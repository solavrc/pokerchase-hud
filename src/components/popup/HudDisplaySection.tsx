import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import RadioGroup from '@mui/material/RadioGroup'
import Typography from '@mui/material/Typography'
import type { UIConfig } from '../../types/hand-log'

interface HudDisplaySectionProps {
  uiConfig: UIConfig
  setUIConfig: (config: UIConfig) => void
}

/**
 * HUD表示スタイル設定（#143）: 表示モード（コンパクト/フル）と統計カラー表示の
 * ON/OFF。UIScaleSection と同じ保存パス（setUIConfig → chrome.storage.sync →
 * 開いている全ゲームタブへ updateUIConfig メッセージ送信）に従う。
 */
export const HudDisplaySection = ({
  uiConfig,
  setUIConfig,
}: HudDisplaySectionProps) => {
  const updateUIConfig = (newConfig: UIConfig) => {
    setUIConfig(newConfig)
    chrome.storage.sync.set({ uiConfig: newConfig })
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'updateUIConfig',
            config: newConfig
          })
        }
      })
    })
  }

  // DEFAULT_UI_CONFIGとのマージ済みuiConfigが渡ってくる前提だが、念のため
  // フォールバックしておく（#143のデフォルト = compact + カラーON）。
  const hudDisplayMode = uiConfig.hudDisplayMode ?? 'compact'
  const hudColorCoding = uiConfig.hudColorCoding ?? true

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ mb: 0.5 }}>表示モード:</Typography>
      <RadioGroup
        row
        aria-label="HUD表示モード"
        value={hudDisplayMode}
        onChange={(_event, newValue) => {
          updateUIConfig({ ...uiConfig, hudDisplayMode: newValue as 'full' | 'compact' })
        }}
      >
        <FormControlLabel value="compact" control={<Radio size="small" />} label="コンパクト" />
        <FormControlLabel value="full" control={<Radio size="small" />} label="フル" />
      </RadioGroup>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={hudColorCoding}
            onChange={(event) => {
              updateUIConfig({ ...uiConfig, hudColorCoding: event.target.checked })
            }}
          />
        }
        label="統計カラー表示"
      />
    </Box>
  )
}
