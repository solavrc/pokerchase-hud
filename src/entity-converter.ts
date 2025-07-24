/**
 * エンティティ変換ユーティリティ
 *
 * APIイベントから直接エンティティ（Hand, Phase, Action）を生成する
 * Stream処理から独立して使用可能
 */

import {
  ActionDetail,
  ActionType,
  ApiType,
  PhaseType,
  Position
} from './types'

import type {
  Action,
  ApiEvent,
  ApiHandEvent,
  Hand,
  Phase,
  HandState,
  Session,
  ActionDetailContext
} from './types'

import { defaultRegistry } from './stats'
import { rotateArrayFromIndex } from './utils/array-utils'

/**
 * エンティティバンドル（一括保存用）
 */
export interface EntityBundle {
  hands: Hand[]
  phases: Phase[]
  actions: Action[]
}

/**
 * APIイベントからエンティティを変換するコンバーター
 */
export class EntityConverter {
  private session: Session

  constructor(session: Session) {
    this.session = session
  }

  /**
   * イベント配列をエンティティに変換（バッチ処理用）
   */
  convertEventsToEntities(events: ApiEvent[]): EntityBundle {
    const entities: EntityBundle = {
      hands: [],
      phases: [],
      actions: []
    }

    let currentHandEvents: ApiHandEvent[] = []
    // セッション情報をローカルに保持（インポートデータから抽出）
    let currentSession = {
      ...this.session,
      players: new Map(this.session.players) // Mapを正しくコピー
    }

    for (const event of events) {
      // セッション開始イベントの処理
      if (event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
        // isApiEventTypeの代わりにApiTypeIdを直接チェック
        // テストケースの不完全なデータに対応
        const entryEvent = event as ApiEvent<ApiType.EVT_ENTRY_QUEUED>
        currentSession.id = entryEvent.Id
        currentSession.battleType = entryEvent.BattleType
        // 新しいセッション開始時はプレイヤー情報をクリア
        currentSession.players = new Map()
      } else if (event.ApiTypeId === ApiType.EVT_SESSION_DETAILS) {
        const detailsEvent = event as ApiEvent<ApiType.EVT_SESSION_DETAILS>
        currentSession.name = detailsEvent.Name
      } else if (event.ApiTypeId === ApiType.EVT_PLAYER_SEAT_ASSIGNED) {
        // プレイヤー名とランクをセッションに保存
        const seatEvent = event as ApiEvent<ApiType.EVT_PLAYER_SEAT_ASSIGNED>
        if (seatEvent.TableUsers) {
          seatEvent.TableUsers.forEach(tableUser => {
            currentSession.players.set(tableUser.UserId, {
              name: tableUser.UserName,
              rank: tableUser.Rank.RankId
            })
          })
        }
      } else if (event.ApiTypeId === ApiType.EVT_PLAYER_JOIN) {
        // 途中参加者のプレイヤー名とランクをセッションに保存
        const joinEvent = event as ApiEvent<ApiType.EVT_PLAYER_JOIN>
        if (joinEvent.JoinUser) {
          currentSession.players.set(joinEvent.JoinUser.UserId, {
            name: joinEvent.JoinUser.UserName,
            rank: joinEvent.JoinUser.Rank.RankId
          })
        }
      }

      // EVT_DEALでハンド開始
      if (event.ApiTypeId === ApiType.EVT_DEAL) {
        // 前のハンドが完了していない場合も処理
        if (currentHandEvents.length > 0) {
          const handEntities = this.convertHandEvents(currentHandEvents, currentSession)
          if (handEntities) {
            entities.hands.push(handEntities.hand)
            entities.phases.push(...handEntities.phases)
            entities.actions.push(...handEntities.actions)
          }
        }
        currentHandEvents = [event as ApiHandEvent]
      } else if (currentHandEvents.length > 0) {
        currentHandEvents.push(event as ApiHandEvent)

        // EVT_HAND_RESULTSでハンド終了
        if (event.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
          const handEntities = this.convertHandEvents(currentHandEvents, currentSession)
          if (handEntities) {
            entities.hands.push(handEntities.hand)
            entities.phases.push(...handEntities.phases)
            entities.actions.push(...handEntities.actions)
          }
          currentHandEvents = []
        }
      }
    }

    // 残りのハンドデータを処理
    if (currentHandEvents.length > 0) {
      const handEntities = this.convertHandEvents(currentHandEvents, currentSession)
      if (handEntities) {
        entities.hands.push(handEntities.hand)
        entities.phases.push(...handEntities.phases)
        entities.actions.push(...handEntities.actions)
      }
    }

    return entities
  }

