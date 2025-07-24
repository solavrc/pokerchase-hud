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
      get: jest.fn((keys, callback) => {
        if (typeof callback === 'function') {
          const result = keys ? 
            (Array.isArray(keys) ? 
              keys.reduce((acc, key) => ({ ...acc, [key]: chromeStorageMockData.sync[key] }), {}) :
              typeof keys === 'string' ? { [keys]: chromeStorageMockData.sync[keys] } : 
              chromeStorageMockData.sync) :
            chromeStorageMockData.sync
          callback(result)
        }
        return Promise.resolve({})
      }),
      set: jest.fn((items, callback) => {
        Object.assign(chromeStorageMockData.sync, items)
        if (typeof callback === 'function') {
          callback()
        }
        return Promise.resolve()
      }),
    },
    local: {
      get: jest.fn((keys, callback) => {
        if (typeof callback === 'function') {
          const result = keys ? 
            (Array.isArray(keys) ? 
              keys.reduce((acc, key) => ({ ...acc, [key]: chromeStorageMockData.local[key] }), {}) :
              typeof keys === 'string' ? { [keys]: chromeStorageMockData.local[keys] } : 
              chromeStorageMockData.local) :
            chromeStorageMockData.local
          callback(result)
        }
        return Promise.resolve({})
      }),
      set: jest.fn((items, callback) => {
        Object.assign(chromeStorageMockData.local, items)
        if (typeof callback === 'function') {
          callback()
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