/**
 * message-router.ts - pre-game hero stats vs. live lineup race guard
 *
 * Regression test for a P2 review finding on PR #158 (pre-game hero stats):
 * if a tab is opened/reloaded right as a real hand is starting, the one-shot
 * `requestLatestStats` (preGame: true) fallback can still be computing
 * (getLatestSessionStats awaits service.ready/filtersRestored, then queries
 * the DB) when the live pipeline (a real EVT_DEAL processed through
 * service.statsOutputStream.write(), see ports.ts's registerStreamSubscriptions)
 * broadcasts the actual full lineup to the same tab. If the stale hero-only
 * fallback is sent to the tab *after* that live broadcast, it clobbers the
 * live lineup back down to one seat until the next real stats push.
 *
 * message-router.ts guards this with `getLiveBroadcastSequence()` (ports.ts):
 * it snapshots the sequence when the preGame request comes in, and compares
 * again once getLatestSessionStats() resolves -- if the live pipeline bumped
 * the sequence in that window, the response is dropped instead of sent.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import { registerStreamSubscriptions } from './ports'
import type { ChromeMessage, MessageResponse } from '../types/messages'

const HERO_ID = 1
const TAB_ID = 42

/**
 * Polls `condition` until it's true, or throws after `timeoutMs`. Used
 * instead of a fixed `setTimeout(resolve, 0)` after resolving the stalled
 * calcStats promise below -- under full-suite load (many test files/DB
 * transactions running concurrently), the remaining async hops (the real
 * DB-backed calcStats' own await chain, then message-router's `.then()`
 * callback) can take more than a single macrotask tick to settle, and a
 * fixed single-tick wait was observed to flake under that load.
 */
const waitUntil = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('message-router requestLatestStats -- pre-game vs. live lineup race guard', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void
  let sendMessageMock: jest.Mock

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready
    service.playerId = HERO_ID

    sendMessageMock = jest.fn()
    ;(global as any).chrome.tabs = {
      sendMessage: sendMessageMock,
      query: jest.fn((_query, callback) => callback([])),
    }

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    registerStreamSubscriptions(service, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    delete (global as any).chrome.tabs
    db.close()
    await db.delete()
  })

  test('drops the pre-game fallback if a live lineup broadcast lands while it is still computing', async () => {
    // Stall the pre-game fallback's DB-backed computation mid-flight so a live
    // broadcast can land in the gap, same as a real cold-DB race.
    let releasePreGameCalc: (() => void) | undefined
    const originalCalcStats = service.statsOutputStream.calcStats.bind(service.statsOutputStream)
    const calcStatsSpy = jest.spyOn(service.statsOutputStream, 'calcStats')
    calcStatsSpy.mockImplementationOnce((seatUserIds: number[]) => {
      return new Promise(resolve => {
        releasePreGameCalc = () => resolve(originalCalcStats(seatUserIds))
      })
    })

    const sendResponse = jest.fn()
    const handled = listener(
      { action: 'requestLatestStats', preGame: true } as unknown as ChromeMessage,
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      sendResponse
    )
    expect(handled).toBe(true)

    // The mocked calcStats call above should already be in flight (consumed the
    // "once" mock) -- confirm nothing has been sent yet.
    expect(sendMessageMock).not.toHaveBeenCalled()

    // A real hand gets dealt and processed through the live pipeline while the
    // pre-game fallback is still stalled -- this is the race.
    await new Promise<void>(resolve => {
      service.statsOutputStream.once('data', () => resolve())
      service.statsOutputStream.write([HERO_ID, 2, 3, 4, 5, 6])
    })

    // Now let the stalled pre-game fallback resolve.
    expect(releasePreGameCalc).toBeDefined()
    releasePreGameCalc!()
    await waitUntil(() => sendResponse.mock.calls.length > 0)

    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    // The stale hero-only fallback must NOT have been delivered to the tab --
    // it would clobber the live lineup the tab already received via the port
    // channel (broadcastMessage).
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  test('still delivers the pre-game fallback when no live broadcast happens in the gap', async () => {
    const sendResponse = jest.fn()
    const handled = listener(
      { action: 'requestLatestStats', preGame: true } as unknown as ChromeMessage,
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      sendResponse
    )
    expect(handled).toBe(true)

    await waitUntil(() => sendResponse.mock.calls.length > 0)

    expect(sendResponse).toHaveBeenCalledWith({ success: true })
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    const [tabId, message] = sendMessageMock.mock.calls[0]
    expect(tabId).toBe(TAB_ID)
    expect(message.action).toBe('latestStats')
    expect(message.stats[0].playerId).toBe(HERO_ID)
  })
})
