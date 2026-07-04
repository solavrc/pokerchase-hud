import { Transform } from 'stream'
import type PokerChaseService from '../services/poker-chase-service'
import {
  ActionDetail,
  ActionType,
  ApiType,
  BetStatusType,
  PhaseType,
  isShowdownParticipant,
  Position
} from '../types'
import type {
  ApiHandEvent,
  HandState,
  Progress
} from '../types'
import type { ActionDetailContext } from '../types/stats'
import { ErrorHandler } from '../utils/error-handler'
import { getPositionMap } from '../utils/position-utils'
import { defaultRegistry } from '../stats'
import type { ErrorContext } from '../types/errors'

type TransformCallback<T> = (error?: Error | null, data?: T) => void

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
export class WriteEntityStream extends Transform {
  private service: PokerChaseService
  constructor(service: PokerChaseService) {
    super({ objectMode: true })
    this.service = service
  }
  async _transform(events: ApiHandEvent[], _: string, callback: TransformCallback<number[]>) {
    try {
      const { hand, actions, phases } = this.toHandState(events)

      await this.service.db.transaction('rw', [this.service.db.hands, this.service.db.phases, this.service.db.actions], async () => {
        return Promise.all([
          this.service.db.hands.put(hand),
          this.service.db.actions.bulkPut(actions),
          this.service.db.phases.bulkPut(phases)
        ])
      })
      callback(null, hand.seatUserIds)
    } catch (error: unknown) {
      const context: ErrorContext = {
        streamName: 'WriteEntityStream',
        handId: events.find(e => e.ApiTypeId === ApiType.EVT_HAND_RESULTS)?.HandId,
        eventsCount: events.length
      }
      const errorCallback = ErrorHandler.createStreamErrorCallback(
        callback,
        'WriteEntityStream',
        context
      )
      errorCallback(error)
    }
  }
  private toHandState = (events: ApiHandEvent[]): HandState => {
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
    for (const event of events) {
      switch (event.ApiTypeId) {
        case ApiType.EVT_DEAL:
          handState.hand.seatUserIds = event.SeatUserIds
          positionMap = getPositionMap(event.SeatUserIds, event.Game)
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: event.SeatUserIds,
            communityCards: [],
          })
          handState.hand.bigBlind = event.Game.BigBlind
          handState.hand.smallBlind = event.Game.SmallBlind
          progress = event.Progress
          break
        case ApiType.EVT_DEAL_ROUND:
          handState.phases.push({
            phase: event.Progress.Phase,
            seatUserIds: (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers)
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BET_ABLE)
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
          // ショーダウンフェーズの生成（実際にカードを比較したプレイヤーが2名以上いる場合）
          // NO_CALL（無競争勝利）やFOLD_OPEN（フォールド後の自発公開）はショーダウンではないため除外する
          const showdownParticipants = event.Results.filter(isShowdownParticipant)
          if (showdownParticipants.length >= 2) {
            handState.phases.push({
              phase: PhaseType.SHOWDOWN,
              communityCards: [...handState.phases.at(-1)!.communityCards, ...event.CommunityCards],
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
          handState.hand.approxTimestamp = event.timestamp
          handState.hand.results = event.Results

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
