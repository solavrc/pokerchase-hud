import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ActionType, ApiType, PhaseType, type ApiEvent } from '../types'

/** 公開済みの合成Ring fixtureだけを使い、人物不明行の前後を組み立てる。 */
export function makeIdentityActionFixture(options: {
  phase?: PhaseType
  followingType?: ActionType
  menu?: ActionType[]
  knownRaiseBefore?: boolean
  trustedMenu?: boolean
  sameTimestamp?: 'unknown-first' | 'known-first'
} = {}): ApiEvent[] {
  const events: ApiEvent[] = readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  const joinIndex = events.findIndex(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)
  const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
  const template = events.find((event): event is ApiEvent<ApiType.EVT_ACTION> => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 3)!
  const phase = options.phase ?? PhaseType.PREFLOP
  const menu = options.menu ?? [ActionType.FOLD, ActionType.CALL, ActionType.ALL_IN]
  const unknown = structuredClone(template)
  Object.assign(unknown, { SeatIndex: 0, ActionType: ActionType.RAISE, Chip: 2850, BetChip: 100 })
  unknown.Progress = { ...unknown.Progress, Phase: phase, Pot: 175, NextActionSeat: 3, NextActionTypes: menu }
  const following = structuredClone(template)
  Object.assign(following, { ActionType: options.followingType ?? ActionType.RAISE, Chip: 7900, BetChip: 200 })
  following.Progress = { ...following.Progress, Phase: phase, Pot: 350, NextActionSeat: 5, NextActionTypes: [] }
  if (following.ActionType === ActionType.ALL_IN) following.Chip = 0
  const before: ApiEvent[] = []
  if (options.knownRaiseBefore) {
    const known = structuredClone(template)
    Object.assign(known, { ActionType: ActionType.RAISE, Chip: 8000, BetChip: 100 })
    known.Progress = { ...known.Progress, Phase: PhaseType.PREFLOP, Pot: 150, NextActionSeat: 5, NextActionTypes: menu }
    before.push(known)
  }
  const after: ApiEvent[] = []
  if (options.trustedMenu) {
    const known = structuredClone(template)
    Object.assign(known, { SeatIndex: 5, ActionType: phase === PhaseType.PREFLOP ? ActionType.CALL : ActionType.CHECK, Chip: 4775, BetChip: 100 })
    known.Progress = { ...known.Progress, Phase: phase, Pot: 225, NextActionSeat: 3, NextActionTypes: menu }
    after.push(known)
  }
  const ordered = [...events.slice(0, joinIndex), ...before, events[joinIndex]!, unknown, ...after, following, result]
  ordered.forEach((event, index) => { event.timestamp = 1734100300000 + index * 1000 })
  result.HandId = 940104
  if (options.sameTimestamp) {
    following.timestamp = unknown.timestamp
    if (options.sameTimestamp === 'known-first') {
      ordered.splice(ordered.indexOf(following), 1)
      ordered.splice(ordered.indexOf(unknown), 0, following)
    }
  }
  return ordered
}

/** 席3と5の250対250 showdown。曖昧版だけ旧席0に同msの着席境界を置く。 */
export function makeIdentityWinnerFixture(unproven: boolean): ApiEvent[] {
  const events: ApiEvent[] = readFileSync(join(process.cwd(), 'e2e/fixtures/hand-ring-seat-replacement.ndjson'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  const deal = events.find(event => event.ApiTypeId === ApiType.EVT_DEAL)!
  const joinEvent = events.find(event => event.ApiTypeId === ApiType.EVT_PLAYER_JOIN)!
  const result = events.find(event => event.ApiTypeId === ApiType.EVT_HAND_RESULTS)!
  const template = events.find((event): event is ApiEvent<ApiType.EVT_ACTION> => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 3)!
  const output = events.slice(0, events.indexOf(template))
  const action = (seat: number, type: ActionType, chip: number, bet: number, phase: PhaseType, pot: number, next: ApiEvent<ApiType.EVT_ACTION>['Progress']['NextActionSeat']) => {
    const event = structuredClone(template)
    Object.assign(event, { SeatIndex: seat, ActionType: type, Chip: chip, BetChip: bet })
    event.Progress = { ...event.Progress, Phase: phase, Pot: pot, NextActionSeat: next, NextActionTypes: [] }
    output.push(event)
  }
  const street = (phase: PhaseType.FLOP | PhaseType.TURN | PhaseType.RIVER, cards: number[], heroChip: number, villainChip: number, pot: number) => {
    output.push({
      ApiTypeId: ApiType.EVT_DEAL_ROUND, CommunityCards: cards,
      Progress: { ...deal.Progress, MinRaise: 0, Phase: phase, Pot: pot, NextActionSeat: 5, NextActionTypes: [ActionType.CHECK, ActionType.BET, ActionType.ALL_IN] },
      Player: { ...deal.Player!, Chip: heroChip, BetChip: 0 },
      OtherPlayers: deal.OtherPlayers.map(player => ({ ...player, Status: 0, BetChip: 0,
        BetStatus: player.SeatIndex === 5 ? 1 : 2,
        Chip: player.SeatIndex === 5 ? villainChip : player.SeatIndex === 0 ? 2950 : player.Chip })),
    })
  }
  action(3, ActionType.CALL, 8050, 50, PhaseType.PREFLOP, 100, 5)
  street(PhaseType.FLOP, [5, 10, 15], 8050, 4875, 100)
  action(5, ActionType.BET, 4775, 100, PhaseType.FLOP, 200, 3)
  action(3, ActionType.CALL, 7950, 100, PhaseType.FLOP, 300, 5)
  street(PhaseType.TURN, [20], 7950, 4775, 300)
  action(5, ActionType.CHECK, 4775, 0, PhaseType.TURN, 300, 3)
  action(3, ActionType.CHECK, 7950, 0, PhaseType.TURN, 300, 5)
  street(PhaseType.RIVER, [25], 7950, 4775, 300)
  action(5, ActionType.BET, 4675, 100, PhaseType.RIVER, 400, 3)
  action(3, ActionType.CALL, 7850, 100, PhaseType.RIVER, 500, -2)
  result.CommunityCards = []
  result.Pot = 500
  result.Results = [
    { UserId: 3103, RankType: 1, HandRanking: 1, Hands: [], HoleCards: [4, 31], Ranking: -2, RewardChip: 500 },
    { UserId: 3104, RankType: 0, HandRanking: 2, Hands: [], HoleCards: [6, 32], Ranking: -2, RewardChip: 0 },
  ]
  result.Player!.Chip = 8350
  result.OtherPlayers.find(player => player.SeatIndex === 5)!.Chip = 4675
  result.HandId = unproven ? 940106 : 940105
  output.push(result)
  output.forEach((event, index) => { event.timestamp = (unproven ? 1734100500000 : 1734100400000) + index * 1000 })
  if (unproven) {
    const oldFold = output.find(event => event.ApiTypeId === ApiType.EVT_ACTION && event.SeatIndex === 0)!
    joinEvent.timestamp = oldFold.timestamp
    output.splice(output.indexOf(joinEvent), 1)
    output.splice(output.indexOf(oldFold), 0, joinEvent)
  }
  return output
}
