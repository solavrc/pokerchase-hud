/**
 * `popupTheme` persistence (`chrome.storage.sync`).
 *
 * Deliberately a *separate* top-level key from `uiConfig`, not a field on
 * it: `UIScaleSection`/`HudDisplaySection` write `uiConfig` through
 * `updateUIConfig()`, which -- after persisting -- broadcasts a
 * `chrome.tabs.sendMessage(..., { action: 'updateUIConfig', ... })` to
 * *every* open tab so the HUD content script re-renders with the new HUD
 * settings. The popup's own light/dark chrome has nothing to do with the
 * HUD overlay; nesting it inside `uiConfig` would fire that same
 * all-tabs broadcast (and an unnecessary HUD re-render) on every popup
 * theme change. A dedicated key keeps the write popup-local, matching
 * `options-storage.ts`'s pattern of one flat `chrome.storage.sync` key per
 * independent concern.
 *
 * The mode is *also* mirrored to `localStorage` (same-origin, synchronous,
 * readable before anything async resolves). `popup-boot.ts` uses it to paint
 * the correct background before `popup.js` parses, and `popup.ts` uses it as
 * the first-render hint so chrome.storage.sync never blocks popup content.
 * `chrome.storage.sync` stays the source of truth; `localStorage` is only a
 * best-effort startup cache.
 */
import type { PopupThemeMode } from './theme'
import { DEFAULT_POPUP_THEME_MODE } from './theme'

export const POPUP_THEME_STORAGE_KEY = 'popupTheme'

/**
 * Deliberately a different key name than `POPUP_THEME_STORAGE_KEY`, even
 * though the two storages (`chrome.storage.sync` vs. `localStorage`) can't
 * collide -- keeps it obvious at a glance which key belongs to which API.
 * Keep in sync with `POPUP_BOOT_LOCAL_STORAGE_KEY` in `popup-boot-theme.ts`
 * (that file is intentionally standalone and can't import this constant --
 * see its top comment).
 */
export const POPUP_THEME_LOCAL_STORAGE_KEY = 'popupThemeMode'

const isPopupThemeMode = (value: unknown): value is PopupThemeMode =>
  value === 'auto' || value === 'dark' || value === 'light'

/**
 * Returns the best theme hint available synchronously for the very first
 * React render. The mirror is written whenever the authoritative
 * `chrome.storage.sync` value is loaded or saved, so normal subsequent popup
 * opens use the right theme without putting an async storage call on the
 * click-to-content critical path.
 *
 * A missing/stale mirror is safe: callers render `auto` immediately and then
 * reconcile with `loadPopupThemeMode()` after mount. `localStorage` is only a
 * startup cache; `chrome.storage.sync` remains the source of truth.
 */
export const loadCachedPopupThemeMode = (): PopupThemeMode => {
  try {
    const value = window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)
    return isPopupThemeMode(value) ? value : DEFAULT_POPUP_THEME_MODE
  } catch {
    return DEFAULT_POPUP_THEME_MODE
  }
}

/**
 * Best-effort mirror to `localStorage` for `popup-boot.ts` to read
 * synchronously on the next popup open. Guarded: `localStorage` can throw
 * (disabled storage, locked-down context) and that must never break the
 * actual `chrome.storage.sync` persistence this mirrors.
 */
const mirrorPopupThemeModeToLocalStorage = (mode: PopupThemeMode): void => {
  try {
    window.localStorage.setItem(POPUP_THEME_LOCAL_STORAGE_KEY, mode)
  } catch {
    // localStorage unavailable/blocked -- popup-boot.ts just falls back to
    // its CSS defaults next time; never worse than before this fix.
  }
}

/**
 * Resolves with the persisted mode, or `DEFAULT_POPUP_THEME_MODE` ('auto')
 * if unset (fresh install) or malformed (defensive against corrupted sync
 * data / a future value this build doesn't know about). Also backfills the
 * `localStorage` mirror on every load -- covers the case where the mode was
 * never explicitly saved from *this* browser profile (e.g. it arrived via
 * `chrome.storage.sync` from another device) so the mirror still exists in
 * time for the boot script's next read.
 */
export const loadPopupThemeMode = (): Promise<PopupThemeMode> =>
  new Promise((resolve) => {
    chrome.storage.sync.get(POPUP_THEME_STORAGE_KEY, (result: Record<string, unknown>) => {
      const value = result[POPUP_THEME_STORAGE_KEY]
      const mode = isPopupThemeMode(value) ? value : DEFAULT_POPUP_THEME_MODE
      mirrorPopupThemeModeToLocalStorage(mode)
      resolve(mode)
    })
  })

export const savePopupThemeMode = (mode: PopupThemeMode): Promise<void> =>
  new Promise((resolve) => {
    mirrorPopupThemeModeToLocalStorage(mode)
    chrome.storage.sync.set({ [POPUP_THEME_STORAGE_KEY]: mode }, () => resolve())
  })
