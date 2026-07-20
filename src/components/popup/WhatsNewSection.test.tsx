import { render, screen, waitFor } from '@testing-library/react'
import { WhatsNewSection } from './WhatsNewSection'
import { WHATS_NEW_ENTRIES, GITHUB_RELEASES_URL } from '../../constants/whats-new'
import { compareVersions } from '../../utils/version-compare'

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

  it('excludes future entries from both the primary slot and the history disclosure (codex review, PR #172)', () => {
    // Regression for: manifest.json/package.json still at 5.1.0 while
    // WHATS_NEW_ENTRIES[0] is the newer, not-yet-released 5.2.0 (this repo's
    // actual state right now -- the whats-new copy for a release is added
    // ahead of release-please bumping the manifest, see whats-new.ts's
    // header comment). An entry newer than the running version must never
    // render anywhere, including tucked away in "過去の更新情報".
    expect(WHATS_NEW_ENTRIES[0]!.version).toBe('5.2.0')
    mockGetManifest.mockReturnValue({ version: '5.1.0' })

    render(<WhatsNewSection />)

    // Primary: the 5.1.0 entry (exact match), never the future 5.2.0 one.
    expect(screen.getByText(/v5\.1\.0/)).toBeInTheDocument()
    expect(screen.queryByText(/v5\.2\.0/)).not.toBeInTheDocument()

    // History: every curated entry strictly older than the selected 5.1.0
    // entry (5.0.0 and all earlier releases) -- the future 5.2.0 entry must
    // be filtered out, not merely deduplicated against the primary entry.
    // Count is derived rather than hardcoded so it doesn't rot as sola adds
    // more curated history to WHATS_NEW_ENTRIES.
    const expectedOlderCount = WHATS_NEW_ENTRIES.filter(entry => compareVersions(entry.version, '5.1.0') === -1).length
    expect(
      screen.getByText(new RegExp(`過去の更新情報（${expectedOlderCount}件）`))
    ).toBeInTheDocument()
    expect(screen.getByText(/v5\.0\.0/)).toBeInTheDocument()
    expect(screen.queryByText(/v5\.2\.0/)).not.toBeInTheDocument()
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
