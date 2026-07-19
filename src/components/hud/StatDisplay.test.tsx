import { render, screen } from '@testing-library/react'
import { StatDisplay } from './StatDisplay'
import type { StatResult } from '../../types/stats'

describe('StatDisplay', () => {
  const mockFormatValue = (value: number | [number, number]): string => {
    if (Array.isArray(value)) {
      const [top, bottom] = value
      const stat = top / bottom
      if (Number.isNaN(stat) || !Number.isFinite(stat)) return '-'
      return `${(Math.round(stat * 1000) / 10).toFixed(1)}% (${top}/${bottom})`
    }
    return String(value)
  }

  const mockDisplayStats: Array<[string, any, StatResult?]> = [
    ['VPIP', [30, 100], { id: 'vpip', name: 'VPIP', value: [30, 100], formatted: '30.0% (30/100)' }],
    ['PFR', [20, 100], { id: 'pfr', name: 'PFR', value: [20, 100], formatted: '20.0% (20/100)' }],
    ['3B', [5, 50], { id: '3bet', name: '3B', value: [5, 50], formatted: '10.0% (5/50)' }],
    ['Hands', 100, { id: 'hands', name: 'Hands', value: 100, formatted: '100' }],
  ]

  it('統計を2列のグリッドで表示', () => {
    render(<StatDisplay displayStats={mockDisplayStats} formatValue={mockFormatValue} />)

    // 統計名（コロン付き）
    expect(screen.getByText('VPIP:')).toBeInTheDocument()
    expect(screen.getByText('PFR:')).toBeInTheDocument()
    expect(screen.getByText('3B:')).toBeInTheDocument()
    expect(screen.getByText('Hands:')).toBeInTheDocument()

    // フォーマット済みの値が優先される
    expect(screen.getByText('30.0% (30/100)')).toBeInTheDocument()
    expect(screen.getByText('20.0% (20/100)')).toBeInTheDocument()
    expect(screen.getByText('10.0% (5/50)')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('formatValue関数を使用して値をフォーマット', () => {
    const statsWithoutFormatted: Array<[string, any, StatResult?]> = [
      ['VPIP', [30, 100], undefined],
      ['Hands', 100, undefined],
    ]

    render(<StatDisplay displayStats={statsWithoutFormatted} formatValue={mockFormatValue} />)

    expect(screen.getByText('VPIP:')).toBeInTheDocument()
    expect(screen.getByText('Hands:')).toBeInTheDocument()
    expect(screen.getByText('30.0% (30/100)')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
  })

  it('空の統計配列の場合は何も表示しない', () => {
    const { container } = render(<StatDisplay displayStats={[]} formatValue={mockFormatValue} />)
    
    // 統計グリッドは存在するが、中身は空
    const statGrid = container.querySelector('div[style*="display: grid"]')
    expect(statGrid).toBeInTheDocument()
    expect(statGrid?.children.length).toBe(0)
  })

  it('奇数個の統計も正しく表示', () => {
    const oddStats: Array<[string, any, StatResult?]> = [
      ['VPIP', [30, 100], { id: 'vpip', name: 'VPIP', value: [30, 100], formatted: '30.0% (30/100)' }],
      ['PFR', [20, 100], { id: 'pfr', name: 'PFR', value: [20, 100], formatted: '20.0% (20/100)' }],
      ['3B', [5, 50], { id: '3bet', name: '3B', value: [5, 50], formatted: '10.0% (5/50)' }],
    ]

    render(<StatDisplay displayStats={oddStats} formatValue={mockFormatValue} />)

    expect(screen.getByText('VPIP:')).toBeInTheDocument()
    expect(screen.getByText('PFR:')).toBeInTheDocument()
    expect(screen.getByText('3B:')).toBeInTheDocument()
  })

  it('NaNやInfinityの値は"-"として表示', () => {
    const invalidStats: Array<[string, any, StatResult?]> = [
      ['Invalid', [0, 0], undefined], // 0/0 = NaN
      ['Infinite', [1, 0], undefined], // 1/0 = Infinity
    ]

    render(<StatDisplay displayStats={invalidStats} formatValue={mockFormatValue} />)

    expect(screen.getByText('Invalid:')).toBeInTheDocument()
    expect(screen.getByText('Infinite:')).toBeInTheDocument()
    const dashes = screen.getAllByText('-')
    expect(dashes).toHaveLength(2)
  })

  describe('カラーコーディング', () => {
    it('colorCoding未指定時は色を適用しない（デフォルトのstatValue色のまま）', () => {
      render(<StatDisplay displayStats={mockDisplayStats} formatValue={mockFormatValue} />)

      const vpipValue = screen.getByText('30.0% (30/100)')
      expect(vpipValue).toHaveStyle({ color: '#dddddd' })
    })

    it('colorCoding有効時はしきい値に応じた色を適用する（n>=20）', () => {
      const highVpip: Array<[string, any, StatResult?]> = [
        ['VPIP', [45, 100], { id: 'vpip', name: 'VPIP', value: [45, 100], formatted: '45.0% (45/100)' }],
      ]

      render(<StatDisplay displayStats={highVpip} formatValue={mockFormatValue} colorCoding />)

      expect(screen.getByText('45.0% (45/100)')).toHaveStyle({ color: '#e57373' })
    })

    it('colorCoding有効でもn<20の場合は低信頼度グレーになる', () => {
      const lowSample: Array<[string, any, StatResult?]> = [
        ['VPIP', [5, 10], { id: 'vpip', name: 'VPIP', value: [5, 10], formatted: '50.0% (5/10)' }],
      ]

      render(<StatDisplay displayStats={lowSample} formatValue={mockFormatValue} colorCoding />)

      expect(screen.getByText('50.0% (5/10)')).toHaveStyle({ color: '#888888' })
    })

    it('しきい値ルールのない統計はcolorCoding有効でも既定色のまま', () => {
      const handsOnly: Array<[string, any, StatResult?]> = [
        ['Hands', 100, { id: 'hands', name: 'Hands', value: 100, formatted: '100' }],
      ]

      render(<StatDisplay displayStats={handsOnly} formatValue={mockFormatValue} colorCoding />)

      expect(screen.getByText('100')).toHaveStyle({ color: '#dddddd' })
    })
  })

  describe('title tooltip合成（#143）', () => {
    it('helpTextのみ（動的tooltipなし）: "統計名: 値"の次にhelpTextを続ける', () => {
      const stats: Array<[string, any, StatResult?]> = [
        ['VPIP', [30, 100], { id: 'vpip', name: 'VPIP', value: [30, 100], formatted: '30.0% (30/100)' }],
      ]

      render(<StatDisplay displayStats={stats} formatValue={mockFormatValue} />)

      const expectedTitle = 'VPIP: 30.0% (30/100)\n自発的にチップをポットに入れたハンドの割合(ウォーク除外)'
      expect(screen.getByText('VPIP:')).toHaveAttribute('title', expectedTitle)
      expect(screen.getByText('30.0% (30/100)')).toHaveAttribute('title', expectedTitle)
    })

    it('helpText + 動的tooltip: 動的tooltipを基底行にしてhelpTextを続ける（vpipFの例）', () => {
      const dynamicTooltip = 'VPIP·F 35.2% (n=1252) | 4p 47.0% (n=279) | 3p 56.1% (n=221) | HU 71.9% (n=146)'
      const stats: Array<[string, any, StatResult?]> = [
        ['VPIP·F', [441, 1252], {
          id: 'vpipF',
          name: 'VPIP·F',
          value: [441, 1252],
          formatted: '35.2% (n=1252)',
          tooltip: dynamicTooltip,
        }],
      ]

      render(<StatDisplay displayStats={stats} formatValue={mockFormatValue} />)

      const expectedTitle = `${dynamicTooltip}\n全員着席した卓に限定したVPIP。卓が縮小するほどVPIPは自然に上がるため、比較しやすいよう絞った指標(HUD独自指標)`
      expect(screen.getByText('35.2% (n=1252)')).toHaveAttribute('title', expectedTitle)
    })
  })
})