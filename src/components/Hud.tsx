import { CSSProperties, useEffect, useState } from 'react'
import { ApiType, ApiResponse, PokerChaseService } from '../app'

const style: CSSProperties = {
  transform: 'translateX(-50%)',
  backgroundColor: 'rgba(0, 0, 0, 0.7)',
  color: 'white',
  padding: '5px 10px',
  zIndex: 100, /* Ensure it's above other elements */
  position: 'absolute',
  width: '10%',
  height: '10%',
  borderRadius: '5px',
  fontSize: '12px',
  textAlign: 'center',
  pointerEvents: 'none', /** クリック透過 */
}

const seatStyles: CSSProperties[] = [
  { top: '85%', left: '50%' }, /** 中央下（プレイヤー） */
  { top: '70%', left: '20%' },
  { top: '33%', left: '18%' },
  { top: '10%', left: '65%' }, /** 中央上 */
  { top: '33%', left: '84%' },
  { top: '68%', left: '90%' },
]

const Hud = (props: { userId: number, actualSeatIndex: number }) => {
  useEffect(() => {
    const handleMessage = ({ detail }: CustomEvent<ApiResponse>) => {
      /** @todo 各プレイヤーごとの情報 */
    }
    window.addEventListener(PokerChaseService.POKER_CHASE_SERVICE_EVENT, handleMessage)
    return () => window.removeEventListener(PokerChaseService.POKER_CHASE_SERVICE_EVENT, handleMessage)
  }, [])
  return props.userId ?
    <div style={{ ...style, ...seatStyles.at(props.actualSeatIndex) }}>
      <div>SeatIndex: {props.actualSeatIndex}</div>
      <div>UserId: {props.userId}</div>
    </div> : <></>
}
export default Hud
