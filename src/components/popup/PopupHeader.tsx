import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { BrightnessAuto, DarkMode, LightMode } from '@mui/icons-material'
import { useEffect } from 'react'
import { GITHUB_RELEASES_URL } from '../../constants/release-info'
import type { AcknowledgeWhatsNewMessage } from '../../types/messages'
import type { PopupThemeMode } from './theme'
import { sendMessageWithTimeout } from './send-message'

interface PopupHeaderProps {
  popupThemeMode: PopupThemeMode
  onPopupThemeModeChange: (mode: PopupThemeMode) => void
}

/**
 * クリックのたびに次のモードへ送る。自動を含めて3状態あるので2状態トグルには
 * できないが、Webでよくある「太陽/月アイコンをクリックして切り替える」形に
 * 揃えて、専有面積を1ボタンぶんに落とす。
 * 自動→ライト→ダーク→自動 の順にしているのは、自動から押したユーザーが
 * まず得たいのは「今と違う見た目」ではなく明示指定であり、ライト・ダークの
 * 並びは設定画面の通例（明→暗）に合わせるため。
 */
const NEXT_THEME_MODE: Record<PopupThemeMode, PopupThemeMode> = {
  auto: 'light',
  light: 'dark',
  dark: 'auto',
}

const THEME_MODE_LABEL: Record<PopupThemeMode, string> = {
  auto: '自動',
  light: 'ライト',
  dark: 'ダーク',
}

const ThemeModeIcon = ({ mode }: { mode: PopupThemeMode }) => {
  const sx = { fontSize: 18 }
  if (mode === 'light') return <LightMode sx={sx} />
  if (mode === 'dark') return <DarkMode sx={sx} />
  return <BrightnessAuto sx={sx} />
}

/**
 * Product-identity header ("PokerChase HUD" wordmark + version, sourced
 * from `manifest.json` so it never drifts from the shipped build) that
 * replaces the previous bare サイズ/表示 row at the very top of the popup.
 * サイズ (UIScaleSection) and 表示/非表示 now live in a settings row
 * beneath this header instead of doubling as the popup's de-facto title.
 *
 * Also hosts the テーマ control -- a popup-only, cosmetic setting (see
 * `popup-theme-storage.ts` for why it's kept out of `uiConfig`) -- so it
 * reads as part of the popup's own chrome rather than a HUD/game setting
 * mixed in with the rest of the cards below. It is a single cycling icon
 * button rather than a 自動/ダーク/ライト segmented row: everything above the
 * stat picker is kept as plain as possible (sola), and the popup's own
 * appearance is the least HUD-related setting there is.
 */
export const PopupHeader = ({ popupThemeMode, onPopupThemeModeChange }: PopupHeaderProps) => {
  const version = chrome.runtime.getManifest().version

  useEffect(() => {
    if (!version) return
    // The running version and the Releases link are now visible, so the
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
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          {version && (
            <>
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
              >
                v{version}
              </Typography>
              <Link
                href={GITHUB_RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                variant="caption"
                color="inherit"
              >
                更新情報
              </Link>
            </>
          )}
          <IconButton
            size="small"
            // 現在のモードをそのままaria-labelにする。次に何になるかはtitle側で
            // 補う（支援技術には「今どれか」の方が先に必要）。
            aria-label={`テーマ: ${THEME_MODE_LABEL[popupThemeMode]}`}
            title={`テーマ: ${THEME_MODE_LABEL[popupThemeMode]}（クリックで${THEME_MODE_LABEL[NEXT_THEME_MODE[popupThemeMode]]}へ）`}
            onClick={() => {
              onPopupThemeModeChange(NEXT_THEME_MODE[popupThemeMode])
            }}
            sx={{ p: 0.5, color: 'text.secondary' }}
          >
            <ThemeModeIcon mode={popupThemeMode} />
          </IconButton>
        </Box>
      </Box>
    </Box>
  )
}
