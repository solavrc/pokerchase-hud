/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
import Dexie from 'dexie'
import PokerChaseService, {
  ApiType,
  ApiMessage,
  validateMessage,
  validateApiEvent,
  parseApiEvent,
  getValidationError,
  isApplicationApiEvent
} from '../app'
import type { ApiEvent } from '../app'
import { autoSyncService } from '../services/auto-sync-service'
import { connectedPorts, startPortPing, setLastKnownStats } from './ports'
import { recordUndecodedEvent } from './undecoded-event-tracker'
import { markSessionActive, markSessionInactive, recheckPendingUpdate, setIngestionDrainProvider } from './update-manager'

/**
 * 参加取消申込（ApiTypeId 203）。`ApiType` enum（アプリケーションで使用する
 * イベント種別、`isApplicationApiEvent`の判定基準）には意図的に含めない
 * ——enumに加えると`isApplicationApiEvent`がtrueを返すようになり、
 * ストリーム（handLogStream等）に本来対象外のイベントが投入されてしまう
 * ため。ここではセッション状態追跡専用の生ApiTypeId定数として扱う
 * （201/303/308/309と同じraw-firstパターン）。
 *
 * 参加申込(201)後、着席（303/308）に至る前にユーザーが参加をキャンセル
 * すると、ハンドが一度も始まらないため309も届かない
 * （P2, codexレビュー指摘 2026-07-21, pass-3）。この203を観測したら309と
 * 同様にsessionActivityをINACTIVEへ戻す（詳細は`applySessionActivity()`
 * コメント参照）。content_script.tsのkeepalive解除条件も同じ判定を
 * ミラーする。
 */
const EVT_ENTRY_CANCELLED_API_TYPE_ID = 203

/**
 * Raw Event Lakeの耐久性バリア（release-blocker監査 finding A）を実現する
 * ための直列化キュー。モジュールスコープに置くのは、update-manager.tsの
 * `awaitIngestionDrain()`（キュー・ドレイン・バリア、2026-07-21 pass-3）
 * から`setIngestionDrainProvider()`経由で参照させるため
 * （`registerEventIngestion()`のコメント参照）。
 */
let ingestionQueue: Promise<void> = Promise.resolve()

/**
 * `chrome.runtime.onConnect`のハンドラーを登録する。
 * content_scriptからのポート接続を受け取り、APIイベントの検証・DB保存・
 * 各ストリームへの書き込み・自動同期トリガーを行う。
 */
