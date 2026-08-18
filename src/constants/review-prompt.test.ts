/**
 * review-promptの純粋ロジック（src/constants/review-prompt.ts）の単体テスト。
 *
 * URL組み立て、storage値の正規化（壊れた値で例外を投げず、記録済みの決着も
 * 暗黙に失わない）、スヌーズ期間と時計ずれ境界を含む表示状態機械を検証する。
 */
import {
  buildChromeWebStoreReviewUrl,
  isReviewPromptVisible,
  parseReviewPromptState,
  REVIEW_PROMPT_SNOOZE_MS,
  type ReviewPromptState,
} from './review-prompt'

const NOW = 1_800_000_000_000

describe('buildChromeWebStoreReviewUrl', () => {
  it('拡張機能IDからレビュータブのURLを組み立てる（slugは含めない）', () => {
    expect(buildChromeWebStoreReviewUrl('ffkgffhokobiegbodhhbfannffpgakhi'))
      .toBe('https://chromewebstore.google.com/detail/ffkgffhokobiegbodhhbfannffpgakhi/reviews')
  })
})

describe('parseReviewPromptState', () => {
  it('未設定/非オブジェクトは空の状態として扱う', () => {
    expect(parseReviewPromptState(undefined)).toEqual({})
    expect(parseReviewPromptState(null)).toEqual({})
    expect(parseReviewPromptState('rated')).toEqual({})
    expect(parseReviewPromptState(42)).toEqual({})
  })

  it('既知のフィールドだけを型チェックして拾う', () => {
    expect(parseReviewPromptState({
      eligibleSince: NOW,
      snoozedAt: NOW + 1,
      resolution: 'rated',
      resolvedAt: NOW + 2,
      somethingElse: 'ignored',
    })).toEqual({
      eligibleSince: NOW,
      snoozedAt: NOW + 1,
      resolution: 'rated',
      resolvedAt: NOW + 2,
    })
  })

  it('壊れた値は捨てる（例外を投げない）', () => {
    expect(parseReviewPromptState({
      eligibleSince: 'yesterday',
      snoozedAt: Number.NaN,
      resolution: 'maybe',
      resolvedAt: NOW,
    })).toEqual({})
  })

  it('resolutionが不正ならresolvedAtも拾わない（決着扱いにしない）', () => {
    const parsed = parseReviewPromptState({ resolution: null, resolvedAt: NOW })
    expect(parsed.resolution).toBeUndefined()
    expect(parsed.resolvedAt).toBeUndefined()
  })
})

describe('isReviewPromptVisible', () => {
  const eligible: ReviewPromptState = { eligibleSince: NOW - 1000 }

  it('表示条件未達（eligibleSince未設定）なら表示しない', () => {
    expect(isReviewPromptVisible({}, NOW)).toBe(false)
  })

  it('表示条件を満たし、スヌーズも決着も無ければ表示する', () => {
    expect(isReviewPromptVisible(eligible, NOW)).toBe(true)
  })

  it.each(['rated', 'dismissed'] as const)('決着済み(%s)なら二度と表示しない', (resolution) => {
    expect(isReviewPromptVisible({ ...eligible, resolution, resolvedAt: NOW - 1 }, NOW)).toBe(false)
    // スヌーズ期間が明けていても決着が優先される
    expect(isReviewPromptVisible(
      { ...eligible, resolution, snoozedAt: NOW - REVIEW_PROMPT_SNOOZE_MS * 2 },
      NOW
    )).toBe(false)
  })

  it('スヌーズ期間中は表示しない', () => {
    expect(isReviewPromptVisible({ ...eligible, snoozedAt: NOW }, NOW)).toBe(false)
    expect(isReviewPromptVisible(
      { ...eligible, snoozedAt: NOW - REVIEW_PROMPT_SNOOZE_MS + 1 },
      NOW
    )).toBe(false)
  })

  it('スヌーズ期間が明けたら再表示する（境界値は表示側）', () => {
    expect(isReviewPromptVisible(
      { ...eligible, snoozedAt: NOW - REVIEW_PROMPT_SNOOZE_MS },
      NOW
    )).toBe(true)
  })

  it('未来のsnoozedAt（時計の巻き戻し等）は非表示側に倒す', () => {
    expect(isReviewPromptVisible({ ...eligible, snoozedAt: NOW + 60_000 }, NOW)).toBe(false)
  })

  it('未来のeligibleSince（時計の巻き戻し等）は非表示側に倒す', () => {
    expect(isReviewPromptVisible({ eligibleSince: NOW + 60_000 }, NOW)).toBe(false)
  })
})
