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
 * EVT_DEALのGame.BigBlindSeat/SeatUserIdsからBBプレイヤーのIDを解決する。
 *
 * VPIP/PFRのウォーク除外（#115）判定用にHand.bigBlindUserIdへ設定する値を
 * 算出する共通ヘルパー。entity-converter.ts / write-entity-stream.ts の
 * 双方から同一ロジックで呼び出すことで、インポート/リビルドとライブ記録の
 * パリティを保つ。BigBlindSeatが不正（-1/未定義）、または対応座席が空席
 * （SeatUserIds[seat] === -1）の場合はundefinedを返す（防御的：実データでは
 * BigBlindSeatは常に着席済み座席を指す。docs/api-events.md参照）。
 */
export function getBigBlindUserId(seatUserIds: number[], bigBlindSeat: number): number | undefined {
  if (bigBlindSeat === undefined || bigBlindSeat === -1) return undefined
  const bbUserId = seatUserIds.at(bigBlindSeat)
  return bbUserId !== undefined && bbUserId !== -1 ? bbUserId : undefined
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
 * - ButtonSeatの占有者 → BTN（ヘッズアップ時は上記のSB判定が優先されるため、ここには来ない。
 *   同様にButtonSeat === BigBlindSeatの場合もBB判定が優先され、BTNは付与されない）
 * - 残りの着席プレイヤー: Button/SmallBlind/BigBlindの各座席を除き、BBの次の座席から
 *   時計回りに辿った順（＝アクション順）を求め、その順序を反転して「BTNに近い方から」
 *   CO, HJ, UTGの順にラベル付けする。
 *   人数が少ない場合は近い方のラベルのみ使われる（例: 4人卓ならBB, SB, BTN, COの4種）。
 *
 * 実データ検証結果（31,916件のEVT_DEAL全件に対して）:
 * - ButtonSeat/SmallBlindSeat/BigBlindSeatは全件で存在し、常に着席済み座席（-1でない）を指していた
 *   （範囲外・空席参照は0件）
 * - ButtonSeat === SmallBlindSeat（ヘッズアップ）は2,794件（8.75%）
 * - ButtonSeat === BigBlindSeat（SmallBlindSeatと異なる）は0件（未観測）
 * - デッドブラインドや欠落ブラインド座席のケースは検出されなかった
 * 上記により、本関数は「ButtonSeat/SmallBlindSeat/BigBlindSeatは必ず着席済み座席を指す」
 * ことを前提として実装している。ButtonSeat === BigBlindSeat（≠ SmallBlindSeat）は
 * 実データでは未観測だが、テストフィクスチャ（entity-converter.test.ts /
 * hand-log-processor.test.ts）に存在するため、誤動作しないよう防御的に扱っている
 * （BBラベルを優先し、時計回り収集はButton/SmallBlind/BigBlindの各座席をスキップする）。
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

  // ブラインドのラベルを先に確定させる。BB/SBは一次情報（ButtonSeat/SmallBlindSeat/
  // BigBlindSeatから直接決まる）なので、後段の時計回り収集がこれらの座席を
  // 再ラベル付けしないよう、先に「特別座席」の集合として扱う。
  const bbPlayerId = seatOccupant(BigBlindSeat)
  if (bbPlayerId !== undefined) {
    positions.set(bbPlayerId, Position.BB)
  }

  const sbPlayerId = seatOccupant(SmallBlindSeat)
  if (sbPlayerId !== undefined) {
    positions.set(sbPlayerId, Position.SB)
  }

  // BTNはSmallBlindSeat・BigBlindSeatのいずれとも異なる場合のみ付与する。
  // ButtonSeat === SmallBlindSeat はヘッズアップの正常系（SBラベルを優先、旧実装と同じ）。
  // ButtonSeat === BigBlindSeat は実データ31,916件のEVT_DEALでは0件観測（純粋に防御的）だが、
  // テストフィクスチャ（entity-converter.test.ts, hand-log-processor.test.ts）に存在するため
  // 対応する：この場合はBBラベルを優先し、BTNは付与しない（BBと同一座席のため）。
  if (!isHeadsUp && ButtonSeat !== BigBlindSeat) {
    const btnPlayerId = seatOccupant(ButtonSeat)
    if (btnPlayerId !== undefined) {
      positions.set(btnPlayerId, Position.BTN)
    }
  }

  // Button/SmallBlind/BigBlindの各座席（重複する場合は実質1〜2座席）を「特別座席」として
  // 除外し、それ以外の着席プレイヤーをBigBlindSeatの次から時計回りに収集する。
  // 従来は「seat === ButtonSeat」で走査を止めていたが、ButtonSeat === BigBlindSeatの
  // ケースでは開始座席（BigBlindSeat+1）と停止座席（ButtonSeat）が噛み合わず全周してしまい、
  // SB等の座席を誤って上書きし得た。特別座席の集合でスキップする方式なら、
  // どの組み合わせでも安全（該当座席をスキップし、それ以外を1周だけ収集する）。
  const specialSeats = new Set<number>([ButtonSeat, SmallBlindSeat, BigBlindSeat])
  const earlyToLate: number[] = []
  for (let offset = 1; offset < seatCount; offset++) {
    const seat = (BigBlindSeat + offset) % seatCount
    // 通常ジオメトリではボタン座席で走査を打ち切る。ボタンより後ろ（BTN〜BBの間）に
    // 配られたプレイヤーが座るケース（dead button等。実データ31,916件中213件で観測）では、
    // その席はボタンの直前に行動する席ではないため、CO/HJ/UTGのラベル対象に含めない
    // （旧実装と同一の挙動。ここを「スキップして続行」にするとBTN後方の席が
    // reverse後の先頭に来てCOラベルを横取りし、実プレイヤーのSTL/FTSがズレる）。
    // ButtonSeat === BigBlindSeat の防御ケースのみ打ち切りが機能しないため、
    // specialSeatsスキップで1周収集する。
    if (seat === ButtonSeat && ButtonSeat !== BigBlindSeat) break
    if (specialSeats.has(seat)) continue
    const playerId = seatOccupant(seat)
    if (playerId !== undefined) {
      earlyToLate.push(playerId)
    }
  }

  // BTNに近い方から順にCO, HJ, UTG, ...をラベル付けする
  // （既にBB/SB/BTNのラベルを持つプレイヤーは上書きしない）
  const lateToEarlyLabels = [Position.CO, Position.HJ, Position.UTG]
  const lateToEarly = earlyToLate.slice().reverse()
  lateToEarly.forEach((playerId, index) => {
    const label = lateToEarlyLabels[index]
    if (label !== undefined && !positions.has(playerId)) {
      positions.set(playerId, label)
    }
  })

  return positions
}
