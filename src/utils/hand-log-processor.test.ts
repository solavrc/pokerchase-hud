/**
 * HandLogProcessor Tests - Edge Cases from GTO Wizard Import Errors
 *
 * These tests reproduce real-world issues found when importing PokerStars
 * format hand logs into GTO Wizard. Each test uses actual PokerChase raw
 * event data that triggered specific errors.
 */

import { HandLogProcessor, HandLogContext } from './hand-log-processor'
import { DEFAULT_HAND_LOG_CONFIG } from '../types/hand-log'
import type { HandLogEntry } from '../types/hand-log'
import type { Session, ApiEvent } from '../types'
import { ApiType } from '../types/api'
import { BattleType } from '../types/game'

/** Helper to create a session with given players */
function createSession(
  players: Array<{ userId: number; name: string; rank?: string }>,
  opts?: { battleType?: number; name?: string; id?: string }
): Session {
  const playersMap = new Map<number, { name: string, rank: string }>()
  for (const p of players) {
    playersMap.set(p.userId, { name: p.name, rank: p.rank ?? 'Unknown' })
  }
  const session: Session = {
    id: opts?.id,
    battleType: opts?.battleType ?? BattleType.SIT_AND_GO,
    name: opts?.name ?? 'TestTournament',
    players: playersMap,
    reset() {
      this.id = undefined
      this.battleType = undefined
      this.name = undefined
      playersMap.clear()
    }
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
// Test 9.5: サイドポット帰属 (regression) — Hand #296039758
// HandRanking=1 がメインポット+side pot-1 を総取りし、
// HandRanking=2 が side pot-2 のみ獲得する実データハンド。
// 旧実装は「potIdx+1 == HandRanking」で対応付けていたため、
// side pot-1 を HandRanking=2 に誤帰属していた。
// ============================================================
describe('サイドポット帰属: HandRanking=1がメイン+side1を総取り (Hand #296039758)', () => {
  const players = [
    { userId: 1001, name: 'PlayerA' },
    { userId: 1002, name: 'PlayerB' },
    { userId: 1003, name: 'PlayerC' },
    { userId: 561384657, name: 'sola' },
    { userId: 1004, name: 'PlayerD' },
  ]

  // Hero (SB) はアンテオールイン (Chip=0, BetChip=0)、BB (PlayerD) は 560359 で
  // オールイン、BTN (PlayerC) が 1000000 をコール。
  // RewardChip: PlayerD = 1875830 = main 620448 + side1 1255382 (HandRanking=1),
  //             PlayerC = 439641 = side2 のみ (HandRanking=2)。
  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1735318901395,
      SeatUserIds: [1001, 1002, 1003, -1, 561384657, 1004],
      Game: { CurrentBlindLv: 16, NextBlindUnixSeconds: -1, Ante: 200000, SmallBlind: 500000, BigBlind: 1000000, ButtonSeat: 2, SmallBlindSeat: 4, BigBlindSeat: 5 },
      Player: { SeatIndex: 4, BetStatus: 3, Chip: 0, BetChip: 0, HoleCards: [24, 2] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 516390, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: 0, Chip: 972708, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 2262310, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: 3, Chip: 0, BetChip: 560359 },
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 5], NextExtraLimitSeconds: 1, MinRaise: 0, Pot: 620448, SidePot: [695023] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1735318912801, SeatIndex: 0, ActionType: 2, BetChip: 0, Chip: 516390, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3], NextExtraLimitSeconds: 6, MinRaise: 0, Pot: 620448, SidePot: [695023] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1735318915388, SeatIndex: 2, ActionType: 3, BetChip: 1000000, Chip: 1262310, Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 620448, SidePot: [1255382, 439641] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1735318916405, HandId: 296039758,
      CommunityCards: [21, 51, 29, 7, 23], Pot: 620448, SidePot: [1255382, 439641],
      ResultType: 0, DefeatStatus: 1, HandLog: '',
      Results: [
        { UserId: 1004, HoleCards: [28, 40], RankType: 7, Hands: [29, 28, 23, 21, 51], HandRanking: 1, Ranking: -2, RewardChip: 1875830 },
        { UserId: 1003, HoleCards: [45, 43], RankType: 8, Hands: [23, 21, 51, 45, 43], HandRanking: 2, Ranking: -2, RewardChip: 439641 },
        { UserId: 561384657, HoleCards: [24, 2], RankType: 8, Hands: [23, 21, 51, 29, 24], HandRanking: -1, Ranking: 10, RewardChip: 0 },
      ],
      Player: { SeatIndex: 4, BetStatus: -1, Chip: 0, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 516390, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 972708, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 1701951, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 1875830, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('ポット整合: Pot + sum(SidePot) == sum(RewardChip)', () => {
    const resultEvent = events.find(e => (e as any).ApiTypeId === ApiType.EVT_HAND_RESULTS) as any
    const totalPot = resultEvent.Pot + resultEvent.SidePot.reduce((s: number, p: number) => s + p, 0)
    const totalReward = resultEvent.Results.reduce((s: number, r: any) => s + r.RewardChip, 0)
    expect(totalPot).toBe(totalReward)
  })

  test('HandRanking=1がmain+side1、HandRanking=2がside2のみ獲得', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    const collectedLines = lines.filter(l => l.includes('collected'))
    expect(collectedLines).toEqual([
      'PlayerC collected 439641 from side pot-2',
      'PlayerD collected 1255382 from side pot-1',
      'PlayerD collected 620448 from main pot',
    ])
  })

  test('Summary行のポット内訳が正しい', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    const totalPotLine = lines.find(l => l.includes('Total pot'))
    expect(totalPotLine).toBe('Total pot 2315471 Main pot 620448. Side pot-1 1255382. Side pot-2 439641. | Rake 0')
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

  test('complete Ring endpoint snapshotからgross potと実rakeを出力する', () => {
    const rakeEvents = events.map(event => {
      if (event.ApiTypeId !== ApiType.EVT_HAND_RESULTS) return event
      return {
        ...event,
        Pot: 290,
        Results: event.Results.map(result =>
          result.UserId === 200 ? { ...result, RewardChip: 290 } : result),
        Player: { ...event.Player, Chip: 1190 },
      } as ApiEvent
    })
    const processor = new HandLogProcessor(createContext(
      createSession(players, { battleType: BattleType.RING_GAME })
    ))
    const lines = getLines(processor, rakeEvents)

    expect(lines).toContain('Hero collected 290 from pot')
    expect(lines).toContain('Total pot 300 | Rake 10')
  })

  test('Ring endpoint snapshot欠損時はrake 0やgross potを断定しない', () => {
    const incompleteEvents = events.map(event => {
      if (event.ApiTypeId !== ApiType.EVT_HAND_RESULTS) return event
      return {
        ...event,
        Pot: 290,
        Results: event.Results.map(result =>
          result.UserId === 200 ? { ...result, RewardChip: 290 } : result),
        Player: { ...event.Player, Chip: 1190 },
        OtherPlayers: event.OtherPlayers.filter(player => player.SeatIndex !== 2),
      } as ApiEvent
    })
    const processor = new HandLogProcessor(createContext(
      createSession(players, { battleType: BattleType.RING_GAME })
    ))
    const totalPotLine = getLines(processor, incompleteEvents)
      .find(line => line.includes('Total pot'))

    expect(totalPotLine).toBe('Total pot unknown (net payout 290) | Rake unknown')
    expect(totalPotLine).not.toContain('Rake 0')
  })
})

// ============================================================
// Test 12: Rare RankTypes in PokerStars-format showdown output
// (ROYAL_FLUSH, STRAIGHT_FLUSH, FLUSH, FOLD_OPEN) — real-data audit
// found zero coverage for these branches in getHandDescription()
// ============================================================
describe('レアなRankTypeのPokerStars形式ショウダウン出力', () => {
  const players = [
    { userId: 100, name: 'Hero' },
    { userId: 200, name: 'Villain' },
  ]

  /** Builds a minimal heads-up hand that reaches showdown on a fixed 5-card board. */
  function buildShowdownEvents(handId: number, winnerRankType: number, winnerHoleCards: number[], winnerHands: number[], loserHoleCards: number[], loserHands: number[], communityCards: number[]): ApiEvent[] {
    return [
      {
        ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
        SeatUserIds: [100, 200, -1, -1, -1, -1],
        Game: { CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600, Ante: 0, SmallBlind: 10, BigBlind: 20, ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1 },
        Player: { SeatIndex: 0, BetStatus: 1, Chip: 980, BetChip: 20, HoleCards: winnerHoleCards },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 980, BetChip: 20 },
        ],
        Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 40, SidePot: [] }
      } as unknown as ApiEvent,
      {
        ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000001000,
        CommunityCards: communityCards.slice(0, 3),
        Progress: { Phase: 1, NextActionSeat: 0, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 40, SidePot: [] }
      } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 0, ActionType: 0, BetChip: 0, Chip: 980, Progress: { Phase: 1, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000003000, SeatIndex: 1, ActionType: 0, BetChip: 0, Chip: 980, Progress: { Phase: 1, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      {
        ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000004000,
        CommunityCards: [communityCards[3]!],
        Progress: { Phase: 2, NextActionSeat: 0, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 40, SidePot: [] }
      } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000005000, SeatIndex: 0, ActionType: 0, BetChip: 0, Chip: 980, Progress: { Phase: 2, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000006000, SeatIndex: 1, ActionType: 0, BetChip: 0, Chip: 980, Progress: { Phase: 2, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      {
        ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1700000007000,
        CommunityCards: [communityCards[4]!],
        Progress: { Phase: 3, NextActionSeat: 0, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 40, SidePot: [] }
      } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000008000, SeatIndex: 0, ActionType: 0, BetChip: 0, Chip: 980, Progress: { Phase: 3, NextActionSeat: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 3, MinRaise: 0, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000009000, SeatIndex: 1, ActionType: 0, BetChip: 0, Chip: 980, Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000010000, HandId: handId,
        CommunityCards: [], Pot: 40, SidePot: [], ResultType: 0, DefeatStatus: 0, HandLog: '',
        Results: [
          { UserId: 100, HoleCards: winnerHoleCards, RankType: winnerRankType, Hands: winnerHands, HandRanking: 1, Ranking: -2, RewardChip: 40 },
          { UserId: 200, HoleCards: loserHoleCards, RankType: 8, Hands: loserHands, HandRanking: -1, Ranking: -2, RewardChip: 0 },
        ],
        Player: { SeatIndex: 0, BetStatus: -1, Chip: 1020, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 980, BetChip: 0 },
        ]
      } as unknown as ApiEvent,
    ]
  }

  test('RankType 0 (ROYAL_FLUSH) は "a royal flush" と表示される', () => {
    // Hero: As Ks + board Qs Js Ts x x = royal flush [As Ks Qs Js Ts]
    const events = buildShowdownEvents(999200, 0, [48, 44], [48, 44, 40, 36, 32], [1, 5], [1, 5, 9, 13, 17], [40, 36, 32, 0, 4])
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)
    expect(lines).toContain('Hero: shows [As Ks] (a royal flush)')
  })

  test('RankType 1 (STRAIGHT_FLUSH) は "a straight flush" と表示される', () => {
    // Hero: 9s 8s + board 7s 6s 5s x x = straight flush [9s 8s 7s 6s 5s]
    const events = buildShowdownEvents(999201, 1, [28, 24], [28, 24, 20, 16, 12], [1, 5], [1, 5, 9, 13, 17], [20, 16, 12, 0, 4])
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)
    expect(lines).toContain('Hero: shows [9s 8s] (a straight flush)')
  })

  test('RankType 4 (FLUSH) は "a flush" と表示される', () => {
    // Hero: As Js + board 9s 6s 2s x x = flush [As Js 9s 6s 2s]
    const events = buildShowdownEvents(999202, 4, [48, 36], [48, 36, 28, 16, 0], [1, 5], [1, 5, 9, 13, 17], [28, 16, 0, 8, 4])
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)
    expect(lines).toContain('Hero: shows [As Js] (a flush)')
  })

  test('RankType 12 (FOLD_OPEN, 両カード有効) はショウダウンなしの "fold" 表示になる', () => {
    // FolderA bets, folds are not modeled here — instead we model the mainline
    // real-world shape (818/1207 real FOLD_OPEN reveals): a fully-revealed
    // 2-card hand from a player who is NOT part of any genuine showdown
    // (isShowdownParticipant() excludes RankType 12, see src/types/game.ts).
    // No *** SHOW DOWN *** section should be fabricated for an uncontested win.
    const foldOpenPlayers = [
      { userId: 100, name: 'Hero' },
      { userId: 200, name: 'FolderA' },
    ]
    const events: ApiEvent[] = [
      {
        ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
        SeatUserIds: [100, 200, -1, -1, -1, -1],
        Game: { CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600, Ante: 0, SmallBlind: 10, BigBlind: 20, ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1 },
        Player: { SeatIndex: 0, BetStatus: 1, Chip: 980, BetChip: 20, HoleCards: [48, 49] },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 980, BetChip: 20 },
        ],
        Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [0, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 40, Pot: 40, SidePot: [] }
      } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 0, ActionType: 1, Chip: 900, BetChip: 100, Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 160, Pot: 40, SidePot: [] } } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 1, ActionType: 2, Chip: 980, BetChip: 20, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 60, SidePot: [] } } as unknown as ApiEvent,
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000003000, HandId: 999203,
        CommunityCards: [], Pot: 60, SidePot: [], ResultType: 0, DefeatStatus: 0, HandLog: '',
        Results: [
          { UserId: 100, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 60 },
          { UserId: 200, HoleCards: [21, 31], RankType: 12, Hands: [], HandRanking: -1, Ranking: -2, RewardChip: 0 },
        ],
        Player: { SeatIndex: 0, BetStatus: -1, Chip: 1060, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 980, BetChip: 0 },
        ]
      } as unknown as ApiEvent,
    ]
    const session = createSession(foldOpenPlayers, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)
    expect(lines.find(l => l.includes('*** SHOW DOWN ***'))).toBeUndefined()
    expect(lines).toContain('Seat 2: FolderA (big blind) folded before Flop')
  })
})

