import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HudHeader } from './HudHeader'

describe('HudHeader', () => {
  it('プレイヤー名を表示', () => {
    render(<HudHeader playerName="TestPlayer" playerId={123} />)
    expect(screen.getByText('TestPlayer')).toBeInTheDocument()
  })

  it('プレイヤー名がない場合はプレイヤーIDを表示', () => {
    render(<HudHeader playerName={null} playerId={123} />)
    expect(screen.getByText('Player 123')).toBeInTheDocument()
  })

  it('ポットオッズを表示', () => {
    const playerPotOdds = {
      spr: 10.5,
      potOdds: {
        pot: 100,
        call: 20,
        percentage: 16.7,
        ratio: '5:1',
        isPlayerTurn: true,
      },
    }

    render(
      <HudHeader 
        playerName="TestPlayer" 
        playerId={123} 
        playerPotOdds={playerPotOdds} 
      />
    )

    expect(screen.getByText('100/20 (17%)')).toBeInTheDocument()
    expect(screen.getByText('SPR:10.5')).toBeInTheDocument()
  })

  it('プレイヤーのターンの場合はポットオッズがハイライトされる', () => {
    const playerPotOdds = {
      spr: 10.5,
      potOdds: {
        pot: 100,
        call: 20,
        percentage: 16.7,
        ratio: '5:1',
        isPlayerTurn: true,
      },
    }

    render(
      <HudHeader 
        playerName="TestPlayer" 
        playerId={123} 
        playerPotOdds={playerPotOdds} 
      />
    )

    const potOddsElement = screen.getByText('100/20 (17%)')
    expect(potOddsElement).toHaveStyle({ color: '#00ff00' })
  })

  it('プレイヤーのターンでない場合はポットオッズが通常色', () => {
    const playerPotOdds = {
      spr: 10.5,
      potOdds: {
        pot: 100,
        call: 20,
        percentage: 16.7,
        ratio: '5:1',
        isPlayerTurn: false,
      },
    }

    render(
      <HudHeader 
        playerName="TestPlayer" 
        playerId={123} 
        playerPotOdds={playerPotOdds} 
      />
    )

    const potOddsElement = screen.getByText('100/20 (17%)')
    expect(potOddsElement).toHaveStyle({ color: '#888' })
  })

  it('ポットオッズがない場合は表示しない', () => {
    render(<HudHeader playerName="TestPlayer" playerId={123} />)

    expect(screen.queryByText(/SPR:/)).not.toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
  })

  describe('ポジション別ドリルダウン・トリガー', () => {
    it('onTogglePositionalPanelが渡されない場合はトリガーを表示しない', () => {
      render(<HudHeader playerName="TestPlayer" playerId={123} />)
      expect(screen.queryByTitle('ポジション別スタッツ')).not.toBeInTheDocument()
    })

    it('onTogglePositionalPanelが渡された場合はトリガーを表示する', () => {
      render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onTogglePositionalPanel={jest.fn()}
        />
      )
      expect(screen.getByTitle('ポジション別スタッツ')).toBeInTheDocument()
    })

    it('クリックでonTogglePositionalPanelが呼ばれる', async () => {
      const handleToggle = jest.fn()
      render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onTogglePositionalPanel={handleToggle}
        />
      )

      await userEvent.click(screen.getByTitle('ポジション別スタッツ'))
      expect(handleToggle).toHaveBeenCalledTimes(1)
    })

    it('isPositionalPanelOpenに応じてaria-expandedとアイコンが変わる', () => {
      const { rerender } = render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={false}
        />
      )

      const trigger = screen.getByTitle('ポジション別スタッツ')
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(trigger).toHaveTextContent('▸')

      rerender(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onTogglePositionalPanel={jest.fn()}
          isPositionalPanelOpen={true}
        />
      )

      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      expect(trigger).toHaveTextContent('▾')
    })
  })
})