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
})