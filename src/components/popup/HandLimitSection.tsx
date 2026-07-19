import Box from '@mui/material/Box'
import Slider from '@mui/material/Slider'
import { SectionHeading } from './SectionHeading'

interface HandLimitSectionProps {
  handLimit: number | undefined
  handleHandLimitChange: (event: Event, value: number | number[]) => void
}

export const HandLimitSection = ({
  handLimit,
  handleHandLimitChange,
}: HandLimitSectionProps) => {
  return (
    <>
      <SectionHeading>ハンド数</SectionHeading>
      <Box sx={{ px: 1, mt: 1, mb: 0.5 }}>
        <Slider
          value={(() => {
            if (handLimit === undefined) return 6
            const handCounts = [20, 50, 100, 200, 500]
            const index = handCounts.indexOf(handLimit)
            return index >= 0 ? index + 1 : 6
          })()}
          onChange={handleHandLimitChange}
          valueLabelDisplay="auto"
          valueLabelFormat={(value) => {
            const handCounts = [20, 50, 100, 200, 500, 'ALL']
            return value === 6 ? 'ALL' : `${handCounts[value - 1]}ハンド`
          }}
          step={1}
          marks={[
            { value: 1, label: '最新20' },
            { value: 2, label: '50' },
            { value: 3, label: '100' },
            { value: 4, label: '200' },
            { value: 5, label: '500' },
            { value: 6, label: 'ALL' }
          ]}
          min={1}
          max={6}
        />
      </Box>
    </>
  )
}