// @ts-nocheck
/**
 * Independent hand tracer for validating expected stats.
 * Parses event_timeline from app.test.ts and computes correct statistics
 * from first principles (standard poker stat definitions).
 *
 * Run: npx tsx src/tools/trace-hands.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// --- Types ---
enum AT { CHECK=0, BET=1, FOLD=2, CALL=3, RAISE=4, ALL_IN=5 }
enum Phase { PREFLOP=0, FLOP=1, TURN=2, RIVER=3, SHOWDOWN=4 }

interface Action {
  seatIndex: number; playerId: number; actionType: AT; normalizedType: AT
  phase: Phase; playerActionIndex: number; prevBetCount: number; bet: number
}
interface HandTrace {
  handNum: number; handId: number; seatUserIds: number[]
  btnSeat: number; sbSeat: number; bbSeat: number
  actions: Action[]
  sawFlop: Set<number>; wentToShowdown: Set<number>; winners: Set<number>
  lastPreflopAggressor: number; phases: Phase[]
}

// --- Read event_timeline ---
const testFile = fs.readFileSync(path.join(__dirname, '..', 'app.test.ts'), 'utf-8')
const startMarker = 'export const event_timeline'
const startIdx = testFile.indexOf(startMarker)
const equalsIdx = testFile.indexOf('=', startIdx + startMarker.length)
const arrayStart = testFile.indexOf('[', equalsIdx)
let depth = 0, arrayEnd = -1
for (let i = arrayStart; i < testFile.length; i++) {
  if (testFile[i] === '[') depth++
  if (testFile[i] === ']') { depth--; if (depth === 0) { arrayEnd = i; break } }
}
const cleaned = testFile.slice(arrayStart, arrayEnd + 1).replace(/\/\/[^\n]*/g, '')
const event_timeline: any[] = eval(cleaned)

// --- Trace hands ---
function traceHands(): HandTrace[] {
  const hands: HandTrace[] = []
  let seatUserIds: number[] = []
  let actions: Action[] = []
  let btnSeat = -1, sbSeat = -1, bbSeat = -1
  let currentPhase = Phase.PREFLOP
  let phaseBetCount = 1
  let playerActionCounts: Map<string, number> = new Map()
  let handNum = 0
  let activePlayers: Set<number> = new Set()
  let sawFlop: Set<number> = new Set()
  let phasePlayers: Set<Phase> = new Set()
  let lastPreflopAggressor = -1
  let highestBetInPhase = 0

  for (const evt of event_timeline) {
    const typeId = evt.ApiTypeId

    if (typeId === 303) { // EVT_DEAL
      seatUserIds = evt.SeatUserIds
      btnSeat = evt.Game.ButtonSeat; sbSeat = evt.Game.SmallBlindSeat; bbSeat = evt.Game.BigBlindSeat
      currentPhase = Phase.PREFLOP; phaseBetCount = 1
      playerActionCounts = new Map(); actions = []
      activePlayers = new Set(); sawFlop = new Set()
      phasePlayers = new Set([Phase.PREFLOP])
      lastPreflopAggressor = -1
      // Highest bet starts at BB bet amount
      highestBetInPhase = evt.Game.BigBlind
      handNum++
      for (let i = 0; i < seatUserIds.length; i++) {
        if (seatUserIds[i] !== -1) activePlayers.add(seatUserIds[i])
      }
    }

    if (typeId === 304) { // EVT_ACTION
      const seatIndex = evt.SeatIndex
      const playerId = seatUserIds[seatIndex]
      const actionType: AT = evt.ActionType
      const key = `${playerId}-${currentPhase}`
      const playerActionIndex = playerActionCounts.get(key) || 0
      playerActionCounts.set(key, playerActionIndex + 1)
      const betChip = evt.BetChip || 0

      // Normalize ALL_IN: if BetChip > current highest bet → RAISE, else → CALL
      let normalizedType = actionType
      if (actionType === AT.ALL_IN) {
        if (highestBetInPhase === 0) {
          normalizedType = AT.RAISE // opening all-in = aggressive
        } else if (betChip > highestBetInPhase) {
          normalizedType = AT.RAISE
        } else {
          normalizedType = AT.CALL
        }
      }

      actions.push({ seatIndex, playerId, actionType, normalizedType, phase: currentPhase,
        playerActionIndex, prevBetCount: phaseBetCount, bet: betChip })

      // Update state
      if (betChip > highestBetInPhase) highestBetInPhase = betChip
      if (currentPhase === Phase.PREFLOP) {
        if (actionType === AT.RAISE || (actionType === AT.ALL_IN && normalizedType === AT.RAISE)) {
          phaseBetCount++; lastPreflopAggressor = playerId
        }
      }
      if (actionType === AT.FOLD) activePlayers.delete(playerId)
    }

    if (typeId === 305) { // EVT_DEAL_ROUND (new street)
      const progress = evt.Progress
      if (progress) {
        currentPhase = progress.Phase as Phase
        phaseBetCount = 0; highestBetInPhase = 0
        phasePlayers.add(currentPhase)
      }
      // Track who saw the flop (non-folded players)
      if (currentPhase === Phase.FLOP) {
        if (evt.Player && evt.Player.BetStatus !== 2) sawFlop.add(seatUserIds[evt.Player.SeatIndex])
        for (const op of (evt.OtherPlayers || [])) {
          if (op.BetStatus !== 2) sawFlop.add(seatUserIds[op.SeatIndex])
        }
      }
    }

    if (typeId === 306) { // EVT_HAND_RESULTS
      const winners = new Set<number>()
      const showdownPlayers = new Set<number>()
      for (const r of evt.Results) {
        if (r.RewardChip > 0) winners.add(r.UserId)
        // RankType 10 = NO_CALL (won without showdown), 12 = FOLD_OPEN
        // RankType 0-9 = actual hand ranks, 11 = SHOWDOWN_MUCK (went to SD but didn't show)
        // Showdown = all players with RankType 0-9 or 11 (excludes NO_CALL and FOLD_OPEN)
        if (r.RankType !== undefined && r.RankType <= 11 && r.RankType !== 10) {
          showdownPlayers.add(r.UserId)
        }
      }
      hands.push({ handNum, handId: evt.HandId, seatUserIds: [...seatUserIds],
        btnSeat, sbSeat, bbSeat, actions: [...actions], sawFlop: new Set(sawFlop),
        wentToShowdown: showdownPlayers, winners, lastPreflopAggressor,
        phases: [...phasePlayers] })
    }
  }
  return hands
}