export const registerEventIngestion = (service: PokerChaseService): void => {
  // Raw Event Lakeの耐久性バリア（release-blocker監査 finding A）:
  // `db.apiEvents.add()`を待たずにストリーム書き込みやセッションフックの副作用
  // （自動同期トリガー、`chrome.runtime.reload()`を呼びうる保留アップデート
  // 再チェック）を進めると、
  //   (1) quota超過等でadd()が失敗した場合に「派生統計だけ存在してraw行が
  //       無い」というRaw Event Lakeの不変条件違反（CLAUDE.md「Raw Event
  //       Lake」/ "Storage happens *before* the validation gate" 参照）が
  //       起こりうる
  //   (2) 重複キー失敗（同一(timestamp, ApiTypeId)が既に保存済み）の場合、
  //       そのイベントは初回処理時に既にストリーム/セッションフックを一度
  //       通過済みのはずなのに、ここでも投入してしまうと二重処理になる
  //   (3) add()のトランザクションが確定する前にreloadでService Workerが
  //       巻き込まれ、書き込みが失われる恐れがある
  // という3つの安全性違反を起こしうる。
  //
  // 対策として、各イベントの処理を「このイベントのadd()が決着（成功、または
  // 処理済みの失敗）してから次のイベントの処理を始める」キューで直列化する
  // （`processEvent`内で全副作用がadd()のawait後に実行されるため、この
  // キューはあわせて「バーストで来たイベントの観測順序がストリーム側で
  // 入れ替わらないこと」も保証する——add()を待つ以上、後続イベントのadd()が
  // 先に決着してしまうと素朴な実装では順序が壊れうるため）。
  //
  // セッション状態追跡（markSessionActive/markSessionInactive）もこの
  // キューの内側、耐久性バリア・重複排除判定の後で行う（2026-07-21
  // pass-3で統一。経緯: 過去2ラウンドはACTIVE化だけを同期的に前倒しする
  // 「楽観的arm」設計を採ったが、到着順序ゲーティング・重複判明時の
  // ロールバックといった対症療法を重ねるほど設計が自分自身と衝突する
  // ようになった——詳細はupdate-manager.tsの`markSessionActive`コメント
  // 参照）。この統一により(a)重複イベントがそもそもACTIVE/INACTIVE判定に
  // 到達しない（判定より先にreturnする）、(b)キュー自体が到着順序を
  // 保証するため順序反転が起こりえない、という2点が構造的に保証される。
  // 残る懸念（rawの書き込みが詰まっている間、reload判定が古い
  // sessionActivityを読んでしまう）は書く側でなく読む側で解決する——
  // update-manager.tsの`awaitIngestionDrain()`参照。
  //
  // なお、`autoSyncService.onGameSessionEnd()`/`onNewSessionStart()`自体は
  // raw Lakeの行数を見るだけの非同期処理で、直接`chrome.runtime.reload()`を
  // 呼ぶわけではない（reloadを呼びうるのはそこから連鎖される
  // `recheckPendingUpdate()`のみ）。そのため理屈の上では同期トリガーの発火
  // 自体はadd()の完了を待たなくても安全ではある。ただし、
  //   - どの内部処理が将来reload隣接になるか将来にわたって保証できない
  //   - 直列化を「ストリームだけ」「セッションフックだけ」で線引きすると
  //     実装・レビューの複雑さが増し、境界の取り違えバグを生みやすい
  // という理由で、本実装では簡潔さと防御的深さを優先し、セッションフック・
  // 同期トリガー・ストリーム書き込みの全てをadd()決着後に統一して実行する
  // （最小要件を満たしつつ上回る、意図的な選択）。
  ingestionQueue = Promise.resolve()
  setIngestionDrainProvider(() => ingestionQueue)

  chrome.runtime.onConnect.addListener(port => {
    if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
      connectedPorts.add(port)
      port.onMessage.addListener((message: ApiMessage | { type: string }) => {
        // キープアライブメッセージの処理（キュー直列化の対象外 -- 何も
        // 保存・処理しないため、耐久性バリアの対象になる副作用が無い）
        if (typeof message === 'object' && 'type' in message && message.type === 'keepalive') {
          return
        }

        // このイベントの処理を、直前のイベントの処理（add()の決着含む）の
        // 後ろに連結する。`processEvent`は内部で全エラーを捕捉して素通し
        // させない設計だが、想定外のバグでqueueが壊れて以降のイベントが
        // 永久に詰まることのないよう、キューの継続用チェーンは別途catchする。
        const task = ingestionQueue.then(() => processEvent(service, message))
        ingestionQueue = task.catch(err => {
          console.error('[background] Unhandled ingestion queue error (fail-safe, queue continues):', err)
        })
        return task
      })
      const stopPing = startPortPing(port)

      // Clean up when port disconnects
      port.onDisconnect.addListener(() => {
        // Keep lastKnownStats for page reloads - only clear interval
        stopPing()
        connectedPorts.delete(port)
      })
    }
  })
}

/**
 * ペイロードが構造的に同一かどうかの簡易比較。生イベントはmsgpackデコード後の
 * 素朴なJSON互換オブジェクトであり、暗号学的な保証は不要な用途（同一
 * (timestamp, ApiTypeId)への再到着が「本当に同じイベントの再送か」を見分ける
 * だけ）のため、JSON.stringifyによる構造比較で十分とする（フィールド順序が
 * 変わりうる別経路からの再構築物を比較する用途ではないため、キー順序依存の
 * 弱さは実害にならない）。
 */
