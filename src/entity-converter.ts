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
import { getPositionMap, getBigBlindUserId } from './utils/position-utils'

/**
 * エンティティバンドル（一括保存用）
 */
export interface EntityBundle {
  hands: Hand[]
  phases: Phase[]
  actions: Action[]
}

type MutableSession = Omit<Session, 'players'> & {
  players: Map<number, { name: string, rank: string }>
}

/**
 * APIイベントからエンティティを変換するコンバーター
 */
export class EntityConverter {
  private currentHandEvents: ApiHandEvent[] = []
  private currentSession: MutableSession

  constructor(session: Session) {
    // SessionState の id/battleType/name は prototype 上の getter のため、
    // オブジェクトスプレッドではなく各フィールドを明示的に読み出す。
    this.currentSession = {
      id: session.id,
      battleType: session.battleType,
      name: session.name,
      players: new Map(session.players),
      reset: () => { }
    }
  }

  /**
   * イベント配列をエンティティに変換（バッチ処理用）
   */
  convertEventsToEntities(events: ApiEvent[]): EntityBundle {
    const entities = this.convertEventChunk(events)
    const remaining = this.flush()

    entities.hands.push(...remaining.hands)
    entities.phases.push(...remaining.phases)
    entities.actions.push(...remaining.actions)
    return entities
  }

