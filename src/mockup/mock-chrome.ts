import {
  HAND_LOG_LAYOUT_STORAGE_KEY,
  hudPositionStorageKey,
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

        if (message.action === 'resetDeviceHandLogLayout') {
          localStorage.remove(HAND_LOG_LAYOUT_STORAGE_KEY, () => {
            callback?.({ success: true })
          })
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

  // The popup queries the active tab to decide whether it can talk to a game
  // page. There is no such tab here, so every query comes back empty and the
  // popup settles on its "not on the game page" branch.
  Object.defineProperty(chromeHost, 'tabs', {
    configurable: true,
    value: {
      create: async () => ({}),
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
