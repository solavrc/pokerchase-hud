import { startKeepAlive } from './import-export'

describe('export service-worker keepalive', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    chrome.runtime.getPlatformInfo = jest.fn().mockResolvedValue({})
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('calls an Extension API before the 30-second idle timeout and stops cleanly', async () => {
    const stop = await startKeepAlive()

    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(25000)
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(2)

    stop()
    jest.advanceTimersByTime(50000)
    expect(chrome.runtime.getPlatformInfo).toHaveBeenCalledTimes(2)
  })
})
