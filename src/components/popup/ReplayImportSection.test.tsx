import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReplayImportSection } from './ReplayImportSection'
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  PUBLIC_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_IMPORT_ACCESS_STORAGE_KEY
} from '../../replay/protocol'

describe('ReplayImportSection', () => {
  beforeEach(async () => {
    await chrome.storage.sync.remove([
      EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
      PUBLIC_REPLAY_IMPORT_STORAGE_KEY
    ])
    await chrome.storage.local.remove(REPLAY_IMPORT_ACCESS_STORAGE_KEY)
  })

  test('公開トグルの既定はOFF', async () => {
    render(<ReplayImportSection />)
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
  })

  test('課金条件・取得タイミング・既存データ保持を事実として説明する', async () => {
    const { container } = render(<ReplayImportSection />)
    await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument())
    const text = container.textContent ?? ''
    expect(text).toContain('カード公開の有効期間内')
    expect(text).toContain('対局が終わったあと')
    expect(text).toContain('対局中は通信しません')
    expect(text).toContain('取り込み済みのハンドは削除されません')
  })

  test('トグルは開発者フラグではなく公開キーを書き換える', async () => {
    render(<ReplayImportSection />)
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled())

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(async () => {
      const stored = await chrome.storage.sync.get([
        PUBLIC_REPLAY_IMPORT_STORAGE_KEY,
        EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY
      ])
      expect(stored[PUBLIC_REPLAY_IMPORT_STORAGE_KEY]).toBe(true)
      expect(stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]).toBeUndefined()
    })
  })

  test.each([
    ['pending-session', '対局終了後にカード公開の利用状態を確認します。'],
    ['pending-auth', 'ゲームのホーム画面を開くと確認されます。'],
    ['checking', 'カード公開の利用状態を確認中です。'],
    ['expired', 'カード公開の有効期間外のため有効化されませんでした。']
  ] as const)('%sの保留・拒否状態を表示する', async (phase, message) => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })
    await chrome.storage.local.set({ [REPLAY_IMPORT_ACCESS_STORAGE_KEY]: { phase } })
    render(<ReplayImportSection />)
    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument())
    expect(screen.getByRole('switch')).toBeChecked()
  })

  test('開発者フラグのバイパスを公開トグルと別に表示する', async () => {
    await chrome.storage.sync.set({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true })
    render(<ReplayImportSection />)
    await waitFor(() => {
      expect(screen.getByText('開発者設定により課金検証を省略して有効です。')).toBeInTheDocument()
    })
    expect(screen.getByRole('switch')).not.toBeChecked()
  })
})
