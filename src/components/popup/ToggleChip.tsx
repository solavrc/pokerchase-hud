import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import { alpha } from '@mui/material/styles'
import type { ChangeEvent, ReactNode } from 'react'

interface ToggleChipProps {
  checked: boolean
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  label: ReactNode
  /**
   * Native `title` attribute on the chip's `<label>` -- a hover tooltip for
   * the fuller explanation when the visible `label` text alone doesn't fit
   * it (e.g. テーブル人数's per-layer breakdown). `FormControlLabel` spreads
   * unrecognized props onto its root `<label>` element, so this Just Works.
   */
  title?: string
}

/**
 * A `Checkbox` + `FormControlLabel` pair styled as a pill/segment chip, for
 * multi-select filter rows (ゲームタイプ, テーブル人数) that read better as
 * a scannable row of toggles than a stacked checkbox list.
 *
 * Deliberately still a real `<input type="checkbox">` inside a native
 * `<label>` -- role="checkbox", accessible name = the label text, checked
 * state driven the same way as a plain Checkbox. Only the visual treatment
 * changes, so this is a drop-in replacement wherever a bare
 * Checkbox+FormControlLabel pair was used, and every existing test that
 * asserts on checkbox role/name/checked state keeps working unmodified.
 */
export const ToggleChip = ({ checked, onChange, label, title }: ToggleChipProps) => (
  <FormControlLabel
    control={
      <Checkbox
        checked={checked}
        onChange={onChange}
        size="small"
        sx={{ p: 0.25, ml: 0.25, mr: 0.25 }}
      />
    }
    label={label}
    title={title}
    sx={(theme) => ({
      m: 0,
      pl: 0.5,
      pr: 1.25,
      height: 32,
      borderRadius: 999,
      border: '1px solid',
      borderColor: checked ? theme.palette.primary.main : theme.palette.divider,
      backgroundColor: checked ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.08) : 'transparent',
      transition: 'border-color 120ms ease, background-color 120ms ease',
      '& .MuiFormControlLabel-label': {
        fontSize: 13,
        fontWeight: checked ? 600 : 400,
        color: checked ? theme.palette.primary.main : theme.palette.text.primary,
        whiteSpace: 'nowrap',
      },
      '&:hover': {
        borderColor: theme.palette.primary.main,
      },
    })}
  />
)
