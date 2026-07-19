import Box from '@mui/material/Box'
import type { GameTypeFilter } from '../../types'
import { SectionHeading } from './SectionHeading'
import { ToggleChip } from './ToggleChip'

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
      <SectionHeading>ゲームタイプ</SectionHeading>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <ToggleChip
          checked={gameTypeFilter.sng}
          onChange={handleGameTypeFilterChange('sng')}
          label="Sit & Go"
        />
        <ToggleChip
          checked={gameTypeFilter.mtt}
          onChange={handleGameTypeFilterChange('mtt')}
          label="MTT"
        />
        <ToggleChip
          checked={gameTypeFilter.ring}
          onChange={handleGameTypeFilterChange('ring')}
          label="リングゲーム"
        />
      </Box>
    </>
  )
}
