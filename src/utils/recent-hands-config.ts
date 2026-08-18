/**
 * 「直近ハンド」パネルの表示設定（表示件数 #341 / 「参加のみ」 #353）:
 * 選択肢の定義と、その永続化。
 *
 * 定数をrecent-hands-service.tsではなくここに置くのは、パネル（content
 * script側）から件数の選択肢を参照する必要があるため。サービス側には
 * Dexie・background/replay-import・リプレイ解析が芋づるで繋がっているので、
 * UIがサービスをimportするとcontent scriptのバンドルにそれらが丸ごと入る。
 * このモジュールはchrome APIを関数の中でしか触らない葉モジュールで、
 * background側からimportしても副作用はない。
 *
 * 保存先は`chrome.storage.local`（端末ローカル）。`uiScale`/`hudPosition_*`
 * （ui-config-storage.ts）と同じ「表示の好みは端末ごと」の扱いに揃える。
 * `sync`を使わない理由は2つ:
 *  - 件数は画面サイズ依存の見た目設定で、端末間で共有する意味が薄い。
 *  - `storage.sync`には書き込み回数クォータ（MAX_WRITE_OPERATIONS_PER_MINUTE）
 *    があり、スイッチャーを続けて押すと簡単に踏む。
 *
 * 読み書きは信頼できるbackground（message-router.tsの
 * `getRecentHandsPanelConfig`/`setRecentHandsPanelConfig`）を経由する。
 * このモジュールのcontent script向け関数から`chrome.storage.local`を直接
 * 触ってはならない（MUST NOT）: `firebase-auth-service`が起動時に
 * `setAccessLevel('TRUSTED_CONTEXTS')`でlocalエリアをcontent scriptから
 * 遮断しており（#274、`e2e/scenarios/auth-storage-access.ts`が実ブラウザで
 * assert済み）、直接のget/setは必ずrejectされ、`storage.onChanged`も
 * untrusted contextには配送されない。直接アクセスしていた頃は#341/#353の
 * 選択が毎回既定値へ静かに戻っていた（unitテストのchromeモックはアクセス
 * レベルを強制しないため気づけなかった）。`uiScale`/`hudPosition_*`/
 * `handLogLayout`と同じ経路に揃える。
 *
 * 値は`RECENT_HANDS_LIMIT_OPTIONS`のいずれかだけを受け付ける。範囲外・型違い・
 * 未設定はすべて`DEFAULT_RECENT_HANDS_LIMIT`へ倒す（フェイルオープン。
 * この設定の読み取り失敗でパネルが出なくなってはならない）。
 */
import type {
  GetRecentHandsPanelConfigMessage,
  SetRecentHandsPanelConfigMessage,
} from '../types/messages'

/**
 * 件数スイッチャーの選択肢。最大値は「全部DOMに出しても仮想化が要らない」
 * 上限として選んだ ―― 100行 × 6セルはHUD1枚あたり高々600ノードで、HandLogが
 * react-windowを使う理由（セッション全体のログ＝行数が原理的に無制限）は
 * ここには当てはまらない。パネル側は代わりに高さ上限＋スクロールで収める
 * （RecentHandsPanel.tsx参照）。
 */
export const RECENT_HANDS_LIMIT_OPTIONS: readonly number[] = [10, 25, 50, 100]

/** `RECENT_HANDS_LIMIT_OPTIONS`の最大値＝1画面に出し得る最大行数。 */
export const MAX_RECENT_HANDS_LIMIT: number =
  RECENT_HANDS_LIMIT_OPTIONS[RECENT_HANDS_LIMIT_OPTIONS.length - 1]!

/**
 * サービス側が実際に組み立ててキャッシュする件数（#353のレビュー指摘対応）。
 *
 * 表示上限（100）ちょうどしか組み立てないと、「参加のみ」ONで100件を選んだ
 * ときに**必ず**100件に届かない ―― 直近100ハンドの中に即フォールドが1件でも
 * あれば足りなくなるため。母集合を表示上限の3倍まで広げることで、直近300
 * ハンドの1/3以上で自発的にチップを入れていれば100件が埋まる（VPIP 33%
 * 相当。実測レンジでは通常満たす）。
 *
 * 3倍で止めるのは、これがライブ対局中のオーバーレイだから: actions/phasesは
 * どちらもインデックス1回のバッチクエリのまま（往復は増えない）だが、
 * 走査する行数は母集合に比例する。ここを無制限にすると「直近N件」ではなく
 * 全履歴走査になる。届かない場合は拾えただけを返す。
 */
export const RECENT_HANDS_ASSEMBLY_LIMIT: number = MAX_RECENT_HANDS_LIMIT * 3

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
 * 件数を保存する。`RECENT_HANDS_LIMIT_OPTIONS`にない値は送らない（不正値を
 * 永続化して次回起動時に既定へ落ちる、という分かりにくい挙動を避ける。
 * background側でも`sanitizeRecentHandsPanelConfigPatch`が同じ検証をする）。
 * 送信失敗は握りつぶす ―― 表示の好みが保存できないだけで、その場の
 * 表示は既に切り替わっている。
 */
