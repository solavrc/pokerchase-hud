/**
 * Firestore Backup Service.
 *
 * Uses the Firestore REST API directly so the MV3 bundle does not include
 * Firebase SDK code that Chrome Web Store can classify as remote-code loaders.
 */

import { firebaseConfig } from './firebase-config'
import { firebaseAuthService } from './firebase-auth-service'
import type { ApiEvent } from '../types'
import { DATABASE_CONSTANTS } from '../constants/database'
import { getApiEventSequence } from '../utils/api-event-key'

/**
 * Sequence 0 intentionally retains the legacy document ID. This makes every
 * v3 row migrated to sequence 0 map to the document it may already have in
 * Firestore, so a reconciliation pass is an idempotent overwrite rather than
 * a second copy of history. Only additional same-ms/same-type rows append a
 * suffix and therefore need a new document name.
 */
export const getFirestoreEventDocumentId = (event: ApiEvent): string => {
  const sequence = getApiEventSequence(event)
  const legacyId = `${event.timestamp}_${event.ApiTypeId}`
  return sequence === 0 ? legacyId : `${legacyId}_${sequence}`
}

export interface BackupSummary {
  totalEvents: number
  syncedEvents: number
  lastSyncTime: Date
}

export interface CloudSyncOptions {
  onBatch: (events: ApiEvent[]) => Promise<void>
  onProgress?: (progress: { current: number, total: number }) => void
}

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { referenceValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } }

interface FirestoreDocument {
  name: string
  fields?: Record<string, FirestoreValue>
}

interface RunQueryResult {
  document?: FirestoreDocument
}

interface RunAggregationQueryResult {
  result?: {
    aggregateFields?: Record<string, FirestoreValue>
  }
}

interface CommitResponse {
  writeResults?: unknown[]
  commitTime?: string
}

interface EventQueryCursor {
  timestamp: FirestoreValue
  documentName: string
}

/**
 * Transport tuning knobs for `FirestoreBackupService.request()`. Production
 * uses the `DATABASE_CONSTANTS` defaults; tests inject small values so
 * timeout/backoff paths run in milliseconds instead of seconds.
 */
export interface FirestoreTransportOptions {
  requestTimeoutMs?: number
  retryBaseDelayMs?: number
  maxTransientRetries?: number
}

export class FirestoreBackupService {
  private readonly USERS_COLLECTION = 'users'
  private readonly EVENTS_COLLECTION = 'apiEvents'
  // Writes go through Firestore's :commit REST method, which applies at most
  // 500 writes atomically in a single request. Both of these must stay <=500.
  private readonly BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_BATCH_SIZE
  private readonly BATCH_DELAY_MS = DATABASE_CONSTANTS.FIRESTORE_BATCH_DELAY_MS
  private readonly DELETE_BATCH_SIZE = DATABASE_CONSTANTS.FIRESTORE_DELETE_BATCH
  private readonly DOWNLOAD_PAGE_SIZE = DATABASE_CONSTANTS.FIRESTORE_DOWNLOAD_PAGE_SIZE
  private readonly REQUEST_TIMEOUT_MS: number
  private readonly RETRY_BASE_DELAY_MS: number
  private readonly MAX_TRANSIENT_RETRIES: number
  private readonly documentsPath = `projects/${firebaseConfig.projectId}/databases/(default)/documents`
  private readonly baseUrl = `https://firestore.googleapis.com/v1/${this.documentsPath}`

  constructor(transportOptions?: FirestoreTransportOptions) {
    this.REQUEST_TIMEOUT_MS = transportOptions?.requestTimeoutMs ?? DATABASE_CONSTANTS.FIRESTORE_REQUEST_TIMEOUT_MS
    this.RETRY_BASE_DELAY_MS = transportOptions?.retryBaseDelayMs ?? DATABASE_CONSTANTS.FIRESTORE_RETRY_BASE_DELAY_MS
    this.MAX_TRANSIENT_RETRIES = transportOptions?.maxTransientRetries ?? DATABASE_CONSTANTS.FIRESTORE_TRANSIENT_RETRIES
  }

