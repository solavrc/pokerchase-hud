import { useEffect } from 'react'

const Hud = (props: { playerId: number, seatIndex: number }) => {
  useEffect(() => {
    /** @todo シートごとの描画位置調整 */
  }, [])
  return <div>{props.playerId}</div>
}
export default Hud
