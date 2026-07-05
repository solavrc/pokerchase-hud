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
    getURL: jest.fn((path: string) => `chrome-extension://mock-extension-id/${path}`),
    reload: jest.fn(),
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
    },
    local: {
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

// Mock document.body.style for dragging tests
if (typeof document !== 'undefined') {
  Object.defineProperty(document.body, 'style', {
    value: {
      cursor: '',
    },
    writable: true,
  })
}