/**
 * ハンドログプロセッサー
 * リアルタイムHandLogStreamとバッチエクスポート機能の両方で共有されるロジック
 */

import type { Session } from '../types'
import type { ApiEvent } from '../types/api'
import { ApiType } from '../types/api'
import { ActionType, RankType, PhaseType } from '../types/game'
import { HandLogConfig, HandLogEntry, HandLogEntryType, HandLogState } from '../types/hand-log'
import { formatCards } from './card-utils'

export interface HandLogContext {
  session: Session
  handLogConfig?: HandLogConfig
  playerId?: number
  handTimestamp?: number
}

export class HandLogProcessor {
  private currentHand: HandLogState | null = null
  private communityCards: number[] = []
  private context: HandLogContext

  constructor(context: HandLogContext) {
    this.context = context
  }

  /**
   * 単一のAPIイベントを処理し、新しいログエントリを返す
   */
  processSingleEvent(event: ApiEvent): HandLogEntry[] {
    const newEntries: HandLogEntry[] = []

    switch (event.ApiTypeId) {
      case ApiType.EVT_DEAL:
        newEntries.push(...this.handleDealEvent(event))
        break
      case ApiType.EVT_ACTION:
        newEntries.push(...this.handleActionEvent(event))
        break
      case ApiType.EVT_DEAL_ROUND:
        newEntries.push(...this.handleDealRoundEvent(event))
        break
      case ApiType.EVT_HAND_RESULTS:
        newEntries.push(...this.handleHandResultsEvent(event))
        break
    }

    return newEntries
  }

  /**
   * 複数のイベントを処理（バッチ処理用）
   */
  processEvents(events: ApiEvent[]): HandLogEntry[] {
    const allEntries: HandLogEntry[] = []

    for (const event of events) {
      const newEntries = this.processSingleEvent(event)
      allEntries.push(...newEntries)
    }

    return allEntries
  }

  /**
   * 現在のハンドのすべてのエントリを取得
   */
  getCurrentHandEntries(): HandLogEntry[] {
    return this.currentHand?.entries || []
  }

  /**
   * 現在のハンドが完了しているかチェック
   */
  isHandComplete(): boolean {
    return this.currentHand?.isComplete || false
  }

