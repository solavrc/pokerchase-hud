import { createTheme, type Theme } from '@mui/material/styles'

/**
 * Popup themes (production, ported from the proto/popup-redesign design
 * review -- see git history for the prototype's `?theme=` URL-toggle
 * version).
 *
 * Two coherent visual directions for the popup, both fixing the same
 * underlying debts (stock-MUI white background, default blue controls,
 * a screaming red export button, mixed EN/JP labels): a dark "felt" theme
 * that shares the HUD overlay's own palette, and a refined light theme for
 * users who prefer a bright settings panel. Selecting between them is a
 * single `createTheme` swap -- no component restructuring.
 *
 * Which variant renders is driven by the user-facing `popupTheme` setting
 * (`'auto' | 'dark' | 'light'`, see `popup-theme-storage.ts`), not a URL
 * param -- `resolvePopupThemeVariant` below resolves 'auto' against the OS
 * `prefers-color-scheme` (read via `useMediaQuery` in `Popup.tsx` so it
 * updates live if the OS scheme changes while the popup is open).
 */
export type PopupThemeVariant = 'dark-felt' | 'modern-light'

/** Persisted user setting (`popupTheme` in `chrome.storage.sync`). */
export type PopupThemeMode = 'auto' | 'dark' | 'light'

export const DEFAULT_POPUP_THEME_MODE: PopupThemeMode = 'auto'

/**
 * Resolves the persisted `popupTheme` mode + the live OS color-scheme signal
 * down to a concrete theme variant. Pure function (no `window` access) so
 * it's trivially unit-testable and reusable both at initial-mount time (in
 * `popup.ts`, before the OS signal is available) and reactively inside
 * `Popup.tsx` via `useMediaQuery('(prefers-color-scheme: dark)')`.
 */
export const resolvePopupThemeVariant = (
  mode: PopupThemeMode,
  prefersDarkScheme: boolean,
): PopupThemeVariant => {
  if (mode === 'dark') return 'dark-felt'
  if (mode === 'light') return 'modern-light'
  return prefersDarkScheme ? 'dark-felt' : 'modern-light'
}

// --- ダークフェルト -----------------------------------------------------
// HUDオーバーレイと世界観を統一: フェルト地の暗い背景 + ポーカーゴールドの
// アクセント。HUDの統計色（青/オレンジ/赤）はここでは使わない
// （このポップアップにスタッツ表示要素は無いため、意図的に持ち込まない）。
const DARK_FELT = {
  background: '#0d1512',
  paper: '#16201b',
  paperElevated: '#1c2820',
  primary: '#d9a842',
  primaryContrast: '#211804',
  secondary: '#3f8a5c',
  secondaryContrast: '#08130d',
  textPrimary: '#eef2ee',
  textSecondary: '#9fb3a4',
  divider: 'rgba(238, 242, 238, 0.09)',
  error: '#d16a63',
  warning: '#d9a842',
  scrollbarTrack: '#0d1512',
  scrollbarThumb: '#33423a',
} as const

// --- モダンライト ---------------------------------------------------------
// 温かみのあるオフホワイト地 + ディープグリーンのアクセント。区切りは
// Dividerではなく淡いボーダーで表現する。
const MODERN_LIGHT = {
  background: '#faf9f6',
  paper: '#ffffff',
  paperElevated: '#f3f1ea',
  primary: '#1f6b45',
  primaryContrast: '#ffffff',
  secondary: '#b9812c',
  secondaryContrast: '#ffffff',
  textPrimary: '#20261f',
  textSecondary: '#5c675d',
  divider: 'rgba(32, 38, 31, 0.10)',
  error: '#b3413a',
  warning: '#b9812c',
  scrollbarTrack: '#f0efe9',
  scrollbarThumb: '#cfcabd',
} as const

const buildTheme = (mode: 'dark' | 'light', tokens: typeof DARK_FELT | typeof MODERN_LIGHT): Theme =>
  createTheme({
    palette: {
      mode,
      background: {
        default: tokens.background,
        paper: tokens.paper,
      },
      primary: {
        main: tokens.primary,
        contrastText: tokens.primaryContrast,
      },
      secondary: {
        main: tokens.secondary,
        contrastText: tokens.secondaryContrast,
      },
      error: {
        main: tokens.error,
      },
      warning: {
        main: tokens.warning,
      },
      text: {
        primary: tokens.textPrimary,
        secondary: tokens.textSecondary,
      },
      divider: tokens.divider,
    },
    shape: {
      borderRadius: 10,
    },
    typography: {
      fontSize: 13,
      button: {
        textTransform: 'none',
        fontWeight: 600,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: {
            colorScheme: mode,
          },
          body: {
            backgroundColor: tokens.background,
            // ハンド数・同期件数・スケール%などの数字が桁変化で左右にガタつかない
            // ように等幅数字を使う（ブランドに関わらず両テーマ共通の可読性改善）。
            fontVariantNumeric: 'tabular-nums',
            scrollbarColor: `${tokens.scrollbarThumb} ${tokens.scrollbarTrack}`,
          },
          '*::-webkit-scrollbar': {
            width: 8,
            height: 8,
          },
          '*::-webkit-scrollbar-track': {
            backgroundColor: tokens.scrollbarTrack,
          },
          '*::-webkit-scrollbar-thumb': {
            backgroundColor: tokens.scrollbarThumb,
            borderRadius: 8,
          },
        },
      },
      MuiPaper: {
        defaultProps: {
          elevation: 0,
        },
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: 8,
          },
        },
      },
    },
  })

const darkFeltTheme = buildTheme('dark', DARK_FELT)
const modernLightTheme = buildTheme('light', MODERN_LIGHT)

export const getPopupTheme = (variant: PopupThemeVariant): Theme =>
  variant === 'modern-light' ? modernLightTheme : darkFeltTheme
