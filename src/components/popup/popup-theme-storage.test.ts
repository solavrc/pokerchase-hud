import {
  loadPopupThemeMode,
  savePopupThemeMode,
  POPUP_THEME_STORAGE_KEY,
  POPUP_THEME_LOCAL_STORAGE_KEY,
} from './popup-theme-storage'

// global.chrome.storage.sync mock backed by src/test-setup.ts (chromeStorageMockData.sync),
// reset between tests via chrome.storage.sync.remove.

describe('popup-theme-storage', () => {
  afterEach(async () => {
    await new Promise<void>((resolve) => chrome.storage.sync.remove(POPUP_THEME_STORAGE_KEY, () => resolve()))
    window.localStorage.removeItem(POPUP_THEME_LOCAL_STORAGE_KEY)
  })

  it('未設定（新規インストール/移行前）は auto にフォールバックする', async () => {
    const mode = await loadPopupThemeMode()
    expect(mode).toBe('auto')
  })

  it('壊れた/未知の値も auto にフォールバックする（防御的）', async () => {
    await new Promise<void>((resolve) => chrome.storage.sync.set({ [POPUP_THEME_STORAGE_KEY]: 'sepia' }, () => resolve()))
    const mode = await loadPopupThemeMode()
    expect(mode).toBe('auto')
  })

  it('保存した値をそのまま読み戻せる（永続化のラウンドトリップ）', async () => {
    await savePopupThemeMode('dark')
    expect(await loadPopupThemeMode()).toBe('dark')

    await savePopupThemeMode('light')
    expect(await loadPopupThemeMode()).toBe('light')

    await savePopupThemeMode('auto')
    expect(await loadPopupThemeMode()).toBe('auto')
  })

  it('uiConfig とは独立した専用キーに書き込む（HUDタブへのbroadcastを発生させないため）', async () => {
    await savePopupThemeMode('dark')
    const result = await new Promise<Record<string, unknown>>((resolve) =>
      chrome.storage.sync.get(null, resolve)
    )
    expect(result[POPUP_THEME_STORAGE_KEY]).toBe('dark')
    expect(result.uiConfig).toBeUndefined()
  })

  describe('localStorage ミラー（popup-boot.ts が次回起動時に同期的に読む）', () => {
    it('savePopupThemeMode は localStorage にも同じ値を書き込む', async () => {
      await savePopupThemeMode('dark')
      expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('dark')

      await savePopupThemeMode('light')
      expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('light')

      await savePopupThemeMode('auto')
      expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('auto')
    })

    it('loadPopupThemeMode は chrome.storage.sync の値で localStorage をバックフィルする（例: 別デバイスからの同期）', async () => {
      expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBeNull()
      await new Promise<void>((resolve) => chrome.storage.sync.set({ [POPUP_THEME_STORAGE_KEY]: 'light' }, () => resolve()))

      await loadPopupThemeMode()

      expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('light')
    })

    it('壊れた/未知の値も auto として localStorage にバックフィルされる', async () => {
      await new Promise<void>((resolve) => chrome.storage.sync.set({ [POPUP_THEME_STORAGE_KEY]: 'sepia' }, () => resolve()))

      const mode = await loadPopupThemeMode()

      expect(mode).toBe('auto')
      expect(window.localStorage.getItem(POPUP_THEME_LOCAL_STORAGE_KEY)).toBe('auto')
    })
  })
})
