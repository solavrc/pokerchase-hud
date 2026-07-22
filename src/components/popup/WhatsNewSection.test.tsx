import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WhatsNewSection } from './WhatsNewSection'
import { WHATS_NEW_ENTRIES, GITHUB_RELEASES_URL, type WhatsNewEntry } from '../../constants/whats-new'

const syntheticEntry = (version: string, pointCount: number): WhatsNewEntry => ({
  version,
  date: '2026-07-22',
  title: `v${version} updates`,
  points: Array.from({ length: pointCount }, (_, index) => ({ text: `${version} point ${index + 1}` })),
})

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

  it('shows the newest two eligible versions initially and keeps older versions collapsed', () => {
    render(<WhatsNewSection />)

    expect(screen.getByText('更新情報')).toBeInTheDocument()
    expect(screen.getByText(/v5\.2\.0/)).toBeVisible()
    expect(screen.getByText(/v5\.1\.0/)).toBeVisible()
    expect(screen.getByText(/v5\.0\.0/)).not.toBeVisible()

    const history = screen.getByRole('button', { name: new RegExp(`過去の更新情報（${WHATS_NEW_ENTRIES.length - 2}件）`) })
    expect(history).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows a short newest release in full while truncating the long second release', () => {
    const entries = [syntheticEntry('5.3.0', 2), syntheticEntry('5.2.0', 6), syntheticEntry('5.1.0', 1)]
    mockGetManifest.mockReturnValue({ version: '5.3.0' })

    render(<WhatsNewSection entries={entries} />)

    expect(screen.getByText('5.3.0 point 1')).toBeVisible()
    expect(screen.getByText('5.3.0 point 2')).toBeVisible()
    expect(screen.queryByRole('button', { name: /v5\.3\.0の更新情報を続きを読む/ })).not.toBeInTheDocument()
    expect(screen.getByText('5.2.0 point 2')).toBeVisible()
    expect(screen.queryByText('5.2.0 point 3')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /v5\.2\.0の更新情報を続きを読む/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands and collapses a long release with an accessible button', async () => {
    const user = userEvent.setup()
    const entries = [syntheticEntry('5.3.0', 1), syntheticEntry('5.2.0', 6)]
    mockGetManifest.mockReturnValue({ version: '5.3.0' })

    render(<WhatsNewSection entries={entries} />)

    const readMore = screen.getByRole('button', { name: /v5\.2\.0の更新情報を続きを読む/ })
    expect(readMore).toHaveAttribute('aria-expanded', 'false')
    expect(readMore).toHaveAttribute('aria-controls')
    expect(screen.queryByText('5.2.0 point 6')).not.toBeInTheDocument()

    await user.click(readMore)

    expect(screen.getByText('5.2.0 point 6')).toBeVisible()
    const collapse = screen.getByRole('button', { name: /v5\.2\.0の更新情報を折りたたむ/ })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')

    await user.click(collapse)

    expect(screen.queryByText('5.2.0 point 6')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /v5\.2\.0の更新情報を続きを読む/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('expands and collapses the third and older releases as one accessible disclosure', async () => {
    const user = userEvent.setup()
    render(<WhatsNewSection />)

    const history = screen.getByRole('button', { name: /過去の更新情報/ })
    const controlledId = history.getAttribute('aria-controls')
    expect(controlledId).toBeTruthy()
    expect(history).toHaveTextContent(/^▶ 過去の更新情報/)
    expect(history).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(controlledId!)).toHaveAttribute('hidden')

    await user.click(history)

    expect(screen.getByRole('button', { name: /過去の更新情報/ })).toHaveTextContent(/^▼ 過去の更新情報/)
    expect(screen.getByRole('button', { name: /過去の更新情報/ })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(controlledId!)).not.toHaveAttribute('hidden')
    expect(screen.getByText(/v5\.0\.0/)).toBeVisible()

    await user.click(screen.getByRole('button', { name: /過去の更新情報/ }))

    expect(screen.getByRole('button', { name: /過去の更新情報/ })).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(controlledId!)).toHaveAttribute('hidden')
  })

  it.each([
    { entries: [syntheticEntry('5.3.0', 1)], expectedVersions: ['5.3.0'] },
    { entries: [syntheticEntry('5.3.0', 1), syntheticEntry('5.2.0', 1)], expectedVersions: ['5.3.0', '5.2.0'] },
  ])('handles $expectedVersions.length eligible entries without an empty history disclosure', ({ entries, expectedVersions }) => {
    mockGetManifest.mockReturnValue({ version: '5.3.0' })

    render(<WhatsNewSection entries={entries} />)

    for (const version of expectedVersions) {
      expect(screen.getByText(new RegExp(`v${version.replace(/\./g, '\\.')}`))).toBeVisible()
    }
    expect(screen.queryByRole('button', { name: /過去の更新情報/ })).not.toBeInTheDocument()
  })

  it('falls back to the newest entry <= current version when there is no exact curated entry', () => {
    mockGetManifest.mockReturnValue({ version: '5.2.99' })

    render(<WhatsNewSection />)

    expect(screen.getByText(/v5\.2\.0/)).toBeVisible()
    expect(screen.getByText(/v5\.1\.0/)).toBeVisible()
  })

  it('renders nothing when the current version predates every curated entry', () => {
    mockGetManifest.mockReturnValue({ version: '0.0.1' })

    const { container } = render(<WhatsNewSection />)

    expect(container).toBeEmptyDOMElement()
  })

  it('excludes future entries from featured releases and history', async () => {
    const user = userEvent.setup()
    mockGetManifest.mockReturnValue({ version: '5.1.0' })

    render(<WhatsNewSection />)

    expect(screen.queryByText(/v5\.2\.0/)).not.toBeInTheDocument()
    expect(screen.getByText(/v5\.1\.0/)).toBeVisible()
    expect(screen.getByText(/v5\.0\.0/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /過去の更新情報/ }))
    expect(screen.queryByText(/v5\.2\.0/)).not.toBeInTheDocument()
  })

  it('renders the GitHub Releases link', () => {
    render(<WhatsNewSection />)

    const link = screen.getByRole('link', { name: /すべての変更を見る/ })
    expect(link).toHaveAttribute('href', GITHUB_RELEASES_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
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
