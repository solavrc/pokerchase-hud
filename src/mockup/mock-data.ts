import type { RealTimeStats } from '../realtime-stats/realtime-stats-service'
import type { PlayerStats } from '../types'
import { HandLogEntryType, type HandLogEntry } from '../types/hand-log'
import type { StatResult } from '../types/stats'

export type MockScenarioId = 'turn-decision' | 'new-table' | 'dense-history'

interface PlayerPotOdds {
  spr?: number
  potOdds?: {
    pot: number
    call: number
    percentage: number
    ratio: string
    isPlayerTurn: boolean
  }
}

/**
 * A seat as the mock table draws it. Occupancy only -- no name, no stack, no
 * per-hand progress. The table is a shell: it shows WHERE the client puts
 * things, never WHAT any particular hand contains. See the scope note in
 * `table-layout.ts`.
 */
export interface TableSeat {
  /** Seat nobody has taken yet -- the plate renders as an empty slot. */
  empty?: boolean
  isHero?: boolean
}

export interface MockScenario {
  handLogEntries: HandLogEntry[]
  id: MockScenarioId
  label: string
  playerPotOdds: Array<PlayerPotOdds | undefined>
  realTimeStats?: RealTimeStats
  /** Seat occupancy only; see {@link TableSeat}. */
  seats: TableSeat[]
  stats: PlayerStats[]
}

/**
 * ヒーロー席の実playerId。DeveloperBadge.tsxの`DEVELOPER_PLAYER_IDS`と一致させて
 * あるので、モックアップでも「DEV」バッジ付きの実際の見え方を確認できる
 * （合成IDのままだとバッジが一切出ず、レイアウト崩れに気づけない）。
 */
const HERO_PLAYER_ID = 561384657

/**
 * 名前欄の省略表示を確認するための長い名前。匿名なのは他の席と同じだが、
 * `dense-history` シナリオはこの席で ellipsis を見るために存在するので、
 * 短い名前に揃えてはいけない。
 */
const LONG_NAME = 'プレイヤーA_とても長い名前のテスト用アカウント'

const result = (
  id: string,
  name: string,
  value: StatResult['value'],
  formatted?: string,
): StatResult => ({ id, name, value, formatted })

const player = (
  playerId: number,
  name: string,
  hands: number,
  values: Array<[string, string, number | [number, number], string?]>,
): PlayerStats => ({
  playerId,
  statResults: [
    result('playerName', 'Name', name),
    result('hands', 'HAND', hands),
    ...values.map(([id, label, value, formatted]) => result(id, label, value, formatted)),
  ],
})

const standardStats = (
  playerId: number,
  name: string,
  hands: number,
  profile: 'balanced' | 'loose' | 'tight',
): PlayerStats => {
  const profiles: Record<
    'balanced' | 'loose' | 'tight',
    Array<[string, string, number | [number, number], string]>
  > = {
    balanced: [
      ['vpip', 'VPIP', [52, 214], '24.3% (52/214)'],
      ['pfr', 'PFR', [38, 214], '17.8% (38/214)'],
      ['cbet', 'CB', [19, 31], '61.3% (19/31)'],
      ['3bet', '3B', [11, 74], '14.9% (11/74)'],
      // AFの実際のStatResult.valueは[BET+RAISE, CALL]のペア（src/stats/core/af.ts）。
      // プレイヤータイプ分類（playerTypeRules.ts）はこのペアの分母を見るので、
      // スカラーのままだとモックアップでアイコンが一切出ない。
      ['af', 'AF', [60, 25], '2.4'],
      ['wtsd', 'WTSD', [17, 52], '32.7% (17/52)'],
    ],
    loose: [
      ['vpip', 'VPIP', [88, 168], '52.4% (88/168)'],
      ['pfr', 'PFR', [61, 168], '36.3% (61/168)'],
      ['cbet', 'CB', [24, 30], '80.0% (24/30)'],
      ['3bet', '3B', [17, 62], '27.4% (17/62)'],
      ['af', 'AF', [120, 25], '4.8'],
      ['wtsd', 'WTSD', [31, 88], '35.2% (31/88)'],
    ],
    tight: [
      ['vpip', 'VPIP', [24, 192], '12.5% (24/192)'],
      ['pfr', 'PFR', [18, 192], '9.4% (18/192)'],
      ['cbet', 'CB', [8, 17], '47.1% (8/17)'],
      ['3bet', '3B', [4, 66], '6.1% (4/66)'],
      ['af', 'AF', [26, 20], '1.3'],
      ['wtsd', 'WTSD', [5, 24], '20.8% (5/24)'],
    ],
  }

  return player(playerId, name, hands, profiles[profile])
}

const logTimestamp = Date.UTC(2026, 6, 15, 11, 42, 0)

const turnHandLogLines: Array<[string, string, HandLogEntryType]> = [
  ['header', 'PokerChase Hand #840217 · Ring 25/50', HandLogEntryType.HEADER],
  ['seat-1', 'Seat 1: Hero (6,240 in chips)', HandLogEntryType.SEAT],
  ['seat-2', 'Seat 2: プレイヤーD (5,850 in chips)', HandLogEntryType.SEAT],
  ['cards', 'Dealt to Hero [A♠ J♠]', HandLogEntryType.CARDS],
  ['preflop', 'Hero: raises 100 to 150', HandLogEntryType.ACTION],
  ['flop', '*** FLOP *** [J♦ 7♠ 2♣]', HandLogEntryType.STREET],
  ['flop-action', 'プレイヤーD: calls 220', HandLogEntryType.ACTION],
  ['turn', '*** TURN *** [J♦ 7♠ 2♣] [9♠]', HandLogEntryType.STREET],
  ['turn-action', 'プレイヤーD: bets 640', HandLogEntryType.ACTION],
]

