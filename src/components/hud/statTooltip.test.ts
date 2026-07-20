import { composeStatTitle } from './statTooltip'

// composeStatTitleはdefaultRegistryからhelpTextを引くため、実レジストリ
// (../../stats経由で自動登録される本物のvpip/vpipF定義)を使う。

describe('composeStatTitle', () => {
  it('helpTextのみ（動的tooltipなし）: 名前+値の行の次にhelpTextを続ける', () => {
    const title = composeStatTitle('vpip', 'VPIP', '30.0% (30/100)', undefined)
    expect(title).toBe('VPIP: 30.0% (30/100)\n自発的にチップをポットに入れたハンドの割合(ウォーク除外)')
  })

  it('helpText + 動的tooltip: 動的tooltipを基底行として使い、helpTextを続ける（vpipFの例）', () => {
    const dynamicTooltip = 'VPIP·F 35.2% (n=1252) | 4p 47.0% (n=279) | 3p 56.1% (n=221) | HU 71.9% (n=146)'
    const title = composeStatTitle('vpipF', 'VPIP·F', '35.2% (n=1252)', dynamicTooltip)
    expect(title).toBe(
      'VPIP·F 35.2% (n=1252) | 4p 47.0% (n=279) | 3p 56.1% (n=221) | HU 71.9% (n=146)\n' +
      '全員着席したテーブルに限定したVPIP。テーブルが縮小するほどVPIPは自然に上がるため、比較しやすいよう絞った指標'
    )
  })

  it('未知の統計ID（helpTextなし）: 名前+値の行のみ', () => {
    const title = composeStatTitle('unknownStat', 'XYZ', '1', undefined)
    expect(title).toBe('XYZ: 1')
  })

  it('IDが空文字（statResult未定義のフォールバックケース）でも壊れない', () => {
    const title = composeStatTitle('', 'Invalid', '-', undefined)
    expect(title).toBe('Invalid: -')
  })
})
