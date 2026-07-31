import {
  DEFAULT_UI_CONFIG,
  type HandLogLayout,
  type UIConfig,
} from '../types/hand-log'
import type {
  ChromeMessage,
  DeviceHandLogLayoutResponse,
  DeviceUILayoutResponse,
  HudPosition,
} from '../types/messages'

export const UI_SCALE_STORAGE_KEY = 'uiScale'
export const LEGACY_SYNC_UI_SCALE_KEY = 'legacyUIScale'
export const REAL_TIME_HUD_POSITION_OFFSET = 100
export const DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS = 1_000
export const HAND_LOG_LAYOUT_STORAGE_KEY = 'handLogLayout'
export const HAND_LOG_MIN_WIDTH = 200
export const HAND_LOG_MIN_HEIGHT = 80
export const hudPositionStorageKey = (seatIndex: number): string =>
  `hudPosition_${seatIndex}`

/** 通常HUD(0-5)とリアルタイムHUD(100-105)の全席。`isValidHudPositionId`と同じ範囲。 */
export const HUD_POSITION_IDS: readonly number[] = [
  ...Array.from({ length: 6 }, (_, seatIndex) => seatIndex),
  ...Array.from(
    { length: 6 },
    (_, seatIndex) => REAL_TIME_HUD_POSITION_OFFSET + seatIndex
  ),
]

/**
 * 消すキーは前方一致で走査せず、有効な席IDから組み立てる。
 * `storage.local`にはサービス状態など無関係のキーも同居しており、
 * `get(null)`で全件読んで前方一致で消す実装は、将来別用途の
 * `hudPosition_`付きキーが増えたときに巻き込む。
 */
export const HUD_POSITION_STORAGE_KEYS: readonly string[] =
  HUD_POSITION_IDS.map(hudPositionStorageKey)

type SyncedUIConfig = Omit<UIConfig, 'scale'>
type PendingSyncedUIConfigWrite = {
  callback?: (success: boolean) => void
} & (
  | { config: UIConfig, patch?: never }
  | { config?: never, patch: Pick<UIConfig, 'toggleShortcut'> }
)
const pendingSyncedUIConfigWrites: PendingSyncedUIConfigWrite[] = []
let syncedUIConfigWriteInProgress = false

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

export const isValidHandLogLayout = (value: unknown): value is HandLogLayout => {
  if (typeof value !== 'object' || value === null) return false
  const layout = value as Partial<HandLogLayout>
  return (
    typeof layout.left === 'number' &&
    Number.isFinite(layout.left) &&
    typeof layout.top === 'number' &&
    Number.isFinite(layout.top) &&
    typeof layout.width === 'number' &&
    Number.isFinite(layout.width) &&
    layout.width >= HAND_LOG_MIN_WIDTH &&
    typeof layout.height === 'number' &&
    Number.isFinite(layout.height) &&
    layout.height >= HAND_LOG_MIN_HEIGHT
  )
}

export const mergeUIConfigWithLocalScale = (
  syncedConfig: Partial<UIConfig> | undefined,
  localScale: unknown
): UIConfig => ({
  ...DEFAULT_UI_CONFIG,
  ...syncedConfig,
  // Prefer the device-local value, but preserve the synchronized scale from
  // pre-migration installs until the background has copied it locally.
  scale: resolveLocalUIScale(
    isValidUIScale(localScale) ? localScale : syncedConfig?.scale
  ),
})

export const toSyncedUIConfig = (config: UIConfig): SyncedUIConfig => {
  const { scale: _localScale, ...syncedConfig } = config
  return syncedConfig
}

const processNextSyncedUIConfigWrite = (): void => {
  if (syncedUIConfigWriteInProgress) return
  const pendingWrite = pendingSyncedUIConfigWrites.shift()
  if (!pendingWrite) return

  syncedUIConfigWriteInProgress = true
  const finish = (success: boolean): void => {
    syncedUIConfigWriteInProgress = false
    pendingWrite.callback?.(success)
    processNextSyncedUIConfigWrite()
  }
  chrome.storage.sync.get(
    ['uiConfig', LEGACY_SYNC_UI_SCALE_KEY],
    (result: Record<string, unknown>) => {
      const readError = chrome.runtime.lastError
      if (readError) {
        finish(false)
        return
      }

      const currentConfig = result.uiConfig as Partial<UIConfig> | undefined
      const syncedConfig = pendingWrite.patch
        ? {
            ...toSyncedUIConfig({
              ...DEFAULT_UI_CONFIG,
              ...currentConfig,
              scale: DEFAULT_UI_CONFIG.scale,
            }),
            ...pendingWrite.patch,
          }
        : toSyncedUIConfig(pendingWrite.config)
      const liveLegacyScale = currentConfig?.scale
      const preservedLegacyScale = result[LEGACY_SYNC_UI_SCALE_KEY]
      const compatibilityScale = isValidUIScale(liveLegacyScale)
        ? liveLegacyScale
        : isValidUIScale(preservedLegacyScale)
          ? preservedLegacyScale
          : undefined
      chrome.storage.sync.set({
        // New versions ignore this compatibility field in favor of local
        // storage. Keep it while mixed-version devices may still read it.
        uiConfig: {
          ...syncedConfig,
          ...(compatibilityScale !== undefined
            ? { scale: compatibilityScale }
            : {}),
        },
        ...(compatibilityScale !== undefined
          ? { [LEGACY_SYNC_UI_SCALE_KEY]: compatibilityScale }
          : {}),
      }, () => {
        finish(!chrome.runtime.lastError)
      })
    }
  )
}

export const persistSyncedUIConfig = (
  config: UIConfig,
  callback?: (success: boolean) => void
): void => {
  pendingSyncedUIConfigWrites.push({ config, callback })
  processNextSyncedUIConfigWrite()
}

