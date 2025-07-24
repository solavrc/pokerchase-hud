import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UIScaleSection } from './UIScaleSection'
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

describe('UIScaleSection', () => {
  const mockSetUIConfig = jest.fn()

  const defaultProps = {
    uiConfig: DEFAULT_UI_CONFIG,
    setUIConfig: mockSetUIConfig,
  }

  beforeEach(() => {
    jest.clearAllMocks()
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
    expect(mockChromeStorageSet).toHaveBeenCalledWith({ uiConfig: expectedConfig })
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
    expect(mockChromeStorageSet).toHaveBeenCalledWith({ uiConfig: expectedConfig })
    expect(mockTabsSendMessage).toHaveBeenCalledWith(1, {
      action: 'updateUIConfig',
      config: expectedConfig,
    })
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