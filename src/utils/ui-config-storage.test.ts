import { DEFAULT_UI_CONFIG } from '../types/hand-log'
import {
  mergeUIConfigWithLocalScale,
  loadLocalUIScale,
  resolveLocalUIScale,
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

  it.each([undefined, null, '1.2', 0.4, 2.1, Number.NaN])(
    '不正な端末ローカルscale %p は既定値へ戻す',
    (value) => {
      expect(resolveLocalUIScale(value)).toBe(DEFAULT_UI_CONFIG.scale)
    }
  )

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
    const callback = jest.fn()
    saveLocalUIScale(1.3, callback)

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { action: 'setDeviceUIScale', scale: 1.3 },
      expect.any(Function)
    )
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
})
