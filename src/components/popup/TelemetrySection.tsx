import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Link from '@mui/material/Link'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useEffect, useState, type ChangeEvent } from 'react'
import {
  readSentryTelemetryEnabled,
  requestSentryTelemetry,
  revokeSentryTelemetry
} from '../../observability/telemetry-consent'

const PRIVACY_POLICY_URL =
  'https://github.com/solavrc/pokerchase-hud/blob/main/PRIVACY.md'

export const TelemetrySection = () => {
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    readSentryTelemetryEnabled()
      .then(value => {
        if (!cancelled) setEnabled(value)
      })
      .catch(() => {
        if (!cancelled) setError('診断情報の設定を読み込めませんでした。')
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const nextEnabled = event.target.checked
    setPending(true)
    setError('')

    try {
      if (nextEnabled) {
        const granted = await requestSentryTelemetry()
        setEnabled(granted)
        if (!granted) {
          setError('診断情報の送信が許可されませんでした。')
        }
      } else {
        await revokeSentryTelemetry()
        setEnabled(false)
      }
    } catch {
      try {
        setEnabled(await readSentryTelemetryEnabled())
      } catch {
        // Keep the last rendered state if even reconciliation is unavailable.
      }
      setError('診断情報の設定を更新できませんでした。')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        診断情報
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            disabled={pending}
            onChange={handleChange}
          />
        }
        label="診断情報を送信"
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        不具合の調査に必要な診断情報は、外部のエラー監視サービスへ送信されます。
        APIの変更を検知した場合は、プレイヤー識別子・名前・チャットを除いた
        対局イベントも含まれます。{' '}
        <Link
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          プライバシーポリシー
        </Link>
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </>
  )
}
