/**
 * recent-hands-config tests (#341)
 *
 * 「直近ハンド」パネルの件数設定。読み書きが常にフェイルオープンすること
 * （不正値・未設定・ストレージ不在で既定値へ倒れ、例外を投げない）と、
 * 他パネル／他タブの変更を購読できることを固定する。
 */
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  MAX_RECENT_HANDS_LIMIT,
  RECENT_HANDS_LIMIT_OPTIONS,
  RECENT_HANDS_LIMIT_STORAGE_KEY,
  isValidRecentHandsLimit,
  loadRecentHandsLimit,
  resolveRecentHandsLimit,
  saveRecentHandsLimit,
  subscribeRecentHandsLimit,
} from './recent-hands-config'

describe('recent-hands-config', () => {
  afterEach(async () => {
    await chrome.storage.local.remove(RECENT_HANDS_LIMIT_STORAGE_KEY)
  })

  describe('選択肢の整合性', () => {
    test('既定値と最大値は選択肢に含まれる', () => {
      expect(RECENT_HANDS_LIMIT_OPTIONS).toContain(DEFAULT_RECENT_HANDS_LIMIT)
      expect(RECENT_HANDS_LIMIT_OPTIONS).toContain(MAX_RECENT_HANDS_LIMIT)
      expect(MAX_RECENT_HANDS_LIMIT).toBe(Math.max(...RECENT_HANDS_LIMIT_OPTIONS))
    })

    test('選択肢は昇順で重複しない', () => {
      const sorted = [...RECENT_HANDS_LIMIT_OPTIONS].sort((a, b) => a - b)
      expect(RECENT_HANDS_LIMIT_OPTIONS).toEqual(sorted)
      expect(new Set(RECENT_HANDS_LIMIT_OPTIONS).size).toBe(RECENT_HANDS_LIMIT_OPTIONS.length)
    })
  })

  describe('検証', () => {
    test('選択肢の値だけを受け付ける', () => {
      RECENT_HANDS_LIMIT_OPTIONS.forEach(option => {
        expect(isValidRecentHandsLimit(option)).toBe(true)
      })
      expect(isValidRecentHandsLimit(7)).toBe(false)
      expect(isValidRecentHandsLimit(0)).toBe(false)
      expect(isValidRecentHandsLimit(-25)).toBe(false)
      expect(isValidRecentHandsLimit('25')).toBe(false)
      expect(isValidRecentHandsLimit(null)).toBe(false)
      expect(isValidRecentHandsLimit(undefined)).toBe(false)
      expect(isValidRecentHandsLimit(Number.NaN)).toBe(false)
    })

    test('不正値は既定値へ倒す', () => {
      expect(resolveRecentHandsLimit(50)).toBe(50)
      expect(resolveRecentHandsLimit(7)).toBe(DEFAULT_RECENT_HANDS_LIMIT)
      expect(resolveRecentHandsLimit(undefined)).toBe(DEFAULT_RECENT_HANDS_LIMIT)
    })
  })

  describe('読み書き', () => {
    test('未設定なら既定値', async () => {
      await expect(loadRecentHandsLimit()).resolves.toBe(DEFAULT_RECENT_HANDS_LIMIT)
    })

    test('保存した値を読み戻せる', async () => {
      saveRecentHandsLimit(100)
      await expect(loadRecentHandsLimit()).resolves.toBe(100)
    })

    test('選択肢にない値は保存しない', async () => {
      saveRecentHandsLimit(100)
      saveRecentHandsLimit(7)
      // 7は書かれていないので、直前の100がそのまま残る。
      await expect(loadRecentHandsLimit()).resolves.toBe(100)
    })

    test('壊れた値が保存されていても既定値へ倒れる（例外を投げない）', async () => {
      await chrome.storage.local.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 'とても多く' })
      await expect(loadRecentHandsLimit()).resolves.toBe(DEFAULT_RECENT_HANDS_LIMIT)
    })

    test('storage読み取りが失敗しても既定値を返す', async () => {
      const original = chrome.storage.local.get
      ;(chrome.storage.local as any).get = jest.fn(() => Promise.reject(new Error('no storage')))
      await expect(loadRecentHandsLimit()).resolves.toBe(DEFAULT_RECENT_HANDS_LIMIT)
      ;(chrome.storage.local as any).get = original
    })

    test('storage書き込みが失敗しても例外を投げない', () => {
      const original = chrome.storage.local.set
      ;(chrome.storage.local as any).set = jest.fn(() => { throw new Error('quota') })
      expect(() => saveRecentHandsLimit(50)).not.toThrow()
      ;(chrome.storage.local as any).set = original
    })
  })

  describe('購読', () => {
    test('localの当該キー変更だけを通知し、解除できる', async () => {
      const onChange = jest.fn()
      const unsubscribe = subscribeRecentHandsLimit(onChange)

      await chrome.storage.local.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 50 })
      expect(onChange).toHaveBeenCalledWith(50)

      onChange.mockClear()
      await chrome.storage.local.set({ someOtherKey: 1 })
      expect(onChange).not.toHaveBeenCalled()

      // syncエリアの同名キーは対象外（保存先はlocalのみ）。
      await chrome.storage.sync.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 10 })
      expect(onChange).not.toHaveBeenCalled()
      await chrome.storage.sync.remove(RECENT_HANDS_LIMIT_STORAGE_KEY)

      unsubscribe()
      await chrome.storage.local.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 10 })
      expect(onChange).not.toHaveBeenCalled()
    })

    test('壊れた新値は既定値として通知する', async () => {
      const onChange = jest.fn()
      const unsubscribe = subscribeRecentHandsLimit(onChange)
      await chrome.storage.local.set({ [RECENT_HANDS_LIMIT_STORAGE_KEY]: 'x' })
      expect(onChange).toHaveBeenCalledWith(DEFAULT_RECENT_HANDS_LIMIT)
      unsubscribe()
    })
  })
})