// --- Compute cumulative stats ---
interface CumStats {
  hands: number; vpipCount: number; pfrHands: Set<number>
  threeBetChance: number; threeBetCount: number
  threeBetFoldChance: number; threeBetFoldCount: number
  cbetChance: number; cbetCount: number
  cbetFoldChance: number; cbetFoldCount: number
  aggressive: number; calls: number; folds: number; checks: number
  flopsSeen: number; showdownsAfterFlop: number; allShowdowns: number
  wonAfterFlop: number; wonAtShowdown: number
  riverCalls: number; riverCallWins: number
}
function init(): CumStats {
  return { hands:0, vpipCount:0, pfrHands:new Set(), threeBetChance:0, threeBetCount:0,
    threeBetFoldChance:0, threeBetFoldCount:0, cbetChance:0, cbetCount:0,
    cbetFoldChance:0, cbetFoldCount:0, aggressive:0, calls:0, folds:0, checks:0,
    flopsSeen:0, showdownsAfterFlop:0, allShowdowns:0, wonAfterFlop:0, wonAtShowdown:0,
    riverCalls:0, riverCallWins:0 }
}

function computeExpected(hands: HandTrace[]) {
  const playerNames: Record<number, string> = { 2: '美遊', 4: '凛', 3: 'クロエ', 1: 'イリヤスフィール' }
  const cs: Record<number, CumStats> = {}
  for (const pid of [2, 4, 3, 1]) cs[pid] = init()
  const allResults: any[][] = []

  for (const hand of hands) {
    const participating = hand.seatUserIds.filter(id => id !== -1)
    for (const pid of participating) cs[pid].hands++

    // --- Preflop ---
    const pfActions = hand.actions.filter(a => a.phase === Phase.PREFLOP)
    for (const a of pfActions) {
      if (a.playerId === -1) continue
      const s = cs[a.playerId]
      const t = a.actionType === AT.ALL_IN ? a.normalizedType : a.actionType

      // VPIP: first preflop CALL/RAISE
      if (a.playerActionIndex === 0 && (t === AT.CALL || t === AT.RAISE)) s.vpipCount++
      // PFR
      if (t === AT.RAISE) s.pfrHands.add(hand.handNum)
      // 3-Bet: facing 2-bet
      if (a.prevBetCount === 2) { s.threeBetChance++; if (t === AT.RAISE) s.threeBetCount++ }
      // 3-Bet Fold: facing 3-bet
      if (a.prevBetCount === 3) { s.threeBetFoldChance++; if (t === AT.FOLD) s.threeBetFoldCount++ }
    }

    // --- CBet on flop ---
    const flopActions = hand.actions.filter(a => a.phase === Phase.FLOP)
    if (flopActions.length > 0 && hand.lastPreflopAggressor !== -1) {
      const pfr = hand.lastPreflopAggressor
      let cBetDone = false
      for (const a of flopActions) {
        const t = a.actionType === AT.ALL_IN ? a.normalizedType : a.actionType
        // PFR's first action on flop with no prior bets = CBet opportunity
        if (a.playerId === pfr && a.playerActionIndex === 0) {
          const priorBets = flopActions.filter(x =>
            flopActions.indexOf(x) < flopActions.indexOf(a) &&
            (x.actionType === AT.BET || x.actionType === AT.RAISE))
          if (priorBets.length === 0) {
            cs[pfr].cbetChance++
            if (t === AT.BET) { cBetDone = true; cs[pfr].cbetCount++ }
          }
        }
        // CBetFold: after cbet, other players who act face it
        // They might have already checked before the cbet (so playerActionIndex > 0)
        // The key condition is: cbet happened, and this is the player's first action AFTER the cbet
        if (cBetDone && a.playerId !== pfr) {
          // Only count if this is the player's first action after the cbet
          const playerActionsAfterCbet = flopActions.filter(x =>
            x.playerId === a.playerId && flopActions.indexOf(x) > flopActions.findIndex(cb => 
              cb.playerId === pfr && (cb.actionType === AT.BET || cb.normalizedType === AT.BET))
          )
          if (playerActionsAfterCbet.length > 0 && playerActionsAfterCbet[0] === a) {
            const s = cs[a.playerId]
            s.cbetFoldChance++
            if (t === AT.FOLD) s.cbetFoldCount++
          }
        }
      }
    }

    // --- AF / AFq: all streets ---
    for (const a of hand.actions) {
      if (a.playerId === -1) continue
      const s = cs[a.playerId]
      const t = a.actionType === AT.ALL_IN ? a.normalizedType : a.actionType
      if (t === AT.BET || t === AT.RAISE) s.aggressive++
      else if (t === AT.CALL) s.calls++
      else if (t === AT.FOLD) s.folds++
      else if (t === AT.CHECK) s.checks++
    }

    // --- RCA: River calls ---
    const riverActions = hand.actions.filter(a => a.phase === Phase.RIVER)
    for (const a of riverActions) {
      if (a.playerId === -1) continue
      const t = a.actionType === AT.ALL_IN ? a.normalizedType : a.actionType
      if (t === AT.CALL) {
        cs[a.playerId].riverCalls++
        if (hand.winners.has(a.playerId)) {
          cs[a.playerId].riverCallWins++
        }
      }
    }

    // --- WTSD / WWSF / W$SD ---
    for (const pid of hand.sawFlop) cs[pid].flopsSeen++
    // WTSD: showdown AND saw flop (exclude preflop all-in)
    for (const pid of hand.wentToShowdown) {
      cs[pid].allShowdowns++ // For W$SD (includes preflop all-in)
      if (hand.sawFlop.has(pid)) cs[pid].showdownsAfterFlop++ // For WTSD
    }
    // WWSF: won AND saw flop
    for (const pid of hand.winners) {
      if (hand.sawFlop.has(pid)) cs[pid].wonAfterFlop++
    }
    // W$SD: won at showdown (ALL showdowns, including preflop all-in)
    for (const pid of hand.winners) {
      if (hand.wentToShowdown.has(pid)) cs[pid].wonAtShowdown++
    }

    // --- Build result ---
    const handResult: any[] = []
    for (const pid of hand.seatUserIds) {
      if (pid === -1) { handResult.push({ playerId: -1 }); continue }
      const s = cs[pid]
      // W$SD denominator: total showdowns including preflop all-in
      const totalShowdowns = hand.actions.length > 0 ?
        // Count all showdowns this player was part of (cumulative)
        // We need a separate counter for "all showdowns" including preflop all-in
        s.showdowns : 0 // Will fix below
      
      handResult.push({ playerId: pid, statResults: [
        { id: 'hands', name: 'HAND', value: s.hands, formatted: `${s.hands}` },
        { id: 'playerName', name: 'Name', value: playerNames[pid], formatted: playerNames[pid] },
        { id: 'vpip', name: 'VPIP', value: [s.vpipCount, s.hands], formatted: fmtPct(s.vpipCount, s.hands) },
        { id: 'pfr', name: 'PFR', value: [s.pfrHands.size, s.hands], formatted: fmtPct(s.pfrHands.size, s.hands) },
        { id: 'cbet', name: 'CB', value: [s.cbetCount, s.cbetChance], formatted: fmtPct(s.cbetCount, s.cbetChance) },
        { id: 'cbetFold', name: 'CBF', value: [s.cbetFoldCount, s.cbetFoldChance], formatted: fmtPct(s.cbetFoldCount, s.cbetFoldChance) },
        { id: '3bet', name: '3B', value: [s.threeBetCount, s.threeBetChance], formatted: fmtPct(s.threeBetCount, s.threeBetChance) },
        { id: '3betfold', name: '3BF', value: [s.threeBetFoldCount, s.threeBetFoldChance], formatted: fmtPct(s.threeBetFoldCount, s.threeBetFoldChance) },
        { id: 'af', name: 'AF', value: [s.aggressive, s.calls], formatted: fmtFactor(s.aggressive, s.calls) },
        { id: 'afq', name: 'AFq', value: [s.aggressive, s.aggressive + s.calls + s.folds], formatted: fmtPct(s.aggressive, s.aggressive + s.calls + s.folds) },
        { id: 'wtsd', name: 'WTSD', value: [s.showdownsAfterFlop, s.flopsSeen], formatted: fmtPct(s.showdownsAfterFlop, s.flopsSeen) },
        { id: 'wwsf', name: 'WWSF', value: [s.wonAfterFlop, s.flopsSeen], formatted: fmtPct(s.wonAfterFlop, s.flopsSeen) },
        { id: 'wsd', name: 'W$SD', value: [s.wonAtShowdown, s.allShowdowns], formatted: fmtPct(s.wonAtShowdown, s.allShowdowns) },
        { id: 'riverCallAccuracy', name: 'RCA', value: [s.riverCallWins, s.riverCalls], formatted: fmtPct(s.riverCallWins, s.riverCalls) },
      ]})
    }
    allResults.push(handResult)
  }
  return allResults
}

