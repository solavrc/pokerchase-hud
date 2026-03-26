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
  firstHandId?: number  // トーナメントIDとして使用（エクスポーター用）
}

export class HandLogProcessor {
  private currentHand: HandLogState | null = null
  private communityCards: number[] = []
  private context: HandLogContext
  private firstHandId: number | null = null

  constructor(context: HandLogContext) {
    this.context = context
    // 外部から firstHandId が渡された場合はそれを使用（エクスポーター用）
    if (context.firstHandId) {
      this.firstHandId = context.firstHandId
    }
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
    const jstDate = new Date(timestamp + 9 * 60 * 60 * 1000) // UTC → JST
    const jstTimestamp = `${jstDate.getUTCFullYear()}/${String(jstDate.getUTCMonth() + 1).padStart(2, '0')}/${String(jstDate.getUTCDate()).padStart(2, '0')} ${String(jstDate.getUTCHours()).padStart(2, '0')}:${String(jstDate.getUTCMinutes()).padStart(2, '0')}:${String(jstDate.getUTCSeconds()).padStart(2, '0')} JST`

    // キャッシュゲームかトーナメントかを判定
    const isCashGame = this.context.session.battleType !== undefined && [4, 5].includes(this.context.session.battleType)

    let headerText: string
    if (isCashGame) {
      headerText = `PokerStars Hand #pending: Hold'em No Limit (${event.Game.SmallBlind}/${event.Game.BigBlind}) - ${jstTimestamp}`
    } else {
      const sessionName = this.context.session.name || 'Unknown'
      // ブラインドレベルをローマ数字に変換
      const blindLevel = this.getBlindLevelRoman(event.Game.CurrentBlindLv)
      headerText = `PokerStars Hand #pending: Tournament #pending, ${sessionName} Hold'em No Limit - Level ${blindLevel} (${event.Game.SmallBlind}/${event.Game.BigBlind}) - ${jstTimestamp}`
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

    // BBアンテオールイン判定
    const bbSeat = event.Game.BigBlindSeat
    const bbUserId = bbSeat !== undefined ? event.SeatUserIds[bbSeat] : undefined
    const bbChipsAfterAnte = (bbUserId !== undefined && bbUserId !== -1)
      ? this.getPlayerChipsAfterAnte(event, bbSeat)
      : -1

    // BBがアンテでオールイン → BBを投稿できない
    // GTO Wizard等のツールはBB行必須のためパースエラーになるが、
    // トーナメントのハンド連続性を維持するため出力は行う

    if (ante > 0) {
      event.SeatUserIds.forEach((userId, seatIdx) => {
        if (userId !== -1) {
          const playerName = this.getPlayerName(userId)
          const chipsBeforeAnte = this.getPlayerChips(event, seatIdx)
          const actualAnte = Math.min(ante, chipsBeforeAnte)
          const playerChipsAfterAnte = this.getPlayerChipsAfterAnte(event, seatIdx)
          const allInSuffix = playerChipsAfterAnte === 0 ? ' and is all-in' : ''
          const anteEntry = this.createEntry(
            `${playerName}: posts the ante ${actualAnte}${allInSuffix}`,
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
      const sbChipsAfterAnte = this.getPlayerChipsAfterAnte(event, sbSeat)
      // SBがアンテでオールインしていなければSB投稿
      if (sbChipsAfterAnte > 0) {
        const sbChipsAfterSb = sbChipsAfterAnte - event.Game.SmallBlind
        const allInSuffix = sbChipsAfterSb <= 0 ? ' and is all-in' : ''
        const sbEntry = this.createEntry(
          `${this.getPlayerName(sbUserId)}: posts small blind ${Math.min(event.Game.SmallBlind, sbChipsAfterAnte)}${allInSuffix}`,
          HandLogEntryType.ACTION
        )
        entries.push(sbEntry)
      }
    }

    // ビッグブラインド
    if (bbUserId !== undefined && bbUserId !== -1 && bbChipsAfterAnte > 0) {
      const bbChipsAfterBb = bbChipsAfterAnte - event.Game.BigBlind
      const allInSuffix = bbChipsAfterBb <= 0 ? ' and is all-in' : ''
      const bbEntry = this.createEntry(
        `${this.getPlayerName(bbUserId)}: posts big blind ${Math.min(event.Game.BigBlind, bbChipsAfterAnte)}${allInSuffix}`,
        HandLogEntryType.ACTION
      )
      entries.push(bbEntry)
    }

    // ホールカード
    const cardsEntry = this.createEntry('*** HOLE CARDS ***', HandLogEntryType.STREET)
    entries.push(cardsEntry)

    // ヒーローのホールカードのみ表示（PokerStars準拠）
    // HoleCards が空 or Player が存在しない場合、heroは参加していない
    // （テーブル移動直後等）→ ハンド自体をスキップ
    const heroHoleCards = event.Player?.HoleCards
    if (!heroHoleCards || heroHoleCards.length === 0) {
      // Hero未参加ハンド → エントリを空にして終了
      this.currentHand = null
      return []
    }

    const heroUserId = event.SeatUserIds[event.Player!.SeatIndex]
    if (heroUserId !== undefined && heroUserId !== -1) {
      const heroName = this.getPlayerName(heroUserId)
      const dealtEntry = this.createEntry(
        `Dealt to ${heroName} [${formatCards(heroHoleCards)}]`,
        HandLogEntryType.CARDS
      )
      entries.push(dealtEntry)
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
        // For HandLogStream, we need to update the tournament ID as well
        if (this.context.session.battleType !== undefined && ![4, 5].includes(this.context.session.battleType)) {
          // Store first hand ID for tournament ID
          if (!this.firstHandId) {
            this.firstHandId = event.HandId
          }
          // Tournament format: update Hand # with current hand, Tournament # with first hand
          entry.text = entry.text.replace(/Hand #pending/, `Hand #${event.HandId}`)
            .replace(/Tournament #pending/, `Tournament #${this.firstHandId}`)
        } else {
          // Cash game: just update Hand #
          entry.text = entry.text.replace('#pending', `#${event.HandId}`)
        }
      }
    })

    // 不足しているコミュニティカードセクションを追加（オールインの場合）
    // EVT_HAND_RESULTS.CommunityCards はフルボードの場合と、
    // まだ配られていないカードのみの場合がある。
    // 既に蓄積されたカード(this.communityCards)とマージして完全なボードを構築する。
    let fullBoard: number[]
    if (event.CommunityCards.length === 0) {
      // イベントにカードがない → 蓄積されたカードをそのまま使う
      fullBoard = [...this.communityCards]
    } else if (event.CommunityCards.length >= 3 && this.communityCards.length <= event.CommunityCards.length) {
      // イベントのカードがフルボード（蓄積分以上）→ イベントのカードを使う
      fullBoard = [...event.CommunityCards]
    } else {
      // イベントのカードが蓄積分より少ない → 残りのカード（TURN/RIVERのみ等）
      // 蓄積されたカードに追加して完全なボードを構築
      fullBoard = [...this.communityCards, ...event.CommunityCards]
    }
    entries.push(...this.addMissingStreets(fullBoard))
    
    // コミュニティカードを完全なボードで更新
    this.communityCards = fullBoard

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
    } else {
      // ショウダウン時でも uncalled bet が発生するケース:
      // サイドポットで他プレイヤーが全員フォールドし、メインポットのオールインプレイヤーとのショウダウンが残る場合
      // 最後のアグレッシブアクション（bet/raise）のプレイヤーが、それに対してコールされていないか確認
      const lastAggressive = this.currentHand!.entries
        .slice()
        .reverse()
        .find(e => e.type === HandLogEntryType.ACTION &&
          (e.text.includes(': bets ') || e.text.includes(': raises ')))
      
      if (lastAggressive) {
        // 最後のbet/raise以降、同じストリート内でcallがあったか確認
        const lastAggIdx = this.currentHand!.entries.indexOf(lastAggressive)
        let hasCaller = false
        for (let i = lastAggIdx + 1; i < this.currentHand!.entries.length; i++) {
          const e = this.currentHand!.entries[i]
          if (e?.type === HandLogEntryType.ACTION && e.text.includes(': calls ')) {
            hasCaller = true
            break
          }
        }
        
        if (!hasCaller) {
          // コールされていない → uncalled bet を返す
          const betMatch = lastAggressive.text.match(/(?:bets|raises \d+ to) (\d+)/)
          const betterName = lastAggressive.text.split(':')[0]!
          if (betMatch?.[1] && betterName) {
            // 同じストリートでの前のベット額を検出
            let prevBet = 0
            let streetStart = 0
            for (let i = lastAggIdx - 1; i >= 0; i--) {
              const e = this.currentHand!.entries[i]
              if (e?.type === HandLogEntryType.STREET) {
                streetStart = i
                break
              }
            }
            for (let i = streetStart; i < lastAggIdx; i++) {
              const e = this.currentHand!.entries[i]
              if (e?.type === HandLogEntryType.ACTION && !e.text.includes(betterName)) {
                const m = e.text.match(/(?:bets|raises \d+ to|calls) (\d+)/)
                if (m?.[1]) prevBet = Math.max(prevBet, parseInt(m[1]))
              }
            }
            const betAmount = parseInt(betMatch[1])
            const uncalledAmount = betAmount - prevBet
            if (uncalledAmount > 0) {
              const uncalledEntry = this.createEntry(
                `Uncalled bet (${uncalledAmount}) returned to ${betterName}`,
                HandLogEntryType.SHOWDOWN
              )
              entries.push(uncalledEntry)
            }
          }
        }
      }
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

  /**
   * アンテ支払い後のプレイヤーのチップ数を取得
   * EVT_DEAL時点のChipはブラインド・アンテ支払い後の値なので、
   * ブラインド分を戻してアンテのみ支払い後の状態を計算する
   */
  private getPlayerChipsAfterAnte(event: ApiEvent<ApiType.EVT_DEAL>, seatIndex: number): number {
    if (event.Player?.SeatIndex === seatIndex) {
      // Player.Chip はアンテ+ブラインド支払い後の値
      // BetChip にブラインド額が入っている → Chip + BetChip がアンテ支払い後
      return event.Player.Chip + event.Player.BetChip
    }

    const otherPlayer = event.OtherPlayers.find(p => p.SeatIndex === seatIndex)
    if (otherPlayer) {
      // OtherPlayers.Chip + BetChip がアンテ支払い後
      return otherPlayer.Chip + otherPlayer.BetChip
    }
    return 0
  }

  private getPlayerChips(event: ApiEvent<ApiType.EVT_DEAL>, seatIndex: number): number {
    const ante = event.Game.Ante || 0
    
    // Chip + BetChip はアンテ(+ブラインド)支払い後の値
    // アンテ投入前のチップ = chipsAfterAnte + 実際のアンテ投入額
    const chipsAfterAnte = this.getPlayerChipsAfterAnte(event, seatIndex)
    
    if (chipsAfterAnte > 0) {
      // アンテ全額投入可能だった → Chip + BetChip + Ante
      return chipsAfterAnte + ante
    }
    
    // chipsAfterAnte == 0: アンテでオールインまたはショートオールイン
    // 実際の投入額を Progress.Pot（メインポット）から推定
    // メインポットはショートスタックの投入額 × 参加人数
    const activePlayers = event.SeatUserIds.filter(id => id !== -1).length
    if (activePlayers > 0 && event.Progress?.Pot > 0) {
      const perPlayerMainPot = Math.floor(event.Progress.Pot / activePlayers)
      if (perPlayerMainPot <= ante) {
        return perPlayerMainPot
      }
    }
    
    // フォールバック
    return ante
  }

  private formatAction(event: ApiEvent<ApiType.EVT_ACTION>, playerName: string): string {
    const { ActionType: actionType, BetChip } = event

    // プレイヤーが現在のストリートで既にベットした金額を取得
    /** プレイヤーの現在のストリートでの累積ベット額を取得 */
    const getPlayerPreviousBet = (player: string): number => {
      if (!this.currentHand) return 0
      
      // 現在のストリートでこのプレイヤーの全アクション金額を累積
      // raises to Y = ストリート内トータルY、calls X = 追加額X
      let total = 0
      let isPostflop = false
      let foundRaiseOrBet = false
      
      for (let i = this.currentHand.entries.length - 1; i >= 0; i--) {
        const entry = this.currentHand.entries[i]
        if (!entry) continue
        
        if (entry.type === HandLogEntryType.STREET) {
          if (entry.text.includes('*** FLOP ***') || entry.text.includes('*** TURN ***') || entry.text.includes('*** RIVER ***')) {
            isPostflop = true
          }
          break
        }
        
        if (entry.type === HandLogEntryType.ACTION && entry.text.includes(player)) {
          // calls X → 追加額を累積
          const callMatch = entry.text.match(/calls (\d+)/)
          if (callMatch?.[1]) {
            total += parseInt(callMatch[1])
            continue
          }
          // raises X to Y → Yがストリート内トータル（以前のcallsも含む）
          const raiseMatch = entry.text.match(/raises \d+ to (\d+)/)
          if (raiseMatch?.[1]) {
            total = parseInt(raiseMatch[1]) + total // raise to Yが基準 + その後のcalls
            foundRaiseOrBet = true
            break // raise以前のアクションは含まれている
          }
          // bets X → トータルはX
          const betMatch = entry.text.match(/bets (\d+)/)
          if (betMatch?.[1]) {
            total = parseInt(betMatch[1]) + total
            foundRaiseOrBet = true
            break
          }
        }
      }
      
      // ポストフロップではストリート内のみ
      if (isPostflop) return total
      
      // プリフロップ: raise/betが見つかった場合はそれが基準（ブラインド含む）
      if (foundRaiseOrBet) return total
      
      // プリフロップ: callsのみの場合、BB/SBポスト額を加算
      const blindEntry = this.currentHand.entries.find(e =>
        e?.text.includes(player) && 
        (e.text.includes('posts small blind') || e.text.includes('posts big blind'))
      )
      if (blindEntry?.text) {
        const blindMatch = blindEntry.text.match(/posts (?:small|big) blind (\d+)/)
        if (blindMatch?.[1]) total += parseInt(blindMatch[1])
      }
      
      return total
    }

    const getPreviousBet = (): number => {
      if (!this.currentHand) return 0

      // 現在のストリートで最後のベット/レイズ額を探す
      let isPostflop = false
      for (let i = this.currentHand.entries.length - 1; i >= 0; i--) {
        const entry = this.currentHand.entries[i]
        if (!entry) continue
        
        if (entry.type === HandLogEntryType.STREET) {
          if (entry.text.includes('*** FLOP ***') || entry.text.includes('*** TURN ***') || entry.text.includes('*** RIVER ***')) {
            isPostflop = true
          }
          break
        }
        
        if (entry.type === HandLogEntryType.ACTION) {
          const betMatch = entry.text.match(/(?:bets|raises \d+ to) (\d+)/)
          if (betMatch?.[1]) {
            return parseInt(betMatch[1])
          }
        }
      }

      // ポストフロップではストリート内のベットのみ参照
      if (isPostflop) return 0

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
      case ActionType.CALL: {
        // PS format: calls shows ADDITIONAL amount (total - already posted)
        const playerPrevBetForCall = getPlayerPreviousBet(playerName)
        const callAmount = BetChip - playerPrevBetForCall
        // callAmount が 0 以下の場合 → check として扱う
        if (callAmount <= 0) {
          return `${playerName}: checks`
        }
        return `${playerName}: calls ${callAmount}`
      }
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
          const playerPrevBetAllIn = getPlayerPreviousBet(playerName)
          const callAmtAllIn = BetChip - playerPrevBetAllIn
          return `${playerName}: calls ${callAmtAllIn} and is all-in`
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
    
    const isCashGame = this.context.session.battleType !== undefined && [4, 5].includes(this.context.session.battleType)
    const potText = isCashGame ? `Total pot ${totalPot} | Rake 0` : `Total pot ${totalPot}`
    const potEntry = this.createEntry(potText, HandLogEntryType.SUMMARY)
    entries.push(potEntry)

    // ボード
    // this.communityCards は handleHandResultsEvent 内で既にフルボードに更新済み
    if (this.communityCards.length > 0) {
      const boardCards = formatCards(this.communityCards)
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
        
        // フォールド前に最後に出現したストリートを特定
        let foldStreet: string | null = null
        for (let i = foldIndex - 1; i >= 0; i--) {
          const e = this.currentHand!.entries[i]
          if (e?.type === HandLogEntryType.STREET) {
            if (e.text.includes('*** FLOP ***')) foldStreet = 'Flop'
            else if (e.text.includes('*** TURN ***')) foldStreet = 'Turn'
            else if (e.text.includes('*** RIVER ***')) foldStreet = 'River'
            break
          }
        }

        if (!foldStreet) {
          // プリフロップでフォールド
          const postedBlind = sbEntry || bbEntry
          
          const hasAction = this.currentHand!.entries.slice(0, foldIndex).some(e =>
            e.type === HandLogEntryType.ACTION &&
            e.text.includes(playerName) &&
            !e.text.includes('folds') &&
            !e.text.includes('posts the ante') &&
            !e.text.includes('posts small blind') &&
            !e.text.includes('posts big blind')
          )
          
          summary += (hasAction || postedBlind) ? ' folded before Flop' : " folded before Flop (didn't bet)"
        } else {
          summary += ` folded on the ${foldStreet}`
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
      } else {
        // フォールドエントリもResultsにも存在しないプレイヤー
        // タイムアウト/切断等による自動フォールド（EVT_ACTIONが送信されないケース）
        // アクション記録の有無を確認
        const hasAnyAction = this.currentHand!.entries.some(e =>
          e.type === HandLogEntryType.ACTION &&
          e.text.startsWith(`${playerName}: `) &&
          !e.text.includes('posts the ante') &&
          !e.text.includes('posts small blind') &&
          !e.text.includes('posts big blind')
        )
        
        if (!hasAnyAction) {
          // アクション未記録 → プリフロップで自動フォールド扱い
          const postedBlind = sbEntry || bbEntry
          summary += postedBlind ? ' folded before Flop' : " folded before Flop (didn't bet)"
        }
      }

      const summaryLineEntry = this.createEntry(summary, HandLogEntryType.SUMMARY)
      entries.push(summaryLineEntry)
    })

    return entries
  }
}
