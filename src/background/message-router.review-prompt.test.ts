/**
 * message-router.tsのgetReviewPrompt / resolveReviewPrompt配線テスト。
 *
 * `getReviewPrompt`がrouterへ登録したDB自身の`hands`テーブルを参照すること、
 * `resolveReviewPrompt`が押されたボタンを永続化すること、およびDB失敗時に
 * `visible`を捏造せずエラー応答を返すことをend-to-endで検証する。
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
import { trackServiceForTeardown } from '../utils/test-service-teardown'

const readState = async (): Promise<ReviewPromptState> =>
  (await chrome.storage.local.get(REVIEW_PROMPT_STORAGE_KEY))?.[REVIEW_PROMPT_STORAGE_KEY] ?? {}

describe('message-router review prompt', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let listener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void

  const send = async (message: ChromeMessage) => {
    let resolveResponse!: (response: MessageResponse) => void
    const response = new Promise<MessageResponse>(resolve => {
      resolveResponse = resolve
    })
    const sendResponse = jest.fn((value: MessageResponse) => resolveResponse(value))
    const handled = listener(message, {}, sendResponse)
    expect(handled).toBe(true)
    const value = await response
    expect(sendResponse).toHaveBeenCalledTimes(1)
    return value as any
  }

  /** 必要最小限の行。表示条件には行数だけが影響する。 */
  const seedHands = (count: number) =>
    db.hands.bulkAdd(Array.from({ length: count }, (_unused, index) => ({
      // `hands`はauto-incrementではない明示的な`id`主キーを使う
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
    service = trackServiceForTeardown(new PokerChaseService({ db }))
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
