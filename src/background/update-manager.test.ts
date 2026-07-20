/**
 * Unit tests for the forced-update auto-apply manager (src/background/update-manager.ts).
 *
 * Covers: safety predicate (all unsafe combinations), the pending-update flow
 * (onUpdateAvailable unsafe -> pending -> session-end applies), badge
 * precedence against rebuild-advisory, and applyUpdateNow()'s reason paths.
 */
import {
  handleUpdateAvailable,
  recheckPendingUpdate,
  applyUpdateNow,
  isSafeToUpdate,
  markSessionActive,
  markSessionInactive,
  getPendingUpdateState,
  initUpdateManager,
  PENDING_UPDATE_STORAGE_KEY,
  __resetUpdateManagerStateForTests,
} from './update-manager'
import { setOperationState } from './operation-state'
import { REBUILD_ADVISORY_STORAGE_KEY } from './rebuild-advisory'
import { REBUILD_ADVISORY_VERSION } from '../constants/database'
import { autoSyncService } from '../services/auto-sync-service'

describe('update-manager', () => {
  beforeEach(async () => {
    __resetUpdateManagerStateForTests()
    setOperationState({ type: 'idle' })
    ;(autoSyncService as any)._isSyncing = false
    await chrome.storage.local.set({
      [PENDING_UPDATE_STORAGE_KEY]: undefined,
      [REBUILD_ADVISORY_STORAGE_KEY]: undefined,
    })
    jest.clearAllMocks()
  })

  describe('isSafeToUpdate (safety predicate)', () => {
    it('is unsafe when session activity is unknown (conservative default, e.g. right after SW start)', () => {
      // markSessionActive/Inactive never called -- stays 'unknown'
      expect(isSafeToUpdate()).toBe(false)
    })

    it('is unsafe while a session is active (between EVT_SESSION_DETAILS and EVT_SESSION_RESULTS)', () => {
      markSessionActive()
      expect(isSafeToUpdate()).toBe(false)
    })

    it('is unsafe when AutoSyncService.isSyncing is true, even with an inactive session and idle operations', () => {
      markSessionInactive()
      ;(autoSyncService as any)._isSyncing = true
      expect(isSafeToUpdate()).toBe(false)
    })

    it('is unsafe when an operation (export/import/rebuild) is in progress', () => {
      markSessionInactive()
      setOperationState({ type: 'rebuild', progress: 50 })
      expect(isSafeToUpdate()).toBe(false)
    })

    it('is safe only when session is inactive, not syncing, and operation is idle', () => {
      markSessionInactive()
      ;(autoSyncService as any)._isSyncing = false
      setOperationState({ type: 'idle' })
      expect(isSafeToUpdate()).toBe(true)
    })

    it('becomes unsafe again once a new session becomes active after being marked inactive', () => {
      markSessionInactive()
      expect(isSafeToUpdate()).toBe(true)
      markSessionActive()
      expect(isSafeToUpdate()).toBe(false)
    })
  })

  describe('handleUpdateAvailable', () => {
    it('applies immediately (reload) when the current window is safe', async () => {
      markSessionInactive()

      await handleUpdateAvailable({ version: '5.2.0' })

      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(false)
    })

    it('records a pending update and sets the badge when unsafe (session active)', async () => {
      markSessionActive()

      await handleUpdateAvailable({ version: '5.2.0' })

      expect(chrome.runtime.reload).not.toHaveBeenCalled()
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(true)
      expect(state.version).toBe('5.2.0')
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'UPD' })
    })

    it('does not set its badge when a rebuild-advisory badge is already pending (precedence)', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { pendingVersion: REBUILD_ADVISORY_VERSION },
      })
      markSessionActive()

      await handleUpdateAvailable({ version: '5.2.0' })

      const state = await getPendingUpdateState()
      expect(state.pending).toBe(true) // still tracked internally
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled() // but badge not clobbered
    })
  })

  describe('pending-update flow: onUpdateAvailable (unsafe) -> pending -> session-end applies', () => {
    it('applies the pending update once the session ends (markSessionInactive + recheck)', async () => {
      markSessionActive()
      await handleUpdateAvailable({ version: '5.2.0' })
      expect(chrome.runtime.reload).not.toHaveBeenCalled()

      // Session ends (mirrors event-ingestion.ts's EVT_SESSION_RESULTS hook)
      markSessionInactive()
      await recheckPendingUpdate()

      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(false)
    })

    it('stays pending (no reload) if still unsafe at recheck time', async () => {
      markSessionActive()
      await handleUpdateAvailable({ version: '5.2.0' })

      // Session still active -- recheck should not apply
      await recheckPendingUpdate()

      expect(chrome.runtime.reload).not.toHaveBeenCalled()
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(true)
    })

    it('recheckPendingUpdate is a no-op when nothing is pending', async () => {
      markSessionInactive()
      await recheckPendingUpdate()
      expect(chrome.runtime.reload).not.toHaveBeenCalled()
    })

    it('clears a stale pending-update flag on recheck when Chrome already installed it outside this manager (codex review P2, e.g. full browser restart)', async () => {
      // Pending update recorded while unsafe (session active) -- never got a
      // chance to reload via this manager.
      markSessionActive()
      await handleUpdateAvailable({ version: '5.2.0' })
      expect(chrome.runtime.reload).not.toHaveBeenCalled()
      jest.clearAllMocks()

      // Chrome restarts and applies the downloaded update on its own; the
      // running extension version now matches what we recorded as pending.
      // Session activity resets to 'unknown' (fresh SW), which alone would
      // otherwise keep the state "unsafe" forever and never clear the badge.
      __resetUpdateManagerStateForTests()
      ;(chrome.runtime.getManifest as jest.Mock).mockReturnValue({ version: '5.2.0' })

      await recheckPendingUpdate()

      // Must clear via the version-match short-circuit, NOT via a reload
      // (Chrome already did the reload/relaunch itself).
      expect(chrome.runtime.reload).not.toHaveBeenCalled()
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(false)
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' })

      // Restore the default manifest version for subsequent tests --
      // jest.clearAllMocks() (in this file's beforeEach) clears call history
      // but not a mockReturnValue override.
      ;(chrome.runtime.getManifest as jest.Mock).mockReturnValue({ version: '5.1.0' })
    })

    it('does NOT clear a pending update on recheck when the running version still differs from the recorded pending version', async () => {
      markSessionActive()
      await handleUpdateAvailable({ version: '5.3.0' })
      jest.clearAllMocks()

      // Still on the old version (5.1.0, the test-setup default) -- the
      // pending 5.3.0 update has genuinely not been applied yet.
      markSessionActive() // still unsafe for an unrelated reason too

      await recheckPendingUpdate()

      expect(chrome.runtime.reload).not.toHaveBeenCalled()
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(true)
      expect(state.version).toBe('5.3.0')
    })

    it('re-asserts the badge on recheck once the rebuild-advisory badge that was blocking it has cleared', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { pendingVersion: REBUILD_ADVISORY_VERSION },
      })
      markSessionActive()
      await handleUpdateAvailable({ version: '5.2.0' })
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()

      // Rebuild advisory resolved (e.g. user ran rebuild) -- badge is now free
      await chrome.storage.local.set({ [REBUILD_ADVISORY_STORAGE_KEY]: undefined })
      jest.clearAllMocks()

      await recheckPendingUpdate() // still unsafe (session active) -> stays pending, reasserts badge
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'UPD' })
    })
  })

  describe('applyUpdateNow (popup "今すぐ適用" button)', () => {
    it('applies and clears pending state when safe', async () => {
      // Pending update recorded while unsafe (session active)
      markSessionActive()
      await handleUpdateAvailable({ version: '5.3.0' })
      jest.clearAllMocks()

      // Session ends -- now safe when the user clicks "今すぐ適用"
      markSessionInactive()
      const result = await applyUpdateNow()

      expect(result).toEqual({ applied: true })
      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
      const state = await getPendingUpdateState()
      expect(state.pending).toBe(false)
    })

    it('returns a reason and keeps pending when unsafe (session active)', async () => {
      markSessionActive()

      const result = await applyUpdateNow()

      expect(result.applied).toBe(false)
      expect(result.reason).toBe('ゲームセッション中のため適用できません')
      expect(chrome.runtime.reload).not.toHaveBeenCalled()
    })

    it('returns a reason when unsafe due to active cloud sync', async () => {
      markSessionInactive()
      ;(autoSyncService as any)._isSyncing = true

      const result = await applyUpdateNow()

      expect(result.applied).toBe(false)
      expect(result.reason).toBe('クラウド同期中のため適用できません')
    })

    it('returns a reason when unsafe due to an in-progress operation', async () => {
      markSessionInactive()
      setOperationState({ type: 'export', format: 'json', progress: 10 })

      const result = await applyUpdateNow()

      expect(result.applied).toBe(false)
      expect(result.reason).toBe('他の処理が実行中のため適用できません')
    })
  })

  describe('initUpdateManager (wiring)', () => {
    it('registers onUpdateAvailable listener, triggers an update check, and creates the alarm when none exists yet', async () => {
      markSessionInactive()
      ;(chrome.alarms.get as jest.Mock).mockResolvedValue(undefined) // no alarm scheduled yet (e.g. first install)

      initUpdateManager()

      expect(chrome.runtime.onUpdateAvailable.addListener).toHaveBeenCalledTimes(1)
      expect(chrome.runtime.requestUpdateCheck).toHaveBeenCalledTimes(1)
      // The onAlarm listener registration is synchronous (before the
      // alarms.get() await), unlike alarm creation below.
      expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1)

      // setupUpdateCheckAlarm() awaits chrome.alarms.get() before deciding
      // whether to create -- flush the microtask queue for that to resolve.
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(chrome.alarms.get).toHaveBeenCalledWith('pokerchase-hud-update-check')
      expect(chrome.alarms.create).toHaveBeenCalledWith(
        'pokerchase-hud-update-check',
        { periodInMinutes: 6 * 60 }
      )
    })

    it('does NOT recreate the update-check alarm on SW startup when one is already scheduled (codex review, PR #150 audit finding #3)', async () => {
      // Regression for: chrome.alarms.create() with an existing alarm name
      // cancels and replaces it, resetting its periodInMinutes countdown.
      // Calling it unconditionally on every initUpdateManager() (i.e. every
      // SW startup) meant a SW that restarts more often than the 6h period
      // would keep postponing the periodic check indefinitely, leaving only
      // the throttled startup requestUpdateCheck() call.
      markSessionInactive()
      const scheduledTime = Date.now() + 3 * 60 * 60 * 1000 // 3h from now
      ;(chrome.alarms.get as jest.Mock).mockResolvedValue({
        name: 'pokerchase-hud-update-check',
        scheduledTime,
        periodInMinutes: 6 * 60,
      })

      initUpdateManager()
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(chrome.alarms.get).toHaveBeenCalledWith('pokerchase-hud-update-check')
      expect(chrome.alarms.create).not.toHaveBeenCalled()
      // The onAlarm listener still gets (re-)registered every startup --
      // only the schedule-resetting create() call is skipped.
      expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1)

      // Restore the default "no alarm scheduled" resolution for subsequent
      // tests -- jest.clearAllMocks() (in this file's beforeEach) clears
      // call history but not a mockResolvedValue override.
      ;(chrome.alarms.get as jest.Mock).mockResolvedValue(undefined)
    })

    it('re-checks (and applies) any pending update left over from before the SW restart', async () => {
      markSessionActive()
      await handleUpdateAvailable({ version: '5.2.0' })
      jest.clearAllMocks()

      // Simulate SW restart: module-level sessionActivity resets to 'unknown',
      // but the session has actually ended by now (storage-backed pending
      // state survives; markSessionInactive mirrors a fresh 309 having
      // already been observed by this new SW instance).
      __resetUpdateManagerStateForTests()
      markSessionInactive()

      initUpdateManager()
      // recheckPendingUpdate() inside initUpdateManager is fire-and-forget
      // from the caller's perspective in this test (its return value is
      // ignored here); flush the macrotask queue so its promise chain
      // (storage get -> check -> storage set -> reload) fully resolves
      // before asserting.
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1)
    })

    it('returns the SW-startup recheckPendingUpdate() promise, so awaiting it (instead of a manual macrotask flush) is enough to observe stale pending-update cleanup having completed (codex review, PR #172)', async () => {
      // Record a pending update, then simulate Chrome having applied it
      // out-of-band (browser restart) by making the running manifest
      // version match the recorded pending version -- recheckPendingUpdate()
      // must clear the now-stale pending state in this case.
      markSessionActive()
      await handleUpdateAvailable({ version: '5.2.0' })
      expect((await getPendingUpdateState()).pending).toBe(true)

      __resetUpdateManagerStateForTests()
      jest.clearAllMocks()
      ;(chrome.runtime.getManifest as jest.Mock).mockReturnValueOnce({ version: '5.2.0' })

      // background.ts sequences reassertWhatsNewBadgeOnStartup() after this
      // promise specifically to avoid reading pendingUpdate mid-cleanup;
      // this asserts that sequencing point actually works -- no extra
      // setTimeout(0) flush, just awaiting the returned promise directly.
      await initUpdateManager()

      expect(await getPendingUpdateState()).toEqual({ pending: false })
    })
  })
})
