import { MESSAGE_ACTIONS } from '../types/messages'
import { MOCK_POSITIONAL_STATS, MOCK_RECENT_HANDS } from './mock-data'
import { DEFAULT_UI_CONFIG, type UIConfig } from '../types/hand-log'
import {
  POPUP_THEME_LOCAL_STORAGE_KEY,
  POPUP_THEME_STORAGE_KEY,
} from '../components/popup/popup-theme-storage'
import {
  HAND_LOG_LAYOUT_STORAGE_KEY,
  HUD_POSITION_STORAGE_KEYS,
  hudPositionStorageKey,
  persistSyncedUIConfig,
  persistSyncedUIConfigPatch,
  resolveLocalUIScale,
  UI_SCALE_STORAGE_KEY,
} from '../utils/ui-config-storage'

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void

export interface MockChromeController {
  clearHudPositions: () => void
}

/**
 * Version the mocked `chrome.runtime.getManifest()` reports. Deliberately not
 * read from package.json: the popup turns this into a GitHub release link, and
 * a mock should not point at a real release tag.
 */
const MOCK_MANIFEST_VERSION = '0.0.0-mock'

/**
 * Long-running background operations the popup starts optimistically: it flips
 * to a busy state and only reverts if the reply says `success: false` (see
 * `ImportExportSection`'s handlers and "Optimistic UI + Server Guard" in
 * AGENTS.md). There is no background here to send the terminal progress
 * message, so a bare success would wedge the popup in "エクスポート中" forever.
 * Rejecting is also what a real background does when it cannot start.
 */
const UNSUPPORTED_ACTIONS = new Set(['exportData', 'rebuildData'])

const selectValues = (
  values: Map<string, unknown>,
  keys?: string | string[] | Record<string, unknown> | null,
): Record<string, unknown> => {
  if (keys == null) return Object.fromEntries(values)

  if (typeof keys === 'string') {
    return values.has(keys) ? { [keys]: values.get(keys) } : {}
  }

  if (Array.isArray(keys)) {
    return Object.fromEntries(
      keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]),
    )
  }

  return Object.fromEntries(
    Object.entries(keys).map(([key, fallback]) => [
      key,
      values.has(key) ? values.get(key) : fallback,
    ]),
  )
}

