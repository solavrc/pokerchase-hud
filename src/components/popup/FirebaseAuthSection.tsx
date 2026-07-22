import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { Cloud as CloudIcon, CloudOff as CloudOffIcon } from '@mui/icons-material'
import type { SyncState } from '../../services/auto-sync-service'
import { SyncStatusSection } from './SyncStatusSection'

interface FirebaseAuthSectionProps {
  isFirebaseSignedIn: boolean
  firebaseUserInfo: { email: string; uid: string } | null
  syncState: SyncState | null
  isAuthPending: boolean
  authError: string
  setImportStatus: (status: string) => void
  handleFirebaseSignIn: () => Promise<void>
  handleFirebaseSignOut: () => Promise<void>
  handleManualSyncUpload: () => void
  handleManualSyncDownload: () => void
}

export const FirebaseAuthSection = ({
  isFirebaseSignedIn,
  firebaseUserInfo,
  syncState,
  isAuthPending,
  authError,
  setImportStatus,
  handleFirebaseSignIn,
  handleFirebaseSignOut,
  handleManualSyncUpload,
  handleManualSyncDownload,
}: FirebaseAuthSectionProps) => {
  if (!isFirebaseSignedIn) {
    return (
      <Box>
        <Button
          variant="contained"
          color="primary"
          fullWidth
          onClick={handleFirebaseSignIn}
          disabled={isAuthPending}
          size="large"
          startIcon={<CloudIcon />}
        >
          {isAuthPending ? '有効化しています...' : '自動バックアップを有効にする'}
        </Button>
        {authError && (
          <Typography role="alert" variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
            {authError}
          </Typography>
        )}
      </Box>
    )
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <CloudIcon sx={{ color: 'primary.main' }} />
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {firebaseUserInfo?.email}
          </Typography>
          {firebaseUserInfo?.uid && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                fontSize: '10px',
                cursor: 'pointer',
                '&:hover': { textDecoration: 'underline' }
              }}
              onClick={() => {
                if (firebaseUserInfo.uid) {
                  navigator.clipboard.writeText(firebaseUserInfo.uid)
                  setImportStatus('ユーザーIDをコピーしました')
                  setTimeout(() => setImportStatus(''), 2000)
                }
              }}
              title="クリックしてコピー"
            >
              ID: {firebaseUserInfo.uid}
            </Typography>
          )}
        </Box>
      </Box>
      <Button
        variant="outlined"
        size="small"
        fullWidth
        onClick={handleFirebaseSignOut}
        disabled={isAuthPending}
        startIcon={<CloudOffIcon />}
        sx={{ mt: 1 }}
      >
        {isAuthPending ? 'ログアウトしています...' : 'ログアウト'}
      </Button>
      {authError && (
        <Typography role="alert" variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
          {authError}
        </Typography>
      )}

      {/* Sync Status */}
      {syncState && (
        <SyncStatusSection
          syncState={syncState}
          handleManualSyncUpload={handleManualSyncUpload}
          handleManualSyncDownload={handleManualSyncDownload}
        />
      )}
    </Box>
  )
}
