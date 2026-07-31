import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_UI_CONFIG, type UIConfig } from '../../types/hand-log'
import { formatShortcut, shortcutFromKeyboardEvent } from '../../utils/keyboard-shortcut'
import {
  saveLocalUIScale,
  resetUILayout,
  saveSyncedUIConfig,
  saveSyncedUIConfigPatch,
} from '../../utils/ui-config-storage'
import { broadcastUIConfig } from './broadcast-ui-config'

interface UIScaleSectionProps {
  uiConfig: UIConfig
  setUIConfig: (config: UIConfig) => void
  scaleControlsDisabled?: boolean
  /**
   * 右カラム3行目に積むHUD表示モード（コンパクト/フル）。
   * 別コンポーネント（HudDisplaySection）のままにしつつ、2カラムの桁揃えは
   * 1つのgridで完結させるためのスロット。各セクションが独自にレイアウトすると
   * 右端が揃わない。
   */
  children?: ReactNode
}

/**
 * ポップアップ最上部の設定ブロック。左カラムに操作（配置リセット / 表示切り替え
 * ショートカット）、右カラムに状態（倍率 / 表示・非表示 / 表示モード）を置く
 * 2カラム構成（sola指定のレイアウト）。
 *
 * 指標選択より上はHUDの本質ではないので、見出しラベル（「表示モード:」等）を
 * 足さず1つのgridに畳んで縦の専有量を抑える。
 */
