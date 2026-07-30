import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  readSentryTelemetryEnabled,
  requestSentryTelemetry,
  revokeSentryTelemetry
} from '../../observability/telemetry-consent'
import { TelemetrySection } from './TelemetrySection'

jest.mock('../../observability/telemetry-consent', () => ({
  readSentryTelemetryEnabled: jest.fn(),
  requestSentryTelemetry: jest.fn(),
  revokeSentryTelemetry: jest.fn()
}))

describe('TelemetrySection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(readSentryTelemetryEnabled).mockResolvedValue(false)
    jest.mocked(requestSentryTelemetry).mockResolvedValue(true)
    jest.mocked(revokeSentryTelemetry).mockResolvedValue()
  })

  it('does not enable telemetry until the user grants the optional host permission', async () => {
    const user = userEvent.setup()
    const { container } = render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: '診断情報を送信'
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(screen.getByText('診断情報')).toBeInTheDocument()
    expect(container).toHaveTextContent(
      /不具合の調査に必要な診断情報は、外部のエラー監視サービスへ送信されます。\s*APIの変更を検知した場合は、プレイヤー識別子・名前・チャットを除いた\s*対局イベントも含まれます。/
    )
    expect(
      screen.getByRole('link', { name: 'プライバシーポリシー' })
    ).toHaveAttribute(
      'href',
      'https://github.com/solavrc/pokerchase-hud/blob/main/PRIVACY.md'
    )
    expect(container).not.toHaveTextContent(/Sentry/i)
    expect(toggle).not.toBeChecked()

    await user.click(toggle)

    await waitFor(() => expect(requestSentryTelemetry).toHaveBeenCalledTimes(1))
    expect(toggle).toBeChecked()
  })

  it('keeps telemetry disabled when Chrome denies the permission request', async () => {
    jest.mocked(requestSentryTelemetry).mockResolvedValue(false)
    const user = userEvent.setup()
    const { container } = render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: '診断情報を送信'
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)

    await screen.findByText('診断情報の送信が許可されませんでした。')
    expect(container).not.toHaveTextContent(/Sentry/i)
    expect(toggle).not.toBeChecked()
  })

  it('reports a generic error when the diagnostic setting cannot be loaded', async () => {
    jest.mocked(readSentryTelemetryEnabled).mockRejectedValue(
      new Error('storage unavailable')
    )
    const { container } = render(<TelemetrySection />)

    await screen.findByText('診断情報の設定を読み込めませんでした。')
    expect(container).not.toHaveTextContent(/Sentry/i)
  })

  it('revokes telemetry when an enabled user switches it off', async () => {
    jest.mocked(readSentryTelemetryEnabled).mockResolvedValue(true)
    const user = userEvent.setup()
    render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: '診断情報を送信'
    })
    await waitFor(() => expect(toggle).toBeChecked())
    await user.click(toggle)

    await waitFor(() => expect(revokeSentryTelemetry).toHaveBeenCalledTimes(1))
    expect(toggle).not.toBeChecked()
  })

  it('reconciles the switch after a partially failed revocation', async () => {
    jest.mocked(readSentryTelemetryEnabled)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    jest.mocked(revokeSentryTelemetry).mockRejectedValue(
      new Error('mirror write failed')
    )
    const user = userEvent.setup()
    const { container } = render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: '診断情報を送信'
    })
    await waitFor(() => expect(toggle).toBeChecked())
    await user.click(toggle)

    await screen.findByText('診断情報の設定を更新できませんでした。')
    expect(container).not.toHaveTextContent(/Sentry/i)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(readSentryTelemetryEnabled).toHaveBeenCalledTimes(2)
  })
})