// ============================================================
// Test 13: Partial hole-card reveal on FOLD_OPEN — [valid,-1] / [-1,valid]
// 389 real occurrences in EVT_HAND_RESULTS.Results[].HoleCards, all RankType=12
// (self-reveal of a single card after folding). Before the fix in this
// commit, `[valid,-1]` (HoleCards[0] !== -1) was misclassified as a genuine
// showdown participant, fabricating a "*** SHOW DOWN ***" section — and
// `Player: shows [<1 card>] (fold)` — for a hand that never reached
// showdown. `[-1,valid]` was already handled gracefully (silently omitted).
// Fix: exclude FOLD_OPEN via isShowdownParticipant() regardless of which
// slot holds the revealed card, so both shapes behave identically.
// ============================================================
describe('部分ホールカード公開 (FOLD_OPEN, [valid,-1] / [-1,valid])', () => {
  const players = [
    { userId: 100, name: 'Hero' },
    { userId: 200, name: 'FolderA' },
    { userId: 300, name: 'FolderB' },
  ]

  function buildEvents(handId: number, folderHoleCards: number[]): ApiEvent[] {
    return [
      {
        ApiTypeId: ApiType.EVT_DEAL, timestamp: 1700000000000,
        SeatUserIds: [100, 200, 300, -1, -1, -1],
        Game: { CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600, Ante: 0, SmallBlind: 10, BigBlind: 20, ButtonSeat: 2, SmallBlindSeat: 0, BigBlindSeat: 1 },
        Player: { SeatIndex: 0, BetStatus: 1, Chip: 1000, BetChip: 10, HoleCards: [48, 49] },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 1000, BetChip: 20 },
          { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 1000, BetChip: 0 },
        ],
        Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 40, Pot: 30, SidePot: [] }
      } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000001000, SeatIndex: 2, ActionType: 2, Chip: 1000, BetChip: 0, Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 40, Pot: 30, SidePot: [] } } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000002000, SeatIndex: 0, ActionType: 4, Chip: 960, BetChip: 40, Progress: { Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 60, Pot: 50, SidePot: [] } } as unknown as ApiEvent,
      { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1700000003000, SeatIndex: 1, ActionType: 2, Chip: 1000, BetChip: 20, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 70, SidePot: [] } } as unknown as ApiEvent,
      {
        ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1700000004000, HandId: handId,
        CommunityCards: [], Pot: 70, SidePot: [], ResultType: 0, DefeatStatus: 0, HandLog: '',
        Results: [
          { UserId: 100, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 110 },
          { UserId: 200, HoleCards: folderHoleCards, RankType: 12, Hands: [], HandRanking: -1, Ranking: -2, RewardChip: 0 },
        ],
        Player: { SeatIndex: 0, BetStatus: -1, Chip: 1070, BetChip: 0 },
        OtherPlayers: [
          { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 980, BetChip: 0 },
          { SeatIndex: 2, Status: 5, BetStatus: -1, Chip: 1000, BetChip: 0 },
        ]
      } as unknown as ApiEvent,
    ]
  }

  test('[valid,-1] は偽の*** SHOW DOWN ***を発生させない', () => {
    const events = buildEvents(999210, [21, -1])
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    expect(lines.find(l => l.includes('*** SHOW DOWN ***'))).toBeUndefined()
    expect(lines.find(l => l.includes('FolderA: shows'))).toBeUndefined()
    expect(lines).toContain('Seat 2: FolderA (big blind) folded before Flop')
    expect(lines.find(l => l.startsWith('Seat 1: Hero') && l.includes('collected'))).toBeDefined()
  })

  test('[-1,valid] は偽の*** SHOW DOWN ***を発生させない', () => {
    const events = buildEvents(999211, [-1, 31])
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    expect(lines.find(l => l.includes('*** SHOW DOWN ***'))).toBeUndefined()
    expect(lines.find(l => l.includes('FolderA: shows'))).toBeUndefined()
    expect(lines).toContain('Seat 2: FolderA (big blind) folded before Flop')
    expect(lines.find(l => l.startsWith('Seat 1: Hero') && l.includes('collected'))).toBeDefined()
  })

  test('[valid,-1] と [-1,valid] は同一の出力になる (どちらの位置に公開カードがあっても対称に処理される)', () => {
    const eventsA = buildEvents(999212, [21, -1])
    const eventsB = buildEvents(999212, [-1, 21])
    const sessionA = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const sessionB = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const linesA = getLines(new HandLogProcessor(createContext(sessionA)), eventsA)
    const linesB = getLines(new HandLogProcessor(createContext(sessionB)), eventsB)
    expect(linesA).toEqual(linesB)
  })
})

