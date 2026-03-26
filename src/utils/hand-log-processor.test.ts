/**
 * HandLogProcessor Tests - Edge Cases from GTO Wizard Import Errors
 *
 * These tests reproduce real-world issues found when importing PokerStars
 * format hand logs into GTO Wizard. Each test uses actual PokerChase raw
 * event data that triggered specific errors.
 */

import { HandLogProcessor, HandLogContext } from './hand-log-processor'
import { DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'
import type { Session, ApiEvent } from '../types'
import { ApiType } from '../types/api'
import { BattleType } from '../types/game'

/** Helper to create a session with given players */
function createSession(
  players: Array<{ userId: number; name: string; rank?: string }>,
  opts?: { battleType?: number; name?: string; id?: string }
): Session {
  const session: Session = {
    id: opts?.id,
    battleType: opts?.battleType ?? BattleType.SIT_AND_GO,
    name: opts?.name ?? 'TestTournament',
    players: new Map(),
    reset() {
      this.id = undefined
      this.battleType = undefined
      this.name = undefined
      this.players.clear()
    }
  }
  for (const p of players) {
    session.players.set(p.userId, { name: p.name, rank: p.rank ?? 'Unknown' })
  }
  return session
}

/** Helper to create context */
function createContext(session: Session, playerId?: number): HandLogContext {
  return {
    session,
    handLogConfig: DEFAULT_HAND_LOG_CONFIG,
    playerId,
    handTimestamp: 1700000000000
  }
}

/** Extract text lines from processor output */
function getLines(processor: HandLogProcessor, events: ApiEvent[]): string[] {
  const entries = processor.processEvents(events)
  return entries.map(e => e.text)
}

// ============================================================
// Test 1: Hero not participating (table move, empty HoleCards)
// Hand #435351195 — Hero has empty HoleCards after MTT table move
// ============================================================
describe('Hero未参加ハンド (テーブル移動直後)', () => {
  const players = [
    { userId: 487926122, name: 'Player487926122' },
    { userId: 561384657, name: 'sola' },
    { userId: 422437637, name: 'Player422437637' },
    { userId: 315105823, name: 'Player315105823' },
    { userId: 793762837, name: 'Player793762837' },
    { userId: 851368114, name: 'Player851368114' },
  ]

  const events: ApiEvent[] = [
    // EVT_DEAL with empty HoleCards for hero
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1762180220108,
      SeatUserIds: [487926122, 561384657, 422437637, 315105823, 793762837, 851368114],
      Game: {
        CurrentBlindLv: 18, NextBlindUnixSeconds: 1762180500,
        Ante: 250, SmallBlind: 500, BigBlind: 1000,
        ButtonSeat: 4, SmallBlindSeat: 5, BigBlindSeat: 0
      },
      Player: { SeatIndex: 1, BetStatus: 1, Chip: 21293, BetChip: 0, HoleCards: [] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 22096, BetChip: 1000 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 95641, BetChip: 0 },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 33044, BetChip: 0 },
        { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 31770, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 50300, BetChip: 500 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 2000, Pot: 3000, SidePot: []
      }
    } as unknown as ApiEvent,
  ]

  test('HoleCardsが空のハンドは出力されない', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)
    expect(lines).toEqual([])
  })
})

