/**
 * content_script.ts - explicit ack for download handoff messages
 * (PR #199 review, finding #1 P1: "Send an ACK before treating lastError as
 * handoff failure")
 *
 * `import-export.ts`'s `downloadFile()` awaits each
 * `chrome.tabs.sendMessage()` handoff via a callback and rejects on
 * `chrome.runtime.lastError` (release-audit finding #10). Chrome's
 * messaging API sets `lastError` to "The message port closed before a
 * response was received" whenever the RECEIVING listener returns without
 * calling `sendResponse()` and without returning `true` -- which is exactly
 * what the four `downloadFile*` handlers below used to do (Blob-download
 * work, then a bare `return`). That made every SUCCESSFULLY handled
 * download handoff look like a delivery failure to the sender, indistinguishable
 * from a genuinely missing content script or a rejected message.
 *
 * This loads content_script.ts fresh (mocking `chrome.runtime.connect` so
 * its top-level `portManager.connect()` side effect doesn't throw, and
 * `URL.createObjectURL`/`HTMLAnchorElement.prototype.click`, which jsdom
 * doesn't implement) and asserts its `chrome.runtime.onMessage` listener
 * now calls `sendResponse()` for each of the four download actions -- the
 * explicit ack that prevents the false "port closed" failure on the sender
 * side (see `sendTabMessageAsync` in `background/import-export.ts`).
 */

describe('content_script.ts download message handlers send an explicit ack', () => {
  let listener: (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void

  beforeEach(() => {
    jest.resetModules()
    ;(chrome.runtime as any).connect = jest.fn(() => ({
      postMessage: jest.fn(),
      disconnect: jest.fn(),
      onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
      onDisconnect: { addListener: jest.fn(), removeListener: jest.fn() },
    }))
    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    // jsdom doesn't implement these; the handlers under test call them
    // unconditionally as part of the (real, working) Blob-download path --
    // without these, the handler itself would throw before reaching
    // sendResponse(), which would make these tests pass for the wrong reason.
    ;(URL as any).createObjectURL = jest.fn(() => 'blob:mock-url')
    ;(URL as any).revokeObjectURL = jest.fn()
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { })

    jest.isolateModules(() => {
      require('./content_script')
    })

    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0]![0]
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('downloadFile sends an explicit success ack (single-message path)', () => {
    const sendResponse = jest.fn()
    listener(
      { action: 'downloadFile', content: 'line1\nline2', filename: 'pokerchase_raw_data.ndjson', contentType: 'application/x-ndjson' },
      {},
      sendResponse
    )
    expect(sendResponse).toHaveBeenCalledTimes(1)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })

  test('downloadFileInit sends an explicit success ack (chunked path start)', () => {
    const sendResponse = jest.fn()
    listener(
      { action: 'downloadFileInit', filename: 'pokerchase_raw_data.ndjson', contentType: 'application/x-ndjson', totalChunks: 2 },
      {},
      sendResponse
    )
    expect(sendResponse).toHaveBeenCalledTimes(1)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })

  test('downloadFileChunk sends an explicit success ack (per chunk)', () => {
    const sendResponse = jest.fn()
    listener(
      { action: 'downloadFileInit', filename: 'pokerchase_raw_data.ndjson', contentType: 'application/x-ndjson', totalChunks: 2 },
      {},
      jest.fn()
    )
    listener(
      { action: 'downloadFileChunk', chunkIndex: 0, chunk: 'abc', totalChunks: 2 },
      {},
      sendResponse
    )
    expect(sendResponse).toHaveBeenCalledTimes(1)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })

  test('downloadFileFinish sends an explicit success ack (chunked path end)', () => {
    listener({ action: 'downloadFileInit', filename: 'f.ndjson', contentType: 'application/x-ndjson', totalChunks: 1 }, {}, jest.fn())
    listener({ action: 'downloadFileChunk', chunkIndex: 0, chunk: 'abc', totalChunks: 1 }, {}, jest.fn())

    const sendResponse = jest.fn()
    listener(
      { action: 'downloadFileFinish', filename: 'f.ndjson', contentType: 'application/x-ndjson' },
      {},
      sendResponse
    )
    expect(sendResponse).toHaveBeenCalledTimes(1)
    expect(sendResponse).toHaveBeenCalledWith({ success: true })
  })

  test('downloadFile reports a failure ack (not a silent success) when the Blob download itself throws', () => {
    ;(URL.createObjectURL as jest.Mock).mockImplementation(() => { throw new Error('createObjectURL boom') })

    const sendResponse = jest.fn()
    listener(
      { action: 'downloadFile', content: 'line1', filename: 'f.ndjson', contentType: 'application/x-ndjson' },
      {},
      sendResponse
    )
    expect(sendResponse).toHaveBeenCalledTimes(1)
    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: 'createObjectURL boom' })
  })
})
