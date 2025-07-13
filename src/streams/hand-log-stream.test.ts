/**
 * HandLogStream Tests
 */

import { event_timeline } from '../app.test'
import type { HandLogEvent } from '../types/hand-log'
import { ApiType } from '../types/api'
import PokerChaseService, { PokerChaseDB } from '../app'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import { Readable } from 'stream'

// 期待される出力を定義し、エクスポート
export const expectedHandLogs = [
  [
    // リングゲームの場合: PokerChase Hand #156632473469:  Hold'em No Limit ($0.05/$0.10 USD) - 2016/07/30 10:40:31 AT [2016/07/30 9:40:31 ET]
    "PokerChase Game #175859516: Tournament #175859516, シーズンマッチ Hold'em No Limit - Level I (100/200) - 1970/01/01 09:00:00 JST", // Tournament # ... session最初のHandId
    "Table 'シーズンマッチ' 6-max Seat #6 is the button",
    'Seat 1: シュレディンガー (20000 in chips)', // anteを払う前の値
    'Seat 2: ぽちこん (20000 in chips)',
    'Seat 3: sola (20000 in chips)',
    'Seat 4: 夜菊0721 (20000 in chips)',
    'Seat 5: ちいまう (20000 in chips)',
    'Seat 6: ラロムジ (20000 in chips)',
    'シュレディンガー: posts the ante 50',
    'ぽちこん: posts the ante 50',
    'sola: posts the ante 50',
    '夜菊0721: posts the ante 50',
    'ちいまう: posts the ante 50',
    'ラロムジ: posts the ante 50',
    'シュレディンガー: posts small blind 100',
    'ぽちこん: posts big blind 200',
    '*** HOLE CARDS ***',
    'Dealt to sola [Jh Ac]',
    'sola: raises 400 to 600',
    '夜菊0721: folds',
    'ちいまう: folds',
    'ラロムジ: raises 1800 to 2400',
    'シュレディンガー: folds',
    'ぽちこん: raises 17550 to 19950 and is all-in',
    'sola: calls 19350 and is all-in',
    'ラロムジ: folds',
    '*** FLOP *** [9h 7d 3c]',
    '*** TURN *** [9h 7d 3c] [Ts]',
    '*** RIVER *** [9h 7d 3c Ts] [Jc]',
    '*** SHOW DOWN ***',
    'ぽちこん: shows [2h 2s] (a pair of Deuces)',
    'sola: shows [Jh Ac] (a pair of Jacks)',
    'sola collected 42700 from pot',
    'ぽちこん finished the tournament in 6th place',
    '*** SUMMARY ***',
    'Total pot 42700 | Rake 0',
    'Board [9h 7d 3c Ts Jc]',
    'Seat 1: シュレディンガー (small blind) folded before Flop',
    'Seat 2: ぽちこん (big blind) showed [2h 2s] and lost with a pair of Deuces',
    'Seat 3: sola showed [Jh Ac] and won (42700) with a pair of Jacks',
    "Seat 4: 夜菊0721 folded before Flop (didn't bet)",
    "Seat 5: ちいまう folded before Flop (didn't bet)",
    'Seat 6: ラロムジ (button) folded before Flop',
  ].join('\n'),
  [
    "PokerChase Game #175859726: Tournament #175859516, シーズンマッチ Hold'em No Limit - Level I (100/200) - 1970/01/01 09:00:00 JST",
    "Table 'シーズンマッチ' 6-max Seat #1 is the button",
    'Seat 1: シュレディンガー (19850 in chips)',
    'Seat 3: sola (42700 in chips)',
    'Seat 4: 夜菊0721 (19950 in chips)',
    'Seat 5: ちいまう (19950 in chips)',
    'Seat 6: ラロムジ (17550 in chips)',
    'シュレディンガー: posts the ante 50',
    'sola: posts the ante 50',
    '夜菊0721: posts the ante 50',
    'ちいまう: posts the ante 50',
    'ラロムジ: posts the ante 50',
    'sola: posts small blind 100',
    '夜菊0721: posts big blind 200',
    '*** HOLE CARDS ***',
    'Dealt to sola [Tc 2c]',
    'ちいまう: folds',
    'ラロムジ: raises 400 to 600',
    'シュレディンガー: folds',
    'sola: folds',
    '夜菊0721: calls 600',
    '*** FLOP *** [2h 7h Ks]',
    '夜菊0721: checks',
    'ラロムジ: checks',
    '*** TURN *** [2h 7h Ks] [8s]',
    '夜菊0721: checks',
    'ラロムジ: checks',
    '*** RIVER *** [2h 7h Ks 8s] [7c]',
    '夜菊0721: checks',
    'ラロムジ: checks',
    '*** SHOW DOWN ***',
    '夜菊0721: shows [2s 3s] (two pair, Sevens and Deuces)', // アクティブプレイヤー順にショーダウンを行う
    'ラロムジ: mucks hand',
    '夜菊0721 collected 1550 from pot',
    '*** SUMMARY ***',
    'Total pot 1550 | Rake 0',
    'Board [2h 7h Ks 8s 7c]',
    "Seat 1: シュレディンガー (button) folded before Flop (didn't bet)",
    'Seat 3: sola (small blind) folded before Flop',
    'Seat 4: 夜菊0721 (big blind) showed [2s 3s] and won (1550) with two pair, Sevens and Deuces',
    "Seat 5: ちいまう folded before Flop (didn't bet)",
    'Seat 6: ラロムジ mucked'
  ].join('\n')
]

test('ApiEventsからPokerStars形式のログを生成できる', async () => {
  const dbMock = new PokerChaseDB(indexedDB, IDBKeyRange)
  const service = new PokerChaseService({ db: dbMock, playerId: 561384657 })

  const sessionEvent = event_timeline.find(e => e.ApiTypeId === ApiType.EVT_SESSION_DETAILS)!
  service.session.name = sessionEvent.Name
  service.session.battleType = 0 // SNG

  const seatEvent = event_timeline.find(e => e.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED)!
  seatEvent.TableUsers?.forEach(user => {
    service.session.players.set(user.UserId, {
      name: user.UserName,
      rank: user.Rank.RankName
    })
  })

  const actual = await new Promise<string[]>((resolve, reject) => {
    const actualHandLogs: string[] = []
    service.handLogStream.on('data', (event: HandLogEvent) => {
      if (event.type === 'update' && event.entries)
        actualHandLogs.push(event.entries.map(({ text }) => text).join('\n'))
    })
      .on('end', () => resolve(actualHandLogs))
      .on('error', (error) => reject(error))
    Readable.from(event_timeline).pipe(service.handLogStream)
  })
  expect(actual).toEqual(expectedHandLogs)
})
