import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TextDecoder as NodeTextDecoder } from 'util'
import { ImportPage } from './ImportPage'
import { IMPORT_RESULT_STORAGE_KEY } from '../constants/import-page'

describe('ImportPage', () => {
  let uploadedChunks: string[]

  beforeEach(() => {
    ;(globalThis as any).TextDecoder = NodeTextDecoder
    uploadedChunks = []

    ;(chrome.storage.local.get as jest.Mock).mockImplementation((_key, callback) => callback({}))
    ;(chrome.storage.local.remove as jest.Mock).mockResolvedValue(undefined)
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (message: { action?: string, chunkData?: string }, callback?: (response: unknown) => void) => {
        if (typeof callback === 'function') {
          callback(message.action === 'getOperationState'
            ? { operationState: { type: 'idle' } }
            : {})
          return undefined
        }
        if (message.action === 'importDataChunk') uploadedChunks.push(message.chunkData ?? '')
        return Promise.resolve({ success: true })
      }
    )
  })

  it('restores an import-origin rebuild without calling the normal popup game-tab flow', async () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (_message: { action?: string }, callback?: (response: unknown) => void) => {
        if (typeof callback === 'function') {
          callback({
            operationState: {
              type: 'rebuild',
              origin: 'import',
              phase: 'rebuild',
              progress: 35,
              message: 'インポート後のデータ再構築中...',
            },
          })
          return undefined
        }
        return Promise.resolve({ success: true })
      }
    )

    render(<ImportPage />)

    expect(await screen.findByText('インポート後のデータ再構築中...')).toBeInTheDocument()
    expect(chrome.tabs.query).not.toHaveBeenCalled()
  })

  it('restores a persisted completion result', async () => {
    ;(chrome.storage.local.get as jest.Mock).mockImplementation((_key, callback) => callback({
      [IMPORT_RESULT_STORAGE_KEY]: {
        status: 'completed',
        message: 'インポートが完了しました (12件のログ)',
        completedAt: 123,
      },
    }))

    render(<ImportPage />)

    expect(await screen.findByText('インポートが完了しました (12件のログ)')).toBeInTheDocument()
  })

  it('shows an initialization error and does not upload chunks', async () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (message: { action?: string }, callback?: (response: unknown) => void) => {
        if (typeof callback === 'function') {
          callback({ operationState: { type: 'idle' } })
          return undefined
        }
        if (message.action === 'importDataInit') {
          return Promise.resolve({ success: false, error: '別の処理が実行中です' })
        }
        return Promise.resolve({ success: true })
      }
    )

    const { container } = render(<ImportPage />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [new File(['{}'], 'data.ndjson', { type: 'application/x-ndjson' })] },
    })

    expect(await screen.findByText('インポート失敗: 別の処理が実行中です')).toBeInTheDocument()
    const actions = (chrome.runtime.sendMessage as jest.Mock).mock.calls.map(([message]) => message.action)
    expect(actions).not.toContain('importDataChunk')
    expect(actions).not.toContain('importDataProcess')
  })

  it('preserves a UTF-8 character split across file chunk boundaries', async () => {
    const chunkSize = 5 * 1024 * 1024
    const content = `${'x'.repeat(chunkSize - 1)}あ\n`
    const { container } = render(<ImportPage />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [new File([content], 'utf8-boundary.ndjson', { type: 'application/x-ndjson' })],
      },
    })

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'importDataProcess' })
      )
    })
    expect(uploadedChunks).toHaveLength(2)
    expect(uploadedChunks.join('')).toBe(content)
    expect(uploadedChunks.join('')).not.toContain('\uFFFD')
  })
})
