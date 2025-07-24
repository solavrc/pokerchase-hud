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
  setImportStatus: (status: string) => void
  handleFirebaseSignIn: () => void
  handleFirebaseSignOut: () => void
  handleManualSyncUpload: () => void
  handleManualSyncDownload: () => void
}

export const FirebaseAuthSection = ({
  isFirebaseSignedIn,
  firebaseUserInfo,
  syncState,
  setImportStatus,
  handleFirebaseSignIn,
  handleFirebaseSignOut,
  handleManualSyncUpload,
  handleManualSyncDownload,
}: FirebaseAuthSectionProps) => {
  if (!isFirebaseSignedIn) {
    return (
      <Button
        variant="contained"
        color="primary"
        fullWidth
        onClick={handleFirebaseSignIn}
        style={{ marginBottom: '15px' }}
        size="large"
        startIcon={<CloudIcon />}
      >
        自動バックアップを有効にする
      </Button>
    )
  }

  return (
    <Box sx={{
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'primary.main',
      borderRadius: 1,
      p: 1.5,
      mb: 2
    }}>
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
        startIcon={<CloudOffIcon />}
        sx={{ mt: 1 }}
      >
        ログアウト
      </Button>

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