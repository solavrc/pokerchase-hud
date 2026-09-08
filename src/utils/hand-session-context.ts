import type { ApiEvent, ApiType, Hand } from '../types'

type HandSession = Hand['session']

/** getterを持つSessionStateも、ハンド所有の3フィールドとして一体で読む。 */
export const snapshotHandSession = (session: HandSession): Readonly<HandSession> => Object.freeze({
  id: session.id,
  battleType: session.battleType,
  name: session.name,
})

// worker内のDEALだけに付くcontext。Raw Lakeや永続schemaには混ぜない。
const sessionByDeal = new WeakMap<ApiEvent<ApiType.EVT_DEAL>, Readonly<HandSession>>()

export const captureHandSession = (deal: ApiEvent<ApiType.EVT_DEAL>, session: HandSession): void => {
  // 完成bufferの再評価や同じDEALの再処理で、次sessionへ書き換えない（MUST NOT）。
  if (!sessionByDeal.has(deal)) sessionByDeal.set(deal, snapshotHandSession(session))
}

export const getHandSession = (deal: ApiEvent<ApiType.EVT_DEAL>): Readonly<HandSession> | undefined =>
  sessionByDeal.get(deal)
