import Typography from '@mui/material/Typography'
import type { ReactNode } from 'react'

interface SectionHeadingProps {
  children: ReactNode
}

/**
 * Small, letterspaced, muted section label used consistently across every
 * popup section (ゲームタイプ / テーブル人数 / ハンド数 / HUD表示設定 / ...) so
 * headings read as one typographic system instead of ad-hoc `<h6>`s.
 * Renders the same text content the previous `<Typography variant="h6">`
 * did, so it's a drop-in visual change only.
 */
export const SectionHeading = ({ children }: SectionHeadingProps) => (
  <Typography
    variant="subtitle2"
    component="h2"
    sx={{
      display: 'block',
      mb: 1,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: 'text.secondary',
    }}
  >
    {children}
  </Typography>
)
