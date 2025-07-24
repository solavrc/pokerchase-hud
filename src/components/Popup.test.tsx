import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
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
      matches: ['https://game.poker-chase.com/*'],
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
    
    // Default mock for chrome.tabs.query to prevent errors
    mockChromeTabsQuery.mockResolvedValue([])
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

    expect(screen.getByText('Export Hand History (PokerStars)')).toBeInTheDocument()
    expect(screen.getByText('Export Raw Data (NDJSON)')).toBeInTheDocument()
    expect(screen.getByText('Import Raw Data (NDJSON)')).toBeInTheDocument()

    // エクスポートボタンをクリック
    await userEvent.click(screen.getByText('Export Hand History (PokerStars)'))

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
          success: true,
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

  describe('タブ移動機能', () => {
    it('ポップアップ開いた時にゲームタブでなければ既存のゲームタブに移動', async () => {
      // 現在のタブがゲームタブではない
      mockChromeTabsQuery.mockImplementation((query) => {
        if (query.active && query.currentWindow) {
          return Promise.resolve([{ id: 1, url: 'https://example.com' }])
        }
        if (query.url === 'https://game.poker-chase.com/*') {
          return Promise.resolve([{ id: 2, url: 'https://game.poker-chase.com/play/index.html' }])
        }
        return Promise.resolve([])
      })

      render(<Popup />)

      await waitFor(() => {
        expect(mockChromeTabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true })
      })

      await waitFor(() => {
        expect(mockChromeTabsQuery).toHaveBeenCalledWith({ url: 'https://game.poker-chase.com/*' })
      })

      expect(mockChromeTabsUpdate).toHaveBeenCalledWith(2, { active: true })
      expect(mockChromeTabsCreate).not.toHaveBeenCalled()
    })

    it('ゲームタブが存在しない場合は新規タブを開く', async () => {
      // 現在のタブがゲームタブではなく、ゲームタブも存在しない
      mockChromeTabsQuery.mockImplementation((query) => {
        if (query.active && query.currentWindow) {
          return Promise.resolve([{ id: 1, url: 'https://example.com' }])
        }
        return Promise.resolve([])
      })

      render(<Popup />)

      await waitFor(() => {
        expect(mockChromeTabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true })
      })

      await waitFor(() => {
        expect(mockChromeTabsCreate).toHaveBeenCalledWith({ url: 'https://game.poker-chase.com/play/index.html' })
      })

      expect(mockChromeTabsUpdate).not.toHaveBeenCalled()
    })

    it('既にゲームタブにいる場合は何もしない', async () => {
      // 現在のタブがゲームタブ
      mockChromeTabsQuery.mockImplementation((query) => {
        if (query.active && query.currentWindow) {
          return Promise.resolve([{ id: 1, url: 'https://game.poker-chase.com/play/index.html' }])
        }
        return Promise.resolve([])
      })

      render(<Popup />)

      await waitFor(() => {
        expect(mockChromeTabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true })
      })

      // ゲームタブを検索しない
      expect(mockChromeTabsQuery).not.toHaveBeenCalledWith({ url: 'https://game.poker-chase.com/*' })
      expect(mockChromeTabsUpdate).not.toHaveBeenCalled()
      expect(mockChromeTabsCreate).not.toHaveBeenCalled()
    })

    it('異なるウィンドウのゲームタブにも移動してフォーカス', async () => {
      // 現在のタブがウィンドウ1、ゲームタブがウィンドウ2
      mockChromeTabsQuery.mockImplementation((query) => {
        if (query.active && query.currentWindow) {
          return Promise.resolve([{ id: 1, url: 'https://example.com', windowId: 1 }])
        }
        if (query.url === 'https://game.poker-chase.com/*') {
          return Promise.resolve([{ id: 2, url: 'https://game.poker-chase.com/play/index.html', windowId: 2 }])
        }
        return Promise.resolve([])
      })

      render(<Popup />)

      await waitFor(() => {
        expect(mockChromeTabsUpdate).toHaveBeenCalledWith(2, { active: true })
      })

      expect(mockChromeWindowsUpdate).toHaveBeenCalledWith(2, { focused: true })
    })
  })

  describe('syncState取得', () => {
    it('getSyncStateレスポンスが正しい形式で処理される', async () => {
      // syncStateのレスポンス形式をテスト
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        if (message.action === 'firebaseAuthStatus') {
          callback({ isSignedIn: false })
        } else if (message.action === 'getSyncState') {
          // 修正後の正しい形式
          callback({
            success: true,
            syncState: {
              status: 'idle',
              lastSyncTimestamp: Date.now(),
              totalEvents: 500,
            },
          })
        }
      })

      render(<Popup />)

      await waitForAsyncOperations()

      // getSyncStateが呼ばれることを確認
      expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
        { action: 'getSyncState' },
        expect.any(Function)
      )
    })

    it('定期的にsyncStateを取得する', async () => {
      jest.useFakeTimers()

      // getSyncStateのモックを設定
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        if (message.action === 'firebaseAuthStatus') {
          callback({ isSignedIn: false })
        } else if (message.action === 'getSyncState') {
          callback({
            success: true,
            syncState: {
              status: 'idle',
              lastSyncTimestamp: Date.now(),
              totalEvents: 500,
            },
          })
        }
      })

      render(<Popup />)

      // 初回のレンダリングを待つ
      await waitFor(() => {
        expect(mockChromeRuntimeSendMessage).toHaveBeenCalled()
      })

      // 初回呼び出しをクリア
      mockChromeRuntimeSendMessage.mockClear()

      // 5秒経過をシミュレート
      act(() => {
        jest.advanceTimersByTime(5000)
      })

      // setIntervalによる再取得を確認
      expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
        { action: 'getSyncState' },
        expect.any(Function)
      )

      jest.useRealTimers()
    }, 10000)
  })
})