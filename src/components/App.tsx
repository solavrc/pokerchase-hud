import { ApiType, ApiResponse } from '../app'
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import Hud from './Hud'

const App = () => {
  const [playerIds, setPlayerIds] = useState<number[]>([])
  useEffect(() => {
    const handleMessage = ({ data }: MessageEvent<ApiResponse>) => {
      if (data.ApiTypeId === ApiType.EVT_DEAL)
        setPlayerIds(data.SeatUserIds)
    }
    navigator.serviceWorker.addEventListener('message', handleMessage)
    return () => navigator.serviceWorker.removeEventListener('message', handleMessage)
  }, [])
  return ((playerIds.length > 0
    ? playerIds.map((playerId, seatIndex) => <Hud key={playerId} playerId={playerId} seatIndex={seatIndex} />)
    : <div>Waiting Hands...</div>))
}
export default App

export const renderApp = (container: HTMLElement) =>
  createRoot(container).render(<App />)
