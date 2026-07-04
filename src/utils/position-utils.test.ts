import { getPositionMap } from './position-utils'
import { Position } from '../types/game'

describe('getPositionMap', () => {
  it('6人フルリング（空席なし）で全ポジションを正しく割り当てる', () => {
    // seat: 0=SB, 1=BB, 2=UTG, 3=HJ, 4=CO, 5=BTN
    const seatUserIds = [600, 601, 602, 603, 604, 605]
    const game = { ButtonSeat: 5, SmallBlindSeat: 0, BigBlindSeat: 1 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(600)).toBe(Position.SB)
    expect(positions.get(601)).toBe(Position.BB)
    expect(positions.get(602)).toBe(Position.UTG)
    expect(positions.get(603)).toBe(Position.HJ)
    expect(positions.get(604)).toBe(Position.CO)
    expect(positions.get(605)).toBe(Position.BTN)
    expect(positions.size).toBe(6)
  })

  it('4人卓（空席なし）ではBTNの次はCOのみに割り当てる', () => {
    // seat: 0=UTG, 1=BTN, 2=SB, 3=BB
    const seatUserIds = [10, 20, 30, 40]
    const game = { ButtonSeat: 1, SmallBlindSeat: 2, BigBlindSeat: 3 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(10)).toBe(Position.CO) // BTNの直前 = COラベル
    expect(positions.get(20)).toBe(Position.BTN)
    expect(positions.get(30)).toBe(Position.SB)
    expect(positions.get(40)).toBe(Position.BB)
    expect(positions.size).toBe(4)
  })

  it('ヘッズアップ（ButtonSeat === SmallBlindSeat）ではボタンのプレイヤーはSBになる', () => {
    const seatUserIds = [111, 222]
    const game = { ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(111)).toBe(Position.SB) // ボタン件SB
    expect(positions.get(222)).toBe(Position.BB)
    expect(positions.size).toBe(2)
  })

  /**
   * バグ検証用ケース（issue記載の実データ由来の例）
   * seats: [-1, -1, A, B, -1, C], Game = { ButtonSeat: 2, SmallBlindSeat: 3, BigBlindSeat: 5 }
   *
   * 旧実装（rotateArrayFromIndexで座席配列を回転してインデックスから逆算する方式）は、
   * 空席（-1）が回転後の配列内でスロットを占有するため、実プレイヤーのインデックスが
   * ズレてしまい、Bを実際のBTN(seat2)、Aを実際のSB(seat3)であるにもかかわらず
   * Bを BTN(0)、Aを CO(1) と誤ってラベル付けしていた（本来はAがBTN、BがSB）。
   * 新実装はGame.ButtonSeat/SmallBlindSeat/BigBlindSeatから直接算出するため、
   * 空席の有無に関わらず正しいポジションが得られる。
   */
  it('空席（-1）を含む座席配列でもButtonSeat/SmallBlindSeat/BigBlindSeatから正しく算出する', () => {
    const A = 100, B = 200, C = 300
    const seatUserIds = [-1, -1, A, B, -1, C]
    const game = { ButtonSeat: 2, SmallBlindSeat: 3, BigBlindSeat: 5 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(A)).toBe(Position.BTN)
    expect(positions.get(B)).toBe(Position.SB)
    expect(positions.get(C)).toBe(Position.BB)
    expect(positions.size).toBe(3)
  })

  it('空席を挟んだ短期テーブルでCO/HJを正しく割り当てる（着席5人）', () => {
    // 6座席中、着席は5人。seat1が空席。
    const P0 = 1, P2 = 3, P3 = 4, P4 = 5, P5 = 6
    const seatUserIds = [P0, -1, P2, P3, P4, P5]
    const game = { ButtonSeat: 4, SmallBlindSeat: 5, BigBlindSeat: 0 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(P0)).toBe(Position.BB)
    expect(positions.get(P5)).toBe(Position.SB)
    expect(positions.get(P4)).toBe(Position.BTN)
    // BBの次はseat1（空席、スキップ）→ seat2(P2), seat3(P3)の順で着席。
    // BTN直前（最もBTNに近い）のP3がCO、その手前のP2がHJ。
    // 着席5人のためUTGラベルは使われない。
    expect(positions.get(P3)).toBe(Position.CO)
    expect(positions.get(P2)).toBe(Position.HJ)
    expect(positions.size).toBe(5)
  })

  it('着席人数が3人の場合はBB, SB, BTNのみに割り当てる', () => {
    const seatUserIds = [1, 2, 3]
    const game = { ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(1)).toBe(Position.BTN)
    expect(positions.get(2)).toBe(Position.SB)
    expect(positions.get(3)).toBe(Position.BB)
    expect(positions.size).toBe(3)
  })

  it('空席のプレイヤーIDはマップに含まれない', () => {
    const seatUserIds = [-1, 2, 3, -1, 5, 6]
    const game = { ButtonSeat: 4, SmallBlindSeat: 5, BigBlindSeat: 1 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.has(-1)).toBe(false)
  })

  /**
   * 防御的テスト: ButtonSeat === BigBlindSeat（≠ SmallBlindSeat）。
   * 実データ31,916件のEVT_DEAL全件では0件観測（未観測の組み合わせ）だが、
   * entity-converter.test.ts（ButtonSeat:1, SmallBlindSeat:0, BigBlindSeat:1）や
   * hand-log-processor.test.ts（ButtonSeat:3, SmallBlindSeat:5, BigBlindSeat:3）の
   * 合成フィクスチャに存在するため、誤動作しないことを保証する。
   *
   * 旧実装では、この組み合わせだと (a) BB占有者のラベルがBTNで上書きされ、
   * (b) 時計回り走査の停止条件 `seat === ButtonSeat` が
   * 開始座席（BigBlindSeat+1）と噛み合わず発火しないため全周してしまい、
   * SB占有者のラベルまでCO/HJ/UTGで上書きされ得た。
   */
  it('ButtonSeat === BigBlindSeat（防御的・実データ未観測）ではBBラベルを優先しBTNは付与しない', () => {
    // hand-log-processor.test.ts の実フィクスチャに準拠した座席配置
    const seatUserIds = [-1, -1, -1, 561384657, -1, 898959592]
    const game = { ButtonSeat: 3, SmallBlindSeat: 5, BigBlindSeat: 3 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(561384657)).toBe(Position.BB) // BTN===BBの座席はBB優先、BTNは付与されない
    expect(positions.get(898959592)).toBe(Position.SB) // 誤って上書きされない
    expect(positions.size).toBe(2)
  })

  it('ButtonSeat === BigBlindSeat（防御的・実データ未観測）で他の着席プレイヤーはCO/HJ/UTGを正しく受け取る', () => {
    // entity-converter.test.ts の実フィクスチャに準拠した座席配置（6人フルリング相当）
    const seatUserIds = [10, 20, 30, 40, 50, 60]
    const game = { ButtonSeat: 1, SmallBlindSeat: 0, BigBlindSeat: 1 }

    const positions = getPositionMap(seatUserIds, game)

    expect(positions.get(20)).toBe(Position.BB) // ButtonSeat===BigBlindSeat: BB優先、BTN付与なし
    expect(positions.get(10)).toBe(Position.SB)
    // BBの次（seat2）からBBの手前（seat0はSBなので除外済み）までを時計回りに収集:
    // seat2, seat3, seat4, seat5 → 反転してBTNに近い方から CO, HJ, UTG
    expect(positions.get(60)).toBe(Position.CO)
    expect(positions.get(50)).toBe(Position.HJ)
    expect(positions.get(40)).toBe(Position.UTG)
    // 4番目（seat2=30）はUTGの手前で、ラベルが尽きているため付与されない
    expect(positions.has(30)).toBe(false)
    expect(positions.size).toBe(5)
  })
})
