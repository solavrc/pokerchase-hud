import { render, screen, waitFor, act } from '@testing-library/react'
import { SyncStatusSection } from './SyncStatusSection'
import type { SyncState } from '../../services/auto-sync-service'

const noop = () => {}

describe('SyncStatusSection', () => {
  let mockSendMessage: jest.Mock

  beforeEach(() => {
    mockSendMessage = jest.fn()
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: mockSendMessage,
      },
    } as any
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('getSyncInfoがタイムアウトしてもフェイルオープンし、UIはブロックされない', async () => {
    jest.useFakeTimers()

    // Simulate a hung/busy service worker: sendMessage never calls its callback
    mockSendMessage.mockImplementation(() => {
      // no-op: never invokes the callback
    })

    render(
      <SyncStatusSection
        syncState={{ status: 'idle' }}
        handleManualSyncUpload={noop}
        handleManualSyncDownload={noop}
      />
    )

    // Status text renders immediately from props — never blocked on getSyncInfo
    expect(screen.getByText('待機中')).toBeInTheDocument()
    expect(screen.getByText('アップロード')).not.toBeDisabled()
    expect(screen.getByText('ダウンロード')).not.toBeDisabled()

    // Advance past the sendMessageWithTimeout window (8s default); must not
    // throw or leave an unhandled rejection
    await act(async () => {
      await jest.advanceTimersByTimeAsync(9000)
    })

    // Fails open: no timestamp line ever appears (syncInfo never arrived),
    // but the rest of the UI stays fully interactive — no stuck spinner
    expect(screen.queryByText(/最終同期:/)).not.toBeInTheDocument()
    expect(screen.getByText('アップロード')).not.toBeDisabled()
    expect(screen.getByText('ダウンロード')).not.toBeDisabled()
  })

  it('syncStateの内容が同一なら新しいオブジェクト参照で再レンダーしてもgetSyncInfoを再送しない', async () => {
    const lastSyncTime = new Date('2026-07-18T00:00:00Z')
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({ syncInfo: { uploadPendingCount: 0 } })
    })

    const makeState = (): SyncState => ({ status: 'idle', lastSyncTime })

    const { rerender } = render(
      <SyncStatusSection
        syncState={makeState()}
        handleManualSyncUpload={noop}
        handleManualSyncDownload={noop}
      />
    )

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
    })

    // A brand-new object identity every poll tick, same content — this is
    // exactly what Popup.tsx's 5s getSyncState poll produces
    for (let i = 0; i < 3; i++) {
      rerender(
        <SyncStatusSection
          syncState={makeState()}
          handleManualSyncUpload={noop}
          handleManualSyncDownload={noop}
        />
      )
    }

    await act(async () => {
      await Promise.resolve()
    })

    // Still only the single initial call — no db.apiEvents.count() re-fires
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('syncStateのstatusが実際に変化したらgetSyncInfoを再送する', async () => {
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({ syncInfo: { uploadPendingCount: 0 } })
    })

    const { rerender } = render(
      <SyncStatusSection
        syncState={{ status: 'idle' }}
        handleManualSyncUpload={noop}
        handleManualSyncDownload={noop}
      />
    )

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1)
    })

    rerender(
      <SyncStatusSection
        syncState={{ status: 'syncing' }}
        handleManualSyncUpload={noop}
        handleManualSyncDownload={noop}
      />
    )

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })
  })
})
