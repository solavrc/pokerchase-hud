import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useCallback, useEffect, useState } from 'react'
import { PENDING_UPDATE_STORAGE_KEY, type PendingUpdateState } from '../../constants/update'
import { MIN_VERSION_GATE_STORAGE_KEY, type MinVersionGateState } from '../../services/min-version-gate'
import type { ApplyPendingUpdateMessage, ApplyUpdateResponse } from '../../types/messages'
import { sendMessageWithTimeout } from './send-message'

/**
 * Forced Update（sola承認）バナー。2つの独立した状態を表示する:
 *
 * 1. 保留中アップデート（`pendingUpdate`）: ダウンロード済みだが安全な瞬間
 *    でなかったため未適用の更新。「今すぐ適用」で安全性を再チェックし、
 *    OKならbackground側で`chrome.runtime.reload()`する。
 * 2. リモート最低バージョンゲート（`minVersionGateState`）: 現在の
 *    バージョンがサポート終了（`config/client.minSupportedVersion`未満）の
 *    場合、より強い警告を表示する。クラウド同期は既にAutoSyncService側で
 *    停止済み（HUD自体はローカル計算のため動作を継続する）。
 *
 * どちらも`chrome.storage.local`を直接購読する方式（rebuild-advisory /
 * UndecodedEventSectionと同じパターン）。適用ボタンは両方とも同じ
 * `applyPendingUpdate`メッセージ（background/update-manager.tsの
 * `applyUpdateNow()`）を再利用する。
 */
export const UpdateSection = () => {
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdateState | null>(null)
  const [minVersionGateState, setMinVersionGateState] = useState<MinVersionGateState | null>(null)
  const [applying, setApplying] = useState(false)
  const [blockedReason, setBlockedReason] = useState<string | null>(null)

  useEffect(() => {
    chrome.storage.local.get(
      [PENDING_UPDATE_STORAGE_KEY, MIN_VERSION_GATE_STORAGE_KEY],
      (result: Record<string, any>) => {
        if (chrome.runtime.lastError) return
        setPendingUpdate(result?.[PENDING_UPDATE_STORAGE_KEY] ?? null)
        setMinVersionGateState(result?.[MIN_VERSION_GATE_STORAGE_KEY] ?? null)
      }
    )

    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'local') return
      if (changes[PENDING_UPDATE_STORAGE_KEY]) {
        const newValue = changes[PENDING_UPDATE_STORAGE_KEY].newValue as PendingUpdateState | undefined
        setPendingUpdate(newValue ?? null)
      }
      if (changes[MIN_VERSION_GATE_STORAGE_KEY]) {
        const newValue = changes[MIN_VERSION_GATE_STORAGE_KEY].newValue as MinVersionGateState | undefined
        setMinVersionGateState(newValue ?? null)
      }
    }

    chrome.storage.onChanged.addListener(handleStorageChange)
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [])

  const handleApplyNow = useCallback(() => {
    setApplying(true)
    setBlockedReason(null)
    sendMessageWithTimeout<ApplyUpdateResponse>({ action: 'applyPendingUpdate' } as ApplyPendingUpdateMessage).then((response) => {
      setApplying(false)
      // response is undefined on timeout, or {applied:false} if still unsafe
      // -- either way, fail open to leaving the banner as-is rather than
      // claiming success.
      if (response && !response.applied) {
        setBlockedReason(response.reason ?? '適用できませんでした')
      }
      // response.applied === true: background is reloading the extension;
      // no further UI update needed (the popup will be torn down).
    })
  }, [])

  const isUnsupported = minVersionGateState?.supported === false
  const isPending = !!pendingUpdate?.pending

  if (!isUnsupported && !isPending) return null

  return (
    <Box sx={{ mt: 1 }}>
      {isUnsupported && (
        <Alert severity="error" sx={{ mb: isPending ? 1 : 0 }}>
          <Typography variant="body2">
            このバージョンはサポートが終了しました。Chromeを再起動すると更新が適用されます
          </Typography>
          {/* ゲートのみunsupportedでpendingUpdateが無い場合はボタンを出さない
              （codexレビュー指摘）: applyPendingUpdate/applyUpdateNow()は
              実際にダウンロード済みの更新が無いとchrome.runtime.reload()が
              「安全なら今の(古い)バージョンのまま再読み込みするだけ」になり、
              何も解決しないのに「保留中の更新」バナーだけ捏造されうる。
              ボタンは実際に更新が保留中(isPending)のときだけ表示し、
              ゲートのみの状態では案内文だけを見せる */}
          {isPending && (
            <Button
              size="small"
              color="inherit"
              onClick={handleApplyNow}
              disabled={applying}
              sx={{ mt: 0.5 }}
            >
              {applying ? '確認中...' : '今すぐ適用'}
            </Button>
          )}
        </Alert>
      )}

      {isPending && (
        <Alert severity="info">
          <Typography variant="body2">
            新しいバージョンが待機中です
          </Typography>
          <Button
            size="small"
            color="inherit"
            onClick={handleApplyNow}
            disabled={applying}
            sx={{ mt: 0.5 }}
          >
            {applying ? '確認中...' : '今すぐ適用'}
          </Button>
          {blockedReason && (
            <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
              {blockedReason}
            </Typography>
          )}
        </Alert>
      )}
    </Box>
  )
}
