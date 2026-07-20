/**
 * SimpleTransform Tests
 *
 * Node Transformの代替として実装した最小限のシリアライズド変換ストリーム基底クラスの
 * 単体テスト。特に重要なのは、非同期transform()呼び出しがランダムな遅延を持っていても
 * write()された順序どおりに出力される「直列実行」の不変条件（Node Transformが
 * `_transform`を1度に1つずつ実行していたのと同じ性質）である。
 */
import { SimpleTransform } from './simple-transform'

class DelayedEchoStream extends SimpleTransform<{ value: number, delayMs: number }, number> {
  protected async transform({ value, delayMs }: { value: number, delayMs: number }): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    this.push(value)
  }
}

class ThrowingStream extends SimpleTransform<number, number> {
  protected async transform(value: number): Promise<void> {
    if (value === 2) {
      throw new Error(`boom on ${value}`)
    }
    this.push(value)
  }
}

class CountingStream extends SimpleTransform<number, number> {
  public transformCallCount = 0
  protected async transform(value: number): Promise<void> {
    this.transformCallCount++
    this.push(value * 10)
  }
}

describe('SimpleTransform', () => {
  test('直列実行: ランダムな非同期遅延があってもwrite()した順序で出力される', async () => {
    const stream = new DelayedEchoStream()
    const results: number[] = []
    stream.on('data', (value: number) => results.push(value))

    // ランダムな遅延（後の要素ほど短い遅延にすることで、並行実行されていれば
    // 順序が入れ替わってしまうようなワーストケースを作る）
    const inputs = [
      { value: 1, delayMs: 30 },
      { value: 2, delayMs: 20 },
      { value: 3, delayMs: 10 },
      { value: 4, delayMs: 25 },
      { value: 5, delayMs: 5 },
    ]
    for (const input of inputs) stream.write(input)
    await stream.whenIdle()

    expect(results).toEqual([1, 2, 3, 4, 5])
  })

  test('直列実行: 複数回のランダム遅延パターンでも常に入力順を保つ（フェイクランダム）', async () => {
    // シード付き擬似乱数（テストの再現性のため Math.random は使わない）
    let seed = 42
    const pseudoRandom = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }

    for (let trial = 0; trial < 5; trial++) {
      const stream = new DelayedEchoStream()
      const results: number[] = []
      stream.on('data', (value: number) => results.push(value))

      const inputs = Array.from({ length: 10 }, (_, i) => ({
        value: i,
        delayMs: Math.floor(pseudoRandom() * 20),
      }))
      for (const input of inputs) stream.write(input)
      await stream.whenIdle()

      expect(results).toEqual(inputs.map(i => i.value))
    }
  })

  test('whenIdle(): キューが完全に空になるまで解決しない', async () => {
    const stream = new DelayedEchoStream()
    const results: number[] = []
    stream.on('data', (value: number) => results.push(value))

    stream.write({ value: 1, delayMs: 50 })
    stream.write({ value: 2, delayMs: 50 })

    await stream.whenIdle()

    expect(results).toEqual([1, 2])
  })

  test('エラー分離: 1チャンクのtransform()が失敗しても後続チャンクの処理は継続する', async () => {
    const stream = new ThrowingStream()
    const results: number[] = []
    stream.on('data', (value: number) => results.push(value))
    stream.on('error', () => { }) // リスナーを付けてemit('error')がthrowしないようにする

    stream.write(1)
    stream.write(2) // これは失敗する
    stream.write(3)
    await stream.whenIdle()

    expect(results).toEqual([1, 3])
  })

  test('エラー分離: errorリスナーが無くてもプロセスをクラッシュさせない', async () => {
    const stream = new ThrowingStream()
    const results: number[] = []
    stream.on('data', (value: number) => results.push(value))
    // 'error'リスナーは意図的に付けない

    stream.write(1)
    stream.write(2)
    stream.write(3)
    await expect(stream.whenIdle()).resolves.toBeUndefined()

    expect(results).toEqual([1, 3])
  })

  test('pipe(): 下流ターゲットへチャンクを転送し、whenIdle()が下流の完了も待つ', async () => {
    const upstream = new CountingStream()
    const downstream = new CountingStream()
    upstream.pipe(downstream)

    const downstreamResults: number[] = []
    downstream.on('data', (value: number) => downstreamResults.push(value))

    upstream.write(1)
    upstream.write(2)
    await upstream.whenIdle()

    // upstream: value*10 => push(10), push(20)
    // downstream: 受け取った値をさらに*10 => push(100), push(200)
    expect(downstreamResults).toEqual([100, 200])
  })

  test('push(): dataイベントと下流への転送を両方行う', async () => {
    const stream = new CountingStream()
    const dataResults: number[] = []
    stream.on('data', (value: number) => dataResults.push(value))

    stream.write(5)
    await stream.whenIdle()

    expect(dataResults).toEqual([50])
    expect(stream.transformCallCount).toBe(1)
  })

  test('once(): 最初のdataイベントだけを通知する', async () => {
    const stream = new CountingStream()
    const results: number[] = []
    stream.once('data', (value: number) => results.push(value))

    stream.write(1)
    stream.write(2)
    await stream.whenIdle()

    expect(results).toEqual([10])
  })

  test('off(): 登録済みのdataリスナーを解除する', async () => {
    const stream = new CountingStream()
    const results: number[] = []
    const listener = (value: number) => results.push(value)
    stream.on('data', listener)
    stream.off('data', listener)

    stream.write(1)
    await stream.whenIdle()

    expect(results).toEqual([])
  })

  test('off(): once()へ渡した元のdataリスナーを発火前に解除する', async () => {
    const stream = new CountingStream()
    const results: number[] = []
    const listener = (value: number) => results.push(value)
    stream.once('data', listener)
    stream.off('data', listener)

    stream.write(1)
    await stream.whenIdle()

    expect(results).toEqual([])
  })

  test('end(): キュー完了後に"end"をemitし、pipe先にend()を伝播する', async () => {
    const upstream = new CountingStream()
    const downstream = new CountingStream()
    upstream.pipe(downstream)

    let upstreamEnded = false
    upstream.on('end', () => { upstreamEnded = true })
    const downstreamEndedPromise = new Promise<void>(resolve => downstream.on('end', () => resolve()))

    upstream.write(1)
    upstream.end()

    await downstreamEndedPromise

    expect(upstreamEnded).toBe(true)
  })
})