// ============================================================
// Test 14: Ante all-in reconstruction (buildAnteAllInChipsMap / fixAnteAllInChips)
// Real hand (anonymized from HandId=260147134): 2 players (seats 0 and 4)
// have Chip=0,BetChip=0 at EVT_DEAL with a non-empty SidePot, requiring
// tier-based chip-amount reconstruction. This path had zero dedicated
// coverage; existing ante-all-in tests in this file only ever have a
// single Chip=0 player (buildAnteAllInChipsMap requires >=2 to activate).
// ============================================================
describe('アンテオールインのチップ額再構築 (buildAnteAllInChipsMap / fixAnteAllInChips)', () => {
  const players = [
    { userId: 1001, name: 'PlayerA' },
    { userId: 561384657, name: 'sola' },
    { userId: 1002, name: 'PlayerB' },
    { userId: 1003, name: 'PlayerC' },
    { userId: 1004, name: 'PlayerD' },
  ]

  // Seats 0 (PlayerA) and 4 (PlayerC) are both ante all-in (Chip=0, BetChip=0).
  // Progress.SidePot=[640, 5000] at EVT_DEAL lets buildAnteAllInChipsMap
  // distinguish their contribution tiers once EVT_HAND_RESULTS resolves
  // which seat won which pot (fixAnteAllInChips).
  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1727239848825,
      SeatUserIds: [1001, -1, 561384657, 1002, 1003, 1004],
      Game: { CurrentBlindLv: 9, NextBlindUnixSeconds: 1727239912, Ante: 950, SmallBlind: 1900, BigBlind: 3800, ButtonSeat: 5, SmallBlindSeat: 0, BigBlindSeat: 2 },
      Player: { SeatIndex: 2, BetStatus: 1, Chip: 64220, BetChip: 3800, HoleCards: [9, 35] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 3, Chip: 0, BetChip: 0 },
        { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 56550, BetChip: 0 },
        { SeatIndex: 4, Status: 0, BetStatus: 3, Chip: 0, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 51640, BetChip: 0 },
      ],
      Progress: { Phase: 0, NextActionSeat: 3, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 7600, Pot: 1950, SidePot: [640, 5000] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239855333, SeatIndex: 3, ActionType: 3, BetChip: 3800, Chip: 52750, Progress: { Phase: 0, NextActionSeat: 5, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 7600, Pot: 1950, SidePot: [640, 8800] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239856870, SeatIndex: 5, ActionType: 3, BetChip: 3800, Chip: 47840, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [0, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 7600, Pot: 1950, SidePot: [640, 12600] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239858500, SeatIndex: 2, ActionType: 0, BetChip: 3800, Chip: 64220, Progress: { Phase: 0, NextActionSeat: -1, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 1950, SidePot: [640, 12600] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1727239859536, CommunityCards: [48, 32, 46], Player: { SeatIndex: 2, Chip: 64220, HoleCards: [9, 35], BetChip: 0, BetStatus: 1 }, OtherPlayers: [{ SeatIndex: 0, Status: 0, BetStatus: 3, BetChip: 0, Chip: 0 }, { SeatIndex: 3, Chip: 52750, Status: 0, BetStatus: 1, BetChip: 0 }, { SeatIndex: 4, BetChip: 0, BetStatus: 3, Chip: 0, Status: 0 }, { SeatIndex: 5, Chip: 47840, Status: 0, BetChip: 0, BetStatus: 1 }], Progress: { Pot: 1950, Phase: 1, NextActionTypes: [0, 5, 1], MinRaise: 0, NextExtraLimitSeconds: 12, NextActionSeat: 2, SidePot: [640, 12600] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239862418, SeatIndex: 2, ActionType: 0, BetChip: 0, Chip: 64220, Progress: { Pot: 1950, NextActionSeat: 3, MinRaise: 0, NextExtraLimitSeconds: 12, NextActionTypes: [0, 5, 1], Phase: 1, SidePot: [640, 12600] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239863630, SeatIndex: 3, ActionType: 0, BetChip: 0, Chip: 52750, Progress: { SidePot: [640, 12600], Phase: 1, NextActionTypes: [0, 5, 1], NextExtraLimitSeconds: 12, MinRaise: 0, NextActionSeat: 5, Pot: 1950 } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239864963, SeatIndex: 5, ActionType: 0, BetChip: 0, Chip: 47840, Progress: { NextActionTypes: [], NextActionSeat: -1, Phase: 1, NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 1950, SidePot: [640, 12600] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1727239865983, OtherPlayers: [{ SeatIndex: 0, BetChip: 0, Chip: 0, Status: 0, BetStatus: 3 }, { SeatIndex: 3, BetChip: 0, BetStatus: 1, Chip: 52750, Status: 0 }, { SeatIndex: 4, Status: 0, Chip: 0, BetStatus: 3, BetChip: 0 }, { SeatIndex: 5, BetStatus: 1, BetChip: 0, Chip: 47840, Status: 0 }], Player: { HoleCards: [9, 35], SeatIndex: 2, Chip: 64220, BetStatus: 1, BetChip: 0 }, Progress: { SidePot: [640, 12600], NextExtraLimitSeconds: 12, Pot: 1950, NextActionTypes: [0, 5, 1], Phase: 2, NextActionSeat: 2, MinRaise: 0 }, CommunityCards: [17] } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239867863, SeatIndex: 2, ActionType: 0, BetChip: 0, Chip: 64220, Progress: { MinRaise: 0, SidePot: [640, 12600], Pot: 1950, NextActionTypes: [0, 5, 1], NextActionSeat: 3, Phase: 2, NextExtraLimitSeconds: 12 } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239869014, SeatIndex: 3, ActionType: 0, BetChip: 0, Chip: 52750, Progress: { SidePot: [640, 12600], MinRaise: 0, NextActionTypes: [0, 5, 1], Pot: 1950, Phase: 2, NextActionSeat: 5, NextExtraLimitSeconds: 12 } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239870360, SeatIndex: 5, ActionType: 0, BetChip: 0, Chip: 47840, Progress: { SidePot: [640, 12600], MinRaise: 0, NextExtraLimitSeconds: 0, Phase: 2, NextActionTypes: [], NextActionSeat: -1, Pot: 1950 } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_DEAL_ROUND, timestamp: 1727239871361, CommunityCards: [19], Player: { BetStatus: 1, BetChip: 0, Chip: 64220, SeatIndex: 2, HoleCards: [9, 35] }, Progress: { Pot: 1950, NextExtraLimitSeconds: 12, Phase: 3, NextActionTypes: [0, 5, 1], NextActionSeat: 2, MinRaise: 0, SidePot: [640, 12600] }, OtherPlayers: [{ SeatIndex: 0, Status: 0, BetChip: 0, Chip: 0, BetStatus: 3 }, { SeatIndex: 3, BetStatus: 1, BetChip: 0, Chip: 52750, Status: 0 }, { SeatIndex: 4, BetStatus: 3, BetChip: 0, Chip: 0, Status: 0 }, { SeatIndex: 5, BetChip: 0, Chip: 47840, BetStatus: 1, Status: 0 }] } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239873605, SeatIndex: 2, ActionType: 0, BetChip: 0, Chip: 64220, Progress: { Pot: 1950, NextActionTypes: [0, 5, 1], NextActionSeat: 3, NextExtraLimitSeconds: 12, MinRaise: 0, Phase: 3, SidePot: [640, 12600] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239874688, SeatIndex: 3, ActionType: 0, BetChip: 0, Chip: 52750, Progress: { Pot: 1950, NextExtraLimitSeconds: 12, SidePot: [640, 12600], Phase: 3, MinRaise: 0, NextActionTypes: [0, 5, 1], NextActionSeat: 5 } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1727239876121, SeatIndex: 5, ActionType: 0, BetChip: 0, Chip: 47840, Progress: { SidePot: [640, 12600], Phase: 3, NextActionSeat: -2, Pot: 1950, NextExtraLimitSeconds: 0, MinRaise: 0, NextActionTypes: [] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1727239877145, HandId: 260147134,
      CommunityCards: [], SidePot: [640, 12600], DefeatStatus: 0, Pot: 1950, ResultType: 0, HandLog: '',
      Results: [
        { HandRanking: 1, RewardChip: 15190, Ranking: -2, HoleCards: [9, 35], Hands: [35, 32, 19, 17, 48], UserId: 561384657, RankType: 7 },
        { UserId: 1003, RewardChip: 0, Ranking: 4, HandRanking: -1, Hands: [19, 17, 48, 46, 41], RankType: 8, HoleCards: [41, 11] },
        { Hands: [19, 17, 48, 46, 32], HandRanking: -1, Ranking: 5, RankType: 8, HoleCards: [28, 22], UserId: 1001, RewardChip: 0 },
        { RankType: 8, HoleCards: [1, 29], Hands: [19, 17, 48, 46, 32], RewardChip: 0, UserId: 1002, HandRanking: -1, Ranking: -2 },
        { Ranking: -2, HandRanking: -1, RankType: 8, Hands: [19, 17, 48, 46, 32], UserId: 1004, RewardChip: 0, HoleCards: [24, 21] },
      ],
      Player: { BetStatus: -1, SeatIndex: 2, BetChip: 0, Chip: 79410 },
      OtherPlayers: [
        { Chip: 0, BetStatus: -1, SeatIndex: 0, Status: 5, BetChip: 0 },
        { BetChip: 0, Chip: 52750, Status: 0, SeatIndex: 3, BetStatus: -1 },
        { SeatIndex: 4, BetStatus: -1, Status: 5, BetChip: 0, Chip: 0 },
        { BetStatus: -1, Chip: 47840, SeatIndex: 5, Status: 0, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('ポット整合: Pot + sum(SidePot) == sum(RewardChip)', () => {
    const resultEvent = events.find(e => (e as any).ApiTypeId === ApiType.EVT_HAND_RESULTS) as any
    const totalPot = resultEvent.Pot + resultEvent.SidePot.reduce((s: number, p: number) => s + p, 0)
    const totalReward = resultEvent.Results.reduce((s: number, r: any) => s + r.RewardChip, 0)
    expect(totalPot).toBe(totalReward)
  })

  test('2人のアンテオールインプレイヤーに異なるチップ額ティアが再構築される (characterization)', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    // PlayerA (seat 1, main-pot-only tier) and PlayerC (seat 5, side-pot tier)
    // must be reconstructed with distinct, non-zero chip counts (not the
    // fallback where both get the same minimum tier).
    const seatLines = lines.filter(l => l.startsWith('Seat ') && l.includes('in chips)'))
    const playerASeat = seatLines.find(l => l.includes('PlayerA'))
    const playerCSeat = seatLines.find(l => l.includes('PlayerC'))
    expect(playerASeat).toBe('Seat 1: PlayerA (390 in chips)')
    expect(playerCSeat).toBe('Seat 5: PlayerC (550 in chips)')

    expect(lines).toContain('PlayerA: posts the ante 390 and is all-in')
    expect(lines).toContain('PlayerC: posts the ante 550 and is all-in')

    // Winner collects from both side pots and the main pot.
    const collectedLines = lines.filter(l => l.includes('collected'))
    expect(collectedLines).toEqual([
      'sola collected 12600 from side pot-2',
      'sola collected 640 from side pot-1',
      'sola collected 1950 from main pot',
    ])

    const totalPotLine = lines.find(l => l.includes('Total pot'))
    expect(totalPotLine).toBe('Total pot 15190 Main pot 1950. Side pot-1 640. Side pot-2 12600. | Rake 0')
  })
})

// ============================================================
// Test: Short-stack ante estimation with a sitting-out player
// Hand #296039758 (anonymized) — Seat 2 is seated but NOT_IN_PLAY
// (BetStatus=0) and posts no ante. Main pot must be divided by the
// number of ante CONTRIBUTORS (4), not seated players (5).
// Pot 620448 / 4 = 155112 (hero's true ante all-in amount).
// Cross-check: SidePot 695023 = (200000-155112)*3 + 560359.
// ============================================================
describe('ショートスタックアンテ推定: 離席中(NOT_IN_PLAY)プレイヤーを拠出者に含めない', () => {
  const players = [
    { userId: 100000001, name: 'PlayerA' },
    { userId: 100000002, name: 'PlayerB' },
    { userId: 100000003, name: 'PlayerC' },
    { userId: 100000004, name: 'Hero' },
    { userId: 100000005, name: 'PlayerE' },
  ]

  // Hero (seat 4) is ante all-in (Chip=0, BetChip=0). Seat 1 (PlayerB) is
  // seated but sitting out (BetStatus=0, NOT_IN_PLAY) — stack unchanged at
  // hand results. Seat 3 is empty.
  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL, timestamp: 1735318901395,
      SeatUserIds: [100000001, 100000002, 100000003, -1, 100000004, 100000005],
      Game: { CurrentBlindLv: 16, NextBlindUnixSeconds: -1, Ante: 200000, SmallBlind: 500000, BigBlind: 1000000, ButtonSeat: 2, SmallBlindSeat: 4, BigBlindSeat: 5 },
      Player: { SeatIndex: 4, BetStatus: 3, Chip: 0, BetChip: 0, HoleCards: [24, 2] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 516390, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: 0, Chip: 972708, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 2262310, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: 3, Chip: 0, BetChip: 560359 },
      ],
      Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 5], NextExtraLimitSeconds: 1, MinRaise: 0, Pot: 620448, SidePot: [695023] }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1735318912801, SeatIndex: 0, ActionType: 2, BetChip: 0, Chip: 516390, Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3], NextExtraLimitSeconds: 6, MinRaise: 0, Pot: 620448, SidePot: [695023] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1735318915388, SeatIndex: 2, ActionType: 3, BetChip: 1000000, Chip: 1262310, Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 620448, SidePot: [1255382, 439641] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS, timestamp: 1735318916405, HandId: 296039758,
      CommunityCards: [21, 51, 29, 7, 23], Pot: 620448, SidePot: [1255382, 439641], ResultType: 0, DefeatStatus: 1, HandLog: '',
      Results: [
        { UserId: 100000005, RankType: 7, HandRanking: 1, Hands: [29, 28, 23, 21, 51], HoleCards: [28, 40], Ranking: -2, RewardChip: 1875830 },
        { UserId: 100000003, RankType: 8, HandRanking: 2, Hands: [23, 21, 51, 45, 43], HoleCards: [45, 43], Ranking: -2, RewardChip: 439641 },
        { UserId: 100000004, RankType: 8, HandRanking: -1, Hands: [23, 21, 51, 29, 24], HoleCards: [24, 2], Ranking: 10, RewardChip: 0 },
      ],
      Player: { SeatIndex: 4, BetStatus: -1, Chip: 0, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 516390, BetChip: 0 },
        { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 972708, BetChip: 0 },
        { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 1701951, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 1875830, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('ポット整合: Pot + sum(SidePot) == sum(RewardChip)', () => {
    const resultEvent = events.find(e => (e as any).ApiTypeId === ApiType.EVT_HAND_RESULTS) as any
    const totalPot = resultEvent.Pot + resultEvent.SidePot.reduce((s: number, p: number) => s + p, 0)
    const totalReward = resultEvent.Results.reduce((s: number, r: any) => s + r.RewardChip, 0)
    expect(totalPot).toBe(totalReward)
  })

  test('アンテオールインのチップ額はPot/アンテ拠出者数で推定される (620448/4=155112)', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // 離席中のPlayerB(seat 1)を除いた4人で均等割: 620448 / 4 = 155112
    // (誤って着席者5人で割ると 620448 / 5 = 124089 になる)
    const heroSeatLine = lines.find(l => l.startsWith('Seat 5: Hero'))
    expect(heroSeatLine).toBe('Seat 5: Hero (155112 in chips)')
    expect(lines).toContain('Hero: posts the ante 155112 and is all-in')

    // アンテ全額を払えたプレイヤーは従来通り
    expect(lines).toContain('PlayerA: posts the ante 200000')
  })

  test('離席中(NOT_IN_PLAY)プレイヤーにはアンテ行を出力せず、Seat行のチップも増額しない', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const ctx = createContext(session)
    const processor = new HandLogProcessor(ctx)
    const lines = getLines(processor, events)

    // PlayerB(seat 1)はBetStatus=0(NOT_IN_PLAY)でアンテを支払っていない
    // (実データではEVT_DEAL/EVT_HAND_RESULTS間でChip=972708のまま不変)
    expect(lines.filter(l => l.startsWith('PlayerB: posts the ante'))).toHaveLength(0)

    // Seat行はスタックそのまま (誤ってアンテを足し戻すと 1172708 になる)
    expect(lines).toContain('Seat 2: PlayerB (972708 in chips)')

    // アンテ行は拠出者4人分のみ
    expect(lines.filter(l => l.includes('posts the ante'))).toHaveLength(4)
  })
})

// ============================================================
// ショウダウン時のuncalled bet額: BBブラインド投稿オールインに対するレイズ
// Hand #517982965 — BBが1148でブラインド投稿オールイン（EVT_ACTIONなし）、
// heroが3280にレイズ、全員フォールド → BBとのショウダウン。
// 旧ヒューリスティックはbets/raises/callsエントリのみ走査するため
// ブラインド投稿行を見逃し、uncalled=3280（レイズ全額）と過大計上していた。
// 正: uncalled = 3280 - 1148 = 2132 (= SidePot = heroのRewardChip)
// ============================================================
describe('ショウダウン時のuncalled bet: ブラインド投稿オールインに対するレイズ (Hand #517982965)', () => {
  const players = [
    { userId: 156012369, name: 'Player156012369' },
    { userId: 561384657, name: 'sola' },
    { userId: 578444683, name: 'Player578444683' },
    { userId: 805494763, name: 'Player805494763' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1782011480000,
      SeatUserIds: [156012369, 561384657, -1, -1, 578444683, 805494763],
      Game: {
        CurrentBlindLv: 7, NextBlindUnixSeconds: 1782011516,
        Ante: 410, SmallBlind: 820, BigBlind: 1640,
        ButtonSeat: 4, SmallBlindSeat: 5, BigBlindSeat: 0
      },
      Player: { SeatIndex: 1, BetStatus: 1, Chip: 45482, BetChip: 0, HoleCards: [2, 49] },
      OtherPlayers: [
        // BB: アンテ410支払い後の残り1148を全額ブラインド投稿してオールイン
        { SeatIndex: 0, Status: 0, BetStatus: 3, Chip: 0, BetChip: 1148, IsSafeLeave: false },
        { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 17194, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 23716, BetChip: 820, IsSafeLeave: false },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 3280, Pot: 4108, SidePot: []
      }
    } as unknown as ApiEvent,
    // sola raises to 3280 → BBの1148を超える分2132は即座にSidePotへ
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1782011482000, SeatIndex: 1, ActionType: 4, BetChip: 3280, Chip: 42202, Progress: { Phase: 0, NextActionSeat: 4, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 4920, Pot: 4756, SidePot: [2132] } } as unknown as ApiEvent,
    // 残り2人はフォールド → コールなし、BBとのショウダウンへ
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1782011484000, SeatIndex: 4, ActionType: 2, BetChip: 0, Chip: 17194, Progress: { Phase: 0, NextActionSeat: 5, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 4920, Pot: 4756, SidePot: [2132] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1782011486000, SeatIndex: 5, ActionType: 2, BetChip: 820, Chip: 23716, Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 4756, SidePot: [2132] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1782011488899,
      HandId: 517982965,
      CommunityCards: [10, 19, 21, 9, 40],
      Pot: 4756, SidePot: [2132], ResultType: 0, DefeatStatus: 0,
      Results: [
        // BBがメインポット4756を獲得
        { UserId: 156012369, RankType: 7, HandRanking: 1, Hands: [42, 40, 23, 21, 19], HoleCards: [42, 23], Ranking: -2, RewardChip: 4756 },
        // heroのRewardChip 2132 = SidePot = コールされなかった超過分の払い戻し
        { UserId: 561384657, RankType: 8, HandRanking: 2, Hands: [10, 9, 49, 40, 21], HoleCards: [2, 49], Ranking: -2, RewardChip: 2132 },
      ],
      Player: { SeatIndex: 1, BetStatus: -1, Chip: 44334, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 4756, BetChip: 0 },
        { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 17194, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 23716, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('uncalled額は相手の最大コミット額(BBブラインド投稿1148)との差分になる', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    expect(lines).toContain('Player156012369: posts big blind 1148 and is all-in')
    // 正: 3280 - 1148 = 2132。旧実装はブラインド投稿を見逃しuncalled 3280としていた
    expect(lines.find(l => l.includes('Uncalled bet (2132) returned to sola'))).toBeDefined()
    expect(lines.find(l => l.includes('Uncalled bet (3280)'))).toBeUndefined()
  })

  test('メインポットはuncalled過大計上で目減りせずBB勝者へ全額渡る', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    // 旧実装ではuncalled 3280がSidePot 2132を超過し、差分1148がメインポットから
    // 誤って差し引かれ "collected 3608 from main pot" になっていた
    const collectedLines = lines.filter(l => l.includes('collected'))
    expect(collectedLines).toEqual(['Player156012369 collected 4756 from main pot'])
  })

  test('チップ整合: collected + uncalled == sum(RewardChip)', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    const collected = lines
      .filter(l => l.includes(' collected '))
      .reduce((sum, l) => sum + parseInt(l.match(/collected (\d+)/)![1]!), 0)
    const uncalled = lines
      .filter(l => l.includes('Uncalled bet ('))
      .reduce((sum, l) => sum + parseInt(l.match(/Uncalled bet \((\d+)\)/)![1]!), 0)
    // Pot 4756 + SidePot 2132 == RewardChip合計 6888
    expect(collected + uncalled).toBe(6888)
  })
})

// ============================================================
// 回帰: 表示名が接頭辞関係にある場合のコミット額の取り違え（codexレビュー指摘）
// 上のHand #517982965と同一イベントで、フォールドした相手の表示名を
// レイザー'sola'の接頭辞'sol'に変えたもの。旧実装のtext.includes(name)照合では
// 'sol'のコミット額走査が「sola: raises 1640 to 3280」に部分一致し、
// maxOpponentCommitment=3280 → uncalled=0と誤算出してUncalled行が消失していた。
// 修正後は「名前 + ': '」の接頭辞完全一致で照合するため影響を受けない。
// ============================================================
describe('ショウダウン時のuncalled bet: 接頭辞衝突する表示名 (sol / sola)', () => {
  const players = [
    { userId: 156012369, name: 'Player156012369' },
    { userId: 561384657, name: 'sola' },
    { userId: 578444683, name: 'sol' }, // レイザー'sola'の接頭辞
    { userId: 805494763, name: 'Player805494763' },
  ]

  const events: ApiEvent[] = [
    {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1782011480000,
      SeatUserIds: [156012369, 561384657, -1, -1, 578444683, 805494763],
      Game: {
        CurrentBlindLv: 7, NextBlindUnixSeconds: 1782011516,
        Ante: 410, SmallBlind: 820, BigBlind: 1640,
        ButtonSeat: 4, SmallBlindSeat: 5, BigBlindSeat: 0
      },
      Player: { SeatIndex: 1, BetStatus: 1, Chip: 45482, BetChip: 0, HoleCards: [2, 49] },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: 3, Chip: 0, BetChip: 1148, IsSafeLeave: false },
        { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 17194, BetChip: 0, IsSafeLeave: false },
        { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 23716, BetChip: 820, IsSafeLeave: false },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 1, NextActionTypes: [2, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 3280, Pot: 4108, SidePot: []
      }
    } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1782011482000, SeatIndex: 1, ActionType: 4, BetChip: 3280, Chip: 42202, Progress: { Phase: 0, NextActionSeat: 4, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 4920, Pot: 4756, SidePot: [2132] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1782011484000, SeatIndex: 4, ActionType: 2, BetChip: 0, Chip: 17194, Progress: { Phase: 0, NextActionSeat: 5, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 12, MinRaise: 4920, Pot: 4756, SidePot: [2132] } } as unknown as ApiEvent,
    { ApiTypeId: ApiType.EVT_ACTION, timestamp: 1782011486000, SeatIndex: 5, ActionType: 2, BetChip: 820, Chip: 23716, Progress: { Phase: 3, NextActionSeat: -2, NextActionTypes: [], NextExtraLimitSeconds: 0, MinRaise: 0, Pot: 4756, SidePot: [2132] } } as unknown as ApiEvent,
    {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1782011488899,
      HandId: 517982965,
      CommunityCards: [10, 19, 21, 9, 40],
      Pot: 4756, SidePot: [2132], ResultType: 0, DefeatStatus: 0,
      Results: [
        { UserId: 156012369, RankType: 7, HandRanking: 1, Hands: [42, 40, 23, 21, 19], HoleCards: [42, 23], Ranking: -2, RewardChip: 4756 },
        { UserId: 561384657, RankType: 8, HandRanking: 2, Hands: [10, 9, 49, 40, 21], HoleCards: [2, 49], Ranking: -2, RewardChip: 2132 },
      ],
      Player: { SeatIndex: 1, BetStatus: -1, Chip: 44334, BetChip: 0 },
      OtherPlayers: [
        { SeatIndex: 0, Status: 0, BetStatus: -1, Chip: 4756, BetChip: 0 },
        { SeatIndex: 4, Status: 0, BetStatus: -1, Chip: 17194, BetChip: 0 },
        { SeatIndex: 5, Status: 0, BetStatus: -1, Chip: 23716, BetChip: 0 },
      ]
    } as unknown as ApiEvent,
  ]

  test('接頭辞名の相手がいてもuncalled額はBBコミット1148との差分2132のまま', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const lines = getLines(processor, events)

    // 旧実装: getPlayerStreetCommitment('sol')が「sola: raises ...」に部分一致し
    // maxOpponentCommitment=3280 → uncalled=0 → Uncalled行が消失
    expect(lines.find(l => l.includes('Uncalled bet (2132) returned to sola'))).toBeDefined()
  })
})

