/**
 * service worker: ブラウザイベントを監視できる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/background?hl=ja
 * @see https://developer.chrome.com/docs/extensions/reference/api/storage
 * @see https://zenn.dev/dotdotdot/articles/b123e67552fe3c
 */
import { ApiEvent, PokerChaseDB, PokerChaseService, PlayerStats } from './app'
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
/** from `content_script.ts` */
chrome.runtime.onConnect.addListener(port => {
  if (port.name === PokerChaseService.POKER_CHASE_SERVICE_EVENT) {
    port.onMessage.addListener((message: ApiEvent) => {
      service.queueEvent(message)
      /** @todo send report */
    })
    /** Anti-Pattern: `=> port.postMessage(hand)` Unchecked runtime.lastError: A listener indicated an asynchronous response by returning true. */
    service.stream.on('data', (hand: PlayerStats[]) => { port.postMessage(hand) })
    service.stream.on('pause', () => { port.postMessage([]) }) /** HUD非表示 */
  }
})
