/**
 * verify-stats: pipeline-side computation.
 *
 * Converts raw NDJSON events through the repo's own `EntityConverter`
 * (exactly as the import path does) and then replicates
 * `ReadEntityStream.calcStats` in memory (no Dexie) to build a
 * `StatCalculationContext` per player and run every registered
 * `StatDefinition.calculate`.
 *
 * This is intentionally the *dependent* half of the verification harness —
 * see oracle.ts for the independent re-implementation this is checked against.
 */
import { EntityConverter } from '../../entity-converter'
import { defaultRegistry } from '../../stats'
import { PhaseType } from '../../types/game'
import type { Action, ApiEvent, Hand, Phase, Session } from '../../types'

/** Per-player pipeline output: hand count plus every registered stat's raw value. */
export interface PipelinePlayerResult {
  playerId: number
  hands: number
  stats: Record<string, unknown>
}

export type PipelineResult = Map<number, PipelinePlayerResult>

/**
 * Run the real EntityConverter + StatDefinition.calculate over `events` and
 * return per-player results for every player who appeared in at least one hand.
 */
export async function runPipeline(events: ApiEvent[]): Promise<PipelineResult> {
  const session: Session = {
    id: undefined,
    battleType: undefined,
    name: undefined,
    players: new Map(),
    reset: () => { /* no-op: standalone tool has no live session to reset */ }
  }

  const converter = new EntityConverter(session)
  const bundle = converter.convertEventsToEntities(events)

  // In-memory indices mirroring the Dexie tables/queries used by
  // ReadEntityStream.calcStats (hands.where('seatUserIds').equals(playerId),
  // actions.where({playerId}), phases.where('seatUserIds').equals(playerId)).
  const handsById = new Map<number, Hand>()
  for (const h of bundle.hands) handsById.set(h.id, h)

  const handsByPlayer = new Map<number, Hand[]>()
  for (const h of bundle.hands) {
    for (const pid of h.seatUserIds) {
      if (pid === -1 || pid == null) continue
      let list = handsByPlayer.get(pid)
      if (!list) { list = []; handsByPlayer.set(pid, list) }
      list.push(h)
    }
  }

  const actionsByPlayer = new Map<number, Action[]>()
  for (const a of bundle.actions) {
    let list = actionsByPlayer.get(a.playerId)
    if (!list) { list = []; actionsByPlayer.set(a.playerId, list) }
    list.push(a)
  }

  const phasesByPlayer = new Map<number, Phase[]>()
  for (const p of bundle.phases) {
    for (const pid of p.seatUserIds) {
      if (pid === -1 || pid == null) continue
      let list = phasesByPlayer.get(pid)
      if (!list) { list = []; phasesByPlayer.set(pid, list) }
      list.push(p)
    }
  }

  const allPlayerIds = new Set<number>()
  for (const h of bundle.hands) {
    for (const pid of h.seatUserIds) {
      if (pid !== -1 && pid != null) allPlayerIds.add(pid)
    }
  }

  const result: PipelineResult = new Map()

  for (const playerId of allPlayerIds) {
    // Mirrors calcStats with no battleType/handLimit filters (we want ALL hands).
    const allPlayerHands = handsByPlayer.get(playerId) || []
    const relevantActions = actionsByPlayer.get(playerId) || []
    const relevantPhases = phasesByPlayer.get(playerId) || []

    const flopPhases = relevantPhases.filter(p => p.phase === PhaseType.FLOP)
    const showdownPhases = relevantPhases.filter(p => p.phase === PhaseType.SHOWDOWN)
    const phaseHandIds = [...new Set([...flopPhases, ...showdownPhases].map(p => p.handId!))]

    let winningHands: Hand[] = []
    if (phaseHandIds.length > 0) {
      winningHands = phaseHandIds
        .map(id => handsById.get(id))
        .filter((h): h is Hand => !!h && h.winningPlayerIds.includes(playerId))
    }
    const winningHandIds = new Set(winningHands.map(h => h.id))

    const statResults = await defaultRegistry.calculateWithConfig({
      playerId,
      actions: relevantActions,
      phases: relevantPhases,
      hands: allPlayerHands,
      allPlayerActions: relevantActions,
      allPlayerPhases: relevantPhases,
      winningHandIds,
      session
    }, undefined)

    const stats: Record<string, unknown> = {}
    for (const sr of statResults) {
      stats[sr.id] = sr.value
    }

    result.set(playerId, {
      playerId,
      hands: allPlayerHands.length,
      stats
    })
  }

  return result
}
