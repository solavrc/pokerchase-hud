import type { Action, Hand } from '../types/entities'
import { ActionType, PhaseType } from '../types/game'

/** 人物帰属で除外した行を、失敗した試行やwalkの証拠にしない（MUST NOT）。 */
export function getPreflopStatOpportunities(hand: Hand, playerId: number, preflopActions: readonly Action[]) {
  const omitted = hand.preflopIdentityUnprovenPlayerIds?.includes(playerId) === true
  const acted = preflopActions.length > 0
  const opportunity = acted || (!omitted && hand.bigBlindUserId !== playerId)
  const raised = preflopActions.some(action => !action.normalizationUnproven && action.actionType === ActionType.RAISE)
  const folded = preflopActions.some(action => action.actionType === ActionType.FOLD)
  // 初回分類が判明すればVPIPは閉じる。PFRの否定には、その後のraise可能性も閉じる必要がある。
  return {
    vpip: opportunity,
    pfr: raised || (opportunity && (!omitted || folded) &&
      !preflopActions.some(action => action.normalizationUnproven)),
  }
}

/** legacy集計でも台帳と同じ人物・hand単位の分母を使う。 */
export function countPreflopStatOpportunities(playerId: number, actions: readonly Action[], hands: readonly Hand[]) {
  const byHand = new Map<number, Action[]>()
  for (const action of actions) {
    if (action.phase !== PhaseType.PREFLOP || action.handId === undefined) continue
    const grouped = byHand.get(action.handId) ?? []
    grouped.push(action)
    byHand.set(action.handId, grouped)
  }
  let vpip = 0
  let pfr = 0
  for (const hand of hands) {
    const trial = getPreflopStatOpportunities(hand, playerId, byHand.get(hand.id) ?? [])
    vpip += Number(trial.vpip)
    pfr += Number(trial.pfr)
  }
  return { vpip, pfr }
}
