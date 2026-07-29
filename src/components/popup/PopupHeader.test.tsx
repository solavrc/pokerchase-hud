import { render, screen } from '@testing-library/react'
import { PopupHeader } from './PopupHeader'

describe('PopupHeader', () => {
  test('shows the manifest version with its release date', () => {
    render(
      <PopupHeader
        popupThemeMode="auto"
        onPopupThemeModeChange={jest.fn()}
      />
    )

    expect(screen.getByText('v5.3.1（2026-07-23）')).toBeInTheDocument()
  })
})
