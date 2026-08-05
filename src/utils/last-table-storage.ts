/**
 * 「最後の卓の復元」(#358の保持表示の永続化): セッション終了後にHUDへ残って
 * いる**表示用**ラインナップを`chrome.storage.local`へ（backgroundを経由して）
 * 書き、次のマウント時に読み戻すための葉モジュール。
 *
 * なぜ要るか: #358の保持（`App.tsx`の`dimCacheRef` / 保持ラインナップ /
 * `lastKnownStats`）はすべてReactのメモリ上にしかない。拡張のリロード、
 * ブラウザ再起動、content scriptの再注入のいずれでも消えるので、対局後に
 * 「さっきの卓の誰かの直近ハンドを見返す」ことが**次のライブDEALが来るまで
 * 一切できない**（sola実例, 2026-08）。ここで永続化するのは、その復習を
 * リロードをまたいで可能にするためだけのもの。
 *
 * 位置づけ（MUST）: これは**表示専用**のスナップショットである。統計
 * パイプライン、ACTIVEポートのトークン判定、リプレイ取得の可否判定へは
 * 一切入力してはならない。復元された座席は「現在この卓にこの人がいる」と
 * いう主張ではなく、「前回この表示を出していた」という記録にすぎない。
 * ライブの信頼済みDEAL・セッション境界は従来どおり唯一の権威で、復元状態は
 * それらに出会った瞬間に捨てられる（App.tsx参照）。
 *
 * 保存先が`chrome.storage.local`（端末ローカル・同期しない）なのは
 * `uiScale`/`hudPosition_*`（ui-config-storage.ts）や
 * `recentHandsLimit`（recent-hands-config.ts）と同じ理由に加えて、
 *  - 卓のラインナップは端末というより「その端末で開いていたゲームタブ」の
 *    状態であり、別端末へ同期する意味がない。
 *  - `storage.sync`には書き込み回数クォータがあり、ハンドごとに書く用途に
 *    そもそも向かない。
 *
 * このモジュールはDexieもbackgroundも引かない（content scriptのバンドルへ
 * 余計な依存を持ち込まないため。recent-hands-config.tsと同じ方針）。
 */
import { z } from 'zod'
import type { ExistPlayerStats, PlayerStats } from '../types/entities'

export const LAST_TABLE_SNAPSHOT_STORAGE_KEY = 'lastTableSnapshot'

/**
 * 保存形式のバージョン。形が変わったら上げる。読み出し側は**一致しない
 * バージョンを復元しない**（MUST、フェイルクローズ）―― 古い形を推測で
 * 読み替えるより、復元しないで空席から始める方が安全な種類のデータ
 * （表示専用で、次のハンドで必ず作り直される）。
 */
export const LAST_TABLE_SNAPSHOT_VERSION = 1

/**
 * 書き込みのデバウンス（ms）。`PokerChaseService.persistState()`と同じ値に
 * 揃えてある。ハンド完了ごと（＝数十秒に1回）が本来の更新頻度で、これは
 * 頻度を抑えるためというより、同じティックに複数の集計メッセージが束で
 * 届くケース（再構築後の一括更新、遅延到着の集計）を1回の書き込みへ
 * 畳むためのもの。アクションごとには**書かない**（MUST NOT）―― 実況更新
 * (`realTimeOnly`)はラインナップを触らないので、そもそも呼び出し側に
 * 到達しない。
 */
export const LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS = 500

/**
 * 復元読み取りのタイムアウト（ms）。`DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS`と
 * 同じ1秒: backgroundのSWが寝ていると起床を待つが、HUDの描画をそれ以上
 * 引きずらない。タイムアウトは「復元しない」であって失敗ではない。
 */
export const LAST_TABLE_SNAPSHOT_MESSAGE_TIMEOUT_MS = 1_000

/**
 * ヒーロー席（表示座席0）は**保存しない**（MUST NOT）。ヒーロー枠は
 * マウント直後のpregameキャリア統計（`getLatestSessionStats({preGame:true})`、
 * AGENTS.md「Pre-game hero stats」）が所有していて、復元がそこへ割り込むと
 * 「DBから計算し直した最新のキャリア統計」を「前回表示していた古い値」で
 * 上書きしかねない。復元の目的は*相手*の統計とドリルダウンへ到達すること
 * なので、ヒーロー席は既存の経路に任せる。
 */
export const LAST_TABLE_HERO_SEAT_INDEX = 0

