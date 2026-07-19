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
 */
import type { PopupThemeMode } from './theme'
import { DEFAULT_POPUP_THEME_MODE } from './theme'

export const POPUP_THEME_STORAGE_KEY = 'popupTheme'

const isPopupThemeMode = (value: unknown): value is PopupThemeMode =>
  value === 'auto' || value === 'dark' || value === 'light'

/**
 * Resolves with the persisted mode, or `DEFAULT_POPUP_THEME_MODE` ('auto')
 * if unset (fresh install) or malformed (defensive against corrupted sync
 * data / a future value this build doesn't know about).
 */
export const loadPopupThemeMode = (): Promise<PopupThemeMode> =>
  new Promise((resolve) => {
    chrome.storage.sync.get(POPUP_THEME_STORAGE_KEY, (result: Record<string, unknown>) => {
      const value = result[POPUP_THEME_STORAGE_KEY]
      resolve(isPopupThemeMode(value) ? value : DEFAULT_POPUP_THEME_MODE)
    })
  })

export const savePopupThemeMode = (mode: PopupThemeMode): Promise<void> =>
  new Promise((resolve) => {
    chrome.storage.sync.set({ [POPUP_THEME_STORAGE_KEY]: mode }, () => resolve())
  })
