import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import type { TableSizeFilter } from '../../types'
import { SectionHeading } from './SectionHeading'
import { ToggleChip } from './ToggleChip'

interface TableSizeFilterSectionProps {
  tableSizeFilter: TableSizeFilter
  handleTableSizeFilterChange: (layer: keyof TableSizeFilter) => (event: React.ChangeEvent<HTMLInputElement>) => void
}

export const TableSizeFilterSection = ({
  tableSizeFilter,
  handleTableSizeFilterChange,
}: TableSizeFilterSectionProps) => {
  return (
    <>
      <SectionHeading>テーブル人数</SectionHeading>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
        配られた人数でHUD統計の集計対象を絞り込みます
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <ToggleChip
          checked={tableSizeFilter.full}
          onChange={handleTableSizeFilterChange('full')}
          label="フル (5-6人)"
          title="満席〜1人欠け(6maxは5-6人 / 4maxは4人)"
        />
        <ToggleChip
          checked={tableSizeFilter['4p']}
          onChange={handleTableSizeFilterChange('4p')}
          label="4人 (ショート)"
          title="6maxテーブルの4人時(ショート)"
        />
        <ToggleChip
          checked={tableSizeFilter['3p']}
          onChange={handleTableSizeFilterChange('3p')}
          label="3人"
          title="3人テーブル"
        />
        <ToggleChip
          checked={tableSizeFilter.hu}
          onChange={handleTableSizeFilterChange('hu')}
          label="HU (2人)"
          title="ヘッズアップ(2人)"
        />
      </Box>
    </>
  )
}
