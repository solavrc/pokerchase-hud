import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportExportSection } from './ImportExportSection'
import { REBUILD_ADVISORY_STORAGE_KEY } from '../../background/rebuild-advisory'
import { IMPORT_RESULT_STORAGE_KEY } from '../../constants/import-page'

const noop = () => {}

const defaultProps = {
  importStatus: '',
  importProgress: 0,
  importProcessed: 0,
  importTotal: 0,
  importDuplicates: 0,
  importSuccess: 0,
  importStartTime: 0,
  setImportStatus: noop,
  setImportProgress: noop,
  setImportProcessed: noop,
  setImportTotal: noop,
  setImportDuplicates: noop,
  setImportSuccess: noop,
  setImportStartTime: noop,
}

describe('ImportExportSection - rebuild advisory banner', () => {
  let storageChangeListeners: Array<(changes: Record<string, any>, areaName: string) => void>
  let storageLocalData: Record<string, any>
  let mockSendMessage: jest.Mock

  beforeEach(() => {
    storageChangeListeners = []
    storageLocalData = {}
    // Default: respond synchronously with no operationState (mirrors "nothing in
    // progress"), so the sendMessageWithTimeout() call in the mount effect
    // resolves immediately instead of leaving a real 8s timeout timer pending
    // after each test.
    mockSendMessage = jest.fn((_message: unknown, callback?: (response: unknown) => void) => {
      if (typeof callback === 'function') callback({})
    })

    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: mockSendMessage,
        getURL: jest.fn(path => `chrome-extension://test/${path}`),
        onMessage: {
          addListener: jest.fn(),
          removeListener: jest.fn(),
        },
      },
      storage: {
        ...global.chrome.storage,
        local: {
          get: jest.fn((_keys: any, callback: any) => {
            callback({
              [REBUILD_ADVISORY_STORAGE_KEY]: storageLocalData[REBUILD_ADVISORY_STORAGE_KEY],
              [IMPORT_RESULT_STORAGE_KEY]: storageLocalData[IMPORT_RESULT_STORAGE_KEY],
            })
          }),
          set: jest.fn(),
          remove: jest.fn(),
        },
        onChanged: {
          addListener: jest.fn((listener: any) => {
            storageChangeListeners.push(listener)
          }),
          removeListener: jest.fn((listener: any) => {
            const idx = storageChangeListeners.indexOf(listener)
            if (idx !== -1) storageChangeListeners.splice(idx, 1)
          }),
        },
      },
      tabs: {
        query: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      windows: {
        update: jest.fn().mockResolvedValue({}),
      },
    } as any
  })

  const emitStorageChange = (newValue: any) => {
    storageChangeListeners.forEach(listener =>
      listener({ [REBUILD_ADVISORY_STORAGE_KEY]: { newValue } }, 'local')
    )
  }

  const emitImportResultChange = (newValue: any) => {
    storageChangeListeners.forEach(listener =>
      listener({ [IMPORT_RESULT_STORAGE_KEY]: { newValue } }, 'local')
    )
  }

  /**
   * Mounts with a transfer already in flight and lets the test decide what the
   * background reports on the *next* getOperationState call -- the storage
   * handler re-asks before releasing, so "did the tracked import really end?"
   * is answered by this mock rather than by the result write alone.
   */
  const restoreActiveTransfer = () => {
    const transfer = {
      type: 'import',
      phase: 'transfer',
      progress: 50,
      processed: 1,
      total: 2,
      message: 'インポートファイル転送中...',
    }
    let current: unknown = transfer
    mockSendMessage.mockImplementation((message: { action?: string }, callback?: (response: unknown) => void) => {
      if (typeof callback === 'function') {
        callback(message.action === 'getOperationState' ? { operationState: current } : {})
      }
    })
    return {
      backgroundBecameIdle: () => { current = { type: 'idle' } },
      backgroundStaysBusy: () => { current = transfer },
      backgroundTookUnrelatedSlot: () => { current = { type: 'sync' } },
    }
  }

  const countOperationStateCalls = () =>
    mockSendMessage.mock.calls.filter(([m]: any[]) => m?.action === 'getOperationState').length

  it('does not render the banner when there is no pending advisory', async () => {
    storageLocalData[REBUILD_ADVISORY_STORAGE_KEY] = undefined

    render(<ImportExportSection {...defaultProps} />)

    await waitFor(() => {
      expect(chrome.storage.local.get).toHaveBeenCalled()
    })

    expect(screen.queryByText(/データ再構築」を実行してください/)).not.toBeInTheDocument()
  })

  it('renders the banner when pendingVersion is set on mount', async () => {
    storageLocalData[REBUILD_ADVISORY_STORAGE_KEY] = { pendingVersion: 1 }

    render(<ImportExportSection {...defaultProps} />)

    expect(await screen.findByText(/データ再構築」を実行してください/)).toBeInTheDocument()
  })

  it('sends the acknowledge message and hides the banner on dismiss', async () => {
    storageLocalData[REBUILD_ADVISORY_STORAGE_KEY] = { pendingVersion: 1 }

    render(<ImportExportSection {...defaultProps} />)

    await screen.findByText(/データ再構築」を実行してください/)

    const closeButton = screen.getByRole('button', { name: '閉じる' })
    await userEvent.click(closeButton)

    expect(mockSendMessage).toHaveBeenCalledWith({ action: 'acknowledgeRebuildAdvisory' })
    expect(screen.queryByText(/データ再構築」を実行してください/)).not.toBeInTheDocument()
  })

  it('hides the banner reactively when storage.onChanged reports resolution', async () => {
    storageLocalData[REBUILD_ADVISORY_STORAGE_KEY] = { pendingVersion: 1 }

    render(<ImportExportSection {...defaultProps} />)

    await screen.findByText(/データ再構築」を実行してください/)

    // Simulate resolveAdvisory() writing storage while the popup is open
    act(() => emitStorageChange({ acknowledgedVersion: 1 }))

    await waitFor(() => {
      expect(screen.queryByText(/データ再構築」を実行してください/)).not.toBeInTheDocument()
    })
  })

  it('opens the dedicated import page instead of reading a file in the popup', async () => {
    render(<ImportExportSection {...defaultProps} />)

    await userEvent.click(screen.getByRole('button', { name: '生データをインポート (NDJSON)' }))

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/dist/index.html?mode=import',
    })
  })

  it('focuses an existing import page instead of opening a duplicate tab', async () => {
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{
      id: 42,
      windowId: 7,
      url: 'chrome-extension://test/dist/index.html?mode=import',
    }])
    render(<ImportExportSection {...defaultProps} />)

    await userEvent.click(screen.getByRole('button', { name: '生データをインポート (NDJSON)' }))

    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true })
    expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })

  it('restores an active import transfer and keeps the import page reachable', async () => {
    mockSendMessage.mockImplementation((message: { action?: string }, callback?: (response: unknown) => void) => {
      if (typeof callback === 'function') {
        callback(message.action === 'getOperationState' ? {
          operationState: {
            type: 'import',
            phase: 'transfer',
            progress: 50,
            processed: 1,
            total: 2,
            message: 'インポートファイル転送中...',
          },
        } : {})
      }
    })
    render(<ImportExportSection {...defaultProps} />)

    expect(await screen.findByRole('button', { name: 'インポートページを表示' })).toBeEnabled()
    expect(screen.getByText(/インポートファイル転送中/)).toBeInTheDocument()
  })

  it('reuses an import page whose navigation has not committed yet', async () => {
    // Chrome reports the destination in pendingUrl until the navigation
    // commits; url is empty or still the previous page until then.
    ;(chrome.tabs.query as jest.Mock).mockResolvedValue([{
      id: 42,
      windowId: 7,
      url: '',
      pendingUrl: 'chrome-extension://test/dist/index.html?mode=import',
    }])
    render(<ImportExportSection {...defaultProps} />)

    await userEvent.click(screen.getByRole('button', { name: '生データをインポート (NDJSON)' }))

    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })

  it('does not open a second import page while the first open is still in flight', async () => {
    let releaseQuery: (tabs: unknown[]) => void = () => {}
    ;(chrome.tabs.query as jest.Mock).mockReturnValue(new Promise(resolve => {
      releaseQuery = resolve as (tabs: unknown[]) => void
    }))
    render(<ImportExportSection {...defaultProps} />)

    const button = screen.getByRole('button', { name: '生データをインポート (NDJSON)' })
    await userEvent.click(button)
    await userEvent.click(button)

    // Both clicks landed while the first query was still open. Without the
    // single-flight guard the second one queries too, also finds nothing, and
    // creates a duplicate page that races for the import operation slot.
    expect(chrome.tabs.query).toHaveBeenCalledTimes(1)

    await act(async () => {
      releaseQuery([])
    })

    expect(chrome.tabs.create).toHaveBeenCalledTimes(1)
  })

  it('releases the operation state when a terminal result arrives via storage', async () => {
    // ImportPage's own transfer failure writes lastImportResult directly and
    // sends only importDataCancel, so storage.onChanged is the popup's only
    // notification -- no importStatus message ever arrives.
    const setImportStatus = jest.fn()
    const background = restoreActiveTransfer()

    render(<ImportExportSection {...defaultProps} setImportStatus={setImportStatus} />)

    expect(await screen.findByRole('button', { name: 'インポートページを表示' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生データをエクスポート (NDJSON)' })).toBeDisabled()

    background.backgroundBecameIdle()
    act(() => emitImportResultChange({
      status: 'error',
      message: 'インポート失敗: ファイルを読み込めませんでした',
      completedAt: 456,
    }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '生データをインポート (NDJSON)' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '生データをエクスポート (NDJSON)' })).toBeEnabled()
    expect(setImportStatus).toHaveBeenCalledWith('インポート失敗: ファイルを読み込めませんでした')
  })

  it('keeps a live import active when a rejected duplicate page writes its own result', async () => {
    // A second import page whose importDataInit is rejected as busy never gets
    // a session, but its catch still writes lastImportResult. That result says
    // nothing about the import this popup is tracking, which is still running.
    const background = restoreActiveTransfer()

    render(<ImportExportSection {...defaultProps} />)

    expect(await screen.findByRole('button', { name: 'インポートページを表示' })).toBeInTheDocument()

    // Count this specific action: mount already issued one, so waiting on
    // "was it called" alone would resolve before the storage handler's own
    // round trip and assert against a not-yet-updated tree.
    await waitFor(() => expect(countOperationStateCalls()).toBe(1))

    background.backgroundStaysBusy()
    act(() => emitImportResultChange({
      status: 'error',
      message: 'インポート失敗: 別の処理が実行中です',
      completedAt: 789,
    }))

    await waitFor(() => expect(countOperationStateCalls()).toBe(2))
    // Flush the .then() that would release, so an unguarded release would have
    // rendered by the time the assertions below run.
    await act(async () => {})
    // Still tracking the live import: buttons stay held, progress not blanked.
    expect(screen.getByRole('button', { name: 'インポートページを表示' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生データをエクスポート (NDJSON)' })).toBeDisabled()
  })

  it('releases the import state when an unrelated operation took the slot', async () => {
    // importDataCancel drops the slot to idle, so an auto-sync parked in
    // waitForOperationIdle() can claim it before the result write lands.
    // 'sync' is not this popup's import: holding for it would strand
    // importOperationActive forever, since the transfer-error path sends no
    // importStatus and nothing re-checks when the sync finishes.
    const background = restoreActiveTransfer()

    render(<ImportExportSection {...defaultProps} />)

    expect(await screen.findByRole('button', { name: 'インポートページを表示' })).toBeInTheDocument()
    await waitFor(() => expect(countOperationStateCalls()).toBe(1))

    background.backgroundTookUnrelatedSlot()
    act(() => emitImportResultChange({
      status: 'error',
      message: 'インポート失敗: ファイルを読み込めませんでした',
      completedAt: 789,
    }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '生データをインポート (NDJSON)' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '生データをエクスポート (NDJSON)' })).toBeEnabled()
  })

  it('restores a persisted result after the popup was closed', async () => {
    const setImportStatus = jest.fn()
    storageLocalData[IMPORT_RESULT_STORAGE_KEY] = {
      status: 'completed',
      message: 'インポートが完了しました (10件のログ)',
      completedAt: 123,
    }

    render(<ImportExportSection {...defaultProps} setImportStatus={setImportStatus} />)

    await waitFor(() => {
      expect(setImportStatus).toHaveBeenCalledWith('インポートが完了しました (10件のログ)')
    })
  })
})
