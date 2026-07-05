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
