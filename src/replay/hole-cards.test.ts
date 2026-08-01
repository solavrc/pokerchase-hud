import { readReplayHoleCards } from './hole-cards'

const HERO = 561384657
const VILLAIN = 619317634

const payload = {
  Game: { PlayerNum: 6 },
  Player: { SeatIndex: 5, UserId: HERO, HoleCardList: [40, 41] },
  OtherPlayerList: [
    { SeatIndex: 0, UserId: VILLAIN, HoleCardList: [1, 0] },
    { SeatIndex: 1, UserId: 111111111, HoleCardList: [] },
    { SeatIndex: 2, UserId: 222222222, HoleCardList: [-1, -1] }
  ]
}

describe('readReplayHoleCards', () => {
  test('ヒーロー自身の手札を読む', () => {
    expect(readReplayHoleCards(payload, HERO)).toEqual(['Qs', 'Qh'])
  })

  test('相手の手札も読む（マックした行の穴埋めが目的）', () => {
    expect(readReplayHoleCards(payload, VILLAIN)).toEqual(['2h', '2s'])
  })

  test('伏せられたまま（空配列・-1埋め）は null', () => {
    expect(readReplayHoleCards(payload, 111111111)).toBeNull()
    expect(readReplayHoleCards(payload, 222222222)).toBeNull()
  })

  test('該当プレイヤーが居なければ null', () => {
    expect(readReplayHoleCards(payload, 999999999)).toBeNull()
  })

  /**
   * payloadは運営コンテンツなので形が変わりうる。想定と違えばnullを返すだけで、
   * 例外を投げてはならない（呼び出し元は直近ハンドパネルの描画経路）。
   */
  // Codexレビュー指摘: payloadは未検証の運営コンテンツ。長さや値域が崩れた
  // ものを通すと、1枚だけ・3枚のホールカードを描画してしまう。
  test('ちょうど2枚・0〜51・重複なし以外は null', () => {
    const oddPayloads = [
      { Player: { UserId: HERO, HoleCardList: [48] } },
      { Player: { UserId: HERO, HoleCardList: [48, 49, 50] } },
      { Player: { UserId: HERO, HoleCardList: [48, 999] } },
      { Player: { UserId: HERO, HoleCardList: [48, 48] } },
      { Player: { UserId: HERO, HoleCardList: [48, 1.5] } }
    ]
    for (const payload of oddPayloads) {
      expect(readReplayHoleCards(payload, HERO)).toBeNull()
    }
  })

  test('形が違っても例外を投げず null を返す', () => {
    expect(readReplayHoleCards(undefined, HERO)).toBeNull()
    expect(readReplayHoleCards(null, HERO)).toBeNull()
    expect(readReplayHoleCards('nope', HERO)).toBeNull()
    expect(readReplayHoleCards({ Player: 'nope', OtherPlayerList: 'nope' }, HERO)).toBeNull()
    expect(readReplayHoleCards({ Player: { UserId: HERO, HoleCardList: ['a', 'b'] } }, HERO)).toBeNull()
  })
})
