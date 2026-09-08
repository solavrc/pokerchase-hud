import type { ApiEvent, ApiHandEvent, ApiType, Hand, Session } from '../types'

type HandSession = Hand['session']
type HandPlayerInfo = { name: string, rank: string }

export interface HandRuntimeContext {
  session: Readonly<HandSession>
  players: ReadonlyMap<number, Readonly<HandPlayerInfo>>
}

/**
 * AggregateEventsStream が確定済みハンドを下流へ渡すときの immutable work。
 * events 自体は Raw Lake の payload 参照で、session/名簿は先頭 DEAL の
 * worker-local context から取得する。永続 schema には追加しない。
 */
export interface CompletedHandWork {
  handId: number
  events: readonly ApiHandEvent[]
}

/** getterを持つSessionStateも、ハンド所有の3フィールドとして一体で読む。 */
export const snapshotHandSession = (session: HandSession): Readonly<HandSession> => Object.freeze({
  id: session.id,
  battleType: session.battleType,
  name: session.name,
})

const snapshotPlayers = (
  players: Session['players']
): ReadonlyMap<number, Readonly<HandPlayerInfo>> => new Map(
  [...players].map(([userId, info]) => [userId, Object.freeze({ ...info })])
)

// worker内のDEALだけに付くcontext。Raw Lakeや永続schemaには混ぜない。
const contextByDeal = new WeakMap<ApiEvent<ApiType.EVT_DEAL>, HandRuntimeContext>()

export const captureHandSession = (deal: ApiEvent<ApiType.EVT_DEAL>, session: Session): void => {
  // 完成bufferの再評価や同じDEALの再処理で、次sessionへ書き換えない（MUST NOT）。
  if (!contextByDeal.has(deal)) {
    contextByDeal.set(deal, {
      session: snapshotHandSession(session),
      players: snapshotPlayers(session.players),
    })
  }
}

export const getHandSession = (deal: ApiEvent<ApiType.EVT_DEAL>): Readonly<HandSession> | undefined =>
  contextByDeal.get(deal)?.session

export const getHandRuntimeContext = (
  deal: ApiEvent<ApiType.EVT_DEAL>
): HandRuntimeContext | undefined => contextByDeal.get(deal)