// ============================================================
// Test 2: Ante all-in (chip count == ante)
// Hand #428238733 — sola has exactly 70 chips, ante is 70
// ============================================================
describe('アンテオールイン (チップ == アンテ)', () => {
  const players = [
    { userId: 549822895, name: 'Player549822895' },
    { userId: 242988705, name: 'Player242988705' },
    { userId: 834636697, name: 'Player834636697' },
    { userId: 561384657, name: 'sola' },
    { userId: 865712115, name: 'Player865712115' },
    { userId: 147802279, name: 'Player147802279' },
  ]

  // From raw: hero seat=3, chip=0, betChip=0 (ante consumed all chips)
  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1760648041444,
      SeatUserIds: [549822895, 242988705, 834636697, 561384657, 865712115, 147802279],
      Game: {
        CurrentBlindLv: 3, NextBlindUnixSeconds: 1760648200,
        Ante: 70, SmallBlind: 140, BigBlind: 280,
        ButtonSeat: 4, SmallBlindSeat: 5, BigBlindSeat: 0
      },
      Player: { SeatIndex: 3, BetStatus: 1, Chip: 0, BetChip: 0, HoleCards: [10, 19] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 44054, BetChip: 280 },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 3308, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 35976, BetChip: 0 },
        { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 17080, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 15580, BetChip: 140 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 560, Pot: 72, SidePot: [1550]
      }
    } as unknown as ApiEvent,
    // Actions: seat 1 RAISE 840, seat 2 CALL 840, seat 4 CALL 840, seat 5 CALL 840, seat 0 FOLD
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648045497, SeatIndex: 1, ActionType: 4, BetChip: 840, Chip: 3308, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 1400, Pot: 72, SidePot: [1550] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648047518, SeatIndex: 2, ActionType: 3, BetChip: 840, Chip: 35976, Progress: { Phase: 0, NextActionSeat: 4, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 1400, Pot: 72, SidePot: [2390] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648049845, SeatIndex: 4, ActionType: 3, BetChip: 840, Chip: 17080, Progress: { Phase: 0, NextActionSeat: 5, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 1400, Pot: 72, SidePot: [3230] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648051716, SeatIndex: 5, ActionType: 3, BetChip: 840, Chip: 15580, Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 1400, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648053020, SeatIndex: 0, ActionType: 2, BetChip: 280, Chip: 44054, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    // FLOP
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1760648054072, CommunityCards: [14, 37, 31], OtherPlayers: [], Progress: { Phase: 1, NextActionSeat: 5, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    // Everyone checks on flop
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648059294, SeatIndex: 5, ActionType: 0, BetChip: 0, Chip: 15580, Progress: { Phase: 1, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648060317, SeatIndex: 1, ActionType: 0, BetChip: 0, Chip: 3308, Progress: { Phase: 1, NextActionSeat: 2, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648062043, SeatIndex: 2, ActionType: 0, BetChip: 0, Chip: 35976, Progress: { Phase: 1, NextActionSeat: 4, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648063966, SeatIndex: 4, ActionType: 0, BetChip: 0, Chip: 17080, Progress: { Phase: 1, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    // TURN
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1760648064969, CommunityCards: [18], OtherPlayers: [], Progress: { Phase: 2, NextActionSeat: 5, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    // Everyone checks on turn
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648067853, SeatIndex: 5, ActionType: 0, BetChip: 0, Chip: 15580, Progress: { Phase: 2, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648071542, SeatIndex: 1, ActionType: 0, BetChip: 0, Chip: 3308, Progress: { Phase: 2, NextActionSeat: 2, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648073425, SeatIndex: 2, ActionType: 0, BetChip: 0, Chip: 35976, Progress: { Phase: 2, NextActionSeat: 4, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648075886, SeatIndex: 4, ActionType: 0, BetChip: 0, Chip: 17080, Progress: { Phase: 2, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    // RIVER
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1760648076780, CommunityCards: [9], OtherPlayers: [], Progress: { Phase: 3, NextActionSeat: 5, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 72, SidePot: [3930] } } as unknown as ApiEvent,
    // River: seat 5 bets 3612, others fold
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648088292, SeatIndex: 5, ActionType: 1, BetChip: 3612, Chip: 11968, Progress: { Phase: 3, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 3, MinRaise: 7224, Pot: 72, SidePot: [7542] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648089487, SeatIndex: 1, ActionType: 2, BetChip: 0, Chip: 3308, Progress: { Phase: 3, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 3, MinRaise: 7224, Pot: 72, SidePot: [7542] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648091392, SeatIndex: 2, ActionType: 2, BetChip: 0, Chip: 35976, Progress: { Phase: 3, NextActionSeat: 4, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 3, MinRaise: 7224, Pot: 72, SidePot: [7542] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1760648092493, SeatIndex: 4, ActionType: 2, BetChip: 0, Chip: 17080, Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 72, SidePot: [7542] } } as unknown as ApiEvent,
    // HAND RESULTS
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1760648093504,
      HandId: 428238733,
      CommunityCards: [],
      Pot: 72, SidePot: [7542], ResultType: 0, DefeatStatus: 0,
      Results: [
        { UserId: 561384657, RankType: 7, HandRanking: 1, Hands: [19, 18, 10, 9, 37], HoleCards: [10, 19], Ranking: -2, RewardChip: 72 },
        { UserId: 147802279, RankType: 8, HandRanking: 2, Hands: [31, 30, 44, 37, 18], HoleCards: [30, 44], Ranking: -2, RewardChip: 7542 },
      ],
      Player: { SeatIndex: 3, BetStatus: -1, Chip: 72, BetChip: 0 },
      OtherPlayers: []
    } as unknown as ApiEvent,
  ]

  test('アンテでオールインしたプレイヤーに "and is all-in" が付与される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // sola's ante line should have "and is all-in" (actual ante may be less than game ante)
    const solaAnteLine = lines.find(l => l.includes('sola: posts the ante') && l.includes('and is all-in'))
    expect(solaAnteLine).toBeDefined()
    // sola should NOT post big blind (ante consumed all chips)
    expect(lines.find(l => l.includes('sola: posts big blind'))).toBeUndefined()
    // Other players' ante should NOT have "and is all-in"
    expect(lines).toContain('Player549822895: posts the ante 70')
    expect(lines.find(l => l === 'Player549822895: posts the ante 70 and is all-in')).toBeUndefined()
  })

  test('ショウダウン時でもuncalled betが出力される (サイドポットケース)', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // River bet of 3612 by Player147802279 was not called
    expect(lines.find(l => l.includes('Uncalled bet (3612) returned to Player147802279'))).toBeDefined()
  })
})

// ============================================================
// Test 3: Partial community cards in EVT_HAND_RESULTS
// Hand #421667480 — All-in on flop, TURN/RIVER only in results
// ============================================================
describe('コミュニティカード部分配信 (オールイン後)', () => {
  const players = [
    { userId: 484400430, name: 'Player484400430' },
    { userId: 561384657, name: 'sola' },
    { userId: 198761063, name: 'Player198761063' },
    { userId: 735515336, name: 'Player735515336' },
    { userId: 992622459, name: 'Player992622459' },
    { userId: 415571738, name: 'Player415571738' },
  ]

  // sola is ante all-in at BTN position (chip=630, ante=630)
  // BB is at seat 2 (normal), not sola
  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1759404700000,
      SeatUserIds: [484400430, 561384657, 198761063, 735515336, 992622459, 415571738],
      Game: {
        CurrentBlindLv: 9, NextBlindUnixSeconds: 1759404900,
        Ante: 630, SmallBlind: 1250, BigBlind: 2500,
        ButtonSeat: 1, SmallBlindSeat: 0, BigBlindSeat: 2
      },
      Player: { SeatIndex: 1, BetStatus: 1, Chip: 0, BetChip: 0, HoleCards: [11, 35] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 15660, BetChip: 1250 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 71780, BetChip: 2500 },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 33596, BetChip: 0 },
        { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 29246, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 25250, BetChip: 0 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 5000, Pot: 408, SidePot: [6560]
      }
    } as unknown as ApiEvent,
    // Preflop actions
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404701000, SeatIndex: 2, ActionType: 3, BetChip: 2500, Chip: 69280, Progress: { Phase: 0, NextActionSeat: 3, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 5000, Pot: 408, SidePot: [6560] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404702000, SeatIndex: 3, ActionType: 2, BetChip: 0, Chip: 33596, Progress: { Phase: 0, NextActionSeat: 4, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 5000, Pot: 408, SidePot: [6560] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404703000, SeatIndex: 4, ActionType: 2, BetChip: 0, Chip: 29246, Progress: { Phase: 0, NextActionSeat: 5, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 5000, Pot: 408, SidePot: [6560] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404704000, SeatIndex: 5, ActionType: 4, BetChip: 5000, Chip: 20250, Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 7500, Pot: 408, SidePot: [11560] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404705000, SeatIndex: 0, ActionType: 3, BetChip: 5000, Chip: 11910, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 7500, Pot: 408, SidePot: [15310] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404706000, SeatIndex: 2, ActionType: 2, BetChip: 2500, Chip: 69280, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 408, SidePot: [15310] } } as unknown as ApiEvent,
    // FLOP [Kc 2s Jh] = [47, 0, 37]
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1759404707000, CommunityCards: [47, 0, 37], OtherPlayers: [], Progress: { Phase: 1, NextActionSeat: 0, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 408, SidePot: [15310] } } as unknown as ApiEvent,
    // Flop: seat 0 checks, seat 5 all-in 20250, seat 0 folds
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404708000, SeatIndex: 0, ActionType: 0, BetChip: 0, Chip: 11910, Progress: { Phase: 1, NextActionSeat: 5, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 408, SidePot: [15310] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404709000, SeatIndex: 5, ActionType: 5, BetChip: 20250, Chip: 0, Progress: { Phase: 1, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 3, MinRaise: 40500, Pot: 408, SidePot: [35560] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1759404710000, SeatIndex: 0, ActionType: 2, BetChip: 0, Chip: 11910, Progress: { Phase: 1, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 408, SidePot: [35560] } } as unknown as ApiEvent,
    // HAND RESULTS — CommunityCards has only TURN+RIVER [8c, 8h] = [27, 25]
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1759404724958,
      HandId: 421667480,
      CommunityCards: [27, 25],  // Only TURN + RIVER cards!
      Pot: 408, SidePot: [35560], ResultType: 0, DefeatStatus: 1,
      Results: [
        { UserId: 415571738, RankType: 8, HandRanking: 1, Hands: [27, 25, 51, 47, 37], HoleCards: [34, 51], Ranking: -2, RewardChip: 35968 },
        { UserId: 561384657, RankType: 8, HandRanking: -1, Hands: [27, 25, 47, 37, 35], HoleCards: [11, 35], Ranking: 6, RewardChip: 0 },
      ],
      Player: { SeatIndex: 1, BetStatus: -1, Chip: 0, BetChip: 0 },
      OtherPlayers: []
    } as unknown as ApiEvent,
  ]

  test('FLOPカードが保持されTURN/RIVERが正しく追加される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // FLOP should be present with correct cards [Kc 2s Jh]
    expect(lines.find(l => l.includes('*** FLOP ***'))).toContain('Kc 2s Jh')

    // TURN should be present with accumulated board [8c]
    const turnLine = lines.find(l => l.includes('*** TURN ***'))
    expect(turnLine).toBeDefined()
    expect(turnLine).toContain('8c')

    // RIVER should be present [8h]
    const riverLine = lines.find(l => l.includes('*** RIVER ***'))
    expect(riverLine).toBeDefined()
    expect(riverLine).toContain('8h')

    // Board in summary should have all 5 cards
    const boardLine = lines.find(l => l.startsWith('Board'))
    expect(boardLine).toBeDefined()
    expect(boardLine).toContain('Kc')
    expect(boardLine).toContain('8c')
    expect(boardLine).toContain('8h')
  })

  test('アンテオールインのheroにand is all-inが付与される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // Actual ante amount may be less than game ante for short-stacked player
    const solaAnteLine = lines.find(l => l.includes('sola: posts the ante') && l.includes('and is all-in'))
    expect(solaAnteLine).toBeDefined()
    // BB should not be posted by sola (ante consumed all chips)
    expect(lines.find(l => l.includes('sola: posts big blind'))).toBeUndefined()
  })
})

// ============================================================
// Test 4: SB partial post (chip < SB amount)
// Hand #306397527 — Player with 3338 chips, ante 2200, SB 4300
//   → After ante: 1138 remaining, can only post partial SB
// ============================================================
describe('SB部分投入 (チップ < SB額)', () => {
  const players = [
    { userId: 561384657, name: 'sola' },
    { userId: 898959592, name: 'Player898959592' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1737299190000,
      SeatUserIds: [-1, -1, -1, 561384657, -1, 898959592],
      Game: {
        CurrentBlindLv: 12, NextBlindUnixSeconds: 1737299400,
        Ante: 2200, SmallBlind: 4300, BigBlind: 8600,
        ButtonSeat: 3, SmallBlindSeat: 5, BigBlindSeat: 3
      },
      Player: { SeatIndex: 3, BetStatus: 1, Chip: 165862, BetChip: 8600, HoleCards: [21, 27] },
      OtherPlayers: [
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 0, BetChip: 1138 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 3, NextActionTypes: [0, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 17200, Pot: 6676, SidePot: [7462]
      }
    } as unknown as ApiEvent,
    // sola checks
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1737299191000, SeatIndex: 3, ActionType: 0, BetChip: 8600, Chip: 165862, Progress: { Phase: 0, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 6676, SidePot: [7462] } } as unknown as ApiEvent,
    // HAND RESULTS — full board in CommunityCards
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1737299194825,
      HandId: 306397527,
      CommunityCards: [22, 26, 46, 14, 47],
      Pot: 6676, SidePot: [7462], ResultType: 1, DefeatStatus: 0,
      Results: [
        { UserId: 561384657, RankType: 7, HandRanking: 1, Hands: [47, 46, 27, 26, 22], HoleCards: [21, 27], Ranking: 1, RewardChip: 14138 },
        { UserId: 898959592, RankType: 8, HandRanking: -1, Hands: [47, 46, 41, 26, 22], HoleCards: [41, 3], Ranking: 2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 3, BetStatus: -1, Chip: 180000, BetChip: 0 },
      OtherPlayers: []
    } as unknown as ApiEvent,
  ]

  test('SBがチップ不足の場合、実際の投入額が表示される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // Player898959592 should post partial SB (1138, not 4300) and be all-in
    expect(lines).toContain('Player898959592: posts small blind 1138 and is all-in')
    // Should NOT show full SB amount
    expect(lines.find(l => l.includes('posts small blind 4300'))).toBeUndefined()
  })
})

