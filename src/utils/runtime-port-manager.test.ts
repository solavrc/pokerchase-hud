import { RuntimePortManager, RuntimePortQueueOverflowError } from './runtime-port-manager'

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

const managerOptions = (
  connect: () => chrome.runtime.Port,
  overrides: Partial<ConstructorParameters<typeof RuntimePortManager>[0]> = {}
) => ({
  connect,
  reconnectDelayMs: 500,
  maxQueueSize: 100,
  ...overrides
})

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
    const manager = new RuntimePortManager(managerOptions(connect))

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
    const manager = new RuntimePortManager(managerOptions(() => replacement.port))

    expect(manager.send({ ApiTypeId: 2 })).toBe(true)
    expect(replacement.port.postMessage).toHaveBeenCalledWith({ ApiTypeId: 2 })
  })

  test('retries the exact event whose postMessage throws on the replacement Port', () => {
    const failed = createPort()
    const replacement = createPort()
    const event = { ApiTypeId: 303, timestamp: 1000 }
    ;(failed.port.postMessage as jest.Mock).mockImplementation(() => {
      throw new Error('Attempting to use a disconnected port object')
    })
    const connect = jest.fn()
      .mockReturnValueOnce(failed.port)
      .mockReturnValueOnce(replacement.port)
    const onSendError = jest.fn()
    const manager = new RuntimePortManager(managerOptions(connect, { onSendError }))

    manager.connect()
    expect(manager.send(event)).toBe(true)
    jest.advanceTimersByTime(500)

    expect(failed.port.postMessage).toHaveBeenCalledWith(event)
    expect(replacement.port.postMessage).toHaveBeenCalledWith(event)
    expect(onSendError).toHaveBeenCalledTimes(1)
  })

  test('preserves causal order when more events arrive before reconnect', () => {
    const failed = createPort()
    const replacement = createPort()
    const first = { ApiTypeId: 303, timestamp: 1000 }
    const second = { ApiTypeId: 313, timestamp: 1001 }
    const third = { ApiTypeId: 319, timestamp: 1002 }
    ;(failed.port.postMessage as jest.Mock).mockImplementation(() => {
      throw new Error('Attempting to use a disconnected port object')
    })
    const connect = jest.fn()
      .mockReturnValueOnce(failed.port)
      .mockReturnValueOnce(replacement.port)
    const manager = new RuntimePortManager(managerOptions(connect))

    manager.connect()
    manager.send(first)
    manager.send(second)
    manager.send(third)
    jest.advanceTimersByTime(500)

    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(1, first)
    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(2, second)
    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(3, third)
  })

  test('retains an ambiguously delivered head event when disconnect races postMessage', () => {
    const raced = createPort()
    const replacement = createPort()
    const first = { ApiTypeId: 303, timestamp: 1000 }
    const second = { ApiTypeId: 313, timestamp: 1001 }
    ;(raced.port.postMessage as jest.Mock).mockImplementation(() => raced.disconnect())
    const connect = jest.fn()
      .mockReturnValueOnce(raced.port)
      .mockReturnValueOnce(replacement.port)
    const manager = new RuntimePortManager(managerOptions(connect))

    manager.connect()
    manager.send(first)
    manager.send(second)
    jest.advanceTimersByTime(500)

    expect(raced.port.postMessage).toHaveBeenCalledWith(first)
    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(1, first)
    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(2, second)
  })

  test('ignores a stale disconnect fired by an earlier Port', () => {
    const first = createPort()
    const replacement = createPort()
    const connect = jest.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(replacement.port)
    const manager = new RuntimePortManager(managerOptions(connect))

    manager.connect()
    first.disconnect()
    jest.advanceTimersByTime(500)
    first.disconnect()
    manager.send({ ApiTypeId: 319 })

    expect(connect).toHaveBeenCalledTimes(2)
    expect(replacement.port.postMessage).toHaveBeenCalledWith({ ApiTypeId: 319 })
  })

  test('queues later events behind a failed connection without a connect storm', () => {
    const replacement = createPort()
    const connect = jest.fn()
      .mockImplementationOnce(() => {
        throw new Error('Service worker unavailable')
      })
      .mockReturnValueOnce(replacement.port)
    const manager = new RuntimePortManager(managerOptions(connect))
    const first = { ApiTypeId: 303 }
    const second = { ApiTypeId: 313 }

    manager.send(first)
    manager.send(second)

    expect(connect).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(500)
    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(1, first)
    expect(replacement.port.postMessage).toHaveBeenNthCalledWith(2, second)
  })

  test('stops retrying and reports a fatal extension context invalidation', () => {
    const invalid = createPort()
    const invalidation = new Error('Extension context invalidated.')
    ;(invalid.port.postMessage as jest.Mock).mockImplementation(() => {
      throw invalidation
    })
    const connect = jest.fn(() => invalid.port)
    const onFatalError = jest.fn()
    const manager = new RuntimePortManager(managerOptions(connect, { onFatalError }))

    manager.connect()
    expect(manager.send({ ApiTypeId: 303 })).toBe(false)
    expect(manager.send({ ApiTypeId: 313 })).toBe(false)
    jest.advanceTimersByTime(500)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(onFatalError).toHaveBeenCalledWith(invalidation)
  })

  test('stops retrying when connect reports an invalidated extension context', () => {
    const invalidation = new Error('Extension context invalidated.')
    const connect = jest.fn(() => {
      throw invalidation
    })
    const onFatalError = jest.fn()
    const manager = new RuntimePortManager(managerOptions(connect, { onFatalError }))

    expect(manager.send({ ApiTypeId: 303 })).toBe(false)
    jest.advanceTimersByTime(500)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(onFatalError).toHaveBeenCalledWith(invalidation)
  })

  test('fails closed and reports overflow instead of silently dropping a queued event', () => {
    const connect = jest.fn(() => {
      throw new Error('Service worker unavailable')
    })
    const onFatalError = jest.fn()
    const manager = new RuntimePortManager(managerOptions(connect, {
      maxQueueSize: 2,
      onFatalError
    }))

    expect(manager.send({ ApiTypeId: 303 })).toBe(true)
    expect(manager.send({ ApiTypeId: 313 })).toBe(true)
    expect(manager.send({ ApiTypeId: 319 })).toBe(false)
    expect(manager.send({ ApiTypeId: 309 })).toBe(false)
    jest.advanceTimersByTime(500)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(onFatalError).toHaveBeenCalledWith(expect.any(RuntimePortQueueOverflowError))
    expect(onFatalError.mock.calls[0]?.[0]).toMatchObject({ maxQueueSize: 2 })
  })

  test('does not reconnect after an intentional disconnect', () => {
    const current = createPort()
    const connect = jest.fn(() => current.port)
    const manager = new RuntimePortManager(managerOptions(connect))

    manager.connect()
    manager.disconnect()
    current.disconnect()
    jest.advanceTimersByTime(500)

    expect(connect).toHaveBeenCalledTimes(1)
  })

  test('rejects an invalid queue limit', () => {
    const current = createPort()

    expect(() => new RuntimePortManager(managerOptions(
      () => current.port,
      { maxQueueSize: 0 }
    ))).toThrow('maxQueueSize must be a positive integer.')
  })
})