// ============================================================
// Test 9: entry idの衝突不可能性 (store-5-handlog.png欠落バグの回帰テスト)
//
// 旧実装は id を `hand_${handId||'pending'}_pos_${position}_${hash}` という
// コンテンツ/位置ベースで生成していた。EVT_DEALのバッチ処理は全エントリを
// ローカル配列に貯めてから最後に一括pushするため、DEAL由来の全行(header/table/
// seat/ante/blind/HOLE CARDS/dealt)は生成時点で position=0 になる。さらに
// ハンド完了時(handleHandResultsEvent)はテキストとhandIdを書き換えるだけで
// idは再生成しないため、完了済みハンドのDEAL由来エントリは `hand_pending_pos_0_*`
// のままUI側stateに残り続ける。次のハンドのDEALで同一テキスト(同一ante額の
// ante行・常に同一の"*** HOLE CARDS ***"等)が生成されると、App.tsxのadd
// dedup(既存id集合でのフィルタ)が「別ハンドの新規行」を誤って捨てていた。
// 新実装はコンテンツ/位置と無関係な (instanceNonce, entrySeq) の組で
// 衝突不可能なidを発行することでこれを解消する。
// ============================================================
describe('entry idの衝突不可能性', () => {
  const players = [
    { userId: 561384657, name: 'sola' },
    { userId: 900000001, name: 'Villain' },
  ]

  /** 同一ブラインドレベル・同一アンテ額のDEALイベントを生成（handSeedのみ変える） */
  function buildDealEvent(handSeed: number): ApiEvent {
    return {
      ApiTypeId: ApiType.EVT_DEAL,
      timestamp: 1700000000000 + handSeed,
      SeatUserIds: [561384657, 900000001, -1, -1, -1, -1],
      Game: {
        CurrentBlindLv: 0, NextBlindUnixSeconds: 1700000600,
        Ante: 70, SmallBlind: 140, BigBlind: 280,
        ButtonSeat: 0, SmallBlindSeat: 0, BigBlindSeat: 1
      },
      Player: { SeatIndex: 0, BetStatus: 1, Chip: 9790, BetChip: 140, HoleCards: [48, 49] },
      OtherPlayers: [
        { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 9650, BetChip: 280 },
      ],
      Progress: {
        Phase: 0, NextActionSeat: 0, NextActionTypes: [0, 3, 4, 5],
        NextExtraLimitSeconds: 1, MinRaise: 560, Pot: 490, SidePot: []
      }
    } as unknown as ApiEvent
  }

  function buildResultsEvent(handId: number): ApiEvent {
    return {
      ApiTypeId: ApiType.EVT_HAND_RESULTS,
      timestamp: 1700000003000 + handId,
      HandId: handId,
      CommunityCards: [],
      Pot: 490, SidePot: [], ResultType: 0, DefeatStatus: 0,
      Results: [
        { UserId: 561384657, RankType: 10, HandRanking: 1, Hands: [], HoleCards: [], Ranking: -2, RewardChip: 490 },
      ],
      Player: { SeatIndex: 0, BetStatus: -1, Chip: 10280, BetChip: 0 },
      OtherPlayers: []
    } as unknown as ApiEvent
  }

  test('DEALイベント1発から生成される全エントリのidが互いにユニーク', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))
    const entries = processor.processSingleEvent(buildDealEvent(1))

    expect(entries.length).toBeGreaterThan(1)
    const ids = entries.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('同一テキストの行が出る2連続ハンドでエントリidが一切重複しない', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))

    const hand1Deal = processor.processSingleEvent(buildDealEvent(1))
    const hand1Results = processor.processSingleEvent(buildResultsEvent(111))
    processor.resetHandState()
    const hand2Deal = processor.processSingleEvent(buildDealEvent(2))
    const hand2Results = processor.processSingleEvent(buildResultsEvent(112))

    // 前提のサニティチェック: ante行・HOLE CARDS行のテキストは2ハンドで完全一致する
    // （これが一致しないと、そもそも旧実装のid衝突は再現しない）
    const anteTexts = (entries: HandLogEntry[]) =>
      entries.filter(e => e.text.includes('posts the ante')).map(e => e.text)
    expect(anteTexts(hand2Deal)).toEqual(anteTexts(hand1Deal))
    expect(anteTexts(hand1Deal).length).toBeGreaterThan(0)
    expect(hand1Deal.some(e => e.text === '*** HOLE CARDS ***')).toBe(true)
    expect(hand2Deal.some(e => e.text === '*** HOLE CARDS ***')).toBe(true)

    const allIds = [...hand1Deal, ...hand1Results, ...hand2Deal, ...hand2Results].map(e => e.id)
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  test('別インスタンスのHandLogProcessorを作り直してもidが重複しない（nonce検証）', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })

    const processorA = new HandLogProcessor(createContext(session))
    const entriesA = processorA.processSingleEvent(buildDealEvent(1))

    const processorB = new HandLogProcessor(createContext(session))
    const entriesB = processorB.processSingleEvent(buildDealEvent(1))

    const allIds = [...entriesA, ...entriesB].map(e => e.id)
    expect(new Set(allIds).size).toBe(allIds.length)
  })

  test('Date.now()が同一値でもモジュールカウンタでnonceの衝突を防ぐ', () => {
    const originalNow = Date.now
    try {
      Date.now = () => 1700000000000
      const session = createSession(players, { battleType: BattleType.SIT_AND_GO })

      const processorA = new HandLogProcessor(createContext(session))
      const entriesA = processorA.processSingleEvent(buildDealEvent(1))

      const processorB = new HandLogProcessor(createContext(session))
      const entriesB = processorB.processSingleEvent(buildDealEvent(1))

      const allIds = [...entriesA, ...entriesB].map(e => e.id)
      expect(new Set(allIds).size).toBe(allIds.length)
    } finally {
      Date.now = originalNow
    }
  })

  test('回帰: App.tsxのadd/updateデデュープを2ハンド分のストリーム出力に適用しても2ハンド目のante行・HOLE CARDS行が残る (store-5バグの再現形)', () => {
    const session = createSession(players, { battleType: BattleType.SIT_AND_GO })
    const processor = new HandLogProcessor(createContext(session))

    // App.tsx handleHandLogEvent の 'add' ケース相当:
    // 既存id集合に無いエントリだけを追記する
    const applyAdd = (prev: HandLogEntry[], incoming: HandLogEntry[]): HandLogEntry[] => {
      const existingIds = new Set(prev.map(e => e.id))
      return [...prev, ...incoming.filter(e => !existingIds.has(e.id))]
    }
    // App.tsx handleHandLogEvent の 'update' ケース相当:
    // 対象handIdのエントリとpending(handId未定義)のエントリを、完了ハンドの全エントリで置き換える
    const applyUpdate = (prev: HandLogEntry[], handId: number, allEntries: HandLogEntry[]): HandLogEntry[] => {
      const otherEntries = prev.filter(e => e.handId !== handId && e.handId !== undefined)
      return [...otherEntries, ...allEntries]
    }

    let displayed: HandLogEntry[] = []

    // ハンド1: DEALで'add'、HAND_RESULTSで'update'（HandLogStreamの実挙動どおり）
    const hand1Deal = processor.processSingleEvent(buildDealEvent(1))
    displayed = applyAdd(displayed, hand1Deal)
    processor.processSingleEvent(buildResultsEvent(111))
    displayed = applyUpdate(displayed, 111, processor.getCurrentHandEntries())
    processor.resetHandState()

    // ハンド2: DEALのみ処理 = 進行中ハンド（store-5-handlog.pngで欠落していた状態）
    const hand2Deal = processor.processSingleEvent(buildDealEvent(2))
    displayed = applyAdd(displayed, hand2Deal)

    // ハンド2のDEAL由来エントリ（ante行・HOLE CARDS行を含む）は
    // 1件も欠落せずdisplayedに含まれていなければならない
    expect(hand2Deal.some(e => e.text === '*** HOLE CARDS ***')).toBe(true)
    expect(hand2Deal.filter(e => e.text.includes('posts the ante')).length).toBeGreaterThan(0)
    for (const entry of hand2Deal) {
      expect(displayed.some(d => d.id === entry.id)).toBe(true)
    }
  })
})
