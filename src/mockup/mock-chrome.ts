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
  const values = new Map<string, unknown>()
  const listeners = new Set<StorageChangeListener>()

  const notify = (changes: Record<string, chrome.storage.StorageChange>) => {
    listeners.forEach((listener) => listener(changes, 'sync'))
  }

  const syncStorage = {
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

      notify(changes)
      callback?.()
    },
  }

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

      Array.from(values.keys())
        .filter((key) => key.startsWith('hudPosition_'))
        .forEach((key) => {
          changes[key] = { oldValue: values.get(key), newValue: undefined }
          values.delete(key)
        })

      notify(changes)
    },
  }
}
