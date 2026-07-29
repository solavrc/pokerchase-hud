import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UIScaleSection } from './UIScaleSection'
import type { UIConfig } from '../../types/hand-log'
import { DEFAULT_UI_CONFIG } from '../../types/hand-log'
import {
  toSyncedUIConfig,
  UI_SCALE_STORAGE_KEY,
} from '../../utils/ui-config-storage'

// Mock chrome storage and tabs
const mockChromeStorageSet = jest.fn()
const mockChromeStorageGet = jest.fn()
const mockChromeLocalStorageSet = jest.fn()
const mockTabsQuery = jest.fn()
const mockTabsSendMessage = jest.fn()
global.chrome = {
  ...global.chrome,
  storage: {
    sync: {
      get: mockChromeStorageGet,
      set: mockChromeStorageSet,
    },
    local: {
      set: mockChromeLocalStorageSet,
    },
  },
  tabs: {
    query: mockTabsQuery,
    sendMessage: mockTabsSendMessage,
  },
} as any

describe('UIScaleSection', () => {
  const mockSetUIConfig = jest.fn()

  const defaultProps = {
    uiConfig: DEFAULT_UI_CONFIG,
    setUIConfig: mockSetUIConfig,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockTabsSendMessage.mockResolvedValue(undefined)
    mockChromeStorageGet.mockImplementation((_key, callback) => {
      callback({ uiConfig: DEFAULT_UI_CONFIG })
    })
    mockChromeLocalStorageSet.mockImplementation((_items, callback?) => {
      if (typeof callback === 'function') callback()
    })
    mockTabsQuery.mockImplementation((_, callback) => {
      callback([{ id: 1 }, { id: 2 }])
    })
  })

  it('UI表示設定を表示', () => {
    render(<UIScaleSection {...defaultProps} />)

    expect(screen.getByText('サイズ:')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('表示')).toBeInTheDocument()
    expect(screen.getByText('非表示')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' }))
      .toHaveValue('Shift + H')
  })

  it('省略される長いショートカットもtitleで完全表示する', () => {
    const longShortcutConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      toggleShortcut: {
        code: 'NumpadEnter',
        key: 'Enter',
        ctrl: true,
        alt: true,
        shift: true,
        meta: false,
      },
    }

    render(<UIScaleSection {...defaultProps} uiConfig={longShortcutConfig} />)

    expect(screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' }))
      .toHaveAttribute(
        'title',
        'Ctrl + Alt + Shift + Numpad Enter（クリックして変更・右クリックで解除）'
      )
  })

  it('小型入力欄でショートカットを記録する', () => {
    render(<UIScaleSection {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.focus(input)
    fireEvent.keyDown(input, {
      key: 'y',
      code: 'KeyY',
      shiftKey: true,
    })

    expect(mockChromeStorageSet).toHaveBeenCalledWith({
      uiConfig: expect.objectContaining({
        toggleShortcut: {
          code: 'KeyY',
          key: 'y',
          ctrl: false,
          alt: false,
          shift: true,
          meta: false,
        },
      }),
    })
    expect(mockChromeStorageSet.mock.calls.at(-1)?.[0].uiConfig)
      .not.toHaveProperty('scale')
  })

  it('ショートカット入力欄の右クリックで明示的な解除状態を保存する', () => {
    render(<UIScaleSection {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.contextMenu(input)

    expect(mockChromeStorageSet).toHaveBeenCalledWith({
      uiConfig: expect.objectContaining({ toggleShortcut: null }),
    })
    expect(mockChromeStorageSet.mock.calls.at(-1)?.[0].uiConfig)
      .not.toHaveProperty('scale')
  })

  it('TabとShift+Tabは通常のフォーカス移動として通す', () => {
    render(<UIScaleSection {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.focus(input)
    expect(fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' })).toBe(true)
    fireEvent.focus(input)
    expect(fireEvent.keyDown(input, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(true)

    expect(mockChromeStorageSet).not.toHaveBeenCalled()
  })

  it('旧形式の部分設定へ既定値を補ってからショートカットを保存する', () => {
    mockChromeStorageGet.mockImplementation((_key, callback) => {
      callback({ uiConfig: { displayEnabled: false, scale: 1.2 } })
    })
    render(<UIScaleSection {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.focus(input)
    fireEvent.keyDown(input, {
      key: 'h',
      code: 'KeyH',
      shiftKey: true,
    })

    expect(mockChromeStorageSet).toHaveBeenCalledWith({
      uiConfig: expect.objectContaining({
        displayEnabled: false,
        hudDisplayMode: DEFAULT_UI_CONFIG.hudDisplayMode,
        hudColorCoding: DEFAULT_UI_CONFIG.hudColorCoding,
      }),
    })
    expect(mockChromeStorageSet.mock.calls.at(-1)?.[0].uiConfig)
      .not.toHaveProperty('scale')
  })

  it('UI表示のON/OFFを切り替え', async () => {
    render(<UIScaleSection {...defaultProps} />)

    const offButton = screen.getByText('非表示')
    
    // OFFに切り替え
    await userEvent.click(offButton)

    const expectedConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      displayEnabled: false,
    }

    expect(mockSetUIConfig).toHaveBeenCalledWith(expectedConfig)
    expect(mockChromeStorageSet).toHaveBeenCalledWith({
      uiConfig: toSyncedUIConfig(expectedConfig),
    })
    expect(mockTabsQuery).toHaveBeenCalled()
    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
    expect(mockTabsSendMessage).toHaveBeenCalledWith(2, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
  })

  it('スケールを変更', async () => {
    render(<UIScaleSection {...defaultProps} />)

    const plusButton = screen.getByText('+')
    
    // スケールを0.1増やす (1.0 -> 1.1)
    await userEvent.click(plusButton)

    const expectedConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      scale: 1.1,
    }

    expect(mockSetUIConfig).toHaveBeenCalledWith(expectedConfig)
    expect(mockChromeLocalStorageSet).toHaveBeenCalledWith(
      { [UI_SCALE_STORAGE_KEY]: 1.1 },
      expect.any(Function)
    )
    expect(mockChromeStorageSet).not.toHaveBeenCalled()
    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
  })

  it.each([
    'Could not establish connection. Receiving end does not exist.',
    'The message port closed before a response was received.',
  ])('ゲームタブだけに通知し、想定済みのone-way送信エラーを消費する: %s', async (errorMessage) => {
    const missingReceiver = Promise.reject(
      new Error(errorMessage)
    )
    await missingReceiver.catch(() => {})
    const catchSpy = jest.spyOn(missingReceiver, 'catch')
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    mockTabsSendMessage.mockReturnValue(missingReceiver)

    render(<UIScaleSection {...defaultProps} />)
    await userEvent.click(screen.getByText('+'))

    expect(mockTabsQuery).toHaveBeenCalledWith(
      { url: ['https://game.poker-chase.com/*'] },
      expect.any(Function)
    )
    expect(catchSpy).toHaveBeenCalledWith(expect.any(Function))
    await Promise.resolve()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('スケールの最小値と最大値を制限', () => {
    // 最小値の確認
    const minConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      scale: 0.5,
    }
    const { rerender } = render(<UIScaleSection {...defaultProps} uiConfig={minConfig} />)
    
    expect(screen.getByText('-')).toBeDisabled()
    expect(screen.getByText('+')).not.toBeDisabled()
    
    // 最大値の確認
    const maxConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      scale: 2.0,
    }
    rerender(<UIScaleSection {...defaultProps} uiConfig={maxConfig} />)
    
    expect(screen.getByText('-')).not.toBeDisabled()
    expect(screen.getByText('+')).toBeDisabled()
  })

  it('現在のスケール値を表示', () => {
    const customConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      scale: 1.3,
    }

    render(<UIScaleSection {...defaultProps} uiConfig={customConfig} />)

    expect(screen.getByText('130%')).toBeInTheDocument()
  })

  it('UI表示がOFFの場合もスケール設定は表示される', () => {
    const disabledConfig: UIConfig = {
      displayEnabled: false,
      scale: 1.0,
    }

    render(<UIScaleSection {...defaultProps} uiConfig={disabledConfig} />)

    // 非表示ボタンが選択されているべき
    const offButton = screen.getByText('非表示')
    const onButton = screen.getByText('表示')
    expect(offButton.closest('button')).toHaveClass('Mui-selected')
    expect(onButton.closest('button')).not.toHaveClass('Mui-selected')
    
    // スケール設定も表示されている
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('+')).toBeInTheDocument()
    expect(screen.getByText('-')).toBeInTheDocument()
  })
})
