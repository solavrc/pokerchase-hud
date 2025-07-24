import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { ArrowUpward, ArrowDownward } from '@mui/icons-material'
import type { SyncState } from '../../services/auto-sync-service'

interface SyncStatusSectionProps {
  syncState: SyncState
  unsyncedCount: number
  handleManualSyncUpload: () => void
  handleManualSyncDownload: () => void
}

export const SyncStatusSection = ({
  syncState,
  unsyncedCount,
  handleManualSyncUpload,
  handleManualSyncDownload,
}: SyncStatusSectionProps) => {
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
        {syncState.status === 'syncing' && syncState.progress && (
          <>
            {syncState.progress.direction === 'upload' ? (
              <ArrowUpward sx={{ fontSize: 14, color: 'success.main', ml: 'auto' }} />
            ) : (
              <ArrowDownward sx={{ fontSize: 14, color: 'error.main', ml: 'auto' }} />
            )}
            <Typography variant="caption" color="text.secondary">
              {syncState.progress.current.toLocaleString()}/{syncState.progress.total.toLocaleString()}
              ({Math.round((syncState.progress.current / syncState.progress.total) * 100)}%)
            </Typography>
          </>
        )}
      </Box>
      {syncState.lastSyncTime && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          最終同期: {new Date(syncState.lastSyncTime).toLocaleString('ja-JP')}
        </Typography>
      )}
      {unsyncedCount > 0 && (
        <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 0.5 }}>
          未同期: {unsyncedCount.toLocaleString()}件
        </Typography>
      )}
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