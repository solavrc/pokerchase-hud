import FormControlLabel from '@mui/material/FormControlLabel'
import Radio from '@mui/material/Radio'
import { alpha } from '@mui/material/styles'
import type { ReactNode } from 'react'

interface SegmentRadioProps {
  value: string
  checked: boolean
  label: ReactNode
}

/**
 * A `Radio` + `FormControlLabel` pair styled to look like one button in a
 * segmented control, for the 表示モード (コンパクト/フル) and テーマ
 * (自動/ダーク/ライト) choices -- visually consistent with `ToggleChip` and
 * the 表示/非表示 `ToggleButtonGroup` in `UIScaleSection`. Still a real
 * `<input type="radio">` with role="radio" (Popup.test.tsx and
 * HudDisplaySection.test.tsx assert on that role directly), so only the
 * visual treatment changes here.
 */
export const SegmentRadio = ({ value, checked, label }: SegmentRadioProps) => (
  <FormControlLabel
    value={value}
    control={<Radio size="small" sx={{ p: 0.25, ml: 0.5, mr: 0.25 }} />}
    label={label}
    sx={(theme) => ({
      m: 0,
      mr: 1,
      pl: 0.5,
      pr: 1.25,
      height: 30,
      borderRadius: 999,
      border: '1px solid',
      borderColor: checked ? theme.palette.primary.main : theme.palette.divider,
      backgroundColor: checked ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.08) : 'transparent',
      transition: 'border-color 120ms ease, background-color 120ms ease',
      '& .MuiFormControlLabel-label': {
        fontSize: 13,
        fontWeight: checked ? 600 : 400,
        color: checked ? theme.palette.primary.main : theme.palette.text.primary,
      },
      '&:hover': {
        borderColor: theme.palette.primary.main,
      },
    })}
  />
)