const turnHandLog: HandLogEntry[] = turnHandLogLines.map(([id, text, type], index) => ({
  handId: 840217,
  id,
  text,
  timestamp: logTimestamp + index * 9_000,
  type,
}))

const realTimeStats: RealTimeStats = {
  communityCards: [38, 20, 3, 28],
  currentPhase: 'Turn',
  handImprovement: result(
    'handImprovement',
    'Hand Improvement',
    {
      currentHand: { name: 'One Pair', rank: 2 },
      improvements: [
        { isComplete: false, isCurrent: false, name: 'Straight Flush', probability: 0, rank: 9 },
        { isComplete: false, isCurrent: false, name: 'Four of a Kind', probability: 0, rank: 8 },
        { isComplete: false, isCurrent: false, name: 'Full House', probability: 8.7, rank: 7 },
        { isComplete: false, isCurrent: false, name: 'Flush', probability: 19.6, rank: 6 },
        { isComplete: false, isCurrent: false, name: 'Straight', probability: 8.7, rank: 5 },
        { isComplete: false, isCurrent: false, name: 'Three of a Kind', probability: 4.3, rank: 4 },
        { isComplete: false, isCurrent: false, name: 'Two Pair', probability: 13.0, rank: 3 },
        { isComplete: true, isCurrent: true, name: 'One Pair', probability: 100, rank: 2 },
      ],
    },
    'Current: One Pair',
  ),
  holeCards: [48, 36],
  potOdds: result(
    'potOdds',
    'Pot Odds',
    { call: 640, isHeroTurn: true, percentage: 26.9, pot: 1740, ratio: '2.7:1' },
    '26.9% (2.7:1)',
  ),
}

const densePlayer = (
  playerId: number,
  name: string,
  hands: number,
): PlayerStats => player(playerId, name, hands, [
  ['vpip', 'VPIP', [401, 987], '40.6% (401/987)'],
  ['pfr', 'PFR', [298, 987], '30.2% (298/987)'],
  ['cbet', 'CB', [126, 183], '68.9% (126/183)'],
  ['cbetFold', 'CBF', [44, 112], '39.3% (44/112)'],
  ['3bet', '3B', [73, 316], '23.1% (73/316)'],
  ['3betfold', '3BF', [41, 86], '47.7% (41/86)'],
  ['steal', 'STL', [96, 173], '55.5% (96/173)'],
  ['foldToSteal', 'FTS', [51, 104], '49.0% (51/104)'],
  ['af', 'AF', [370, 100], '3.7'],
  ['afq', 'AFq', [311, 684], '45.5% (311/684)'],
  ['wtsd', 'WTSD', [98, 401], '24.4% (98/401)'],
  ['wwsf', 'WWSF', [221, 401], '55.1% (221/401)'],
  ['wsd', 'W$SD', [57, 98], '58.2% (57/98)'],
  ['riverCallAccuracy', 'RCA', [19, 27], '70.4% (19/27)'],
])

export const MOCK_SCENARIOS: Record<MockScenarioId, MockScenario> = {
  'turn-decision': {
    handLogEntries: turnHandLog,
    id: 'turn-decision',
    label: 'ターンの判断',
    playerPotOdds: [
      { spr: 2.7, potOdds: { call: 640, isPlayerTurn: true, percentage: 26.9, pot: 1740, ratio: '2.7:1' } },
      { spr: 3.1 },
      { spr: 6.8 },
      { spr: 4.4 },
      { spr: 8.2 },
      { spr: 5.9 },
    ],
    realTimeStats,
    seats: [
      { isHero: true },
      {},
      {},
      {},
      {},
      {},
    ],
    stats: [
      standardStats(HERO_PLAYER_ID, 'Hero', 642, 'balanced'),
      standardStats(2108, 'プレイヤーA', 214, 'tight'),
      standardStats(3440, 'プレイヤーB', 168, 'loose'),
      standardStats(4611, 'プレイヤーC', 192, 'tight'),
      standardStats(5870, 'プレイヤーD', 987, 'balanced'),
      standardStats(6032, 'プレイヤーE', 301, 'loose'),
    ],
  },
  'new-table': {
    handLogEntries: [],
    id: 'new-table',
    label: '新しい卓・データなし',
    playerPotOdds: [],
    seats: [
      { isHero: true },
      {},
      { empty: true },
      {},
      { empty: true },
      {},
    ],
    stats: [
      { playerId: HERO_PLAYER_ID, statResults: [] },
      { playerId: -1 },
      { playerId: -1 },
      { playerId: 8801, statResults: [] },
      { playerId: -1 },
      { playerId: 8802, statResults: [] },
    ],
  },
  'dense-history': {
    handLogEntries: turnHandLog,
    id: 'dense-history',
    label: '長い名前・全統計',
    playerPotOdds: [
      { spr: 0.4, potOdds: { call: 2380, isPlayerTurn: true, percentage: 38.5, pot: 3800, ratio: '1.6:1' } },
    ],
    seats: [
      { isHero: true },
      {},
      {},
      {},
      {},
      {},
    ],
    stats: [
      densePlayer(HERO_PLAYER_ID, 'Hero', 12_840),
      densePlayer(7321, LONG_NAME, 987),
      densePlayer(7322, 'プレイヤーB', 2_411),
      densePlayer(7323, 'プレイヤーC', 104),
      densePlayer(7324, 'プレイヤーD', 8_320),
      densePlayer(7325, 'プレイヤーE', 43_208),
    ],
  },
}
