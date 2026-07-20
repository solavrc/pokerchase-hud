/**
 * Pure, dependency-free logic for `popup-boot.ts` (the synchronous,
 * non-module boot script loaded in `index.html`'s `<head>` *before*
 * `popup.js`, to paint the popup's correct background before the
 * MUI+React bundle has even parsed -- see `popup-boot.ts` for the full
 * white-flash rationale, and `fix/popup-white-flash`).
 *
 * Deliberately standalone: does NOT import `theme.ts` or
 * `popup-theme-storage.ts`. `theme.ts` builds both full MUI themes
 * (`createTheme()`) at module-scope import time, and
 * `popup-theme-storage.ts` transitively imports `theme.ts` -- either would
 * make importing this module pull in the same slow MUI/React work the boot
 * script exists to run *before*, defeating the whole point of it being tiny
 * and synchronous. The two hex values and the localStorage key name are
 * therefore intentionally duplicated (in miniature) from theme.ts's
 * `DARK_FELT.background` / `MODERN_LIGHT.background` and from
 * `popup-theme-storage.ts`'s `POPUP_THEME_LOCAL_STORAGE_KEY`.
 * `popup-boot-theme.test.ts` cross-checks both against their sources of
 * truth so drift fails a test instead of silently reintroducing the flash.
 */

/** Keep in sync with `POPUP_THEME_LOCAL_STORAGE_KEY` in `popup-theme-storage.ts`. */
export const POPUP_BOOT_LOCAL_STORAGE_KEY = 'popupThemeMode'

/** Keep in sync with `DARK_FELT.background` in `theme.ts`. */
export const DARK_FELT_BACKGROUND = '#0d1512'
/** Keep in sync with `MODERN_LIGHT.background` in `theme.ts`. */
export const MODERN_LIGHT_BACKGROUND = '#faf9f6'

/**
 * Mirrors `resolvePopupThemeVariant` in `theme.ts` (persisted mode + live OS
 * signal -> which side), collapsed straight to the ground color since
 * that's all the boot script needs (it never touches MUI theme objects).
 */
export const resolveBootBackgroundColor = (
  storedMode: string | null,
  prefersDarkScheme: boolean,
): string => {
  if (storedMode === 'dark') return DARK_FELT_BACKGROUND
  if (storedMode === 'light') return MODERN_LIGHT_BACKGROUND
  return prefersDarkScheme ? DARK_FELT_BACKGROUND : MODERN_LIGHT_BACKGROUND
}
