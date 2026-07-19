/**
 * message-router.ts - getUndecodedEventStats / acknowledgeUndecodedEventStats plumbing
 *
 * Verifies the drop-visibility Chrome messages (postmortem
 * docs/postmortems/2026-07-session-results-drop.md 再発防止#2) are wired
 * end-to-end: registerMessageRouter() responds to 'getUndecodedEventStats'
 * with the persisted counters, and 'acknowledgeUndecodedEventStats' resets them.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import { recordUndecodedEvent, resetUndecodedEventStats, UNDECODED_EVENT_STATS_KEY } from './undecoded-event-tracker'
import { ApiType } from '../types'
import type { ChromeMessage, MessageResponse } from '../types/messages'

// See undecoded-event-tracker.test.ts: real (not fake) timers, since
// fake-indexeddb's own event scheduling conflicts with Jest's fake timers.
const flush = () => new Promise(resolve => setTimeout(resolve, 550))

describe('message-router undecoded event stats', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    await resetUndecodedEventStats(db)
    service = new PokerChaseService({ db })
    await service.ready

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('getUndecodedEventStats responds with the persisted counters', async () => {
    await recordUndecodedEvent(db, ApiType.EVT_SESSION_RESULTS, 1000)
    await flush()

    const sendResponse = jest.fn()
    const handled = listener({ action: 'getUndecodedEventStats' } as ChromeMessage, {}, sendResponse)
    expect(handled).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(sendResponse).toHaveBeenCalledTimes(1)
    const response = sendResponse.mock.calls[0]![0] as any
    expect(response.success).toBe(true)
    expect(response.undecodedEventStats).toEqual({
      total: 1,
      perApiTypeId: { [ApiType.EVT_SESSION_RESULTS]: { count: 1, lastSeen: 1000 } }
    })
  })

  test('acknowledgeUndecodedEventStats resets the counters', async () => {
    await recordUndecodedEvent(db, ApiType.EVT_SESSION_RESULTS, 1000)
    await flush()

    const ackResponse = jest.fn()
    listener({ action: 'acknowledgeUndecodedEventStats' } as ChromeMessage, {}, ackResponse)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(ackResponse).toHaveBeenCalledWith({ success: true })

    const getResponse = jest.fn()
    listener({ action: 'getUndecodedEventStats' } as ChromeMessage, {}, getResponse)
    await new Promise(resolve => setTimeout(resolve, 50))

    const response = getResponse.mock.calls[0]![0] as any
    expect(response.undecodedEventStats).toEqual({ total: 0, perApiTypeId: {} })
    expect((await db.meta.get(UNDECODED_EVENT_STATS_KEY))?.value).toEqual({ total: 0, perApiTypeId: {} })
  })
})
