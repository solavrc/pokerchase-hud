import Box from '@mui/material/Box'
import Slider from '@mui/material/Slider'
import Typography from '@mui/material/Typography'
import type { TableSizeFilter } from '../../types'
import {
  TABLE_SIZE_SLIDER_MAX,
  TABLE_SIZE_SLIDER_MIN,
  tableSizeFilterToRange,
} from '../../utils/table-size-range'
import { SectionHeading } from './SectionHeading'

interface TableSizeFilterSectionProps {
  tableSizeFilter: TableSizeFilter
  handleTableSizeFilterChange: (event: Event, value: number | number[]) => void
}

/** 目盛りラベル。スライダー値（1始まり）は TABLE_SIZE_SLIDER_LAYERS と同じ並び。 */
const MARKS = [
  { value: 1, label: 'HU' },
  { value: 2, label: '3人' },
  { value: 3, label: '4人' },
  { value: 4, label: 'フル' },
]

const VALUE_LABELS: Record<number, string> = {
  1: 'HU (2人)',
  2: '3人',
  3: '4人 (ショート)',
  4: 'フル',
}

/**
 * テーブル人数フィルタ。層は人数の順に並んでいて、選びたいのは常にその
 * 連続した一区間になる ―― 「HUとフルは対象だが4人は対象外」に意味のある
 * 状況が無いため（sola）。層ごとのチェックボックスはその無意味な組み合わせ
 * まで表現できてしまうので、ハンド数と同じスライダーへ寄せた。
 *
 * ただしハンド数（単一つまみ＝上限だけ）と違い、両端を持つレンジにしている。
 * 単一つまみだと「N人以上」しか表現できず、短ハンド戦だけを見る
 * （3人以下に限定する）といった絞り込みができないため。
 */
export const TableSizeFilterSection = ({
  tableSizeFilter,
  handleTableSizeFilterChange,
}: TableSizeFilterSectionProps) => {
  const range = tableSizeFilterToRange(tableSizeFilter)

  return (
    <>
      <SectionHeading>テーブル人数</SectionHeading>
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
        配られた人数でHUD統計の集計対象を絞り込みます
      </Typography>
      <Box sx={{ px: 1, mt: 1, mb: 0.5 }}>
        <Slider
          value={range}
          onChange={handleTableSizeFilterChange}
          getAriaLabel={(index) => (index === 0 ? 'テーブル人数の下限' : 'テーブル人数の上限')}
          valueLabelDisplay="auto"
          valueLabelFormat={(value) => VALUE_LABELS[value] ?? String(value)}
          step={1}
          marks={MARKS}
          min={TABLE_SIZE_SLIDER_MIN}
          max={TABLE_SIZE_SLIDER_MAX}
          // つまみが入れ替わると「下限＞上限」の瞬間ができ、区間の意味が壊れる。
          disableSwap
        />
      </Box>
      {/*
        「フル」の定義はテーブルサイズに依存する(classifyTableSizeLayer, table-size.ts):
        6maxは5〜6人、4maxは4人(満席)。目盛りラベルだけでこの分岐を表現すると
        長すぎるかホバー頼みになるため、ここに常時表示のキャプションとして
        明記する(sola要件: 正しいこと AND 推測なしで発見できること)。
      */}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 1 }}>
        「フル」は6maxで5〜6人、4maxで4人(満席)を対象とします
      </Typography>
    </>
  )
}
