/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * Chrome ウェブストアのレビュー依頼（sola承認）のbackground側。
 *
 * 「表示してよいか」の判定と決着の記録だけを持つ。判定材料のうち
 * 現在のプレイヤーが参加した累計ハンド数はIndexedDB由来でPopupからは
 * 触れないため（PopupバンドルにDexieを引き込まない方針、
 * `constants/update.ts`冒頭のコメント参照）、ここで数えてPopupには
 * boolean だけを返す。
 *
 * 評価タイミングはPopupを開いた瞬間のみ（`getReviewPrompt`メッセージ）。
 * イベント取り込み経路（`event-ingestion.ts`）には一切フックしない:
 * この機能のためにセッション終了フックやカウンタ書き込みを増やす価値は
 * 無く、`seatUserIds`のmulti-entry indexによるcountで十分速い。
 * しかも決着済み（`resolution`あり）ならcount自体を実行しない。
 *
 * 表示条件の判定と決着の記録がどちらもここに集約されているのが肝心で、
 * Popup側は「表示する/しない」と「押されたボタンを送る」だけを担う
 * （storage keyの書き込み主体をbackgroundに一本化する）。
 */
import type { PokerChaseDB } from '../db/poker-chase-db'
import { enqueuePendingStorageWrite } from './pending-storage-writes'
import {
  isReviewPromptVisible,
  parseReviewPromptState,
  REVIEW_PROMPT_MIN_HANDS,
  REVIEW_PROMPT_STORAGE_KEY,
  type ReviewPromptChoice,
  type ReviewPromptState,
} from '../constants/review-prompt'

/** `chrome.storage.local`から現在の依頼状態を取得する（未設定なら空オブジェクト） */
export const getReviewPromptState = async (): Promise<ReviewPromptState> => {
  const result = await chrome.storage.local.get(REVIEW_PROMPT_STORAGE_KEY)
  return parseReviewPromptState(result?.[REVIEW_PROMPT_STORAGE_KEY])
}

const setReviewPromptState = async (state: ReviewPromptState): Promise<void> => {
  await chrome.storage.local.set({ [REVIEW_PROMPT_STORAGE_KEY]: state })
}

/**
 * Popupを開いたときに呼ぶ（`getReviewPrompt`メッセージ）。
 *
 * まだ表示条件を満たしていない状態でのみ現在のプレイヤーを含む`hands`件数を数え、閾値に
 * 到達していれば`eligibleSince`を記録する（一度立てば以降countしない）。
 * 戻り値は「このPopupで依頼バナーを出してよいか」。
 *
 * read-modify-write全体を共有storage FIFOへ開始時点から載せる。Popupの
 * 多重起動やボタン操作との競合を直列化するだけでなく、forced updateの
 * reloadドレインが途中のDB問い合わせ・storage読み取りもMUST待てるようにする。
 */
export const evaluateReviewPromptVisibility = async (
  db: PokerChaseDB,
  playerId: number | undefined,
  now: number = Date.now()
): Promise<boolean> => enqueuePendingStorageWrite(async () => {
  const state = await getReviewPromptState()
  // 決着済みなら以後は何も問い合わせない（countも走らせない）
  if (state.resolution) return false

  // 復元途中・観戦中などhero identityが不明な状態では、観戦/他アカウントの
  // 履歴を本人の利用実績と誤認しないよう非表示側に倒す。
  if (typeof playerId !== 'number' || !Number.isSafeInteger(playerId) || playerId <= 0) return false

  if (state.eligibleSince === undefined) {
    const handCount = await db.hands.where('seatUserIds').equals(playerId).count()
    if (handCount < REVIEW_PROMPT_MIN_HANDS) return false
    const eligible: ReviewPromptState = { ...state, eligibleSince: now }
    await setReviewPromptState(eligible)
    return isReviewPromptVisible(eligible, now)
  }

  return isReviewPromptVisible(state, now)
})

/**
 * Popupのボタン操作を記録する（`resolveReviewPrompt`メッセージ）。
 *
 * - `rated` / `dismissed`: 決着として記録し、以後二度と表示しない。
 *   「評価する」を実際に投稿したかは検知できないが、ストアページまで
 *   送り出した相手に再度お願いする方が体験として悪い。
 * - `later`: スヌーズ時刻だけ更新する（`REVIEW_PROMPT_SNOOZE_MS`後に再表示）。
 *
 * 決着済みの状態に対しては何もしない（後から`later`で復活させない、
 * 最初の決着を上書きしない）。
 */
export const resolveReviewPrompt = async (
  choice: ReviewPromptChoice,
  now: number = Date.now()
): Promise<void> => enqueuePendingStorageWrite(async () => {
  const state = await getReviewPromptState()
  if (state.resolution) return

  if (choice === 'later') {
    await setReviewPromptState({ ...state, snoozedAt: now })
    return
  }

  await setReviewPromptState({
    ...state,
    // 表示せずに決着させる経路は無いが、記録の一貫性のため補完しておく
    eligibleSince: state.eligibleSince ?? now,
    resolution: choice,
    resolvedAt: now,
  })
})
