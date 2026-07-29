import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { useCallback, useRef, useState } from 'react'
import { DEFAULT_UI_CONFIG, type UIConfig } from '../../types/hand-log'
import { formatShortcut, shortcutFromKeyboardEvent } from '../../utils/keyboard-shortcut'
import {
  saveLocalUIScale,
  saveSyncedUIConfig,
} from '../../utils/ui-config-storage'
import { broadcastUIConfig } from './broadcast-ui-config'

interface UIScaleSectionProps {
  uiConfig: UIConfig
  setUIConfig: (config: UIConfig) => void
}

export const UIScaleSection = ({
  uiConfig,
  setUIConfig,
}: UIScaleSectionProps) => {
  const [recordingShortcut, setRecordingShortcut] = useState(false)
  const [shortcutError, setShortcutError] = useState(false)
  const shortcutInputRef = useRef<HTMLInputElement>(null)
  const shortcutLabel = uiConfig.toggleShortcut
    ? formatShortcut(uiConfig.toggleShortcut)
    : null

  const updateSyncedUIConfig = (newConfig: UIConfig) => {
    setUIConfig(newConfig)
    saveSyncedUIConfig(newConfig)
    broadcastUIConfig(newConfig)
  }

  const updateLocalScale = (newConfig: UIConfig) => {
    saveLocalUIScale(newConfig.scale, success => {
      if (!success) return
      setUIConfig(newConfig)
      broadcastUIConfig(newConfig)
    })
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
    saveSyncedUIConfig(nextConfig)
    broadcastUIConfig(nextConfig)
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
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', rowGap: 1 }}>
      <Box sx={{ display: 'flex', width: '100%', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>サイズ:</Typography>
        <IconButton
          size="small"
          onClick={() => {
            const newScale = Math.max(0.5, uiConfig.scale - 0.1)
            updateLocalScale({ ...uiConfig, scale: newScale })
          }}
          disabled={uiConfig.scale <= 0.5}
        >
          -
        </IconButton>
        <Typography variant="body2" sx={{ minWidth: 35, textAlign: 'center' }}>
          {Math.round(uiConfig.scale * 100)}%
        </Typography>
        <IconButton
          size="small"
          onClick={() => {
            const newScale = Math.min(2.0, uiConfig.scale + 0.1)
            updateLocalScale({ ...uiConfig, scale: newScale })
          }}
          disabled={uiConfig.scale >= 2.0}
        >
          +
        </IconButton>
      </Box>

      <Box sx={{ display: 'flex', width: '100%', justifyContent: 'flex-end', alignItems: 'center', gap: 0.75 }}>
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
      </Box>
    </Box>
  )
}
