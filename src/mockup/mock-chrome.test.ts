import { installChromeMock } from './mock-chrome'
import { DEFAULT_UI_CONFIG } from '../types/hand-log'

describe('visual mock chrome layout storage', () => {
  it('端末ローカルのHUD位置とscaleをruntime message経由で保存・読込する', () => {
    const controller = installChromeMock()
    const storageListener = jest.fn()
    chrome.storage.onChanged.addListener(storageListener)

    chrome.runtime.sendMessage({
      action: 'setDeviceUIScale',
      scale: 1.4,
    }, jest.fn())
    chrome.runtime.sendMessage({
      action: 'setDeviceHudPosition',
      seatIndex: 2,
      position: { top: '30%', left: '40%' },
    }, jest.fn())

    const response = jest.fn()
    chrome.runtime.sendMessage({
      action: 'getDeviceUILayout',
      seatIndex: 2,
    }, response)

    expect(response).toHaveBeenCalledWith({
      success: true,
      scale: 1.4,
      position: { top: '30%', left: '40%' },
    })
    expect(storageListener).toHaveBeenCalledWith(expect.objectContaining({
      hudPosition_2: expect.objectContaining({
        newValue: { top: '30%', left: '40%' },
      }),
    }), 'local')

    controller.clearHudPositions()
    chrome.runtime.sendMessage({
      action: 'getDeviceUILayout',
      seatIndex: 2,
    }, response)

    expect(response).toHaveBeenLastCalledWith({
      success: true,
      scale: 1.4,
    })
  })

  it('位置とサイズのリセットで倍率も既定へ戻す', () => {
    // 本番の resetDeviceUILayout は倍率も既定へ書き戻す。モックが位置だけを
    // 消すと、ポップアップの表示は100%へ戻るのに背後のHUDは前の倍率のまま
    // という、本番には存在しない状態になり、mockupでこの操作を検証できない。
    installChromeMock()

    chrome.runtime.sendMessage({ action: 'setDeviceUIScale', scale: 1.4 }, jest.fn())
    chrome.runtime.sendMessage({
      action: 'setDeviceHudPosition',
      seatIndex: 2,
      position: { top: '30%', left: '40%' },
    }, jest.fn())

    const resetResponse = jest.fn()
    chrome.runtime.sendMessage({ action: 'resetDeviceUILayout' }, resetResponse)
    expect(resetResponse).toHaveBeenCalledWith({ success: true })

    const response = jest.fn()
    chrome.runtime.sendMessage({
      action: 'getDeviceUILayout',
      seatIndex: 2,
    }, response)

    expect(response).toHaveBeenCalledWith({
      success: true,
      scale: DEFAULT_UI_CONFIG.scale,
    })
  })
})
