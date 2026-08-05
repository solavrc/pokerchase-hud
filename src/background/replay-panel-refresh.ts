/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * リプレイ詳細のドレイン中に、開いたままの「直近ハンド」パネルを追従させる
 * ための通知層（表示配管のみ。取得の間隔・ゲート・保存の意味論には触れない）。
 *
 * ## なぜ要るか
 *
 * セッション終了後のドレインは1.5秒間隔で `replayDetails` / Lake 90001 を
 * 書き足していくが、その書き込み自体はどのUI経路にも接続されていない。
 * `recent-hands-service.ts` の30秒キャッシュも `writeEntityStream`（＝ハンド
 * 完了）にしか購読していないので、開いているパネルは閉じて開き直すまで
 * 埋まらなかった。
 *
 * ## 2つの信号を分ける
 *
 * - **キャッシュ無効化は1件ごと**（間引かない）。無効化は`Map.clear()`と
 *   世代のインクリメントだけで、DBもポートも触らない。間引くと、その隙に
 *   ユーザーが手で開いたパネルが「1件前のDB状態」のキャッシュを最大30秒
 *   掴む。安いほうを毎回やる。
 * - **パネルへの通知は間引く**（MUST）。通知1回につき、開いている各パネルが
 *   hands/actions/phases/replayDetailsの再読み取りへ行く。1.5秒ごとに100件超
 *   届くドレインでこれを1件ごとに撃つと、ドレインの間じゅう再フェッチが
 *   走り続ける。
 *
 * ## 間引きの刻み
 *
 * `REPLAY_PANEL_REFRESH_BATCH_SIZE`件ごと、または前回通知から
 * `REPLAY_PANEL_REFRESH_MIN_INTERVAL_MS`が経過したとき、のどちらか早いほう。
 * 取得間隔が1.5秒なので、5件＝約7.5秒に1回の再フェッチに収まる。時間側の条件は
 * 取得が遅い（再試行・スキップが挟まる）ときの下限保証で、初回だけは
 * `lastNotifiedAt = 0` により即座に通る ―― 最初の1件が届いた瞬間に画面が
 * 動くほうが、7.5秒黙っているより「効いている」ことが分かる。
 *
 * MUST: ドレインの最後には`flush()`を必ず呼ぶ。間引きの性質上、最後の数件は
 * どの閾値にも届かないまま残るので、これが無いとドレイン末尾のハンドが
 * 画面に出ない。
 */
import { invalidateRecentHandsCache } from '../services/recent-hands-service'
import { notifyReplayDetailsStored } from './ports'

/** この件数を書いたら通知する。 */
export const REPLAY_PANEL_REFRESH_BATCH_SIZE = 5

/** 前回通知からこれだけ経っていれば、件数に届いていなくても通知する。 */
export const REPLAY_PANEL_REFRESH_MIN_INTERVAL_MS = 10_000

export interface ReplayPanelRefreshHooks {
  now?: () => number
  /** 直近ハンドのbackendキャッシュを捨てる（1件ごと）。 */
  invalidateCache?: () => void
  /** 開いているパネルへ再フェッチを促す（間引き後）。 */
  notifyPanels?: () => void
}

export interface ReplayPanelRefresh {
  /** 詳細を1件保存したときに呼ぶ。 */
  onDetailStored: () => void
  /** ドレインの終わりに呼ぶ。未通知の書き込みが残っていれば1回だけ通知する。 */
  flush: () => void
}

/**
 * ドレイン1周ぶんの通知状態を持つインスタンスを作る。
 *
 * 状態をモジュールスコープに置かないのは、`createReplayImportDeps()`が
 * トリガーごとに新しい依存を組む作りだから ―― 1周に1インスタンスなら、
 * 前回のドレインの残骸で今回の初回通知が抑制されることがない。
 */
export const createReplayPanelRefresh = (
  hooks: ReplayPanelRefreshHooks = {}
): ReplayPanelRefresh => {
  const now = hooks.now ?? (() => Date.now())
  const invalidateCache = hooks.invalidateCache ?? invalidateRecentHandsCache
  const notifyPanels = hooks.notifyPanels ?? notifyReplayDetailsStored
  /** 前回の通知以降に保存できた件数。0なら通知することが無い。 */
  let pending = 0
  let lastNotifiedAt = 0

  const notify = (at: number): void => {
    pending = 0
    lastNotifiedAt = at
    notifyPanels()
  }

  return {
    onDetailStored: () => {
      // 無効化は毎回（上のコメント参照）。
      invalidateCache()
      pending += 1
      const at = now()
      if (
        pending >= REPLAY_PANEL_REFRESH_BATCH_SIZE ||
        at - lastNotifiedAt >= REPLAY_PANEL_REFRESH_MIN_INTERVAL_MS
      ) {
        notify(at)
      }
    },
    flush: () => {
      // 1件も書いていないドレインでは何も送らない（MUST NOT: 空の通知）。
      if (pending === 0) return
      notify(now())
    }
  }
}
