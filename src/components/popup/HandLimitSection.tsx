import Box from '@mui/material/Box'
import Slider from '@mui/material/Slider'
import Typography from '@mui/material/Typography'
import { SectionHeading } from './SectionHeading'

interface HandLimitSectionProps {
  handLimit: number | undefined
  sessionOnly: boolean
  handleHandLimitChange: (event: Event, value: number | number[]) => void
}

export const HandLimitSection = ({
  handLimit,
  sessionOnly,
  handleHandLimitChange,
}: HandLimitSectionProps) => {
  return (
    <>
      <SectionHeading>ハンド数</SectionHeading>
      {/* ゲームタイプ/テーブル人数と同じ理由・同じ文末で「これもフィルタだ」を明示する */}
      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
        直近Nハンドに限定してHUD統計の集計対象を絞り込みます
      </Typography>
      <Box sx={{ px: 1, mt: 1, mb: 0.5 }}>
        <Slider
          value={(() => {
            if (sessionOnly) return 0
            if (handLimit === undefined) return 6
            const handCounts = [20, 50, 100, 200, 500]
            const index = handCounts.indexOf(handLimit)
            return index >= 0 ? index + 1 : 6
          })()}
          onChange={handleHandLimitChange}
          valueLabelDisplay="auto"
          valueLabelFormat={(value) => {
            const handCounts = [20, 50, 100, 200, 500, 'ALL']
            if (value === 0) return 'このセッション'
            return value === 6 ? 'ALL' : `${handCounts[value - 1]}ハンド`
          }}
          step={1}
          marks={[
            { value: 0, label: '最新' },
            { value: 1, label: '20' },
            { value: 2, label: '50' },
            { value: 3, label: '100' },
            { value: 4, label: '200' },
            { value: 5, label: '500' },
            { value: 6, label: 'ALL' }
          ]}
          min={0}
          max={6}
        />
      </Box>
    </>
  )
}