/**
 * 1座席分のスナップショット。
 *
 * `playerId`と`playerName`は明示的に持つ: 復元後にユーザーが実際にやりたい
 * のは「この相手の直近ハンドを見る」であり、ドリルダウンは`playerId`だけを
 * 使ってIndexedDBを引く。`statResults`が将来どう変わっても、この2つが
 * 生き残っていればその導線は成立する。`statResults`は`Hud`がそのまま描く
 * 表示値の配列（`ExistPlayerStats.statResults`）。
 */
const lastTableSeatSchema = z.object({
  /** 表示座席index（ヒーロー基準に回転済み。`Hud`の`seat-${index}`と同じ空間） */
  seatIndex: z.number().int().min(1).max(5),
  playerId: z.number().int(),
  /**
   * 表示名。`statResults`内の`playerName`と重複するが、こちらは記録側の
   * 正本ではなく**フォールバック**として使う: 復元時に`statResults`へ
   * `playerName`が含まれていなければ、この値から補う（App.tsx参照）。
   * 取得できなかった場合は`null`。
   */
  playerName: z.string().nullable(),
  /**
   * `Hud`が描く表示値。中身は`StatResult`だが、`ExistPlayerStats`側が
   * `z.array(z.any())`のままなのでここでも構造だけを検証する ――
   * `id`/`name`が文字列で、`value`がJSONで往復できる形（数値・文字列・
   * [分子, 分母]）であること。これを満たさない要素が1つでもあれば
   * スナップショット全体を捨てる（フェイルクローズ）。
   */
  statResults: z.array(z.object({
    id: z.string(),
    name: z.string(),
    value: z.union([z.number(), z.string(), z.tuple([z.number(), z.number()])]),
    formatted: z.string().optional(),
    tooltip: z.string().optional(),
  })),
})

const lastTableSnapshotSchema = z.object({
  version: z.literal(LAST_TABLE_SNAPSHOT_VERSION),
  /** `Date.now()`。復元はしないが、いつの卓かを診断できるようにしておく。 */
  savedAt: z.number(),
  seats: z.array(lastTableSeatSchema),
})

export type LastTableSeatSnapshot = z.infer<typeof lastTableSeatSchema>
export type LastTableSnapshot = z.infer<typeof lastTableSnapshotSchema>

const isExistPlayerStats = (stat: PlayerStats): stat is ExistPlayerStats =>
  stat.playerId !== -1

const readPlayerName = (stat: ExistPlayerStats): string | null => {
  const nameResult = stat.statResults?.find(
    (result: { id?: unknown, name?: unknown }) => result?.id === 'playerName' || result?.name === 'Name'
  )
  return typeof nameResult?.value === 'string' ? nameResult.value : null
}

/**
 * 現在の表示ラインナップからスナップショットを組み立てる。
 *
 * ヒーロー席と空席は落とす。実プレイヤーが1人も残らない場合は`null`を返す
 * ―― 何も入っていないスナップショットで既存の記録を上書きしても、
 * 「最後の卓」を消すだけで得るものがない（セッション境界の破棄で
 * `EMPTY_SEATS`になった直後がまさにこれ）。
 *
 * 書き込む値は`Hud`へ渡っているものそのもので、ここでは統計を再計算しない
 * （MUST NOT: 表示のスナップショットであって、二つ目の計算経路ではない）。
 */
export const buildLastTableSnapshot = (
  stats: readonly PlayerStats[],
  now: number = Date.now(),
): LastTableSnapshot | null => {
  const seats: LastTableSeatSnapshot[] = []
  stats.forEach((stat, seatIndex) => {
    if (seatIndex === LAST_TABLE_HERO_SEAT_INDEX) return
    if (seatIndex < 1 || seatIndex > 5) return
    if (!isExistPlayerStats(stat)) return
    const statResults = lastTableSeatSchema.shape.statResults.safeParse(stat.statResults)
    if (!statResults.success) return
    seats.push({
      seatIndex,
      playerId: stat.playerId,
      playerName: readPlayerName(stat),
      statResults: statResults.data,
    })
  })
  if (seats.length === 0) return null
  return { version: LAST_TABLE_SNAPSHOT_VERSION, savedAt: now, seats }
}

/**
 * 保存済みの値を検証する。バージョン違い・型違い・欠損はすべて`null`
 * （＝復元しない、従来どおり空席から始める）へ倒す。フェイルクローズ:
 * 壊れた記録から一部だけ拾って復元すると、「誰の統計かわからないパネル」が
 * 出る方が空席より悪い。
 */
