/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import { ApiResponse, PokerChaseDB, PokerChaseService, HUDStat } from './app'
import { content_scripts } from '../manifest.json'
import process from 'process'

self.process = process
export const { origin } = new URL(content_scripts.at(0)!.matches.at(0)!)

const db = new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
const service = new PokerChaseService({ db })

/** from `content_script.ts` */
chrome.runtime?.onMessage.addListener((message: ApiResponse | HUDStat[], sender, _sendResponse) => {
  if (sender.origin === origin && !Array.isArray(message) && message.ApiTypeId) {
    /** @todo send report */
    service.eventHandler(message)
  }
})
/** to `content_script.ts` */
service.handStream.on('data', (hand: HUDStat[]) => {
  chrome.tabs.query({ url: `${origin}/play/index.html`, currentWindow: true, active: true }, tabs => {
    console.debug(`[${new Date().toISOString().slice(11, 19)}] HUDStat[]:`, hand)
    tabs.forEach(({ id }) => id && chrome.tabs.sendMessage<HUDStat[]>(id, hand))
  })
})
