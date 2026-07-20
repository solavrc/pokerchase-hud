/**
 * SimpleTransform - 最小限のシリアライズド変換ストリーム基底クラス
 *
 * Node.jsの`Transform`ストリームは背圧（backpressure）制御のための機能を持つが、
 * 本プロジェクトのStream群（AggregateEventsStream, WriteEntityStream,
 * ReadEntityStream, HandLogStream, RealTimeStatsStream）は`.write()` / `.pipe()` /
 * `'data'`イベントのみを利用し、背圧は一切使用していない。にもかかわらず
 * `Transform`を継承しているため、MV3 Service Workerのバンドルに
 * stream-browserify（および付随するprocess/bufferポリフィル）を含める必要が生じ、
 * バンドルサイズとSW起動時間を圧迫していた。
 *
 * このクラスは実際に使われている機能（write/push/pipe/データ・エラーイベント）
 * のみを、Promiseチェーンと標準JavaScriptのSetで再実装したものである。
 *
 * ## シリアライゼーション不変条件（重要）
 * Node.jsのTransformは内部的に1度に1つの`_transform`呼び出ししか実行しない
 * （前のコールバックが呼ばれるまで次のチャンクは処理されない）。
 * WriteEntityStreamはDexieへの書き込みをawaitし、ReadEntityStreamは統計を
 * 再計算するため、複数チャンクの`transform`が並行実行されるとハンドの処理順序が
 * 崩れ、DB書き込みや統計計算が破損する可能性がある。
 * そのため`write()`は内部プロミスチェーンに`transform()`呼び出しを積み、
 * 「前のチャンクのtransform()が完全に解決してから次のチャンクのtransform()を
 * 開始する」という厳密な直列実行を保証する。この直列性は本クラスの中核的な
 * 不変条件であり、変更してはならない。
 */
export type SimpleTransformTarget = {
  write(chunk: any): void
  end(): void
}

type SimpleTransformEventName = 'data' | 'error' | 'end'
type SimpleTransformListener = (...args: any[]) => void

/**
 * エラーハンドラ関数の型。呼び出し側（各Streamサブクラス）が現在のTransform/Callback
 * パターンで行っているエラー処理（ErrorHandler.createStreamErrorCallback等）を
 * そのまま利用できるように、生のErrorを受け取ってログ・変換する関数を渡す。
 */
export type SimpleTransformErrorHandler = (error: unknown) => void

export abstract class SimpleTransform<In = any, Out = any> {
  /** 直列実行を保証する内部プロミスチェーン */
  private queue: Promise<void> = Promise.resolve()
  /** キューに積まれた（まだ完了していない）チャンク数 */
  private pending = 0
  /** pipe()で接続された下流ターゲット */
  private target?: SimpleTransformTarget
  /** end()が呼ばれたかどうか */
  private ended = false
  /** Node EventEmitterを持ち込まずにdata/error/end購読を提供するリスナー集合 */
  private readonly listeners: Record<SimpleTransformEventName, Set<SimpleTransformListener>> = {
    data: new Set(),
    error: new Set(),
    end: new Set()
  }