export const parseLastTableSnapshot = (raw: unknown): LastTableSnapshot | null => {
  const parsed = lastTableSnapshotSchema.safeParse(raw)
  if (!parsed.success) return null
  if (parsed.data.seats.length === 0) return null
  // 同じ表示座席が2つあると復元先が決まらない。壊れた記録として扱う。
  const seatIndices = new Set(parsed.data.seats.map(seat => seat.seatIndex))
  if (seatIndices.size !== parsed.data.seats.length) return null
  return parsed.data
}

/**
 * 保存済みスナップショットを背景経由で読む。
 *
 * **content scriptから`chrome.storage.local`を直接触ってはならない**（MUST
 * NOT）: `firebase-auth-service`が起動時に
 * `setAccessLevel('TRUSTED_CONTEXTS')`でlocalエリアをcontent scriptから
 * 遮断しており（#274、`e2e/scenarios/auth-storage-access.ts`が実ブラウザで
 * assert済み）、直接のget/setは必ずrejectされる。`uiScale`/`hudPosition_*`/
 * `handLogLayout`と同じく、信頼できるbackground（message-router.ts）を
 * 経由する。
 *
 * 応答なし・タイムアウト・壊れた記録はすべて`null`（＝復元しない）。
 * この読み取りの失敗でHUDが出なくなってはならない。
 */
export const loadLastTableSnapshot = (
  callback: (snapshot: LastTableSnapshot | null) => void,
): void => {
  let settled = false
  const finish = (snapshot: LastTableSnapshot | null) => {
    if (settled) return
    settled = true
    clearTimeout(timeoutId)
    callback(snapshot)
  }
  const timeoutId = setTimeout(
    () => finish(null),
    LAST_TABLE_SNAPSHOT_MESSAGE_TIMEOUT_MS
  )

  try {
    chrome.runtime.sendMessage(
      { action: 'getLastTableSnapshot' },
      (response: { success?: boolean, snapshot?: unknown } | undefined) => {
        // SWが一時的に居ない場合のunchecked errorを消費する。
        void chrome.runtime.lastError
        // backgroundも同じ`parseLastTableSnapshot`で検証しているが、ここでも
        // 通す（多層防御）: 検証済みの形しかReactのstateへ入れない。
        finish(response?.success === true ? parseLastTableSnapshot(response.snapshot) : null)
      }
    )
  } catch {
    finish(null)
  }
}

/**
 * 保存された1座席を`Hud`が描ける`ExistPlayerStats`へ戻す。
 *
 * `statResults`に`playerName`が入っていなければ、明示フィールドの
 * `playerName`から補う ―― HUDのヘッダーはこの結果から名前を引くので、
 * 補わないと「Player 12345」表示になり、誰の卓だったのか分からなくなる。
 * 逆に`statResults`側に名前があればそちらが正本（表示していた値そのもの）。
 * どちらにも無ければ補わない（名前を捏造しない）。
 */
export const restoreSeatStats = (seat: LastTableSeatSnapshot): ExistPlayerStats => {
  const hasName = seat.statResults.some(result => result.id === 'playerName')
  if (hasName || seat.playerName === null) {
    return { playerId: seat.playerId, statResults: seat.statResults }
  }
  return {
    playerId: seat.playerId,
    statResults: [
      { id: 'playerName', name: 'Name', value: seat.playerName, formatted: seat.playerName },
      ...seat.statResults,
    ],
  }
}

let pendingSaveTimer: ReturnType<typeof setTimeout> | undefined

/**
 * スナップショットの保存をデバウンスして予約する。`stats`は呼び出し時点の
 * 値でスナップショットにするので、タイマー発火までの間に状態が変わっても
 * 「予約した時点の表示」が保存される（最後の予約が勝つ）。
 */
export const scheduleLastTableSnapshotSave = (stats: readonly PlayerStats[]): void => {
  const snapshot = buildLastTableSnapshot(stats)
  if (!snapshot) return
  if (pendingSaveTimer !== undefined) clearTimeout(pendingSaveTimer)
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = undefined
    try {
      chrome.runtime.sendMessage({ action: 'setLastTableSnapshot', snapshot }, () => {
        // 表示の付加機能なので、保存失敗は握りつぶす（次のハンドで書き直す）。
        void chrome.runtime.lastError
      })
    } catch {
      // 拡張コンテキスト外（テスト等）では何もしない。
    }
  }, LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS)
}

/** 予約済みの書き込みを取り消す（アンマウント・テスト用）。 */
export const cancelPendingLastTableSnapshotSave = (): void => {
  if (pendingSaveTimer === undefined) return
  clearTimeout(pendingSaveTimer)
  pendingSaveTimer = undefined
}
