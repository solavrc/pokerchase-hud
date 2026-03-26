#!/usr/bin/env npx tsx
/**
 * GTO Wizard検証用: 特定ハンドのPokerStars形式出力を生成
 *
 * Usage:
 *   npx tsx scripts/verify-hands.ts <ndjson_file> [hand_id...]
 *
 * Example:
 *   npx tsx scripts/verify-hands.ts pokerchase_raw_data_2026-03-25T08-19-31-398Z.ndjson
 *
 * 引数なしの場合、今回発見されたエッジケースのハンドIDを使用
 */

import * as fs from 'fs'
import * as readline from 'readline'
import { HandLogProcessor, HandLogContext } from '../src/utils/hand-log-processor'
import { DEFAULT_HAND_LOG_CONFIG } from '../src/types/hand-log'
import { ApiType, isApiEventType } from '../src/types/api'
import type { ApiEvent, Session } from '../src/types'

// 今回検出されたエッジケースのハンドID（パターン別）
const DEFAULT_HAND_IDS = [
  435351195,  // Hero未参加（テーブル移動直後、HoleCards空）
  428238733,  // アンテオールイン + ショウダウン時uncalled bet
  421667480,  // コミュニティカード部分配信（FLOP配信済み、TURN/RIVERのみresultsに）
  306397527,  // SB部分投入（チップ < SB額）
  306234673,  // BB部分投入（チップ < BB額）
]

// 時間バッファ定数
const TIME_BUFFER_MS = 300000    // 5 minutes before
const POST_HAND_BUFFER_MS = 30000 // 30 seconds after

