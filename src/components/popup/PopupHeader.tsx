import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import RadioGroup from '@mui/material/RadioGroup'
import Typography from '@mui/material/Typography'
import { useEffect } from 'react'
import { getGitHubReleaseUrl } from '../../constants/release-info'
import type { AcknowledgeWhatsNewMessage } from '../../types/messages'
import type { PopupThemeMode } from './theme'
import { SegmentRadio } from './SegmentRadio'
import { sendMessageWithTimeout } from './send-message'

interface PopupHeaderProps {
  popupThemeMode: PopupThemeMode
  onPopupThemeModeChange: (mode: PopupThemeMode) => void
}

/**
 * Product-identity header ("PokerChase HUD" wordmark + version, sourced
 * from `manifest.json` so it never drifts from the shipped build) that
 * replaces the previous bare サイズ/表示 row at the very top of the popup.
 * サイズ (UIScaleSection) and 表示/非表示 now live in a settings row
 * beneath this header instead of doubling as the popup's de-facto title.
 *
 * Also hosts the テーマ (自動/ダーク/ライト) control -- a popup-only,
 * cosmetic setting (see `popup-theme-storage.ts` for why it's kept out of
 * `uiConfig`) -- so it reads as part of the popup's own chrome rather than
 * a HUD/game setting mixed in with the rest of the cards below.
 */
export const PopupHeader = ({ popupThemeMode, onPopupThemeModeChange }: PopupHeaderProps) => {
  const version = chrome.runtime.getManifest().version
  const releaseUrl = getGitHubReleaseUrl(version)

  useEffect(() => {
    if (!version) return
    // The running version and its Release link are now visible, so the
    // informational N badge has fulfilled its purpose. The message is
    // idempotent and preserves higher-priority rebuild/update badges.
    sendMessageWithTimeout<{ success: boolean }>({
      action: 'acknowledgeWhatsNew',
    } as AcknowledgeWhatsNewMessage)
  }, [version])

  return (
    <Box sx={{ mb: 1.5, px: 0.25 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Typography
          component="h1"
          sx={{
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: '0.01em',
            color: 'text.primary',
          }}
        >
          PokerChase HUD
        </Typography>
        {version && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
            <Typography
              variant="caption"
              sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
            >
              v{version}
            </Typography>
            <Link
              href={releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="caption"
              color="inherit"
            >
              更新情報
            </Link>
          </Box>
        )}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>テーマ:</Typography>
        <RadioGroup
          row
          aria-label="テーマ"
          name="popup-theme-mode"
          value={popupThemeMode}
          onChange={(_event, newValue) => {
            onPopupThemeModeChange(newValue as PopupThemeMode)
          }}
        >
          <SegmentRadio value="auto" checked={popupThemeMode === 'auto'} label="自動" />
          <SegmentRadio value="dark" checked={popupThemeMode === 'dark'} label="ダーク" />
          <SegmentRadio value="light" checked={popupThemeMode === 'light'} label="ライト" />
        </RadioGroup>
      </Box>
    </Box>
  )
}
