import { memo, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Position } from '../../types/game'
import type { PositionalStatId, PositionalStatsBucketId, PositionalStatsResult } from '../../types/stats'
import type { GetPositionalStatsMessage, PositionalStatsResponse, ErrorResponse } from '../../types/messages'
import { sendMessageWithTimeout } from '../popup/send-message'
import { HUD_MUTED_TEXT_COLOR } from './hudColors'

interface PositionalStatsPanelProps {
  playerId: number
  /**
   * 生きたハンドが1件完了するたびに増える「hand epoch」（App.tsx/Hud.tsx参照、
   * 監査指摘11 P2「開いたドリルダウンパネルが無期限に古くなる」対応）。
   * playerIdと一緒にフェッチeffectのdepsへ入れることで、このパネルを開いた
   * ままにしていても新しいハンドが終わるたびに1回だけ再フェッチする
   * （実況の1アクションごとの更新ではこの値は変化しないため再フェッチ
   * ストームは起きない）。バックエンド側の30秒キャッシュも同じイベントで
   * 無効化される（positional-stats-service.tsのsubscribeToHandCompletion参照）
   * ので、この再フェッチは古いキャッシュ結果を受け取らない。
   */
  handEpoch?: number
}

type FetchStatus = 'loading' | 'ready' | 'error'

// HUDは対局中のリアルタイムオーバーレイのため、popup既定の8sより短いタイムアウトで
// フェイルオープンする（開いたままスピナーが長居してプレイを妨げないように）
const POSITIONAL_STATS_TIMEOUT_MS = 5000
const LOW_SAMPLE_THRESHOLD = 10

const STAT_COLUMNS: Array<{ id: PositionalStatId, label: string }> = [
  { id: 'vpip', label: 'VPIP' },
  { id: 'pfr', label: 'PFR' },
  { id: '3bet', label: '3B' },
  { id: 'steal', label: 'STL' },
  { id: 'foldToSteal', label: 'FTS' },
  { id: 'cbet', label: 'CB' },
]

/** `Position`列挙体は数値enumなので逆引きで表示名が得られる。'unknown'バケットのみ特別扱い。 */
const positionLabel = (bucket: PositionalStatsBucketId): string =>
  typeof bucket === 'number' ? Position[bucket] : '?'

const formatPct = (num: number, den: number): string => {
  if (den <= 0) return '-'
  return `${Math.round((num / den) * 100)}%`
}

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
    color: '#aaaaaa',
    fontWeight: 'bold',
  } as CSSProperties,

  lowSample: {
    color: HUD_MUTED_TEXT_COLOR,
  } as CSSProperties,
}

/**
 * ポジション別スタッツ・ドリルダウンパネル。
 *
 * `getPositionalStats`をchrome.runtime.sendMessage経由でbackgroundに直接送る
 * （このコンポーネントはcontent_script.tsがマウントするAppツリー内で動くため、
 * chrome.runtime.sendMessageに直接アクセスできる。App.tsxのchrome.runtime.onMessage
 * 購読、content_script.tsのrequestLatestStats送信と同じコンテキスト・同じ仕組み）。
 *
 * タイムアウト・chrome.runtime.lastError・success:falseのいずれも
 * フェイルオープンでエラープレースホルダーへ倒す。HUDをクラッシュさせない（#127踏襲）。
 */
export const PositionalStatsPanel = memo(({ playerId, handEpoch }: PositionalStatsPanelProps) => {
  const [status, setStatus] = useState<FetchStatus>('loading')
  const [data, setData] = useState<PositionalStatsResult | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setData(undefined)

    const message: GetPositionalStatsMessage = { action: 'getPositionalStats', playerId }
    sendMessageWithTimeout<PositionalStatsResponse | ErrorResponse>(message, POSITIONAL_STATS_TIMEOUT_MS)
      .then(response => {
        if (cancelled) return
        if (!response || response.success !== true || !('positionalStats' in response)) {
          setStatus('error')
          return
        }
        setData(response.positionalStats)
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
      <div style={styles.panel} data-testid="positional-stats-panel">
        <div style={styles.placeholder}>Loading positions…</div>
      </div>
    )
  }

  if (status === 'error' || !data) {
    return (
      <div style={styles.panel} data-testid="positional-stats-panel">
        <div style={styles.placeholder}>—</div>
      </div>
    )
  }

  // 'unknown'バケットはhandsNが0の時のみ非表示（バックエンドの固定順序はそのまま維持）
  const rows = data.positions.filter(bucket => bucket.position !== 'unknown' || bucket.handsN > 0)

  return (
    <div style={styles.panel} data-testid="positional-stats-panel">
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>Pos</th>
            <th style={styles.headerCell}>N</th>
            {STAT_COLUMNS.map(col => (
              <th key={col.id} style={styles.headerCell}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(bucket => (
            <tr key={String(bucket.position)}>
              <td style={{ ...styles.cell, ...styles.cellLeft }}>{positionLabel(bucket.position)}</td>
              <td style={styles.cell}>{bucket.handsN}</td>
              {STAT_COLUMNS.map(col => {
                const [num, den] = bucket.stats[col.id]
                const isLowSample = den < LOW_SAMPLE_THRESHOLD
                return (
                  <td
                    key={col.id}
                    style={isLowSample ? { ...styles.cell, ...styles.lowSample } : styles.cell}
                    data-low-sample={isLowSample ? 'true' : undefined}
                  >
                    {formatPct(num, den)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

PositionalStatsPanel.displayName = 'PositionalStatsPanel'
