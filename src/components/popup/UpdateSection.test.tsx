import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateSection } from './UpdateSection'
import { PENDING_UPDATE_STORAGE_KEY } from '../../constants/update'
import { MIN_VERSION_GATE_STORAGE_KEY } from '../../services/min-version-gate'

describe('UpdateSection', () => {
  let mockSendMessage: jest.Mock

  beforeEach(async () => {
    mockSendMessage = jest.fn()
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: mockSendMessage,
      },
    } as any
    await chrome.storage.local.set({
      [PENDING_UPDATE_STORAGE_KEY]: undefined,
      [MIN_VERSION_GATE_STORAGE_KEY]: undefined,
    })
  })

  it('何も保留/未サポートが無ければ何も表示しない (fresh install / e2e baseline)', async () => {
    const { container } = render(<UpdateSection />)

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement()
    })
  })

  it('pendingUpdate.pending=trueのとき「新しいバージョンが待機中です」バナーを表示する', async () => {
    await chrome.storage.local.set({
      [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '5.2.0', detectedAt: Date.now() },
    })

    render(<UpdateSection />)

    await waitFor(() => {
      expect(screen.getByText('新しいバージョンが待機中です')).toBeInTheDocument()
    })
    expect(screen.getByText('今すぐ適用')).toBeInTheDocument()
  })

  it('minVersionGateState.supported=falseのとき「サポートが終了しました」バナーを表示する', async () => {
    await chrome.storage.local.set({
      [MIN_VERSION_GATE_STORAGE_KEY]: { supported: false, minSupportedVersion: '6.0.0', checkedAt: Date.now() },
    })

    render(<UpdateSection />)

    await waitFor(() => {
      expect(screen.getByText(/このバージョンはサポートが終了しました/)).toBeInTheDocument()
    })
  })

  it('ゲートのみunsupported（pendingUpdate無し）のときは案内文のみで「今すぐ適用」ボタンを出さない (codexレビュー指摘)', async () => {
    // No pendingUpdate recorded -- applyPendingUpdate/applyUpdateNow() cannot
    // actually fetch/install anything here (there's no downloaded update to
    // apply); a reload would just relaunch the same unsupported version and
    // could fabricate a misleading "pending update" banner.
    await chrome.storage.local.set({
      [MIN_VERSION_GATE_STORAGE_KEY]: { supported: false, minSupportedVersion: '6.0.0', checkedAt: Date.now() },
    })

    render(<UpdateSection />)

    await waitFor(() => {
      expect(screen.getByText(/このバージョンはサポートが終了しました/)).toBeInTheDocument()
    })
    expect(screen.queryByText('今すぐ適用')).not.toBeInTheDocument()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('supported=trueのときは未サポートバナーを表示しない', async () => {
    await chrome.storage.local.set({
      [MIN_VERSION_GATE_STORAGE_KEY]: { supported: true, checkedAt: Date.now() },
    })

    const { container } = render(<UpdateSection />)

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement()
    })
  })

  it('「今すぐ適用」クリックでapplyPendingUpdateメッセージを送る', async () => {
    await chrome.storage.local.set({
      [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '5.2.0' },
    })
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({ success: true, applied: true })
    })

    render(<UpdateSection />)

    await waitFor(() => {
      expect(screen.getByText('新しいバージョンが待機中です')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('今すぐ適用'))

    expect(mockSendMessage).toHaveBeenCalledWith(
      { action: 'applyPendingUpdate' },
      expect.any(Function)
    )
  })

  it('適用できなかった場合はbackgroundから返された理由を表示する', async () => {
    await chrome.storage.local.set({
      [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '5.2.0' },
    })
    mockSendMessage.mockImplementation((_message, callback) => {
      callback({ success: true, applied: false, reason: 'ゲームセッション中のため適用できません' })
    })

    render(<UpdateSection />)

    await waitFor(() => {
      expect(screen.getByText('新しいバージョンが待機中です')).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('今すぐ適用'))

    await waitFor(() => {
      expect(screen.getByText('ゲームセッション中のため適用できません')).toBeInTheDocument()
    })
  })

  it('両方の状態が真のときは両方のバナーを表示する', async () => {
    await chrome.storage.local.set({
      [PENDING_UPDATE_STORAGE_KEY]: { pending: true, version: '5.2.0' },
      [MIN_VERSION_GATE_STORAGE_KEY]: { supported: false, minSupportedVersion: '6.0.0', checkedAt: Date.now() },
    })

    render(<UpdateSection />)

    await waitFor(() => {
      expect(screen.getByText(/このバージョンはサポートが終了しました/)).toBeInTheDocument()
      expect(screen.getByText('新しいバージョンが待機中です')).toBeInTheDocument()
    })
    expect(screen.getAllByText('今すぐ適用')).toHaveLength(2)
  })
})