const isSamePayload = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * 生メッセージの数値ApiTypeIdだけを見て、セッションのACTIVE/INACTIVE状態を
 * 判定し、該当すれば`markSessionActive()`/`markSessionInactive()`を呼ぶ。
 *
 * 呼び出しは`processEvent`内、Raw Event Lakeの耐久性バリア（add()の決着）
 * および重複判定の**後**でのみ行う（真の重複はここに到達する前に
 * `processEvent`がreturn済み——重複イベントがACTIVE/INACTIVEを動かす
 * ことは無い。詳細は`processEvent`のコメント参照）。
 *
 * ACTIVE化のトリガーは308(EVT_SESSION_DETAILS)単独に頼らない
 * （release-blocker監査 finding B）: docs/api-events.md:99が明記する
 * 通り、308の欠落は正常系のバリアント（観測ギャップ）であり、
 * 「308が来ない試合開始」は普通に起こる。以下のいずれかを観測したら
 * 即active化する:
 *   - EVT_ENTRY_QUEUED(201): 着席（新セッション/新テーブルの入口）
 *   - EVT_DEAL(303, Player在席時のみ): ハンド進行中の最も強いシグナル
 *     （観戦モード=Playerフィールド自体が無い場合は除外——P2, codex
 *     レビュー指摘。docs/api-events.md「EVT_DEAL: Playerフィールドの
 *     欠落」参照）
 *   - EVT_SESSION_DETAILS(308): 従来からのシグナル（来れば最速）
 *
 * INACTIVEへ戻すトリガーはEVT_SESSION_RESULTS(309)と
 * EVT_ENTRY_CANCELLED(203, 本ファイル冒頭の定数コメント参照)の2つ
 * （tri-stateのunknown=unsafeデフォルトは変更しない）。
 *
 * 同じトリガー集合をcontent_script.tsのkeepalive起動/解除条件にも
 * ミラーする必要がある（背景・コンテンツスクリプト間でimport不可のため
 * 手動同期。変更時は両ファイルを揃えること）。
 */
const applySessionActivity = (rawApiTypeId: unknown, message: ApiMessage | { type: string }): void => {
  if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS || rawApiTypeId === EVT_ENTRY_CANCELLED_API_TYPE_ID) {
    markSessionInactive()
    return
  }
  if (rawApiTypeId === ApiType.EVT_ENTRY_QUEUED || rawApiTypeId === ApiType.EVT_SESSION_DETAILS) {
    markSessionActive()
    return
  }
  if (rawApiTypeId === ApiType.EVT_DEAL) {
    const rawPlayer = (message as { Player?: unknown }).Player
    if (rawPlayer != null) {
      markSessionActive()
    }
  }
}

/**
 * 1件のAPIイベントを処理する: Raw Event Lakeへの保存（耐久性バリア）→
 * セッション状態追跡・自動同期トリガー（raw書き込み決着後のみ）→
 * リアルタイムパイプラインへの投入。
 */
