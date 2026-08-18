/**
 * review-promptのbackground側ロジック（src/background/review-prompt.ts）の単体テスト。
 *
 * ハンド数ゲートと一方向ラッチ、スヌーズ・決着の記録、および依頼をしつこく
 * 出さないための性質（決着後はDBへ問い合わせず、再表示もしない）を検証する。
 */
import {
  evaluateReviewPromptVisibility,
  getReviewPromptState,
  resolveReviewPrompt,
} from './review-prompt'
import {
  REVIEW_PROMPT_MIN_HANDS,
  REVIEW_PROMPT_SNOOZE_MS,
  REVIEW_PROMPT_STORAGE_KEY,
} from '../constants/review-prompt'
import type { PokerChaseDB } from '../db/poker-chase-db'
import { __resetPendingStorageWritesForTests } from './pending-storage-writes'

const NOW = 1_800_000_000_000
const PLAYER_ID = 42

describe('review-prompt (background)', () => {
  let mockDb: jest.Mocked<PokerChaseDB>
  let handCount: jest.Mock
  let handWhere: jest.Mock
  let handEquals: jest.Mock

  beforeEach(async () => {
    __resetPendingStorageWritesForTests()
    await chrome.storage.local.set({ [REVIEW_PROMPT_STORAGE_KEY]: undefined })
    jest.clearAllMocks()

    handCount = jest.fn()
    handEquals = jest.fn(() => ({ count: handCount }))
    handWhere = jest.fn(() => ({ equals: handEquals }))
    mockDb = { hands: { where: handWhere } } as any
  })

  describe('evaluateReviewPromptVisibility', () => {
    it('累計ハンド数が閾値未満なら表示せず、状態も記録しない', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS - 1)

      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW)).toBe(false)
      expect(await getReviewPromptState()).toEqual({})
      expect(handWhere).toHaveBeenCalledWith('seatUserIds')
      expect(handEquals).toHaveBeenCalledWith(PLAYER_ID)
    })

    it('閾値に到達したら表示し、eligibleSinceを記録する', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS)

      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW)).toBe(true)
      expect(await getReviewPromptState()).toEqual({ eligibleSince: NOW })
    })

    it('一度eligibleになったら以降はハンド数を数え直さない（全データ削除後も降りない）', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS)
      await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW)
      handCount.mockClear()
      handCount.mockResolvedValue(0)

      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW + 1)).toBe(true)
      expect(handCount).not.toHaveBeenCalled()
    })

    it('決着済みなら表示せず、DBへの問い合わせも行わない', async () => {
      await chrome.storage.local.set({
        [REVIEW_PROMPT_STORAGE_KEY]: { eligibleSince: NOW, resolution: 'rated', resolvedAt: NOW },
      })

      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW + 1)).toBe(false)
      expect(handCount).not.toHaveBeenCalled()
    })

    it('playerIdが不明または不正なら観戦・他プレイヤーの履歴を数えず非表示にする', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS)

      expect(await evaluateReviewPromptVisibility(mockDb, undefined, NOW)).toBe(false)
      expect(await evaluateReviewPromptVisibility(mockDb, Number.NaN, NOW)).toBe(false)
      expect(await evaluateReviewPromptVisibility(mockDb, 0, NOW)).toBe(false)
      expect(handWhere).not.toHaveBeenCalled()
      expect(await getReviewPromptState()).toEqual({})
    })

    it('スヌーズ中は表示せず、期間が明けたら再表示する', async () => {
      await chrome.storage.local.set({
        [REVIEW_PROMPT_STORAGE_KEY]: { eligibleSince: NOW, snoozedAt: NOW },
      })

      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW + REVIEW_PROMPT_SNOOZE_MS - 1)).toBe(false)
      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW + REVIEW_PROMPT_SNOOZE_MS)).toBe(true)
    })

    it('表示判定中に決着しても、古い表示状態で決着を消さない', async () => {
      let releaseHandCount!: (count: number) => void
      let markHandCountStarted!: () => void
      const handCountStarted = new Promise<void>(resolve => {
        markHandCountStarted = resolve
      })
      handCount.mockImplementation(() => new Promise<number>(resolve => {
        releaseHandCount = resolve
        markHandCountStarted()
      }))

      const visibility = evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW)
      await handCountStarted
      const dismissed = resolveReviewPrompt('dismissed', NOW + 10)
      releaseHandCount(REVIEW_PROMPT_MIN_HANDS)

      expect(await visibility).toBe(true)
      await dismissed
      expect(await getReviewPromptState()).toEqual({
        eligibleSince: NOW,
        resolution: 'dismissed',
        resolvedAt: NOW + 10,
      })
    })
  })

  describe('resolveReviewPrompt', () => {
    beforeEach(async () => {
      await chrome.storage.local.set({ [REVIEW_PROMPT_STORAGE_KEY]: { eligibleSince: NOW } })
    })

    it('「後で」はスヌーズ時刻だけを記録する（決着にしない）', async () => {
      await resolveReviewPrompt('later', NOW + 10)

      expect(await getReviewPromptState()).toEqual({ eligibleSince: NOW, snoozedAt: NOW + 10 })
    })

    it.each(['rated', 'dismissed'] as const)('「%s」は決着として記録する', async (choice) => {
      await resolveReviewPrompt(choice, NOW + 10)

      expect(await getReviewPromptState()).toEqual({
        eligibleSince: NOW,
        resolution: choice,
        resolvedAt: NOW + 10,
      })
      expect(await evaluateReviewPromptVisibility(mockDb, PLAYER_ID, NOW + 20)).toBe(false)
    })

    it('決着済みの状態は上書きしない（「後で」で復活もしない）', async () => {
      await resolveReviewPrompt('rated', NOW + 10)
      await resolveReviewPrompt('later', NOW + 20)
      await resolveReviewPrompt('dismissed', NOW + 30)

      expect(await getReviewPromptState()).toEqual({
        eligibleSince: NOW,
        resolution: 'rated',
        resolvedAt: NOW + 10,
      })
    })

    it('並行した決着と「後で」でも先に記録した決着を失わない', async () => {
      const dismissed = resolveReviewPrompt('dismissed', NOW + 10)
      const later = resolveReviewPrompt('later', NOW + 20)

      await Promise.all([dismissed, later])

      expect(await getReviewPromptState()).toEqual({
        eligibleSince: NOW,
        resolution: 'dismissed',
        resolvedAt: NOW + 10,
      })
    })
  })
})
