/**
 * 保存済みのリプレイ詳細から、指定プレイヤーのホールカードを読む。
 *
 * WebSocket の `EVT_HAND_RESULTS` は、ショーダウンでマックした行
 * （`RankType: 11` = SHOWDOWN_MUCK）の `HoleCards` を空で送る。一方
 * `/replay/detail` は同じハンドについて実際の手札を返す ―― ゲーム自身の
 * リプレイ画面もそれを表示するので、**ショーダウンに到達した手は公開情報**
 * としてサーバが扱っている。
 *
 * 読み出しは許可リスト方式で、`Player` と `OtherPlayerList` の
 * `UserId` / `HoleCardList` だけを見る。payload は運営コンテンツなので
 * 形が変わりうる ―― 想定と違えば `null` を返すだけで、例外は投げない。
 */
import { formatCardsArray } from '../utils/card-utils'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readHoleCardList = (entry: unknown, playerId: number): number[] | undefined => {
  if (!isRecord(entry)) return undefined
  if (entry.UserId !== playerId) return undefined
  const cards = entry.HoleCardList
  if (!Array.isArray(cards)) return undefined
  if (!cards.every(card => typeof card === 'number')) return undefined
  return cards as number[]
}

/**
 * `payload` は `/replay/detail` 応答の `param`（`replayDetails.payload`）。
 * 見つからない・形が違う・カードが伏せられたままの場合は `null`。
 */
export const readReplayHoleCards = (
  payload: unknown,
  playerId: number
): string[] | null => {
  if (!isRecord(payload)) return null

  const candidates: unknown[] = [payload.Player]
  if (Array.isArray(payload.OtherPlayerList)) candidates.push(...payload.OtherPlayerList)

  for (const candidate of candidates) {
    const cards = readHoleCardList(candidate, playerId)
    // **ちょうど2枚・0〜51・重複なし**だけを受ける（MUST）。payloadは未検証の
    // 運営コンテンツで、サーバ変更・古いインポート・偽装結果で長さや値域が
    // 崩れうる。`formatCardsArray` は不正値を落とすだけなので、ここを緩めると
    // 1枚だけ・3枚のホールカードを描画してしまう。伏せられたままの席は
    // 空配列か `-1` 埋めで返るので、この条件で自然に弾ける。
    if (!cards || cards.length !== 2) continue
    if (!cards.every(card => Number.isSafeInteger(card) && card >= 0 && card <= 51)) continue
    if (cards[0] === cards[1]) continue
    const formatted = formatCardsArray(cards)
    if (formatted.length === 2) return formatted
  }
  return null
}
