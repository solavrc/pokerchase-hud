/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import { content_scripts } from '../manifest.json'
import { getBucket } from '@extend-chrome/storage'
import { Options } from './components/Popup'
/** "type": "module" */
export const { origin } = new URL(content_scripts.at(0)!.matches.at(0)!)

const bucket = getBucket<Options>('options', 'sync')

chrome.runtime?.onMessage.addListener(async (message, sender, sendResponse) => {
  if (sender.origin === origin) {
    /** @todo ハンドログ保存 */
    console.dir(message)
    const { sendUserData } = await bucket.get()
    if (sendUserData) {
      /** @todo ハンドログ収集 */
    }
  }
})
