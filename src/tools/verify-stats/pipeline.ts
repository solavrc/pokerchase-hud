/**
 * verify-stats: pipeline-side computation.
 *
 * Converts raw NDJSON events through the repo's own `EntityConverter`
 * (exactly as the import path does), then exposes both product calculators:
 * the legacy `StatDefinition.calculate` full-history path and the v8
 * contribution-ledger derivation/aggregation path.
 *
 * This is intentionally the *dependent* half of the verification harness —
 * see oracle.ts for the independent re-implementation this is checked against.
 */
import { EntityConverter } from '../../entity-converter'
import type { EntityBundle } from '../../entity-converter'
import { defaultRegistry } from '../../stats'
import {
  buildGenerationFromEntityBundle,
  buildStatSnapshot,
} from '../../stats/stat-ledger'
import { PhaseType } from '../../types/game'
import type { Action, ApiEvent, Hand, Phase, Session } from '../../types'

/** Per-player pipeline output: hand count plus every registered stat's raw value. */
export interface PipelinePlayerResult {
  playerId: number
  hands: number
  stats: Record<string, unknown>
}

export type PipelineResult = Map<number, PipelinePlayerResult>

function createStandaloneSession(): Session {
  return {
    id: undefined,
    battleType: undefined,
    name: undefined,
    players: new Map(),
    reset: () => { /* no-op: standalone tool has no live session to reset */ }
  }
}

function convertEvents(events: ApiEvent[]): { bundle: EntityBundle, session: Session } {
  const session = createStandaloneSession()
  const converter = new EntityConverter(session)
  return { bundle: converter.convertEventsToEntities(events), session }
}

/**
 * Run the real EntityConverter + StatDefinition.calculate over `events` and
 * return per-player results for every player who appeared in at least one hand.
 */
async function runLegacyPipelineFromBundle(
  bundle: EntityBundle,
  session: Session
): Promise<PipelineResult> {
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

  // Mirror Dexie's `phases` table primary key `[handId+phase]`: the real import
  // path writes phases via `bulkPut`, so multiple EntityConverter-emitted phase
  // records for the same (handId, phase) collapse to ONE record (last write
  // wins, by array order) before ReadEntityStream.calcStats ever sees them.
  // Without this de-dup, the harness indexes every phase EntityConverter
  // emits, which diverges from product behavior for hands with duplicate
  // street events (fused table-move buffers are now rejected upstream, but the semantics must still mirror bulkPut for any future duplicate-street capture).
  const dedupedPhasesByKey = new Map<string, Phase>()
  for (const p of bundle.phases) {
    dedupedPhasesByKey.set(`${p.handId}:${p.phase}`, p)
  }
  const dedupedPhases = [...dedupedPhasesByKey.values()]

  const phasesByPlayer = new Map<number, Phase[]>()
  for (const p of dedupedPhases) {
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

    const context = {
      playerId,
      actions: relevantActions,
      phases: relevantPhases,
      hands: allPlayerHands,
      allPlayerActions: relevantActions,
      allPlayerPhases: relevantPhases,
      winningHandIds,
      session
    }

    // Deliberately compute EVERY registered stat (defaultRegistry.getAll()),
    // not just the enabled ones (calculateWithConfig(ctx, undefined) would use
    // calculateAll -> getEnabled()). Opt-in variants (e.g. wtsdNoAi/wwsfNoAi,
    // #115) are disabled by default in the product but must still be checked
    // against the oracle here -- verify-stats is a regression harness for the
    // full registered stat surface, independent of the live UI's default
    // enabled state.
    const stats: Record<string, unknown> = {}
    for (const stat of defaultRegistry.getAll()) {
      try {
        stats[stat.id] = await stat.calculate(context)
      } catch (error) {
        console.error(`[verify-stats pipeline] Error calculating stat ${stat.id}:`, error)
        stats[stat.id] = 0
      }
    }

    result.set(playerId, {
      playerId,
      hands: allPlayerHands.length,
      stats
    })
  }

  return result
}

export async function runPipeline(events: ApiEvent[]): Promise<PipelineResult> {
  const { bundle, session } = convertEvents(events)
  return await runLegacyPipelineFromBundle(bundle, session)
}

/**
 * Run the product's v8 contribution-ledger derivation over `events` and
 * return its all-history player aggregates in the same comparison shape.
 * This deliberately calls the shipping ledger code; verify-stats must not
 * infer ledger correctness from the unchanged legacy calculator alone.
 */
function runLedgerPipelineFromBundle(bundle: EntityBundle): PipelineResult {
  const built = buildGenerationFromEntityBundle(1, bundle)
  const result: PipelineResult = new Map()

  for (const aggregate of built.aggregates) {
    const stats = buildStatSnapshot(aggregate.totals)
    const hands = stats.hands
    if (typeof hands !== 'number') {
      throw new TypeError(`Ledger hands counter is not numeric for player ${aggregate.playerId}`)
    }
    result.set(aggregate.playerId, {
      playerId: aggregate.playerId,
      hands,
      stats,
    })
  }

  return result
}

export async function runLedgerPipeline(events: ApiEvent[]): Promise<PipelineResult> {
  return runLedgerPipelineFromBundle(convertEvents(events).bundle)
}

/** CLI用: 大規模captureを二度EntityConverterへ通さず両製品経路を計算する。 */
export async function runProductPipelines(events: ApiEvent[]): Promise<{
  legacy: PipelineResult
  ledger: PipelineResult
}> {
  const { bundle, session } = convertEvents(events)
  const ledger = runLedgerPipelineFromBundle(bundle)
  return {
    legacy: await runLegacyPipelineFromBundle(bundle, session),
    ledger,
  }
}