  /**
   * イベントの一部分を変換する。未完了ハンドとセッション状態は次の呼び出しへ引き継ぐ。
   */
  convertEventChunk(events: ApiEvent[]): EntityBundle {
    const entities: EntityBundle = {
      hands: [],
      phases: [],
      actions: []
    }

    for (const event of events) {
      // セッション開始イベントの処理
      if (isApiEventType(event, ApiType.EVT_ENTRY_QUEUED)) {
        this.currentSession.id = event.Id
        this.currentSession.battleType = event.BattleType
        // 新しいセッション開始時はプレイヤー情報をクリア
        this.currentSession.players = new Map()
      } else if (isApiEventType(event, ApiType.EVT_SESSION_DETAILS)) {
        this.currentSession.name = event.Name
      } else if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED)) {
        // プレイヤー名とランクをセッションに保存
        if (event.TableUsers) {
          event.TableUsers.forEach(tableUser => {
            this.currentSession.players.set(tableUser.UserId, {
              name: tableUser.UserName,
              rank: tableUser.Rank.RankId
            })
          })
        }
      } else if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN)) {
        // 途中参加者のプレイヤー名とランクをセッションに保存
        if (event.JoinUser) {
          this.currentSession.players.set(event.JoinUser.UserId, {
            name: event.JoinUser.UserName,
            rank: event.JoinUser.Rank.RankId
          })
        }
      }

      // EVT_DEALでハンド開始
      if (event.ApiTypeId === ApiType.EVT_DEAL) {
        // 前のハンドが完了していない場合も処理
        this.appendCurrentHand(entities)
        this.currentHandEvents = [event as ApiHandEvent]
      } else if (this.currentHandEvents.length > 0) {
        this.currentHandEvents.push(event as ApiHandEvent)

        // EVT_HAND_RESULTSでハンド終了
        if (event.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
          this.appendCurrentHand(entities)
        }
      }
    }

    return entities
  }

  /** 残っている未完了ハンドを最終化する。 */
  flush(): EntityBundle {
    const entities: EntityBundle = { hands: [], phases: [], actions: [] }
    this.appendCurrentHand(entities)
    return entities
  }

  private appendCurrentHand(entities: EntityBundle): void {
    if (this.currentHandEvents.length === 0) return

    const handEntities = this.convertHandEvents(this.currentHandEvents, this.currentSession)
    if (handEntities) {
      entities.hands.push(handEntities.hand)
      entities.phases.push(...handEntities.phases)
      entities.actions.push(...handEntities.actions)
    }
    this.currentHandEvents = []
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
            // VPIP/PFRのウォーク除外（#115）判定用（WriteEntityStreamと同一ロジック）。
            bigBlindUserId: getBigBlindUserId(event.SeatUserIds, event.Game.BigBlindSeat),
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
          // 同一フェーズのEVT_DEAL_ROUND重複 = テーブル移動/再編成で2つのハンドが
          // 融合したバッファのシグネチャ（WriteEntityStreamの同名ガードとdocs/api-events.md
          // 「デュアルボード」参照。実データ12/12件でハンド内EQ/313割込みと相関）。
          // Resultsの顔ぶれが偶然一致するとhasResultsOutsideDealtLineupを通過するため、
          // ここで独立に検出してハンド全体を棄却する。
          if (newPhase !== null && handState.phases.some(p => p.phase === newPhase)) {
            console.log(`[EntityConverter] Rejected fused hand buffer: duplicate EVT_DEAL_ROUND for phase ${newPhase} (mid-hand table move/rebalance)`)
            return null
          }
          if (newPhase !== null) {
            // このストリートに進んだプレイヤー（BET_ABLE=フォールドしていない、
            // または ALL_IN=プリフロップオールイン済み）のみをseatUserIdsに
            // 含める（WriteEntityStreamと同一ロジック）。
            // handState.hand.seatUserIds（配札時の全員）をそのまま使うと、
            // プリフロップで既にフォールドしたプレイヤーもこのフェーズを
            // 「見た」ことになり、WTSD/WWSFの分母が水増しされる（#97で修正済み、
            // この制約は維持する）。
            // 一方、PT4公式の「flops seen」はプリフロップオールインを含む
            // （PT4スタッフ: "Those stats are based on flops seen, not based
            // on flops seen when not all-in, so all-in spots will count"）ため、
            // ALL_INステータスのプレイヤーもこのフェーズの参加者に含める
            // （#115）。FOLDEDのプレイヤーのみが引き続き除外される。
            const seatUserIds = (event.Player ? [event.Player, ...event.OtherPlayers] : event.OtherPlayers)
              .filter(({ BetStatus }) => BetStatus === BetStatusType.BET_ABLE || BetStatus === BetStatusType.ALL_IN)
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

          // このハンドで最終的に見えているコミュニティカード全体（既存フェーズの
          // 蓄積分 + このEVT_HAND_RESULTS自身が運ぶ分）。SHOWDOWNフェーズの
          // communityCardsはこれをそのまま使う（下のFLOP合成ブロックがphasesに
          // 要素をpushした後で再度lastPhase.communityCardsを参照すると、
          // EVT_HAND_RESULTSのCommunityCardsを二重に数えてしまう）。
          const fullBoard = [...(handState.phases.at(-1)?.communityCards || []), ...(event.CommunityCards || [])]

          // プリフロップ全員オールインでストリートが自動進行した場合、PokerChaseは
          // 残りのEVT_DEAL_ROUNDを一切送信せず、コミュニティカードは全てこの
          // EVT_HAND_RESULTS.CommunityCardsにまとめて届く（docs/api-events.md
          // 「EVT_DEAL_ROUND: CommunityCards」）。この場合FLOPフェーズが一度も
          // pushされないため、WTSD/WWSFの「flops seen」分母がゼロ扱いになり、
          // PT4公式定義（プリフロップオールインを含む「flops seen」）と食い違う
          // （#115で修正した通常のDEAL_ROUND経由のALL_IN救済では、DEAL_ROUND自体が
          // 送信されないこのケースを救えていなかった。sola監査、#115未解決コメント）。
          // フェーズ配列にFLOPが一度も現れておらず、かつボードが3枚以上到達して
          // いる場合のみ、FLOPフェーズを合成する（WriteEntityStreamと同一ロジック）。
          // BetStatusのスナップショットが存在しないため、通常経路（BET_ABLE ||
          // ALL_IN）の代わりに以下2条件のANDでメンバーシップを判定する（PR #184
          // codex review, P2）:
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
            const resultUserIds = new Set((event.Results || []).map(({ UserId }) => UserId))
            handState.phases.push({
              handId: event.HandId,
              phase: PhaseType.FLOP,
              seatUserIds: (handState.hand.seatUserIds || []).filter(uid =>
                uid !== -1 && !preflopFoldedPlayerIds.has(uid) && resultUserIds.has(uid)
              ),
              communityCards: fullBoard.slice(0, 3),
            })
          }

          // ショーダウンフェーズの生成（実際にカードを比較したプレイヤーが2名以上いる場合）
          // NO_CALL（無競争勝利）やFOLD_OPEN（フォールド後の自発公開）はショーダウンではないため除外する
          {
            const showdownParticipants = (event.Results || []).filter(isShowdownParticipant)
            if (showdownParticipants.length >= 2) {
              handState.phases.push({
                handId: event.HandId,
                phase: PhaseType.SHOWDOWN,
                communityCards: fullBoard,
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
