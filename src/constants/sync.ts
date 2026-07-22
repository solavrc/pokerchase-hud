/** Account-scoped upload rewind floor stored in PokerChaseDB.meta. */
export const SYNC_RESCAN_FLOOR_META_KEY = 'syncUnparseableFloor'

/** Account-scoped marker for the one-time below-watermark reconciliation. */
export const SYNC_RESCAN_BACKFILL_DONE_META_KEY = 'syncUnparseableFloorBackfillDoneV2'

export const isScopedSyncMetaKey = (id: string, baseKey: string): boolean =>
  id === baseKey || id.startsWith(`${baseKey}:`)