  /**
   * Stream群が公開してきた最小イベントAPIを維持する。
   * 同じリスナーの重複登録はSetにより冪等になる。
   */
  on(event: 'data', listener: (data: Out) => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  on(event: 'end', listener: () => void): this
  on(event: SimpleTransformEventName, listener: SimpleTransformListener): this {
    this.listeners[event].add(listener)
    return this
  }

  once(event: 'data', listener: (data: Out) => void): this
  once(event: 'error', listener: (error: unknown) => void): this
  once(event: 'end', listener: () => void): this
  once(event: SimpleTransformEventName, listener: SimpleTransformListener): this {
    const onceListener: SimpleTransformListener = (...args) => {
      this.listeners[event].delete(onceListener)
      listener(...args)
    }
    this.listeners[event].add(onceListener)
    return this
  }

  off(event: 'data', listener: (data: Out) => void): this
  off(event: 'error', listener: (error: unknown) => void): this
  off(event: 'end', listener: () => void): this
  off(event: SimpleTransformEventName, listener: SimpleTransformListener): this {
    this.listeners[event].delete(listener)
    return this
  }

  protected emit(event: 'data', data: Out): boolean
  protected emit(event: 'error', error: unknown): boolean
  protected emit(event: 'end'): boolean
  protected emit(event: SimpleTransformEventName, ...args: any[]): boolean {
    const listeners = this.listeners[event]
    if (listeners.size === 0) return false

    // dispatch中の登録変更が現在の通知順序へ影響しないようスナップショットを使う。
    for (const listener of [...listeners]) listener(...args)
    return true
  }

  protected listenerCount(event: SimpleTransformEventName): number {
    return this.listeners[event].size
  }

  /**
   * サブクラスが実装する変換処理本体。
   * Node Transformの`_transform(chunk, _, callback)`に相当するが、
   * callbackの代わりにasync/awaitとthis.push()を使う。
   * - `callback(null, x)` 相当 → `this.push(x)` を呼ぶ
   * - `callback()` 相当（出力なし） → 何もpushせずreturn
   * - `callback(err)` 相当 → throw（呼び出し元のwrite()が捕捉しhandleErrorへ渡す）
   */
  protected abstract transform(chunk: In): Promise<void>

  /**
   * チャンクをキューに積む。実際の変換は内部プロミスチェーン上で直列実行される。
   * Node Transformの`.write()`と異なり、常に同期的にtrueを返す（背圧制御なし）。
   */
  write(chunk: In): void {
    this.pending++
    this.queue = this.queue.then(async () => {
      try {
        await this.transform(chunk)
      } catch (error: unknown) {
        this.handleError(error)
      } finally {
        this.pending--
      }
    })
  }

  /**
   * 下流へのデータ出力。'data'イベントとしてemitし、pipe()で接続された
   * ターゲットがあればそちらの write() にも同期的に転送する。
   */
  protected push(data: Out): void {
    this.emit('data', data)
    this.target?.write(data)
  }

  /**
   * サブクラスがtransform()内で発生したエラーを処理する。
   * デフォルトでは'error'リスナーが存在する場合のみemitする
   * （Node EventEmitterは'error'にリスナーが無いとthrowするため、
   * 現行のTransformベース実装がエラーリスナー無しでも動いていた
   * ストリーム[RealTimeStatsStream等]の挙動を壊さないための配慮）。
   * より詳細なエラーハンドリング（ErrorHandler連携）が必要なサブクラスは
   * このメソッドをoverrideする。
   */
  protected handleError(error: unknown): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error)
    } else {
      console.error(error)
    }
  }

  /**
   * 下流ストリームへ接続する。Node Streamの`.pipe()`同様、target自身を返し
   * チェーン可能にする（例: `a.pipe(b).pipe(c)`）。
   */
  pipe<T extends SimpleTransformTarget>(target: T): T {
    this.target = target
    return target
  }

  /**
   * 内部キューが完全に空になるまで待つ。pipe()で下流に接続されている場合は
   * 下流のwhenIdle()も連鎖的に待つ（上流が空になった直後に下流へpushされた
   * チャンクがまだ処理中である可能性があるため）。
   * 'finish'イベントベースのテスト待機（Node Transform時代の手法）を置き換える。
   */
  async whenIdle(): Promise<void> {
    // pending済みのチャンクがすべて解決するまで待つ。
    // await中に新たなwrite()が発生する可能性があるため、pendingが0になるまでループする。
    while (this.pending > 0) {
      await this.queue.catch(() => { })
    }
    // 下流ストリームがSimpleTransformであればそちらも連鎖的に待つ
    if (this.target && typeof (this.target as any).whenIdle === 'function') {
      await (this.target as any).whenIdle()
    }
  }

  /**
   * Node Readable/Transform互換のend()。既存テストが
   * `stream.write(...); stream.end()` の形でRead可能ストリームの終端を
   * エミュレートしているため、キューが空になった時点で'end'をemitし、
   * pipe先にもend()を伝播する。
   */
  end(): void {
    if (this.ended) return
    this.ended = true
    void this.whenIdle().then(() => {
      this.emit('end')
      this.target?.end()
    })
  }
}
