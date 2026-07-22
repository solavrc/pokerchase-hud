/**
 * message-router.ts - getRecentHands plumbing test
 *
 * Verifies the 'getRecentHands' Chrome message is wired end-to-end:
 * registerMessageRouter() registers a chrome.runtime.onMessage listener that,
 * given { action: 'getRecentHands', playerId, limit? }, calls the recent
 * hands service and responds with { success: true, recentHands }.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import { clearRecentHandsCache } from '../services/recent-hands-service'
import { RankType } from '../types/game'
import type { Hand } from '../types/entities'
import type { ChromeMessage, MessageResponse } from '../types/messages'

const PLAYER_ID = 1

/**
 * getRecentHands does more DB round-trips than getPositionalStats (hands
 * query, then a Promise.all of an actions query + a phases query) -- a
 * single `setTimeout(resolve, 0)` tick isn't reliably enough ticks for
 * fake-indexeddb to settle all of them, so poll instead of guessing a fixed
 * delay.
 */
async function waitForCall(mock: jest.Mock, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (mock.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('message-router getRecentHands', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

  beforeEach(async () => {
    clearRecentHandsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    const hands: Hand[] = [1, 2, 3].map(id => ({
      id,
      approxTimestamp: id * 1000,
      bigBlindUserId: 2,
      seatUserIds: [1, 2, 3],
      winningPlayerIds: [],
      smallBlind: 100,
      bigBlind: 200,
      session: {},
      results: [{ UserId: PLAYER_ID, HandRanking: 1, Ranking: -2, RewardChip: id === 3 ? 500 : 0, RankType: RankType.NO_CALL, Hands: [], HoleCards: [] }],
      playerChipAccounting: {
        [String(PLAYER_ID)]: id === 3
          ? { grossPayout: 500, totalContribution: 100, netChips: 400 }
          : { grossPayout: 0, totalContribution: 100, netChips: -100 }
      }
    }))
    await db.hands.bulkAdd(hands)

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('responds with the recent hands payload for the requested player, newest first', async () => {
    const sendResponse = jest.fn()
    const handled = listener(
      { action: 'getRecentHands', playerId: PLAYER_ID },
      {},
      sendResponse
    )

    expect(handled).toBe(true) // async response signaled

    await waitForCall(sendResponse)

    expect(sendResponse).toHaveBeenCalledTimes(1)
    const response = sendResponse.mock.calls[0][0]
    expect(response.success).toBe(true)
    expect(response.recentHands).toBeDefined()
    expect(typeof response.recentHands.computedAt).toBe('number')
    expect(response.recentHands.hands.map((h: any) => h.handId)).toEqual([3, 2, 1])
    expect(response.recentHands.hands[0].won).toBe(true)
    expect(response.recentHands.hands[0].netChips).toBe(400)
  })

  test('respects an explicit limit', async () => {
    const sendResponse = jest.fn()
    listener({ action: 'getRecentHands', playerId: PLAYER_ID, limit: 2 }, {}, sendResponse)

    await waitForCall(sendResponse)

    const response = sendResponse.mock.calls[0]![0]
    expect(response.recentHands.hands).toHaveLength(2)
  })
})
