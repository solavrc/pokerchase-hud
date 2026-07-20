/**
 * Remote minimum-version gate ("kill switch").
 *
 * Reads a single public-read Firestore document (`config/client`, field
 * `minSupportedVersion`) via the same REST API `firestore-backup-service.ts`
 * uses, but WITHOUT authentication — this doc is deliberately readable by
 * anyone (`firestore.rules`: `match /config/client { allow read: if true;
 * allow write: if false }`), since the extension must be able to check it
 * before/without a signed-in user.
 *
 * Fail-open by design: any fetch error, missing doc, or malformed version
 * value is treated as "supported" (never blocks the extension on a broken
 * or absent remote config). This module only ever *disables cloud sync*;
 * it never disables the HUD itself (stats are computed entirely locally).
 *
 * Result is cached in `chrome.storage.local` with a 12h TTL so a normal
 * session doesn't re-fetch on every Service Worker wake.
 */
import { firebaseConfig } from './firebase-config'
import { isVersionBelow } from '../utils/version-compare'

export const MIN_VERSION_GATE_STORAGE_KEY = 'minVersionGateState'

const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12 hours

export interface MinVersionGateState {
  /** `false` only when the doc was readable, well-formed, and current < minSupportedVersion */
  supported: boolean
  minSupportedVersion?: string
  checkedAt: number
  /**
   * The extension version this result was computed for. A mismatch against
   * the currently-running version (e.g. right after the extension itself
   * updated) invalidates the cache immediately, regardless of the 12h TTL --
   * otherwise a stale `supported: false` computed for an old version could
   * keep blocking cloud sync / showing the unsupported warning for up to
   * 12h after the extension already updated to a supported version
   * (codex#3612092776).
   */
  checkedVersion?: string
}

const documentsPath = `projects/${firebaseConfig.projectId}/databases/(default)/documents`

/**
 * Unauthenticated GET of `config/client` using the Firestore REST API with
 * just the project's public API key (`?key=...`) — no `Authorization`
 * header, matching the "public read" rule. Shape mirrors
 * `FirestoreBackupService`'s `baseUrl` (`https://firestore.googleapis.com/v1/
 * projects/{projectId}/databases/(default)/documents`), plus the doc path
 * and `key` query param instead of a bearer token.
 */
const buildConfigClientUrl = (): string =>
  `https://firestore.googleapis.com/v1/${documentsPath}/config/client?key=${firebaseConfig.apiKey}`

const supportedFailOpen = (currentVersion: string, minSupportedVersion?: string): MinVersionGateState => ({
  supported: true,
  minSupportedVersion,
  checkedAt: Date.now(),
  checkedVersion: currentVersion
})

/** Fetches and evaluates the remote gate. Never throws — every failure path fails open. */
const fetchMinVersionGateState = async (currentVersion: string): Promise<MinVersionGateState> => {
  let response: Response
  try {
    response = await fetch(buildConfigClientUrl())
  } catch (error) {
    console.warn('[min-version-gate] Fetch failed, failing open:', error)
    return supportedFailOpen(currentVersion)
  }

  if (!response.ok) {
    // 404 = doc doesn't exist yet (owner hasn't created it), or any other
    // transient/HTTP error -- both fail open the same way.
    console.warn(`[min-version-gate] REST request failed (${response.status}), failing open`)
    return supportedFailOpen(currentVersion)
  }

  let body: any
  try {
    body = await response.json()
  } catch (error) {
    console.warn('[min-version-gate] Response was not valid JSON, failing open:', error)
    return supportedFailOpen(currentVersion)
  }

  const minSupportedVersion = body?.fields?.minSupportedVersion?.stringValue
  if (typeof minSupportedVersion !== 'string' || minSupportedVersion.length === 0) {
    console.warn('[min-version-gate] Missing/malformed minSupportedVersion field, failing open')
    return supportedFailOpen(currentVersion)
  }

  const below = isVersionBelow(currentVersion, minSupportedVersion)
  return {
    supported: !below,
    minSupportedVersion,
    checkedAt: Date.now(),
    checkedVersion: currentVersion
  }
}

/**
 * Returns the current gate state, using a 12h-TTL cache in
 * `chrome.storage.local`. Pass `now` only from tests.
 */
export const checkMinVersionGate = async (currentVersion: string, now = Date.now()): Promise<MinVersionGateState> => {
  const stored = await chrome.storage.local.get(MIN_VERSION_GATE_STORAGE_KEY)
  const cached = stored?.[MIN_VERSION_GATE_STORAGE_KEY] as MinVersionGateState | undefined

  // codex#3612092776: a cache computed for a different extension version
  // (most commonly: right after the extension itself updated) is stale
  // regardless of the TTL -- re-check immediately rather than serving up
  // to 12h of a possibly-wrong `supported` value for the new version.
  if (cached && cached.checkedVersion === currentVersion && now - cached.checkedAt < CACHE_TTL_MS) {
    return cached
  }

  const fresh = await fetchMinVersionGateState(currentVersion)
  await chrome.storage.local.set({ [MIN_VERSION_GATE_STORAGE_KEY]: fresh })
  return fresh
}

/** Cached state only, without triggering a fetch (for read-only callers like AutoSyncService's guard). */
export const getCachedMinVersionGateState = async (): Promise<MinVersionGateState | undefined> => {
  const stored = await chrome.storage.local.get(MIN_VERSION_GATE_STORAGE_KEY)
  return stored?.[MIN_VERSION_GATE_STORAGE_KEY] as MinVersionGateState | undefined
}

/**
 * `true` when cloud sync should be stopped (current version below the
 * remote-configured minimum). Reads/refreshes the TTL cache via
 * `checkMinVersionGate` — safe to call from a hot path (`AutoSyncService`
 * entry points) since it only hits the network at most once per 12h.
 */
export const isCloudSyncBlockedByMinVersionGate = async (): Promise<boolean> => {
  const currentVersion = chrome.runtime.getManifest().version
  const state = await checkMinVersionGate(currentVersion)
  return !state.supported
}