const processEvent = async (
  service: PokerChaseService,
  message: ApiMessage | { type: string }
): Promise<void> => {
  // Ensure service is ready before processing messages
  try {
    await service.ready
  } catch (err) {
    console.error('[background] Service not ready:', err)
    return
  }

  const rawApiTypeId = (message as { ApiTypeId?: unknown }).ApiTypeId
  const rawTimestamp = (message as { timestamp?: unknown }).timestamp

  // Raw Event Lake（docs/architecture.md参照）: timestamp/ApiTypeIdが数値である
  // 限り、Zodパースの成否・アプリケーションイベントか否かに関わらず生のまま
  // 保存する。バリデーションは後続のリアルタイム処理パイプライン（ストリーム）
  // への投入可否のみを左右し、保存の可否は左右しない。これにより将来
  // PokerChase側のペイロード変更でスキーマ検証が壊れても、修正後のデータ
  // 再構築で復旧可能になる（2026年シーズン3のEVT_SESSION_RESULTS破壊的変更で
  // 実際にデータが失われた反省による）。
  if (validateMessage(message).success) {
    // Dexieの型はApiEvent（既知スキーマ）を想定しているが、Lakeとして未検証・
    // 未知のApiTypeIdの生イベントも意図的に保存するためアサーションが必要。
    // ここを`await`し、決着（成功/失敗）してから以降の全処理へ進むのが
    // 今回の耐久性バリア本体（release-blocker監査 finding A）。
    try {
      await service.db.apiEvents.add(message as ApiEvent)
    } catch (err) {
      const isConstraintError = err instanceof Dexie.DexieError && err.name === 'ConstraintError'
      if (isConstraintError) {
        // ConstraintError = 既に同じ[timestamp+ApiTypeId]の行がLakeに存在
        // する。これは2つの別々のケースを区別する必要がある
        // （P2, codexレビュー指摘 2026-07-21, 監査finding 6）:
        //   (a) 真の重複: 同一イベントの再到着（再送・reconnect replay等）
        //   (b) 真の衝突: 同一ミリ秒バーストで2つの"別々の"生WebSocket
        //       メッセージが同じApiTypeIdで届き、両方とも同じ
        //       `Date.now()`由来のtimestamp（web_accessible_resource.ts）を
        //       持ってしまい[timestamp+ApiTypeId]がぶつかったケース
        // (b)を(a)と同じ「スキップ」扱いにすると、衝突した方のイベント
        // （アクション・結果・セッション遷移等）がライブパイプラインから
        // 静かに消えてしまう。既存行のペイロードと比較して区別する。
        let existing: ApiEvent | undefined
        try {
          existing = await service.db.apiEvents.get([rawTimestamp as number, rawApiTypeId as number])
        } catch (getErr) {
          console.error('[background] Failed to read colliding row for dedup comparison (treating as a genuine collision, not a duplicate):', getErr)
        }

        if (existing !== undefined && isSamePayload(existing, message)) {
          // (a) 真の重複: このイベントは初回受信時に既にセッションフック・
          // 同期トリガー・ストリームを一度通過済みのはず。ここで再度投入
          // すると二重処理（統計の二重計上等）になるため、dedup semantics
          // として以降の全処理をスキップする——ACTIVE/INACTIVE判定
          // （`applySessionActivity`）にも到達させない。これにより
          // reconnectが複数の重複をまとめて再送しても（各イベントごとに
          // 個別にここで判定・スキップされるだけなので）セッション状態が
          // 一切動かない（2026-07-21 pass-3, codexレビュー指摘: 過去の
          // 「楽観的ACTIVE化+ロールバック」設計はスタックした重複バースト
          // で破綻していたが、判定そのものを重複チェックの後ろに統一した
          // ことで、そもそも動かすものが無くなり構造的に解消される）。
          console.warn('[background] Duplicate event (identical payload already in Raw Event Lake), skipping re-processing:', message)
          return
        }

        // (b) 真の衝突: 別イベントが同じprimary keyを先取りしていたため、
        // このイベント自身の生ログはRaw Event Lakeに残せない（add()は
        // 既存行を上書きしない）。根本修正はwave-3で予定されている
        // シーケンスキー移行（[timestamp+ApiTypeId]をこの種の衝突が起こら
        // ないキーへ置き換える）で、それまでの当面の対処として、同一
        // ミリ秒バーストでアクション・結果・セッション遷移を静かに握り
        // つぶす方が実害が大きいと判断し、ライブパイプラインへの投入は
        // 続行する（returnしない）。raw行を持てなかったという事実は
        // drop可視化カウンタ（#141）で大きく可視化し、運用上気づける
        // ようにする（quota等の失敗と同じ経路 -- どちらも「raw行が無い
        // まま素通しした」事実を運用に晒す点は共通）。
        console.error('[background] Primary-key collision (different event landed on the same [timestamp+ApiTypeId] -- see wave-3 sequence-key migration for the real fix; forwarding to the live pipeline anyway, no raw row persisted for this event):', err, { incoming: message, existing })
        if (typeof rawApiTypeId === 'number') {
          const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
          recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(recordErr =>
            console.error('[background] Failed to record dropped-event stats:', recordErr)
          )
        }
        // フォールスルー（returnしない）: 以降のセッション状態追跡・
        // 同期トリガー・ストリーム投入へ進む。
      } else {
        // 重複/衝突以外の理由（quota超過等）でraw書き込みが失敗 = この
        // イベントはLakeに存在しない。「派生統計はraw行があって初めて
        // 存在してよい」というLakeの不変条件を守るため、ストリーム・
        // セッションフック・同期トリガーのいずれにも投入しない
        // （forward NGが正しい判断——「ログだけ出して素通しする」は
        // 不変条件違反を積極的に作りにいくことになるため選ばない）。
        // #141のdrop可視化カウンタで運用上気づけるようにする。
        console.error('[background] Raw Event Lake write failed -- dropping from pipeline to preserve the Lake invariant (derived stats require a raw row):', err, message)
        if (typeof rawApiTypeId === 'number') {
          const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
          recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(recordErr =>
            console.error('[background] Failed to record dropped-event stats:', recordErr)
          )
        }
        return
      }
    }
  } else {
    // timestamp/ApiTypeIdが数値でない = キーとして使えないため保存不可。
    // add()自体を呼んでいないので耐久性バリアの対象外（待つべきI/Oが無い）。
    // 直後のparseApiEvent()もほぼ確実にnullを返し自然に早期returnする。
    console.warn('[background] Event missing numeric timestamp/ApiTypeId, cannot store:', message)
  }

  // ここから先は、raw書き込みが成功した・保存不可能で待つべきI/Oが無かった・
  // または真の衝突でフォールスルーしてきた場合にのみ到達する（上記
  // いずれか）。add()が実際に失敗した（重複以外の失敗、または真の重複）
  // ケースは上で既にreturnしている。

  // Forced-update安全性述語（update-manager.ts）のセッション状態追跡。
  // 意図的にパース成功後のdata.ApiTypeIdではなく、生メッセージの数値
  // ApiTypeIdだけを見て判定する: PokerChase側のペイロード破壊的変更で
  // parseApiEvent()がnullを返すようになっても、セッション状態が永久に
  // 誤った値のまま詰まらないようにするため（codexレビュー指摘）。
  // 詳細は`applySessionActivity`のコメント参照。
  applySessionActivity(rawApiTypeId, message)

  if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS) {
    // #179 round3指摘: セッション終了(EVT_SESSION_RESULTS)によるHUDクリアは
    // App.tsx側のReact stateだけで完結しており、background(ports.ts)の
    // `lastKnownStats`はセッションをまたいで残り続ける。この状態で
    // Popupのバトルタイプフィルターが変更されると、message-router.tsの
    // `updateBattleTypeFilter`ハンドラーが`getLastKnownStats()`（終了済み
    // lineupのまま）を使って`service.statsOutputStream.write(...)`を
    // 再トリガーし、ブロードキャストで終了済みlineupが復活してApp.tsxの
    // クリア済みパネルへ再度流し込まれてしまう。上と同じ「パース成功後の
    // data.ApiTypeIdではなく生メッセージの数値ApiTypeIdだけを見る」
    // raw-firstパターンで（309のペイロード破壊的変更に影響されないよう）
    // ここでlastKnownStatsを空にしておけば、以降のフィルター変更は
    // `lastKnownStats.length > 0`のガードに引っかからずセッション開始前と
    // 同じ「何もブロードキャストしない」挙動になる。プリゲーム・ヒーロー
    // スタッツの復元（#158, `requestLatestStats`→`getLatestSessionStats`）
    // はDBを読む別経路でありlastKnownStatsを参照しないため、この変更の
    // 影響を受けない。
    //
    // post-merge reviewでは一時ここにhero単独lineupを合成する修正
    // （round4/round5）や、App.tsx側にセッション状態・ヒーロー身元の
    // 検証機構を足す修正（round6の「相互作用マトリクス」設計）を
    // 積んだが、いずれもオーナー判断で撤回されている（PR #191,
    // 2026-07-20, sola「それほど重要な機能ではないので、bで十分です」）。
    // 理由: `service.setBattleTypeFilter()`は内部で無条件に
    // `ReadEntityStream.recalculateStats()`を呼び、`lastKnownStats`の
    // 中身に関係なく`service.latestEvtDeal.SeatUserIds`（ヒーローの
    // 直近の実在席時点のフルの顔ぶれ。セッション終了後もクリアされ
    // ない）を再計算・再ブロードキャストしてしまう。つまりこのファイル
    // 側で`lastKnownStats`をどう作っても、その再ブロードキャストは
    // 止められない別経路であり、追いかけるだけ複雑化する一方だった。
    //
    // 採用した方針（保守的な縮小スコープ）: bust後のミュート表示・
    // hero身元の保持は「連続したライブシーケンス内」でのみ保証する
    // （#158のセッション終了時hero保持は例外的にApp.tsx側で維持）。
    // セッション終了後にフィルターを変更すると、`recalculateStats()`
    // がヒーロー在籍時点の最後の実テーブル（対戦相手を含む）を新
    // フィルターで再表示することがあるが、これは「不正確なデータ」
    // ではなく「文脈的に古い可能性のある正確なデータ」であり、この
    // 機能の重要度に見合わないため許容する。ここは元のround3の
    // 意図通り単純な`[]`のままにする -- `updateBattleTypeFilter`の
    // 明示的な`getLastKnownStats()`ベースの再write()を単にno-opに
    // するだけで、他には何もしない。
    //
    // なお#188（read-entity-stream.tsのrecalculateStats()を呼ぶ
    // message-router.tsのupdateBattleTypeFilterハンドラー自身）で、
    // このwrite()と`recalculateStats()`の競合（観戦中のlineupが
    // ヒーロー在籍dealのevtDealとペアリングされてしまうケース）に
    // 対する`lineup-identity`ガードが別途入っており、この単純な
    // `[]`のままでも競合は起きない。
    //
    // 203(参加取消申込)はここに含めない: 303/308が一度も届いていない
    // （ハンドが一度も始まっていない）ため、そもそもクリアすべき
    // ライブlineupが存在しない。
    setLastKnownStats([])
  }

  // Auto-sync起動・保留中アップデートの安全性再チェックも、上のセッション状態
  // 追跡と同じ理由で生メッセージの数値ApiTypeIdだけを見て判定する（codexレビュー
  // 指摘, P2）。autoSyncService.onGameSessionEnd()/onNewSessionStart()は
  // 生のapiEvents Lake（上で既に保存済み）の件数だけを見るヘルパーで、
  // パース済みdataには一切依存しない。以前はこのトリガーが後段の
  // `if (data.ApiTypeId === ...)`（パース成功時のみ到達するブロック）に
  // ぶら下がっていたため、PokerChase側の309ペイロード破壊的変更で
  // parseApiEvent()がnullを返すケースでは、下のearly returnによって
  // recheckPendingUpdate()が一切呼ばれず、保留中アップデートは次の
  // セッション終了までずっと詰まったままになっていた（309の生データは
  // 上のRaw Event Lake保存で既に確保済みなので、この再チェック自体を
  // パース成否に依存させる理由はそもそも無い）。
  if (rawApiTypeId === ApiType.EVT_SESSION_RESULTS) {
    // セッション終了は保留中アップデートの安全性再チェック地点の1つ
    // （src/background/update-manager.ts参照）。onGameSessionEnd()の
    // Promiseが完了(成功/失敗いずれか)してから必ずチェーンして
    // recheckPendingUpdate()を呼ぶ -- 両方を並列で撃つと、performSync()が
    // `_isSyncing`を立てる前の非同期区間（min-versionゲートのawait等）を
    // recheckPendingUpdate()がすり抜けて安全と誤判定し、直近セッションの
    // クラウドバックアップがまだ始まってもいないうちに
    // chrome.runtime.reload()でService Workerを巻き込んでしまう恐れが
    // あるため（codexレビュー指摘, P1）。
    //
    // このチェーン全体を`await`し、`processEvent`自体（延いては
    // `ingestionQueue`）がこの決着を待ってから次のイベントへ進むように
    // する（P2, codexレビュー指摘 2026-07-21, pass-3, 「Keep the reload
    // recheck inside the ingestion queue」）: 以前はfire-and-forgetして
    // いたため、`processEvent()`がここで即座にresolveしてキューが次の
    // rawイベントの処理（＝新たな`apiEvents.add()`）を始めてしまう一方、
    // まだ実行中の`recheckPendingUpdate()`が`chrome.runtime.reload()`を
    // 呼べる状態のままだった。保留中アップデートがある状態で309の直後に
    // 非ACTIVEなイベントが1件でも続くと、そのreloadが次イベントの
    // in-flightな`apiEvents.add()`と競合してabortさせ、耐久性バリアが
    // あるにもかかわらずraw-Lakeに欠落を作りうる。`await`することで、
    // この309自身の処理が完全に終わる（＝reloadするかどうかの決着が
    // 付く）までキューが先に進まなくなり、この競合が構造的に無くなる。
    try {
      await autoSyncService.onGameSessionEnd()
    } catch (err) {
      console.error('[background] Auto sync on game end failed:', err)
    }
    try {
      await recheckPendingUpdate()
    } catch (err) {
      console.error('[background] Pending update recheck on session end failed:', err)
    }
  } else if (rawApiTypeId === ApiType.EVT_ENTRY_QUEUED || rawApiTypeId === ApiType.EVT_SESSION_DETAILS) {
    // フォールバックトリガー（docs/postmortems/2026-07-session-results-drop.md
    // 再発防止#3): 309単一トリガーのSPOF対策。新セッション開始時点は
    // 進行中ハンドが存在しない安全なタイミングなので、ここでも同じ閾値判定
    // でuploadを起動する（309が正常なら直前で既にバックログが閾値未満に
    // なっているため二重発火しない）
    autoSyncService.onNewSessionStart().catch(err =>
      console.error('[background] Auto sync on new session start failed:', err)
    )
  }

  // 通常のAPIメッセージ処理
  // Zodスキーマでパース（passthrough: 未知プロパティは保持）
  const data = parseApiEvent(message as ApiMessage)

  if (!data) {
    // パース失敗 = 必須プロパティ欠損など破壊的変更の可能性。生ログは上で
    // 既に保存済みなので、ここではリアルタイムパイプラインへの投入のみ諦める
    const validationResult = validateApiEvent(message as ApiMessage)
    const errorDetails = validationResult.error ? getValidationError(validationResult.error) : null
    console.warn(`[background] Schema validation failed (stored raw, pipeline skipped):\n  Errors: ${JSON.stringify(errorDetails, null, 2)}\n  Event: ${JSON.stringify(message, null, 2)}`)

    // drop可視化（docs/postmortems/2026-07-session-results-drop.md 再発防止#2）:
    // 検証失敗イベントの件数をApiTypeIdごとに集計してmetaテーブルへ永続化し、
    // Popupから可視化できるようにする。309インシデントは半年間これが
    // console.warnの中にしか無かったために気づけなかった
    if (typeof rawApiTypeId === 'number') {
      const eventTimestamp = typeof rawTimestamp === 'number' ? rawTimestamp : Date.now()
      recordUndecodedEvent(service.db, rawApiTypeId, eventTimestamp).catch(err =>
        console.error('[background] Failed to record undecoded event stats:', err)
      )
    }
    return
  }

  // アプリケーション用のイベントかチェック
  if (!isApplicationApiEvent(data)) {
    // アプリケーションで使用しないApiTypeIdのイベントはパイプラインに投入しないが
    // 内容は記録（生ログとしては上で既に保存済み）
    console.info(`[background] Non-application event (${data.ApiTypeId}): ${JSON.stringify(data)}`)
    return
  }

  // ここでdataはApiEvent型（isApplicationApiEventで保証済み）
  service.eventLogger(data, 'info')

  // ストリーム処理（DB保存は上で完了済み・耐久性確定済み -- ただし
  // primary-key衝突でフォールスルーしてきた場合のみ例外: このイベント
  // 自身の生ログはRaw Event Lakeに残っていない。上のコメント参照）
  service.handLogStream.write(data)
  service.handAggregateStream.write(data)
  service.realTimeStatsStream.write(data)
  // Auto-sync起動・pending update再チェック（309/201/308）は上のRaw
  // Event Lake保存直後に生ApiTypeIdベースで既にトリガー済み（本ブロックの
  // パース成功はストリーム投入のみが目的）
}
