/**
 * Chrome ウェブストアのレビュー依頼（sola承認）のstorage key・型・純粋関数。
 *
 * `constants/update.ts`と同じ理由で副作用フリーの独立モジュールとして
 * 切り出している: Popupがこれを`background/review-prompt.ts`から直接
 * importすると、そのimport連鎖（PokerChaseDB / Dexie）ごとPopupバンドルで
 * 実行されてしまうため。
 *
 * 状態は`chrome.storage.local`に置く（`pendingUpdate` /
 * `rebuildAdvisory` / `whatsNewUnseenVersion`と同じ area）。判断材料の
 * 累計ハンド数がそもそも端末のIndexedDB由来で端末ごとに異なるため、
 * `storage.sync`に置いても「デバイスAで条件を満たした」状態を
 * デバイスBへ持ち込むだけで嬉しくない。複数デバイスで最大1回ずつ
 * 聞かれうるのは許容する（依頼は生涯1回、スヌーズ1回分の差でしかない）。
 */

export const REVIEW_PROMPT_STORAGE_KEY = 'reviewPrompt'

/** 依頼を終了させる決着（どちらも二度と表示しない） */
export type ReviewPromptResolution = 'rated' | 'dismissed'

/** Popupのボタンに対応するユーザーの選択（`later`はスヌーズのみ） */
export type ReviewPromptChoice = ReviewPromptResolution | 'later'

export interface ReviewPromptState {
  /**
   * 表示条件（累計ハンド数）を最初に満たした時刻(ms)。
   * 一度立ったら降りない: 全データ削除でハンド数が0に戻っても、
   * 「十分に使った」という事実は変わらないため。
   */
  eligibleSince?: number
  /** 「後で」を押した時刻(ms)。`REVIEW_PROMPT_SNOOZE_MS`経過するまで再表示しない */
  snoozedAt?: number
  /** 「評価する」「今後表示しない」で決着した理由。設定済みなら二度と表示しない */
  resolution?: ReviewPromptResolution
  /** `resolution`を記録した時刻(ms) */
  resolvedAt?: number
}

/**
 * 依頼を出し始める、現在のプレイヤーが参加した累計ハンド数。
 *
 * 数セッション使い込んで価値を実感した頃合いを狙う閾値（sola選択）。
 * インストール直後の押し付けを避けつつ、母数を極端に絞らない妥協点。
 */
export const REVIEW_PROMPT_MIN_HANDS = 500

/** 「後で」を押されてから再表示するまでの期間（30日） */
export const REVIEW_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * レビュー投稿ページのURLを拡張機能ID（`chrome.runtime.id`）から組み立てる。
 *
 * slug（`/detail/pokerchase-hud/<id>/reviews`）を含めない形にしているのは、
 * slugがストア掲載名に追従して変わりうる一方、ID単独の形は
 * `https://chromewebstore.google.com/detail/<id>/reviews` → slug付きURLへ
 * 301リダイレクトされるため（2026-07-31実測）。IDをビルド時に埋め込まず
 * 実行時に取得するのも同じ理由で、manifestの`key`から決まる値なので
 * fork（別のkey）ではそのforkのストアページを指す。
 */
export const buildChromeWebStoreReviewUrl = (extensionId: string): string =>
  `https://chromewebstore.google.com/detail/${extensionId}/reviews`

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * `chrome.storage.local`から読んだ生の値を`ReviewPromptState`に正規化する。
 *
 * 壊れた値（手動編集・将来の形式変更）で例外を投げたり、意図せず
 * 「決着済み」を失って再度依頼したりしないよう、既知のフィールドだけを
 * 型チェックして拾う。
 */
export const parseReviewPromptState = (value: unknown): ReviewPromptState => {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const state: ReviewPromptState = {}
  if (isFiniteNumber(raw.eligibleSince)) state.eligibleSince = raw.eligibleSince
  if (isFiniteNumber(raw.snoozedAt)) state.snoozedAt = raw.snoozedAt
  if (raw.resolution === 'rated' || raw.resolution === 'dismissed') {
    state.resolution = raw.resolution
    if (isFiniteNumber(raw.resolvedAt)) state.resolvedAt = raw.resolvedAt
  }
  return state
}

/**
 * 永続化された状態だけから「いま表示してよいか」を判定する純粋関数
 * （累計ハンド数の判定は`eligibleSince`として既に畳み込まれている前提）。
 *
 * スヌーズ中の判定は「経過時間が負」（端末時計が巻き戻った、未来の
 * タイムスタンプが書かれている）でも非表示側に倒す。しつこく出るより
 * 出ない方に倒すのが、この種の依頼バナーの安全側。
 */
export const isReviewPromptVisible = (state: ReviewPromptState, now: number): boolean => {
  if (state.resolution) return false
  if (state.eligibleSince === undefined) return false
  if (state.eligibleSince > now) return false
  if (state.snoozedAt !== undefined) {
    const elapsed = now - state.snoozedAt
    if (elapsed < REVIEW_PROMPT_SNOOZE_MS) return false
  }
  return true
}
