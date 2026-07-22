import { SimpleTransform } from './simple-transform'
import type PokerChaseService from '../services/poker-chase-service'
import {
  ActionDetail,
  ActionType,
  ApiType,
  BetStatusType,
  PhaseType,
  hasResultsOutsideDealtLineup,
  isShowdownParticipant,
  Position
} from '../types'
import type {
  ApiEvent,
  ApiHandEvent,
  HandState,
  Progress
} from '../types'
import type { ActionDetailContext } from '../types/stats'
import { ErrorHandler } from '../utils/error-handler'
import { getPositionMap, getBigBlindUserId } from '../utils/position-utils'
import { defaultRegistry } from '../stats'
import type { ErrorContext } from '../types/errors'
import { derivePlayerHandChipAccounting } from '../utils/hand-chip-accounting'

/**
 * エンティティ書き込みStream（パイプライン第2段階）
 *
 * 集約されたハンドイベントを構造化データに変換してDBに永続化する：
 * - ApiHandEvent配列をHand、Phase、Actionエンティティに分解
 * - ALL_INアクションをBET/RAISE/CALLに正規化
 * - 統計計算用のActionDetailフラグを各アクションに付与
 * - ポジション計算（相対的な座席位置）
 * - 統計モジュールからのActionDetail検出とHandState更新
 * - トランザクション内でhands、phases、actionsテーブルに一括書き込み
 *
 * 入力: 1ハンド分のApiHandEvent配列
 * 出力: プレイヤーIDの配列（seatUserIds） → ReadEntityStream
 */
