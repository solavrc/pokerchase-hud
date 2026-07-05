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

/**
 * ショーダウン（カードの強制/自発的公開による勝敗比較）が実際に発生したことを示すRankTypeか判定する。
 *
 * - 0-9（実役）: ショーダウンで役を比較した結果
 * - 11 (SHOWDOWN_MUCK): ショーダウンに参加したが敗北してマック（＝ショーダウンは発生した）
 * - 10 (NO_CALL) / 12 (FOLD_OPEN): ショーダウンは発生していない（無競争勝利／フォールド後の自発公開）
 *
 * `EVT_HAND_RESULTS.Results`は`RankType`を持つオブジェクトの配列であり、SHOWDOWNフェーズ生成や
 * WTSD/W$SD統計はこの述語で「ショーダウン参加者」を判定する必要がある（詳細はCLAUDE.mdの
 * Confirmed Statistical Definitions参照）。
 */
export function isShowdownParticipant(result: { RankType: RankType }): boolean {
  return result.RankType !== RankType.NO_CALL && result.RankType !== RankType.FOLD_OPEN
}

/**
 * MTTでヒーローがハンド途中に別テーブルへ移動した際に発生する「キメラハンド」を検出する。
 *
 * 発生機序: EVT_ENTRY_QUEUEDでテーブル移動が発生すると、クライアントは移動先テーブルで
 * 進行中だったハンドの残り（EVT_ACTIONの末尾、およびそのEVT_HAND_RESULTS）を受信する。
 * 移動先のEVT_ACTION.SeatIndexは旧テーブルのバッファ済みEVT_DEAL.SeatUserIdsに対しては
 * 意味を持たないが、席番号が偶然旧テーブルの有効な席インデックス範囲・NextActionSeatの
 * 遷移パターンと一致した場合、#100のSeatIndex未解決ガード（EC/WES双方のEVT_ACTIONケース）
 * をすり抜けてハンドバッファが継続してしまう。結果、旧テーブルのEVT_DEAL（座席構成・
 * ブラインド・ヒーローのホールカード）と新テーブルのEVT_HAND_RESULTS（HandId、勝者、
 * 獲得チップ）が1つのハンドとして混ざり合う。
 *
 * 実データ検証（393,830イベント、31,392完走ハンド）: SeatIndex未解決アクションを含む
 * 27ハンド中、25ハンドはこの述語がtrueになる（23ハンドはResults[]が新テーブルの
 * 座席構成と完全一致、2ハンドは新旧混在）。残り2ハンドは旧テーブルのDEALと正しく
 * 対応しており、この述語はfalseのまま（正当なハンドとして許容される）。
 * また、SeatIndex未解決アクションが1件もない場合でも、席番号の偶然の一致により
 * 同様のキメラが発生するケースが46ハンド追加で確認された（全てEVT_ENTRY_QUEUED
 * 直後の最初の完走ハンドであり、テーブル移動由来と断定できる）。
 *
 * 判定: EVT_HAND_RESULTS.Results[]のUserIdが1件でもEVT_DEAL.SeatUserIds（着席者）に
 * 含まれない場合、そのRESULTSは真の対応先（ヒーローが離脱した旧テーブル）からは
 * 決して届かないため、バッファ中のハンドを丸ごと棄却するべきと判定する。
 */
export function hasResultsOutsideDealtLineup(seatUserIds: readonly number[], results: readonly { UserId: number }[]): boolean {
  const dealtUserIds = new Set(seatUserIds.filter(id => id !== -1))
  return results.some(({ UserId }) => !dealtUserIds.has(UserId))
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
  STEAL = 'STEAL',
  STEAL_CHANCE = 'STEAL_CHANCE',
  FOLD_TO_STEAL = 'FOLD_TO_STEAL',
  FOLD_TO_STEAL_CHANCE = 'FOLD_TO_STEAL_CHANCE',
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
