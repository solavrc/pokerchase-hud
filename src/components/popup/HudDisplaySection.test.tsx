import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HudDisplaySection } from './HudDisplaySection'
import type { UIConfig } from '../../types/hand-log'
import { DEFAULT_UI_CONFIG } from '../../types/hand-log'

// Mock chrome runtime and tabs
const mockChromeRuntimeSendMessage = jest.fn()
const mockTabsQuery = jest.fn()
const mockTabsSendMessage = jest.fn()
global.chrome = {
  ...global.chrome,
  runtime: {
    ...global.chrome.runtime,
    sendMessage: mockChromeRuntimeSendMessage,
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
    mockChromeRuntimeSendMessage.mockImplementation((_message, callback) => {
      callback({ success: true })
    })
    mockTabsQuery.mockImplementation((_, callback) => {
      callback([{ id: 1 }, { id: 2 }])
    })
  })

  it('HUD表示モードのUIを表示する', () => {
    render(<HudDisplaySection {...defaultProps} />)

    expect(screen.getByRole('button', { name: '簡易' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '詳細' })).toBeInTheDocument()
  })

  it('DEFAULT_UI_CONFIG（新規/既存ユーザーのマイグレーション後）は簡易が選択されている', () => {
    render(<HudDisplaySection {...defaultProps} />)

    expect(screen.getByRole('button', { name: '簡易' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '詳細' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('詳細を選択すると保存され全ゲームタブへ通知される', async () => {
    render(<HudDisplaySection {...defaultProps} />)

    await userEvent.click(screen.getByRole('button', { name: '詳細' }))

    const expectedConfig: UIConfig = {
      ...DEFAULT_UI_CONFIG,
      hudDisplayMode: 'full',
    }

    expect(mockSetUIConfig).toHaveBeenCalledWith(expectedConfig)
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'setSyncedUIConfig', config: expectedConfig },
      expect.any(Function)
    )
    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
    expect(mockTabsSendMessage).toHaveBeenCalledWith(2, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
  })

  it('統計カラー表示の設定は廃止され、切り替えUIを持たない', () => {
    // 常時有効にしたので設定項目そのものが無い（sola指定）。
    render(<HudDisplaySection {...defaultProps} />)

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText('統計カラー表示')).not.toBeInTheDocument()
  })

  it('旧フィールド欠落のuiConfig（マイグレーション前提未達のフォールバック）でも簡易で描画される', () => {
    // #143以前に保存されたuiConfig相当（hudDisplayModeが無い）
    const legacyConfig = { displayEnabled: true, scale: 1.0 } as UIConfig

    render(<HudDisplaySection uiConfig={legacyConfig} setUIConfig={mockSetUIConfig} />)

    expect(screen.getByRole('button', { name: '簡易' })).toHaveAttribute('aria-pressed', 'true')
  })
})
