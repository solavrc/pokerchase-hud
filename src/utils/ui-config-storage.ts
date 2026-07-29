import {
  DEFAULT_UI_CONFIG,
  type UIConfig,
} from '../types/hand-log'
import type {
  DeviceUILayoutResponse,
  HudPosition,
} from '../types/messages'

export const UI_SCALE_STORAGE_KEY = 'uiScale'
export const REAL_TIME_HUD_POSITION_OFFSET = 100
export const hudPositionStorageKey = (seatIndex: number): string =>
  `hudPosition_${seatIndex}`

type SyncedUIConfig = Omit<UIConfig, 'scale'>

export const isValidUIScale = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0.5 &&
  value <= 2

export const resolveLocalUIScale = (value: unknown): number =>
  isValidUIScale(value) ? value : DEFAULT_UI_CONFIG.scale

export const isValidHudPositionId = (value: unknown): value is number => {
  if (!Number.isInteger(value)) return false
  const positionId = Number(value)
  return (
    (positionId >= 0 && positionId < 6) ||
    (
      positionId >= REAL_TIME_HUD_POSITION_OFFSET &&
      positionId < REAL_TIME_HUD_POSITION_OFFSET + 6
    )
  )
}

const isValidPercentPosition = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?%$/.test(value)) return false
  const percent = Number.parseFloat(value)
  return Number.isFinite(percent) && percent >= 0 && percent <= 90
}

export const isValidHudPosition = (value: unknown): value is HudPosition => {
  if (typeof value !== 'object' || value === null) return false
  const position = value as Partial<HudPosition>
  return isValidPercentPosition(position.top) && isValidPercentPosition(position.left)
}

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

const consumeRuntimeError = (): void => {
  // Reading lastError inside the callback prevents Chrome from reporting an
  // unchecked error when the service worker is temporarily unavailable.
  void chrome.runtime.lastError
}

export const loadLocalUIScale = (callback: (scale: number) => void): void => {
  chrome.runtime.sendMessage(
    { action: 'getDeviceUILayout' },
    (response: DeviceUILayoutResponse | undefined) => {
      consumeRuntimeError()
      callback(resolveLocalUIScale(response?.scale))
    }
  )
}

export const saveLocalUIScale = (
  scale: number,
  callback?: () => void
): void => {
  chrome.runtime.sendMessage(
    { action: 'setDeviceUIScale', scale: resolveLocalUIScale(scale) },
    () => {
      consumeRuntimeError()
      callback?.()
    }
  )
}

export const loadHudPosition = (
  seatIndex: number,
  callback: (position: HudPosition | undefined) => void
): void => {
  chrome.runtime.sendMessage(
    { action: 'getDeviceUILayout', seatIndex },
    (response: DeviceUILayoutResponse | undefined) => {
      consumeRuntimeError()
      callback(isValidHudPosition(response?.position) ? response.position : undefined)
    }
  )
}

export const saveHudPosition = (
  seatIndex: number,
  position: HudPosition
): void => {
  chrome.runtime.sendMessage(
    { action: 'setDeviceHudPosition', seatIndex, position },
    consumeRuntimeError
  )
}
