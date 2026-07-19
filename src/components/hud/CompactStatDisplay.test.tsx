import { render, screen } from '@testing-library/react'
import { CompactStatDisplay } from './CompactStatDisplay'
import type { StatResult } from '../../types/stats'

describe('CompactStatDisplay', () => {
  const buildDisplayStats = (overrides: Partial<Record<string, StatResult>> = {}): Array<[string, any, StatResult?]> => {
    const defaults: Record<string, StatResult> = {
      vpip: { id: 'vpip', name: 'VPIP', value: [30, 100], formatted: '30.0% (30/100)' },
      pfr: { id: 'pfr', name: 'PFR', value: [20, 100], formatted: '20.0% (20/100)' },
      '3bet': { id: '3bet', name: '3B', value: [8, 100], formatted: '8.0% (8/100)' },
      hands: { id: 'hands', name: 'HAND', value: 67, formatted: '67' },
      af: { id: 'af', name: 'AF', value: [30, 10], formatted: '3.00 (30/10)' },
      cbet: { id: 'cbet', name: 'CB', value: [12, 20], formatted: '60.0% (12/20)' },
      steal: { id: 'steal', name: 'STL', value: [0, 0], formatted: '-' },
    }
    const merged = { ...defaults, ...overrides }
    return Object.entries(merged).map(([id, statResult]) => [statResult?.name || id, statResult?.value, statResult])
  }

  it('クラシックライン (VPIP/PFR/3B (HAND)) を丸めた整数で表示', () => {
    render(<CompactStatDisplay displayStats={buildDisplayStats()} />)

    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('(67)')).toBeInTheDocument()
  })

  it('機会数0の副次スタッツ（分母0）は行ごと表示から除外される', () => {
    render(<CompactStatDisplay displayStats={buildDisplayStats()} />)

    // steal は分母0なので STL: 行が出ない
    expect(screen.queryByText('STL:')).not.toBeInTheDocument()
    // af/cbetは機会があるので表示される
    expect(screen.getByText('AF:')).toBeInTheDocument()
    expect(screen.getByText('CB:')).toBeInTheDocument()
  })

  it('機会がない場合クラシックラインの個別セグメントは"-"にフォールバックする', () => {
    render(
      <CompactStatDisplay
        displayStats={buildDisplayStats({ vpip: { id: 'vpip', name: 'VPIP', value: [0, 0], formatted: '-' } })}
      />
    )

    expect(screen.getByText('-')).toBeInTheDocument()
  })

  it('colorCoding未指定時は色を適用しない', () => {
    render(<CompactStatDisplay displayStats={buildDisplayStats()} />)

    const vpipSegment = screen.getByText('30')
    expect(vpipSegment).not.toHaveStyle({ color: '#e57373' })
  })

  it('colorCoding有効時はしきい値に応じて色を適用する（n>=20のみ）', () => {
    render(
      <CompactStatDisplay
        displayStats={buildDisplayStats({
          vpip: { id: 'vpip', name: 'VPIP', value: [45, 100], formatted: '45.0% (45/100)' }, // >40% -> red, n=100>=20
        })}
        colorCoding
      />
    )

    const vpipSegment = screen.getByText('45')
    expect(vpipSegment).toHaveStyle({ color: '#e57373' })
  })

  it('colorCoding有効でもn<20の場合は低信頼度グレーになる', () => {
    render(
      <CompactStatDisplay
        displayStats={buildDisplayStats({
          vpip: { id: 'vpip', name: 'VPIP', value: [5, 10], formatted: '50.0% (5/10)' }, // n=10 < 20
        })}
        colorCoding
      />
    )

    const vpipSegment = screen.getByText('50')
    expect(vpipSegment).toHaveStyle({ color: '#888888' })
  })

  it('各セグメントに統計名+値+一言説明を含むtitleが付与される', () => {
    render(<CompactStatDisplay displayStats={buildDisplayStats()} />)

    const vpipSegment = screen.getByText('30')
    expect(vpipSegment).toHaveAttribute(
      'title',
      'VPIP: 30.0% (30/100)\n自発的にチップをポットに入れたハンドの割合(ウォーク除外)'
    )

    const handSegment = screen.getByText('(67)')
    expect(handSegment).toHaveAttribute(
      'title',
      'HAND: 67\nこれまでにプレイしたハンド数'
    )
  })
})
