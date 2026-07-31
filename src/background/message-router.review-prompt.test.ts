/**
 * message-router.ts - getReviewPrompt / resolveReviewPrompt plumbing
 *
 * Verifies the Chrome Web Store review-prompt messages are wired end-to-end:
 * `getReviewPrompt` answers from the `hands` table of the DB the router was
 * registered with (not some other instance), `resolveReviewPrompt` persists
 * the pressed button, and a failing DB surfaces as an error response rather
 * than a fabricated `visible` value.
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { registerMessageRouter } from './message-router'
import {
  REVIEW_PROMPT_MIN_HANDS,
  REVIEW_PROMPT_STORAGE_KEY,
  type ReviewPromptState,
} from '../constants/review-prompt'
import type { ChromeMessage, MessageResponse } from '../types/messages'

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

const readState = async (): Promise<ReviewPromptState> =>
  (await chrome.storage.local.get(REVIEW_PROMPT_STORAGE_KEY))?.[REVIEW_PROMPT_STORAGE_KEY] ?? {}

describe('message-router review prompt', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

  const send = async (message: ChromeMessage) => {
    const sendResponse = jest.fn()
    const handled = listener(message, {}, sendResponse)
    expect(handled).toBe(true)
    await settle()
    expect(sendResponse).toHaveBeenCalledTimes(1)
    return sendResponse.mock.calls[0]![0] as any
  }

  /** Minimal rows: only the row count matters to the eligibility gate. */
  const seedHands = (count: number) =>
    db.hands.bulkAdd(Array.from({ length: count }, (_unused, index) => ({
      // `hands` uses an explicit (non auto-increment) `id` primary key
      id: index + 1,
      approxTimestamp: index,
      seatUserIds: [],
      winningPlayerIds: [],
      smallBlind: 0,
      bigBlind: 0,
      session: { id: 'test', battleType: undefined, name: undefined },
      results: [],
    }) as any))

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
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

  test('getReviewPrompt responds visible:false while the hands table is below the threshold', async () => {
    await seedHands(REVIEW_PROMPT_MIN_HANDS - 1)

    expect(await send({ action: 'getReviewPrompt' } as ChromeMessage)).toEqual({
      success: true,
      visible: false,
    })
    expect(await readState()).toEqual({})
  })

  test('getReviewPrompt responds visible:true from the registered db once the threshold is reached', async () => {
    await seedHands(REVIEW_PROMPT_MIN_HANDS)

    expect(await send({ action: 'getReviewPrompt' } as ChromeMessage)).toEqual({
      success: true,
      visible: true,
    })
    expect((await readState()).eligibleSince).toEqual(expect.any(Number))
  })

  test('resolveReviewPrompt persists the pressed button and later prompts stay hidden', async () => {
    await chrome.storage.local.set({ [REVIEW_PROMPT_STORAGE_KEY]: { eligibleSince: 1 } })

    expect(await send({ action: 'resolveReviewPrompt', choice: 'dismissed' } as ChromeMessage))
      .toEqual({ success: true })

    const state = await readState()
    expect(state.resolution).toBe('dismissed')
    expect(await send({ action: 'getReviewPrompt' } as ChromeMessage)).toEqual({
      success: true,
      visible: false,
    })
  })

  test('getReviewPrompt reports an error instead of a fabricated answer when the db is unavailable', async () => {
    db.close()

    const response = await send({ action: 'getReviewPrompt' } as ChromeMessage)
    expect(response.success).toBe(false)
    expect(response.error).toEqual(expect.any(String))
    expect(response.visible).toBeUndefined()
  })
})