function fmtPct(n: number, d: number): string {
  if (d === 0) return '-'; return `${(n/d*100).toFixed(1)}% (${n}/${d})`
}
function fmtFactor(n: number, d: number): string {
  if (d === 0) return '-'; return `${(n/d).toFixed(2)} (${n}/${d})`
}

// --- Main ---
const hands = traceHands()
console.log(`\n=== Traced ${hands.length} hands ===\n`)

for (const hand of hands) {
  const p = (s: number) => { const id = hand.seatUserIds[s]; return id === -1 ? '(empty)' : `P${id}` }
  console.log(`--- Hand ${hand.handNum} (ID: ${hand.handId}) ---`)
  console.log(`  BTN: seat${hand.btnSeat}=${p(hand.btnSeat)}, SB: seat${hand.sbSeat}=${p(hand.sbSeat)}, BB: seat${hand.bbSeat}=${p(hand.bbSeat)}`)
  let curPhase = -1
  for (const a of hand.actions) {
    if (a.phase !== curPhase) { curPhase = a.phase; console.log(`  [${Phase[a.phase]}]`) }
    const name = a.actionType === AT.ALL_IN ? `ALL_IN→${AT[a.normalizedType]}` : AT[a.actionType]
    console.log(`    seat${a.seatIndex}(P${a.playerId}) ${name} idx=${a.playerActionIndex} prevBet=${a.prevBetCount} bet=${a.bet}`)
  }
  console.log(`  Saw flop: [${[...hand.sawFlop]}] Showdown: [${[...hand.wentToShowdown]}] Winners: [${[...hand.winners]}] PFR: P${hand.lastPreflopAggressor}`)
}

const expected = computeExpected(hands)
console.log('\n=== Expected Stats (JSON) ===\n')
console.log(JSON.stringify(expected, null, 2))

console.log('\n=== Per-hand cumulative summary ===\n')
for (let i = 0; i < expected.length; i++) {
  console.log(`After Hand ${i+1}:`)
  for (const ps of expected[i]) {
    if (ps.playerId === -1) continue
    const f = (id: string) => ps.statResults?.find((s:any)=>s.id===id)?.formatted || '?'
    console.log(`  P${ps.playerId}: VPIP=${f('vpip')} PFR=${f('pfr')} 3B=${f('3bet')} 3BF=${f('3betfold')} CB=${f('cbet')} CBF=${f('cbetFold')} AF=${f('af')} AFq=${f('afq')} WTSD=${f('wtsd')} WWSF=${f('wwsf')} W$SD=${f('wsd')}`)
  }
}
