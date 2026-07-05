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
  BetStatusType,
  PhaseType,
  Position,
  hasResultsOutsideDealtLineup,
  isApiEventType,
  isShowdownParticipant
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
import { getPositionMap } from './utils/position-utils'

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
    // NOTE: this.session は SessionState クラスのインスタンスの場合があり、
    // id/battleType/name は prototype 上の getter のため、オブジェクトスプレッドでは
    // コピーされない（private な _id/_battleType/_name のみコピーされ、値が undefined になる）。
    // そのため各フィールドを明示的に読み出す。
    let currentSession = {
      id: this.session.id,
      battleType: this.session.battleType,
      name: this.session.name,
      players: new Map(this.session.players), // Mapを正しくコピー（可変Mapとして扱う）
      reset: () => { } // ローカルな作業コピーではreset()は使用されない
    }

    for (const event of events) {
      // セッション開始イベントの処理
      if (isApiEventType(event, ApiType.EVT_ENTRY_QUEUED)) {
        currentSession.id = event.Id
        currentSession.battleType = event.BattleType
        // 新しいセッション開始時はプレイヤー情報をクリア
        currentSession.players = new Map()
      } else if (isApiEventType(event, ApiType.EVT_SESSION_DETAILS)) {
        currentSession.name = event.Name
      } else if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED)) {
        // プレイヤー名とランクをセッションに保存
        if (event.TableUsers) {
          event.TableUsers.forEach(tableUser => {
            currentSession.players.set(tableUser.UserId, {
              name: tableUser.UserName,
              rank: tableUser.Rank.RankId
            })
          })
        }
      } else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN)) {
        // 途中参加者のプレイヤー名とランクをセッションに保存
        if (event.JoinUser) {
          currentSession.players.set(event.JoinUser.UserId, {
            name: event.JoinUser.UserName,
            rank: event.JoinUser.Rank.RankId
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
      statStates: {} // 各統計プラグインが自身のIDでネームスペース化した一時状態を保持
    }

    // プレイヤーID → ポジションのマップ（EVT_DEALで1ハンドにつき1度だけ設定される。
    // WriteEntityStream（ライブ記録パイプライン）と同一のロジックで算出し、
    // インポート/リビルド後もポジション値が一致するようにする）
    let positionMap: Map<number, Position> = new Map()

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

          // プレイヤーID → ポジションのマップを算出（WriteEntityStreamと同一ロジック）。
          // Game.ButtonSeat/SmallBlindSeat/BigBlindSeatから直接導出し、全フェーズ共通で使用する。
          positionMap = getPositionMap(event.SeatUserIds, event.Game)

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

          // 途中着席（EVT_ENTRY_QUEUED）によるテーブル移動後、直前にバッファされた
          // EVT_DEALのSeatUserIdsには新テーブルの座席が反映されておらず、
          // event.SeatIndexが解決できない（undefined）か空席（-1）を指すことがある。
          // 実データ検証: 完走した27ハンド / 68アクション（全ハンドの0.09%）でこの状況を確認。
          // 従来はplayerId ?? 0でplayerId=0を捏造し、position=-3のアクションが
          // actionsテーブルに混入していた。検出コンテキストも意味を持たないため、
          // このアクション自体を丸ごとスキップする（ハンドの他のアクションは通常通り処理を続ける）。
          // progressは次のアクションのALL_IN正規化で参照されるため、スキップする場合でも更新する。
          if (playerId === undefined || playerId === -1) {
            progress = event.Progress
            break
          }

          const phase = handState.phases.at(-1)!.phase
          const phaseActions = handState.actions.filter(action => action.phase === phase)
          const phasePrevBetCount = phaseActions.filter(action =>
            [ActionType.BET, ActionType.RAISE].includes(action.actionType)
          ).length + Number(phase === PhaseType.PREFLOP)

          // phasePlayerActionIndexを計算
          const phasePlayerActionIndex = phaseActions.filter(action =>
            action.playerId === playerId
          ).length

          // ポジション計算（WriteEntityStreamと同一ロジック。EVT_DEAL時点で確定した
          // positionMapを全フェーズで使い回すことで、ライブ記録と同じポジション値を得る）
          const position: Position = positionMap.get(playerId) ?? -3 as Position

          // 統計モジュールを使用してActionDetailを検出
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

          // アクションの作成（handIdは後でEVT_HAND_RESULTSで更新される）
          handState.actions.push({
            handId: 0, // EVT_HAND_RESULTSで更新される
            index: handState.actions.length,
            playerId,
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
            // このストリートに進んだプレイヤー（BET_ABLE=フォールドしていない）のみを
            // seatUserIdsに含める（WriteEntityStreamと同一ロジック）。
            // handState.hand.seatUserIds（配札時の全員）をそのまま使うと、
            // プリフロップで既にフォールドしたプレイヤーもこのフェーズを
            // 「見た」ことになり、WTSD/WWSFの分母が水増しされる。
            const seatUserIds = (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers)
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BET_ABLE)
              .sort((a, b) => a.SeatIndex - b.SeatIndex)
              .map(({ SeatIndex }) => handState.hand.seatUserIds.at(SeatIndex)!)
            handState.phases.push({
              handId: 0, // EVT_HAND_RESULTSで更新される
              phase: newPhase,
              seatUserIds,
              communityCards: event.CommunityCards || []
            })
          }

          progress = event.Progress
          break
        }

        case ApiType.EVT_HAND_RESULTS: {
          // テーブル移動キメラハンドの棄却（詳細はhasResultsOutsideDealtLineupのdocコメント参照）。
          // Results[]に配札時のseatUserIdsへ存在しないUserIdが1件でもあれば、このRESULTSは
          // 移動先テーブルのものであり、バッファ中のハンド（移動元テーブルのDEAL）とは
          // 対応しない。真の対応先RESULTSは二度と届かないため、ハンド全体を棄却する
          // （handState.hand.idを0のままにし、末尾の有効性チェックでnullを返させる）。
          if (hasResultsOutsideDealtLineup(handState.hand.seatUserIds || [], event.Results || [])) {
            console.log(`[EntityConverter] Rejected chimera hand (HandId=${event.HandId}): EVT_HAND_RESULTS.Results references a player outside the dealt lineup (mid-hand table move)`)
            break
          }

          // HandIdを設定
          handState.hand.id = event.HandId

          // すべてのフェーズとアクションのhandIdを更新
          handState.phases.forEach(phase => {
            phase.handId = event.HandId
          })
          handState.actions.forEach(action => {
            action.handId = event.HandId
          })

          // ショーダウンフェーズの生成（実際にカードを比較したプレイヤーが2名以上いる場合）
          // NO_CALL（無競争勝利）やFOLD_OPEN（フォールド後の自発公開）はショーダウンではないため除外する
          {
            const showdownParticipants = (event.Results || []).filter(isShowdownParticipant)
            if (showdownParticipants.length >= 2) {
              const lastPhase = handState.phases.at(-1)
              handState.phases.push({
                handId: event.HandId,
                phase: PhaseType.SHOWDOWN,
                communityCards: [...(lastPhase?.communityCards || []), ...(event.CommunityCards || [])],
                seatUserIds: showdownParticipants.map(result => result.UserId)
              })
            }
          }

          // ハンド結果の更新
          handState.hand.winningPlayerIds = event.Results
            ?.filter(result => result.RewardChip > 0)
            .map(result => result.UserId) || []
          handState.hand.results = event.Results || []
          handState.hand.approxTimestamp = event.timestamp

          // RIVER_CALLで勝利したアクションにRIVER_CALL_WONを付与する
          // （WriteEntityStreamと同一ロジック。River Call Accuracy統計が参照する）
          handState.actions.forEach(action => {
            if (action.actionDetails.includes(ActionDetail.RIVER_CALL) &&
                handState.hand.winningPlayerIds.includes(action.playerId)) {
              action.actionDetails.push(ActionDetail.RIVER_CALL_WON)
            }
          })
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
}
