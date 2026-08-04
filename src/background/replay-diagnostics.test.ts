import {
  __setReplayDiagnosticsEnabledForTests,
  logReplayDiagnostic
} from './replay-diagnostics'

describe('replay service-worker diagnostics', () => {
  afterEach(() => {
    __setReplayDiagnosticsEnabledForTests(false)
    jest.restoreAllMocks()
  })

  test('開発者フラグOFFでは出力しない', () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    logReplayDiagnostic('port-event-processed', { elapsedMs: 12, queueDepth: 0 })
    expect(debug).not.toHaveBeenCalled()
  })

  test('開発者フラグONでは時差・深さ・理由だけを出力できる', () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    __setReplayDiagnosticsEnabledForTests(true)

    logReplayDiagnostic('port-event-processed', { elapsedMs: 12, queueDepth: 0 })
    logReplayDiagnostic('drain-trigger', { reason: 'session-end' })

    expect(debug).toHaveBeenNthCalledWith(1, '[replay-dev] port-event-processed', {
      elapsedMs: 12,
      queueDepth: 0
    })
    expect(debug).toHaveBeenNthCalledWith(2, '[replay-dev] drain-trigger', {
      reason: 'session-end'
    })
  })
})
