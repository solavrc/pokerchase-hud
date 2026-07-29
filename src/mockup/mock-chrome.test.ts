import { installChromeMock } from './mock-chrome'

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
})
