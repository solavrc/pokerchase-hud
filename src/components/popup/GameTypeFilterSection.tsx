import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import Typography from '@mui/material/Typography'
import type { GameTypeFilter } from '../../app'

interface GameTypeFilterSectionProps {
  gameTypeFilter: GameTypeFilter
  handleGameTypeFilterChange: (type: keyof GameTypeFilter) => (event: React.ChangeEvent<HTMLInputElement>) => void
}

export const GameTypeFilterSection = ({
  gameTypeFilter,
  handleGameTypeFilterChange,
}: GameTypeFilterSectionProps) => {
  return (
    <>
      <Typography variant="h6">ゲームタイプ</Typography>
      <FormControl component="fieldset" style={{ marginTop: '10px', width: '100%' }}>
        <FormGroup>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={gameTypeFilter.sng}
                  onChange={handleGameTypeFilterChange('sng')}
                />
              }
              label="Sit & Go"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={gameTypeFilter.mtt}
                  onChange={handleGameTypeFilterChange('mtt')}
                />
              }
              label="MTT"
            />
          </Box>
          <FormControlLabel
            control={
              <Checkbox
                checked={gameTypeFilter.ring}
                onChange={handleGameTypeFilterChange('ring')}
              />
            }
            label="リングゲーム"
          />
        </FormGroup>
      </FormControl>
    </>
  )
}