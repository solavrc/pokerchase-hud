/**
 * 「直近ハンド」パネルの表示設定（表示件数 #341 / 「参加のみ」 #353）:
 * 選択肢の定義と、その永続化。
 *
 * 定数をrecent-hands-service.tsではなくここに置くのは、パネル（content
 * script側）から件数の選択肢を参照する必要があるため。サービス側には
 * Dexie・background/replay-import・リプレイ解析が芋づるで繋がっているので、
 * UIがサービスをimportするとcontent scriptのバンドルにそれらが丸ごと入る。
 * このモジュールは`chrome.storage`を関数の中でしか触らない葉モジュールで、
 * background側からimportしても副作用はない。
 *
 * 保存先は`chrome.storage.local`（端末ローカル）。`uiScale`/`hudPosition_*`
 * （ui-config-storage.ts）と同じ「表示の好みは端末ごと」の扱いに揃える。
 * `sync`を使わない理由は2つ:
 *  - 件数は画面サイズ依存の見た目設定で、端末間で共有する意味が薄い。
 *  - `storage.sync`には書き込み回数クォータ（MAX_WRITE_OPERATIONS_PER_MINUTE）
 *    があり、スイッチャーを続けて押すと簡単に踏む。
 *
 * 値は`RECENT_HANDS_LIMIT_OPTIONS`のいずれかだけを受け付ける。範囲外・型違い・
 * 未設定はすべて`DEFAULT_RECENT_HANDS_LIMIT`へ倒す（フェイルオープン。
 * この設定の読み取り失敗でパネルが出なくなってはならない）。
 */

/**
 * 件数スイッチャーの選択肢。最大値は「全部DOMに出しても仮想化が要らない」
 * 上限として選んだ ―― 100行 × 6セルはHUD1枚あたり高々600ノードで、HandLogが
 * react-windowを使う理由（セッション全体のログ＝行数が原理的に無制限）は
 * ここには当てはまらない。パネル側は代わりに高さ上限＋スクロールで収める
 * （RecentHandsPanel.tsx参照）。
 */
export const RECENT_HANDS_LIMIT_OPTIONS: readonly number[] = [10, 25, 50, 100]

/** `RECENT_HANDS_LIMIT_OPTIONS`の最大値。サービス側はこの件数で組み立ててキャッシュする。 */
export const MAX_RECENT_HANDS_LIMIT: number =
  RECENT_HANDS_LIMIT_OPTIONS[RECENT_HANDS_LIMIT_OPTIONS.length - 1]!

/**
 * デフォルトの取得件数。#341で10→25へ引き上げた（10件は傾向を見るには
 * 少なすぎる、という課題提起そのもの）。100を既定にしないのは、既定で毎回
 * 100ハンド分のactions/phasesを読むほどの情報量は要らないため ―― 必要な
 * ユーザーはスイッチャーで上げられ、選択は端末ローカルに永続化される。
 */
export const DEFAULT_RECENT_HANDS_LIMIT = 25

export const RECENT_HANDS_LIMIT_STORAGE_KEY = 'recentHandsLimit'

export const isValidRecentHandsLimit = (value: unknown): value is number =>
  typeof value === 'number' && RECENT_HANDS_LIMIT_OPTIONS.includes(value)

export const resolveRecentHandsLimit = (value: unknown): number =>
  isValidRecentHandsLimit(value) ? value : DEFAULT_RECENT_HANDS_LIMIT

/**
 * 保存済みの件数を読む。ストレージが使えない環境（テスト、拡張コンテキスト
 * 外）や読み取り失敗では既定値を返す ―― rejectしない。
 */
export const loadRecentHandsLimit = async (): Promise<number> => {
  try {
    const stored = await chrome.storage?.local?.get(RECENT_HANDS_LIMIT_STORAGE_KEY)
    return resolveRecentHandsLimit(stored?.[RECENT_HANDS_LIMIT_STORAGE_KEY])
  } catch {
    return DEFAULT_RECENT_HANDS_LIMIT
  }
}

/**
 * 件数を保存する。`RECENT_HANDS_LIMIT_OPTIONS`にない値は書かない（不正値を
 * 永続化して次回起動時に既定へ落ちる、という分かりにくい挙動を避ける）。
 * 書き込み失敗は握りつぶす ―― 表示の好みが保存できないだけで、その場の
 * 表示は既に切り替わっている。
 */
