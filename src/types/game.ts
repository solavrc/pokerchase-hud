/**
 * Game Mechanics Types and Enums
 */

export enum ActionType {
  CHECK = 0,
  BET = 1,
  FOLD = 2,
  CALL = 3,
  RAISE = 4,
  ALL_IN = 5
}

export enum BattleType {
  SIT_AND_GO = 0,          // トーナメント - SitAndGo(ランク戦)
  TOURNAMENT = 1,          // トーナメント - MTT
  FRIEND_SIT_AND_GO = 2,   // トーナメント - フレンドマッチ
  RING_GAME = 4,           // リングゲーム
  FRIEND_RING_GAME = 5,    // リングゲーム - PrivateTable
  CLUB_MATCH = 6,          // トーナメント - SitAndGo(クラブマッチ)
}

export enum BetStatusType {
  HAND_ENDED = -1,
  NOT_IN_PLAY = 0,
  BET_ABLE = 1,
  FOLDED = 2,
  ALL_IN = 3,
  ELIMINATED = 4
}

export enum PhaseType {
  PREFLOP = 0,
  FLOP = 1,
  TURN = 2,
  RIVER = 3,
  /** 独自追加 */
  SHOWDOWN = 4,
}

/** `FOLD`したプレイヤーは`FOLD_OPEN`しない限り含まれない */
export enum RankType {
  ROYAL_FLUSH = 0,
  STRAIGHT_FLUSH = 1,
  FOUR_OF_A_KIND = 2,
  FULL_HOUSE = 3,
  FLUSH = 4,
  STRAIGHT = 5,
  THREE_OF_A_KIND = 6,
  TWO_PAIR = 7,
  ONE_PAIR = 8,
  HIGH_CARD = 9,
  NO_CALL = 10,
  SHOWDOWN_MUCK = 11,
  FOLD_OPEN = 12
}

export enum Position {
  BB = -2,
  SB = -1,
  BTN = 0,
  CO = 1,
  HJ = 2,
  UTG = 3,
}

export enum ActionDetail {
  ALL_IN = 'ALL_IN',
  VPIP = 'VPIP',
  CBET = 'CBET',
  CBET_CHANCE = 'CBET_CHANCE',
  CBET_FOLD = 'CBET_FOLD',
  CBET_FOLD_CHANCE = 'CBET_FOLD_CHANCE',
  $3BET = '3BET',
  $3BET_CHANCE = '3BET_CHANCE',
  $3BET_FOLD = '3BET_FOLD',
  $3BET_FOLD_CHANCE = '3BET_FOLD_CHANCE',
  DONK_BET = 'DONK_BET',
  DONK_BET_CHANCE = 'DONK_BET_CHANCE',
  RIVER_CALL = 'RIVER_CALL',
  RIVER_CALL_WON = 'RIVER_CALL_WON',
}

// Battle type filter constants
export const BATTLE_TYPE_FILTERS = {
  ALL: undefined,
  TOURNAMENT: [BattleType.SIT_AND_GO, BattleType.TOURNAMENT, BattleType.CLUB_MATCH] as number[],
  RING_GAME: [BattleType.RING_GAME, BattleType.FRIEND_RING_GAME] as number[],
  SNG: [BattleType.SIT_AND_GO, BattleType.FRIEND_SIT_AND_GO, BattleType.CLUB_MATCH] as number[],
  MTT: [BattleType.TOURNAMENT] as number[],
  RING: [BattleType.RING_GAME, BattleType.FRIEND_RING_GAME] as number[],
} as const

