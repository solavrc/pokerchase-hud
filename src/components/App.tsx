import { ApiType, ApiResponse, PokerChaseService } from '../app'
import { useEffect, useState } from 'react'
import Hud from './Hud'

const App = () => {
  const [seatUserIds, setSeatUserIds] = useState<number[]>([])
  /** プレイヤーごとのHUD表示制御 */
  useEffect(() => {
    const handleMessage = ({ detail }: CustomEvent<ApiResponse>) => {
      switch (detail.ApiTypeId) {
        case ApiType.EVT_PLAYER_SEATED:
        case ApiType.EVT_DEAL:
          setSeatUserIds(detail.SeatUserIds)
          break
        case ApiType.EVT_RESULT:
          setSeatUserIds([])
          break
      }
    }
    window.addEventListener(PokerChaseService.POKER_CHASE_SERVICE_EVENT, handleMessage)
    return () => window.removeEventListener(PokerChaseService.POKER_CHASE_SERVICE_EVENT, handleMessage)
  }, [])
  return seatUserIds.map((userId, index) => userId !== -1
    ? <Hud key={index} userId={userId} actualSeatIndex={index} />
    : <div key={index} />)
}
export default App
