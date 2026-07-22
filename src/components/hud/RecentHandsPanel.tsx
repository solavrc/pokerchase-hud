import { memo, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Position } from '../../types/game'
import type { RecentHandEntry, RecentHandsResult } from '../../types/stats'
import type { GetRecentHandsMessage, RecentHandsResponse, ErrorResponse } from '../../types/messages'
import { sendMessageWithTimeout } from '../popup/send-message'
import { isRedSuit } from '../../utils/card-utils'
import { HUD_MUTED_TEXT_COLOR } from './hudColors'

interface RecentHandsPanelProps {
  playerId: number
  /**
   * 生きたハンドが1件完了するたびに増える「hand epoch」（App.tsx/Hud.tsx参照、
   * 監査指摘11 P2「開いたドリルダウンパネルが無期限に古くなる」対応）。
   * playerIdと一緒にフェッチeffectのdepsへ入れることで、このパネルを開いた
   * ままにしていても新しいハンドが終わるたびに1回だけ再フェッチする
   * （実況の1アクションごとの更新ではこの値は変化しないため再フェッチ
   * ストームは起きない）。バックエンド側の30秒キャッシュも同じイベントで
   * 無効化される（recent-hands-service.tsのsubscribeToHandCompletion参照）
   * ので、この再フェッチは古いキャッシュ結果を受け取らない。
   */
  handEpoch?: number
}

type FetchStatus = 'loading' | 'ready' | 'error'

// #128のポジション別ドリルダウンと同じ考え方: 対局中のリアルタイムオーバーレイ
// のため、popup既定の8sより短いタイムアウトでフェイルオープンする。
const RECENT_HANDS_TIMEOUT_MS = 5000

/** `Position`列挙体は数値enumなので逆引きで表示名が得られる。`null`は非該当。 */
const positionLabel = (position: Position | null): string =>
  position === null ? '—' : Position[position]

/**
 * `approxTimestamp`からの相対時刻を短縮表示する（'3m'/'2h'/'昨日'/'5d'）。
 * `null`（approxTimestampがそもそも記録されていない古いデータ）は'—'。
 * Exported for direct unit testing.
 */
export function formatRelativeTime(timestamp: number | null, now: number = Date.now()): string {
  if (timestamp === null) return '—'
  const diffMs = Math.max(0, now - timestamp)
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  if (diffMs < MINUTE) return 'now'
  if (diffMs < HOUR) return `${Math.floor(diffMs / MINUTE)}m`
  if (diffMs < DAY) return `${Math.floor(diffMs / HOUR)}h`
  if (diffMs < 2 * DAY) return '昨日'
  return `${Math.floor(diffMs / DAY)}d`
}

/** '+1,240'（勝利時、桁区切り）または'-'（非勝利時）を返す。 */
const formatNetChips = (entry: RecentHandEntry): string =>
  entry.won && entry.netChips !== null ? `+${entry.netChips.toLocaleString()}` : '-'

