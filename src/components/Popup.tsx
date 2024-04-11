import { Button, Checkbox, FormGroup, FormControlLabel } from '@mui/material'
import { createRoot } from 'react-dom/client'
import { getBucket } from '@extend-chrome/storage'
import { useEffect, useState, ChangeEvent } from 'react'

export interface Options {
  sendUserData: boolean
}

const bucket = getBucket<Options>('options', 'sync')

const Popup = () => {
  const [options, setOptions] = useState<Options>({ sendUserData: true })
  useEffect(() => {
    (async () => setOptions(await bucket.get()))()
  }, [])
  const openLink = () => window.open('https://poker-chase.com', '_blank')
  const handleOptions = ({ target: { name, checked } }: ChangeEvent<HTMLInputElement>) => {
    bucket.set({ ...options, [name]: checked })
    setOptions({ ...options, [name]: checked })
  }
  return <div style={{ width: 300 }}>
    <h1>PokerChase Analyzer</h1>
    <FormGroup>
      <FormControlLabel key={'sendUserData'} label={'統計データ収集に協力する'} name={'sendUserData'} control={<Checkbox checked={options.sendUserData} onChange={handleOptions} />} />
    </FormGroup>
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <Button onClick={openLink}>ポーカーチェイス</Button>
    </div>
  </div>
}
export default Popup

export const renderOptions = (container: HTMLElement) =>
  createRoot(container).render(<Popup />)
