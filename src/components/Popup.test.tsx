import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Popup from './Popup'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import { defaultStatDisplayConfigs } from '../stats'
import { POPUP_THEME_LOCAL_STORAGE_KEY } from './popup/popup-theme-storage'

// Mock chrome APIs
const mockChromeRuntimeSendMessage = jest.fn()
const mockChromeTabsQuery = jest.fn()
const mockChromeTabsCreate = jest.fn()
const mockChromeTabsUpdate = jest.fn()
const mockChromeWindowsUpdate = jest.fn()
const mockChromeStorageGet = jest.fn()
const mockChromeStorageSet = jest.fn()
const mockChromeStorageRemove = jest.fn()

global.chrome = {
  runtime: {
    sendMessage: mockChromeRuntimeSendMessage,
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    // WhatsNewSection reads this to pick the entry matching the running
    // version; kept in sync with test-setup.ts's default so this file's
    // full-chrome-object override doesn't diverge from the global mock.
    getManifest: jest.fn(() => ({ version: '5.1.0' })),
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
      remove: mockChromeStorageRemove,
    },
    local: {
      get: jest.fn((_key: string, cb: (result: Record<string, unknown>) => void) => cb({})),
      set: jest.fn(),
    },
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
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
  // chrome.storage.syncのバッキングストア（フラットな`options`キーを含む）
  let syncData: Record<string, any>

  // Helper to wait for all initial async operations
  const waitForAsyncOperations = async () => {
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
    window.localStorage.removeItem(POPUP_THEME_LOCAL_STORAGE_KEY)

    // Default mock implementations: Popupはフラットな`options`キーを読む
    syncData = {
      options: {
        sendUserData: true,
        filterOptions: {
          gameTypes: { sng: true, mtt: true, ring: true },
          handLimit: 500,
          statDisplayConfigs: defaultStatDisplayConfigs,
        },
      },
      uiConfig: DEFAULT_UI_CONFIG,
    }

    mockChromeStorageGet.mockImplementation((keys, callback) => {
      // Execute callback immediately - tests will use waitFor
      const keyList = Array.isArray(keys) ? keys : [keys]
      callback(keyList.reduce((acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }), {}))
    })

    mockChromeStorageSet.mockImplementation((items, callback?) => {
      Object.assign(syncData, items)
      if (typeof callback === 'function') callback()
    })

    mockChromeStorageRemove.mockImplementation((keys, callback?) => {
      const keyList = Array.isArray(keys) ? keys : [keys]
      keyList.forEach((key: string) => { delete syncData[key] })
      if (typeof callback === 'function') callback()
    })

    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      // Execute callback immediately - tests will use waitFor
      if (message.action === 'firebaseAuthStatus') {
        callback({ isSignedIn: false, userInfo: null })
      } else if (message.action === 'getSyncState') {
        callback({ syncState: null })
      } else if (message.action === 'acknowledgeWhatsNew') {
        // WhatsNewSection (rendered inside every <Popup />) fires this on
        // mount; answer it so sendMessageWithTimeout's real 8s timer never
        // arms (codex review, PR #172 — otherwise this stalls the suite).
        callback({ success: true })
      }
    })

    // Default mock for chrome.tabs.query to prevent errors
    mockChromeTabsQuery.mockResolvedValue([])
  })

  it('初期設定を読み込む', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // フラットな`options`キーから読み込む
    expect(mockChromeStorageGet).toHaveBeenCalledWith(
      expect.arrayContaining(['options']),
      expect.any(Function)
    )
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'firebaseAuthStatus' },
      expect.any(Function)
    )
  })

  it('WhatsNewSectionのマウント時acknowledgeWhatsNewメッセージが共有sendMessageモックで処理される（codex review, PR #172）', async () => {
    // WhatsNewSection is mounted unconditionally inside every <Popup />
    // render and fires this message on mount (fire-and-forget, via
    // sendMessageWithTimeout). Before this fix the shared mock only
    // answered 'firebaseAuthStatus'/'getSyncState', so this call never
    // settled and left an unanswered real 8s timer armed per render
    // (28 renders in this suite) -- stalling `npx jest` for minutes.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    render(<Popup />)

    // Resolves near-instantly (well within waitFor's default timeout)
    // because the shared mock now answers synchronously -- proving the
    // call is actually stubbed rather than merely tolerated.
    await waitFor(() => {
      expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
        { action: 'acknowledgeWhatsNew' },
        expect.any(Function)
      )
    })

    // No "Unchecked runtime.lastError" / unhandled-callback style warnings
    // from a message that never got a response.
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('HUD表示設定（コンパクト/フル・統計カラー表示）を表示・変更できる', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('表示モード:')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'コンパクト' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '統計カラー表示' })).toBeChecked()

    await userEvent.click(screen.getByRole('radio', { name: 'フル' }))

    await waitFor(() => {
      expect(syncData.uiConfig).toEqual(
        expect.objectContaining({ hudDisplayMode: 'full' })
      )
    })
  })

  it('popupTheme未設定（新規インストール）は自動（auto）で表示され、uiConfigとは独立して永続化される', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // デフォルトは自動 -- popupThemeキーが無い状態からのマイグレーション
    expect(screen.getByRole('radio', { name: '自動' })).toBeChecked()

    await userEvent.click(screen.getByRole('radio', { name: 'ライト' }))

    await waitFor(() => {
      expect(syncData.popupTheme).toBe('light')
    })
    // uiConfig（HUD/game-tab向け設定）は変化しない -- popupThemeはuiConfigに
    // ネストせず別キーに保存する（全タブへのupdateUIConfig broadcastを
    // 誘発しないため、popup-theme-storage.tsを参照）
    expect(syncData.uiConfig).toEqual(DEFAULT_UI_CONFIG)
  })

  it('保存済みのpopupThemeモードを起動時に読み込んで反映する', async () => {
    syncData.popupTheme = 'dark'

    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByRole('radio', { name: 'ダーク' })).toBeChecked()
  })

  it('同期キャッシュのテーマで即時描画し、storage.syncの正本を描画後に反映する', async () => {
    let resolveThemeRead: ((result: Record<string, any>) => void) | undefined
    mockChromeStorageGet.mockImplementation((keys, callback) => {
      if (keys === 'popupTheme') {
        resolveThemeRead = callback
        return
      }
      const keyList = Array.isArray(keys) ? keys : [keys]
      callback(keyList.reduce((acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }), {}))
    })

    render(<Popup initialPopupThemeMode="light" />)

    // The popup is usable before chrome.storage.sync answers.
    expect(screen.getByRole('radio', { name: 'ライト' })).toBeChecked()
    expect(resolveThemeRead).toBeDefined()

    act(() => {
      resolveThemeRead?.({ popupTheme: 'dark' })
    })

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'ダーク' })).toBeChecked()
    })
  })

  it('起動時のstorage.sync読込中に選んだテーマを古い応答で巻き戻さない', async () => {
    let resolveThemeRead: ((result: Record<string, any>) => void) | undefined
    mockChromeStorageGet.mockImplementation((keys, callback) => {
      if (keys === 'popupTheme') {
        resolveThemeRead = callback
        return
      }
      const keyList = Array.isArray(keys) ? keys : [keys]
      callback(keyList.reduce((acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }), {}))
    })

    render(<Popup initialPopupThemeMode="light" />)
    expect(screen.getByRole('radio', { name: 'ライト' })).toBeChecked()

    await userEvent.click(screen.getByRole('radio', { name: 'ダーク' }))
    expect(screen.getByRole('radio', { name: 'ダーク' })).toBeChecked()
    expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('dark')

    await act(async () => {
      resolveThemeRead?.({ popupTheme: 'light' })
      await Promise.resolve()
    })

    expect(screen.getByRole('radio', { name: 'ダーク' })).toBeChecked()
    expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('dark')
  })

  it('旧storageのuiConfigにhudDisplayMode/hudColorCodingキーが無いユーザーはコンパクト+カラーONで復元される（グレースフルなマイグレーション, #143）', async () => {
    syncData = {
      options: {
        sendUserData: true,
        filterOptions: {
          gameTypes: { sng: true, mtt: true, ring: true },
          handLimit: 500,
          statDisplayConfigs: defaultStatDisplayConfigs,
        },
      },
      // #143以前に保存されたuiConfig相当（新フィールドが無い）
      uiConfig: { displayEnabled: true, scale: 1.0 },
    }

    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByRole('radio', { name: 'コンパクト' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '統計カラー表示' })).toBeChecked()
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

  it('フィルター変更時はフラットなoptionsキーへ保存しメッセージを送る', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    await userEvent.click(screen.getByRole('checkbox', { name: 'MTT' }))

    // フラットキーへoptions全体（sendUserData含む）が書き込まれる
    await waitFor(() => {
      expect(syncData.options).toEqual(
        expect.objectContaining({
          sendUserData: true,
          filterOptions: expect.objectContaining({
            gameTypes: { sng: true, mtt: false, ring: true },
          }),
        })
      )
    })

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'updateBattleTypeFilter' })
    )
  })

  it('テーブル人数フィルターを表示・変更できる（デフォルトは全層選択）', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByText('テーブル人数')).toBeInTheDocument()
    expect(screen.getByText('配られた人数でHUD統計の集計対象を絞り込みます')).toBeInTheDocument()
    // 「フル」が何を意味するか（6maxは5〜6人/4maxは4人）はテーブルタイプ依存で
    // チップの可視ラベルだけでは表現しきれないため、常時表示のキャプションで
    // 明示する（ホバーtitleだけに頼らない。codex review, PR #145）
    expect(screen.getByText('「フル」は6maxで5〜6人、4maxで4人(満席)を対象とします')).toBeInTheDocument()

    const fullCheckbox = screen.getByRole('checkbox', { name: 'フル' }) as HTMLInputElement
    const fourPCheckbox = screen.getByRole('checkbox', { name: '4人 (ショート)' }) as HTMLInputElement
    const threePCheckbox = screen.getByRole('checkbox', { name: '3人' }) as HTMLInputElement
    const huCheckbox = screen.getByRole('checkbox', { name: 'HU (2人)' }) as HTMLInputElement

    // デフォルト（新規ユーザー/tableSizeキー欠落時）は全層選択 = フィルタなし
    expect(fullCheckbox.checked).toBe(true)
    expect(fourPCheckbox.checked).toBe(true)
    expect(threePCheckbox.checked).toBe(true)
    expect(huCheckbox.checked).toBe(true)
  })

  it('テーブル人数フィルター変更時はフラットなoptionsキーへ保存しupdateBattleTypeFilterメッセージを送る', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    await userEvent.click(screen.getByRole('checkbox', { name: 'HU (2人)' }))

    await waitFor(() => {
      expect(syncData.options).toEqual(
        expect.objectContaining({
          sendUserData: true,
          filterOptions: expect.objectContaining({
            tableSize: { full: true, '4p': true, '3p': true, hu: false },
          }),
        })
      )
    })

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'updateBattleTypeFilter' })
    )
  })

  it('旧storageにtableSizeキーが無いユーザーはデフォルト（全層選択）で復元される（グレースフルなマイグレーション）', async () => {
    syncData = {
      options: {
        sendUserData: true,
        filterOptions: {
          gameTypes: { sng: true, mtt: true, ring: true },
          handLimit: 500,
          statDisplayConfigs: defaultStatDisplayConfigs,
          // tableSize キーが存在しない（#130以前のユーザー）
        },
      },
      uiConfig: DEFAULT_UI_CONFIG,
    }

    render(<Popup />)

    await waitForAsyncOperations()

    const fullCheckbox = screen.getByRole('checkbox', { name: 'フル' }) as HTMLInputElement
    const huCheckbox = screen.getByRole('checkbox', { name: 'HU (2人)' }) as HTMLInputElement
    expect(fullCheckbox.checked).toBe(true)
    expect(huCheckbox.checked).toBe(true)
  })

  it('旧@extend-chrome/storage bucketキーのみのユーザーはフラットキーへ移行される', async () => {
    // フラットキーが無く、旧bucketキーのみ存在する状態
    syncData = {
      'extend-chrome/storage__options_keys': ['sendUserData', 'filterOptions'],
      'extend-chrome/storage__options--sendUserData': false,
      'extend-chrome/storage__options--filterOptions': {
        gameTypes: { sng: false, mtt: true, ring: true },
        handLimit: 200,
        statDisplayConfigs: defaultStatDisplayConfigs,
      },
      uiConfig: DEFAULT_UI_CONFIG,
    }

    render(<Popup />)

    await waitForAsyncOperations()

    // フラットキーへ移行され、旧キーは削除される
    await waitFor(() => {
      expect(syncData.options).toEqual({
        sendUserData: false,
        filterOptions: {
          gameTypes: { sng: false, mtt: true, ring: true },
          handLimit: 200,
          statDisplayConfigs: defaultStatDisplayConfigs,
        },
      })
    })
    expect(syncData['extend-chrome/storage__options_keys']).toBeUndefined()
    expect(syncData['extend-chrome/storage__options--sendUserData']).toBeUndefined()
    expect(syncData['extend-chrome/storage__options--filterOptions']).toBeUndefined()

    // 移行した設定がUIに反映される（handLimit 200）
    expect(screen.getByText('200')).toBeInTheDocument()
    const mttCheckbox = screen.getByRole('checkbox', { name: 'MTT' }) as HTMLInputElement
    expect(mttCheckbox.checked).toBe(true)
    const sngCheckbox = screen.getByRole('checkbox', { name: 'Sit & Go' }) as HTMLInputElement
    expect(sngCheckbox.checked).toBe(false)
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

    expect(screen.getByText('ハンド履歴をエクスポート (PokerStars)')).toBeInTheDocument()
    expect(screen.getByText('生データをエクスポート (NDJSON)')).toBeInTheDocument()
    expect(screen.getByText('生データをインポート (NDJSON)')).toBeInTheDocument()

    // エクスポートボタンをクリック
    await userEvent.click(screen.getByText('ハンド履歴をエクスポート (PokerStars)'))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'exportData', format: 'pokerstars' },
      expect.any(Function)
    )
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

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'rebuildData' },
      expect.any(Function)
    )

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
      } else if (message.action === 'acknowledgeWhatsNew') {
        callback({ success: true })
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
        } else if (message.action === 'acknowledgeWhatsNew') {
          callback({ success: true })
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
        } else if (message.action === 'acknowledgeWhatsNew') {
          callback({ success: true })
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

  describe('Service Worker無応答時のフェイルオープン', () => {
    it('firebaseAuthStatus/getSyncStateがタイムアウトしてもUIはブロックされず既定状態で使用可能', async () => {
      jest.useFakeTimers()

      // Simulate a busy/unresponsive service worker: sendMessage never calls its callback
      mockChromeRuntimeSendMessage.mockImplementation(() => {
        // no-op: never invokes the callback
      })

      render(<Popup />)

      // The mount effect calls chrome.storage.sync/local.get synchronously,
      // and sendMessage is invoked (even though it never responds)
      await waitFor(() => {
        expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
          { action: 'firebaseAuthStatus' },
          expect.any(Function)
        )
      })

      // The rest of the popup renders immediately — not blocked on the SW response
      expect(screen.getByText('サイズ:')).toBeInTheDocument()

      // Advance past the sendMessageWithTimeout window (8s default default) for
      // both getSyncState poll and firebaseAuthStatus; must not throw or hang
      await act(async () => {
        await jest.advanceTimersByTimeAsync(9000)
      })

      // Fail-open default: still shows the "enable backup" sign-in button
      // (isFirebaseSignedIn stayed at its default `false`), not a stuck spinner
      expect(screen.getByText('自動バックアップを有効にする')).toBeInTheDocument()

      jest.useRealTimers()
    }, 15000)
  })
})
