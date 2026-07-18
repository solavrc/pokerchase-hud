import Box from '@mui/material/Box'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import Typography from '@mui/material/Typography'
import type { TableSizeFilter } from '../../types'

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
      <Typography variant="h6">卓人数</Typography>
      <FormControl component="fieldset" style={{ marginTop: '10px', width: '100%' }}>
        <FormGroup>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={tableSizeFilter.full}
                  onChange={handleTableSizeFilterChange('full')}
                />
              }
              label="フル"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={tableSizeFilter['4p']}
                  onChange={handleTableSizeFilterChange('4p')}
                />
              }
              label="4人"
            />
          </Box>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={tableSizeFilter['3p']}
                  onChange={handleTableSizeFilterChange('3p')}
                />
              }
              label="3人"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={tableSizeFilter.hu}
                  onChange={handleTableSizeFilterChange('hu')}
                />
              }
              label="HU"
            />
          </Box>
        </FormGroup>
      </FormControl>
    </>
  )
}
