import { CSSProperties, Fragment } from 'react'
import { PlayerStats } from '../app'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableRow from '@mui/material/TableRow'

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
  },
})

const style: CSSProperties = {
  backgroundColor: 'rgba(0, 0, 0, 0.3)',
  boxSizing: 'border-box',
  width: 640,
  pointerEvents: 'none',
  position: 'absolute',
  tableLayout: 'fixed',
  userSelect: 'none',
}

const seatStyles: CSSProperties[] = [
  { bottom: '0%', left: '50%', transform: 'translate(-50%)' }, /** 中央下（プレイヤー） */
  { bottom: '20%', left: '0%' },
  { top: '33%', left: '0%' },
  { top: '0%', left: '50%', transform: 'translate(-50%)' }, /** 中央上 */
  { top: '33%', right: '0%' },
  { bottom: '20%', right: '0%' },
]

const Hud = (props: { actualSeatIndex: number, stat: PlayerStats }) => {
  const colSize = 3
  const chunks = Array.from({ length: Math.ceil(Object.entries(props.stat).length / colSize) }, (_, i) =>
    Object.entries(props.stat).slice(i * colSize, i * colSize + colSize))
  const valueHandler = (value: number | [number, number]) => {
    if (Array.isArray(value)) {
      const [top, bottom] = value
      const stat = top / bottom
      if (Number.isNaN(stat) || !Number.isFinite(stat)) return '-'
      return `${(Math.round(stat * 1000) / 10).toFixed(1)}%(${top}/${bottom})`
    }
    return String(value)
  }
  return props.stat.playerId ? (
    <ThemeProvider theme={darkTheme}>
      <Table size='small' sx={{ ...style, ...seatStyles.at(props.actualSeatIndex) }}>
        <TableBody>
          {chunks.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.map(([key, value]: [string, number | [number, number]], colIndex) => (
                <Fragment key={colIndex}>
                  <TableCell component='th' scope='row' sx={{ paddingX: '5px', paddingY: 'none', fontSize: 'smaller' }}>{key.toUpperCase()}</TableCell>
                  <TableCell align='right' sx={{ paddingX: '5px', paddingY: 'none', fontSize: 'smaller' }}>{valueHandler(value)}</TableCell>
                </Fragment>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ThemeProvider>
  ) : <></>
}
export default Hud
