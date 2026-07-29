import {
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

        callback?.({ success: true })
      },
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
