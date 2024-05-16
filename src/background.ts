/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import PokerChaseService, { ApiEvent, PokerChaseDB, PlayerStats } from './app'
import process from 'process'
/** !!! DO NOT IMPORT FROM CONTENT_SCRIPTS, WEB_ACCESSIBLE_RESOURCES !!! */

declare global {
  interface Window {
    db: PokerChaseDB
    service: PokerChaseService
  }
}

self.process = process

const db = new PokerChaseDB(self.indexedDB, self.IDBKeyRange)
const service = new PokerChaseService({ db })
/** for debug */
self.db = db
self.service = service

/** 拡張更新時: データ再構築 */
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === chrome.runtime.OnInstalledReason.UPDATE)
    service.refreshDatabase()
})
/**
 * from `content_script.ts`
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/messaging?hl=ja#port-lifetime
 * @see https://medium.com/@bhuvan.gandhi/chrome-extension-v3-mitigate-service-worker-timeout-issue-in-the-easiest-way-fccc01877abd
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
    port.onMessage.addListener((message: ApiEvent) => {
      service.queueEvent(message)
      /** @todo send report */
    })
    const postMessage = (hand: PlayerStats[] | string) => {
      try {
        port.postMessage(hand)
      } catch (error: unknown) {
        if (error instanceof Error) {
          /** when `content_script` is inactive */
          if (error.message === 'Attempting to use a disconnected port object')
            clearInterval(intervalId)
          else
            console.error(error)
        }
      }
    }
    const intervalId = setInterval(() => { postMessage(`[PING] ${new Date().toISOString()}`) }, 10 * 1000)
    service.stream.on('data', (hand: PlayerStats[]) => { postMessage(hand) })
    service.stream.on('pause', () => { postMessage([]) }) /** HUD非表示 */
  }
})
