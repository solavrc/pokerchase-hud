import { render, screen, waitFor } from '@testing-library/react'
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
})
