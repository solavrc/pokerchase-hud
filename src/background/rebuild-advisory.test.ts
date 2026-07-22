/**
 * Unit tests for the rebuild advisory (src/background/rebuild-advisory.ts)
 */
import {
  checkOnUpdate,
  resolveAdvisory,
  getRebuildAdvisoryState,
  REBUILD_ADVISORY_STORAGE_KEY,
} from './rebuild-advisory'
import { REBUILD_ADVISORY_VERSION } from '../constants/database'
import type { PokerChaseDB } from '../db/poker-chase-db'

describe('rebuild-advisory', () => {
  let mockDb: jest.Mocked<PokerChaseDB>

  beforeEach(async () => {
    // Clear chrome.storage.local between tests
    await chrome.storage.local.set({ [REBUILD_ADVISORY_STORAGE_KEY]: undefined })
    jest.clearAllMocks()

    mockDb = {
      apiEvents: {
        count: jest.fn()
      }
    } as any
  })

  describe('checkOnUpdate', () => {
    it('sets pendingVersion and notifies when data exists and version is unacknowledged', async () => {
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(42)

      await checkOnUpdate(mockDb)

      const state = await getRebuildAdvisoryState()
      expect(state.pendingVersion).toBe(REBUILD_ADVISORY_VERSION)
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalled()
      expect(chrome.notifications.create).toHaveBeenCalledTimes(1)
      const [notification] = (chrome.notifications.create as jest.Mock).mock.calls[0]
      expect(notification.type).toBe('basic')
      expect(notification.title).toEqual(expect.any(String))
      expect(notification.message).toEqual(expect.any(String))
    })

    it('silently acknowledges when there is no existing data (nothing to rebuild)', async () => {
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(0)

      await checkOnUpdate(mockDb)

      const state = await getRebuildAdvisoryState()
      expect(state.pendingVersion).toBeUndefined()
      expect(state.acknowledgedVersion).toBe(REBUILD_ADVISORY_VERSION)
      expect(chrome.notifications.create).not.toHaveBeenCalled()
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('does not notify again when already acknowledged at the current version', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { acknowledgedVersion: REBUILD_ADVISORY_VERSION }
      })
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(100)

      await checkOnUpdate(mockDb)

      expect(chrome.notifications.create).not.toHaveBeenCalled()
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
      // apiEvents.count should not even need to be consulted once acknowledged,
      // but if it is, state must remain unchanged either way
      const state = await getRebuildAdvisoryState()
      expect(state.pendingVersion).toBeUndefined()
    })

    it('does not double count when acknowledgedVersion is higher than current (future-proofing)', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { acknowledgedVersion: REBUILD_ADVISORY_VERSION + 1 }
      })
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(100)

      await checkOnUpdate(mockDb)

      expect(chrome.notifications.create).not.toHaveBeenCalled()
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('re-asserts the badge but does not re-notify on a second update while the advisory is still pending (#105)', async () => {
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(42)

      // 1回目の拡張機能更新: 通常どおりpendingVersionをセットし、バッジと通知を出す
      await checkOnUpdate(mockDb)
      expect(chrome.notifications.create).toHaveBeenCalledTimes(1)
      expect(chrome.action.setBadgeText).toHaveBeenCalledTimes(1)

      jest.clearAllMocks()

      // 2回目の拡張機能更新: ユーザーはリビルド/解消せず、pendingVersionは同じバージョンのまま。
      // 通知は再送されるべきではないが、バッジは再アサートされてよい（ブラウザ再起動対策）。
      await checkOnUpdate(mockDb)

      expect(chrome.notifications.create).not.toHaveBeenCalled()
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })

      const state = await getRebuildAdvisoryState()
      expect(state.pendingVersion).toBe(REBUILD_ADVISORY_VERSION)
    })

    it('keeps the advisory durable when callback-free badge and notification APIs reject', async () => {
      const uiError = new Error('extension UI unavailable')
      ;(chrome.action.setBadgeText as jest.Mock).mockRejectedValue(uiError)
      ;(chrome.action.setBadgeBackgroundColor as jest.Mock).mockRejectedValue(uiError)
      ;(chrome.notifications.create as jest.Mock).mockRejectedValue(uiError)
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(42)

      await expect(checkOnUpdate(mockDb)).resolves.toBeUndefined()
      await Promise.resolve()

      expect((await getRebuildAdvisoryState()).pendingVersion).toBe(REBUILD_ADVISORY_VERSION)
      expect(warnSpy).toHaveBeenCalledTimes(3)
      warnSpy.mockRestore()
    })
  })

  describe('PR #207 backfill (audit finding #7, codex review pass-3 P2 "Prompt rebuilds for already-stored overlap repairs")', () => {
    it('re-surfaces the advisory for a user who already acknowledged the pre-#207 version, so their pre-existing overlap-import staleness gets a manual rebuild prompt', async () => {
      // A user on the version just before this rollout (REBUILD_ADVISORY_VERSION
      // was bumped from 2 -> 3 specifically for this fix, see
      // src/constants/database.ts) already acknowledged version 2 -- e.g. they
      // ran a rebuild for the #115 fix and have not needed one since.
      //
      // If they also, at some point on an OLDER build, imported an export that
      // overlapped existing data, the old incremental-conversion bug (audit
      // finding #7) may have left their hands/phases/actions silently stale for
      // hands split across existing+imported rows. Their raw apiEvents rows are
      // already complete (the Lake always stores every row), so re-importing the
      // same export today just hits the pure-duplicate path (successCount === 0)
      // and never triggers importData()'s new rebuild-on-overlap behavior --
      // there's nothing left to bump this user onto the fixed code path except
      // this advisory. REBUILD_ADVISORY_VERSION must have moved past what they
      // already acknowledged so checkOnUpdate() prompts them again.
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { acknowledgedVersion: 2 }
      })
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(1)

      await checkOnUpdate(mockDb)

      const state = await getRebuildAdvisoryState()
      expect(state.pendingVersion).toBe(REBUILD_ADVISORY_VERSION)
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })
      expect(chrome.notifications.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('hand start timestamp backfill', () => {
    it('re-surfaces the advisory for users who acknowledged version 3', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { acknowledgedVersion: 3 }
      })
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(1)

      await checkOnUpdate(mockDb)

      const state = await getRebuildAdvisoryState()
      expect(REBUILD_ADVISORY_VERSION).toBeGreaterThan(3)
      expect(state.pendingVersion).toBe(REBUILD_ADVISORY_VERSION)
      expect(chrome.notifications.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('resolveAdvisory', () => {
    it('clears pendingVersion, sets acknowledgedVersion, and clears the badge', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { pendingVersion: REBUILD_ADVISORY_VERSION }
      })

      await resolveAdvisory()

      const state = await getRebuildAdvisoryState()
      expect(state.pendingVersion).toBeUndefined()
      expect(state.acknowledgedVersion).toBe(REBUILD_ADVISORY_VERSION)
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    })
  })

  describe('API availability guards', () => {
    it('does not throw when chrome.notifications is unavailable', async () => {
      const original = (chrome as any).notifications
      delete (chrome as any).notifications
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(10)

      await expect(checkOnUpdate(mockDb)).resolves.not.toThrow()

      ;(chrome as any).notifications = original
    })

    it('does not throw when chrome.action is unavailable', async () => {
      const original = (chrome as any).action
      delete (chrome as any).action
      ;(mockDb.apiEvents.count as jest.Mock).mockResolvedValue(10)

      await expect(checkOnUpdate(mockDb)).resolves.not.toThrow()
      await expect(resolveAdvisory()).resolves.not.toThrow()

      ;(chrome as any).action = original
    })
  })
})
