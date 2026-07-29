import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useEffect, useState, type ChangeEvent } from 'react'
import {
  readSentryTelemetryEnabled,
  requestSentryTelemetry,
  revokeSentryTelemetry
} from '../../observability/telemetry-consent'

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
        if (!cancelled) setError('エラー診断の設定を読み込めませんでした。')
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
          setError('Sentryへの送信権限が許可されませんでした。')
        }
      } else {
        await revokeSentryTelemetry()
        setEnabled(false)
      }
    } catch {
      setError('エラー診断の設定を更新できませんでした。')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        エラー診断
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            disabled={pending}
            onChange={handleChange}
          />
        }
        label="Sentryへエラー診断を送信"
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        クラッシュ情報を送信します。API変更を検知した場合は、
        プレイヤー識別子・名前・チャットを除いた対局イベントも送信します。
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </>
  )
}