// ============================================================
// Test 5: BB partial post (chip < BB amount after ante)
// Hand #306234673 — sola has 6320 chips, ante 3200, BB 13000
//   → After ante: 3120 remaining, can only post partial BB
// ============================================================
describe('BB部分投入 (チップ < BB額)', () => {
  const players = [
    { userId: 430263249, name: 'Player430263249' },
    { userId: 561384657, name: 'sola' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1737283610000,
      SeatUserIds: [430263249, -1, -1, -1, 561384657, -1],
      Game: {
        CurrentBlindLv: 13, NextBlindUnixSeconds: 1737283800,
        Ante: 3200, SmallBlind: 6500, BigBlind: 13000,
        ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 4
      },
      Player: { SeatIndex: 4, BetStatus: 1, Chip: 0, BetChip: 3120, HoleCards: [44, 29] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 163980, BetChip: 6500 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 0, NextActionTypes: [0, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 26000, Pot: 6676, SidePot: [7462]
      }
    } as unknown as ApiEvent,
    // Player430263249 calls
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1737283611000, SeatIndex: 0, ActionType: 3, BetChip: 13000, Chip: 157480, Progress: { Phase: 0, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 6676, SidePot: [9880] } } as unknown as ApiEvent,
    // HAND RESULTS
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1737283613475,
      HandId: 306234673,
      CommunityCards: [13, 7, 5, 1, 28],
      Pot: 12640, SidePot: [9880], ResultType: 1, DefeatStatus: 1,
      Results: [
        { UserId: 430263249, RankType: 3, HandRanking: 1, Hands: [7, 6, 5, 1, 0], HoleCards: [6, 0], Ranking: 1, RewardChip: 22520 },
        { UserId: 561384657, RankType: 7, HandRanking: -1, Hands: [29, 28, 7, 5, 44], HoleCards: [44, 29], Ranking: 2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 4, BetStatus: -1, Chip: 0, BetChip: 0 },
      OtherPlayers: []
    } as unknown as ApiEvent,
  ]

  test('BBがチップ不足の場合、実際の投入額が表示される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // sola should post partial BB (3120, not 13000) and be all-in
    expect(lines).toContain('sola: posts big blind 3120 and is all-in')
    // Should NOT show full BB amount
    expect(lines.find(l => l.includes('posts big blind 13000'))).toBeUndefined()
  })
})

