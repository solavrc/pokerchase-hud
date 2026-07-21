/**
 * message-router.ts - getPositionalStats plumbing test
 *
 * Verifies the 'getPositionalStats' Chrome message is wired end-to-end:
 * registerMessageRouter() registers a chrome.runtime.onMessage listener that,
 * given { action: 'getPositionalStats', playerId }, calls the positional
 * stats service and responds with { success: true, positionalStats }.
 */
import { waitFor } from '@testing-library/dom'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import { clearPositionalStatsCache } from '../services/positional-stats-service'
import { ActionType, PhaseType, Position } from '../types/game'
import type { Action, Hand } from '../types/entities'
import type { ChromeMessage, MessageResponse } from '../types/messages'

const PLAYER_ID = 1

describe('message-router getPositionalStats', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

  beforeEach(async () => {
    clearPositionalStatsCache()
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = new PokerChaseService({ db })
    await service.ready

    const hand: Hand = {
      id: 1,
      bigBlindUserId: 2,
      seatUserIds: [1, 2, 3],
      winningPlayerIds: [],
      smallBlind: 100,
      bigBlind: 200,
      session: {},
      results: []
    }
    const action: Action = {
      handId: 1,
      index: 0,
      playerId: PLAYER_ID,
      phase: PhaseType.PREFLOP,
      actionType: ActionType.RAISE,
      position: Position.BTN,
      bet: 400,
      pot: 400,
      sidePot: [],
      actionDetails: []
    }
    await db.hands.add(hand)
    await db.actions.add(action)

    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()
    registerMessageRouter(service, db, 'https://example.com/*')
    listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]
  })

  afterEach(async () => {
    db.close()
    await db.delete()
  })

  test('responds with the positional stats payload for the requested player', async () => {
    const sendResponse = jest.fn()
    const handled = listener(
      { action: 'getPositionalStats', playerId: PLAYER_ID },
      {},
      sendResponse
    )

    expect(handled).toBe(true) // async response signaled

    // Let the underlying promise chain resolve. Poll instead of a single
    // setTimeout(0): the chain includes fake-indexeddb reads that can take
    // more than one macrotask to settle on a loaded machine (observed as a
    // rare flake during `jest --randomize` seed sweeps, 2026-07-21).
    await waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1))

    expect(sendResponse).toHaveBeenCalledTimes(1)
    const response = sendResponse.mock.calls[0][0]
    expect(response.success).toBe(true)
    expect(response.positionalStats).toBeDefined()
    expect(typeof response.positionalStats.computedAt).toBe('number')

    const btn = response.positionalStats.positions.find((p: any) => p.position === Position.BTN)
    expect(btn.handsN).toBe(1)
    expect(btn.stats.pfr).toEqual([1, 1])
  })
})
