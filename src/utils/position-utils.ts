import { Position } from '../types/game'

/**
 * ポジション計算に必要なGameイベントのサブセット
 */
export interface PositionGameInfo {
  ButtonSeat: number
  SmallBlindSeat: number
  BigBlindSeat: number
}

/**
 * 着席プレイヤーIDからポジション（Position enum値）へのマップを構築する。
 *
 * 背景（バグ修正の経緯）:
 * 旧実装は `rotateArrayFromIndex(seatUserIds, BigBlindSeat + 1).reverse()` で
 * 座席配列を回転させ、その配列上のインデックスからポジションを逆算していた。
 * この方式は「全座席が連続して埋まっている」ことを暗黙に仮定しており、
 * トーナメントのバスト等で空席（SeatUserIds内の-1）が生じると、
 * 空席が回転後の配列内でスロットを占有し続けるため、実プレイヤーの
 * インデックスがズレてポジションが誤って算出されていた。
 * 実データ（393,830イベント、うちEVT_DEAL 31,916件）を検証したところ、
 * 58.10%のハンドで空席が存在し、この方式ではハンド全体の29%でBTNの
 * ラベル付けが誤っていた。
 *
 * 新実装は回転を使わず、Game.ButtonSeat / SmallBlindSeat / BigBlindSeat という
 * 明示的なフィールドから直接ポジションを求める:
 * - BigBlindSeatの占有者 → BB
 * - SmallBlindSeatの占有者 → SB（ヘッズアップ時はButtonSeat === SmallBlindSeatとなり、
 *   このプレイヤーはSBのまま。これは旧実装のHU挙動と一致する）
 * - ButtonSeatの占有者 → BTN（ヘッズアップ時は上記のSB判定が優先されるため、ここには来ない）
 * - 残りの着席プレイヤー: BBの次の座席からBTNまで時計回りに辿った順（＝アクション順）を求め、
 *   その順序を反転して「BTNに近い方から」CO, HJ, UTGの順にラベル付けする。
 *   人数が少ない場合は近い方のラベルのみ使われる（例: 4人卓ならBB, SB, BTN, COの4種）。
 *
 * 実データ検証結果（31,916件のEVT_DEAL全件に対して）:
 * - ButtonSeat/SmallBlindSeat/BigBlindSeatは全件で存在し、常に着席済み座席（-1でない）を指していた
 *   （範囲外・空席参照は0件）
 * - ButtonSeat === SmallBlindSeat（ヘッズアップ）は2,794件（8.75%）
 * - デッドブラインドや欠落ブラインド座席のケースは検出されなかった
 * 上記により、本関数は「ButtonSeat/SmallBlindSeat/BigBlindSeatは必ず着席済み座席を指す」
 * ことを前提として実装している。
 *
 * @param seatUserIds 座席インデックス順のプレイヤーID配列（空席は-1）
 * @param game ButtonSeat/SmallBlindSeat/BigBlindSeatを含むGame情報
 * @returns プレイヤーID → Positionのマップ（空席・存在しないプレイヤーIDは含まれない）
 */
export function getPositionMap(seatUserIds: number[], game: PositionGameInfo): Map<number, Position> {
  const positions = new Map<number, Position>()
  const seatCount = seatUserIds.length
  const { ButtonSeat, SmallBlindSeat, BigBlindSeat } = game

  const seatOccupant = (seat: number): number | undefined => {
    const playerId = seatUserIds[((seat % seatCount) + seatCount) % seatCount]
    return playerId !== undefined && playerId !== -1 ? playerId : undefined
  }

  const isHeadsUp = ButtonSeat === SmallBlindSeat

  const bbPlayerId = seatOccupant(BigBlindSeat)
  if (bbPlayerId !== undefined) {
    positions.set(bbPlayerId, Position.BB)
  }

  const sbPlayerId = seatOccupant(SmallBlindSeat)
  if (sbPlayerId !== undefined) {
    positions.set(sbPlayerId, Position.SB)
  }

  if (!isHeadsUp) {
    const btnPlayerId = seatOccupant(ButtonSeat)
    if (btnPlayerId !== undefined) {
      positions.set(btnPlayerId, Position.BTN)
    }
  }

  // BBの次の座席からButtonSeatの手前まで、時計回りに着席プレイヤーを収集する
  // （＝プリフロップのアクション順で、UTGが先頭・BTN直前が末尾になる）
  const earlyToLate: number[] = []
  for (let offset = 1; offset < seatCount; offset++) {
    const seat = (BigBlindSeat + offset) % seatCount
    if (seat === ButtonSeat) break
    const playerId = seatOccupant(seat)
    if (playerId !== undefined) {
      earlyToLate.push(playerId)
    }
  }

  // BTNに近い方から順にCO, HJ, UTG, ...をラベル付けする
  const lateToEarlyLabels = [Position.CO, Position.HJ, Position.UTG]
  const lateToEarly = earlyToLate.slice().reverse()
  lateToEarly.forEach((playerId, index) => {
    const label = lateToEarlyLabels[index]
    if (label !== undefined) {
      positions.set(playerId, label)
    }
  })

  return positions
}
