import '@testing-library/jest-dom'

// Polyfill structuredClone for Node.js environment
if (typeof global.structuredClone === 'undefined') {
  global.structuredClone = (obj: any) => {
    return JSON.parse(JSON.stringify(obj))
  }
}

// Mock chrome API
const chromeStorageMockData = {
  sync: {} as Record<string, any>,
  local: {} as Record<string, any>,
}

// chrome.storage.onChanged listeners (fired by the local/sync `set` mocks below)
const storageChangeListeners: Array<(changes: Record<string, { oldValue?: any, newValue?: any }>, areaName: string) => void> = []

// The mock storage above is module-scoped, so without a per-test reset any
// key a test writes leaks into every later test in the same file — an
// order-dependence that only surfaces under `jest --randomize` (e.g. a
// leftover legacy `autoSyncLastTime` makes AutoSyncService.initialize()
// conclude "already synced" and skip the first sync another test asserts on).
// Listeners are intentionally NOT cleared: module singletons register
// chrome.storage.onChanged listeners as import-time side effects (once per
// file), and clearing them here would desubscribe them for every test after
// the first in a way real Chrome never would. The reset itself is registered
// in the beforeEach at the bottom of this file, alongside the chrome-mock
// implementation restore.

const fireStorageChange = (areaName: 'sync' | 'local', items: Record<string, any>) => {
  const changes: Record<string, { oldValue?: any, newValue?: any }> = {}
  for (const key of Object.keys(items)) {
    changes[key] = { oldValue: chromeStorageMockData[areaName][key], newValue: items[key] }
  }
  storageChangeListeners.forEach(listener => listener(changes, areaName))
}

global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    onInstalled: {
      addListener: jest.fn(),
    },
    onUpdateAvailable: {
      addListener: jest.fn(),
    },
    requestUpdateCheck: jest.fn().mockResolvedValue({ status: 'no_update' }),
    getPlatformInfo: jest.fn().mockResolvedValue({ os: 'mac', arch: 'arm', nacl_arch: 'arm' }),
    getManifest: jest.fn(() => ({ version: '5.1.0' })),
    getURL: jest.fn((path: string) => `chrome-extension://mock-extension-id/${path}`),
    reload: jest.fn(),
  },
  alarms: {
    create: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(undefined),
    onAlarm: {
      addListener: jest.fn(),
    },
  },
  storage: {
    sync: {
      get: jest.fn((keys, callback?) => {
        const result = keys ?
          (Array.isArray(keys) ?
            keys.reduce((acc, key) => ({ ...acc, [key]: chromeStorageMockData.sync[key] }), {}) :
            typeof keys === 'string' ? { [keys]: chromeStorageMockData.sync[keys] } :
            chromeStorageMockData.sync) :
          chromeStorageMockData.sync
        if (typeof callback === 'function') {
          callback(result)
          return undefined
        }
        // Promise-based call style (no callback): resolve with the actual looked-up data
        return Promise.resolve(result)
      }),
      set: jest.fn((items, callback?) => {
        fireStorageChange('sync', items)
        Object.assign(chromeStorageMockData.sync, items)
        if (typeof callback === 'function') {
          callback()
          return undefined
        }
        return Promise.resolve()
      }),
      remove: jest.fn((keys, callback?) => {
        const keyList = Array.isArray(keys) ? keys : [keys]
        keyList.forEach((key: string) => { delete chromeStorageMockData.sync[key] })
        if (typeof callback === 'function') {
          callback()
          return undefined
        }
        return Promise.resolve()
      }),
    },
    local: {
      setAccessLevel: jest.fn().mockResolvedValue(undefined),
      get: jest.fn((keys, callback?) => {
        const result = keys ?
          (Array.isArray(keys) ?
            keys.reduce((acc, key) => ({ ...acc, [key]: chromeStorageMockData.local[key] }), {}) :
            typeof keys === 'string' ? { [keys]: chromeStorageMockData.local[keys] } :
            chromeStorageMockData.local) :
          chromeStorageMockData.local
        if (typeof callback === 'function') {
          callback(result)
          return undefined
        }
        // Promise-based call style (no callback): resolve with the actual looked-up data
        return Promise.resolve(result)
      }),
      set: jest.fn((items, callback?) => {
        fireStorageChange('local', items)
        Object.assign(chromeStorageMockData.local, items)
        if (typeof callback === 'function') {
          callback()
          return undefined
        }
        return Promise.resolve()
      }),
      remove: jest.fn((keys, callback?) => {
        const keyList = Array.isArray(keys) ? keys : [keys]
        keyList.forEach((key: string) => { delete chromeStorageMockData.local[key] })
        if (typeof callback === 'function') {
          callback()
          return undefined
        }
        return Promise.resolve()
      }),
    },
    onChanged: {
      addListener: jest.fn((listener: (changes: Record<string, any>, areaName: string) => void) => {
        storageChangeListeners.push(listener)
      }),
      removeListener: jest.fn((listener: (changes: Record<string, any>, areaName: string) => void) => {
        const index = storageChangeListeners.indexOf(listener)
        if (index !== -1) storageChangeListeners.splice(index, 1)
      }),
    },
  },
  tabs: {
    query: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    sendMessage: jest.fn(),
  },
  downloads: {
    download: jest.fn((_options, callback?) => {
      if (typeof callback === 'function') {
        callback(1)
        return undefined
      }
      return Promise.resolve(1)
    }),
  },
  windows: {
    update: jest.fn(),
  },
  identity: {
    getAuthToken: jest.fn(),
  },
  notifications: {
    create: jest.fn((_idOrOptions?: any, _optionsOrCallback?: any, callback?: any) => {
      const cb = typeof _optionsOrCallback === 'function' ? _optionsOrCallback : callback
      if (typeof cb === 'function') {
        cb('mock-notification-id')
        return undefined
      }
      return Promise.resolve('mock-notification-id')
    }),
  },
  action: {
    setBadgeText: jest.fn((_details, callback?) => {
      if (typeof callback === 'function') {
        callback()
        return undefined
      }
      return Promise.resolve()
    }),
    setBadgeBackgroundColor: jest.fn((_details, callback?) => {
      if (typeof callback === 'function') {
        callback()
        return undefined
      }
      return Promise.resolve()
    }),
  },
} as any