const styles = {
  panel: {
    borderTop: '1px solid rgba(255, 255, 255, 0.15)',
    padding: '4px 6px 6px',
  } as CSSProperties,

  placeholder: {
    padding: '6px 0',
    textAlign: 'center' as const,
    color: HUD_MUTED_TEXT_COLOR,
    fontSize: '9px',
  } as CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '9px',
  } as CSSProperties,

  headerCell: {
    color: '#aaaaaa',
    fontWeight: 'bold',
    textAlign: 'right' as const,
    padding: '1px 3px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.15)',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,

  headerCellLeft: {
    textAlign: 'left' as const,
  } as CSSProperties,

  cell: {
    color: '#dddddd',
    textAlign: 'right' as const,
    padding: '1px 3px',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,

  cellLeft: {
    textAlign: 'left' as const,
  } as CSSProperties,

  won: {
    color: '#00ff00',
    fontWeight: 'bold',
  } as CSSProperties,

  notWon: {
    color: HUD_MUTED_TEXT_COLOR,
  } as CSSProperties,

  showdownMarker: {
    color: '#ffcc00',
    marginLeft: '2px',
  } as CSSProperties,

  blackCard: {
    color: '#dddddd',
  } as CSSProperties,

  redCard: {
    color: '#e57373',
  } as CSSProperties,
}

/**
 * 直近ハンド・ドリルダウンパネル（HM3/PT4"Last Hands" + Hand2Noteの
 * "recent showdown hole cards"相当）。
 *
 * `getRecentHands`をchrome.runtime.sendMessage経由でbackgroundに直接送る
 * （PositionalStatsPanelと全く同じ仕組み・同じコンテキスト）。
 *
 * タイムアウト・chrome.runtime.lastError・success:falseのいずれも
 * フェイルオープンでエラープレースホルダーへ倒す。HUDをクラッシュさせない（#127踏襲）。
 */
export const RecentHandsPanel = memo(({ playerId, handEpoch }: RecentHandsPanelProps) => {
  const [status, setStatus] = useState<FetchStatus>('loading')
  const [data, setData] = useState<RecentHandsResult | undefined>(undefined)
  const panelProps = {
    id: `recent-hands-panel-${playerId}`,
    role: 'region',
    'aria-label': `Player ${playerId}の直近ハンド`,
    'data-testid': 'recent-hands-panel',
    'data-player-id': playerId,
  } as const

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setData(undefined)

    const message: GetRecentHandsMessage = { action: 'getRecentHands', playerId }
    sendMessageWithTimeout<RecentHandsResponse | ErrorResponse>(message, RECENT_HANDS_TIMEOUT_MS)
      .then(response => {
        if (cancelled) return
        if (!response || response.success !== true || !('recentHands' in response)) {
          setStatus('error')
          return
        }
        setData(response.recentHands)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
    // handEpoch: 監査指摘11(P2)対応。値が変わるのは生きたハンドが1件完了した
    // ときだけ（App.tsx/ports.ts参照）なので、このパネルを開いたままにしていても
    // 最新のハンドを反映して再フェッチする。
  }, [playerId, handEpoch])

  if (status === 'loading') {
    return (
      <div style={styles.panel} {...panelProps}>
        <div style={styles.placeholder}>Loading hands…</div>
      </div>
    )
  }

  if (status === 'error' || !data) {
    return (
      <div style={styles.panel} {...panelProps}>
        <div style={styles.placeholder}>—</div>
      </div>
    )
  }

  if (data.hands.length === 0) {
    return (
      <div style={styles.panel} {...panelProps}>
        <div style={styles.placeholder}>No hands yet</div>
      </div>
    )
  }

  const now = Date.now()

  return (
    <div style={styles.panel} {...panelProps}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>時刻</th>
            <th style={styles.headerCell}>Pos</th>
            <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>カード</th>
            <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>ライン</th>
            <th style={styles.headerCell}>結果</th>
          </tr>
        </thead>
        <tbody>
          {data.hands.map(entry => (
            <tr key={entry.handId} data-testid="recent-hands-row">
              <td style={{ ...styles.cell, ...styles.cellLeft }}>{formatRelativeTime(entry.approxTimestamp, now)}</td>
              <td style={styles.cell}>{positionLabel(entry.position)}</td>
              <td style={{ ...styles.cell, ...styles.cellLeft }} data-testid="recent-hands-cards">
                {entry.holeCards ? (
                  entry.holeCards.map((card, i) => (
                    <span key={i} style={isRedSuit(card) ? styles.redCard : styles.blackCard}>
                      {card}{i < entry.holeCards!.length - 1 ? ' ' : ''}
                    </span>
                  ))
                ) : (
                  <span style={styles.notWon}>—</span>
                )}
              </td>
              <td style={{ ...styles.cell, ...styles.cellLeft }}>{entry.preflopLine ?? '—'}</td>
              <td style={styles.cell}>
                <span style={entry.won ? styles.won : styles.notWon}>{formatNetChips(entry)}</span>
                {entry.wentToShowdown && <span style={styles.showdownMarker} title="ショーダウン">●</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

RecentHandsPanel.displayName = 'RecentHandsPanel'