export const installChromeMock = (): MockChromeController => {
  const syncedValues = new Map<string, unknown>()
  const localValues = new Map<string, unknown>()
  const listeners = new Set<StorageChangeListener>()
  const runtimeMessageListeners = new Set<unknown>()

  const notify = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: 'sync' | 'local',
  ) => {
    listeners.forEach((listener) => listener(changes, areaName))
  }

  const createStorageArea = (
    values: Map<string, unknown>,
    areaName: 'sync' | 'local',
  ) => ({
    get: (
      keys: string | string[] | Record<string, unknown> | null,
      callback: (items: Record<string, unknown>) => void,
    ) => callback(selectValues(values, keys)),
    set: (items: Record<string, unknown>, callback?: () => void) => {
      const changes: Record<string, chrome.storage.StorageChange> = {}

      Object.entries(items).forEach(([key, newValue]) => {
        const oldValue = values.get(key)
        values.set(key, newValue)
        changes[key] = { oldValue, newValue }
      })

      notify(changes, areaName)
      callback?.()
    },
    remove: (keys: string | string[], callback?: () => void) => {
      const changes: Record<string, chrome.storage.StorageChange> = {}

      ;(Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        if (!values.has(key)) return
        changes[key] = { oldValue: values.get(key), newValue: undefined }
        values.delete(key)
      })

      if (Object.keys(changes).length > 0) notify(changes, areaName)
      callback?.()
    },
  })

  // `chrome.storage.sync` persists for real users, but this mock's copy starts
  // empty on every load. Seed the popup's theme from the localStorage mirror
  // the popup itself keeps, or a reload would show the frame honouring the
  // saved mode while the popup reconciles to the default and renders the other
  // theme.
  // NB: `window.` is required -- the bare name is shadowed below by this
  // file's own `localStorage` storage-area helper.
  const savedPopupTheme = window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)
  if (savedPopupTheme) syncedValues.set(POPUP_THEME_STORAGE_KEY, savedPopupTheme)

  const syncStorage = createStorageArea(syncedValues, 'sync')
  const localStorage = createStorageArea(localValues, 'local')

  const existingChrome = typeof chrome === 'object' ? chrome : undefined
  const chromeHost = existingChrome ?? {}

  Object.defineProperty(chromeHost, 'storage', {
    configurable: true,
    value: {
      onChanged: {
        addListener: (listener: StorageChangeListener) => listeners.add(listener),
        removeListener: (listener: StorageChangeListener) => listeners.delete(listener),
      },
      sync: syncStorage,
      local: localStorage,
    },
  })

  Object.defineProperty(chromeHost, 'runtime', {
    configurable: true,
    value: {
      ...(existingChrome?.runtime ?? {}),
      sendMessage: (
        message: {
          action?: string
          config?: UIConfig
          patch?: Pick<UIConfig, 'toggleShortcut'>
          scale?: number
          seatIndex?: number
          position?: unknown
          layout?: unknown
        },
        callback?: (response: unknown) => void,
      ) => {
        if (message.action === 'getDeviceUILayout') {
          const positionKey = message.seatIndex === undefined
            ? undefined
            : hudPositionStorageKey(message.seatIndex)
          callback?.({
            success: true,
            scale: resolveLocalUIScale(localValues.get(UI_SCALE_STORAGE_KEY)),
            ...(positionKey && localValues.has(positionKey)
              ? { position: localValues.get(positionKey) }
              : {}),
          })
          return
        }

        if (message.action === 'setDeviceUIScale') {
          localStorage.set({ [UI_SCALE_STORAGE_KEY]: message.scale }, () => {
            callback?.({ success: true })
          })
          return
        }

        if (
          message.action === 'setDeviceHudPosition' &&
          message.seatIndex !== undefined
        ) {
          localStorage.set({
            [hudPositionStorageKey(message.seatIndex)]: message.position,
          }, () => {
            callback?.({ success: true })
          })
          return
        }

        if (message.action === 'getDeviceHandLogLayout') {
          callback?.({
            success: true,
            ...(localValues.has(HAND_LOG_LAYOUT_STORAGE_KEY)
              ? { layout: localValues.get(HAND_LOG_LAYOUT_STORAGE_KEY) }
              : {}),
          })
          return
        }

        if (message.action === 'setDeviceHandLogLayout') {
          localStorage.set({
            [HAND_LOG_LAYOUT_STORAGE_KEY]: message.layout,
          }, () => {
            callback?.({ success: true })
          })
          return
        }

        if (message.action === 'resetDeviceUILayout') {
          localStorage.remove(
            [HAND_LOG_LAYOUT_STORAGE_KEY, ...HUD_POSITION_STORAGE_KEYS],
            () => {
              // Scale is part of the reset too, and it is written back to the
              // default rather than removed -- a missing local uiScale means
              // "not migrated to device-local" and would re-migrate from the
              // legacy synced value, resurrecting the pre-reset scale. Mirror
              // the real handler exactly: without this the mock resets only the
              // positions, the popup snaps back to 100% while the HUD behind it
              // keeps the old scale, and 位置とサイズをリセット cannot be
              // verified here at all.
              localStorage.set({ [UI_SCALE_STORAGE_KEY]: DEFAULT_UI_CONFIG.scale }, () => {
                // Clearing storage is not enough: neither `HandLog` nor
                // `useDraggable` watches storage -- they reset on these window
                // events. The real background sends one `resetUILayout` message
                // to the game tab, where `content_script.ts` fans it out into
                // exactly these two -- without them the popup's
                // 位置とサイズをリセット button would do nothing visible.
                window.dispatchEvent(new CustomEvent(MESSAGE_ACTIONS.RESET_HAND_LOG_LAYOUT))
                window.dispatchEvent(new CustomEvent(MESSAGE_ACTIONS.RESET_HUD_POSITIONS))
                callback?.({ success: true })
              })
            }
          )
          return
        }

        // The popup asks the background to persist HUD display settings
        // rather than writing sync storage itself, so the mock has to do the
        // storing or nothing the popup changes would ever reach the HUD.
        // Delegates to the same helpers `message-router.ts` uses.
        if (message.action === 'setSyncedUIConfig') {
          const done = (success: boolean) => callback?.({ success })
          if (message.patch) persistSyncedUIConfigPatch(message.patch, done)
          else if (message.config) persistSyncedUIConfig(message.config, done)
          else done(false)
          return
        }

        // The two HUD drill-downs (ポジション別スタッツ / 直近ハンド) fetch
        // through the background. Unlike the popup's readers these do NOT fail
        // open on a bare `{ success: true }` -- they land on their「データなし」
        // branch, so the panel bodies the mockup exists to review would never
        // appear. Hand back the authored fixtures (see mock-data.ts).
        if (message.action === 'getPositionalStats') {
          callback?.({ success: true, positionalStats: MOCK_POSITIONAL_STATS })
          return
        }

        if (message.action === 'getRecentHands') {
          callback?.({ success: true, recentHands: MOCK_RECENT_HANDS })
          return
        }

        if (message.action && UNSUPPORTED_ACTIONS.has(message.action)) {
          callback?.({ success: false, error: 'モックでは実行できません' })
          return
        }

        // Everything else -- the popup's read actions (`getOperationState`,
        // `firebaseAuthStatus`, `getSyncState`, `getSyncInfo`,
        // `getUndecodedEventStats` …) and its write actions alike. Every popup
        // reader is written to fail open on an unrecognised response
        // (`if (response?.x)`), so a bare success lands them all on their
        // idle/empty state, which is what a mock should show. Do NOT fake
        // richer payloads here: the popup would then render states that no
        // real background ever produced.
        callback?.({ success: true })
      },
      onMessage: {
        addListener: (listener: unknown) => runtimeMessageListeners.add(listener),
        removeListener: (listener: unknown) => runtimeMessageListeners.delete(listener),
      },
      // The popup prints this next to its 更新情報 link.
      getManifest: () => ({ version: MOCK_MANIFEST_VERSION }),
      getURL: (path: string) => path,
      lastError: undefined,
      reload: () => {},
    },
  })

  // `ImportExportSection` focuses an existing import tab through this. The
  // query above never finds one here, so it is only ever a safety net.
  Object.defineProperty(chromeHost, 'windows', {
    configurable: true,
    value: { update: async () => ({}) },
  })

  // The popup queries the active tab to decide whether it can talk to a game
  // page. There is no such tab here, so every query comes back empty and the
  // popup settles on its "not on the game page" branch.
  Object.defineProperty(chromeHost, 'tabs', {
    configurable: true,
    value: {
      // Rejecting rather than silently resolving: the popup's import button
      // awaits this and shows its own failure message if it throws. Resolving
      // with nothing would leave the click looking accepted while no page
      // opened. Callers that open the game tab already swallow the error.
      create: async () => { throw new Error('モックでは新しいタブを開けません') },
      query: async () => [],
      sendMessage: async () => undefined,
      update: async () => ({}),
    },
  })

  if (!existingChrome) {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: chromeHost,
    })
  }

  return {
    clearHudPositions: () => {
      const changes: Record<string, chrome.storage.StorageChange> = {}

      Array.from(localValues.keys())
        .filter((key) => key.startsWith('hudPosition_'))
        .forEach((key) => {
          changes[key] = { oldValue: localValues.get(key), newValue: undefined }
          localValues.delete(key)
        })

      notify(changes, 'local')
    },
  }
}
