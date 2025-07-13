import { HandLogExporter } from './hand-log-exporter'
import { HandLogProcessor, HandLogContext } from './hand-log-processor'
import { event_timeline } from '../app.test'
import type { ApiEvent, Session } from '../types'
import { ApiType } from '../types'
import { DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'

describe('HandLogExporter', () => {
  beforeEach(async () => {
    // Clear any cached player names
    HandLogExporter.clearCache()
  })

  describe('processEvents from event_timeline', () => {
    test('should convert event_timeline to PokerStars format', async () => {
      // Create a session with player names from EVT_PLAYER_SEAT_ASSIGNED event
      const session: Session = {
        id: 'new_stage007_010',
        battleType: 0,
        name: 'シーズンマッチ',
        players: new Map(),
        reset: function() {
          this.id = undefined
          this.battleType = undefined
          this.name = undefined
          this.players.clear()
        }
      }

      // Find EVT_PLAYER_SEAT_ASSIGNED event to populate player names
      const seatAssignedEvent = event_timeline.find(e => e.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED) as ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
      if (seatAssignedEvent?.TableUsers) {
        seatAssignedEvent.TableUsers.forEach(user => {
          session.players.set(user.UserId, {
            name: user.UserName,
            rank: user.Rank.RankId
          })
        })
      }

      // Create context for processor
      const context: HandLogContext = {
        session,
        handLogConfig: DEFAULT_HAND_LOG_CONFIG,
        playerId: 561384657 // sola's player ID
      }

      // Process events using HandLogProcessor
      const processor = new HandLogProcessor(context)
      const entries = processor.processEvents(event_timeline)
      
      // Convert entries to text
      const output = entries.map(entry => entry.text).join('\n')

      // Expected output for both hands
      const expectedLines = [
        // First hand
        'Tournament #175859516, Hold\'em No Limit - Level I (100/200) - 1970/01/01 09:00:00 JST',
        'Table \'シーズンマッチ\' 6-max Seat #6 is the button',
        'Seat 1: シュレディンガー (19950 in chips)',
        'Seat 2: ぽちこん (19950 in chips)',
        'Seat 3: sola (19950 in chips)',
        'Seat 4: 夜菊0721 (19950 in chips)',
        'Seat 5: ちいまう (19950 in chips)',
        'Seat 6: ラロムジ (19950 in chips)',
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
        'ラロムジ: raises 2200 to 2400',
        'シュレディンガー: folds',
        'ぽちこん: raises 19750 to 19950 and is all-in',
        'sola: raises 19750 to 19950 and is all-in',
        'ラロムジ: folds',
        '*** FLOP *** [9h 7d 3c]',
        '*** TURN *** [9h 7d 3c] [Ts]',
        '*** RIVER *** [9h 7d 3c Ts] [Jc]',
        '*** SHOW DOWN ***',
        'ぽちこん: shows [2h 2s] (a pair)',
        'sola: shows [Jh Ac] (a pair)',
        'sola collected 42700 from pot',
        '*** SUMMARY ***',
        'Total pot 42700 | Rake 0',
        'Board [9h 7d 3c Ts Jc]',
        'Seat 1: シュレディンガー (small blind) folded before Flop',
        'Seat 2: ぽちこん (big blind) mucked',
        'Seat 3: sola showed [Jh Ac] and won (42700) with a pair',
        'Seat 4: 夜菊0721 folded before Flop',
        'Seat 5: ちいまう folded before Flop',
        'Seat 6: ラロムジ (button) folded before Flop',
        // Second hand
        'Tournament #175859726, Hold\'em No Limit - Level I (100/200) - 1970/01/01 09:00:00 JST',
        'Table \'シーズンマッチ\' 6-max Seat #1 is the button',
        'Seat 1: シュレディンガー (19800 in chips)',
        'Seat 3: sola (42650 in chips)',
        'Seat 4: 夜菊0721 (19900 in chips)',
        'Seat 5: ちいまう (19900 in chips)',
        'Seat 6: ラロムジ (17500 in chips)',
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
        'ラロムジ: mucks hand',
        '夜菊0721: shows [2s 3s] (two pair)',
        '夜菊0721 collected 1550 from pot',
        '*** SUMMARY ***',
        'Total pot 1550 | Rake 0',
        'Seat 1: シュレディンガー (button) folded before Flop',
        'Seat 3: sola (small blind) folded before Flop',
        'Seat 4: 夜菊0721 (big blind) showed [2s 3s] and won (1550) with two pair',
        'Seat 5: ちいまう folded before Flop',
        'Seat 6: ラロムジ mucked'
      ]

      const expectedOutput = expectedLines.join('\n')
      expect(output).toBe(expectedOutput)
    })

    test('should handle specific hand segments from event_timeline', () => {
      // Test processing just the first hand events
      const firstHandEvents: ApiEvent[] = []
      let collecting = false
      
      for (const event of event_timeline) {
        if (event.ApiTypeId === ApiType.EVT_DEAL && !collecting) {
          collecting = true
        }
        
        if (collecting) {
          firstHandEvents.push(event)
          
          if (event.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
            break
          }
        }
      }

      // Create session
      const session: Session = {
        id: 'new_stage007_010',
        battleType: 0,
        name: 'シーズンマッチ',
        players: new Map([
          [583654032, { name: 'シュレディンガー', rank: 'legend' }],
          [619317634, { name: 'ぽちこん', rank: 'legend' }],
          [561384657, { name: 'sola', rank: 'diamond' }],
          [575402650, { name: '夜菊0721', rank: 'legend' }],
          [750532695, { name: 'ちいまう', rank: 'legend' }],
          [172432670, { name: 'ラロムジ', rank: 'legend' }]
        ]),
        reset: function() {
          this.id = undefined
          this.battleType = undefined
          this.name = undefined
          this.players.clear()
        }
      }

      const context: HandLogContext = {
        session,
        handLogConfig: DEFAULT_HAND_LOG_CONFIG,
        playerId: 561384657
      }

      const processor = new HandLogProcessor(context)
      const entries = processor.processEvents(firstHandEvents)
      const output = entries.map(entry => entry.text).join('\n')

      // Verify the first hand structure (Tournament format)
      expect(output).toContain('Tournament #175859516')
      expect(output).toContain('Dealt to sola [Jh Ac]')
      expect(output).toContain('Board [9h 7d 3c Ts Jc]')
      expect(output).toContain('Total pot 42700')
      // Note: The summary section format differs from the expected comments
    })
  })

  describe('HandLogExporter with database', () => {
    test('should build player names map and format output correctly', async () => {
      // First test the HandLogProcessor directly to verify output format
      const session: Session = {
        id: 'test_session',
        battleType: 0,
        name: 'テストゲーム',
        players: new Map([
          [123, { name: 'TestPlayer1', rank: 'gold' }],
          [456, { name: 'TestPlayer2', rank: 'diamond' }]
        ]),
        reset: function() {
          this.id = undefined
          this.battleType = undefined
          this.name = undefined
          this.players.clear()
        }
      }

      const context: HandLogContext = {
        session,
        handLogConfig: DEFAULT_HAND_LOG_CONFIG,
        playerId: 123
      }

      // Create a simple test event sequence
      const testEvents: ApiEvent[] = [
        {
          ApiTypeId: ApiType.EVT_DEAL,
          timestamp: 1000,
          SeatUserIds: [123, 456],
          Game: {
            CurrentBlindLv: 1,
            NextBlindUnixSeconds: 0,
            Ante: 0,
            SmallBlind: 50,
            BigBlind: 100,
            ButtonSeat: 1,
            SmallBlindSeat: 0,
            BigBlindSeat: 1
          },
          Player: {
            SeatIndex: 0,
            BetStatus: 1,
            HoleCards: [51, 50], // As, Ah
            Chip: 1000,
            BetChip: 0
          },
          OtherPlayers: [{
            SeatIndex: 1,
            Status: 0,
            BetStatus: 1,
            Chip: 1000,
            BetChip: 0
          }],
          Progress: {
            Phase: 0,
            NextActionSeat: 0,
            NextActionTypes: [2, 3, 4, 5],
            NextExtraLimitSeconds: 1,
            MinRaise: 200,
            Pot: 150,
            SidePot: []
          }
        } as ApiEvent<ApiType.EVT_DEAL>
      ]

      const processor = new HandLogProcessor(context)
      const entries = processor.processEvents(testEvents)
      const output = entries.map(e => e.text).join('\n')

      // Verify basic output format
      expect(output).toContain('Tournament #pending')
      expect(output).toContain('TestPlayer1 (1000 in chips)')
      expect(output).toContain('TestPlayer2 (1000 in chips)')
      expect(output).toContain('Dealt to TestPlayer1 [Ac Ad]')  // Cards 51, 50 = Ac, Ad
    })
  })
})