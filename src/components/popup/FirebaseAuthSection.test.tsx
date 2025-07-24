import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FirebaseAuthSection } from './FirebaseAuthSection'
import type { SyncState } from '../../services/auto-sync-service'

describe('FirebaseAuthSection', () => {
  const mockHandleFirebaseSignIn = jest.fn()
  const mockHandleFirebaseSignOut = jest.fn()
  const mockHandleManualSyncUpload = jest.fn()
  const mockHandleManualSyncDownload = jest.fn()
  const mockSetImportStatus = jest.fn()

  const defaultProps = {
    isFirebaseSignedIn: false,
    firebaseUserInfo: null,
    syncState: null,
    unsyncedCount: 0,
    setImportStatus: mockSetImportStatus,
    handleFirebaseSignIn: mockHandleFirebaseSignIn,
    handleFirebaseSignOut: mockHandleFirebaseSignOut,
    handleManualSyncUpload: mockHandleManualSyncUpload,
    handleManualSyncDownload: mockHandleManualSyncDownload,
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('サインアウト時はサインインボタンを表示', () => {
    render(<FirebaseAuthSection {...defaultProps} />)

    expect(screen.getByText('自動バックアップを有効にする')).toBeInTheDocument()
    expect(screen.queryByText('ログアウト')).not.toBeInTheDocument()
  })

  it('サインイン時はユーザー情報と同期ボタンを表示', () => {
    const syncState: SyncState = {
      status: 'idle',
      lastSyncTime: new Date(Date.now() - 60000), // 1分前
    }

    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid' }}
        syncState={syncState}
        unsyncedCount={50}
      />
    )

    expect(screen.getByText('test@example.com')).toBeInTheDocument()
    // 最終同期時刻が表示されることを確認（日時形式）
    expect(screen.getByText(/最終同期:/)).toBeInTheDocument()
    expect(screen.getByText('未同期: 50件')).toBeInTheDocument()
    expect(screen.getByText('アップロード')).toBeInTheDocument()
    expect(screen.getByText('ダウンロード')).toBeInTheDocument()
    expect(screen.getByText('ログアウト')).toBeInTheDocument()
  })

  it('同期中の進行状況を表示', () => {
    const syncState: SyncState = {
      status: 'syncing',
      lastSyncTime: new Date(),
      progress: {
        current: 500,
        total: 1000,
        direction: 'upload',
      },
    }

    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid' }}
        syncState={syncState}
      />
    )

    expect(screen.getByText('同期中...')).toBeInTheDocument()
    // Progress is displayed as one text node
    expect(screen.getByText(/500.*1,000.*50%/)).toBeInTheDocument()
    
    // 同期中はボタンが無効化される
    expect(screen.getByText('アップロード')).toBeDisabled()
    expect(screen.getByText('ダウンロード')).toBeDisabled()
  })

  it('サインインボタンクリックでハンドラーが呼ばれる', async () => {
    render(<FirebaseAuthSection {...defaultProps} />)

    await userEvent.click(screen.getByText('自動バックアップを有効にする'))

    expect(mockHandleFirebaseSignIn).toHaveBeenCalled()
  })

  it('サインアウトボタンクリックでハンドラーが呼ばれる', async () => {
    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid' }}
      />
    )

    await userEvent.click(screen.getByText('ログアウト'))

    expect(mockHandleFirebaseSignOut).toHaveBeenCalled()
  })

  it('アップロードボタンクリックでハンドラーが呼ばれる', async () => {
    const syncState: SyncState = {
      status: 'idle',
      lastSyncTime: new Date(),
    }

    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid' }}
        syncState={syncState}
      />
    )

    await userEvent.click(screen.getByText('アップロード'))

    expect(mockHandleManualSyncUpload).toHaveBeenCalled()
  })

  it('ダウンロードボタンクリックでハンドラーが呼ばれる', async () => {
    const syncState: SyncState = {
      status: 'idle',
      lastSyncTime: new Date(),
    }

    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid' }}
        syncState={syncState}
      />
    )

    await userEvent.click(screen.getByText('ダウンロード'))

    expect(mockHandleManualSyncDownload).toHaveBeenCalled()
  })

  it('エラー状態を表示', () => {
    const syncState: SyncState = {
      status: 'error',
      lastSyncTime: new Date(),
      error: 'ネットワークエラーが発生しました',
    }

    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid' }}
        syncState={syncState}
      />
    )

    expect(screen.getByText('エラー')).toBeInTheDocument()
    expect(screen.getByText('ネットワークエラーが発生しました')).toBeInTheDocument()
  })

  it('ユーザーIDクリップボードコピー時にインポートステータスを設定', async () => {
    // Mock clipboard
    const mockWriteText = jest.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: mockWriteText,
      },
    })

    render(
      <FirebaseAuthSection
        {...defaultProps}
        isFirebaseSignedIn={true}
        firebaseUserInfo={{ email: 'test@example.com', uid: 'test-uid-123' }}
      />
    )

    // ユーザーIDをクリック
    const uidElement = screen.getByText(/ID: test-uid-123/)
    await userEvent.click(uidElement)

    expect(mockWriteText).toHaveBeenCalledWith('test-uid-123')
    expect(mockSetImportStatus).toHaveBeenCalledWith('ユーザーIDをコピーしました')
  })
})