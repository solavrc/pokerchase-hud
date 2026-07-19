import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { Close } from '@mui/icons-material'
import { useCallback, useEffect, useState } from 'react'
import { ApiTypeValues, type ApiType } from '../../types'
import type { UndecodedEventStats } from '../../background/undecoded-event-tracker'
import type { AcknowledgeUndecodedEventStatsMessage } from '../../types/messages'
import { sendMessageWithTimeout } from './send-message'

/**
 * drop可視化（docs/postmortems/2026-07-session-results-drop.md 再発防止#2）。
 *
 * 検証失敗イベント（Zodパース失敗）の件数をPopupに表示する。309インシデントは
 * この情報がconsole.warnにしかなかったために半年間気づかれなかった。
 * N=0の間は何も表示しない（既定は非表示、ユーザーの目に触れるのは異常時のみ）。
 */
export const UndecodedEventSection = () => {
  const [stats, setStats] = useState<UndecodedEventStats | null>(null)

  const refresh = useCallback(() => {
    // フェイルオープン: タイムアウト/エラー時は現状維持（ブロッキングしない）
    sendMessageWithTimeout<{ undecodedEventStats?: UndecodedEventStats }>({
      action: 'getUndecodedEventStats'
    }).then((response) => {
      if (response?.undecodedEventStats) {
        setStats(response.undecodedEventStats)
      }
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleAcknowledge = useCallback(() => {
    // 楽観的に即座に消す（background側の書き込みでも問題ない）
    setStats(null)
    chrome.runtime.sendMessage<AcknowledgeUndecodedEventStatsMessage>({
      action: 'acknowledgeUndecodedEventStats'
    })
  }, [])

  if (!stats || stats.total === 0) return null

  const entries = Object.entries(stats.perApiTypeId)
    .map(([apiTypeIdStr, entry]) => ({ apiTypeId: Number(apiTypeIdStr), ...entry }))
    .sort((a, b) => b.count - a.count)

  const isDangerous = entries.some(({ apiTypeId }) => ApiTypeValues.includes(apiTypeId as ApiType))
  const lastSeen = entries.reduce((max, e) => Math.max(max, e.lastSeen), 0)

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return `${month}-${day} ${hours}:${minutes}`
  }

  const breakdown = entries.map(({ apiTypeId, count }) => `${apiTypeId}×${count}`).join(', ')

  return (
    <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
      <Alert
        severity={isDangerous ? 'warning' : 'info'}
        action={
          <IconButton size="small" onClick={handleAcknowledge} aria-label="確認済みにする">
            <Close fontSize="inherit" />
          </IconButton>
        }
      >
        <Typography variant="body2">
          未解釈イベント: {stats.total.toLocaleString()}件 ({breakdown} / 最新 {formatTimestamp(lastSeen)})
        </Typography>
      </Alert>
    </Box>
  )
}
