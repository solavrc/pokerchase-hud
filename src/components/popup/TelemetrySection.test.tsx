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
    render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: 'Sentryへエラー診断を送信'
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).not.toBeChecked()

    await user.click(toggle)

    await waitFor(() => expect(requestSentryTelemetry).toHaveBeenCalledTimes(1))
    expect(toggle).toBeChecked()
  })

  it('keeps telemetry disabled when Chrome denies the permission request', async () => {
    jest.mocked(requestSentryTelemetry).mockResolvedValue(false)
    const user = userEvent.setup()
    render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: 'Sentryへエラー診断を送信'
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)

    await screen.findByText('Sentryへの送信権限が許可されませんでした。')
    expect(toggle).not.toBeChecked()
  })

  it('revokes telemetry when an enabled user switches it off', async () => {
    jest.mocked(readSentryTelemetryEnabled).mockResolvedValue(true)
    const user = userEvent.setup()
    render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: 'Sentryへエラー診断を送信'
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
    render(<TelemetrySection />)

    const toggle = await screen.findByRole('switch', {
      name: 'Sentryへエラー診断を送信'
    })
    await waitFor(() => expect(toggle).toBeChecked())
    await user.click(toggle)

    await screen.findByText('エラー診断の設定を更新できませんでした。')
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(readSentryTelemetryEnabled).toHaveBeenCalledTimes(2)
  })
})