export const UIScaleSection = ({
  uiConfig,
  setUIConfig,
  scaleControlsDisabled = false,
  children,
}: UIScaleSectionProps) => {
  const [recordingShortcut, setRecordingShortcut] = useState(false)
  const [shortcutError, setShortcutError] = useState(false)
  const shortcutInputRef = useRef<HTMLInputElement>(null)
  const latestUIConfigRef = useRef(uiConfig)
  const pendingScaleRef = useRef(uiConfig.scale)
  const latestAppliedScaleRef = useRef(uiConfig.scale)
  const pendingScaleWriteCountRef = useRef(0)
  const nextScaleRequestIdRef = useRef(0)
  const latestAppliedScaleRequestIdRef = useRef(0)
  latestUIConfigRef.current = uiConfig
  if (pendingScaleWriteCountRef.current === 0) {
    pendingScaleRef.current = uiConfig.scale
    latestAppliedScaleRef.current = uiConfig.scale
  }
  const shortcutLabel = uiConfig.toggleShortcut
    ? formatShortcut(uiConfig.toggleShortcut)
    : null

  const updateSyncedUIConfig = (newConfig: UIConfig) => {
    setUIConfig(newConfig)
    saveSyncedUIConfig(newConfig)
    broadcastUIConfig(newConfig)
  }

  const updateLocalScale = (scale: number) => {
    const requestId = ++nextScaleRequestIdRef.current
    let callbackReceived = false
    pendingScaleWriteCountRef.current += 1
    pendingScaleRef.current = scale
    saveLocalUIScale(scale, status => {
      if (status === 'timeout') {
        // The background write is still live and can finish later. Keep this
        // requested value as the base for another click while it is unsettled.
        return
      }
      if (!callbackReceived) {
        callbackReceived = true
        pendingScaleWriteCountRef.current -= 1
      }
      if (status === 'failure') {
        if (pendingScaleWriteCountRef.current === 0) {
          pendingScaleRef.current = latestAppliedScaleRef.current
        }
        return
      }
      if (requestId < latestAppliedScaleRequestIdRef.current) return
      latestAppliedScaleRequestIdRef.current = requestId
      latestAppliedScaleRef.current = scale
      // The write can succeed after the timeout. Reconcile only its scale
      // onto the latest synchronized settings instead of replaying the
      // full config captured when the button was clicked.
      const reconciledConfig = {
        ...latestUIConfigRef.current,
        scale,
      }
      if (pendingScaleWriteCountRef.current === 0) {
        pendingScaleRef.current = scale
      }
      setUIConfig(reconciledConfig)
      // The trusted background broadcasts this saved scale to game tabs.
      // Keeping delivery there lets it finish even if the action popup closes
      // immediately after dispatching the write.
    })
  }

  const requestScaleChange = (delta: number) => {
    const scale = Math.min(
      2,
      Math.max(0.5, Math.round((pendingScaleRef.current + delta) * 10) / 10)
    )
    updateLocalScale(scale)
  }

  const saveShortcut = useCallback((shortcut: UIConfig['toggleShortcut']) => {
    // Popup subscribes to synchronized changes while open, so its state is the
    // latest available full config. Queue persistence immediately before the
    // action-popup context can be destroyed.
    const nextConfig = {
      ...DEFAULT_UI_CONFIG,
      ...uiConfig,
      toggleShortcut: shortcut,
    }
    setUIConfig(nextConfig)
    // Persist only the edited field against the background's latest sync
    // snapshot. The resulting storage event updates open game tabs without
    // broadcasting this popup's potentially stale full config.
    saveSyncedUIConfigPatch({ toggleShortcut: shortcut })
  }, [setUIConfig, uiConfig])

  const handleShortcutKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Keep standard keyboard focus traversal. Shift+Tab must not become a
    // shortcut merely because Shift satisfies the modifier requirement.
    if (event.key === 'Tab') {
      setRecordingShortcut(false)
      setShortcutError(false)
      return
    }

    event.preventDefault()
    event.stopPropagation()

    if (event.key === 'Escape') {
      setRecordingShortcut(false)
      setShortcutError(false)
      shortcutInputRef.current?.blur()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      saveShortcut(null)
      setRecordingShortcut(false)
      setShortcutError(false)
      shortcutInputRef.current?.blur()
      return
    }

    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
    if (!shortcut) {
      setShortcutError(true)
      return
    }

    saveShortcut(shortcut)
    setRecordingShortcut(false)
    setShortcutError(false)
    shortcutInputRef.current?.blur()
  }

  return (
    <Box
      sx={{
        display: 'grid',
        // 左は内容の実寸、右は内容ぴったり。右カラムを max-content にすることで
        // 倍率・表示切替・表示モードの右端が揃う。
        gridTemplateColumns: 'auto max-content',
        columnGap: 1,
        rowGap: 0.75,
        alignItems: 'center',
      }}
    >
      <Button
        size="small"
        variant="text"
        title="HUDパネルとハンドログの位置・サイズ・倍率を既定へ戻す"
        onClick={() => {
          // Persistence and live-tab delivery both run in the background so
          // closing the action popup cannot interrupt the reset.
          resetUILayout(() => {
            // 倍率はbackgroundがstorageから消し、ゲームタブへは
            // updateDeviceUIScaleで配信される。ポップアップ自身は購読して
            // いないので、成功応答を受けてここで既定へ戻す。
            // 進行中のscale書き込みがあれば、その基準もここへ寄せる。
            latestAppliedScaleRequestIdRef.current = ++nextScaleRequestIdRef.current
            latestAppliedScaleRef.current = DEFAULT_UI_CONFIG.scale
            pendingScaleRef.current = DEFAULT_UI_CONFIG.scale
            setUIConfig({
              ...latestUIConfigRef.current,
              scale: DEFAULT_UI_CONFIG.scale,
            })
          })
        }}
        sx={{
          justifySelf: 'start',
          px: 0.5,
          minWidth: 0,
          fontSize: '11px',
          textTransform: 'none',
        }}
      >
        位置とサイズをリセット
      </Button>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>サイズ:</Typography>
        <IconButton
          size="small"
          onClick={() => requestScaleChange(-0.1)}
          disabled={scaleControlsDisabled || uiConfig.scale <= 0.5}
        >
          -
        </IconButton>
        <Typography variant="body2" sx={{ minWidth: 35, textAlign: 'center' }}>
          {Math.round(uiConfig.scale * 100)}%
        </Typography>
        <IconButton
          size="small"
          onClick={() => requestScaleChange(0.1)}
          disabled={scaleControlsDisabled || uiConfig.scale >= 2.0}
        >
          +
        </IconButton>
      </Box>

      <TextField
        inputRef={shortcutInputRef}
        size="small"
        value={recordingShortcut
          ? 'キーを入力…'
          : shortcutLabel ?? '未設定'}
        error={shortcutError}
        onFocus={() => {
          setRecordingShortcut(true)
          setShortcutError(false)
        }}
        onBlur={() => {
          setRecordingShortcut(false)
          setShortcutError(false)
        }}
        onKeyDown={handleShortcutKeyDown}
        onContextMenu={(event) => {
          event.preventDefault()
          saveShortcut(null)
          setRecordingShortcut(false)
          setShortcutError(false)
          shortcutInputRef.current?.blur()
        }}
        slotProps={{
          htmlInput: {
            readOnly: true,
            'aria-label': 'HUD表示切り替えショートカット',
            title: shortcutError
              ? '利用できません（Shiftと文字キーを同時に押してください）'
              : shortcutLabel
                ? `${shortcutLabel}（クリックして変更・右クリックで解除）`
                : 'クリックして入力・右クリックで解除',
          },
        }}
        sx={{
          width: 105,
          justifySelf: 'end',
          '& .MuiInputBase-input': {
            px: 0.75,
            py: 0.625,
            fontSize: '11px',
            textAlign: 'center',
            cursor: 'pointer',
          },
        }}
      />

      <ToggleButtonGroup
        value={uiConfig.displayEnabled ? 'on' : 'off'}
        exclusive
        onChange={(_event, newValue: string | null) => {
          if (newValue !== null) {
            updateSyncedUIConfig({ ...uiConfig, displayEnabled: newValue === 'on' })
          }
        }}
        size="small"
        sx={(theme) => ({
          '& .MuiToggleButton-root': {
            padding: '4px 12px',
            fontSize: '12px',
            fontWeight: 'bold',
            textTransform: 'none',
            '&.Mui-selected': {
              '&[value="off"]': {
                backgroundColor: theme.palette.error.main,
                color: theme.palette.getContrastText(theme.palette.error.main),
                '&:hover': {
                  backgroundColor: theme.palette.error.dark,
                }
              },
              '&[value="on"]': {
                backgroundColor: theme.palette.secondary.main,
                color: theme.palette.getContrastText(theme.palette.secondary.main),
                '&:hover': {
                  backgroundColor: theme.palette.secondary.dark,
                }
              }
            }
          }
        })}
      >
        <ToggleButton value="off">
          非表示
        </ToggleButton>
        <ToggleButton value="on">
          表示
        </ToggleButton>
      </ToggleButtonGroup>

      {/* 3行目は右カラムだけ。左は空セルで桁を保つ。 */}
      {children !== undefined && (
        <>
          <Box />
          {children}
        </>
      )}
    </Box>
  )
}
