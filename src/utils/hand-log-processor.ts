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

// 定数定義
const MAX_SEATS = 6 // PokerChaseの6人テーブル

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
  private firstHandId: number | null = null

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

  /**
   * ハンド固有の状態をリセット（セッションレベルの状態は保持）
   */
  resetHandState(): void {
    this.currentHand = null
    this.communityCards = []
    // firstHandId は保持（トーナメントID用）
  }

  /**
   * ブラインドレベルをローマ数字に変換
   */
  private getBlindLevelRoman(level: number): string {
    const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
      'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX']
    return romans[level] || `${level + 1}`
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
    const utcTimestamp = new Date(timestamp).toISOString().replace('T', ' ').substring(0, 19)

    // キャッシュゲームかトーナメントかを判定
    const isCashGame = this.context.session.battleType !== undefined && [4, 5].includes(this.context.session.battleType)

    let headerText: string
    if (isCashGame) {
      headerText = `Poker Hand #pending: Hold'em No Limit ($${event.Game.SmallBlind}/$${event.Game.BigBlind} USD) - ${utcTimestamp}`
    } else {
      const sessionName = this.context.session.name || 'Unknown'
      // ブラインドレベルをローマ数字に変換
      const blindLevel = this.getBlindLevelRoman(event.Game.CurrentBlindLv)
      headerText = `Poker Game #pending: Tournament #pending, ${sessionName} Hold'em No Limit - Level ${blindLevel} (${event.Game.SmallBlind}/${event.Game.BigBlind}) - ${utcTimestamp}`
    }

    const headerEntry = this.createEntry(headerText, HandLogEntryType.HEADER)
    entries.push(headerEntry)

    const tableEntry = this.createEntry(
      `Table '${this.context.session.name || 'Unknown'}' ${MAX_SEATS}-max Seat #${event.Game.ButtonSeat + 1} is the button`,
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
    const cardsEntry = this.createEntry('*** HOLE CARDS ***', HandLogEntryType.STREET)
    entries.push(cardsEntry)

    // 全プレイヤーに "Dealt to" を表示
    event.SeatUserIds.forEach((userId, seatIndex) => {
      if (userId !== -1) {
        const playerName = this.getPlayerName(userId)
        let dealtEntry: HandLogEntry

        // Heroのカードを表示
        if (event.Player?.SeatIndex === seatIndex && event.Player?.HoleCards) {
          dealtEntry = this.createEntry(
            `Dealt to ${playerName} [${formatCards(event.Player.HoleCards)}]`,
            HandLogEntryType.CARDS
          )
        } else {
          // 他のプレイヤーは "Dealt to" のみ
          dealtEntry = this.createEntry(
            `Dealt to ${playerName}`,
            HandLogEntryType.CARDS
          )
        }
        entries.push(dealtEntry)
      }
    })

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
        // For HandLogStream, we need to update the tournament ID as well
        if (this.context.session.battleType !== undefined && ![4, 5].includes(this.context.session.battleType)) {
          // Store first hand ID for tournament ID
          if (!this.firstHandId) {
            this.firstHandId = event.HandId
          }
          // Tournament format: update Game # with current hand, Tournament # with first hand
          entry.text = entry.text.replace(/Game #pending/, `Game #${event.HandId}`)
            .replace(/Tournament #pending/, `Tournament #${this.firstHandId}`)
        } else {
          // Cash game: just update Game #
          entry.text = entry.text.replace('#pending', `#${event.HandId}`)
        }
      }
    })

    // 不足しているコミュニティカードセクションを追加（オールインの場合）
    // Use accumulated cards if event has empty cards
    const cardsForMissingStreets = event.CommunityCards.length > 0 ? event.CommunityCards : this.communityCards
    entries.push(...this.addMissingStreets(cardsForMissingStreets))

    // Update community cards if event has them
    // Don't overwrite with empty array - some events have empty CommunityCards
    if (event.CommunityCards.length > 0) {
      this.communityCards = event.CommunityCards
    }

    // ショウダウンに参加したプレイヤー（カードを見せた/マックした両方）
    const showdownParticipants = event.Results.filter(r => {
      // Include players who show cards OR who reached showdown (SHOWDOWN_MUCK)
      const hasValidCards = r.HoleCards && r.HoleCards.length > 0 && r.HoleCards[0] !== -1
      const reachedShowdown = r.RankType === RankType.SHOWDOWN_MUCK
      // Exclude NO_CALL wins (e.g., BB wins when everyone folds)
      const isNoCallWin = r.RankType === RankType.NO_CALL
      // Also check if they have a reward chip (winner) but empty cards (rare case)
      const wonWithoutShowingCards = r.RewardChip > 0 && (!r.HoleCards || r.HoleCards.length === 0) && !isNoCallWin
      return hasValidCards || reachedShowdown || wonWithoutShowingCards
    })

    // Handle uncalled bets BEFORE showdown
    const wentToShowdown = showdownParticipants.length > 0

    if (!wentToShowdown) {
      // For non-showdown wins, handle uncalled bets first
      event.Results.forEach(result => {
        if (result.RewardChip > 0) {
          const playerName = this.getPlayerName(result.UserId)
          const uncalledEntries = this.handleUncalledBet(result, playerName)
          entries.push(...uncalledEntries)
        }
      })
    }

    if (showdownParticipants.length > 0) {
      const showdownEntry = this.createEntry('*** SHOW DOWN ***', HandLogEntryType.SHOWDOWN)
      entries.push(showdownEntry)

      // ショウダウンのプレイヤーのカードを表示
      // アクティブプレイヤー順（最後にアクションしたプレイヤーから）
      const showdownOrder = this.getShowdownOrder(event.Results, showdownParticipants)


      showdownOrder.forEach(result => {
        const playerName = this.getPlayerName(result.UserId)

        // プレイヤーが表示する有効なホールカードを持っているかチェック
        const hasValidCards = result.HoleCards &&
          result.HoleCards.length > 0 &&
          result.HoleCards[0] !== -1

        if (hasValidCards) {
          const cards = formatCards(result.HoleCards)
          const handDesc = this.getHandDescription(result.RankType, result.Hands)
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

    // Handle pot collection for showdown winners and tournament finish positions
    event.Results.forEach(result => {
      if (result.RewardChip > 0 && wentToShowdown) {
        const playerName = this.getPlayerName(result.UserId)
        const collectEntry = this.createEntry(
          `${playerName} collected ${result.RewardChip} from pot`,
          HandLogEntryType.SHOWDOWN
        )
        entries.push(collectEntry)
      }

      // Check if player finished the tournament
      if (result.Ranking > 0 && result.RewardChip === 0) {
        const playerName = this.getPlayerName(result.UserId)
        const rankText = this.getRankingText(result.Ranking)
        const finishEntry = this.createEntry(
          `${playerName} finished the tournament in ${rankText} place`,
          HandLogEntryType.SHOWDOWN
        )
        entries.push(finishEntry)
      }
    })

    // SUMMARYセクションを追加
    entries.push(...this.addSummarySection(event, entries))

    // ハンド終了後に2行の空白行を追加
    entries.push(this.createEntry('', HandLogEntryType.SUMMARY), this.createEntry('', HandLogEntryType.SUMMARY))

    this.currentHand.entries.push(...entries)
    return entries
  }

  private handleUncalledBet(result: unknown, playerName: string): HandLogEntry[] {
    const entries: HandLogEntry[] = []

    // Special case: BB wins without anyone calling (everyone folded to BB)
    // Check if winner posted BB and no one called
    const bbEntry = this.currentHand!.entries.find(e =>
      e.type === HandLogEntryType.ACTION &&
      e.text.includes(playerName) &&
      e.text.includes('posts big blind')
    )

    if (bbEntry) {
      // Extract BB amount
      const bbMatch = bbEntry.text.match(/posts big blind (\d+)/)
      const bbAmount = bbMatch?.[1] ? parseInt(bbMatch[1]) : 0

      // Check if anyone called or raised the BB
      let maxOpponentBet = 0
      let foundRaiseOrCall = false

      // Look for any calls or raises after the BB was posted
      const bbIndex = this.currentHand!.entries.indexOf(bbEntry)
      for (let i = bbIndex + 1; i < this.currentHand!.entries.length; i++) {
        const entry = this.currentHand!.entries[i]
        if (entry && entry.type === HandLogEntryType.ACTION) {
          if (entry.text.includes(': calls ') || entry.text.includes(': raises ')) {
            foundRaiseOrCall = true
            const match = entry.text.match(/calls (\d+)|raises \d+ to (\d+)/)
            if (match) {
              const amount = parseInt(match[1] || match[2] || '0')
              maxOpponentBet = Math.max(maxOpponentBet, amount)
            }
          }
        }
      }

      // If no one called or raised, only SB amount was contested
      if (!foundRaiseOrCall) {
        // Find SB amount
        const sbEntry = this.currentHand!.entries.find(e =>
          e.type === HandLogEntryType.ACTION &&
          e.text.includes('posts small blind')
        )
        const sbMatch = sbEntry?.text.match(/posts small blind (\d+)/)
        const sbAmount = sbMatch?.[1] ? parseInt(sbMatch[1]) : 0

        if (sbAmount > 0 && bbAmount > sbAmount) {
          const uncalledAmount = bbAmount - sbAmount
          const resultWithReward = result as { RewardChip?: number }
          const potContribution = (resultWithReward.RewardChip ?? 0) - uncalledAmount

          const uncalledEntry = this.createEntry(
            `Uncalled bet (${uncalledAmount}) returned to ${playerName}`,
            HandLogEntryType.SHOWDOWN
          )
          entries.push(uncalledEntry)

          if (potContribution > 0) {
            const collectEntry = this.createEntry(
              `${playerName} collected ${potContribution} from pot`,
              HandLogEntryType.SHOWDOWN
            )
            entries.push(collectEntry)
          }

          const noShowEntry = this.createEntry(
            `${playerName}: doesn't show hand `,
            HandLogEntryType.SHOWDOWN
          )
          entries.push(noShowEntry)

          return entries
        }
      }
    }

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
            `${playerName}: doesn't show hand `,
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


  private getShowdownOrder(_results: any[], playersWithCards: any[]): any[] {
    // Get last aggressive action from current hand entries
    let lastAggressorUserId: number | null = null

    // Find the last street marker (RIVER, TURN, FLOP, or start of hand)
    let lastStreetIndex = -1
    for (let i = this.currentHand!.entries.length - 1; i >= 0; i--) {
      const entry = this.currentHand!.entries[i]
      if (entry?.type === HandLogEntryType.STREET || entry?.type === HandLogEntryType.CARDS) {
        lastStreetIndex = i
        break
      }
    }

    // Find last bet/raise action on the final street only
    for (let i = this.currentHand!.entries.length - 1; i > lastStreetIndex; i--) {
      const entry = this.currentHand!.entries[i]
      if (entry?.type === HandLogEntryType.ACTION &&
        entry.text && (entry.text.includes(': bets ') || entry.text.includes(': raises '))) {
        // Extract player name from action
        const playerName = entry.text.split(':')[0]
        // Find userId from playerName
        for (const [userId, info] of this.context.session.players) {
          if (info.name === playerName) {
            lastAggressorUserId = userId
            break
          }
        }
        break
      }
    }


    // If there was a last aggressor, they show first
    if (lastAggressorUserId !== null) {
      // Sort by putting last aggressor first, then by position
      const lastAggressorIndex = this.currentHand!.seatUserIds.indexOf(lastAggressorUserId)
      return playersWithCards.sort((a, b) => {
        const aIndex = this.currentHand!.seatUserIds.indexOf(a.UserId)
        const bIndex = this.currentHand!.seatUserIds.indexOf(b.UserId)

        // Last aggressor goes first
        if (a.UserId === lastAggressorUserId) return -1
        if (b.UserId === lastAggressorUserId) return 1

        // Then by position order starting after the aggressor
        const aPos = (aIndex - lastAggressorIndex + MAX_SEATS) % MAX_SEATS
        const bPos = (bIndex - lastAggressorIndex + MAX_SEATS) % MAX_SEATS
        return aPos - bPos
      })
    } else {
      // If no aggressor (all checks), use position order starting from BB
      // Find the BB position (they act first postflop)
      let bbSeatIndex = 1 // Default BB position in ${MAX_SEATS}-max

      // Find actual BB from preflop actions
      for (const entry of this.currentHand!.entries) {
        if (entry.type === HandLogEntryType.ACTION && entry.text && entry.text.includes(': posts big blind')) {
          const colonIndex = entry.text.indexOf(':')
          if (colonIndex > 0) {
            const playerName = entry.text.substring(0, colonIndex).trim()
            for (let i = 0; i < this.currentHand!.seatUserIds.length; i++) {
              const userId = this.currentHand!.seatUserIds[i]
              if (userId && userId !== -1) {
                const currentPlayerName = this.getPlayerName(userId).trim()
                if (currentPlayerName === playerName) {
                  bbSeatIndex = i
                  break
                }
              }
            }
          }
          break
        }
      }

      return playersWithCards.sort((a, b) => {
        const aIndex = this.currentHand!.seatUserIds.indexOf(a.UserId)
        const bIndex = this.currentHand!.seatUserIds.indexOf(b.UserId)

        // Calculate position relative to BB (BB shows first)
        const aPos = (aIndex - bbSeatIndex + MAX_SEATS) % MAX_SEATS
        const bPos = (bIndex - bbSeatIndex + MAX_SEATS) % MAX_SEATS

        return aPos - bPos
      })
    }
  }

  private getRankingText(ranking: number): string {
    // Convert numeric ranking to ordinal text
    if (ranking === 1) return '1st'
    if (ranking === 2) return '2nd'
    if (ranking === 3) return '3rd'
    return ranking + 'th'
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
    const ante = event.Game.Ante || 0

    if (event.Player?.SeatIndex === seatIndex) {
      // Add ante back to show chip count before ante was posted
      return event.Player.Chip + event.Player.BetChip + ante
    }

    const otherPlayer = event.OtherPlayers.find(p => p.SeatIndex === seatIndex)
    if (otherPlayer) {
      // For SB/BB players, need to add back their blinds as well
      let chips = otherPlayer.Chip + otherPlayer.BetChip + ante
      return chips
    }
    return 0
  }

  private formatAction(event: ApiEvent<ApiType.EVT_ACTION>, playerName: string): string {
    const { ActionType: actionType, BetChip } = event

    // プレイヤーが現在のストリートで既にベットした金額を取得
    const getPlayerPreviousBet = (player: string): number => {
      if (!this.currentHand) return 0

      // 現在のストリートでこのプレイヤーの最後のベット/レイズ/コールを探す
      for (let i = this.currentHand.entries.length - 1; i >= 0; i--) {
        const entry = this.currentHand.entries[i]
        if (!entry) continue

        // ストリートマーカーに到達したら終了
        if (entry.type === HandLogEntryType.STREET) {
          break
        }

        if (entry.type === HandLogEntryType.ACTION && entry.text.includes(player)) {
          // このプレイヤーのベット/レイズ/コールの金額を取得
          const match = entry.text.match(/(?:bets|raises \d+ to|calls) (\d+)/)
          if (match?.[1]) {
            return parseInt(match[1])
          }
        }
      }

      // プリフロップでBB/SBをポストした場合
      const blindEntry = this.currentHand.entries.find(e =>
        e?.text.includes(player) &&
        (e.text.includes('posts small blind') || e.text.includes('posts big blind'))
      )
      if (blindEntry?.text) {
        const blindMatch = blindEntry.text.match(/posts (?:small|big) blind (\d+)/)
        if (blindMatch?.[1]) return parseInt(blindMatch[1])
      }

      return 0
    }

    const getPreviousBet = (): number => {
      if (!this.currentHand) return 0

      // 現在のストリートで最後のベット/レイズ額を探す
      // ストリートマーカーを見つけたら検索を停止
      for (let i = this.currentHand.entries.length - 1; i >= 0; i--) {
        const entry = this.currentHand.entries[i]
        if (!entry) continue

        // ストリートマーカーに到達したら、このストリートではベットがない
        if (entry.type === HandLogEntryType.STREET) {
          break
        }

        if (entry.type === HandLogEntryType.ACTION) {
          // betsまたはraises ... to XXXのパターンを探す
          const betMatch = entry.text.match(/(?:bets|raises \d+ to) (\d+)/)
          if (betMatch?.[1]) {
            return parseInt(betMatch[1])
          }
        }
      }

      // プリフロップの場合、BBを返す
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
        } else if (prevBet > 0 && BetChip === prevBet) {
          // 前のベットと同額の場合、差額を表示
          const playerPrevBet = getPlayerPreviousBet(playerName)
          const callAmount = BetChip - playerPrevBet
          return `${playerName}: calls ${callAmount} and is all-in`
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

  private getHandDescription(rankType: number, hands: number[] | undefined): string {
    // カードインデックスからランクを取得するヘルパー関数
    const getCardRankPlural = (cardIndex: number): string => {
      const rank = Math.floor(cardIndex / 4)
      const ranks = ['Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces']
      return ranks[rank] || 'Unknown'
    }

    switch (rankType) {
      case RankType.ROYAL_FLUSH:
        return 'a royal flush'
      case RankType.STRAIGHT_FLUSH:
        return 'a straight flush'
      case RankType.FOUR_OF_A_KIND:
        if (hands && hands.length > 0 && hands[0] !== undefined) {
          return `four of a kind, ${getCardRankPlural(hands[0])}`
        }
        return 'four of a kind'
      case RankType.FULL_HOUSE:
        return 'a full house'
      case RankType.FLUSH:
        return 'a flush'
      case RankType.STRAIGHT:
        return 'a straight'
      case RankType.THREE_OF_A_KIND:
        if (hands && hands.length > 0 && hands[0] !== undefined) {
          return `three of a kind, ${getCardRankPlural(hands[0])}`
        }
        return 'three of a kind'
      case RankType.TWO_PAIR:
        if (hands && hands.length >= 3 && hands[0] !== undefined && hands[2] !== undefined) {
          const rank1 = getCardRankPlural(hands[0])
          const rank2 = getCardRankPlural(hands[2])
          return `two pair, ${rank1} and ${rank2}`
        }
        return 'two pair'
      case RankType.ONE_PAIR:
        if (hands && hands.length > 0 && hands[0] !== undefined) {
          return `a pair of ${getCardRankPlural(hands[0])}`
        }
        return 'a pair'
      case RankType.HIGH_CARD:
        return 'high card'
      case RankType.NO_CALL:
        return 'no call'
      case RankType.SHOWDOWN_MUCK:
        return 'muck'
      case RankType.FOLD_OPEN:
        return 'fold'
      default:
        return 'unknown'
    }
  }

  private addSummarySection(event: ApiEvent<ApiType.EVT_HAND_RESULTS>, handResultEntries: HandLogEntry[]): HandLogEntry[] {
    if (!this.currentHand) return []

    const entries: HandLogEntry[] = []

    const summaryEntry = this.createEntry('*** SUMMARY ***', HandLogEntryType.SUMMARY)
    entries.push(summaryEntry)

    // Calculate total pot, accounting for uncalled bets
    let totalPot = event.Pot + event.SidePot.reduce((sum, pot) => sum + pot, 0)

    // Check if there was an uncalled bet in the hand result entries
    const uncalledBetEntry = handResultEntries.find(e =>
      e.text.includes('Uncalled bet (') && e.text.includes(') returned to')
    )

    if (uncalledBetEntry) {
      // Extract uncalled amount and subtract from total pot
      const uncalledMatch = uncalledBetEntry.text.match(/Uncalled bet \((\d+)\)/)
      if (uncalledMatch?.[1]) {
        const uncalledAmount = parseInt(uncalledMatch[1])
        totalPot -= uncalledAmount
      }
    }

    const potEntry = this.createEntry(`Total pot ${totalPot}`, HandLogEntryType.SUMMARY)
    entries.push(potEntry)

    // ボード
    // Use accumulated community cards if event doesn't have them (e.g., when all-in occurred early)
    const finalCommunityCards = event.CommunityCards.length > 0 ? event.CommunityCards : this.communityCards
    if (finalCommunityCards.length > 0) {
      const boardCards = formatCards(finalCommunityCards)
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
          // プレイヤーがSBかBBをポストしたかチェック
          const postedBlind = sbEntry || bbEntry

          // プレイヤーがチップを入れたかチェック（ブラインドポストを除く）
          const hasAction = this.currentHand!.entries.slice(0, foldIndex).some(e =>
            e.type === HandLogEntryType.ACTION &&
            e.text.includes(playerName) &&
            !e.text.includes('folds') &&
            !e.text.includes('posts the ante') &&
            !e.text.includes('posts small blind') &&
            !e.text.includes('posts big blind')
          )

          // SB/BBをポストした、または他のアクションがある場合は"didn't bet"を付けない
          summary += (hasAction || postedBlind) ? ' folded before Flop' : " folded before Flop (didn't bet)"
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
            const handDesc = this.getHandDescription(result.RankType, result.Hands)
            summary += ` showed [${cards}] and won (${result.RewardChip}) with ${handDesc}`
          } else {
            // ショウダウン以外の勝利 - "collected" を表示
            // Check if there was an uncalled bet for this player
            const uncalledBetEntry = [...this.currentHand!.entries, ...handResultEntries].find(e =>
              e.text.includes('Uncalled bet (') &&
              e.text.includes(`) returned to ${playerName}`)
            )

            let collectedAmount = result.RewardChip
            if (uncalledBetEntry) {
              // Extract uncalled amount to show the actual contested pot
              const uncalledMatch = uncalledBetEntry.text.match(/Uncalled bet \((\d+)\)/)
              if (uncalledMatch?.[1]) {
                const uncalledAmount = parseInt(uncalledMatch[1])
                collectedAmount = result.RewardChip - uncalledAmount
              }
            }

            summary += ` collected (${collectedAmount})`
          }
        } else {
          // ショウダウンの敗者
          if (wentToShowdown && result.HoleCards && result.HoleCards.length > 0 && result.HoleCards[0] !== -1) {
            // カードを見せていた場合
            const cards = formatCards(result.HoleCards)
            const handDesc = this.getHandDescription(result.RankType, result.Hands)
            summary += ` showed [${cards}] and lost with ${handDesc}`
          } else if (wentToShowdown) {
            // ショウダウンに参加したがカードを見せなかった
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
