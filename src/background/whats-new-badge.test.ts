/**
 * Unit tests for the What's New badge (src/background/whats-new-badge.ts).
 *
 * Covers: the 3-way badge-precedence resolver (all 8 states), entry-gated
 * onInstalled('update') marking (background.ts only calls markWhatsNewOnUpdate
 * for reason === 'update', never 'install' -- this file tests that function
 * directly, matching the existing convention in rebuild-advisory.test.ts of
 * testing checkOnUpdate() rather than the onInstalled listener wrapper),
 * seen-clearing (acknowledgeWhatsNew), and startup re-assertion.
 */
import {
  resolveActiveBadge,
  markWhatsNewOnUpdate,
  acknowledgeWhatsNew,
  reassertWhatsNewBadgeOnStartup,
  getUnseenWhatsNewVersion,
  type ActiveBadge,
} from './whats-new-badge'
import { REBUILD_ADVISORY_STORAGE_KEY } from './rebuild-advisory'
import { PENDING_UPDATE_STORAGE_KEY } from './update-manager'
import { WHATS_NEW_STORAGE_KEY, WHATS_NEW_ENTRIES } from '../constants/whats-new'

const CURRENT_ENTRY_VERSION = WHATS_NEW_ENTRIES[0]!.version

describe('whats-new-badge', () => {
  beforeEach(async () => {
    await chrome.storage.local.set({
      [REBUILD_ADVISORY_STORAGE_KEY]: undefined,
      [PENDING_UPDATE_STORAGE_KEY]: undefined,
      [WHATS_NEW_STORAGE_KEY]: undefined,
    })
    jest.clearAllMocks()
  })

  describe('resolveActiveBadge (3-way precedence, all 8 states)', () => {
    // rebuild > update > whats-new. Table covers every combination of the
    // three boolean inputs.
    const cases: Array<{
      rebuildPending: boolean
      updatePending: boolean
      whatsNewUnseen: boolean
      expected: ActiveBadge
    }> = [
      { rebuildPending: false, updatePending: false, whatsNewUnseen: false, expected: null },
      { rebuildPending: false, updatePending: false, whatsNewUnseen: true, expected: 'whats-new' },
      { rebuildPending: false, updatePending: true, whatsNewUnseen: false, expected: 'update' },
      { rebuildPending: false, updatePending: true, whatsNewUnseen: true, expected: 'update' },
      { rebuildPending: true, updatePending: false, whatsNewUnseen: false, expected: 'rebuild' },
      { rebuildPending: true, updatePending: false, whatsNewUnseen: true, expected: 'rebuild' },
      { rebuildPending: true, updatePending: true, whatsNewUnseen: false, expected: 'rebuild' },
      { rebuildPending: true, updatePending: true, whatsNewUnseen: true, expected: 'rebuild' },
    ]

    it.each(cases)(
      'rebuild=$rebuildPending update=$updatePending whatsNew=$whatsNewUnseen -> $expected',
      ({ rebuildPending, updatePending, whatsNewUnseen, expected }) => {
        expect(resolveActiveBadge({ rebuildPending, updatePending, whatsNewUnseen })).toBe(expected)
      }
    )
  })

  describe('markWhatsNewOnUpdate (onInstalled reason === \'update\' only)', () => {
    it('records the unseen version and sets the badge when a curated entry exists and no higher-priority badge is active', async () => {
      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)

      expect(await getUnseenWhatsNewVersion()).toBe(CURRENT_ENTRY_VERSION)
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'N' })
      expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalled()
    })

    it('does not record anything when the version has no curated WHATS_NEW_ENTRIES entry (e.g. an unreleased/unrecognized version)', async () => {
      await markWhatsNewOnUpdate('0.0.1-not-a-real-release')

      expect(await getUnseenWhatsNewVersion()).toBeUndefined()
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('records the unseen version but suppresses the badge when rebuild-advisory is pending (precedence)', async () => {
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { pendingVersion: 1 },
      })

      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)

      expect(await getUnseenWhatsNewVersion()).toBe(CURRENT_ENTRY_VERSION)
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('records the unseen version but suppresses the badge when an update is pending (precedence)', async () => {
      await chrome.storage.local.set({
        [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '9.9.9' },
      })

      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)

      expect(await getUnseenWhatsNewVersion()).toBe(CURRENT_ENTRY_VERSION)
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('does not throw when chrome.action is unavailable', async () => {
      const original = (chrome as any).action
      delete (chrome as any).action

      await expect(markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)).resolves.not.toThrow()
      expect(await getUnseenWhatsNewVersion()).toBe(CURRENT_ENTRY_VERSION)

      ;(chrome as any).action = original
    })
  })

  describe('acknowledgeWhatsNew (Popup WhatsNewSection mount)', () => {
    it('clears the unseen version and the badge', async () => {
      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)
      expect(await getUnseenWhatsNewVersion()).toBe(CURRENT_ENTRY_VERSION)
      jest.clearAllMocks()

      await acknowledgeWhatsNew()

      expect(await getUnseenWhatsNewVersion()).toBeUndefined()
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    })

    it('is a no-op (idempotent) when there is nothing unseen', async () => {
      await acknowledgeWhatsNew()

      expect(await getUnseenWhatsNewVersion()).toBeUndefined()
      // Still clears text unconditionally when no higher-priority badge is
      // active -- resolveActiveBadge(all false) -> null -> clear branch.
      // This mirrors clearBadge() in rebuild-advisory.ts/update-manager.ts,
      // which are also unconditional/idempotent when already clear.
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    })

    it('does not clobber the rebuild-advisory badge when it is active', async () => {
      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION) // suppressed (no rebuild yet)
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { pendingVersion: 1 },
      })
      jest.clearAllMocks()

      await acknowledgeWhatsNew()

      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('does not clobber the update-manager badge when it is active', async () => {
      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION) // suppressed (no update yet)
      await chrome.storage.local.set({
        [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '9.9.9' },
      })
      jest.clearAllMocks()

      await acknowledgeWhatsNew()

      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })
  })

  describe('reassertWhatsNewBadgeOnStartup (SW startup re-check)', () => {
    it('does nothing when there is no unseen version', async () => {
      await reassertWhatsNewBadgeOnStartup()

      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })

    it('promotes the whats-new badge once a higher-priority badge that suppressed it at onInstalled time has since resolved', async () => {
      // onInstalled('update') time: rebuild-advisory was pending, so the
      // whats-new badge was recorded but suppressed.
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { pendingVersion: 1 },
      })
      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)
      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()

      // User rebuilds; rebuild-advisory resolves (acknowledgedVersion set,
      // pendingVersion cleared) independently of this module.
      await chrome.storage.local.set({
        [REBUILD_ADVISORY_STORAGE_KEY]: { acknowledgedVersion: 1 },
      })
      jest.clearAllMocks()

      // Next SW startup re-checks and promotes.
      await reassertWhatsNewBadgeOnStartup()

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'N' })
    })

    it('stays suppressed on re-check while a higher-priority badge is still active', async () => {
      await chrome.storage.local.set({
        [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '9.9.9' },
      })
      await markWhatsNewOnUpdate(CURRENT_ENTRY_VERSION)
      jest.clearAllMocks()

      await reassertWhatsNewBadgeOnStartup()

      expect(chrome.action.setBadgeText).not.toHaveBeenCalled()
    })
  })
})
