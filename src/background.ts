/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import { ApiResponse } from './app'
import { content_scripts } from '../manifest.json'
import process from 'process'
/** "type": "module" */
self.process = process
export const { origin } = new URL(content_scripts.at(0)!.matches.at(0)!)

chrome.runtime?.onMessage.addListener(async (message: ApiResponse, sender, _sendResponse) => {
  if (sender.origin === origin) {
    /** @todo send report */
    console.dir(message)
  }
  return true
})
