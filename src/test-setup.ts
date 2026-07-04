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

global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
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
        Object.assign(chromeStorageMockData.local, items)
        if (typeof callback === 'function') {
          callback()
          return undefined
        }
        return Promise.resolve()
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