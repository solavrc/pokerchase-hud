import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Popup from './Popup'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import { defaultStatDisplayConfigs } from '../stats'
import { POPUP_THEME_LOCAL_STORAGE_KEY } from './popup/popup-theme-storage'
import { UI_SCALE_STORAGE_KEY } from '../utils/ui-config-storage'

// Mock chrome APIs
const mockChromeRuntimeSendMessage = jest.fn()
const mockChromeTabsQuery = jest.fn()
const mockChromeTabsCreate = jest.fn()
const mockChromeTabsUpdate = jest.fn()
const mockChromeTabsSendMessage = jest.fn()
const mockChromeWindowsUpdate = jest.fn()
const mockChromeStorageGet = jest.fn()
const mockChromeStorageSet = jest.fn()
const mockChromeStorageRemove = jest.fn()
const mockChromeLocalStorageGet = jest.fn()
const mockChromeLocalStorageSet = jest.fn()

global.chrome = {
  runtime: {
    sendMessage: mockChromeRuntimeSendMessage,
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
    // PopupHeader uses the running version to build the exact Release link.
    getManifest: jest.fn(() => ({ version: '5.1.0' })),
  },
  tabs: {
    query: mockChromeTabsQuery,
    create: mockChromeTabsCreate,
    update: mockChromeTabsUpdate,
    sendMessage: mockChromeTabsSendMessage,
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
      get: mockChromeLocalStorageGet,
      set: mockChromeLocalStorageSet,
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
  let localData: Record<string, any>

  const respondToDeviceLayoutMessage = (
    message: { action?: string, scale?: number },
    callback?: (response: unknown) => void
  ): boolean => {
    if (message.action === 'getDeviceUILayout') {
      callback?.({ success: true, scale: localData[UI_SCALE_STORAGE_KEY] ?? 1 })
      return true
    }
    if (message.action === 'setDeviceUIScale') {
      localData[UI_SCALE_STORAGE_KEY] = message.scale
      callback?.({ success: true })
      return true
    }
    return false
  }

  const respondToSyncedUIConfigMessage = (
    message: {
      action?: string
      config?: typeof DEFAULT_UI_CONFIG
      patch?: Partial<typeof DEFAULT_UI_CONFIG>
    },
    callback?: (response: unknown) => void
  ): boolean => {
    if (message.action !== 'setSyncedUIConfig') return false
    if (message.patch) {
      syncData.uiConfig = {
        ...DEFAULT_UI_CONFIG,
        ...syncData.uiConfig,
        ...message.patch,
      }
      callback?.({ success: true })
      return true
    }
    if (!message.config) return false
    const liveLegacyScale = syncData.uiConfig?.scale
    const preservedLegacyScale = syncData.legacyUIScale
    const compatibilityScale = typeof liveLegacyScale === 'number'
      ? liveLegacyScale
      : typeof preservedLegacyScale === 'number'
        ? preservedLegacyScale
        : undefined
    syncData.uiConfig = {
      ...message.config,
      ...(compatibilityScale !== undefined ? { scale: compatibilityScale } : {}),
    }
    if (compatibilityScale !== undefined) {
      syncData.legacyUIScale = compatibilityScale
    }
    callback?.({ success: true })
    return true
  }

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

  const mockSignedOutPopupMessages = (
    handleSignIn: (callback: (response?: unknown) => void) => void,
    getAuthStatus: () => { isSignedIn: boolean; userInfo: { email: string; uid: string } | null } = () => ({
      isSignedIn: false,
      userInfo: null,
    })
  ) => {
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (respondToDeviceLayoutMessage(message, callback)) return
      if (message.action === 'firebaseAuthStatus') {
        callback({ success: true, ...getAuthStatus() })
      } else if (message.action === 'getSyncState') {
        callback({ success: true, syncState: null })
      } else if (message.action === 'acknowledgeWhatsNew') {
        callback({ success: true })
      } else if (message.action === 'firebaseSignIn') {
        handleSignIn(callback)
      }
    })
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
    localData = {}

    mockChromeStorageGet.mockImplementation((keys, callback?) => {
      // Execute callback immediately - tests will use waitFor
      const keyList = Array.isArray(keys) ? keys : [keys]
      const result = keyList.reduce(
        (acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }),
        {}
      )
      // 実APIと同じく両方の呼び出し形を通す。コールバック前提のままだと、
      // Promise形で読むコンポーネント（ReplayImportSection等）が
      // `callback is not a function` で落ちる。
      if (typeof callback === 'function') {
        callback(result)
        return undefined
      }
      return Promise.resolve(result)
    })

    mockChromeStorageSet.mockImplementation((items, callback?) => {
      Object.assign(syncData, items)
      if (typeof callback === 'function') {
        callback()
        return undefined
      }
      return Promise.resolve()
    })

    mockChromeStorageRemove.mockImplementation((keys, callback?) => {
      const keyList = Array.isArray(keys) ? keys : [keys]
      keyList.forEach((key: string) => { delete syncData[key] })
      if (typeof callback === 'function') {
        callback()
        return undefined
      }
      return Promise.resolve()
    })

    mockChromeLocalStorageGet.mockImplementation((keys, callback) => {
      const keyList = Array.isArray(keys) ? keys : [keys]
      callback(keyList.reduce(
        (acc: Record<string, any>, key: string) => ({ ...acc, [key]: localData[key] }),
        {}
      ))
    })
    mockChromeLocalStorageSet.mockImplementation((items, callback?) => {
      Object.assign(localData, items)
      if (typeof callback === 'function') callback()
    })

    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      // Execute callback immediately - tests will use waitFor
      if (respondToDeviceLayoutMessage(message, callback)) return
      if (respondToSyncedUIConfigMessage(message, callback)) return
      if (message.action === 'firebaseAuthStatus') {
        callback({ success: true, isSignedIn: false, userInfo: null })
      } else if (message.action === 'getSyncState') {
        callback({ syncState: null })
      } else if (message.action === 'acknowledgeWhatsNew') {
        // PopupHeader fires this once its version/Release link is visible;
        // answer it so sendMessageWithTimeout's real 8s timer never remains
        // armed and stalls the suite.
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

  it('バージョンとReleaseリンクの表示時acknowledgeWhatsNewメッセージが共有sendMessageモックで処理される', async () => {
    // PopupHeader is mounted unconditionally inside every <Popup /> render
    // and fires this message after rendering (fire-and-forget, via
    // sendMessageWithTimeout). The shared mock must answer it; otherwise the
    // call never settles and leaves a real 8s timer armed per render
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

  it('HUD表示設定（簡易/詳細）を表示・変更できる', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    expect(screen.getByRole('button', { name: '簡易' })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByRole('button', { name: '詳細' }))

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
    expect(screen.getByRole('button', { name: 'テーマ: 自動' })).toBeInTheDocument()

    // アイコントグルは 自動→ライト→ダーク→自動 の順に送る
    await userEvent.click(screen.getByRole('button', { name: 'テーマ: 自動' }))

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

    expect(screen.getByRole('button', { name: 'テーマ: ダーク' })).toBeInTheDocument()
  })

  it('同期キャッシュのテーマで即時描画し、storage.syncの正本を描画後に反映する', async () => {
    let resolveThemeRead: ((result: Record<string, any>) => void) | undefined
    mockChromeStorageGet.mockImplementation((keys, callback?) => {
      if (keys === 'popupTheme') {
        resolveThemeRead = callback
        return
      }
      const keyList = Array.isArray(keys) ? keys : [keys]
      const result = keyList.reduce(
        (acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }),
        {}
      )
      if (typeof callback === 'function') {
        callback(result)
        return undefined
      }
      return Promise.resolve(result)
    })

    render(<Popup initialPopupThemeMode="light" />)

    // The popup is usable before chrome.storage.sync answers.
    expect(screen.getByRole('button', { name: 'テーマ: ライト' })).toBeInTheDocument()
    expect(resolveThemeRead).toBeDefined()

    act(() => {
      resolveThemeRead?.({ popupTheme: 'dark' })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'テーマ: ダーク' })).toBeInTheDocument()
    })
  })

  it('起動時のstorage.sync読込中に選んだテーマを古い応答で巻き戻さない', async () => {
    let resolveThemeRead: ((result: Record<string, any>) => void) | undefined
    mockChromeStorageGet.mockImplementation((keys, callback?) => {
      if (keys === 'popupTheme') {
        resolveThemeRead = callback
        return
      }
      const keyList = Array.isArray(keys) ? keys : [keys]
      const result = keyList.reduce(
        (acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }),
        {}
      )
      if (typeof callback === 'function') {
        callback(result)
        return undefined
      }
      return Promise.resolve(result)
    })

    render(<Popup initialPopupThemeMode="light" />)
    expect(screen.getByRole('button', { name: 'テーマ: ライト' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'テーマ: ライト' }))
    expect(screen.getByRole('button', { name: 'テーマ: ダーク' })).toBeInTheDocument()
    expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('dark')

    await act(async () => {
      resolveThemeRead?.({ popupTheme: 'light' })
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'テーマ: ダーク' })).toBeInTheDocument()
    expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('dark')
  })

  it('旧storageのuiConfigにhudDisplayModeキーが無いユーザーは簡易で復元される（グレースフルなマイグレーション, #143）', async () => {
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

    expect(screen.getByRole('button', { name: '簡易' })).toHaveAttribute('aria-pressed', 'true')
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

  it('保存済みuiConfigの初期読込が終わるまで設定操作を有効にしない', async () => {
    syncData.uiConfig = {
      ...DEFAULT_UI_CONFIG,
      // Legacy/cross-device value must not override this device's scale.
      scale: 0.8,
      toggleShortcut: null,
    }
    localData[UI_SCALE_STORAGE_KEY] = 1.4
    let resolveUIConfigRead!: (result: Record<string, any>) => void
    mockChromeStorageGet.mockImplementation((keys, callback?) => {
      if (keys === 'uiConfig') {
        resolveUIConfigRead = callback
        return
      }
      const keyList = Array.isArray(keys) ? keys : [keys]
      const result = keyList.reduce(
        (acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }),
        {}
      )
      if (typeof callback === 'function') {
        callback(result)
        return undefined
      }
      return Promise.resolve(result)
    })

    render(<Popup />)
    await waitFor(() => expect(resolveUIConfigRead).toBeDefined())

    expect(screen.queryByText('サイズ:')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', {
      name: 'HUD表示切り替えショートカット',
    })).not.toBeInTheDocument()

    act(() => resolveUIConfigRead({ uiConfig: syncData.uiConfig }))

    await waitFor(() => {
      expect(screen.getByText('140%')).toBeInTheDocument()
      expect(screen.getByRole('textbox', {
        name: 'HUD表示切り替えショートカット',
      })).toHaveValue('未設定')
    })
  })

  it('初期sync読込中のlocal scale変更でも保存済み表示設定を読み飛ばさない', async () => {
    syncData.uiConfig = {
      ...DEFAULT_UI_CONFIG,
      displayEnabled: false,
      hudDisplayMode: 'full',
    }
    localData[UI_SCALE_STORAGE_KEY] = 1.4
    let resolveUIConfigRead!: (result: Record<string, any>) => void
    mockChromeStorageGet.mockImplementation((keys, callback?) => {
      if (keys === 'uiConfig') {
        resolveUIConfigRead = callback
        return
      }
      const keyList = Array.isArray(keys) ? keys : [keys]
      const result = keyList.reduce(
        (acc: Record<string, any>, key: string) => ({ ...acc, [key]: syncData[key] }),
        {}
      )
      if (typeof callback === 'function') {
        callback(result)
        return undefined
      }
      return Promise.resolve(result)
    })

    render(<Popup />)
    await waitFor(() => {
      expect(resolveUIConfigRead).toBeDefined()
      expect(chrome.storage.onChanged.addListener).toHaveBeenCalled()
    })

    const storageListeners = (chrome.storage.onChanged.addListener as jest.Mock).mock.calls
      .map(([listener]) => listener as (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string
      ) => void)

    localData[UI_SCALE_STORAGE_KEY] = 1.6
    act(() => {
      for (const listener of storageListeners) {
        listener({
          [UI_SCALE_STORAGE_KEY]: {
            oldValue: 1.4,
            newValue: 1.6,
          },
        }, 'local')
      }
    })

    // A scale-only event must not expose default settings while the
    // authoritative synchronized config is still pending.
    expect(screen.queryByText('サイズ:')).not.toBeInTheDocument()

    act(() => resolveUIConfigRead({ uiConfig: syncData.uiConfig }))

    await waitFor(() => {
      expect(screen.getByText('160%')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '非表示' })).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: '詳細' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('初期local scale未解決中のsync変更では設定UIを有効にしない', async () => {
    let respondToInitialLayout!: (response: unknown) => void
    mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
      if (message.action === 'getDeviceUILayout') {
        respondToInitialLayout = callback
        return
      }
      if (respondToSyncedUIConfigMessage(message, callback)) return
      if (message.action === 'firebaseAuthStatus') {
        callback({ success: true, isSignedIn: false, userInfo: null })
      } else if (message.action === 'getSyncState') {
        callback({ syncState: null })
      } else if (message.action === 'acknowledgeWhatsNew') {
        callback({ success: true })
      }
    })

    render(<Popup />)
    await waitFor(() => {
      expect(respondToInitialLayout).toBeDefined()
      expect(chrome.storage.onChanged.addListener).toHaveBeenCalled()
    })

    const storageListeners = (chrome.storage.onChanged.addListener as jest.Mock).mock.calls
      .map(([listener]) => listener as (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string
      ) => void)
    act(() => {
      for (const listener of storageListeners) {
        listener({
          uiConfig: {
            newValue: {
              ...DEFAULT_UI_CONFIG,
              displayEnabled: false,
              hudDisplayMode: 'full',
            },
          },
        }, 'sync')
      }
    })

    expect(screen.queryByText('サイズ:')).not.toBeInTheDocument()

    act(() => respondToInitialLayout({ success: true, scale: 1.6 }))

    await waitFor(() => {
      expect(screen.getByText('160%')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '非表示' }))
        .toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: '詳細' })).toHaveAttribute('aria-pressed', 'true')
    })
  })

  it('local scale読込timeout後も権威的応答までは倍率ボタンを無効にする', async () => {
    jest.useFakeTimers()
    try {
      let respondToInitialLayout!: (response: unknown) => void
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        if (message.action === 'getDeviceUILayout') {
          respondToInitialLayout = callback
          return
        }
        if (respondToSyncedUIConfigMessage(message, callback)) return
        if (message.action === 'firebaseAuthStatus') {
          callback({ success: true, isSignedIn: false, userInfo: null })
        } else if (message.action === 'getSyncState') {
          callback({ syncState: null })
        } else if (message.action === 'acknowledgeWhatsNew') {
          callback({ success: true })
        }
      })

      render(<Popup />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(respondToInitialLayout).toBeDefined()

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000)
      })

      expect(screen.getByText('100%')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '-' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '表示' })).toBeEnabled()

      act(() => respondToInitialLayout({ success: true, scale: 1.8 }))

      expect(screen.getByText('180%')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '+' })).toBeEnabled()
      expect(screen.getByRole('button', { name: '-' })).toBeEnabled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('外部のuiConfig変更を開いたまま反映し、後続の設定変更で巻き戻さない', async () => {
    localData[UI_SCALE_STORAGE_KEY] = 1.4
    render(<Popup />)
    await waitForAsyncOperations()
    expect(screen.getByText('140%')).toBeInTheDocument()

    const storageListeners = (chrome.storage.onChanged.addListener as jest.Mock).mock.calls
      .map(([listener]) => listener as (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string
      ) => void)

    act(() => {
      for (const listener of storageListeners) {
        listener({
          uiConfig: {
            newValue: {
              ...DEFAULT_UI_CONFIG,
              displayEnabled: false,
              // Legacy value from another device must be ignored.
              scale: 0.6,
            },
          },
        }, 'sync')
      }
    })

    expect(screen.getByRole('button', { name: '非表示' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('140%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '+' }))

    await waitFor(() => {
      expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
        { action: 'setDeviceUIScale', scale: 1.5 },
        expect.any(Function)
      )
    })
    expect(mockChromeStorageSet).not.toHaveBeenCalled()
  })

  it('別の設定画面で変更された端末ローカルのscaleを反映し、後続のbroadcastで巻き戻さない', async () => {
    localData[UI_SCALE_STORAGE_KEY] = 1.4
    render(<Popup />)
    await waitForAsyncOperations()

    const storageListeners = (chrome.storage.onChanged.addListener as jest.Mock).mock.calls
      .map(([listener]) => listener as (
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string
      ) => void)

    act(() => {
      for (const listener of storageListeners) {
        listener({
          [UI_SCALE_STORAGE_KEY]: {
            oldValue: 1.4,
            newValue: 1.6,
          },
        }, 'local')
      }
    })

    expect(screen.getByText('160%')).toBeInTheDocument()

    mockChromeTabsQuery.mockImplementationOnce((_query, callback) => {
      callback([{ id: 123 }])
    })
    mockChromeTabsSendMessage.mockResolvedValue(undefined)
    await userEvent.click(screen.getByRole('button', { name: '詳細' }))

    expect(mockChromeTabsSendMessage).toHaveBeenCalledWith(123, {
      action: 'updateUIConfig',
      config: expect.objectContaining({
        scale: 1.6,
        hudDisplayMode: 'full',
      }),
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

    // デフォルト（新規ユーザー/tableSizeキー欠落時）は全層 = フィルタなし。
    // レンジスライダーなので「両端が最小と最大」で表現される。
    const [lower, upper] = screen.getAllByRole('slider').slice(0, 2) as HTMLInputElement[]
    expect(lower).toHaveAttribute('aria-label', 'テーブル人数の下限')
    expect(upper).toHaveAttribute('aria-label', 'テーブル人数の上限')
    expect(lower).toHaveValue('1')
    expect(upper).toHaveValue('4')

    // 層ごとのチェックボックスは廃止（連続しない選択を作れてしまうため）
    expect(screen.queryByRole('checkbox', { name: 'フル' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'HU (2人)' })).not.toBeInTheDocument()
  })

  it('テーブル人数フィルター変更時はフラットなoptionsキーへ保存しupdateBattleTypeFilterメッセージを送る', async () => {
    render(<Popup />)

    await waitForAsyncOperations()

    // 下限つまみを HU(1) から 3人(2) へ動かす = HUだけ対象外
    const lower = screen.getAllByRole('slider')[0]!
    fireEvent.change(lower, { target: { value: '2' } })

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

  it('旧UIで作れた連続しないtableSizeは起動時に丸めて保存・配信する', async () => {
    // 旧チェックボックスUIでのみ作れた状態（フルとHUだけ）。表示だけを丸めると
    // 「ポップアップは全層選択に見えるのに、実際のフィルタは3人/4人を除外した
    // まま」という不一致が、ユーザーがスライダーを触るまで残ってしまう。
    syncData = {
      options: {
        sendUserData: true,
        filterOptions: {
          gameTypes: { sng: true, mtt: true, ring: true },
          tableSize: { full: true, '4p': false, '3p': false, hu: true },
          handLimit: 500,
          statDisplayConfigs: defaultStatDisplayConfigs,
        },
      },
      uiConfig: DEFAULT_UI_CONFIG,
    }

    render(<Popup />)

    await waitForAsyncOperations()

    const [lower, upper] = screen.getAllByRole('slider').slice(0, 2) as HTMLInputElement[]
    expect(lower).toHaveValue('1')
    expect(upper).toHaveValue('4')

    // storageも同じ全層へ揃う（表示だけが広がることはない）
    await waitFor(() => {
      expect(syncData.options.filterOptions.tableSize).toEqual({
        full: true, '4p': true, '3p': true, hu: true,
      })
    })
    // 対象範囲が実際に変わるので、開いているゲームタブへも伝える
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'updateBattleTypeFilter',
        filterOptions: expect.objectContaining({
          tableSize: { full: true, '4p': true, '3p': true, hu: true },
        }),
      })
    )

    // 丸めた値がstateにも入っていること。表示だけ丸めてstateに古い値を残すと、
    // 次に別のフィルタを変えた瞬間に連続しない値がstorageへ書き戻り、
    // 起動時の移行が取り消される。
    await userEvent.click(screen.getByRole('checkbox', { name: 'MTT' }))

    await waitFor(() => {
      expect(syncData.options.filterOptions.gameTypes.mtt).toBe(false)
    })
    expect(syncData.options.filterOptions.tableSize).toEqual({
      full: true, '4p': true, '3p': true, hu: true,
    })
  })

  it('連続したtableSizeは起動時に書き換えない', async () => {
    syncData = {
      options: {
        sendUserData: true,
        filterOptions: {
          gameTypes: { sng: true, mtt: true, ring: true },
          tableSize: { full: true, '4p': true, '3p': false, hu: false },
          handLimit: 500,
          statDisplayConfigs: defaultStatDisplayConfigs,
        },
      },
      uiConfig: DEFAULT_UI_CONFIG,
    }

    render(<Popup />)

    await waitForAsyncOperations()

    const [lower, upper] = screen.getAllByRole('slider').slice(0, 2) as HTMLInputElement[]
    expect(lower).toHaveValue('3')
    expect(upper).toHaveValue('4')
    expect(syncData.options.filterOptions.tableSize).toEqual({
      full: true, '4p': true, '3p': false, hu: false,
    })
    expect(mockChromeRuntimeSendMessage).not.toHaveBeenCalledWith(
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

    const [lower, upper] = screen.getAllByRole('slider').slice(0, 2) as HTMLInputElement[]
    expect(lower).toHaveValue('1')
    expect(upper).toHaveValue('4')
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

  describe('Firebase認証操作のフィードバック', () => {
    it('成功応答までボタンを無効化し、成功後はbackgroundの認証状態を再取得する', async () => {
      let respondToSignIn: ((response?: unknown) => void) | undefined
      let signedIn = false
      mockSignedOutPopupMessages((callback) => {
        respondToSignIn = callback
      }, () => {
        if (!signedIn) return { isSignedIn: false, userInfo: null }
        return {
          isSignedIn: true,
          userInfo: { email: 'test@example.com', uid: 'test-uid' },
        }
      })

      render(<Popup />)
      await waitForAsyncOperations()

      fireEvent.click(screen.getByRole('button', { name: '自動バックアップを有効にする' }))

      await waitFor(() => {
        expect(respondToSignIn).toBeDefined()
        expect(screen.getByRole('button', { name: '有効化しています...' })).toBeDisabled()
      })

      act(() => {
        signedIn = true
        respondToSignIn?.({ success: true })
      })

      await waitFor(() => {
        expect(screen.getByText('test@example.com')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'ログアウト' })).toBeEnabled()
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      // The action response itself carries no user details. Success therefore
      // refetches the background's authoritative auth state instead of
      // optimistically inventing one in the popup.
      expect(
        mockChromeRuntimeSendMessage.mock.calls.filter(([message]) => message.action === 'firebaseAuthStatus')
      ).toHaveLength(2)
    })

    it('backgroundのエラー応答を表示し、再試行開始時に古いエラーを消す', async () => {
      let attempt = 0
      let respondToRetry: ((response?: unknown) => void) | undefined
      mockSignedOutPopupMessages((callback) => {
        attempt += 1
        if (attempt === 1) {
          callback({ success: false, error: 'Google認証に失敗しました' })
        } else {
          respondToRetry = callback
        }
      })

      render(<Popup />)
      await waitForAsyncOperations()

      await userEvent.click(screen.getByRole('button', { name: '自動バックアップを有効にする' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Google認証に失敗しました')

      fireEvent.click(screen.getByRole('button', { name: '自動バックアップを有効にする' }))

      await waitFor(() => {
        expect(respondToRetry).toBeDefined()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: '有効化しています...' })).toBeDisabled()
      })

      act(() => {
        respondToRetry?.({ success: true })
      })
    })

    it.each(['undefined response', 'synchronous sendMessage rejection'])('%sを通信エラーとして表示する', async (failureMode) => {
      mockSignedOutPopupMessages((callback) => {
        if (failureMode === 'undefined response') {
          callback(undefined)
          return
        }
        throw new Error('Extension context invalidated')
      })

      render(<Popup />)
      await waitForAsyncOperations()

      await userEvent.click(screen.getByRole('button', { name: '自動バックアップを有効にする' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'バックグラウンドとの通信に失敗しました。もう一度お試しください。'
      )
      expect(screen.getByRole('button', { name: '自動バックアップを有効にする' })).toBeEnabled()
    })

    it('対話型サインインが応答しない場合は2分でタイムアウトして再試行可能にする', async () => {
      jest.useFakeTimers()
      mockSignedOutPopupMessages(() => {
        // Deliberately leave the callback unresolved.
      })

      render(<Popup />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      fireEvent.click(screen.getByRole('button', { name: '自動バックアップを有効にする' }))

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: '有効化しています...' })).toBeDisabled()

      await act(async () => {
        await jest.advanceTimersByTimeAsync(120_000)
      })

      expect(screen.getByRole('alert')).toHaveTextContent(
        'バックグラウンドとの通信に失敗しました。もう一度お試しください。'
      )
      expect(screen.getByRole('button', { name: '自動バックアップを有効にする' })).toBeEnabled()

      jest.useRealTimers()
    })

    it('認証後の初回同期が長引いて応答がタイムアウトしても、認証済みなら失敗扱いにしない', async () => {
      jest.useFakeTimers()
      let signedIn = false
      mockSignedOutPopupMessages(() => {
        // Authentication commits, but the original callback remains pending
        // behind a long first auto-sync in the background.
      }, () => signedIn
        ? {
            isSignedIn: true,
            userInfo: { email: 'test@example.com', uid: 'test-uid' },
          }
        : { isSignedIn: false, userInfo: null }
      )

      render(<Popup />)

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      fireEvent.click(screen.getByRole('button', { name: '自動バックアップを有効にする' }))

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: '有効化しています...' })).toBeDisabled()

      signedIn = true
      await act(async () => {
        await jest.advanceTimersByTimeAsync(120_000)
      })

      expect(screen.getByText('test@example.com')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'ログアウト' })).toBeEnabled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()

      jest.useRealTimers()
    })

    it('素早い二重クリックでも認証要求を1件だけ送る', async () => {
      let respondToSignIn: ((response?: unknown) => void) | undefined
      mockSignedOutPopupMessages((callback) => {
        respondToSignIn = callback
      })

      render(<Popup />)
      await waitForAsyncOperations()

      const button = screen.getByRole('button', { name: '自動バックアップを有効にする' })
      act(() => {
        fireEvent.click(button)
        fireEvent.click(button)
      })

      await waitFor(() => {
        expect(respondToSignIn).toBeDefined()
      })
      expect(
        mockChromeRuntimeSendMessage.mock.calls.filter(([message]) => message.action === 'firebaseSignIn')
      ).toHaveLength(1)

      act(() => {
        respondToSignIn?.({ success: true })
      })
    })
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
      if (respondToDeviceLayoutMessage(message, callback)) return
      if (message.action === 'firebaseAuthStatus') {
        callback({
          success: true,
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
        if (respondToDeviceLayoutMessage(message, callback)) return
        if (message.action === 'firebaseAuthStatus') {
          callback({ success: true, isSignedIn: false })
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
        if (respondToDeviceLayoutMessage(message, callback)) return
        if (message.action === 'firebaseAuthStatus') {
          callback({ success: true, isSignedIn: false })
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
    it('auth restoreエラー応答ではstorage cacheのサインイン表示を維持する', async () => {
      ;(chrome.storage.local.get as jest.Mock).mockImplementation(
        (_key: string, callback: (result: Record<string, unknown>) => void) => callback({
          firebaseAuthCache: {
            isSignedIn: true,
            userInfo: { email: 'cached@example.com', uid: 'cached-user' },
          },
        })
      )
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        if (respondToDeviceLayoutMessage(message, callback)) return
        if (message.action === 'firebaseAuthStatus') {
          callback({ success: false, error: 'auth restore failed' })
        } else if (message.action === 'getSyncState') {
          callback({ success: true, syncState: null })
        } else if (message.action === 'acknowledgeWhatsNew') {
          callback({ success: true })
        }
      })

      render(<Popup />)

      expect(await screen.findByText('cached@example.com')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'ログアウト' })).toBeEnabled()
    })

    it('firebaseAuthStatus/getSyncStateがタイムアウトしてもUIはブロックされず既定状態で使用可能', async () => {
      jest.useFakeTimers()

      // Simulate a busy/unresponsive service worker: sendMessage never calls its callback
      mockChromeRuntimeSendMessage.mockImplementation((message, callback) => {
        if (respondToDeviceLayoutMessage(message, callback)) return
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

  describe('統計の並べ替え（未適用の変更）', () => {
    // 一覧に出ている統計名のみ（playerNameはHUDヘッダー常時表示のため非表示）
    const displayedStatNames = () =>
      screen.getAllByRole('listitem')
        .map(item => item.querySelector('.MuiListItemText-primary')?.textContent)

    const orderButtonsFor = (statName: string) => {
      const listItem = screen.getByText(statName).closest('li')!
      const [up, down] = Array.from(listItem.querySelectorAll('button'))
      return { up: up!, down: down! }
    }

    it('一覧はplayerNameを除外して表示する', async () => {
      render(<Popup />)
      await waitForAsyncOperations()

      expect(displayedStatNames().slice(0, 3)).toEqual(['HAND', 'VPIP', 'VPIP·F'])
      expect(screen.queryByText('Name')).not.toBeInTheDocument()
    })

    it('↑1回で表示順が1つ動く（非表示のplayerNameを跨ぐケース）', async () => {
      // 回帰テスト: 生配列インデックスでorderを交換していた頃は、
      // VPIP（表示2番目）の↑1回目が非表示のplayerName（order 1）と
      // 入れ替わるだけで、表示順が全く変化しないデッドクリックだった。
      render(<Popup />)
      await waitForAsyncOperations()

      await userEvent.click(orderButtonsFor('VPIP').up)

      expect(displayedStatNames().slice(0, 3)).toEqual(['VPIP', 'HAND', 'VPIP·F'])
      expect(screen.getByText('(未適用の変更があります)')).toBeInTheDocument()
    })

    it('↓1回でも表示順が1つ動く（非表示のplayerNameを跨ぐケース）', async () => {
      render(<Popup />)
      await waitForAsyncOperations()

      await userEvent.click(orderButtonsFor('HAND').down)

      expect(displayedStatNames().slice(0, 3)).toEqual(['VPIP', 'HAND', 'VPIP·F'])
    })

    it('適用すると並べ替え後のstatDisplayConfigsが保存・配信される', async () => {
      render(<Popup />)
      await waitForAsyncOperations()

      await userEvent.click(orderButtonsFor('VPIP').up)
      await userEvent.click(screen.getByRole('button', { name: '適用' }))

      await waitFor(() => {
        expect(syncData.options.filterOptions.statDisplayConfigs[0]).toEqual(
          expect.objectContaining({ id: 'vpip', order: 0 })
        )
      })
      // playerNameは自身のスロット（order 1）に据え置かれ、HANDが後ろへ
      const savedOrder = (syncData.options.filterOptions.statDisplayConfigs as { id: string }[])
        .slice(0, 3)
        .map(config => config.id)
      expect(savedOrder).toEqual(['vpip', 'playerName', 'hands'])

      expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'updateBattleTypeFilter',
          filterOptions: expect.objectContaining({
            statDisplayConfigs: expect.arrayContaining([
              expect.objectContaining({ id: 'vpip', order: 0 })
            ])
          })
        })
      )
    })

    it('既定構成（module-levelのdefaultStatDisplayConfigs）を汚染しない（保存済みoptionsが無い初回表示）', async () => {
      // pendingStatDisplayConfigsにdefaultStatDisplayConfigsの要素が
      // そのまま入る現存唯一の経路: 保存済みoptionsが無いとstateの初期値が
      // module-levelの定数そのものになる。その場書き換え実装では、
      // 「適用」していない並べ替えが定数に残り、同一JSコンテキスト内で
      // 以降に呼ばれるmergeStatDisplayConfigs等が汚れた既定値でマージする。
      syncData = { uiConfig: DEFAULT_UI_CONFIG }
      const before = defaultStatDisplayConfigs.map(config => ({ ...config }))

      render(<Popup />)
      await waitForAsyncOperations()

      // 往復させるとその場書き換え実装でもorderが元に戻ってしまうため片道で検証する
      await userEvent.click(orderButtonsFor('HAND').down)

      // 並べ替えは保留中のstateにのみ反映される
      expect(displayedStatNames().slice(0, 3)).toEqual(['VPIP', 'HAND', 'VPIP·F'])
      expect(screen.getByText('(未適用の変更があります)')).toBeInTheDocument()
      expect(defaultStatDisplayConfigs).toEqual(before)
    })

    it('既定構成（module-levelのdefaultStatDisplayConfigs）を汚染しない（保存済み設定に欠けがある場合）', async () => {
      // 保存済み設定に無い項目（pfr）をmergeStatDisplayConfigsが補う経路。
      // mergeStatDisplayConfigs自体も複製を返すようになったため現在この経路で
      // 共有参照は入らないが、二重の防御（マージ側の複製・並べ替え側の複製）の
      // どちらか一方が外れても定数が汚れないことをUI側から独立に保証する。
      syncData.options.filterOptions.statDisplayConfigs =
        defaultStatDisplayConfigs.filter(config => config.id !== 'pfr')
      const before = defaultStatDisplayConfigs.map(config => ({ ...config }))

      render(<Popup />)
      await waitForAsyncOperations()

      await userEvent.click(orderButtonsFor('PFR').up)

      expect(defaultStatDisplayConfigs).toEqual(before)
    })
  })

  /**
   * リプレイ取り込みは**フラグのみで動く非公開機能**として入っている。
   * ポップアップに操作や説明を出すのは、プライバシーポリシーとストア掲載
   * 情報の開示を伴う公開時点まで行わない（sola裁定、リリース方針）。
   *
   * 「まだ出さない」という決定は、コードを消すのではなくここで固定する ――
   * セクションを足せばこのテストが落ちるので、開示の手当てを伴わない
   * 露出が黙って入ることはない。
   */
  describe('リプレイ取り込みは非公開（フラグのみ）', () => {
    it('ポップアップにリプレイ取り込みの操作も説明も出さない', async () => {
      render(<Popup />)
      await waitForAsyncOperations()

      const text = document.body.textContent ?? ''
      expect(text).not.toContain('リプレイ')
      expect(text).not.toContain('対局が終わったあと')
      expect(screen.queryByRole('switch', { name: /リプレイ/ })).toBeNull()
    })

    it('ポップアップは実験フラグを読みにも書きにもいかない', async () => {
      render(<Popup />)
      await waitForAsyncOperations()

      const touchedKeys = [
        ...(chrome.storage.sync.get as jest.Mock).mock.calls,
        ...(chrome.storage.sync.set as jest.Mock).mock.calls
      ].map(([arg]) => JSON.stringify(arg ?? ''))
      expect(touchedKeys.some(key => key.includes('experimentalReplayImportEnabled'))).toBe(false)
    })
  })
})
