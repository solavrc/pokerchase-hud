import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReplayImportSection } from './ReplayImportSection'
import { EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY } from '../../replay/protocol'

describe('ReplayImportSection', () => {
  beforeEach(async () => {
    await chrome.storage.sync.remove(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY)
  })

  test('既定はOFF', async () => {
    render(<ReplayImportSection />)
    await waitFor(() => {
      expect(screen.getByRole('switch')).not.toBeChecked()
    })
  })

  /**
   * sola裁定: 「セッション終了後に取得する」ことはユーザーに読める位置へ
   * 出す。文言が消えたら失敗するように固定する。
   */
  test('取得のタイミングと期間の制約を本文で説明している', async () => {
    const { container } = render(<ReplayImportSection />)
    await waitFor(() => expect(screen.getByRole('switch')).toBeInTheDocument())
    const text = container.textContent ?? ''
    expect(text).toContain('対局が終わったあと')
    expect(text).toContain('対局中は一切通信しません')
    expect(text).toContain('直近3日')
  })

  test('トグルで storage.sync のフラグを書き換える', async () => {
    render(<ReplayImportSection />)
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled())

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(async () => {
      const stored = await chrome.storage.sync.get(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY)
      expect(stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]).toBe(true)
    })
  })

  test('保存済みの有効状態を復元する', async () => {
    await chrome.storage.sync.set({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true })
    render(<ReplayImportSection />)
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeChecked()
    })
  })
})
