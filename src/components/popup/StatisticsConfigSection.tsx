import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemSecondaryAction from '@mui/material/ListItemSecondaryAction'
import ListItemText from '@mui/material/ListItemText'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { defaultRegistry } from '../../stats'
import type { StatDisplayConfig } from '../../types/filters'

interface StatisticsConfigSectionProps {
  pendingStatDisplayConfigs: StatDisplayConfig[]
  hasUnsavedStatChanges: boolean
  handleStatToggle: (statId: string) => (event: React.ChangeEvent<HTMLInputElement>) => void
  handleStatOrderChange: (statId: string, direction: 'up' | 'down') => void
  handleApplyStatChanges: () => void
  handleResetStatChanges: () => void
}

export const StatisticsConfigSection = ({
  pendingStatDisplayConfigs,
  hasUnsavedStatChanges,
  handleStatToggle,
  handleStatOrderChange,
  handleApplyStatChanges,
  handleResetStatChanges,
}: StatisticsConfigSectionProps) => {
  return (
    <>
      <Typography variant="h6">
        HUD表示設定
        {hasUnsavedStatChanges && (
          <Typography component="span" variant="body2" color="orange" style={{ marginLeft: 8 }}>
            (未適用の変更があります)
          </Typography>
        )}
      </Typography>
      <List dense style={{ maxHeight: 200, overflow: 'auto' }}>
        {pendingStatDisplayConfigs
          .filter(config => config.id !== 'playerName') // playerNameはヘッダーに常に表示されるため除外
          .sort((a, b) => a.order - b.order)
          .map((config, index) => {
            const statDef = defaultRegistry.get(config.id)
            return (
              <ListItem key={config.id} style={{ paddingLeft: 0, paddingRight: 0 }}>
                <IconButton
                  size="small"
                  disabled={index === 0}
                  onClick={() => handleStatOrderChange(config.id, 'up')}
                >
                  ↑
                </IconButton>
                <IconButton
                  size="small"
                  disabled={index === pendingStatDisplayConfigs.filter(c => c.id !== 'playerName').length - 1}
                  onClick={() => handleStatOrderChange(config.id, 'down')}
                >
                  ↓
                </IconButton>
                <ListItemText
                  primary={statDef?.name || config.id}
                  secondary={statDef?.description}
                  style={{ marginLeft: 8, paddingRight: 80 }}
                />
                <ListItemSecondaryAction>
                  <Switch
                    edge="end"
                    onChange={handleStatToggle(config.id)}
                    checked={config.enabled}
                  />
                </ListItemSecondaryAction>
              </ListItem>
            )
          })}
      </List>

      {hasUnsavedStatChanges && (
        <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
          <Button
            variant="contained"
            color="primary"
            size="small"
            onClick={handleApplyStatChanges}
            style={{ flex: 1 }}
          >
            適用
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={handleResetStatChanges}
            style={{ flex: 1 }}
          >
            リセット
          </Button>
        </Box>
      )}
    </>
  )
}