export const saveRecentHandsLimit = (limit: number): void => {
  if (!isValidRecentHandsLimit(limit)) return
  sendRecentHandsPanelConfigPatch({ limit })
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

/** 件数と同じく、送信失敗は握りつぶす（その場の表示は既に切り替わっている）。 */
export const saveRecentHandsParticipationOnly = (participationOnly: boolean): void => {
  if (typeof participationOnly !== 'boolean') return
  sendRecentHandsPanelConfigPatch({ participationOnly })
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

/**
 * patchを検証して、有効なキーだけを残す。有効なキーが1つも無ければ`null`。
 * background（message-router.tsの`setRecentHandsPanelConfig`）と購読側
 * （broadcast受信）の両方が使う、patchの形の唯一の正本。不正な値は既定値へ
 * 読み替えず**落とす** ―― 不正値の混じったpatchで保存や表示を既定値へ
 * 巻き戻すより、そのキーを無視する方が安全。
 */
export const sanitizeRecentHandsPanelConfigPatch = (
  raw: unknown
): Partial<RecentHandsPanelConfig> | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = raw as Record<string, unknown>
  const patch: Partial<RecentHandsPanelConfig> = {}
  if (isValidRecentHandsLimit(candidate.limit)) patch.limit = candidate.limit
  if (typeof candidate.participationOnly === 'boolean') {
    patch.participationOnly = candidate.participationOnly
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * 設定読み取りのタイムアウト（ms）。`DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS`と同じ
 * 1秒: backgroundのSWが寝ていると起床を待つが、パネルの表示をそれ以上
 * 引きずらない。タイムアウトは「既定値で表示する」であって失敗ではない。
 */
export const RECENT_HANDS_CONFIG_MESSAGE_TIMEOUT_MS = 1_000

/**
 * 保存済み設定をbackground経由でまとめて読む。応答なし・タイムアウト・
 * 拡張コンテキスト外（テスト等）はすべて既定値へ倒す（フェイルオープン、
 * rejectしない）。
 */
export const loadRecentHandsPanelConfig = (): Promise<RecentHandsPanelConfig> =>
  new Promise(resolve => {
    let settled = false
    const finish = (config: RecentHandsPanelConfig): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(config)
    }
    const timeoutId = setTimeout(
      () => finish(DEFAULT_RECENT_HANDS_PANEL_CONFIG),
      RECENT_HANDS_CONFIG_MESSAGE_TIMEOUT_MS
    )
    try {
      const message: GetRecentHandsPanelConfigMessage = { action: 'getRecentHandsPanelConfig' }
      chrome.runtime.sendMessage(
        message,
        (response?: { success?: boolean, config?: unknown }) => {
          // SWが一時的に居ない場合のunchecked errorを消費する。
          void chrome.runtime.lastError
          // backgroundも保存値をresolve済みで返すが、ここでも通す（多層防御）:
          // 検証済みの値しかReactのstateへ入れない。
          const stored = response?.success === true
            && typeof response.config === 'object' && response.config !== null
            ? response.config as Record<string, unknown>
            : undefined
          finish({
            limit: resolveRecentHandsLimit(stored?.['limit']),
            participationOnly: resolveRecentHandsParticipationOnly(stored?.['participationOnly']),
          })
        }
      )
    } catch {
      finish(DEFAULT_RECENT_HANDS_PANEL_CONFIG)
    }
  })

/** 検証済みpatchをbackgroundへ送る。保存とbroadcastはbackgroundが行う。 */
const sendRecentHandsPanelConfigPatch = (patch: Partial<RecentHandsPanelConfig>): void => {
  try {
    const message: SetRecentHandsPanelConfigMessage = { action: 'setRecentHandsPanelConfig', patch }
    chrome.runtime.sendMessage(message, () => {
      // 保存できなくても表示は既に切り替わっているので、握りつぶしてよい。
      void chrome.runtime.lastError
    })
  } catch {
    // 拡張コンテキスト外（テスト等）では何もしない。
  }
}

/**
 * broadcastをcontent_script.tsがwindowイベントへ変換するときのイベント名。
 * メッセージのaction名（`MESSAGE_ACTIONS.UPDATE_RECENT_HANDS_PANEL_CONFIG`）
 * と同じ文字列（`updateHandLogLayout`等の既存broadcastと同じ流儀）。
 */
export const RECENT_HANDS_PANEL_CONFIG_EVENT = 'updateRecentHandsPanelConfig'

/**
 * 他のパネル（＝他席のHUD）やタブでの変更を購読する。同じ端末で複数の
 * パネルを開いていても設定が食い違わないようにするための購読で、返り値は
 * 解除関数。変更のあったキーだけをpatchとして渡す。
 *
 * 変更はbackgroundが保存成功後に全ゲームタブへbroadcastし、
 * content_script.tsが同名のwindow CustomEvent（detail = patch）へ変換した
 * ものを受け取る。`storage.onChanged`は使えない ―― TRUSTED_CONTEXTSゲートで
 * untrusted contextには配送されない（モジュール冒頭のコメント参照）。
 * detailはこの購読にとって外部入力なので、`sanitizeRecentHandsPanelConfigPatch`
 * を通し、有効なキーが無ければ通知しない。
 */
export const subscribeRecentHandsPanelConfig = (
  onChange: (patch: Partial<RecentHandsPanelConfig>) => void
): (() => void) => {
  const listener = (event: Event): void => {
    const detail: unknown = (event as CustomEvent).detail
    const patch = sanitizeRecentHandsPanelConfigPatch(detail)
    if (!patch) return
    onChange(patch)
  }
  try {
    window.addEventListener(RECENT_HANDS_PANEL_CONFIG_EVENT, listener)
  } catch {
    // windowが無い環境（background SW等）では購読しない。
    return () => { }
  }
  return () => {
    try {
      window.removeEventListener(RECENT_HANDS_PANEL_CONFIG_EVENT, listener)
    } catch {
      // no-op
    }
  }
}
