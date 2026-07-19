import { resolvePopupThemeVariant, getPopupTheme, DEFAULT_POPUP_THEME_MODE } from './theme'

describe('resolvePopupThemeVariant', () => {
  it('デフォルトは自動(auto)', () => {
    expect(DEFAULT_POPUP_THEME_MODE).toBe('auto')
  })

  it('auto + OSがダーク配色を優先 → ダークフェルトを解決する', () => {
    expect(resolvePopupThemeVariant('auto', true)).toBe('dark-felt')
  })

  it('auto + OSがライト配色を優先 → モダンライトを解決する', () => {
    expect(resolvePopupThemeVariant('auto', false)).toBe('modern-light')
  })

  it('明示的な light 指定は OS のダーク配色設定より優先される', () => {
    expect(resolvePopupThemeVariant('light', true)).toBe('modern-light')
  })

  it('明示的な dark 指定は OS のライト配色設定より優先される', () => {
    expect(resolvePopupThemeVariant('dark', false)).toBe('dark-felt')
  })
})

describe('getPopupTheme', () => {
  it('dark-felt はダークパレットのMUIテーマを返す', () => {
    const theme = getPopupTheme('dark-felt')
    expect(theme.palette.mode).toBe('dark')
  })

  it('modern-light はライトパレットのMUIテーマを返す', () => {
    const theme = getPopupTheme('modern-light')
    expect(theme.palette.mode).toBe('light')
  })
})