export const persistSyncedUIConfigPatch = (
  patch: Pick<UIConfig, 'toggleShortcut'>,
  callback?: (success: boolean) => void
): void => {
  pendingSyncedUIConfigWrites.push({ patch, callback })
  processNextSyncedUIConfigWrite()
}

export const saveSyncedUIConfig = (config: UIConfig): void => {
  try {
    chrome.runtime.sendMessage(
      { action: 'setSyncedUIConfig', config },
      consumeRuntimeError
    )
  } catch {
    // The UI already broadcasts optimistically. A future storage event or
    // reload will reconcile if the persistent background cannot be reached.
  }
}

export const saveSyncedUIConfigPatch = (
  patch: Pick<UIConfig, 'toggleShortcut'>
): void => {
  try {
    chrome.runtime.sendMessage(
      { action: 'setSyncedUIConfig', patch },
      consumeRuntimeError
    )
  } catch {
    // The background write may be unavailable while the popup is closing.
  }
}

const consumeRuntimeError = (): void => {
  // Reading lastError inside the callback prevents Chrome from reporting an
  // unchecked error when the service worker is temporarily unavailable.
  void chrome.runtime.lastError
}

const sendDeviceLayoutReadMessage = <TResponse,>(
  message: ChromeMessage,
  callback: (response: TResponse | undefined) => void
): void => {
  let completed = false
  const timeoutId = setTimeout(
    () => {
      if (!completed) callback(undefined)
    },
    DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS
  )

  try {
    chrome.runtime.sendMessage(message, (response: TResponse | undefined) => {
      consumeRuntimeError()
      if (completed) return
      completed = true
      clearTimeout(timeoutId)
      // A timeout may already have unblocked rendering. Reconcile once more
      // when the authoritative background response eventually arrives.
      callback(response)
    })
  } catch {
    completed = true
    clearTimeout(timeoutId)
    callback(undefined)
  }
}

export type DeviceLayoutWriteStatus = 'success' | 'failure' | 'timeout'

const sendDeviceLayoutWriteMessage = (
  message: ChromeMessage,
  callback: (status: DeviceLayoutWriteStatus) => void
): void => {
  let responseReceived = false
  const timeoutId = setTimeout(() => {
    if (!responseReceived) callback('timeout')
  }, DEVICE_LAYOUT_MESSAGE_TIMEOUT_MS)
  const finish = (status: Exclude<DeviceLayoutWriteStatus, 'timeout'>) => {
    if (responseReceived) return
    responseReceived = true
    clearTimeout(timeoutId)
    // A timeout cannot cancel the background write. Always publish the later
    // authoritative result so callers can distinguish an unsettled request
    // from a definitive storage failure.
    callback(status)
  }

  try {
    chrome.runtime.sendMessage(message, (response: { success?: boolean } | undefined) => {
      const runtimeError = chrome.runtime.lastError
      finish(!runtimeError && response?.success === true ? 'success' : 'failure')
    })
  } catch {
    clearTimeout(timeoutId)
    if (!responseReceived) {
      responseReceived = true
      callback('failure')
    }
  }
}

export const loadLocalUIScale = (
  callback: (scale: number, authoritative: boolean) => void
): void => {
  sendDeviceLayoutReadMessage<DeviceUILayoutResponse>(
    { action: 'getDeviceUILayout' },
    (response: DeviceUILayoutResponse | undefined) => {
      const authoritative =
        response?.success === true && isValidUIScale(response.scale)
      callback(resolveLocalUIScale(response?.scale), authoritative)
    }
  )
}

export const saveLocalUIScale = (
  scale: number,
  callback?: (status: DeviceLayoutWriteStatus) => void
): void => {
  sendDeviceLayoutWriteMessage(
    { action: 'setDeviceUIScale', scale: resolveLocalUIScale(scale) },
    status => {
      callback?.(status)
    }
  )
}

export const loadHudPosition = (
  seatIndex: number,
  callback: (position: HudPosition | undefined) => void
): void => {
  sendDeviceLayoutReadMessage<DeviceUILayoutResponse>(
    { action: 'getDeviceUILayout', seatIndex },
    (response: DeviceUILayoutResponse | undefined) => {
      callback(isValidHudPosition(response?.position) ? response.position : undefined)
    }
  )
}

export const saveHudPosition = (
  seatIndex: number,
  position: HudPosition
): void => {
  let warned = false
  sendDeviceLayoutWriteMessage(
    { action: 'setDeviceHudPosition', seatIndex, position },
    status => {
      if (status !== 'success' && !warned) {
        warned = true
        console.warn('[HUD layout] Failed to save device-local position')
      }
    }
  )
}

export const loadHandLogLayout = (
  callback: (layout: HandLogLayout | undefined) => void
): void => {
  sendDeviceLayoutReadMessage<DeviceHandLogLayoutResponse>(
    { action: 'getDeviceHandLogLayout' },
    (response: DeviceHandLogLayoutResponse | undefined) => {
      callback(isValidHandLogLayout(response?.layout) ? response.layout : undefined)
    }
  )
}

export const saveHandLogLayout = (layout: HandLogLayout): void => {
  sendDeviceLayoutWriteMessage(
    { action: 'setDeviceHandLogLayout', layout },
    (_status) => {}
  )
}

/**
 * HUDパネル位置とハンドログのレイアウトをまとめて既定へ戻す。
 * 永続化も開いているタブへの配信もバックグラウンドが行うので、
 * 呼び出し直後にポップアップが閉じてもリセットは中断されない。
 */
export const resetUILayout = (callback?: () => void): void => {
  sendDeviceLayoutWriteMessage(
    { action: 'resetDeviceUILayout' },
    status => {
      if (status === 'success') callback?.()
    }
  )
}
