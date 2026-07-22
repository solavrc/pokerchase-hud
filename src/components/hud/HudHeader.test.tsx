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

  it('ポットオッズをSPRより先に表示し、各値の対応を維持する', () => {
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

    const potOdds = screen.getByText('17%')
    const spr = screen.getByText('10.5')

    expect(potOdds).toBeInTheDocument()
    expect(spr).toBeInTheDocument()
    expect(screen.queryByText('100/20', { exact: false })).not.toBeInTheDocument()
    expect(screen.queryByText(/SPR:/)).not.toBeInTheDocument()
    expect(potOdds.compareDocumentPosition(spr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('ポットオッズとSPRの意味・式をhoverとkeyboard focusで説明できる', async () => {
    const user = userEvent.setup()
    render(
      <HudHeader
        playerName="TestPlayer"
        playerId={123}
        playerPotOdds={{
          spr: 10.5,
          potOdds: {
            pot: 100,
            call: 20,
            percentage: 16.7,
            ratio: '5:1',
            isPlayerTurn: true,
          },
        }}
      />
    )

    const potOddsTooltip = 'ポットオッズ: コールに必要な最低勝率。式: コール額 ÷（メインポット＋全サイドポット＋コール額）'
    const sprTooltip = 'SPR: このプレイヤーの残りスタックと現在のポット総額の比。式: 残りスタック ÷（メインポット＋全サイドポット）'
    const potOdds = screen.getByTitle(potOddsTooltip)
    const spr = screen.getByTitle(sprTooltip)

    expect(potOdds).toHaveAttribute('aria-label', `ポットオッズ 17%。${potOddsTooltip}`)
    expect(spr).toHaveAttribute('aria-label', `SPR 10.5。${sprTooltip}`)

    await user.tab()
    expect(potOdds).toHaveFocus()
    await user.tab()
    expect(spr).toHaveFocus()
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

    const potOddsElement = screen.getByText('17%')
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

    const potOddsElement = screen.getByText('17%')
    expect(potOddsElement).toHaveStyle({ color: '#b8b8b8' })
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

  describe('直近ハンド・ドリルダウン・トリガー', () => {
    it('onToggleRecentHandsPanelが渡されない場合はトリガーを表示しない', () => {
      render(<HudHeader playerName="TestPlayer" playerId={123} />)
      expect(screen.queryByTitle('直近ハンド')).not.toBeInTheDocument()
    })

    it('onToggleRecentHandsPanelが渡された場合はトリガーを表示する', () => {
      render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onToggleRecentHandsPanel={jest.fn()}
        />
      )
      expect(screen.getByTitle('直近ハンド')).toBeInTheDocument()
    })

    it('クリックでonToggleRecentHandsPanelが呼ばれる', async () => {
      const handleToggle = jest.fn()
      render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onToggleRecentHandsPanel={handleToggle}
        />
      )

      await userEvent.click(screen.getByTitle('直近ハンド'))
      expect(handleToggle).toHaveBeenCalledTimes(1)
    })

    it('isRecentHandsPanelOpenに応じてaria-expandedが変わり、対応パネルをaria-controlsで示す', () => {
      const { rerender } = render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onToggleRecentHandsPanel={jest.fn()}
          isRecentHandsPanelOpen={false}
        />
      )

      const trigger = screen.getByTitle('直近ハンド')
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(trigger).toHaveAttribute('aria-controls', 'recent-hands-panel-123')

      rerender(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onToggleRecentHandsPanel={jest.fn()}
          isRecentHandsPanelOpen={true}
        />
      )

      expect(trigger).toHaveAttribute('aria-expanded', 'true')
    })

    it('native buttonとしてキーボードのEnterで開閉できる', async () => {
      const handleToggle = jest.fn()
      render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onToggleRecentHandsPanel={handleToggle}
        />
      )

      const trigger = screen.getByTitle('直近ハンド')
      trigger.focus()
      await userEvent.keyboard('{Enter}')

      expect(handleToggle).toHaveBeenCalledTimes(1)
    })

    it('両トリガーが同時に表示されても独立している', async () => {
      const handlePositional = jest.fn()
      const handleRecentHands = jest.fn()
      render(
        <HudHeader
          playerName="TestPlayer"
          playerId={123}
          onTogglePositionalPanel={handlePositional}
          onToggleRecentHandsPanel={handleRecentHands}
        />
      )

      expect(screen.getByTitle('ポジション別スタッツ')).toBeInTheDocument()
      expect(screen.getByTitle('直近ハンド')).toBeInTheDocument()

      await userEvent.click(screen.getByTitle('直近ハンド'))
      expect(handleRecentHands).toHaveBeenCalledTimes(1)
      expect(handlePositional).not.toHaveBeenCalled()
    })
  })
})
