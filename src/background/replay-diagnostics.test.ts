import { EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY } from '../replay/protocol'

type ReplayDiagnosticsModule = typeof import('./replay-diagnostics')

describe('replay service-worker diagnostics', () => {
  let diagnostics: ReplayDiagnosticsModule

  beforeEach(async () => {
    jest.resetModules()
    diagnostics = await import('./replay-diagnostics')
  })

  afterEach(() => {
    diagnostics.__setReplayDiagnosticsEnabledForTests(false)
    jest.restoreAllMocks()
  })

  test('開発者フラグOFFでは出力しない', () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    diagnostics.logReplayDiagnostic('port-event-processed', { elapsedMs: 12, queueDepth: 0 })
    expect(debug).not.toHaveBeenCalled()
  })

  test('SW取り込み診断フラグONでは時差・深さ・理由だけを出力できる', () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    diagnostics.__setReplayDiagnosticsEnabledForTests(true)

    diagnostics.logReplayDiagnostic('port-event-processed', { elapsedMs: 12, queueDepth: 0 })
    diagnostics.logReplayDiagnostic('drain-trigger', { reason: 'session-end' })

    expect(debug).toHaveBeenNthCalledWith(1, '[replay-dev] port-event-processed', {
      elapsedMs: 12,
      queueDepth: 0
    })
    expect(debug).toHaveBeenNthCalledWith(2, '[replay-dev] drain-trigger', {
      reason: 'session-end'
    })
  })

  test('リプレイ取得ONだけでは診断を有効化しない', async () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    await chrome.storage.sync.set({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true })

    diagnostics.initializeReplayDiagnostics()
    await Promise.resolve()
    diagnostics.logReplayDiagnostic('port-event-processed', { elapsedMs: 12, queueDepth: 0 })

    expect(chrome.storage.sync.get).toHaveBeenLastCalledWith(
      diagnostics.SW_INGESTION_DIAGNOSTICS_STORAGE_KEY
    )
    expect(debug).not.toHaveBeenCalled()
  })

  test('リプレイ取得OFFでもSW取り込み診断を単独で有効化できる', async () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    await chrome.storage.sync.set({
      [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: false,
      [diagnostics.SW_INGESTION_DIAGNOSTICS_STORAGE_KEY]: true
    })

    diagnostics.initializeReplayDiagnostics()
    await Promise.resolve()
    diagnostics.logReplayDiagnostic('port-event-received', { queueDepth: 1 })

    expect(debug).toHaveBeenCalledWith('[replay-dev] port-event-received', {
      queueDepth: 1
    })
  })

  test('SW起動後も独立キーだけで診断を切り替えられる', async () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    diagnostics.initializeReplayDiagnostics()
    await Promise.resolve()

    await chrome.storage.sync.set({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true })
    diagnostics.logReplayDiagnostic('port-event-received', { queueDepth: 1 })
    expect(debug).not.toHaveBeenCalled()

    await chrome.storage.sync.set({
      [diagnostics.SW_INGESTION_DIAGNOSTICS_STORAGE_KEY]: true
    })
    diagnostics.logReplayDiagnostic('port-event-received', { queueDepth: 2 })
    expect(debug).toHaveBeenCalledTimes(1)

    await chrome.storage.sync.set({
      [diagnostics.SW_INGESTION_DIAGNOSTICS_STORAGE_KEY]: false
    })
    diagnostics.logReplayDiagnostic('port-event-received', { queueDepth: 3 })
    expect(debug).toHaveBeenCalledTimes(1)
  })
})
