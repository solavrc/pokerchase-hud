import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { ArrowUpward, ArrowDownward } from '@mui/icons-material'
import type { SyncState } from '../../services/auto-sync-service'
import { useEffect, useState } from 'react'

interface SyncStatusSectionProps {
  syncState: SyncState
  handleManualSyncUpload: () => void
  handleManualSyncDownload: () => void
}

interface SyncInfo {
  localLastTimestamp?: number
  cloudLastTimestamp?: number
  uploadPendingCount: number
}

export const SyncStatusSection = ({
  syncState,
  handleManualSyncUpload,
  handleManualSyncDownload,
}: SyncStatusSectionProps) => {
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null)

  useEffect(() => {
    // Get sync info on mount and when syncState changes
    chrome.runtime.sendMessage({ action: 'getSyncInfo' }, (response: any) => {
      if (response && response.syncInfo) {
        setSyncInfo(response.syncInfo)
      }
    })
  }, [syncState])

  const formatTimestamp = (timestamp?: number) => {
    if (!timestamp) return '未確認'
    const date = new Date(timestamp)
    const year = String(date.getFullYear()).slice(-2)
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`
  }

  return (
    <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: syncState.status === 'syncing' ? 'warning.main' :
              syncState.status === 'error' ? 'error.main' :
                syncState.status === 'success' ? 'success.main' : 'grey.500'
          }}
        />
        <Typography variant="body2">
          {syncState.status === 'syncing' ? '同期中...' :
            syncState.status === 'error' ? 'エラー' :
              syncState.status === 'success' ? '同期完了' : '待機中'}
        </Typography>
        {syncInfo && syncInfo.cloudLastTimestamp && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            最終同期: {formatTimestamp(syncInfo.cloudLastTimestamp)}
          </Typography>
        )}
        {syncState.status === 'syncing' && syncState.progress && (
          <>
            {syncState.progress.direction === 'upload' ? (
              <ArrowUpward sx={{ fontSize: 14, color: 'success.main', ml: syncInfo ? 1 : 'auto' }} />
            ) : (
              <ArrowDownward sx={{ fontSize: 14, color: 'error.main', ml: syncInfo ? 1 : 'auto' }} />
            )}
            <Typography variant="caption" color="text.secondary">
              {syncState.progress.current.toLocaleString()}/{syncState.progress.total.toLocaleString()}
              ({Math.round((syncState.progress.current / syncState.progress.total) * 100)}%)
            </Typography>
          </>
        )}
      </Box>
      {syncState.error && (
        <Typography variant="caption" color="error" display="block" sx={{ mt: 0.5 }}>
          {syncState.error}
        </Typography>
      )}

      {/* Manual Sync Buttons */}
      <Box sx={{ display: 'flex', gap: 1, mt: 1.5 }}>
        <Button
          variant="outlined"
          size="small"
          fullWidth
          onClick={handleManualSyncUpload}
          disabled={syncState.status === 'syncing'}
          startIcon={<ArrowUpward />}
        >
          アップロード
        </Button>
        <Button
          variant="outlined"
          size="small"
          fullWidth
          onClick={handleManualSyncDownload}
          disabled={syncState.status === 'syncing'}
          startIcon={<ArrowDownward />}
        >
          ダウンロード
        </Button>
      </Box>
    </Box>
  )
}