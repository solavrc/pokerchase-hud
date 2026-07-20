/**
 * Synchronous, non-module boot script -- loaded in `index.html`'s `<head>`
 * BEFORE `popup.js` (see that file's script order) to eliminate the
 * white-flash-before-first-paint bug: `popup.js` is a minified MUI+React
 * bundle, and parsing/executing it before the first `render()` takes long
 * enough that the popup window's unstyled default white background can be
 * visible while it initializes (see `fix/popup-white-flash`).
 *
 * `index.html`'s inline CSS already paints the right ground color for
 * `auto` mode via `prefers-color-scheme`. This script exists only for the
 * remaining gap: a user who explicitly forced 'dark' or 'light' while their
 * OS scheme disagrees would otherwise still get one frame of the *other*
 * theme's color (never white, but still wrong) before `popup.js` mounts
 * React and applies the real MUI theme. It reads the mode mirrored to
 * `localStorage` by `savePopupThemeMode` (see `popup-theme-storage.ts`) and,
 * if set, overrides `documentElement`'s background immediately.
 *
 * Must stay tiny and side-effect-only: no MUI, no React, no chrome.* APIs.
 * See `popup-boot-theme.ts` for why its constants are duplicated rather than
 * imported from `theme.ts` / `popup-theme-storage.ts`.
 */
import { POPUP_BOOT_LOCAL_STORAGE_KEY, resolveBootBackgroundColor } from './components/popup/popup-boot-theme'

try {
  const storedMode = window.localStorage.getItem(POPUP_BOOT_LOCAL_STORAGE_KEY)
  const prefersDarkScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.style.backgroundColor = resolveBootBackgroundColor(storedMode, prefersDarkScheme)
} catch {
  // localStorage / matchMedia unavailable or throwing (locked-down context,
  // very old browser, etc.) -- leave index.html's CSS defaults
  // (the `prefers-color-scheme` media query) in place. Never worse than
  // before this fix.
}
