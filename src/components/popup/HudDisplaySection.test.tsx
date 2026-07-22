import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HudDisplaySection } from './HudDisplaySection'
import type { UIConfig } from '../../types/hand-log'
import { DEFAULT_UI_CONFIG } from '../../types/hand-log'

// Mock chrome storage and tabs
const mockChromeStorageSet = jest.fn()
const mockTabsQuery = jest.fn()
const mockTabsSendMessage = jest.fn()
global.chrome = {
  ...global.chrome,
  storage: {
    sync: {
      set: mockChromeStorageSet,
    },
  },
  tabs: {
    query: mockTabsQuery,
    sendMessage: mockTabsSendMessage,
  },
} as any

describe('HudDisplaySection', () => {
  const mockSetUIConfig = jest.fn()

  const defaultProps = {
    uiConfig: DEFAULT_UI_CONFIG,
    setUIConfig: mockSetUIConfig,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockTabsSendMessage.mockResolvedValue(undefined)
    mockTabsQuery.mockImplementation((_, callback) => {
      callback([{ id: 1 }, { id: 2 }])
    })
  })

  it('HUD表示モードと統計カラー表示のUIを表示する', () => {
    render(<HudDisplaySection {...defaultProps} />)

    expect(screen.getByText('表示モード:')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'コンパクト' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'フル' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '統計カラー表示' })).toBeInTheDocument()
  })

  it('DEFAULT_UI_CONFIG（新規/既存ユーザーのマイグレーション後）はコンパクト+カラーONが選択されている', () => {
    render(<HudDisplaySection {...defaultProps} />)

    expect(screen.getByRole('radio', { name: 'コンパクト' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'フル' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '統計カラー表示' })).toBeChecked()
  })

  it('フルを選択すると保存され全ゲームタブへ通知される', async () => {
    render(<HudDisplaySection {...defaultProps} />)

    await userEvent.click(screen.getByRole('radio', { name: 'フル' }))

    const expectedConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      hudDisplayMode: 'full',
    }

    expect(mockSetUIConfig).toHaveBeenCalledWith(expectedConfig)
    expect(mockChromeStorageSet).toHaveBeenCalledWith({ uiConfig: expectedConfig })
    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
    expect(mockTabsSendMessage).toHaveBeenCalledWith(2, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
  })

  it('統計カラー表示のチェックを外すと保存され全ゲームタブへ通知される', async () => {
    render(<HudDisplaySection {...defaultProps} />)

    await userEvent.click(screen.getByRole('checkbox', { name: '統計カラー表示' }))

    const expectedConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      hudColorCoding: false,
    }

    expect(mockSetUIConfig).toHaveBeenCalledWith(expectedConfig)
    expect(mockChromeStorageSet).toHaveBeenCalledWith({ uiConfig: expectedConfig })
    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
  })

  it('旧フィールド欠落のuiConfig（マイグレーション前提未達のフォールバック）でもcompact+ONで描画される', () => {
    // #143以前に保存されたuiConfig相当（hudDisplayMode/hudColorCodingが無い）
    const legacyConfig = { displayEnabled: true, scale: 1.0 } as UIConfig

    render(<HudDisplaySection uiConfig={legacyConfig} setUIConfig={mockSetUIConfig} />)

    expect(screen.getByRole('radio', { name: 'コンパクト' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '統計カラー表示' })).toBeChecked()
  })
})
