/**
 * options-storage: フラット`options`キーの読み書きと、
 * 旧@extend-chrome/storage bucketキーからのマイグレーションのテスト
 */
import { loadOptions, saveOptions, OPTIONS_STORAGE_KEY, type Options } from './options-storage'

const LEGACY_KEYS_KEY = 'extend-chrome/storage__options_keys'
const legacyKey = (field: string) => `extend-chrome/storage__options--${field}`

const sampleFilterOptions = {
  gameTypes: { sng: true, mtt: false, ring: true },
  handLimit: 200,
  statDisplayConfigs: [{ id: 'vpip', enabled: true, order: 1 }]
}

// test-setup.tsのchromeモックはモジュールスコープで状態を持つため、各テスト前に全キーを消す
const clearSyncStorage = async () => {
  const all = await chrome.storage.sync.get(null as any) as Record<string, any>
  const keys = Object.keys(all)
  if (keys.length > 0) {
    await chrome.storage.sync.remove(keys)
  }
}

describe('options-storage', () => {
  beforeEach(async () => {
    await clearSyncStorage()
    jest.clearAllMocks()
  })

  it('saveOptionsはフラットなoptionsキーへ書き込む', async () => {
    const options: Options = { sendUserData: true, filterOptions: sampleFilterOptions }
    await saveOptions(options)

    // Promise形式のget（test-setupモックは両形式対応）
    const result = await chrome.storage.sync.get(OPTIONS_STORAGE_KEY) as Record<string, any>
    expect(result[OPTIONS_STORAGE_KEY]).toEqual(options)
  })

  it('フラットキーのみ存在する場合はそのまま返す（マイグレーションなし）', async () => {
    const options: Options = { sendUserData: false, filterOptions: sampleFilterOptions }
    await chrome.storage.sync.set({ [OPTIONS_STORAGE_KEY]: options })

    const loaded = await loadOptions()

    expect(loaded).toEqual(options)
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled()
  })

  it('データが無い場合はundefinedを返す', async () => {
    await expect(loadOptions()).resolves.toBeUndefined()
  })

  it('旧bucketキーのみ存在する場合はフラットキーへ移行し旧キーを削除する', async () => {
    await chrome.storage.sync.set({
      [LEGACY_KEYS_KEY]: ['sendUserData', 'filterOptions'],
      [legacyKey('sendUserData')]: false,
      [legacyKey('filterOptions')]: sampleFilterOptions
    })

    const loaded = await loadOptions()

    expect(loaded).toEqual({ sendUserData: false, filterOptions: sampleFilterOptions })

    // フラットキーへ書き込まれ、旧キーは消えている（コールバック形式のgetで確認）
    const after = await new Promise<Record<string, any>>(resolve =>
      chrome.storage.sync.get(
        [OPTIONS_STORAGE_KEY, LEGACY_KEYS_KEY, legacyKey('sendUserData'), legacyKey('filterOptions')],
        resolve
      )
    )
    expect(after[OPTIONS_STORAGE_KEY]).toEqual({ sendUserData: false, filterOptions: sampleFilterOptions })
    expect(after[LEGACY_KEYS_KEY]).toBeUndefined()
    expect(after[legacyKey('sendUserData')]).toBeUndefined()
    expect(after[legacyKey('filterOptions')]).toBeUndefined()
  })

  it('フラットと旧bucketが両方ある場合はフラット優先でマージし旧キーを削除する', async () => {
    const flatFilterOptions = { ...sampleFilterOptions, handLimit: 500 }
    const legacyFilterOptions = { ...sampleFilterOptions, handLimit: 20 }
    await chrome.storage.sync.set({
      // message-routerの旧・部分書き込み形（sendUserData欠落）を再現
      [OPTIONS_STORAGE_KEY]: { filterOptions: flatFilterOptions },
      [LEGACY_KEYS_KEY]: ['sendUserData', 'filterOptions'],
      [legacyKey('sendUserData')]: false,
      [legacyKey('filterOptions')]: legacyFilterOptions
    })

    const loaded = await loadOptions()

    // filterOptionsはフラット側が勝ち、bucketにしか無いsendUserDataは拾われる
    expect(loaded).toEqual({ sendUserData: false, filterOptions: flatFilterOptions })

    const after = await chrome.storage.sync.get(null as any) as Record<string, any>
    expect(after[OPTIONS_STORAGE_KEY]).toEqual({ sendUserData: false, filterOptions: flatFilterOptions })
    expect(after[LEGACY_KEYS_KEY]).toBeUndefined()
    expect(after[legacyKey('sendUserData')]).toBeUndefined()
    expect(after[legacyKey('filterOptions')]).toBeUndefined()
  })

  it('2回目以降のloadOptionsはマイグレーションを再実行しない（冪等）', async () => {
    await chrome.storage.sync.set({
      [LEGACY_KEYS_KEY]: ['filterOptions'],
      [legacyKey('filterOptions')]: sampleFilterOptions
    })

    const first = await loadOptions()
    jest.clearAllMocks()
    const second = await loadOptions()

    expect(second).toEqual(first)
    expect(chrome.storage.sync.set).not.toHaveBeenCalled()
    expect(chrome.storage.sync.remove).not.toHaveBeenCalled()
  })
})