export class WriteEntityStream extends SimpleTransform<ApiHandEvent[], number[]> {
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super()
    this.service = service
  }
  protected async transform(events: ApiHandEvent[]): Promise<void> {
    try {
      const handState = this.toHandState(events)
      if (handState === null) {
        // キメラハンド（テーブル移動によるDEAL/RESULTS不整合）。DB書き込み・
        // seatUserIdsのダウンストリーム配信ともにスキップする。
        const handId = events.find(e => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)?.HandId
        console.log(`[WriteEntityStream] Rejected chimera hand (HandId=${handId}): EVT_HAND_RESULTS.Results references a player outside the dealt lineup (mid-hand table move)`)
        return
      }
      const { hand, actions, phases } = handState

      await this.service.db.transaction('rw', [this.service.db.hands, this.service.db.phases, this.service.db.actions], async () => {
        return Promise.all([
          this.service.db.hands.put(hand),
          this.service.db.actions.bulkPut(actions),
          this.service.db.phases.bulkPut(phases)
        ])
      })
      // EVT_DEAL may have warmed this exact lineup into the 5-second HUD
      // cache. The completed hand changes every aggregate, so invalidate only
      // after its entity transaction commits and before downstream recalculates.
      this.service.statsOutputStream.invalidateCache()
      this.push(hand.seatUserIds)
    } catch (error: unknown) {
      const context: ErrorContext = {
        streamName: 'WriteEntityStream',
        handId: events.find(e => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)?.HandId,
        eventsCount: events.length
      }
      const appError = ErrorHandler.handleStreamError(error, 'WriteEntityStream', context)
      if (this.listenerCount('error') > 0) {
        this.emit('error', appError)
      }
    }
  }
  private toHandState = (events: ApiHandEvent[]): HandState | null => {
    let positionMap: Map<number, Position> = new Map()
    const handState: HandState = {
      hand: {
        session: {
          id: this.service.session.id,
          battleType: this.service.session.battleType,
          name: this.service.session.name
        },
        id: NaN,
        approxTimestamp: NaN,
        seatUserIds: [],
        winningPlayerIds: [],
        bigBlind: NaN,
        smallBlind: NaN,
        results: []
      },
      actions: [],
      phases: [],
      statStates: {}
    }
    let progress: Progress | undefined
    let dealEvent: ApiEvent<ApiType.EVT_DEAL> | undefined
    // 同一フェーズのEVT_DEAL_ROUND重複検出用（テーブル移動キメラのシグネチャ）。
    // 実データ検証: 同一ハンドバッファ内でフェーズが重複した12件は、12件全てで
    // ハンド内にEVT_ENTRY_QUEUED/EVT_PLAYER_SEAT_ASSIGNEDが割り込んでおり、
    // 「旧ハンドのDEAL + 移動/再編成先テーブルの別ハンド（異なるボード）」が
    // 融合したバッファだった（いわゆる「デュアルボード」の正体。run it twice等の
    // ゲーム機能ではない）。うち9件はResultsの顔ぶれ不一致で#106のガードに掛かるが、
    // 3件は偶然同じプレイヤー構成のため通過してしまう。フェーズ重複は融合の
    // 自己完結的なシグネチャなので、検出したらハンド全体を棄却する。
    const seenDealRoundPhases = new Set<number>()
    for (const event of events) {
      switch (event.ApiTypeId) {
        case ApiType.EVT_DEAL:
          dealEvent = event
          handState.hand.seatUserIds = event.SeatUserIds
          // Receive chronology and exported hand-log timestamps are anchored
          // at the start of the hand, not when EVT_HAND_RESULTS arrives.
          handState.hand.approxTimestamp = event.timestamp
          positionMap = getPositionMap(event.SeatUserIds, event.Game)
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: event.SeatUserIds,
            communityCards: [],
          })
          handState.hand.bigBlind = event.Game.BigBlind
          handState.hand.smallBlind = event.Game.SmallBlind
          // VPIP/PFRのウォーク除外（#115）判定用（EntityConverterと同一ロジック）。
          handState.hand.bigBlindUserId = getBigBlindUserId(event.SeatUserIds, event.Game.BigBlindSeat)
          progress = event.Progress
          break
        case ApiType.EVT_DEAL_ROUND:
          if (seenDealRoundPhases.has(event.Progress.Phase)) {
            console.warn(`[WriteEntityStream] Rejected fused hand buffer: duplicate EVT_DEAL_ROUND for phase ${event.Progress.Phase} (mid-hand table move/rebalance)`)
            return null
          }
          seenDealRoundPhases.add(event.Progress.Phase)
          handState.phases.push({
            phase: event.Progress.Phase,
            // このストリートに進んだプレイヤー（BET_ABLE=フォールドしていない、
            // または ALL_IN=プリフロップオールイン済み）のみをseatUserIdsに
            // 含める（EntityConverterと同一ロジック）。FOLDEDのプレイヤーは
            // 引き続き除外する（#97）。ALL_INを含めるのはPT4公式の
            // 「flops seen」定義（プリフロップオールインを含む）に合わせるため
            // （#115）。
            seatUserIds: (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers)
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BET_ABLE || BetStatus === BetStatusType.ALL_IN)
              .sort((a, b) => a.SeatIndex - b.SeatIndex)
              .map(({ SeatIndex }) => handState.hand.seatUserIds.at(SeatIndex)!),
            communityCards: [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards],
          })
          progress = event.Progress
          break
        case ApiType.EVT_ACTION: {
          const actionDetails: ActionDetail[] = []
          /**
           * ALL_IN アクション変換ロジック
           *
           * ALL_INは「全チップを賭ける」という賭け金額の情報であり、
           * アクションタイプとしては文脈に応じてBET/RAISE/CALLのいずれかに分類される。
           *
           * 変換ルール:
           * 1. BETが可能な状況（誰もベットしていない） → BET
           * 2. CALLが可能な状況（相手がベット済み） → RAISE
           * 3. それ以外（相手がレイズ済み等） → CALL
           *
           * この変換により、統計計算（VPIP, PFR, AF, AFq等）で
           * ALL_INが適切なアクションとしてカウントされる。
           * ActionDetail.ALL_INフラグは保持され、必要に応じて参照可能。
           */
          const actionType: Exclude<ActionType, ActionType.ALL_IN> = (({ ActionType: actionType }: typeof event) => {
            if (actionType === ActionType.ALL_IN) {
              actionDetails.push(ActionDetail.ALL_IN)
              if (progress?.NextActionTypes.includes(ActionType.BET)) {
                return ActionType.BET
              } else if (progress?.NextActionTypes.includes(ActionType.CALL)) {
                return ActionType.RAISE
              } else {
                return ActionType.CALL
              }
            } else {
              return actionType
            }
          })(event)
          const playerId = handState.hand.seatUserIds[event.SeatIndex]

          // 途中着席（EVT_ENTRY_QUEUED）によるテーブル移動後、直前にバッファされた
          // EVT_DEALのSeatUserIdsには新テーブルの座席が反映されておらず、
          // event.SeatIndexが解決できない（undefined）か空席（-1）を指すことがある。
          // 実データ検証: 完走した27ハンド / 68アクション（全ハンドの0.09%）でこの状況を確認。
          // 従来はplayerId ?? 0でplayerId=0を捏造し、position=-3のアクションが
          // actionsテーブルに混入していた。検出コンテキストも意味を持たないため、
          // このアクション自体を丸ごとスキップする（ハンドの他のアクションは通常通り処理を続ける）。
          if (playerId === undefined || playerId === -1) {
            progress = event.Progress
            break
          }

          const phase = handState.phases.at(-1)!.phase
          const phaseActions = handState.actions.filter(action => action.phase === phase)
          const phasePlayerActionIndex = phaseActions.filter(action => action.playerId === playerId).length
          const phasePrevBetCount = phaseActions.filter(action => [ActionType.BET, ActionType.RAISE].includes(action.actionType)).length + Number(phase === PhaseType.PREFLOP)
          const position: Position = positionMap.get(playerId) ?? -3 as Position
          // モジュールベース検出用のActionDetailContext
          const detectionContext: ActionDetailContext = {
            playerId,
            actionType,
            phase,
            phasePlayerActionIndex,
            phasePrevBetCount,
            position,
            handState
          }

          // 統計モジュールからActionDetailsを収集
          for (const stat of defaultRegistry.getAll()) {
            if (stat.detectActionDetails) {
              const detectedDetails = stat.detectActionDetails(detectionContext)
              actionDetails.push(...detectedDetails)
            }
            // 必要に応じてhandStateを更新
            if (stat.updateHandState) {
              stat.updateHandState(detectionContext)
            }
          }
          handState.actions.push({
            playerId,
            phase,
            index: handState.actions.length,
            actionType,
            bet: event.BetChip,
            pot: event.Progress.Pot,
            sidePot: event.Progress.SidePot,
            position,
            actionDetails,
          })
          progress = event.Progress
        }
          break
        case ApiType.EVT_HAND_RESULTS: {
          // テーブル移動キメラハンドの棄却（詳細はhasResultsOutsideDealtLineupのdocコメント参照）。
          // Results[]に配札時のseatUserIdsへ存在しないUserIdが1件でもあれば、このRESULTSは
          // 移動先テーブルのものであり、バッファ中のハンド（移動元テーブルのDEAL）とは
          // 対応しない。真の対応先RESULTSは二度と届かないため、ハンド全体を棄却する。
          if (hasResultsOutsideDealtLineup(handState.hand.seatUserIds, event.Results)) {
            return null
          }

          // このハンドで最終的に見えているコミュニティカード全体（既存フェーズの
          // 蓄積分 + このEVT_HAND_RESULTS自身が運ぶ分）。SHOWDOWNフェーズの
          // communityCardsはこれをそのまま使う（下のFLOP合成ブロックがphasesに
          // 要素をpushした後で再度[...handState.phases.at(-1)!.communityCards, ...]
          // を計算すると、EVT_HAND_RESULTSのCommunityCardsを二重に数えてしまう）。
          const fullBoard = [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards]

          // プリフロップ全員オールインでストリートが自動進行した場合、PokerChaseは
          // 残りのEVT_DEAL_ROUNDを一切送信せず、コミュニティカードは全てこの
          // EVT_HAND_RESULTS.CommunityCardsにまとめて届く（docs/api-events.md
          // 「EVT_DEAL_ROUND: CommunityCards」）。この場合FLOPフェーズが一度も
          // pushされないため、WTSD/WWSFの「flops seen」分母がゼロ扱いになり、
          // PT4公式定義（プリフロップオールインを含む「flops seen」）と食い違う
          // （#115で修正した通常のDEAL_ROUND経由のALL_IN救済では、DEAL_ROUND自体が
          // 送信されないこのケースを救えていなかった。sola監査、#115未解決コメント）。
          // フェーズ配列にFLOPが一度も現れておらず、かつボードが3枚以上到達して
          // いる場合のみ、FLOPフェーズを合成する。BetStatusのスナップショットが
          // 存在しないため、通常経路（BET_ABLE || ALL_IN）の代わりに以下2条件の
          // AND でメンバーシップを判定する（PR #184 codex review, P2）:
          //   (i)  PREFLOPフェーズでFOLDアクションを送っていない（#97のフォールド
          //        除外と同じ結論）
          //   (ii) EVT_HAND_RESULTS.Results[]に存在する
          // (i)単独では不十分: タイムアウト/切断したプレイヤーは明示的なFOLDの
          // EVT_ACTIONが送信されないことがあり、かつこの場合Results[]にも一切
          // 含まれない（docs/api-events.md「EVT_ACTION: 送信されないケース」
          // 「タイムアウト / 切断」、src/types/api.ts EVT_HAND_RESULTS.Results[].UserId
          // のdescribe）。このプレイヤーはフォールドもオールインもしていない
          // （黙って消えただけ）ため、(i)だけで判定するとFLOP合成メンバーに誤って
          // 含まれてしまう。
          // (ii)単独でも不十分: PREFLOPでFOLDしたプレイヤーがFOLD_OPEN（フォールド後
          // の自発的カード公開）を選んだ場合、そのプレイヤーはResults[]に含まれる
          // （RankType=12）にもかかわらずFLOPを見ていない（src/types/api.ts
          // 「フォールド済みプレイヤーはFOLD_OPENしない限りResults[]に含まれない」＝
          // FOLD_OPENなら含まれる）。
          // 一方、真にプリフロップオールインでボードが自動進行した生存者は、それ以上
          // ベット判断の余地がないため必ずショーダウンへ到達しResults[]に実役
          // （RankType 0-9）またはSHOWDOWN_MUCK（11）で現れる — src/types/api.ts の
          // 不変条件「Pot + sum(SidePot) == sum(Results[].RewardChip)」が100%成立する
          // こと（docs/api-events.md該当行）はチップを持つ全参加者がResults[]に
          // エントリを持つことを要求する。したがって両条件のANDのみがゲームの実際の
          // 意味論と一致する。
          if (fullBoard.length >= 3 && !handState.phases.some(p => p.phase === PhaseType.FLOP)) {
            const preflopFoldedPlayerIds = new Set(
              handState.actions
                .filter(a => a.phase === PhaseType.PREFLOP && a.actionType === ActionType.FOLD)
                .map(a => a.playerId)
            )
            const resultUserIds = new Set(event.Results.map(({ UserId }) => UserId))
            handState.phases.push({
              phase: PhaseType.FLOP,
              seatUserIds: handState.hand.seatUserIds.filter(uid =>
                uid !== -1 && !preflopFoldedPlayerIds.has(uid) && resultUserIds.has(uid)
              ),
              communityCards: fullBoard.slice(0, 3),
            })
          }

          // ショーダウンフェーズの生成（実際にカードを比較したプレイヤーが2名以上いる場合）
          // NO_CALL（無競争勝利）やFOLD_OPEN（フォールド後の自発公開）はショーダウンではないため除外する
          const showdownParticipants = event.Results.filter(isShowdownParticipant)
          if (showdownParticipants.length >= 2) {
            handState.phases.push({
              phase: PhaseType.SHOWDOWN,
              communityCards: fullBoard,
              seatUserIds: showdownParticipants.map(({ UserId }) => UserId),
            })
          }
          handState.hand.id = event.HandId
          // 勝者定義: RewardChip > 0（獲得チップがあるプレイヤー）。
          // HandRanking === 1（最強役）ではサイドポットのみを獲得したプレイヤーを
          // 見逃す（メインポット勝者の役が最強でも、サイドポット勝者は別役の場合がある）。
          // WWSF/W$SDはPT4の定義上「ポットの一部でも獲得したか」を問うため、
          // RewardChip基準がこれらの統計と整合する。
          handState.hand.winningPlayerIds = event.Results.filter(({ RewardChip }) => RewardChip > 0).map(({ UserId }) => UserId)
          handState.hand.results = event.Results
          handState.hand.playerChipAccounting = dealEvent
            ? derivePlayerHandChipAccounting(dealEvent, event, handState.hand.session.battleType)
            : Object.fromEntries(handState.hand.seatUserIds.filter(userId => userId !== -1).map(userId => [String(userId), null]))

          // Update actions with handId and add RIVER_CALL_WON for winning river calls
          handState.actions = handState.actions.map(action => {
            const updatedAction = { ...action, handId: event.HandId }

            // Check if this is a river call by a winning player
            if (action.actionDetails.includes(ActionDetail.RIVER_CALL) &&
                handState.hand.winningPlayerIds.includes(action.playerId)) {
              updatedAction.actionDetails = [...action.actionDetails, ActionDetail.RIVER_CALL_WON]
            }

            return updatedAction
          })

          handState.phases = handState.phases.map(phase => ({ ...phase, handId: event.HandId }))
          break
        }
      }
    }
    return handState
  }
}
