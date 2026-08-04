/**
 * Unit tests for the review-prompt background logic
 * (src/background/review-prompt.ts).
 *
 * Covers: the hand-count gate and its one-way latch, the snooze/resolution
 * bookkeeping, and the two properties that keep this from becoming a nag —
 * a resolved prompt never queries the DB again and never comes back.
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

const NOW = 1_800_000_000_000

describe('review-prompt (background)', () => {
  let mockDb: jest.Mocked<PokerChaseDB>
  let handCount: jest.Mock

  beforeEach(async () => {
    await chrome.storage.local.set({ [REVIEW_PROMPT_STORAGE_KEY]: undefined })
    jest.clearAllMocks()

    handCount = jest.fn()
    mockDb = { hands: { count: handCount } } as any
  })

  describe('evaluateReviewPromptVisibility', () => {
    it('累計ハンド数が閾値未満なら表示せず、状態も記録しない', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS - 1)

      expect(await evaluateReviewPromptVisibility(mockDb, NOW)).toBe(false)
      expect(await getReviewPromptState()).toEqual({})
    })

    it('閾値に到達したら表示し、eligibleSinceを記録する', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS)

      expect(await evaluateReviewPromptVisibility(mockDb, NOW)).toBe(true)
      expect(await getReviewPromptState()).toEqual({ eligibleSince: NOW })
    })

    it('一度eligibleになったら以降はハンド数を数え直さない（全データ削除後も降りない）', async () => {
      handCount.mockResolvedValue(REVIEW_PROMPT_MIN_HANDS)
      await evaluateReviewPromptVisibility(mockDb, NOW)
      handCount.mockClear()
      handCount.mockResolvedValue(0)

      expect(await evaluateReviewPromptVisibility(mockDb, NOW + 1)).toBe(true)
      expect(handCount).not.toHaveBeenCalled()
    })

    it('決着済みなら表示せず、DBへの問い合わせも行わない', async () => {
      await chrome.storage.local.set({
        [REVIEW_PROMPT_STORAGE_KEY]: { eligibleSince: NOW, resolution: 'rated', resolvedAt: NOW },
      })

      expect(await evaluateReviewPromptVisibility(mockDb, NOW + 1)).toBe(false)
      expect(handCount).not.toHaveBeenCalled()
    })

    it('スヌーズ中は表示せず、期間が明けたら再表示する', async () => {
      await chrome.storage.local.set({
        [REVIEW_PROMPT_STORAGE_KEY]: { eligibleSince: NOW, snoozedAt: NOW },
      })

      expect(await evaluateReviewPromptVisibility(mockDb, NOW + REVIEW_PROMPT_SNOOZE_MS - 1)).toBe(false)
      expect(await evaluateReviewPromptVisibility(mockDb, NOW + REVIEW_PROMPT_SNOOZE_MS)).toBe(true)
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
      expect(await evaluateReviewPromptVisibility(mockDb, NOW + 20)).toBe(false)
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
  })
})
