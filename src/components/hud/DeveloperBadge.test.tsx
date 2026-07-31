import { render, screen } from '@testing-library/react'
import { DeveloperBadge, DEVELOPER_PLAYER_IDS, isDeveloperPlayer } from './DeveloperBadge'

const DEVELOPER_PLAYER_ID = 561384657

describe('DeveloperBadge', () => {
  describe('isDeveloperPlayer', () => {
    it('開発者アカウントのplayerIdでtrue', () => {
      expect(isDeveloperPlayer(DEVELOPER_PLAYER_ID)).toBe(true)
      expect(DEVELOPER_PLAYER_IDS.has(DEVELOPER_PLAYER_ID)).toBe(true)
    })

    it('それ以外のplayerIdでfalse', () => {
      expect(isDeveloperPlayer(583654032)).toBe(false)
      expect(isDeveloperPlayer(0)).toBe(false)
      // 空席センチネル（EMPTY_SEAT_ID）や未定義でも落ちない
      expect(isDeveloperPlayer(-1)).toBe(false)
      expect(isDeveloperPlayer(undefined)).toBe(false)
    })
  })

  it('開発者アカウントではDEVチップとツールチップを表示', () => {
    render(<DeveloperBadge playerId={DEVELOPER_PLAYER_ID} />)

    const badge = screen.getByText('DEV')
    expect(badge).toHaveAttribute('title', 'PokerChase HUD 開発者')
    // 名前が長い時に縮むのは名前側であってバッジではない
    expect(badge).toHaveStyle({ flexShrink: 0 })
    // DragHandleのオーバーレイに隠れるとtitleがホバーで出ない（PlayerTypeIcons同様）
    expect(badge).toHaveStyle({ position: 'relative', zIndex: 1 })
  })

  it('対象外のplayerIdでは何も描画しない', () => {
    const { container } = render(<DeveloperBadge playerId={583654032} />)
    expect(container).toBeEmptyDOMElement()
  })
})
