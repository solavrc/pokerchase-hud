import { HUD_MUTED_TEXT_COLOR } from './hudColors'

const srgbChannelToLinear = (channel: number): number => {
  const normalized = channel / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = (hex: string): number => {
  const [red, green, blue] = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16))
  return (
    0.2126 * srgbChannelToLinear(red!) +
    0.7152 * srgbChannelToLinear(green!) +
    0.0722 * srgbChannelToLinear(blue!)
  )
}

const contrastRatio = (foreground: string, background: string): number => {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('HUD text contrast', () => {
  test('muted text meets WCAG AA on the bright representative normal-panel background', () => {
    // Conservative 95th-percentile bright background sampled from normal HUD
    // panels in docs/store-assets/store-1-hud.png. The old #888888 token was
    // only 2.61:1 here; #b8b8b8 is 4.67:1 while remaining below #dddddd.
    const representativeBrightPanelBackground = '#414946'

    expect(contrastRatio(HUD_MUTED_TEXT_COLOR, representativeBrightPanelBackground)).toBeGreaterThanOrEqual(4.5)
    expect(relativeLuminance(HUD_MUTED_TEXT_COLOR)).toBeLessThan(relativeLuminance('#dddddd'))
  })
})
