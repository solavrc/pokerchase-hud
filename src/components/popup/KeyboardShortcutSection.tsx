import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useEffect, useRef, useState } from 'react'
import type { UIConfig } from '../../types/hand-log'
import { formatShortcut, shortcutFromKeyboardEvent } from '../../utils/keyboard-shortcut'
import { broadcastUIConfig } from './broadcast-ui-config'
import { SectionHeading } from './SectionHeading'

interface KeyboardShortcutSectionProps {
  uiConfig: UIConfig
  setUIConfig: (config: UIConfig) => void
}

export const KeyboardShortcutSection = ({
  uiConfig,
  setUIConfig,
}: KeyboardShortcutSectionProps) => {
  const [recording, setRecording] = useState(false)
  const [validationMessage, setValidationMessage] = useState('')
  const recordButtonRef = useRef<HTMLButtonElement>(null)

  const saveShortcut = (shortcut: UIConfig['toggleShortcut']) => {
    const nextConfig = { ...uiConfig, toggleShortcut: shortcut }
    setUIConfig(nextConfig)
    chrome.storage.sync.set({ uiConfig: nextConfig })
    broadcastUIConfig(nextConfig)
  }

  useEffect(() => {
    if (!recording) return

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(false)
        setValidationMessage('')
        recordButtonRef.current?.focus()
        return
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        saveShortcut(undefined)
        setRecording(false)
        setValidationMessage('')
        recordButtonRef.current?.focus()
        return
      }

      const shortcut = shortcutFromKeyboardEvent(event)
      if (!shortcut) {
        setValidationMessage('Ctrl・Alt・⌘のいずれかを含めてください（F1〜F12は単独可）')
        return
      }

      saveShortcut(shortcut)
      setRecording(false)
      setValidationMessage('')
      recordButtonRef.current?.focus()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, uiConfig])

  return (
    <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
      <SectionHeading>表示切り替えショートカット</SectionHeading>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Button
          ref={recordButtonRef}
          size="small"
          variant={recording ? 'contained' : 'outlined'}
          aria-pressed={recording}
          onClick={() => {
            setRecording(current => !current)
            setValidationMessage('')
          }}
        >
          {recording ? 'キーを入力…' : uiConfig.toggleShortcut ? formatShortcut(uiConfig.toggleShortcut) : '未設定'}
        </Button>
        {uiConfig.toggleShortcut && !recording && (
          <Button size="small" color="inherit" onClick={() => saveShortcut(undefined)}>
            解除
          </Button>
        )}
      </Box>
      <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: validationMessage ? 'error.main' : 'text.secondary' }}>
        {validationMessage || (recording
          ? '希望の組み合わせを押してください。Escで中止、Backspaceで解除'
          : 'ゲーム画面でHUDとハンドログをまとめて表示／非表示にします')}
      </Typography>
    </Box>
  )
}
