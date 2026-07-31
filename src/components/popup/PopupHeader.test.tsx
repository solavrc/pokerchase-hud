import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PopupThemeMode } from './theme'
import { PopupHeader } from './PopupHeader'

describe('PopupHeader', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('shows the running manifest version and the fixed GitHub Releases link', async () => {
    render(
      <PopupHeader
        popupThemeMode="auto"
        onPopupThemeModeChange={jest.fn()}
      />
    )

    const version = chrome.runtime.getManifest().version
    expect(screen.getByText(`v${version}`)).toBeInTheDocument()
    expect(screen.queryByText(/2026-07-23/)).not.toBeInTheDocument()

    const link = screen.getByRole('link', { name: '更新情報' })
    // Deliberately version-independent: the link points at the Releases index,
    // never a per-version tag URL that can 404 on an unreleased build.
    expect(link).toHaveAttribute('href', 'https://github.com/solavrc/pokerchase-hud/releases')
    expect(link.getAttribute('href')).not.toContain(version)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        { action: 'acknowledgeWhatsNew' },
        expect.any(Function)
      )
    })
  })

  describe('テーマのアイコントグル', () => {
    // 3状態を1ボタンで回すので、順序が崩れると到達できないモードが出る。
    it.each<[PopupThemeMode, PopupThemeMode]>([
      ['auto', 'light'],
      ['light', 'dark'],
      ['dark', 'auto'],
    ])('%s をクリックすると %s になる', async (mode, expected) => {
      const onPopupThemeModeChange = jest.fn()
      render(
        <PopupHeader
          popupThemeMode={mode}
          onPopupThemeModeChange={onPopupThemeModeChange}
        />
      )

      await userEvent.click(screen.getByRole('button', { name: /^テーマ:/ }))

      expect(onPopupThemeModeChange).toHaveBeenCalledWith(expected)
    })

    it('現在のモードをアクセシブル名に出し、次のモードはtitleで補う', () => {
      render(
        <PopupHeader popupThemeMode="dark" onPopupThemeModeChange={jest.fn()} />
      )

      const toggle = screen.getByRole('button', { name: 'テーマ: ダーク' })
      expect(toggle).toHaveAttribute('title', 'テーマ: ダーク（クリックで自動へ）')
    })

    it('自動/ダーク/ライトの3択ラジオは残っていない', () => {
      render(
        <PopupHeader popupThemeMode="auto" onPopupThemeModeChange={jest.fn()} />
      )

      expect(screen.queryAllByRole('radio')).toHaveLength(0)
    })
  })
})
