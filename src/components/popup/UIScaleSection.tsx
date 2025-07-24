import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import type { UIConfig } from '../../types/hand-log'

interface UIScaleSectionProps {
  uiConfig: UIConfig
  setUIConfig: (config: UIConfig) => void
}

export const UIScaleSection = ({
  uiConfig,
  setUIConfig,
}: UIScaleSectionProps) => {
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

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2">サイズ:</Typography>
        <IconButton
          size="small"
          onClick={() => {
            const newScale = Math.max(0.5, uiConfig.scale - 0.1)
            updateUIConfig({ ...uiConfig, scale: newScale })
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
            updateUIConfig({ ...uiConfig, scale: newScale })
          }}
          disabled={uiConfig.scale >= 2.0}
        >
          +
        </IconButton>
      </Box>

      <ToggleButtonGroup
        value={uiConfig.displayEnabled ? 'on' : 'off'}
        exclusive
        onChange={(_event, newValue: string | null) => {
          if (newValue !== null) {
            updateUIConfig({ ...uiConfig, displayEnabled: newValue === 'on' })
          }
        }}
        size="small"
        sx={{
          '& .MuiToggleButton-root': {
            padding: '4px 12px',
            fontSize: '12px',
            fontWeight: 'bold',
            '&.Mui-selected': {
              '&[value="off"]': {
                backgroundColor: '#f44336',
                color: '#ffffff',
                '&:hover': {
                  backgroundColor: '#d32f2f',
                }
              },
              '&[value="on"]': {
                backgroundColor: '#4caf50',
                color: '#ffffff',
                '&:hover': {
                  backgroundColor: '#388e3c',
                }
              }
            }
          }
        }}
      >
        <ToggleButton value="off">
          非表示
        </ToggleButton>
        <ToggleButton value="on">
          表示
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  )
}