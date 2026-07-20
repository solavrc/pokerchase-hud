import {
  DARK_FELT_BACKGROUND,
  MODERN_LIGHT_BACKGROUND,
  POPUP_BOOT_LOCAL_STORAGE_KEY,
  resolveBootBackgroundColor,
} from './popup-boot-theme'
import { getPopupTheme } from './theme'
import { POPUP_THEME_LOCAL_STORAGE_KEY } from './popup-theme-storage'

// popup-boot-theme.ts deliberately duplicates its color/key constants
// instead of importing theme.ts / popup-theme-storage.ts (see its top
// comment -- importing either would pull in MUI's createTheme() work the
// boot script exists to run *before*). These two tests are the drift guard:
// if theme.ts's colors or popup-theme-storage.ts's localStorage key ever
// change without updating popup-boot-theme.ts to match, the white-flash fix
// silently regresses -- fail loudly here instead.
describe('popup-boot-theme drift guards', () => {
  it('DARK_FELT_BACKGROUND stays in sync with theme.ts', () => {
    expect(DARK_FELT_BACKGROUND).toBe(getPopupTheme('dark-felt').palette.background.default)
  })

  it('MODERN_LIGHT_BACKGROUND stays in sync with theme.ts', () => {
    expect(MODERN_LIGHT_BACKGROUND).toBe(getPopupTheme('modern-light').palette.background.default)
  })

  it('POPUP_BOOT_LOCAL_STORAGE_KEY stays in sync with popup-theme-storage.ts', () => {
    expect(POPUP_BOOT_LOCAL_STORAGE_KEY).toBe(POPUP_THEME_LOCAL_STORAGE_KEY)
  })
})

describe('resolveBootBackgroundColor', () => {
  it('明示的な dark 指定は OS のライト配色設定より優先される', () => {
    expect(resolveBootBackgroundColor('dark', false)).toBe(DARK_FELT_BACKGROUND)
  })

  it('明示的な light 指定は OS のダーク配色設定より優先される', () => {
    expect(resolveBootBackgroundColor('light', true)).toBe(MODERN_LIGHT_BACKGROUND)
  })

  it('未設定(null) + OSがダーク配色を優先 → ダークフェルトの背景色', () => {
    expect(resolveBootBackgroundColor(null, true)).toBe(DARK_FELT_BACKGROUND)
  })

  it('未設定(null) + OSがライト配色を優先 → モダンライトの背景色', () => {
    expect(resolveBootBackgroundColor(null, false)).toBe(MODERN_LIGHT_BACKGROUND)
  })

  it('壊れた/未知の値(auto以外の任意の文字列)は auto と同様にOS設定へフォールバックする', () => {
    expect(resolveBootBackgroundColor('sepia', true)).toBe(DARK_FELT_BACKGROUND)
    expect(resolveBootBackgroundColor('sepia', false)).toBe(MODERN_LIGHT_BACKGROUND)
  })
})
