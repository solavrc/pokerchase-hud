import { render, screen, waitFor } from '@testing-library/react'
import { WhatsNewSection } from './WhatsNewSection'
import { WHATS_NEW_ENTRIES, GITHUB_RELEASES_URL } from '../../constants/whats-new'

describe('WhatsNewSection', () => {
  let mockSendMessage: jest.Mock
  let mockGetManifest: jest.Mock

  beforeEach(() => {
    mockSendMessage = jest.fn((_message, callback?: (response: unknown) => void) => {
      if (typeof callback === 'function') callback({ success: true })
    })
    mockGetManifest = jest.fn(() => ({ version: WHATS_NEW_ENTRIES[0]!.version }))
    global.chrome = {
      ...global.chrome,
      runtime: {
        ...global.chrome.runtime,
        sendMessage: mockSendMessage,
        getManifest: mockGetManifest,
      },
    } as any
  })

  it('renders the entry matching the current manifest version, its points, and the GitHub Releases link', async () => {
    render(<WhatsNewSection />)

    const current = WHATS_NEW_ENTRIES[0]!
    expect(screen.getByText('更新情報')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`v${current.version.replace(/\./g, '\\.')}`))).toBeInTheDocument()
    expect(screen.getByText(current.points[0]!.text)).toBeInTheDocument()

    const link = screen.getByRole('link', { name: /すべての変更を見る/ })
    expect(link).toHaveAttribute('href', GITHUB_RELEASES_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('falls back to the newest entry <= current version when there is no exact-match curated entry', async () => {
    mockGetManifest.mockReturnValue({ version: '5.2.99' }) // uncurated patch bump above the newest entry

    render(<WhatsNewSection />)

    const newest = WHATS_NEW_ENTRIES[0]!
    expect(screen.getByText(new RegExp(`v${newest.version.replace(/\./g, '\\.')}`))).toBeInTheDocument()
  })

  it('renders nothing when the current version predates every curated entry', () => {
    mockGetManifest.mockReturnValue({ version: '0.0.1' })

    const { container } = render(<WhatsNewSection />)

    expect(container).toBeEmptyDOMElement()
  })

  it('collapses older entries under a <details> disclosure and lists them all', () => {
    render(<WhatsNewSection />)

    const olderCount = WHATS_NEW_ENTRIES.length - 1
    if (olderCount > 0) {
      const summary = screen.getByText(new RegExp(`過去の更新情報（${olderCount}件）`))
      expect(summary).toBeInTheDocument()
      expect(summary.closest('summary')).toBeInTheDocument()

      for (const entry of WHATS_NEW_ENTRIES.slice(1)) {
        expect(screen.getByText(new RegExp(`v${entry.version.replace(/\./g, '\\.')}`))).toBeInTheDocument()
      }
    }
  })

  it('sends acknowledgeWhatsNew on mount so the background can clear the badge', async () => {
    render(<WhatsNewSection />)

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        { action: 'acknowledgeWhatsNew' },
        expect.any(Function)
      )
    })
  })
})