  /**
   * 1ハンド分のイベントをエンティティに変換
   */
  private convertHandEvents(events: ApiHandEvent[], session: Session): { hand: Hand, phases: Phase[], actions: Action[] } | null {
    if (events.length === 0) return null

    const handState: HandState = {
      hand: {} as Hand,
      phases: [],
      actions: [],
      cBetter: undefined // CB統計のために追加
    }

    let progress: any = undefined

    for (const event of events) {
      switch (event.ApiTypeId) {
        case ApiType.EVT_DEAL: {
          // ハンドの作成（IDは一時的に0を設定、EVT_HAND_RESULTSで更新）
          handState.hand = {
            id: 0, // EVT_HAND_RESULTSのHandIdで更新される
            approxTimestamp: event.timestamp,
            seatUserIds: event.SeatUserIds,
            winningPlayerIds: [],
            smallBlind: event.Game.SmallBlind,
            bigBlind: event.Game.BigBlind,
            session: {
              id: session.id,
              battleType: session.battleType,
              name: session.name
            },
            results: []
          }

          // プリフロップフェーズの作成（handIdは後で更新される）
          handState.phases.push({
            handId: 0, // EVT_HAND_RESULTSで更新される
            phase: PhaseType.PREFLOP,
            seatUserIds: event.SeatUserIds,
            communityCards: []
          })

          progress = event.Progress
          break
        }

        case ApiType.EVT_ACTION: {
          // handIdはEVT_HAND_RESULTSで設定されるため、ここではhandの存在のみチェック
          if (!handState.hand.seatUserIds) break

          const actionDetails: ActionDetail[] = []

          // ALL_INアクションの正規化
          const actionType = this.normalizeAllInAction(event, progress, actionDetails)
          const playerId = handState.hand.seatUserIds[event.SeatIndex]
          const phase = handState.phases.at(-1)!.phase
          const phaseActions = handState.actions.filter(action => action.phase === phase)
          const phasePrevBetCount = phaseActions.filter(action =>
            [ActionType.BET, ActionType.RAISE].includes(action.actionType)
          ).length + Number(phase === PhaseType.PREFLOP)

          // phasePlayerActionIndexを計算
          const phasePlayerActionIndex = phaseActions.filter(action =>
            action.playerId === playerId
          ).length

          // 統計モジュールを使用してActionDetailを検出
          const detectionContext: ActionDetailContext = {
            playerId: playerId ?? 0,
            actionType,
            phase,
            phasePlayerActionIndex,
            phasePrevBetCount,
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

          // ポジション計算のためのユーザーID配列を作成
          const positionUserIds = this.getPositionUserIds(handState.hand.seatUserIds, phase)

          // ポジション計算
          let position: Position
          const playerIndex = positionUserIds.indexOf(playerId ?? 0)
          if (playerIndex === 0) {
            position = Position.SB // -1
          } else if (playerIndex === 1) {
            position = Position.BB // -2
          } else if (playerIndex === 2) {
            position = Position.UTG // 3
          } else if (playerIndex === 3) {
            position = Position.HJ // 2
          } else if (playerIndex === 4) {
            position = Position.CO // 1
          } else {
            position = Position.BTN // 0
          }

          // アクションの作成（handIdは後でEVT_HAND_RESULTSで更新される）
          handState.actions.push({
            handId: 0, // EVT_HAND_RESULTSで更新される
            index: handState.actions.length,
            playerId: playerId ?? 0,
            phase,
            actionType,
            bet: event.BetChip,
            pot: event.Progress.Pot,
            sidePot: event.Progress.SidePot,
            position,
            actionDetails
          })

          progress = event.Progress
          break
        }

        case ApiType.EVT_DEAL_ROUND: {
          // handIdはEVT_HAND_RESULTSで設定されるため、ここではhandの存在のみチェック
          if (!handState.hand.seatUserIds) break

          // 新しいフェーズの作成
          const newPhase = this.getPhaseFromProgress(event.Progress)
          if (newPhase !== null) {
            handState.phases.push({
              handId: 0, // EVT_HAND_RESULTSで更新される
              phase: newPhase,
              seatUserIds: handState.hand.seatUserIds,
              communityCards: event.CommunityCards || []
            })
          }

          progress = event.Progress
          break
        }

        case ApiType.EVT_HAND_RESULTS: {
          // HandIdを設定
          handState.hand.id = event.HandId

          // すべてのフェーズとアクションのhandIdを更新
          handState.phases.forEach(phase => {
            phase.handId = event.HandId
          })
          handState.actions.forEach(action => {
            action.handId = event.HandId
          })

          // ショーダウンフェーズの生成（複数のプレイヤーが結果に含まれる場合）
          if (event.Results && event.Results.length > 1) {
            const lastPhase = handState.phases.at(-1)
            handState.phases.push({
              handId: event.HandId,
              phase: PhaseType.SHOWDOWN,
              communityCards: [...(lastPhase?.communityCards || []), ...(event.CommunityCards || [])],
              seatUserIds: event.Results.map(result => result.UserId)
            })
          }

          // ハンド結果の更新
          handState.hand.winningPlayerIds = event.Results
            ?.filter(result => result.RewardChip > 0)
            .map(result => result.UserId) || []
          handState.hand.results = event.Results || []
          handState.hand.approxTimestamp = event.timestamp
          break
        }
      }
    }

    // 有効なハンドデータの場合のみ返す（handIdが設定されていることを確認）
    if (handState.hand.id > 0 && handState.phases.length > 0) {
      return {
        hand: handState.hand,
        phases: handState.phases,
        actions: handState.actions
      }
    }

    return null
  }

  /**
   * ALL_INアクションを適切なアクションタイプに正規化
   */
  private normalizeAllInAction(
    event: ApiEvent<ApiType.EVT_ACTION>,
    progress: any,
    actionDetails: ActionDetail[]
  ): Exclude<ActionType, ActionType.ALL_IN> {
    if (event.ActionType === ActionType.ALL_IN) {
      actionDetails.push(ActionDetail.ALL_IN)

      if (progress?.NextActionTypes.includes(ActionType.BET)) {
        return ActionType.BET
      } else if (progress?.NextActionTypes.includes(ActionType.CALL)) {
        return ActionType.RAISE
      } else {
        return ActionType.CALL
      }
    }

    return event.ActionType
  }

  /**
   * Progressからフェーズを取得
   */
  private getPhaseFromProgress(progress: any): PhaseType | null {
    if (!progress) return null

    switch (progress.Phase) {
      case 0: return PhaseType.PREFLOP
      case 1: return PhaseType.FLOP
      case 2: return PhaseType.TURN
      case 3: return PhaseType.RIVER
      default: return null
    }
  }

  /**
   * ポジション計算用のユーザーID配列を取得
   */
  private getPositionUserIds(seatUserIds: number[], phase: PhaseType): number[] {
    // プリフロップの場合はSB/BBから始まる順序
    if (phase === PhaseType.PREFLOP) {
      // SBの位置を見つける（BBの1つ前）
      let sbIndex = -1
      for (let i = 0; i < seatUserIds.length; i++) {
        if (seatUserIds[i] !== -1 && seatUserIds[(i + 1) % seatUserIds.length] !== -1) {
          sbIndex = i
          break
        }
      }

      if (sbIndex === -1) return seatUserIds // フォールバック

      // SBから順に並べ替え
      return rotateArrayFromIndex(seatUserIds, sbIndex)
    }

    // ポストフロップの場合はボタンの次から始まる順序
    // 簡単のため、最後の有効なプレイヤーをボタンとする
    let buttonIndex = -1
    for (let i = seatUserIds.length - 1; i >= 0; i--) {
      if (seatUserIds[i] !== -1) {
        buttonIndex = i
        break
      }
    }

    if (buttonIndex === -1) return seatUserIds // フォールバック

    // ボタンの次から順に並べ替え
    const nextIndex = (buttonIndex + 1) % seatUserIds.length
    return rotateArrayFromIndex(seatUserIds, nextIndex)
  }
}