  /**
   * Sync local events to cloud (upload events newer than cloud's latest timestamp).
   */
  async syncToCloud(
    apiEvents: ApiEvent[],
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<BackupSummary> {
    const cloudMaxTimestamp = await this.getCloudMaxTimestamp()
    return await this.syncToCloudBatch(apiEvents, cloudMaxTimestamp, onProgress)
  }

  /**
   * Get cloud backup status.
   */
  async getCloudStatus(): Promise<{ eventCount: number }> {
    try {
      const user = await this.requireUser()
      return { eventCount: await this.countEventDocuments(user.uid) }
    } catch (error) {
      console.error('Failed to get cloud status:', error)
      return { eventCount: 0 }
    }
  }

  /**
   * Sync cloud events to local (cloud as source of truth).
   */
  async syncFromCloud(options: CloudSyncOptions): Promise<number> {
    try {
      const user = await this.requireUser()
      const total = await this.countEventDocuments(user.uid)
      let processed = 0

      for await (const documents of this.queryEventDocumentPages(user.uid)) {
        const events = documents.map(doc => decodeFields(doc.fields ?? {}) as ApiEvent)
        await options.onBatch(events)
        processed += events.length
        options.onProgress?.({ current: processed, total })
      }

      if (processed === 0) {
        options.onProgress?.({ current: 0, total })
      }

      console.log(`[Firestore] Downloaded ${processed} of ${total} matching cloud events`)
      return processed
    } catch (error) {
      console.error('Failed to sync from cloud:', error)
      throw new Error(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Get the latest timestamp from cloud events.
   *
   * Returns `null` ONLY when the cloud collection is PROVEN empty (a
   * successful query that returned zero documents for this user) -- never as
   * a stand-in for an auth/network/REST failure, which now throws instead of
   * being swallowed. This distinction is load-bearing for callers:
   * `AutoSyncService.backfillUnparseableFloorIfNeeded()` treats a `null`
   * result as "nothing has ever been uploaded, so there's no watermark to
   * backfill past" and permanently marks its one-time backfill done. Before
   * this fix, a transient error on the very first post-upgrade sync was
   * indistinguishable from a genuinely empty cloud, so it could permanently
   * suppress the only backfill attempt for a pre-existing unparseable row
   * (codex review round 4 on PR #182). Callers that want the old
   * swallow-to-null behavior (e.g. `updateTimestamps()`, a best-effort UI
   * value) must wrap this call in their own try/catch.
   */
  async getCloudMaxTimestamp(): Promise<number | null> {
    const events = await this.queryEvents('desc', 1)
    const latestEvent = events[0]
    return typeof latestEvent?.timestamp === 'number' ? latestEvent.timestamp : null
  }

  /**
   * Sync a batch of events to cloud with pre-fetched cloud max timestamp.
   */
  async syncToCloudBatch(
    apiEvents: ApiEvent[],
    cloudMaxTimestamp: number | null,
    onProgress?: (progress: { current: number, total: number }) => void
  ): Promise<BackupSummary> {
    const user = await this.requireUser()

    try {
      let processed = 0
      let synced = 0

      console.log(`[Firestore] Processing batch of ${apiEvents.length} upload candidates...`)

      const newEvents = cloudMaxTimestamp
        ? apiEvents.filter(event => (event.timestamp || 0) > cloudMaxTimestamp)
        : apiEvents

      console.log(`[Firestore] ${newEvents.length} events remain after the upload watermark filter`)

      const PARALLEL_BATCHES = DATABASE_CONSTANTS.FIRESTORE_PARALLEL_BATCHES
      for (let i = 0; i < newEvents.length; i += this.BATCH_SIZE * PARALLEL_BATCHES) {
        const batchPromises = []

        for (let j = 0; j < PARALLEL_BATCHES && i + j * this.BATCH_SIZE < newEvents.length; j++) {
          const startIndex = i + j * this.BATCH_SIZE
          const chunk = newEvents.slice(startIndex, startIndex + this.BATCH_SIZE)
          if (chunk.length === 0) break

          batchPromises.push(this.writeBatch(user.uid, chunk))
          synced += chunk.length
        }

        await Promise.all(batchPromises)
        processed = Math.min(i + this.BATCH_SIZE * PARALLEL_BATCHES, newEvents.length)

        if (onProgress) {
          onProgress({ current: processed, total: newEvents.length })
        }

        if (processed < newEvents.length) {
          await new Promise(resolve => setTimeout(resolve, this.BATCH_DELAY_MS))
        }
      }

      if (synced > 0) {
        const maxTimestamp = Math.max(...newEvents.map(e => e.timestamp || 0))
        await this.updateLastSyncTimestamp(user.uid, maxTimestamp)
      }

      return {
        totalEvents: apiEvents.length,
        syncedEvents: synced,
        lastSyncTime: new Date()
      }
    } catch (error) {
      console.error('Failed to sync batch to cloud:', error)
      throw new Error(`Cloud sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Delete all cloud events and user metadata.
   */
  async deleteAllCloudEvents(): Promise<void> {
    try {
      const user = await this.requireUser()
      console.log('[Firestore] Starting optimized delete...')

      let totalDeleted = 0

      while (true) {
        const docs = await this.queryEventDocuments(user.uid, 'asc', this.DELETE_BATCH_SIZE)
        if (docs.length === 0) break

        await this.commitWrites(docs.map(doc => ({ delete: doc.name })))
        totalDeleted += docs.length

        if (Math.floor(totalDeleted / 10000) > Math.floor((totalDeleted - docs.length) / 10000)) {
          console.log(`[Firestore] Deleted ${totalDeleted} events...`)
        }
      }

      await this.setUserMetadata(user.uid, {
        lastSyncTimestamp: null,
        lastSyncTime: null
      }).catch(error => {
        console.warn('[Firestore] Failed to clear user metadata:', error)
      })

      console.log(`[Firestore] Fast delete completed. Total deleted: ${totalDeleted} events`)
    } catch (error) {
      console.error('Failed to delete cloud events:', error)
      throw new Error(`Failed to delete cloud events: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private async writeBatch(uid: string, events: ApiEvent[]): Promise<void> {
    const writes = events.map(event => {
      const eventId = getFirestoreEventDocumentId(event)
      return {
        update: {
          name: `${this.documentsPath}/${this.docPath(this.USERS_COLLECTION, uid, this.EVENTS_COLLECTION, eventId)}`,
          fields: encodeFields(event as Record<string, unknown>)
        }
      }
    })

    // 429/RESOURCE_EXHAUSTED retry ownership lives in `request()`'s
    // transport-level classification (codex review r3617090429, P2, "Avoid
    // stacking 429 retries for write batches"): this method used to run its
    // own 3-attempt rate-limit loop on top, which -- once the transport
    // gained its own 429 backoff -- multiplied to up to 9 commit attempts
    // per batch under a persistent rate limit, amplifying the very
    // throttling being backed off from. Exactly one layer (the transport)
    // now retries 429; an error surfacing here has already exhausted that
    // bounded budget and must propagate.
    await this.commitWrites(writes)
  }

  private async updateLastSyncTimestamp(uid: string, timestamp: number): Promise<void> {
    try {
      await this.setUserMetadata(uid, {
        lastSyncTimestamp: timestamp,
        lastSyncTime: new Date().toISOString()
      })
    } catch (error) {
      console.error('Failed to update last sync timestamp:', error)
    }
  }

  private async setUserMetadata(uid: string, metadata: Record<string, unknown>): Promise<void> {
    await this.request(`${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: encodeFields(metadata) })
    })
  }

  private async queryEvents(direction: 'asc' | 'desc', maxResults?: number): Promise<ApiEvent[]> {
    const user = await this.requireUser()
    const docs = await this.queryEventDocuments(user.uid, direction, maxResults)
    return docs.map(doc => decodeFields(doc.fields ?? {}) as ApiEvent)
  }

  private async *queryEventDocumentPages(uid: string, initialCursor?: EventQueryCursor): AsyncGenerator<FirestoreDocument[]> {
    let cursor = initialCursor

    while (true) {
      const documents = await this.queryEventDocuments(
        uid,
        'asc',
        this.DOWNLOAD_PAGE_SIZE,
        cursor
      )
      if (documents.length === 0) break

      yield documents
      if (documents.length < this.DOWNLOAD_PAGE_SIZE) break

      const lastDocument = documents.at(-1)!
      const timestamp = lastDocument.fields?.timestamp
      if (!timestamp || !('integerValue' in timestamp)) {
        throw new Error(`Firestore event document lacks an integer timestamp: ${lastDocument.name}`)
      }
      cursor = { timestamp, documentName: lastDocument.name }
    }
  }

  private async queryEventDocuments(
    uid: string,
    direction: 'asc' | 'desc',
    maxResults?: number,
    cursor?: EventQueryCursor
  ): Promise<FirestoreDocument[]> {
    const results = await this.request<RunQueryResult[]>(`${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}:runQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: this.EVENTS_COLLECTION }],
          orderBy: [
            {
              field: { fieldPath: 'timestamp' },
              direction: direction === 'asc' ? 'ASCENDING' : 'DESCENDING'
            },
            {
              field: { fieldPath: '__name__' },
              direction: direction === 'asc' ? 'ASCENDING' : 'DESCENDING'
            }
          ],
          ...(cursor ? {
            startAt: {
              values: [
                cursor.timestamp,
                { referenceValue: cursor.documentName }
              ],
              before: false
            }
          } : {}),
          ...(maxResults ? { limit: maxResults } : {})
        }
      })
    }) ?? []

    return results.map(result => result.document).filter((doc): doc is FirestoreDocument => !!doc)
  }

  private async countEventDocuments(uid: string, cursor?: EventQueryCursor): Promise<number> {
    const alias = 'eventCount'
    const results = await this.request<RunAggregationQueryResult[]>(
      `${this.baseUrl}/${this.docPath(this.USERS_COLLECTION, uid)}:runAggregationQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structuredAggregationQuery: {
            structuredQuery: {
              from: [{ collectionId: this.EVENTS_COLLECTION }],
              ...(cursor ? {
                orderBy: [
                  { field: { fieldPath: 'timestamp' }, direction: 'ASCENDING' },
                  { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }
                ],
                startAt: {
                  values: [cursor.timestamp, { referenceValue: cursor.documentName }],
                  before: false
                }
              } : {})
            },
            aggregations: [{ alias, count: {} }]
          }
        })
      }
    ) ?? []

    const count = results[0]?.result?.aggregateFields?.[alias]
    return count && 'integerValue' in count ? Number(count.integerValue) : 0
  }

  /**
   * Apply up to 500 writes atomically via Firestore's `:commit` REST method.
   *
   * `:commit` (unlike `:batchWrite`) reports failures as a normal HTTP error
   * on the request itself (handled by `request()`'s `!response.ok` check),
   * rather than embedding a per-write `status` array inside an HTTP 200
   * response. That keeps failure handling identical to every other call in
   * this service (`setUserMetadata`, `runQuery`, ...) and means a write that
   * a security rule denies fails the whole call instead of silently
   * succeeding for the rest of the batch.
   */
  private async commitWrites(writes: Array<Record<string, unknown>>): Promise<void> {
    await this.request<CommitResponse>(`${this.baseUrl}:commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    })
  }

  /**
   * Hardened REST transport (release audit 2026-07-21, "Firestore fetchに
   * timeout/abort/401 refresh retryがなく同期が固着可能"): every Firestore
   * REST call in this service funnels through here, and used to be a single
   * bare `fetch` -- a stalled connection held `AutoSyncService.isSyncing`
   * (and therefore the forced-update safety gate) indefinitely, a transient
   * 5xx/network blip failed the whole sync pass outright, and an expired
   * token (401) had no recovery path.
   *
   * Behavior:
   * - TIMEOUT: each attempt is bounded by an `AbortController` timeout
   *   (`REQUEST_TIMEOUT_MS`, covering the response body read as well), so a
   *   hung fetch can never stall a sync pass forever.
   * - TRANSIENT RETRY: network errors, timeouts, HTTP 5xx and 429 are
   *   retried with exponential backoff (`RETRY_BASE_DELAY_MS * 2^n`), at
   *   most `MAX_TRANSIENT_RETRIES` extra attempts. Retrying is safe for
   *   every call in this service: reads (`:runQuery`/`:runAggregationQuery`)
   *   are side-effect-free, and writes (`:commit` upserts/deletes keyed by
   *   document name, metadata `PATCH`) are idempotent.
   * - 401 TOKEN REFRESH: a single retry after `getIdToken(true)` (forced
   *   refresh). Gated on the auth generation (`firebaseAuthService.
   *   getAuthGeneration()`) still matching the value snapshotted BEFORE the
   *   initial token acquisition -- if the signed-in account changed
   *   mid-request (including an A -> B -> A round trip, which a uid
   *   comparison would miss), the retry is ABORTED instead of silently
   *   re-issuing the request against whichever account is live now. A 401
   *   on the refreshed token is terminal (no second refresh).
   * - BOUNDED AUTH: every auth-service await in this method (the `ready()`
   *   restore, the initial `getIdToken()`, and the 401 path's
   *   `getIdToken(true)`) goes through `boundedAuthAcquisition()` -- the
   *   same timeout discipline as the fetches themselves, so a stalled
   *   Secure Token endpoint (or storage restore) fails the request instead
   *   of stalling it indefinitely outside the timeout budget.
   * - NON-RETRYABLE: any other 4xx (permission denied, bad request, ...)
   *   throws immediately, preserving the pre-existing
   *   `Firestore REST request failed: <status> <body>` message shape that
   *   callers (e.g. `writeBatch`'s RESOURCE_EXHAUSTED check) match on.
   */
  private async request<T = unknown>(url: string, init: RequestInit): Promise<T | null> {
    // SNAPSHOT ORDER (codex review r3617090425, P2, "Snapshot auth
    // generation before awaiting the token"): the generation snapshot must
    // be taken BEFORE the awaited `getIdToken()` call, not after it --
    // `getIdToken()` internally awaits a network token refresh when the
    // cached token is expired, and an account switch landing during THAT
    // await used to be invisible: the old account's refreshed token came
    // back while the snapshot recorded the NEW account's generation as the
    // baseline, so a later 401 passed `assertAccountUnchanged` and re-issued
    // the old account's request with the new account's token. `ready()` is
    // awaited explicitly first so the initial-restore generation bump (every
    // Service Worker start does one) settles before the snapshot -- after
    // that, the counter only moves on a real sign-in/sign-out transition.
    // The assert right after the token acquisition fails fast: if the
    // account switched while the initial token was being fetched/refreshed,
    // the request aborts before anything is sent under an ambiguous identity.
    //
    // BOTH awaits are bounded (codex review r3617258715, P2, "Bound the
    // initial token refresh too"): when the cached token is expired, the
    // INITIAL `getIdToken()` performs the exact same unbounded Secure Token
    // API fetch as the 401 path's forced refresh -- it runs before
    // `fetchWithTimeout()` ever gets involved, so without this bound a
    // stalled token endpoint left the sync pass hanging outside every
    // timeout budget. Same discipline applied to `ready()` for completeness
    // (storage-only, but an unbounded await is an unbounded await).
    await this.boundedAuthAcquisition(() => firebaseAuthService.ready(), 'auth state restore')
    const generationAtStart = firebaseAuthService.getAuthGeneration()
    let token = await this.boundedAuthAcquisition(() => firebaseAuthService.getIdToken(), 'initial token acquisition')
    this.assertAccountUnchanged(generationAtStart, 'after initial token acquisition')
    let authRetryUsed = false
    let transientRetriesUsed = 0

    while (true) {
      let outcome: { ok: boolean, status: number, text: string }
      try {
        outcome = await this.fetchWithTimeout(url, init, token)
      } catch (error) {
        const timedOut = (error as { name?: string })?.name === 'AbortError'
        if (transientRetriesUsed < this.MAX_TRANSIENT_RETRIES) {
          transientRetriesUsed++
          console.warn(`[Firestore] ${timedOut ? 'Request timed out' : 'Network error'}, retrying (${transientRetriesUsed}/${this.MAX_TRANSIENT_RETRIES})...`)
          await this.delayBeforeRetry(transientRetriesUsed)
          continue
        }
        throw new Error(timedOut
          ? `Firestore REST request timed out after ${this.REQUEST_TIMEOUT_MS}ms`
          : `Firestore REST request failed: network error (${error instanceof Error ? error.message : 'Unknown error'})`)
      }

      if (outcome.ok) {
        if (!outcome.text.trim()) return null
        try {
          return JSON.parse(outcome.text) as T
        } catch (error) {
          throw new Error(
            `Firestore REST response was invalid JSON (${outcome.text.length} bytes): ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        }
      }

      if (outcome.status === 401 && !authRetryUsed) {
        // Abort (do not refresh, do not retry) if the signed-in account
        // changed since this request started -- both before AND after the
        // refresh await, which is itself a window for a switch to land.
        this.assertAccountUnchanged(generationAtStart, 'before 401 token-refresh retry')
        console.warn('[Firestore] Request returned 401, force-refreshing token and retrying once...')
        token = await this.boundedAuthAcquisition(() => firebaseAuthService.getIdToken(true), 'forced token refresh')
        this.assertAccountUnchanged(generationAtStart, 'after 401 token refresh')
        authRetryUsed = true
        continue
      }

      const transientStatus = outcome.status === 429 || outcome.status >= 500
      if (transientStatus && transientRetriesUsed < this.MAX_TRANSIENT_RETRIES) {
        transientRetriesUsed++
        console.warn(`[Firestore] Request failed with ${outcome.status}, retrying (${transientRetriesUsed}/${this.MAX_TRANSIENT_RETRIES})...`)
        await this.delayBeforeRetry(transientRetriesUsed)
        continue
      }

      throw new Error(`Firestore REST request failed: ${outcome.status} ${outcome.text}`)
    }
  }

  /**
   * One fetch attempt bounded by `REQUEST_TIMEOUT_MS` via `AbortController`.
   * The timer also covers `response.text()` (cleared only after the body is
   * fully read), so a connection that stalls mid-body is aborted too.
   */
  private async fetchWithTimeout(url: string, init: RequestInit, token: string): Promise<{ ok: boolean, status: number, text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      })
      const text = await response.text()
      return { ok: response.ok, status: response.status, text }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Runs one auth-service acquisition bounded by the same transport timeout
   * as the requests themselves. Used for EVERY auth await in `request()`:
   * the `ready()` restore, the initial `getIdToken()`, and the 401 path's
   * `getIdToken(true)`.
   *
   * WHY (codex reviews r3617177865 + r3617258715, P2 x2, "Bound the forced
   * token refresh" / "Bound the initial token refresh too"):
   * `FirebaseAuthService.getIdToken()` performs its own Secure Token API
   * `fetch` WITHOUT an `AbortController` whenever the cached token is
   * expired -- and BOTH acquisition sites can hit that path, the forced 401
   * refresh and the very first `getIdToken()` of a request alike. Each runs
   * outside `fetchWithTimeout()`'s budget, so a bare await on either meant
   * a stalled token endpoint left the sync pass hanging with
   * `AutoSyncService._isSyncing` latched indefinitely -- exactly the stall
   * this transport hardening exists to prevent.
   *
   * Bounded from the CALLER side via `Promise.race` (`firebase-auth-service.
   * ts` is deliberately untouched -- other callers keep its existing
   * semantics). A timeout is terminal for this request: treated as an auth
   * failure, surfaced as an error, no retry. The losing promise is not
   * cancelled (nothing to abort without touching the auth service); a late
   * settle just updates the auth service's own cached state harmlessly, and
   * its potential late REJECTION is explicitly observed so it can never
   * surface as an unhandled rejection.
   */
  private async boundedAuthAcquisition<T>(acquire: () => Promise<T>, label: string): Promise<T> {
    const acquisition = acquire()
    // Observe (don't act on) a rejection that lands after the race is lost.
    acquisition.catch(() => { })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        acquisition,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Firestore ${label} timed out after ${this.REQUEST_TIMEOUT_MS}ms`)),
            this.REQUEST_TIMEOUT_MS
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private async delayBeforeRetry(retryNumber: number): Promise<void> {
    const delayMs = this.RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1)
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  /**
   * Throws if the auth-state generation moved since `generationAtStart` --
   * i.e. the signed-in account changed (sign-in/sign-out/switch, including an
   * A -> B -> A round trip) while this request was in flight. Deliberately a
   * generation comparison, not a uid comparison, for the same ABA rationale
   * as `AutoSyncService.assertGenerationUnchanged()`.
   */
  private assertAccountUnchanged(generationAtStart: number, context: string): void {
    if (firebaseAuthService.getAuthGeneration() !== generationAtStart) {
      throw new Error(`Firestore request aborted (${context}): the signed-in account changed while the request was in flight`)
    }
  }

  private async requireUser() {
    await firebaseAuthService.ready()
    const user = firebaseAuthService.getCurrentUser()
    if (!user) {
      throw new Error('User not authenticated')
    }
    return user
  }

  private docPath(...segments: string[]): string {
    return segments.map(segment => encodeURIComponent(segment)).join('/')
  }

}

function encodeFields(input: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)])
  )
}

function encodeValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } }
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } }
  }
  return { stringValue: String(value) }
}

function decodeFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])
  )
}

function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null
  if ('booleanValue' in value) return value.booleanValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('stringValue' in value) return value.stringValue
  if ('referenceValue' in value) return value.referenceValue
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue)
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {})
  return null
}

export const firestoreBackupService = new FirestoreBackupService()
