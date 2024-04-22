import { CSSProperties } from 'react'
import { HUDStat } from '../app'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import Paper from '@mui/material/Paper'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableRow from '@mui/material/TableRow'

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
  },
})

const style: CSSProperties = {
  backgroundColor: 'rgba(0, 0, 0, 0.3)',
  height: 100,
  pointerEvents: 'none', /** クリック透過 */
  position: 'absolute',
  transform: 'translateX(-50%)',
  width: 300,
  zIndex: 100, /* Ensure it's above other elements */
}

const seatStyles: CSSProperties[] = [
  { top: '85%', left: '50%' }, /** 中央下（プレイヤー） */
  { top: '70%', left: '15%' },
  { top: '33%', left: '15%' },
  { top: '10%', left: '70%' }, /** 中央上 */
  { top: '33%', left: '85%' },
  { top: '68%', left: '85%' },
]

const Hud = (props: { actualSeatIndex: number, stat: HUDStat }) => {
  return props.stat.playerId
    ? <ThemeProvider theme={darkTheme}>
      <TableContainer component={Paper} style={{ ...style, ...seatStyles.at(props.actualSeatIndex) }}>
        <Table size='small'>
          <TableBody>
            <TableRow>
              <TableCell scope='row'>ID</TableCell>
              <TableCell align='right'>{props.stat.playerId}</TableCell>
              <TableCell scope='row'>HANDS</TableCell>
              <TableCell align='right'>{props.stat.hands}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell scope='row'>VPIP</TableCell>
              <TableCell align='right'>{(Math.round((props.stat.vpip || 0) * 100))}%</TableCell>
              <TableCell scope='row'>PFR</TableCell>
              <TableCell align='right'>{(Math.round((props.stat.pfr || 0) * 100))}%</TableCell>
            </TableRow>
            <TableRow>
              <TableCell scope='row'>3B</TableCell>
              <TableCell align='right'>{(Math.round((props.stat.threeBet || 0) * 100))}%</TableCell>
              <TableCell scope='row'>3BF</TableCell>
              <TableCell align='right'>{(Math.round((props.stat.threeBetFold || 0) * 100))}%</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>
    </ThemeProvider>
    : <></>
}
export default Hud