// ============================================================
// Test 6: Summary for player with no action and no result
// (timeout/disconnect - no EVT_ACTION sent)
// ============================================================
describe('SUMMARY: アクション未記録プレイヤー', () => {
  const players = [
    { userId: 100, name: 'PlayerA' },
    { userId: 200, name: 'PlayerB' },
    { userId: 300, name: 'sola' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1700000000000,
      SeatUserIds: [100, 200, 300],
      Game: {
        CurrentBlindLv: 1, NextBlindUnixSeconds: 1700000200,
        Ante: 50, SmallBlind: 100, BigBlind: 200,
        ButtonSeat: 2, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 2, BetStatus: 1, Chip: 9750, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 9600, BetChip: 100 },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 9550, BetChip: 200 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 450, SidePot: []
      }
    } as unknown as ApiEvent,
    // sola raises, PlayerA folds — but PlayerB has NO action (timeout)
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 2, ActionType: 4, BetChip: 600, Chip: 9150, Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 1000, Pot: 1050, SidePot: [] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 0, ActionType: 2, BetChip: 100, Chip: 9600, Progress: { Phase: 0, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 1050, SidePot: [] } } as unknown as ApiEvent,
    // HAND RESULTS — only sola wins, PlayerB not in results
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1700000003000,
      HandId: 999999,
      CommunityCards: [],
      Pot: 1050, SidePot: [], ResultType: 0, DefeatStatus: 0,
      Results: [
        { UserId: 300, RankType: 10, HandRanking: 1, Hands: [], HoleCards: [], Ranking: -2, RewardChip: 1050 },
      ],
      Player: { SeatIndex: 2, BetStatus: -1, Chip: 10200, BetChip: 0 },
      OtherPlayers: []
    } as unknown as ApiEvent,
  ]

  test('アクション未記録のプレイヤーがSUMMARYで "folded before Flop" になる', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // PlayerB (seat 2 = BB) has no action and no result
    // Should show "folded before Flop" in summary
    // Use startsWith to match SUMMARY line (not the SEAT line)
    const playerBSummary = lines.find(l => l.startsWith('Seat 2: PlayerB') && l.includes('folded'))
    expect(playerBSummary).toBeDefined()
    expect(playerBSummary).toContain('folded before Flop')
  })
})