// Per-test isolation for the shared chrome mock above.
//
// `jest.clearAllMocks()` clears call history but NOT implementations, and
// `jest.restoreAllMocks()` only covers `jest.spyOn` spies — so a test that
// calls `mockImplementation()`/`mockReturnValue()` on one of these shared
// jest.fn()s would otherwise leak that override into every later test in the
// same file (order-dependent failures under `jest --randomize`). Snapshot
// each mock's default implementation once at setup, then reset and re-install
// it before every test. File-level `beforeEach` hooks run after this root
// one, so per-file overrides installed there keep working unchanged.
const chromeMockDefaults: Array<{ fn: jest.Mock, impl: ((...args: any[]) => any) | undefined }> = []
const collectMockDefaults = (obj: Record<string, any>) => {
  for (const value of Object.values(obj)) {
    if (jest.isMockFunction(value)) {
      chromeMockDefaults.push({ fn: value as jest.Mock, impl: (value as jest.Mock).getMockImplementation() })
    } else if (value && typeof value === 'object') {
      collectMockDefaults(value)
    }
  }
}
collectMockDefaults(global.chrome)

beforeEach(() => {
  chromeStorageMockData.sync = {}
  chromeStorageMockData.local = {}
  // Some test files replace global.chrome wholesale with a minimal stub
  // (e.g. useDraggable.test.ts) — guard, and only clean lastError when the
  // runtime namespace actually exists.
  if ((global.chrome as any)?.runtime) {
    delete (global.chrome.runtime as any).lastError
  }
  for (const { fn, impl } of chromeMockDefaults) {
    fn.mockReset()
    if (impl) fn.mockImplementation(impl)
  }
})

// Mock document.body.style for dragging tests
if (typeof document !== 'undefined') {
  Object.defineProperty(document.body, 'style', {
    value: {
      cursor: '',
    },
    writable: true,
  })
}