  private handleDealEvent(event: ApiEvent<ApiType.EVT_DEAL>): HandLogEntry[] {
    if (this.currentHand && !this.currentHand.isComplete) {
      console.warn('[HandLogProcessor] Clearing incomplete hand due to new EVT_DEAL')
    }

    this.communityCards = []

    this.currentHand = {
      entries: [],
      startTime: Date.now(),
      isComplete: false,
      playerNames: new Map(Array.from(this.context.session.players.entries()).map(([id, info]) => [id, info.name])),
      seatUserIds: event.SeatUserIds
    }

    const entries: HandLogEntry[] = []

    const timestamp = this.context.handTimestamp || event.timestamp || Date.now()
    const jstTimestamp = new Date(timestamp).toLocaleString('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(',', '').replace(/(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})/, '$1/$2/$3 $4 JST')

    // キャッシュゲームかトーナメントかを判定
    const isCashGame = this.context.session.battleType !== undefined && [4, 5].includes(this.context.session.battleType)

    let headerText: string
    if (isCashGame) {
      headerText = `PokerChase Hand #pending:  Hold'em No Limit (${event.Game.SmallBlind}/${event.Game.BigBlind}) - ${jstTimestamp}`
    } else {
      headerText = `Tournament #pending, Hold'em No Limit - Level I (${event.Game.SmallBlind}/${event.Game.BigBlind}) - ${jstTimestamp}`
    }

    const headerEntry = this.createEntry(headerText, HandLogEntryType.HEADER)
    entries.push(headerEntry)

    const tableEntry = this.createEntry(
      `Table '${this.context.session.name || 'Unknown'}' 6-max Seat #${event.Game.ButtonSeat + 1} is the button`,
      HandLogEntryType.HEADER
    )
    entries.push(tableEntry)

    // 席エントリを追加
    // 席エントリを作成
    event.SeatUserIds.forEach((userId, seatIndex) => {
      if (userId !== -1) {
        const playerName = this.getPlayerName(userId)
        const chips = this.getPlayerChips(event, seatIndex)

        // 席エントリの詳細

        const seatEntry = this.createEntry(
          `Seat ${seatIndex + 1}: ${playerName} (${chips} in chips)`,
          HandLogEntryType.SEAT
        )
        entries.push(seatEntry)
      }
    })

    // ブラインドとアンテを追加
    const ante = event.Game.Ante

    if (ante > 0) {
      event.SeatUserIds.forEach((userId, _seatIndex) => {
        if (userId !== -1) {
          const playerName = this.getPlayerName(userId)
          const anteEntry = this.createEntry(
            `${playerName}: posts the ante ${ante}`,
            HandLogEntryType.ACTION
          )
          entries.push(anteEntry)
        }
      })
    }

    // スモールブラインド
    const sbSeat = event.Game.SmallBlindSeat
    const sbUserId = sbSeat !== undefined ? event.SeatUserIds[sbSeat] : undefined
    if (sbUserId !== undefined && sbUserId !== -1) {
      const sbEntry = this.createEntry(
        `${this.getPlayerName(sbUserId)}: posts small blind ${event.Game.SmallBlind}`,
        HandLogEntryType.ACTION
      )
      entries.push(sbEntry)
    }

    // ビッグブラインド
    const bbSeat = event.Game.BigBlindSeat
    const bbUserId = bbSeat !== undefined ? event.SeatUserIds[bbSeat] : undefined
    if (bbUserId !== undefined && bbUserId !== -1) {
      const bbEntry = this.createEntry(
        `${this.getPlayerName(bbUserId)}: posts big blind ${event.Game.BigBlind}`,
        HandLogEntryType.ACTION
      )
      entries.push(bbEntry)
    }

    // ホールカード
    if (event.Player?.HoleCards) {
      const cardsEntry = this.createEntry('*** HOLE CARDS ***', HandLogEntryType.STREET)
      entries.push(cardsEntry)

      const playerSeat = event.Player.SeatIndex
      const playerId = playerSeat !== undefined ? event.SeatUserIds[playerSeat] : undefined
      if (playerId === undefined) {
        return entries
      }
      const holeCardsEntry = this.createEntry(
        `Dealt to ${this.getPlayerName(playerId)} [${formatCards(event.Player.HoleCards)}]`,
        HandLogEntryType.CARDS
      )
      entries.push(holeCardsEntry)
    }

    this.currentHand.entries.push(...entries)
    return entries
  }

  private handleActionEvent(event: ApiEvent<ApiType.EVT_ACTION>): HandLogEntry[] {
    if (!this.currentHand) return []

    const playerId = this.currentHand.seatUserIds[event.SeatIndex] || -1
    const playerName = this.getPlayerName(playerId)
    const actionText = this.formatAction(event, playerName)

    const actionEntry = this.createEntry(actionText, HandLogEntryType.ACTION)
    this.currentHand.entries.push(actionEntry)

    return [actionEntry]
  }

  private handleDealRoundEvent(event: ApiEvent<ApiType.EVT_DEAL_ROUND>): HandLogEntry[] {
    if (!this.currentHand) return []

    const streetName = this.getStreetName(event.Progress.Phase)

    // Add new community cards to our running total
    this.communityCards.push(...event.CommunityCards)

    let streetText: string
    if (event.Progress.Phase === 1) { // FLOP
      const cardsText = formatCards(this.communityCards.slice(0, 3))
      streetText = `*** ${streetName} *** [${cardsText}]`
    } else if (event.Progress.Phase === 2) { // TURN
      const flopCards = formatCards(this.communityCards.slice(0, 3))
      const turnCard = formatCards(this.communityCards.slice(3, 4))
      streetText = `*** ${streetName} *** [${flopCards}] [${turnCard}]`
    } else if (event.Progress.Phase === 3) { // RIVER
      const boardCards = formatCards(this.communityCards.slice(0, 4))
      const riverCard = formatCards(this.communityCards.slice(4, 5))
      streetText = `*** ${streetName} *** [${boardCards}] [${riverCard}]`
    } else {
      const cardsText = formatCards(this.communityCards)
      streetText = `*** ${streetName} *** [${cardsText}]`
    }

    const streetEntry = this.createEntry(streetText, HandLogEntryType.STREET)
    this.currentHand.entries.push(streetEntry)

    return [streetEntry]
  }

  private handleHandResultsEvent(event: ApiEvent<ApiType.EVT_HAND_RESULTS>): HandLogEntry[] {
    if (!this.currentHand) return []

    const entries: HandLogEntry[] = []

    // すべてのエントリのHandIdを更新
    this.currentHand.handId = event.HandId
    this.currentHand.isComplete = true

    // すべてのエントリを実際のHandIdで更新
    this.currentHand.entries.forEach(entry => {
      entry.handId = event.HandId
      // ヘッダーテキストを特別に更新
      if (entry.type === HandLogEntryType.HEADER && entry.text.includes('#pending')) {
        entry.text = entry.text.replace('#pending', `#${event.HandId}`)
      }
    })

    // 不足しているコミュニティカードセクションを追加（オールインの場合）
    entries.push(...this.addMissingStreets(event.CommunityCards))

    // カードをショウしているプレイヤーがいる場合はショウダウンを追加
    const playersWithCards = event.Results.filter(r =>
      r.HoleCards && r.HoleCards.length > 0 && r.HoleCards[0] !== -1
    )

    if (playersWithCards.length > 0) {
      const showdownEntry = this.createEntry('*** SHOW DOWN ***', HandLogEntryType.SHOWDOWN)
      entries.push(showdownEntry)

      // ショウダウンのプレイヤーのカードを表示
      event.Results
        .sort((a, b) => a.HandRanking - b.HandRanking) // 勝者を先に
        .forEach(result => {
          const playerName = this.getPlayerName(result.UserId)

          // プレイヤーが表示する有効なホールカードを持っているかチェック
          const hasValidCards = result.HoleCards &&
            result.HoleCards.length > 0 &&
            result.HoleCards[0] !== -1

          if (hasValidCards) {
            const cards = formatCards(result.HoleCards)
            const handDesc = this.getHandDescription(result.RankType)
            const showEntry = this.createEntry(
              `${playerName}: shows [${cards}] (${handDesc})`,
              HandLogEntryType.SHOWDOWN
            )
            entries.push(showEntry)
          } else {
            // プレイヤーがハンドをマック（カードを表示しない）
            const muckEntry = this.createEntry(
              `${playerName}: mucks hand`,
              HandLogEntryType.SHOWDOWN
            )
            entries.push(muckEntry)
          }
        })
    }

    // チップを獲得した人を追加し、コールされなかったベットを処理
    const wentToShowdown = [...this.currentHand.entries, ...entries].some(e => e.text.includes('*** SHOW DOWN ***'))

    event.Results.forEach(result => {
      if (result.RewardChip > 0) {
        const playerName = this.getPlayerName(result.UserId)

        // ショウダウンがない場合、コールされなかったベットをチェック
        if (!wentToShowdown) {
          const uncalledEntries = this.handleUncalledBet(result, playerName)
          entries.push(...uncalledEntries)
        } else {
          // 通常の回収エントリ
          const collectEntry = this.createEntry(
            `${playerName} collected ${result.RewardChip} from pot`,
            HandLogEntryType.SHOWDOWN
          )
          entries.push(collectEntry)

          // ショウダウンがない場合、"doesn't show hand"を追加
          if (!wentToShowdown) {
            const noShowEntry = this.createEntry(
              `${playerName}: doesn't show hand`,
              HandLogEntryType.SHOWDOWN
            )
            entries.push(noShowEntry)
          }
        }
      }
    })

    // SUMMARYセクションを追加
    entries.push(...this.addSummarySection(event, entries))

    this.currentHand.entries.push(...entries)
    return entries
  }

  private handleUncalledBet(result: unknown, playerName: string): HandLogEntry[] {
    const entries: HandLogEntry[] = []

    // ハンドの最後のアグレッシブアクション（ベット/レイズ）を検索
    const lastAggressiveAction = this.currentHand!.entries
      .slice()
      .reverse()
      .find(e => e.type === HandLogEntryType.ACTION &&
        (e.text.includes(': bets ') || e.text.includes(': raises ')))

    if (lastAggressiveAction && lastAggressiveAction.text.includes(playerName)) {
      // 勝者のアクションから最終ベット額を抽出
      const betMatch = lastAggressiveAction.text.match(/raises (\d+) to (\d+)|bets (\d+)/)
      if (betMatch) {
        const winnerFinalBet = betMatch[2] ? parseInt(betMatch[2]) : parseInt(betMatch[3] || '0')

        // 最後のアグレッシブアクションがどのストリートで行われたかを判定
        const actionIndex = this.currentHand!.entries.indexOf(lastAggressiveAction)
        let streetStartIndex = 0

        // 現在のストリートがどこから始まるかを検索
        for (let i = actionIndex - 1; i >= 0; i--) {
          const entry = this.currentHand!.entries[i]
          if (entry && entry.type === HandLogEntryType.STREET) {
            streetStartIndex = i + 1
            break
          }
        }

        // 同じストリートでの相手の最大拠出額を検索
        let maxOpponentContribution = 0

        // 現在のストリートでのみ相手の拠出を検索
        for (let i = streetStartIndex; i <= actionIndex; i++) {
          const entry = this.currentHand!.entries[i]
          if (entry && entry.type === HandLogEntryType.ACTION && !entry.text.includes(playerName)) {
            // このストリートでの相手のアクションからベット額を抽出
            const opponentBetMatch = entry.text.match(/(?:calls|bets|raises \d+ to) (\d+)/)
            if (opponentBetMatch?.[1]) {
              const amount = parseInt(opponentBetMatch[1])
              maxOpponentContribution = Math.max(maxOpponentContribution, amount)
            }
          }
        }

        const uncalledAmount = Math.max(0, winnerFinalBet - maxOpponentContribution)
        const resultWithReward = result as { RewardChip?: number }
        const potContribution = (resultWithReward.RewardChip ?? 0) - uncalledAmount

        if (uncalledAmount > 0) {
          const uncalledEntry = this.createEntry(
            `Uncalled bet (${uncalledAmount}) returned to ${playerName}`,
            HandLogEntryType.SHOWDOWN
          )
          entries.push(uncalledEntry)

          // 争われたポット額で回収エントリを追加
          if (potContribution > 0) {
            const collectEntry = this.createEntry(
              `${playerName} collected ${potContribution} from pot`,
              HandLogEntryType.SHOWDOWN
            )
            entries.push(collectEntry)
          }

          // 必要に応じて"doesn't show hand"を追加
          const noShowEntry = this.createEntry(
            `${playerName}: doesn't show hand`,
            HandLogEntryType.SHOWDOWN
          )
          entries.push(noShowEntry)

          return entries // 通常の回収ロジックをスキップするため早期に返す
        }
      }
    }

    // 通常の回収エントリにフォールバック
    const resultWithReward = result as { RewardChip?: number }
    const collectEntry = this.createEntry(
      `${playerName} collected ${resultWithReward.RewardChip ?? 0} from pot`,
      HandLogEntryType.SHOWDOWN
    )
    entries.push(collectEntry)

    const noShowEntry = this.createEntry(
      `${playerName}: doesn't show hand`,
      HandLogEntryType.SHOWDOWN
    )
    entries.push(noShowEntry)

    return entries
  }

  private createEntry(text: string, type: HandLogEntryType): HandLogEntry {
    const timestamp = Date.now()
    // コンテンツとハンド内の位置に基づいたより決定的なIDを作成
    // これにより、同じイベントが複数回処理されたときの重複を防ぐ
    const handPosition = this.currentHand?.entries.length || 0
    const contentHash = this.hashString(text)
    const uniqueId = `hand_${this.currentHand?.handId || 'pending'}_pos_${handPosition}_${contentHash}`
    return {
      id: uniqueId,
      handId: this.currentHand?.handId,
      timestamp,
      text,
      type
    }
  }

  private hashString(str: string): string {
    // 一貫したIDを作成するためのシンプルなハッシュ関数
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // 32ビット整数に変換
    }
    return Math.abs(hash).toString(36)
  }

