import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UIScaleSection } from './UIScaleSection'
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

describe('UIScaleSection', () => {
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

  it('UI表示設定を表示', () => {
    render(<UIScaleSection {...defaultProps} />)

    expect(screen.getByText('サイズ:')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('表示')).toBeInTheDocument()
    expect(screen.getByText('非表示')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '位置とサイズをリセット' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' }))
      .toHaveValue('Shift + H')
  })

  it('HUDとハンドログの位置とサイズのリセットを永続backgroundへ委譲する', async () => {
    const user = userEvent.setup()
    render(<UIScaleSection {...defaultProps} />)

    await user.click(screen.getByRole('button', { name: '位置とサイズをリセット' }))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'resetDeviceUILayout' },
      expect.any(Function)
    )
    expect(mockTabsQuery).not.toHaveBeenCalled()
    expect(mockTabsSendMessage).not.toHaveBeenCalled()
  })

  it('リセット成功後は倍率表示も既定へ戻す', async () => {
    // 倍率のstorage削除とゲームタブへの配信はbackgroundが行うが、ポップアップ
    // 自身は配信を購読していないので、成功応答を受けて自前で戻す必要がある。
    const user = userEvent.setup()
    render(
      <UIScaleSection
        {...defaultProps}
        uiConfig={{ ...DEFAULT_UI_CONFIG, scale: 1.6 }}
      />
    )
    expect(screen.getByText('160%')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '位置とサイズをリセット' }))

    expect(mockSetUIConfig).toHaveBeenCalledWith(
      expect.objectContaining({ scale: DEFAULT_UI_CONFIG.scale })
    )
  })

  it('リセット応答が遅れても、その間に押した倍率変更を捨てない', async () => {
    // リセットの採番はクリック時点で行う。完了時点で採番すると、応答待ちの
    // 間に押した + の方が小さいIDになり、永続化に成功した後発の倍率が
    // stale判定で捨てられる。
    const user = userEvent.setup()
    let completeReset: (() => void) | undefined
    mockChromeRuntimeSendMessage.mockImplementation((message: any, callback: any) => {
      if (message.action === 'resetDeviceUILayout') {
        completeReset = () => callback({ success: true })
        return
      }
      callback({ success: true })
    })
    render(
      <UIScaleSection
        {...defaultProps}
        uiConfig={{ ...DEFAULT_UI_CONFIG, scale: 1.6 }}
      />
    )

    await user.click(screen.getByRole('button', { name: '位置とサイズをリセット' }))
    expect(completeReset).toBeDefined()

    // リセット応答より先に倍率を上げ、その書き込みは成功する。
    await user.click(screen.getByRole('button', { name: '+' }))
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'setDeviceUIScale' }),
      expect.any(Function)
    )
    const appliedScale = mockSetUIConfig.mock.calls.at(-1)?.[0]?.scale
    expect(appliedScale).toBeGreaterThan(1.6)

    // 遅れて届いたリセット応答は、後発の倍率を上書きしない。
    mockSetUIConfig.mockClear()
    completeReset?.()

    expect(mockSetUIConfig).not.toHaveBeenCalled()
  })

  it('リセットが失敗した場合は倍率表示を戻さない', async () => {
    const user = userEvent.setup()
    mockChromeRuntimeSendMessage.mockImplementation((_message, callback) => {
      callback({ success: false, error: 'remove failed' })
    })
    render(
      <UIScaleSection
        {...defaultProps}
        uiConfig={{ ...DEFAULT_UI_CONFIG, scale: 1.6 }}
      />
    )

    await user.click(screen.getByRole('button', { name: '位置とサイズをリセット' }))

    expect(mockSetUIConfig).not.toHaveBeenCalled()
    expect(screen.getByText('160%')).toBeInTheDocument()
  })

  it('UI配置の永続削除に失敗した場合は表示だけをリセットしない', async () => {
    const user = userEvent.setup()
    mockChromeRuntimeSendMessage.mockImplementation((_message, callback) => {
      callback({ success: false, error: 'remove failed' })
    })
    render(<UIScaleSection {...defaultProps} />)

    await user.click(screen.getByRole('button', { name: '位置とサイズをリセット' }))

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'resetDeviceUILayout' },
      expect.any(Function)
    )
    expect(mockTabsSendMessage).not.toHaveBeenCalled()
  })

  it('端末倍率が未確定の間は倍率操作だけを無効化する', () => {
    render(
      <UIScaleSection
        {...defaultProps}
        scaleControlsDisabled
      />
    )

    expect(screen.getByRole('button', { name: '+' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '-' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '表示' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '非表示' })).toBeEnabled()
    expect(screen.getByRole('button', {
      name: '位置とサイズをリセット',
    })).toBeEnabled()
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

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith({
      action: 'setSyncedUIConfig',
      patch: {
        toggleShortcut: {
          code: 'KeyY',
          key: 'y',
          ctrl: false,
          alt: false,
          shift: true,
          meta: false,
        },
      },
    }, expect.any(Function))
    expect(mockTabsSendMessage).not.toHaveBeenCalled()
  })

  it('ショートカット入力欄の右クリックで明示的な解除状態を保存する', () => {
    render(<UIScaleSection {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.contextMenu(input)

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith({
      action: 'setSyncedUIConfig',
      patch: { toggleShortcut: null },
    }, expect.any(Function))
  })

  it('TabとShift+Tabは通常のフォーカス移動として通す', () => {
    render(<UIScaleSection {...defaultProps} />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.focus(input)
    expect(fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' })).toBe(true)
    fireEvent.focus(input)
    expect(fireEvent.keyDown(input, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(true)

    expect(mockChromeRuntimeSendMessage).not.toHaveBeenCalled()
  })

  it('ショートカットだけをpatchとして保存する', () => {
    const legacyConfig = { displayEnabled: false, scale: 1.2 } as UIConfig
    render(<UIScaleSection
      {...defaultProps}
      uiConfig={legacyConfig}
    />)
    const input = screen.getByRole('textbox', { name: 'HUD表示切り替えショートカット' })

    fireEvent.focus(input)
    fireEvent.keyDown(input, {
      key: 'h',
      code: 'KeyH',
      shiftKey: true,
    })

    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith({
      action: 'setSyncedUIConfig',
      patch: {
        toggleShortcut: expect.objectContaining({
          code: 'KeyH',
        }),
      },
    }, expect.any(Function))
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
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'setSyncedUIConfig', config: expectedConfig },
      expect.any(Function)
    )
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
    expect(mockChromeRuntimeSendMessage).toHaveBeenCalledWith(
      { action: 'setDeviceUIScale', scale: 1.1 },
      expect.any(Function)
    )
    expect(mockChromeRuntimeSendMessage.mock.calls).not.toContainEqual([
      expect.objectContaining({ action: 'setSyncedUIConfig' }),
      expect.any(Function),
    ])
    expect(mockTabsQuery).not.toHaveBeenCalled()
    expect(mockTabsSendMessage).not.toHaveBeenCalled()
  })

  it('保存応答待ちの連続クリックを累積して保存する', () => {
    const responses: Array<(response: unknown) => void> = []
    mockChromeRuntimeSendMessage.mockImplementation((_message, callback) => {
      responses.push(callback)
    })
    render(<UIScaleSection {...defaultProps} />)

    fireEvent.click(screen.getByText('+'))
    fireEvent.click(screen.getByText('+'))

    expect(mockChromeRuntimeSendMessage.mock.calls.map(([message]) => message))
      .toEqual([
        { action: 'setDeviceUIScale', scale: 1.1 },
        { action: 'setDeviceUIScale', scale: 1.2 },
      ])

    responses[0]!({ success: true })
    responses[1]!({ success: true })
    expect(mockSetUIConfig).toHaveBeenLastCalledWith({
      ...DEFAULT_UI_CONFIG,
      scale: 1.2,
    })
  })

  it('新しいscale成功後に届く古い成功応答では巻き戻さない', () => {
    const responses: Array<(response: unknown) => void> = []
    mockChromeRuntimeSendMessage.mockImplementation((_message, callback) => {
      responses.push(callback)
    })
    render(<UIScaleSection {...defaultProps} />)

    fireEvent.click(screen.getByText('+'))
    fireEvent.click(screen.getByText('+'))
    responses[1]!({ success: true })
    responses[0]!({ success: true })

    expect(mockSetUIConfig).toHaveBeenCalledTimes(1)
    expect(mockSetUIConfig).toHaveBeenCalledWith({
      ...DEFAULT_UI_CONFIG,
      scale: 1.2,
    })
  })

  it('scale保存失敗時は表示を更新せずbroadcastしない', async () => {
    mockChromeRuntimeSendMessage.mockImplementationOnce((_message, callback) => {
      callback({ success: false, error: 'quota' })
    })
    render(<UIScaleSection {...defaultProps} />)

    await userEvent.click(screen.getByText('+'))

    expect(mockSetUIConfig).not.toHaveBeenCalled()
    expect(mockTabsQuery).not.toHaveBeenCalled()
    expect(mockTabsSendMessage).not.toHaveBeenCalled()
  })

  it('scale保存失敗後の次操作は最後の確定値から計算する', () => {
    mockChromeRuntimeSendMessage.mockImplementationOnce((_message, callback) => {
      callback({ success: false, error: 'quota' })
    })
    render(<UIScaleSection {...defaultProps} />)

    fireEvent.click(screen.getByText('+'))
    fireEvent.click(screen.getByText('+'))

    expect(mockChromeRuntimeSendMessage.mock.calls.map(([message]) => message))
      .toEqual([
        { action: 'setDeviceUIScale', scale: 1.1 },
        { action: 'setDeviceUIScale', scale: 1.1 },
      ])
  })

  it('scale保存timeout後の遅いsuccessは最新設定へscaleだけを反映する', () => {
    jest.useFakeTimers()
    try {
      let respond!: (response: unknown) => void
      mockChromeRuntimeSendMessage.mockImplementationOnce((_message, callback) => {
        respond = callback
      })
      const { rerender } = render(<UIScaleSection {...defaultProps} />)

      fireEvent.click(screen.getByText('+'))
      jest.advanceTimersByTime(1_000)

      expect(mockSetUIConfig).not.toHaveBeenCalled()
      expect(mockTabsQuery).not.toHaveBeenCalled()

      const newerConfig = {
        ...DEFAULT_UI_CONFIG,
        displayEnabled: false,
      }
      rerender(<UIScaleSection {...defaultProps} uiConfig={newerConfig} />)
      respond({ success: true })

      const reconciledConfig = {
        ...newerConfig,
        scale: 1.1,
      }
      expect(mockSetUIConfig).toHaveBeenCalledWith(reconciledConfig)
      expect(mockTabsQuery).not.toHaveBeenCalled()
      expect(mockTabsSendMessage).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('scale保存timeout中の次操作は未確定の倍率から累積する', () => {
    jest.useFakeTimers()
    try {
      const responses: Array<(response: unknown) => void> = []
      mockChromeRuntimeSendMessage.mockImplementation((_message, callback) => {
        responses.push(callback)
      })
      render(<UIScaleSection {...defaultProps} />)

      fireEvent.click(screen.getByText('+'))
      jest.advanceTimersByTime(1_000)
      fireEvent.click(screen.getByText('+'))

      expect(mockChromeRuntimeSendMessage.mock.calls.map(([message]) => message))
        .toEqual([
          { action: 'setDeviceUIScale', scale: 1.1 },
          { action: 'setDeviceUIScale', scale: 1.2 },
        ])

      responses[0]!({ success: true })
      responses[1]!({ success: true })
      expect(mockSetUIConfig).toHaveBeenLastCalledWith({
        ...DEFAULT_UI_CONFIG,
        scale: 1.2,
      })
    } finally {
      jest.useRealTimers()
    }
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
    await userEvent.click(screen.getByText('非表示'))

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
