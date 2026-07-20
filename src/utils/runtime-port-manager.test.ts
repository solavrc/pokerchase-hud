import { RuntimePortManager } from './runtime-port-manager'

const createPort = () => {
  let disconnectListener: (() => void) | undefined
  const port = {
    onMessage: { addListener: jest.fn() },
    onDisconnect: {
      addListener: jest.fn((listener: () => void) => {
        disconnectListener = listener
      })
    },
    postMessage: jest.fn(),
    disconnect: jest.fn()
  } as unknown as chrome.runtime.Port

  return {
    port,
    disconnect: () => disconnectListener?.()
  }
}

describe('RuntimePortManager', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('stores the replacement Port after a disconnect', () => {
    const first = createPort()
    const second = createPort()
    const connect = jest.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(second.port)
    const manager = new RuntimePortManager({ connect, reconnectDelayMs: 500 })

    manager.connect()
    first.disconnect()
    jest.advanceTimersByTime(500)
    manager.send({ ApiTypeId: 1 })

    expect(connect).toHaveBeenCalledTimes(2)
    expect(first.port.postMessage).not.toHaveBeenCalled()
    expect(second.port.postMessage).toHaveBeenCalledWith({ ApiTypeId: 1 })
  })

  test('connects and forwards the triggering message when no Port is active', () => {
    const replacement = createPort()
    const manager = new RuntimePortManager({
      connect: () => replacement.port,
      reconnectDelayMs: 500
    })

    expect(manager.send({ ApiTypeId: 2 })).toBe(true)
    expect(replacement.port.postMessage).toHaveBeenCalledWith({ ApiTypeId: 2 })
  })

  test('does not reconnect after an intentional disconnect', () => {
    const current = createPort()
    const connect = jest.fn(() => current.port)
    const manager = new RuntimePortManager({ connect, reconnectDelayMs: 500 })

    manager.connect()
    manager.disconnect()
    current.disconnect()
    jest.advanceTimersByTime(500)

    expect(connect).toHaveBeenCalledTimes(1)
  })
})