  private getPlayerName(userId: number): string {
    if (userId === -1) return 'Empty Seat'

    // まずコンテキストセッションから取得を試みる
    const playerInfo = this.context.session.players.get(userId)
    if (playerInfo) {
      return playerInfo.name
    }

    // コンテキストセッションにない場合、現在のハンドのプレイヤー名から試みる（利用可能な場合）
    if (this.currentHand?.playerNames.has(userId)) {
      return this.currentHand.playerNames.get(userId)!
    }

    // プレイヤーがまったく利用できない場合のみログを出力（異常なケース）
    if (this.context.session.players.size === 0) {
      console.warn(`[HandLogProcessor] No player names available in session for userId ${userId}`)
    }

    // 汎用名にフォールバック
    return `Player${userId}`
  }

  private getPlayerChips(event: ApiEvent<ApiType.EVT_DEAL>, seatIndex: number): number {
    if (event.Player?.SeatIndex === seatIndex) {
      return event.Player.Chip + event.Player.BetChip
    }

    const otherPlayer = event.OtherPlayers.find(p => p.SeatIndex === seatIndex)
    return otherPlayer ? otherPlayer.Chip + otherPlayer.BetChip : 0
  }

  private formatAction(event: ApiEvent<ApiType.EVT_ACTION>, playerName: string): string {
    const { ActionType: actionType, BetChip } = event

    const getPreviousBet = (): number => {
      if (!this.currentHand) return 0

      for (let i = this.currentHand.entries.length - 1; i >= 0; i--) {
        const entry = this.currentHand.entries[i]
        if (entry && entry.type === HandLogEntryType.ACTION) {
          const match = entry.text.match(/(?:bets|raises to|calls) (\d+)/)
          if (match?.[1]) {
            return parseInt(match[1])
          }
        }
      }

      const bbEntry = this.currentHand.entries.find(e =>
        e?.text.includes('posts big blind')
      )
      if (bbEntry?.text) {
        const bbMatch = bbEntry.text.match(/posts big blind (\d+)/)
        if (bbMatch?.[1]) return parseInt(bbMatch[1])
      }

      return 0
    }

    switch (actionType) {
      case ActionType.CHECK:
        return `${playerName}: checks`
      case ActionType.BET:
        return `${playerName}: bets ${BetChip}`
      case ActionType.FOLD:
        return `${playerName}: folds`
      case ActionType.CALL:
        return `${playerName}: calls ${BetChip}`
      case ActionType.RAISE: {
        const previousBet = getPreviousBet()
        const raiseAmount = BetChip - previousBet
        return `${playerName}: raises ${raiseAmount} to ${BetChip}`
      }
      case ActionType.ALL_IN: {
        const prevBet = getPreviousBet()
        if (prevBet > 0 && BetChip > prevBet) {
          const raiseAmt = BetChip - prevBet
          return `${playerName}: raises ${raiseAmt} to ${BetChip} and is all-in`
        } else if (prevBet > 0) {
          return `${playerName}: calls ${BetChip} and is all-in`
        } else {
          return `${playerName}: bets ${BetChip} and is all-in`
        }
      }
      default:
        return `${playerName}: unknown action (${actionType})`
    }
  }


