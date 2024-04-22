import { PokerChaseService, HUDStat } from '../app'
import { useEffect, useState } from 'react'
import Hud from './Hud'

const App = () => {
  const [stats, setStats] = useState<HUDStat[]>([])
  useEffect(() => {
    const handleMessage = ({ detail }: CustomEvent<HUDStat[]>) => {
      setStats(detail)
    }
    window.addEventListener(PokerChaseService.POKER_CHASE_SERVICE_EVENT, handleMessage)
    return () => window.removeEventListener(PokerChaseService.POKER_CHASE_SERVICE_EVENT, handleMessage)
  }, [])
  return stats.map((stat, index) => stat.playerId !== -1
    ? <Hud key={index} actualSeatIndex={index} stat={stat} />
    : <div key={index} />)
}
export default App
