import { memo } from 'react'
import type { CSSProperties } from 'react'

/**
 * このHUDの開発者アカウントのPokerChase `UserId`。
 *
 * 「ヒーロー（自分）」ではなく特定のplayerIdに紐づける点が肝心 -- ヒーロー
 * 判定にすると拡張機能を入れた全ユーザーが自分自身にDEVバッジを見ることに
 * なる。playerId固定なので、他ユーザーのHUDでも同卓時に開発者席にだけ出る。
 *
 * 値の出典: 実キャプチャ由来のフィクスチャ（`src/utils/hand-log-processor.test.ts`
 * のsola席、`src/types/api.ts`のEVT_PLAYER_SEAT_ASSIGNED実ペイロード例）。
 */
export const DEVELOPER_PLAYER_IDS: ReadonlySet<number> = new Set([
  561384657, // sola
])

/** そのplayerIdがHUD開発者アカウントかどうか。 */
export const isDeveloperPlayer = (playerId: number | undefined): boolean =>
  playerId !== undefined && DEVELOPER_PLAYER_IDS.has(playerId)

export const DEVELOPER_BADGE_LABEL = 'DEV'
export const DEVELOPER_BADGE_TOOLTIP = 'PokerChase HUD 開発者'

const styles = {
  // 「離席」バッジ（Hud.tsx / HudHeader.tsx の dimmedBadge）と同じチップ語彙。
  // 10pxのヘッダーでは絵文字より文字チップの方が誤読がなく、左端の分類絵文字
  // （🦈💣🪨🐟🐳）と語彙が競合しない。
  //
  // position + zIndex は DragHandle（position:absolute, height:20px）が
  // ヘッダー行を覆っていてヒットテストを奪うため必須。これがないと `title`
  // ツールチップがホバーで出ない -- PlayerTypeIcons.tsx と同じ対処。
  developerBadge: {
    position: 'relative',
    zIndex: 1,
    fontSize: '8px',
    fontWeight: 'bold',
    color: '#ffcc66',
    border: '1px solid rgba(255, 204, 102, 0.5)',
    borderRadius: '3px',
    padding: '0 3px',
    letterSpacing: '0.2px',
    whiteSpace: 'nowrap' as const,
    lineHeight: 1.4,
    // 名前が長い時に縮む/省略されるのは名前側であってバッジではない。
    flexShrink: 0,
  } as CSSProperties,
}

interface DeveloperBadgeProps {
  playerId: number
}

/**
 * プレイヤー名の右に出る「HUD開発者」バッジ（sola承認仕様）。
 *
 * 対象外のplayerIdでは何も描画しない自己ゲート方式なので、呼び出し側は
 * 条件分岐なしに `<DeveloperBadge playerId={id} />` と置くだけでよい
 * （PlayerTypeIconsが分類不能時にnullを返すのと同じ形）。
 */
export const DeveloperBadge = memo(({ playerId }: DeveloperBadgeProps) => {
  if (!isDeveloperPlayer(playerId)) return null

  return (
    <span style={styles.developerBadge} title={DEVELOPER_BADGE_TOOLTIP} data-developer-badge="true">
      {DEVELOPER_BADGE_LABEL}
    </span>
  )
})

DeveloperBadge.displayName = 'DeveloperBadge'
