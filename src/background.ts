/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import { content_scripts } from '../manifest.json'
/** "type": "module" */
export const { origin } = new URL(content_scripts.at(0)!.matches.at(0)!)

/** @todo `@extend-chrome/storage` getBucket に失敗するため、一旦ここでは扱わない */
chrome.runtime?.onMessage.addListener(async (message, sender, sendResponse) => {
  if (sender.origin === origin) {
    /** @todo ハンドログ送信 */
    sendResponse(message) /** response to `content_script` */
  }
})
