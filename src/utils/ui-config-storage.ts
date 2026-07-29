import {
  DEFAULT_UI_CONFIG,
  type UIConfig,
} from '../types/hand-log'

export const UI_SCALE_STORAGE_KEY = 'uiScale'

type SyncedUIConfig = Omit<UIConfig, 'scale'>

const isValidUIScale = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0.5 &&
  value <= 2

export const resolveLocalUIScale = (value: unknown): number =>
  isValidUIScale(value) ? value : DEFAULT_UI_CONFIG.scale

export const mergeUIConfigWithLocalScale = (
  syncedConfig: Partial<UIConfig> | undefined,
  localScale: unknown
): UIConfig => ({
  ...DEFAULT_UI_CONFIG,
  ...syncedConfig,
  // Scale is deliberately device-local. Ignore a legacy scale field that may
  // still exist inside the synchronized uiConfig object.
  scale: resolveLocalUIScale(localScale),
})

export const toSyncedUIConfig = (config: UIConfig): SyncedUIConfig => {
  const { scale: _localScale, ...syncedConfig } = config
  return syncedConfig
}

export const saveSyncedUIConfig = (config: UIConfig): void => {
  chrome.storage.sync.set({ uiConfig: toSyncedUIConfig(config) })
}

export const saveLocalUIScale = (
  scale: number,
  callback?: () => void
): void => {
  const value = { [UI_SCALE_STORAGE_KEY]: resolveLocalUIScale(scale) }
  if (callback) {
    chrome.storage.local.set(value, callback)
  } else {
    chrome.storage.local.set(value)
  }
}
