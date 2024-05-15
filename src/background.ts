/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import { ApiResponse, PokerChaseDB, PokerChaseService, PlayerStats } from './app'
import { content_scripts } from '../manifest.json'
import process from 'process'

declare global {
  interface Window {
    db: PokerChaseDB
    service: PokerChaseService
  }
}

self.process = process
export const { origin } = new URL(content_scripts.at(0)!.matches.at(0)!)

const db = new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
const service = new PokerChaseService({ db })
/** for debug */
self.db = db
self.service = service

/** 拡張更新時: データ再構築 */
chrome.runtime?.onInstalled?.addListener(details => {
  if (details.reason === 'update')
    service.refreshDatabase()
})

let tabId: number | undefined
/** from `content_script.ts` */
chrome.runtime?.onMessage?.addListener((message: ApiResponse | PlayerStats[], sender, _sendResponse) => {
  if (sender.origin === origin && !Array.isArray(message) && message.ApiTypeId) {
    tabId = sender.tab?.id
    service.queueEvent(message)
    /** @todo send report */
  }
})
/** to `content_script.ts` */
const sendMessageToGameTab = (hand: PlayerStats[]) =>
  tabId && chrome.tabs.sendMessage<PlayerStats[]>(tabId, hand)
/**
 * Uncaught (in promise) Error: Could not establish connection. Receiving end does not exist.
 * @see https://stackoverflow.com/questions/53939205/how-to-avoid-extension-context-invalidated-errors-when-messaging-after-an-exte
 */
service.stream.on('data', (hand: PlayerStats[]) => sendMessageToGameTab(hand))
service.stream.on('pause', () => sendMessageToGameTab([])) /** HUD非表示 */
