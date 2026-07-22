import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TextDecoder as NodeTextDecoder } from 'util'
import { useRef, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { ImportExportSection } from './ImportExportSection'
import { REBUILD_ADVISORY_STORAGE_KEY } from '../../background/rebuild-advisory'

const noop = () => {}

const defaultProps = {
  importStatus: '',
  importProgress: 0,
  importProcessed: 0,
  importTotal: 0,
  importDuplicates: 0,
  importSuccess: 0,
  importStartTime: 0,
  fileInputRef: { current: null },
  setImportStatus: noop,
  setImportProgress: noop,
  setImportProcessed: noop,
  setImportTotal: noop,
  setImportDuplicates: noop,
  setImportSuccess: noop,
  setImportStartTime: noop,
}

const ImportStatusHarness = () => {
  const [importStatus, setImportStatus] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <ImportExportSection
      {...defaultProps}
      importStatus={importStatus}
      fileInputRef={fileInputRef}
      setImportStatus={setImportStatus}
    />
  )
}

describe('ImportExportSection - rebuild advisory banner', () => {
  let storageChangeListeners: Array<(changes: Record<string, any>, areaName: string) => void>
  let storageLocalData: Record<string, any>
  let mockSendMessage: jest.Mock

  beforeEach(() => {
    ;(globalThis as any).TextDecoder = NodeTextDecoder
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
        onMessage: {
          addListener: jest.fn(),
          removeListener: jest.fn(),
        },
      },
      storage: {
        ...global.chrome.storage,
        local: {
          get: jest.fn((_keys: any, callback: any) => {
            callback({ [REBUILD_ADVISORY_STORAGE_KEY]: storageLocalData[REBUILD_ADVISORY_STORAGE_KEY] })
          }),
          set: jest.fn(),
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
        query: jest.fn(),
      },
    } as any
  })

  const emitStorageChange = (newValue: any) => {
    storageChangeListeners.forEach(listener =>
      listener({ [REBUILD_ADVISORY_STORAGE_KEY]: { newValue } }, 'local')
    )
  }

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

  it('stops chunk upload and shows the background error when import initialization is rejected', async () => {
    mockSendMessage.mockImplementation((message: { action?: string }, callback?: (response: unknown) => void) => {
      if (typeof callback === 'function') {
        callback({})
        return undefined
      }
      if (message.action === 'importDataInit') {
        return Promise.resolve({ success: false, error: '別の処理が実行中です' })
      }
      return Promise.resolve({ success: true })
    })

    const { container } = render(<ImportStatusHarness />)
    const handleRuntimeMessage = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
    act(() => {
      handleRuntimeMessage({
        action: 'exportProgress',
        state: 'completed',
        format: 'json',
        message: 'エクスポート完了'
      })
    })
    expect(screen.getByText('エクスポート完了')).toBeInTheDocument()

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['{}'], 'data.ndjson', { type: 'application/x-ndjson' })

    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByText('インポート失敗: 別の処理が実行中です')).toBeInTheDocument()
    expect(screen.queryByText('エクスポート完了')).not.toBeInTheDocument()
    const actions = mockSendMessage.mock.calls.map(([message]) => message.action)
    expect(actions).toContain('importDataInit')
    expect(actions).not.toContain('importDataChunk')
    expect(actions).not.toContain('importDataProcess')
  })

  it('preserves a UTF-8 character split across file chunk boundaries', async () => {
    const uploadedChunks: string[] = []
    mockSendMessage.mockImplementation((message: { action?: string, chunkData?: string }, callback?: (response: unknown) => void) => {
      if (typeof callback === 'function') {
        callback({})
        return undefined
      }
      if (message.action === 'importDataChunk') uploadedChunks.push(message.chunkData ?? '')
      return Promise.resolve({ success: true })
    })

    const chunkSize = 5 * 1024 * 1024
    const content = `${'x'.repeat(chunkSize - 1)}あ\n`
    const { container } = render(<ImportStatusHarness />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([content], 'utf8-boundary.ndjson', { type: 'application/x-ndjson' })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'importDataProcess' }))
    })
    expect(uploadedChunks).toHaveLength(2)
    expect(uploadedChunks.join('')).toBe(content)
    expect(uploadedChunks.join('')).not.toContain('\uFFFD')
  })
})
