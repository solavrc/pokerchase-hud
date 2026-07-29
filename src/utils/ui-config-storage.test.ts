import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import {
  DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS,
  isValidHandLogLayout,
  isValidHudPositionId,
  loadHandLogLayout,
  mergeUIConfigWithLocalScale,
  loadLocalUIScale,
  resolveLocalUIScale,
  resetHandLogLayout,
  saveHandLogLayout,
  saveLocalUIScale,
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

  it('同期payloadからscaleだけを除外する', () => {
    const config = {
      ...DEFAULT_UI_CONFIG,
      scale: 1.5,
      displayEnabled: false,
    }

    expect(toSyncedUIConfig(config)).toEqual({
      displayEnabled: false,
      hudDisplayMode: DEFAULT_UI_CONFIG.hudDisplayMode,
      hudColorCoding: DEFAULT_UI_CONFIG.hudColorCoding,
      toggleShortcut: DEFAULT_UI_CONFIG.toggleShortcut,
    })

    saveSyncedUIConfig(config)
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({
      uiConfig: toSyncedUIConfig(config),
    })
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
    expect(callback).toHaveBeenCalled()
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
    expect(callback).toHaveBeenCalledWith(1.6)
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
    resetHandLogLayout(resetCallback)

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
      { action: 'resetDeviceHandLogLayout' },
      expect.any(Function)
    )
    expect(resetCallback).toHaveBeenCalled()
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
      expect(callback).toHaveBeenCalledWith(DEFAULT_UI_CONFIG.scale)

      respond({ success: true, scale: 1.6 })
      expect(callback).toHaveBeenLastCalledWith(1.6)
      expect(callback).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
