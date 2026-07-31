import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import {
  DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS,
  isValidHandLogLayout,
  isValidHudPositionId,
  loadHandLogLayout,
  mergeUIConfigWithLocalScale,
  loadLocalUIScale,
  LEGACY_SYNC_UI_SCALE_KEY,
  persistSyncedUIConfig,
  resolveLocalUIScale,
  resetUILayout,
  saveHandLogLayout,
  saveLocalUIScale,
  saveHudPosition,
  saveSyncedUIConfig,
  toSyncedUIConfig,
} from './ui-config-storage'

describe('ui-config-storage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('端末ローカルのscaleをlegacy sync値より優先する', () => {
    expect(mergeUIConfigWithLocalScale(
      { ...DEFAULT_UI_CONFIG, scale: 0.7, displayEnabled: false },
      1.4
    )).toEqual({
      ...DEFAULT_UI_CONFIG,
      displayEnabled: false,
      scale: 1.4,
    })
  })

  it('端末ローカル値がない移行前はlegacy sync scaleを保持する', () => {
    expect(mergeUIConfigWithLocalScale(
      { ...DEFAULT_UI_CONFIG, scale: 1.6 },
      undefined
    ).scale).toBe(1.6)
  })

  it.each([undefined, null, '1.2', 0.4, 2.1, Number.NaN])(
    '不正な端末ローカルscale %p は既定値へ戻す',
    (value) => {
      expect(resolveLocalUIScale(value)).toBe(DEFAULT_UI_CONFIG.scale)
    }
  )

  it.each([0, 5, 100, 105])(
    '通常HUDとリアルタイムHUDの位置ID %p を許可する',
    (value) => {
      expect(isValidHudPositionId(value)).toBe(true)
    }
  )

  it.each([-1, 6, 99, 106, 1.5, '100'])(
    '位置保存に使わないID %p を拒否する',
    (value) => {
      expect(isValidHudPositionId(value)).toBe(false)
    }
  )

  it('有限座標と最小サイズ以上のハンドログlayoutだけを許可する', () => {
    expect(isValidHandLogLayout({
      left: -100,
      top: 50,
      width: 200,
      height: 80,
    })).toBe(true)
    expect(isValidHandLogLayout({
      left: Number.NaN,
      top: 50,
      width: 400,
      height: 100,
    })).toBe(false)
    expect(isValidHandLogLayout({
      left: 0,
      top: 0,
      width: 199,
      height: 79,
    })).toBe(false)
  })

  it('新規同期payloadから端末ローカルscaleを除外する', () => {
    const config = {
      ...DEFAULT_UI_CONFIG,
      scale: 1.5,
      displayEnabled: false,
    }

    expect(toSyncedUIConfig(config)).toEqual({
      displayEnabled: false,
      hudDisplayMode: DEFAULT_UI_CONFIG.hudDisplayMode,
      toggleShortcut: DEFAULT_UI_CONFIG.toggleShortcut,
    })

    persistSyncedUIConfig(config)
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({
      uiConfig: toSyncedUIConfig(config),
    }, expect.any(Function))
  })

  it('旧版端末のlive scaleを削除前に移行snapshotへ退避する', () => {
    ;(chrome.storage.sync.get as jest.Mock).mockImplementationOnce(
      (_keys, callback) => {
        callback({
          uiConfig: {
            ...DEFAULT_UI_CONFIG,
            scale: 1.8,
          },
          [LEGACY_SYNC_UI_SCALE_KEY]: 1.3,
        })
      }
    )
    const config = {
      ...DEFAULT_UI_CONFIG,
      scale: 1.1,
      displayEnabled: false,
    }

    persistSyncedUIConfig(config)

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({
      uiConfig: {
        ...toSyncedUIConfig(config),
        scale: 1.8,
      },
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.8,
    }, expect.any(Function))
  })

  it('旧版互換scaleをuiConfigとsnapshotの両方に保持する', () => {
    ;(chrome.storage.sync.get as jest.Mock).mockImplementationOnce(
      (_keys, callback) => {
        callback({
          uiConfig: toSyncedUIConfig(DEFAULT_UI_CONFIG),
          [LEGACY_SYNC_UI_SCALE_KEY]: 1.6,
        })
      }
    )

    persistSyncedUIConfig({ ...DEFAULT_UI_CONFIG, displayEnabled: false })

    expect(chrome.storage.sync.set).toHaveBeenCalledWith({
      uiConfig: {
        ...toSyncedUIConfig({ ...DEFAULT_UI_CONFIG, displayEnabled: false }),
        scale: 1.6,
      },
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.6,
    }, expect.any(Function))
  })

  it('同期read/writeを直列化して新しい設定を古いwriteで巻き戻さない', () => {
    const pendingReads: Array<(result: Record<string, unknown>) => void> = []
    const pendingWrites: Array<() => void> = []
    ;(chrome.storage.sync.get as jest.Mock).mockImplementation(
      (_keys, callback) => {
        pendingReads.push(callback)
      }
    )
    ;(chrome.storage.sync.set as jest.Mock).mockImplementation(
      (_items, callback) => {
        pendingWrites.push(callback)
      }
    )
    const olderConfig = {
      ...DEFAULT_UI_CONFIG,
      displayEnabled: false,
    }
    const newerConfig = {
      ...DEFAULT_UI_CONFIG,
      hudDisplayMode: 'full' as const,
    }

    persistSyncedUIConfig(olderConfig)
    persistSyncedUIConfig(newerConfig)
    expect(pendingReads).toHaveLength(1)

    pendingReads[0]!({
      uiConfig: { ...DEFAULT_UI_CONFIG, scale: 1.7 },
    })
    expect(chrome.storage.sync.set).toHaveBeenCalledTimes(1)
    expect(pendingReads).toHaveLength(1)

    pendingWrites[0]!()
    expect(pendingReads).toHaveLength(2)
    pendingReads[1]!({
      uiConfig: { ...DEFAULT_UI_CONFIG, scale: 1.7 },
    })
    pendingWrites[1]!()

    expect(chrome.storage.sync.set).toHaveBeenCalledTimes(2)
    expect(chrome.storage.sync.set).toHaveBeenLastCalledWith({
      uiConfig: {
        ...toSyncedUIConfig(newerConfig),
        scale: 1.7,
      },
      [LEGACY_SYNC_UI_SCALE_KEY]: 1.7,
    }, expect.any(Function))
  })

  it('同期設定保存をpersistent backgroundへ即時に委譲する', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce(
      (_message, callback) => callback({ success: true })
    )
    const config = { ...DEFAULT_UI_CONFIG, displayEnabled: false }

    saveSyncedUIConfig(config)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'setSyncedUIConfig', config },
      expect.any(Function)
    )
  })

  it('scaleはlocalへ保存する', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce((_message, callback) => {
      callback({ success: true })
    })
    const callback = jest.fn()
    saveLocalUIScale(1.3, callback)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'setDeviceUIScale', scale: 1.3 },
      expect.any(Function)
    )
    expect(callback).toHaveBeenCalledWith('success')
  })

  it('backgroundがscale保存を拒否した場合は失敗を返す', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce((_message, callback) => {
      callback({ success: false, error: 'quota' })
    })
    const callback = jest.fn()

    saveLocalUIScale(1.3, callback)

    expect(callback).toHaveBeenCalledWith('failure')
  })

  it('runtime.lastErrorがあるscale保存responseは失敗として扱う', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce((_message, callback) => {
      ;(chrome.runtime as any).lastError = { message: 'service worker unavailable' }
      callback({ success: true })
      delete (chrome.runtime as any).lastError
    })
    const callback = jest.fn()

    saveLocalUIScale(1.3, callback)

    expect(callback).toHaveBeenCalledWith('failure')
  })

  it('scale保存timeoutを未確定として返し、遅い実保存成功を再通知する', () => {
    jest.useFakeTimers()
    try {
      let respond!: (response: unknown) => void
      ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce(
        (_message, callback) => {
          respond = callback
        }
      )
      const callback = jest.fn()

      saveLocalUIScale(1.3, callback)
      jest.advanceTimersByTime(DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS)
      expect(callback).toHaveBeenCalledWith('timeout')

      respond({ success: true })
      expect(callback).toHaveBeenNthCalledWith(2, 'success')
    } finally {
      jest.useRealTimers()
    }
  })

  it('HUD位置保存失敗は永続化不能をwarnする', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce((_message, callback) => {
      callback({ success: false, error: 'quota' })
    })
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    saveHudPosition(2, { top: '20%', left: '30%' })

    expect(warnSpy).toHaveBeenCalledWith(
      '[HUD layout] Failed to save device-local position'
    )
    warnSpy.mockRestore()
  })

  it('scaleはbackground経由で読み込む', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce((_message, callback) => {
      callback({ success: true, scale: 1.6 })
    })
    const callback = jest.fn()

    loadLocalUIScale(callback)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'getDeviceUILayout' },
      expect.any(Function)
    )
    expect(callback).toHaveBeenCalledWith(1.6, true)
  })

  it('ハンドログlayoutをbackground経由で読込・保存・リセットする', () => {
    const layout = { left: 40, top: 60, width: 480, height: 220 }
    ;(chrome.runtime.sendMessage as jest.Mock)
      .mockImplementationOnce((_message, callback) => {
        callback({ success: true, layout })
      })
      .mockImplementation((_message, callback) => {
        callback({ success: true })
      })
    const loadCallback = jest.fn()
    const resetCallback = jest.fn()

    loadHandLogLayout(loadCallback)
    saveHandLogLayout(layout)
    resetUILayout(resetCallback)

    expect(loadCallback).toHaveBeenCalledWith(layout)
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(
      1,
      { action: 'getDeviceHandLogLayout' },
      expect.any(Function)
    )
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(
      2,
      { action: 'setDeviceHandLogLayout', layout },
      expect.any(Function)
    )
    expect(chrome.runtime.sendMessage).toHaveBeenNthCalledWith(
      3,
      { action: 'resetDeviceUILayout' },
      expect.any(Function)
    )
    expect(resetCallback).toHaveBeenCalled()
  })

  it('UI配置resetの失敗時は成功callbackを呼ばない', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce(
      (_message, callback) => {
        callback({ success: false, error: 'remove failed' })
      }
    )
    const callback = jest.fn()

    resetUILayout(callback)

    expect(callback).not.toHaveBeenCalled()
  })

  it('timeout後にreset成功応答が届いた場合も成功callbackを呼ぶ', () => {
    jest.useFakeTimers()
    try {
      let respond!: (response: unknown) => void
      ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce(
        (_message, callback) => {
          respond = callback
        }
      )
      const callback = jest.fn()

      resetUILayout(callback)
      jest.advanceTimersByTime(DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS)
      expect(callback).not.toHaveBeenCalled()

      respond({ success: true })
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('timeoutで描画を進め、遅れたbackground応答もscaleへ反映する', () => {
    jest.useFakeTimers()
    try {
      let respond!: (response: unknown) => void
      ;(chrome.runtime.sendMessage as jest.Mock).mockImplementationOnce(
        (_message, callback) => {
          respond = callback
        }
      )
      const callback = jest.fn()

      loadLocalUIScale(callback)
      expect(callback).not.toHaveBeenCalled()

      jest.advanceTimersByTime(DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS)
      expect(callback).toHaveBeenCalledWith(DEFAULT_UI_CONFIG.scale, false)

      respond({ success: true, scale: 1.6 })
      expect(callback).toHaveBeenLastCalledWith(1.6, true)
      expect(callback).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