  private getStreetName(phase: number): string {
    switch (phase) {
      case PhaseType.PREFLOP: return 'PREFLOP'
      case PhaseType.FLOP: return 'FLOP'
      case PhaseType.TURN: return 'TURN'
      case PhaseType.RIVER: return 'RIVER'
      case PhaseType.SHOWDOWN: return 'SHOWDOWN'
      default: return 'UNKNOWN'
    }
  }

  private addMissingStreets(finalCommunityCards: number[]): HandLogEntry[] {
    if (!this.currentHand) return []

    const entries: HandLogEntry[] = []

    // コミュニティカードを最終状態に更新
    this.communityCards = finalCommunityCards

    // すでに表示したストリートをチェック
    const hasFlop = this.currentHand.entries.some(e => e.text.includes('*** FLOP ***'))
    const hasTurn = this.currentHand.entries.some(e => e.text.includes('*** TURN ***'))
    const hasRiver = this.currentHand.entries.some(e => e.text.includes('*** RIVER ***'))

    // 不足しているストリートを追加
    if (!hasFlop && finalCommunityCards.length >= 3) {
      const flopCards = formatCards(finalCommunityCards.slice(0, 3))
      const flopEntry = this.createEntry(`*** FLOP *** [${flopCards}]`, HandLogEntryType.STREET)
      entries.push(flopEntry)
    }

    if (!hasTurn && finalCommunityCards.length >= 4) {
      const turnCardIdx = finalCommunityCards[3]
      if (turnCardIdx !== undefined) {
        const turnCard = formatCards([turnCardIdx])
        const flopCards = formatCards(finalCommunityCards.slice(0, 3))
        const turnEntry = this.createEntry(`*** TURN *** [${flopCards}] [${turnCard}]`, HandLogEntryType.STREET)
        entries.push(turnEntry)
      }
    }

    if (!hasRiver && finalCommunityCards.length >= 5) {
      const riverCardIdx = finalCommunityCards[4]
      if (riverCardIdx !== undefined) {
        const riverCard = formatCards([riverCardIdx])
        const boardCards = formatCards(finalCommunityCards.slice(0, 4))
        const riverEntry = this.createEntry(`*** RIVER *** [${boardCards}] [${riverCard}]`, HandLogEntryType.STREET)
        entries.push(riverEntry)
      }
    }

    return entries
  }