export const saveRecentHandsLimit = (limit: number): void => {
  if (!isValidRecentHandsLimit(limit)) return
  try {
    const pending: unknown = chrome.storage?.local?.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: limit })
    if (pending instanceof Promise) pending.catch(() => { })
  } catch {
    // 保存できなくても表示は既に切り替わっているので、握りつぶしてよい。
  }
}

export const RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY = 'recentHandsParticipationOnly'

/**
 * 「参加のみ」の既定値。既定ONにするのは、ブラインド／アンテを取られただけの
 * ハンド（プリフロップ即フォールド・ウォーク）が一覧の大半を占めると、
 * 「直近ハンドを振り返る」という本来の用途で目的の行が埋もれるため。
 * ブラインド流出そのものを見たいときはOFFにすれば全件表示に戻る。
 */
export const DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY = true

export const resolveRecentHandsParticipationOnly = (value: unknown): boolean =>
  typeof value === 'boolean' ? value : DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY

/** 件数と同じくフェイルオープン（読めなければ既定値、rejectしない）。 */
export const loadRecentHandsParticipationOnly = async (): Promise<boolean> => {
  try {
    const stored = await chrome.storage?.local?.get(RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY)
    return resolveRecentHandsParticipationOnly(stored?.[RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY])
  } catch {
    return DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY
  }
}

/** 件数と同じく、書き込み失敗は握りつぶす（その場の表示は既に切り替わっている）。 */
export const saveRecentHandsParticipationOnly = (participationOnly: boolean): void => {
  if (typeof participationOnly !== 'boolean') return
  try {
    const pending: unknown = chrome.storage?.local?.set({
      [RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]: participationOnly,
    })
    if (pending instanceof Promise) pending.catch(() => { })
  } catch {
    // no-op
  }
}

/** パネルが読む設定一式。増えたときにパネル側のstateを増やさずに済むよう1つにまとめる。 */
export interface RecentHandsPanelConfig {
  limit: number
  participationOnly: boolean
}

export const DEFAULT_RECENT_HANDS_PANEL_CONFIG: RecentHandsPanelConfig = {
  limit: DEFAULT_RECENT_HANDS_LIMIT,
  participationOnly: DEFAULT_RECENT_HANDS_PARTICIPATION_ONLY,
}

/** 保存済み設定を1回のstorage読み取りでまとめて読む。 */
export const loadRecentHandsPanelConfig = async (): Promise<RecentHandsPanelConfig> => {
  try {
    const stored = await chrome.storage?.local?.get([
      RECENT_HANDS_LIMIT_STORAGE_KEY,
      RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY,
    ])
    return {
      limit: resolveRecentHandsLimit(stored?.[RECENT_HANDS_LIMIT_STORAGE_KEY]),
      participationOnly: resolveRecentHandsParticipationOnly(
        stored?.[RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]
      ),
    }
  } catch {
    return DEFAULT_RECENT_HANDS_PANEL_CONFIG
  }
}

/**
 * 他のパネル（＝他席のHUD）やタブでの変更を購読する。同じ端末で複数の
 * パネルを開いていても設定が食い違わないようにするための購読で、返り値は
 * 解除関数。変更のあったキーだけをpatchとして渡す。
 */
export const subscribeRecentHandsPanelConfig = (
  onChange: (patch: Partial<RecentHandsPanelConfig>) => void
): (() => void) => {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ): void => {
    if (areaName !== 'local') return
    const patch: Partial<RecentHandsPanelConfig> = {}
    if (RECENT_HANDS_LIMIT_STORAGE_KEY in changes) {
      patch.limit = resolveRecentHandsLimit(changes[RECENT_HANDS_LIMIT_STORAGE_KEY]?.newValue)
    }
    if (RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY in changes) {
      patch.participationOnly = resolveRecentHandsParticipationOnly(
        changes[RECENT_HANDS_PARTICIPATION_ONLY_STORAGE_KEY]?.newValue
      )
    }
    if (Object.keys(patch).length === 0) return
    onChange(patch)
  }
  try {
    chrome.storage?.onChanged?.addListener(listener)
  } catch {
    return () => { }
  }
  return () => {
    try {
      chrome.storage?.onChanged?.removeListener(listener)
    } catch {
      // no-op
    }
  }
}