interface HandData {
  handId: number
  events: ApiEvent[]
  playerMap: Map<number, { name: string; rank: string }>
  battleType?: number
  sessionName?: string
  approxTimestamp: number
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/verify-hands.ts <ndjson_file> [hand_id...]')
    process.exit(1)
  }

  const ndjsonFile = args[0]!
  const handIds = args.length > 1
    ? args.slice(1).map(Number)
    : DEFAULT_HAND_IDS

  if (!fs.existsSync(ndjsonFile)) {
    console.error(`File not found: ${ndjsonFile}`)
    process.exit(1)
  }

  console.error(`Loading events from ${ndjsonFile}...`)
  console.error(`Target hand IDs: ${handIds.join(', ')}`)

  // Phase 1: Find hand result events to get timestamps
  const handResults = new Map<number, { timestamp: number; line: number }>()
  const allEvents: ApiEvent[] = []

  const rl = readline.createInterface({
    input: fs.createReadStream(ndjsonFile),
    crlfDelay: Infinity
  })

  let lineNum = 0
  for await (const line of rl) {
    lineNum++
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as ApiEvent
      allEvents.push(event)

      if (event.ApiTypeId === ApiType.EVT_HAND_RESULTS) {
        const handId = (event as any).HandId as number
        if (handIds.includes(handId)) {
          handResults.set(handId, { timestamp: event.timestamp!, line: lineNum })
        }
      }
    } catch {
      // skip invalid lines
    }
  }

  console.error(`Loaded ${allEvents.length} events`)
  console.error(`Found ${handResults.size}/${handIds.length} target hand results`)

  // Phase 2: Build global player name map from EVT_PLAYER_SEAT_ASSIGNED events
  const globalPlayerMap = new Map<number, { name: string; rank: string }>()
  for (const event of allEvents) {
    if (isApiEventType(event, ApiType.EVT_PLAYER_SEAT_ASSIGNED) && event.TableUsers) {
      for (const user of event.TableUsers) {
        globalPlayerMap.set(user.UserId, {
          name: user.UserName,
          rank: user.Rank.RankId
        })
      }
    }
    if (isApiEventType(event, ApiType.EVT_PLAYER_JOIN) && event.JoinUser) {
      globalPlayerMap.set(event.JoinUser.UserId, {
        name: event.JoinUser.UserName,
        rank: event.JoinUser.Rank.RankId
      })
    }
  }
  console.error(`Player map: ${globalPlayerMap.size} players`)

  // Phase 3: Extract hand event sequences and detect session context
  const outputs: string[] = []

  for (const handId of handIds) {
    const result = handResults.get(handId)
    if (!result) {
      console.error(`\n⚠ Hand #${handId}: not found in file, skipping`)
      continue
    }

    // Find the event range
    const startTime = result.timestamp - TIME_BUFFER_MS
    const endTime = result.timestamp + POST_HAND_BUFFER_MS

    const rangeEvents = allEvents.filter(e =>
      e.timestamp! >= startTime && e.timestamp! <= endTime
    ).sort((a, b) => a.timestamp! - b.timestamp!)

    // Find the specific hand sequence: EVT_DEAL -> EVT_HAND_RESULTS
    const resultEvent = rangeEvents.find(e =>
      isApiEventType(e, ApiType.EVT_HAND_RESULTS) && (e as any).HandId === handId
    )
    if (!resultEvent) {
      console.error(`\n⚠ Hand #${handId}: could not find EVT_HAND_RESULTS`)
      continue
    }

    // Find matching EVT_DEAL by looking for SeatUserIds match
    // We need to find the deal that leads to this result
    const handEvents: ApiEvent[] = []
    let foundDeal = false
    let dealEvent: ApiEvent | null = null

    // Get SeatUserIds from result's OtherPlayers + Player
    for (const event of rangeEvents) {
      if (isApiEventType(event, ApiType.EVT_DEAL)) {
        // Check if any subsequent result matches our handId
        foundDeal = true
        dealEvent = event
        handEvents.length = 0
        handEvents.push(event)
      } else if (foundDeal) {
        handEvents.push(event)
        if (isApiEventType(event, ApiType.EVT_HAND_RESULTS) && (event as any).HandId === handId) {
          break
        }
        // If we hit another EVT_HAND_RESULTS with different ID, reset
        if (isApiEventType(event, ApiType.EVT_HAND_RESULTS) && (event as any).HandId !== handId) {
          foundDeal = false
          dealEvent = null
          handEvents.length = 0
        }
      }
    }

    if (!dealEvent || handEvents.length === 0) {
      console.error(`\n⚠ Hand #${handId}: could not reconstruct event sequence`)
      continue
    }

    // Detect session context from nearby EVT_SESSION_DETAILS or EVT_ENTRY_QUEUED
    let battleType: number | undefined
    let sessionName: string | undefined

    for (const event of rangeEvents) {
      if (event.ApiTypeId === ApiType.EVT_SESSION_DETAILS) {
        sessionName = (event as any).Name2 || (event as any).Name
      }
      if (event.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
        battleType = (event as any).BattleType
      }
    }

    // Fallback: detect from deal event
    if (battleType === undefined) {
      // If there's MyRanking in deal, it's a tournament
      if ((dealEvent as any).MyRanking) {
        battleType = 0 // SIT_AND_GO (tournament)
      }
    }
    if (!sessionName) {
      // Try to find from earlier session details
      for (let i = allEvents.indexOf(dealEvent) - 1; i >= Math.max(0, allEvents.indexOf(dealEvent) - 500); i--) {
        const e = allEvents[i]!
        if (e.ApiTypeId === ApiType.EVT_SESSION_DETAILS) {
          sessionName = (e as any).Name2 || (e as any).Name
          break
        }
        if (e.ApiTypeId === ApiType.EVT_ENTRY_QUEUED) {
          battleType = (e as any).BattleType
        }
      }
    }

    // Build session with player names
    const seatUserIds = (dealEvent as any).SeatUserIds as number[]
    const session: Session = {
      id: `hand_${handId}`,
      battleType: battleType ?? 0,
      name: sessionName || 'Unknown',
      players: new Map(),
      reset() {
        this.players.clear()
      }
    }

    for (const userId of seatUserIds) {
      if (userId !== -1) {
        const info = globalPlayerMap.get(userId)
        if (info) {
          session.players.set(userId, info)
        } else {
          session.players.set(userId, { name: `Player${userId}`, rank: 'Unknown' })
        }
      }
    }

    // Process with HandLogProcessor
    const ctx: HandLogContext = {
      session,
      handLogConfig: DEFAULT_HAND_LOG_CONFIG,
      handTimestamp: (dealEvent as any).timestamp
    }

    const processor = new HandLogProcessor(ctx)
    const entries = processor.processEvents(handEvents)
    const handText = entries.map(e => e.text).join('\n')

    if (handText.trim()) {
      console.error(`\n✓ Hand #${handId}: ${entries.length} lines generated`)
      outputs.push(handText)
    } else {
      console.error(`\n○ Hand #${handId}: skipped (hero not participating)`)
    }
  }

  // Output all hands to stdout (separated by blank lines, PokerStars convention)
  if (outputs.length > 0) {
    console.log(outputs.join('\n\n\n'))
  }

  console.error(`\nDone: ${outputs.length} hands exported`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
