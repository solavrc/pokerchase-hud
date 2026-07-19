import Paper from '@mui/material/Paper'
import type { ReactNode } from 'react'

interface SectionCardProps {
  children: ReactNode
}

/**
 * Groups a settings section into a bordered surface with consistent
 * padding/spacing, replacing the old flat `<Divider>`-separated layout so
 * sections read as distinct cards with breathing room instead of one long
 * unbroken list of controls.
 */
export const SectionCard = ({ children }: SectionCardProps) => (
  <Paper
    variant="outlined"
    sx={{
      p: 1.75,
      mb: 1.5,
      borderRadius: 2.5,
    }}
  >
    {children}
  </Paper>
)
