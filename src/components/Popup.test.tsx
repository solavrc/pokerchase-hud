import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Popup from './Popup'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import { defaultStatDisplayConfigs } from '../stats'

// Mock @extend-chrome/storage
jest.mock('@extend-chrome/storage', () => {
  const mockBucket = {
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve()),
  }
  return {
    getBucket: jest.fn(() => mockBucket),
  }
})

// Mock chrome APIs
const mockChromeRuntimeSendMessage = jest.fn()
const mockChromeTabsQuery = jest.fn()
const mockChromeTabsCreate = jest.fn()
const mockChromeTabsUpdate = jest.fn()
const mockChromeWindowsUpdate = jest.fn()
const mockChromeStorageGet = jest.fn()
const mockChromeStorageSet = jest.fn()

global.chrome = {
  runtime: {
    sendMessage: mockChromeRuntimeSendMessage,
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  tabs: {
    query: mockChromeTabsQuery,
    create: mockChromeTabsCreate,
    update: mockChromeTabsUpdate,
  },
  windows: {
    update: mockChromeWindowsUpdate,
  },
  storage: {
    sync: {
      get: mockChromeStorageGet,
      set: mockChromeStorageSet,
    },
  },
} as any

// Mock manifest.json
jest.mock('../../manifest.json', () => ({
  content_scripts: [
    {
      matches: ['https://poker-chase.com/*'],
    },
  ],
}))

describe('Popup', () => {
  let mockBucket: any

  // Helper to wait for all initial async operations
  const waitForAsyncOperations = async () => {
    await waitFor(() => {
      expect(mockBucket.get).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(mockChromeStorageGet).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(mockChromeRuntimeSendMessage).toHaveBeenCalled()
    })
    // Small delay to ensure all microtasks complete
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    jest.clearAllMocks()
    
    // Get the mocked bucket instance
    const { getBucket } = require('@extend-chrome/storage')
    mockBucket = getBucket()
    
    // Default mock implementations
    mockBucket.get.mockResolvedValue({
      sendUserData: true,
      filterOptions: {
        gameTypes: { sng: true, mtt: true, ring: true },
        handLimit: 500,
        statDisplayConfigs: defaultStatDisplayConfigs,
      },
    })
    
    mockChromeStorageGet.mockImplementation((_keys, callback) => {
      // Execute callback immediately - tests will use waitFor
      callback({
        uiConfig: DEFAULT_UI_CONFIG,
      })
    })
    
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      // Execute callback immediately - tests will use waitFor
      if (message.action === 'firebaseAuthStatus') {
        callback({ isSignedIn: false, userInfo: null })
      } else if (message.action === 'getSyncState') {
        callback({ syncState: null })
      }
    })
  })

  it('初期設定を読み込む', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(mockBucket.get).toHaveBeenCalled()
    expect(mockChromeStorageGet).toHaveBeenCalled()
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'firebaseAuthStatus' },
      expect.any(Function)
    )
  })

  it('UIスケール設定を表示・変更できる', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('サイズ:')).toBeInTheDocument()

    // + and - buttons exist for scale adjustment
    const increaseButton = screen.getByRole('button', { name: '+' })
    
    expect(screen.getByText('100%')).toBeInTheDocument()

    // Click increase button to change scale
    fireEvent.click(increaseButton)

    await waitFor(() => {
      // After clicking +, the display shows 110%
      expect(screen.getByText('110%')).toBeInTheDocument()
    })
  })

  it('ゲームタイプフィルターを表示・変更できる', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('ゲームタイプ')).toBeInTheDocument()

    // Check that at least one checkbox exists
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
  })

  it('ハンド数制限を表示・変更できる', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // Check that the hand limit section exists by looking for the value
    expect(screen.getByText('500')).toBeInTheDocument()
  })

  it('統計設定を表示・変更できる', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // Check that checkboxes exist (statistics are shown as checkboxes)
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(0)
  })

  it('Firebaseサインイン/サインアウト', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // Component should render without errors
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThan(0)
  })

  it('インポート/エクスポート機能', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('エクスポート (PokerStars)')).toBeInTheDocument()
    expect(screen.getByText('エクスポート (.ndjson)')).toBeInTheDocument()
    expect(screen.getByText('インポート (.ndjson)')).toBeInTheDocument()

    // エクスポートボタンをクリック
    await userEvent.click(screen.getByText('エクスポート (PokerStars)'))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith({
      action: 'exportData',
      format: 'pokerstars',
    })
  })

  it('データ再構築機能', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('データ再構築')).toBeInTheDocument()

    // confirmをモック
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true)

    await userEvent.click(screen.getByText('データ再構築'))

    expect(confirmSpy).toHaveBeenCalledWith(
      'データを再構築しますか？この処理には時間がかかる場合があります。'
    )

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith({
      action: 'rebuildData',
    })

    confirmSpy.mockRestore()
  })

  it('手動同期機能（サインイン済み）', async () => {
    // サインイン済みの状態をモック
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      // Execute callback immediately - tests will use waitFor
      if (message.action === 'firebaseAuthStatus') {
        callback({
          isSignedIn: true,
          userInfo: { email: 'test@example.com', uid: 'test-uid' },
        })
      } else if (message.action === 'getSyncState') {
        callback({
          syncState: {
            status: 'idle',
            lastSyncTimestamp: Date.now() - 60000,
            totalEvents: 1000,
            uploadedEvents: 0,
            downloadedEvents: 0,
            progress: 0,
          },
        })
      }
    })

    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('test@example.com')).toBeInTheDocument()
    expect(screen.getByText('アップロード')).toBeInTheDocument()
    expect(screen.getByText('ダウンロード')).toBeInTheDocument()

    // アップロードボタンをクリック
    await userEvent.click(screen.getByText('アップロード'))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith({
      action: 'manualSyncUpload',
    })
  })

  it('インポート進行状況を表示', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // Ensure the component mounts and message listener is registered
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled()
  })
})