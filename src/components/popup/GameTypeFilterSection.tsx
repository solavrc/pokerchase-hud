import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
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
      {/*
        テーブル人数/ハンド数と並ぶ3つのHUD統計フィルタの1つであることを
        明示する常時表示キャプション。「これはフィルタだ」と気づけない、
        との指摘(sola, PR #145レビュー)への対応。他2セクションのキャプションと
        文末（HUD統計の集計対象を絞り込みます）を揃えて統一感を出す。
      */}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
        ゲーム種別でHUD統計の集計対象を絞り込みます
      </Typography>
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