  private getHandDescription(rankType: number): string {
    const rankDescriptions: { [key: number]: string } = {
      [RankType.ROYAL_FLUSH]: 'a royal flush',
      [RankType.STRAIGHT_FLUSH]: 'a straight flush',
      [RankType.FOUR_OF_A_KIND]: 'four of a kind',
      [RankType.FULL_HOUSE]: 'a full house',
      [RankType.FLUSH]: 'a flush',
      [RankType.STRAIGHT]: 'a straight',
      [RankType.THREE_OF_A_KIND]: 'three of a kind',
      [RankType.TWO_PAIR]: 'two pair',
      [RankType.ONE_PAIR]: 'a pair',
      [RankType.HIGH_CARD]: 'high card',
      [RankType.NO_CALL]: 'no call',
      [RankType.SHOWDOWN_MUCK]: 'muck',
      [RankType.FOLD_OPEN]: 'fold'
    }
    return rankDescriptions[rankType] || 'unknown'
  }

  private addSummarySection(event: ApiEvent<ApiType.EVT_HAND_RESULTS>, handResultEntries: HandLogEntry[]): HandLogEntry[] {
    if (!this.currentHand) return []

    const entries: HandLogEntry[] = []

    const summaryEntry = this.createEntry('*** SUMMARY ***', HandLogEntryType.SUMMARY)
    entries.push(summaryEntry)

    const totalPot = event.Pot + event.SidePot.reduce((sum, pot) => sum + pot, 0)
    const rakeDisplay = ' | Rake 0'
    const potEntry = this.createEntry(`Total pot ${totalPot}${rakeDisplay}`, HandLogEntryType.SUMMARY)
    entries.push(potEntry)

    // ボード
    if (event.CommunityCards.length > 0) {
      const boardCards = formatCards(event.CommunityCards)
      const boardEntry = this.createEntry(`Board [${boardCards}]`, HandLogEntryType.SUMMARY)
      entries.push(boardEntry)
    }

    // プレイヤーのサマリー
    this.currentHand.seatUserIds.forEach((userId, seatIndex) => {
      if (userId === -1) return

      const playerName = this.getPlayerName(userId)
      const seatNum = seatIndex + 1
      let summary = `Seat ${seatNum}: ${playerName}`

      // ポジション情報を追加
      const dealEvent = this.currentHand!.entries.find(e => e.text.includes('is the button'))
      if (dealEvent && dealEvent.text.includes(`Seat #${seatNum} is the button`)) {
        summary += ' (button)'
      }

      // プレイヤーがスモールブラインドまたはビッグブラインドかチェック
      const sbEntry = this.currentHand!.entries.find(e =>
        e.text.includes(`${playerName}: posts small blind`)
      )
      const bbEntry = this.currentHand!.entries.find(e =>
        e.text.includes(`${playerName}: posts big blind`)
      )

      if (sbEntry && !summary.includes('(button)')) {
        summary += ' (small blind)'
      } else if (bbEntry && !summary.includes('(button)')) {
        summary += ' (big blind)'
      }

      // プレイヤーの結果を検索
      const result = event.Results.find(r => r.UserId === userId)

      // プレイヤーがフォールドしたかチェック
      const foldEntry = this.currentHand!.entries.find(e =>
        e.type === HandLogEntryType.ACTION &&
        e.text.includes(`${playerName}: folds`)
      )

      if (foldEntry) {
        // プレイヤーがフォールド - どのストリートかチェック
        const foldIndex = this.currentHand!.entries.indexOf(foldEntry)
        const beforeFlop = !this.currentHand!.entries.slice(0, foldIndex).some(e =>
          e.text.includes('*** FLOP ***')
        )

        if (beforeFlop) {
          // プレイヤーがチップを入れたかチェック
          const hasAction = this.currentHand!.entries.slice(0, foldIndex).some(e =>
            e.type === HandLogEntryType.ACTION &&
            e.text.includes(playerName) &&
            !e.text.includes('folds')
          )
          summary += hasAction ? ' folded before Flop' : " folded before Flop (didn't bet)"
        } else {
          summary += ' folded'
        }
      } else if (result) {
        // このハンドがショウダウンまで行ったかチェック
        const wentToShowdown = [...this.currentHand!.entries, ...handResultEntries].some(e => e.text.includes('*** SHOW DOWN ***'))

        if (result.RewardChip > 0) {
          // 勝者
          if (wentToShowdown) {
            // ショウダウンの勝者 - カードとハンドを表示
            const cards = formatCards(result.HoleCards)
            const handDesc = this.getHandDescription(result.RankType)
            summary += ` showed [${cards}] and won (${result.RewardChip}) with ${handDesc}`
          }
          // ショウダウン以外の勝利では追加テキスト不要（ポット回収はメインログに表示済み）
        } else {
          // ショウダウンの敗者
          if (wentToShowdown) {
            summary += ' mucked'
          }
        }
      }

      const summaryLineEntry = this.createEntry(summary, HandLogEntryType.SUMMARY)
      entries.push(summaryLineEntry)
    })

    return entries
  }
}