// ============================================================
// Test 7: サイドポット1つ (3人オールイン、ショートスタック1人)
// posts-allin.txt 参考: メインポット勝者とサイドポット勝者が同一
// ============================================================
describe('サイドポット1つ (ショウダウン)', () => {
  const players = [
    { userId: 100, name: 'ShortStack' },
    { userId: 200, name: 'BigStack' },
    { userId: 300, name: 'MedStack' },
    { userId: 400, name: 'Folder' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1700000000000,
      SeatUserIds: [100, 200, 300, 400, -1, -1],
      Game: {
        CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600,
        Ante: 0, SmallBlind: 50, BigBlind: 100,
        ButtonSeat: 3, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 1, BetStatus: 1, Chip: 900, BetChip: 100, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 50, BetChip: 50, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 500, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 500, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 150, SidePot: []
      }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000,
      SeatIndex: 0, ActionType: 5, Chip: 0, BetChip: 100,
      Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 200, SidePot: [] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000,
      SeatIndex: 2, ActionType: 3, Chip: 400, BetChip: 100,
      Progress: { Phase: 0, NextActionSeat: 3, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 300, SidePot: [] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000003000,
      SeatIndex: 3, ActionType: 2, Chip: 500, BetChip: 0,
      Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 300, SidePot: [] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000004000,
      SeatIndex: 1, ActionType: 4, Chip: 700, BetChip: 300,
      Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 500, Pot: 500, SidePot: [] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000005000,
      SeatIndex: 2, ActionType: 3, Chip: 200, BetChip: 300,
      Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 300, SidePot: [400] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000006000,
      CommunityCards: [0, 4, 8],
      Player: { SeatIndex: 1, BetStatus: 2, Chip: 700, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 4, Chip: 0, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 2, Chip: 200, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 1, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 300, SidePot: [400] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000007000,
      CommunityCards: [12],
      Player: { SeatIndex: 1, BetStatus: 2, Chip: 700, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 4, Chip: 0, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 2, Chip: 200, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 2, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 300, SidePot: [400] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000008000,
      CommunityCards: [16],
      Player: { SeatIndex: 1, BetStatus: 2, Chip: 700, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 4, Chip: 0, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 2, Chip: 200, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 3, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 300, SidePot: [400] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000009000,
      CommunityCards: [0, 4, 8, 12, 16],
      Pot: 300, SidePot: [400],
      ResultType: 0, DefeatStatus: 0, HandId: 999001, HandLog: '',
      Results: [
        { UserId: 200, HoleCards: [48, 49], RankType: 8, Hands: [48, 49, 0, 4, 8], HandRanking: 1, Ranking: -2, RewardChip: 700 },
        { UserId: 100, HoleCards: [20, 21], RankType: 9, Hands: [20, 21, 0, 4, 8], HandRanking: -1, Ranking: 4, RewardChip: 0 },
        { UserId: 300, HoleCards: [24, 25], RankType: 9, Hands: [24, 25, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 1, BetStatus: -1, Chip: 1700, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 5, BetStatus: -1, Chip: 0, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 200, BetChip: 0 },
        { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 500, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('collected行がside pot → main pot の順で出力される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const collectedLines = lines.filter(l => l.includes('collected'))
    expect(collectedLines).toHaveLength(2)
    expect(collectedLines[0]).toBe('BigStack collected 400 from side pot')
    expect(collectedLines[1]).toBe('BigStack collected 300 from main pot')
  })

  test('Summary行にMain pot / Side pot内訳が表示される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const totalPotLine = lines.find(l => l.includes('Total pot'))
    expect(totalPotLine).toBe('Total pot 700 Main pot 300. Side pot 400. | Rake 0')
  })

  test('ポット整合: Pot + sum(SidePot) == sum(RewardChip)', () => {
    const resultEvent = events.find(e => (e as any).ApiTypeId === ApiType.EVT_HAND_RESULTS) as any
    const totalPot = resultEvent.Pot + resultEvent.SidePot.reduce((s: number, p: number) => s + p, 0)
    const totalReward = resultEvent.Results.reduce((s: number, r: any) => s + r.RewardChip, 0)
    expect(totalPot).toBe(totalReward)
  })

  test('SeatサマリーでBigStackの獲得額はRewardChip合計', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const bigStackSummary = lines.find(l => l.startsWith('Seat 2: BigStack') && l.includes('won'))
    expect(bigStackSummary).toContain('won (700)')
  })
})

// ============================================================
// Test 8: サイドポットで異なるプレイヤーが各ポットを獲得
// ============================================================
describe('サイドポット: 異なるプレイヤーが各ポットを獲得', () => {
  const players = [
    { userId: 100, name: 'ShortAll' },
    { userId: 200, name: 'MedAll' },
    { userId: 300, name: 'BigCaller' },
    { userId: 400, name: 'Folder' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
      SeatUserIds: [100, 200, 300, 400, -1, -1],
      Game: {
        CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600,
        Ante: 0, SmallBlind: 50, BigBlind: 100,
        ButtonSeat: 3, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 2, BetStatus: 1, Chip: 1000, BetChip: 0, HoleCards: [40, 41] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 50, BetChip: 50, IsSafeLeave: false },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 200, BetChip: 100, IsSafeLeave: false },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 500, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 150, SidePot: [] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 0, ActionType: 5, Chip: 0, BetChip: 100, Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 200, SidePot: [] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 1, ActionType: 5, Chip: 0, BetChip: 300, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 500, Pot: 300, SidePot: [200] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000003000, SeatIndex: 3, ActionType: 2, Chip: 500, BetChip: 0, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 500, Pot: 300, SidePot: [200] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000004000, SeatIndex: 2, ActionType: 3, Chip: 700, BetChip: 300, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 300, SidePot: [400] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000009000,
      CommunityCards: [0, 4, 8, 12, 16], Pot: 300, SidePot: [400],
      ResultType: 0, DefeatStatus: 0, HandId: 999002, HandLog: '',
      Results: [
        // メインポット勝者: ShortAll (最強ハンドだがオールインで少額)
        { UserId: 100, HoleCards: [48, 49], RankType: 6, Hands: [48, 49, 0, 4, 8], HandRanking: 1, Ranking: -2, RewardChip: 300 },
        // サイドポット勝者: MedAll (メインでは負けだがサイドポット分は獲得)
        { UserId: 200, HoleCards: [44, 45], RankType: 8, Hands: [44, 45, 0, 4, 8], HandRanking: 2, Ranking: -2, RewardChip: 400 },
        // 敗者: BigCaller
        { UserId: 300, HoleCards: [40, 41], RankType: 9, Hands: [40, 41, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 2, BetStatus: -1, Chip: 700, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 300, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 400, BetChip: 0 },
        { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 500, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('異なるプレイヤーのcollected行が正しく出力される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // side pot → main pot の順
    const collectedLines = lines.filter(l => l.includes('collected'))
    expect(collectedLines).toHaveLength(2)
    expect(collectedLines[0]).toBe('MedAll collected 400 from side pot')
    expect(collectedLines[1]).toBe('ShortAll collected 300 from main pot')
  })
})

// ============================================================
// Test 9: 複数サイドポット (全ポットを1人が獲得)
// ============================================================
describe('複数サイドポット (2つ)', () => {
  const players = [
    { userId: 100, name: 'Tiny' },
    { userId: 200, name: 'Small' },
    { userId: 300, name: 'Hero' },
    { userId: 400, name: 'Big' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
      SeatUserIds: [100, 200, 300, 400, -1, -1],
      Game: {
        CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600,
        Ante: 0, SmallBlind: 10, BigBlind: 20,
        ButtonSeat: 3, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 2, BetStatus: 1, Chip: 500, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 40, BetChip: 10, IsSafeLeave: false },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 180, BetChip: 20, IsSafeLeave: false },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 500, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 40, Pot: 30, SidePot: [] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 0, ActionType: 5, Chip: 0, BetChip: 50, Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 100, Pot: 70, SidePot: [] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 1, ActionType: 5, Chip: 0, BetChip: 200, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 200, SidePot: [150] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000003000, SeatIndex: 2, ActionType: 3, Chip: 200, BetChip: 300, Progress: { Phase: 0, NextActionSeat: 3, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 200, SidePot: [300, 100] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000004000, SeatIndex: 3, ActionType: 3, Chip: 200, BetChip: 300, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 200, SidePot: [450, 200] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000009000,
      CommunityCards: [0, 4, 8, 12, 16], Pot: 200, SidePot: [450, 200],
      ResultType: 0, DefeatStatus: 0, HandId: 999003, HandLog: '',
      Results: [
        { UserId: 300, HoleCards: [48, 49], RankType: 6, Hands: [48, 49, 0, 4, 8], HandRanking: 1, Ranking: -2, RewardChip: 850 },
        { UserId: 100, HoleCards: [20, 21], RankType: 9, Hands: [20, 21, 0, 4, 8], HandRanking: -1, Ranking: 4, RewardChip: 0 },
        { UserId: 200, HoleCards: [24, 25], RankType: 9, Hands: [24, 25, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
        { UserId: 400, HoleCards: [28, 29], RankType: 9, Hands: [28, 29, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 2, BetStatus: -1, Chip: 1050, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 5, BetStatus: -1, Chip: 0, BetChip: 0 },
        { SeatIndex: 1, Status: 5, BetStatus: -1, Chip: 0, BetChip: 0 },
        { SeatIndex: 3, Status: 0, BetStatus: -1, Chip: 200, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('全ポットを1人が獲得: side pot-2 → side pot-1 → main pot', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const collectedLines = lines.filter(l => l.includes('collected'))
    expect(collectedLines).toHaveLength(3)
    expect(collectedLines[0]).toBe('Hero collected 200 from side pot-2')
    expect(collectedLines[1]).toBe('Hero collected 450 from side pot-1')
    expect(collectedLines[2]).toBe('Hero collected 200 from main pot')
  })

  test('Summary行に複数サイドポットの内訳が表示される', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const totalPotLine = lines.find(l => l.includes('Total pot'))
    expect(totalPotLine).toBe('Total pot 850 Main pot 200. Side pot-1 450. Side pot-2 200. | Rake 0')
  })
})

// ============================================================
// Test 10: サイドポットなし (regression)
// ============================================================
describe('サイドポットなし (regression)', () => {
  const players = [
    { userId: 100, name: 'PlayerA' },
    { userId: 200, name: 'PlayerB' },
    { userId: 300, name: 'Hero' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
      SeatUserIds: [100, 200, 300, -1, -1, -1],
      Game: {
        CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600,
        Ante: 0, SmallBlind: 50, BigBlind: 100,
        ButtonSeat: 2, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 2, BetStatus: 1, Chip: 1000, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 950, BetChip: 50, IsSafeLeave: false },
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 900, BetChip: 100, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 150, SidePot: [] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 2, ActionType: 4, Chip: 800, BetChip: 200, Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 300, Pot: 350, SidePot: [] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 0, ActionType: 2, Chip: 950, BetChip: 50, Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 300, Pot: 350, SidePot: [] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000003000, SeatIndex: 1, ActionType: 3, Chip: 800, BetChip: 200, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 450, SidePot: [] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000004000,
      CommunityCards: [0, 4, 8],
      Player: { SeatIndex: 2, BetStatus: 2, Chip: 800, BetChip: 0, HoleCards: [48, 49] },
      OtherPlayers: [{ SeatIndex: 1, Status: 0, BetStatus: 2, Chip: 800, BetChip: 0, IsSafeLeave: false }],
      Progress: { Phase: 1, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 450, SidePot: [] }
    } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000009000,
      CommunityCards: [0, 4, 8, 12, 16], Pot: 450, SidePot: [],
      ResultType: 0, DefeatStatus: 0, HandId: 999004, HandLog: '',
      Results: [
        { UserId: 300, HoleCards: [48, 49], RankType: 6, Hands: [48, 49, 0, 4, 8], HandRanking: 1, Ranking: -2, RewardChip: 450 },
        { UserId: 200, HoleCards: [20, 21], RankType: 9, Hands: [20, 21, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 2, BetStatus: -1, Chip: 1450, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 950, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 800, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('サイドポットなしの場合 "from pot" のまま', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const collectedLine = lines.find(l => l.includes('collected'))
    expect(collectedLine).toBe('Hero collected 450 from pot')
  })

  test('Summary行にSide pot内訳が含まれない', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const totalPotLine = lines.find(l => l.includes('Total pot'))
    expect(totalPotLine).toBe('Total pot 450')
    expect(totalPotLine).not.toContain('Main pot')
  })
})

// ============================================================
// Test 11: キャッシュゲーム + サイドポット
// ============================================================
describe('キャッシュゲーム + サイドポット', () => {
  const players = [
    { userId: 100, name: 'Short' },
    { userId: 200, name: 'Hero' },
    { userId: 300, name: 'Caller' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
      SeatUserIds: [100, 200, 300, -1, -1, -1],
      Game: {
        CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600,
        Ante: 0, SmallBlind: 50, BigBlind: 100,
        ButtonSeat: 2, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 1, BetStatus: 1, Chip: 900, BetChip: 100, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 50, BetChip: 50, IsSafeLeave: false },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 1000, BetChip: 0, IsSafeLeave: false },
      ],
      Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 150, SidePot: [] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 0, ActionType: 5, Chip: 0, BetChip: 100, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 200, Pot: 200, SidePot: [] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 2, ActionType: 3, Chip: 900, BetChip: 100, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 300, SidePot: [] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000009000,
      CommunityCards: [0, 4, 8, 12, 16], Pot: 300, SidePot: [],
      ResultType: 0, DefeatStatus: 0, HandId: 999005, HandLog: '',
      Results: [
        { UserId: 200, HoleCards: [48, 49], RankType: 6, Hands: [48, 49, 0, 4, 8], HandRanking: 1, Ranking: -2, RewardChip: 300 },
        { UserId: 100, HoleCards: [20, 21], RankType: 9, Hands: [20, 21, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
        { UserId: 300, HoleCards: [24, 25], RankType: 9, Hands: [24, 25, 0, 4, 8], HandRanking: -1, Ranking: -2, RewardChip: 0 },
      ],
      Player: { SeatIndex: 1, BetStatus: -1, Chip: 1200, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 0, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 900, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('キャッシュゲームのSummaryに "| Rake 0" が含まれる', () => {
    const session = createSession(players, { battleType: 4 })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    const totalPotLine = lines.find(l => l.includes('Total pot'))
    expect(totalPotLine).toBe('Total pot 300 | Rake 0')
  })
})
