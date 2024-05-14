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
  pointerEvents: 'none', /** クリック透過 */
  position: 'absolute',
  transform: 'translateX(-50%)',
  width: 300,
  zIndex: 100, /* Ensure it's above other elements */
  userSelect: 'none',
}

const seatStyles: CSSProperties[] = [
  { top: '85%', left: '50%' }, /** 中央下（プレイヤー） */
  { top: '70%', left: '15%' },
  { top: '33%', left: '15%' },
  { top: '10%', left: '70%' }, /** 中央上 */
  { top: '33%', left: '85%' },
  { top: '68%', left: '85%' },
]

const Hud = (props: { actualSeatIndex: number, stat: PlayerStats }) => {
  const colSize = 2
  const chunks = Array.from({ length: Math.ceil(Object.entries(props.stat).length / colSize) }, (_, i) =>
    Object.entries(props.stat).slice(i * colSize, i * colSize + colSize))
  const valueHandler = (value: number | [number, number]) => {
    if (Array.isArray(value)) {
      const [top, bottom] = value
      return `${(Math.round(top / bottom * 1000) / 10).toFixed(1)}% (${top}/${bottom})`
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
                  <TableCell component='th' scope='row'>{key.toUpperCase()}</TableCell>
                  <TableCell align='right'>{valueHandler(value)}</TableCell>
                </Fragment>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ThemeProvider >
  ) : <></>
}
export default Hud
