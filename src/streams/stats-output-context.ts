import type { ApiEvent, ApiType, PlayerStats } from '../types'

/**
 * 統計配列の公開wire型を変えずに、非同期streamの発生文脈を運ぶ内部metadata。
 * WeakMapなのでRaw Event Lake・export・content scriptへ混入しない。
 */
export interface StatsOutputContext {
  generation?: number
  evtDeal?: ApiEvent<ApiType.EVT_DEAL>
  delivery: 'active' | 'connected'
}

let generationByEvent = new WeakMap<object, number>()
let contextByRequest = new WeakMap<number[], StatsOutputContext>()
let contextByOutput = new WeakMap<PlayerStats[], StatsOutputContext>()
let defaultContextProvider: (() => StatsOutputContext) | undefined

export const setEventGeneration = (event: object, generation: number): void => {
  generationByEvent.set(event, generation)
}

export const getEventGeneration = (event: object): number | undefined =>
  generationByEvent.get(event)

export const setStatsRequestContext = (
  seatUserIds: number[],
  context: StatsOutputContext
): void => {
  contextByRequest.set(seatUserIds, context)
}

export const takeStatsRequestContext = (
  seatUserIds: number[]
): StatsOutputContext | undefined => {
  const context = contextByRequest.get(seatUserIds)
  contextByRequest.delete(seatUserIds)
  return context
}

export const setDefaultStatsContextProvider = (
  provider: () => StatsOutputContext
): void => {
  defaultContextProvider = provider
}

export const getDefaultStatsContext = (): StatsOutputContext | undefined =>
  defaultContextProvider?.()

export const setStatsOutputContext = (
  stats: PlayerStats[],
  context: StatsOutputContext | undefined
): void => {
  if (context) contextByOutput.set(stats, context)
}

export const getStatsOutputContext = (
  stats: PlayerStats[]
): StatsOutputContext | undefined => contextByOutput.get(stats)

export const __resetStatsOutputContextForTests = (): void => {
  generationByEvent = new WeakMap<object, number>()
  contextByRequest = new WeakMap<number[], StatsOutputContext>()
  contextByOutput = new WeakMap<PlayerStats[], StatsOutputContext>()
  defaultContextProvider = undefined
}
