import { memo, useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Position } from '../../types/game'
import type { PostflopLines, RecentHandEntry, RecentHandsResult } from '../../types/stats'
import type { GetRecentHandsMessage, RecentHandsResponse, ErrorResponse } from '../../types/messages'
import { sendMessageWithTimeout } from '../popup/send-message'
import { isRedSuit } from '../../utils/card-utils'
import { HUD_MUTED_TEXT_COLOR } from './hudColors'
import {
  DEFAULT_RECENT_HANDS_LIMIT,
  RECENT_HANDS_LIMIT_OPTIONS,
  loadRecentHandsLimit,
  saveRecentHandsLimit,
  subscribeRecentHandsLimit,
} from '../../utils/recent-hands-config'

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

/**
 * ポストフロップ3ストリートを1セルに畳む（#341）。ストリート区切りは`/`、
 * 各ストリートの中身は`PostflopLines`の1文字表記そのまま。
 *
 * 末尾側の「アクションが無いストリート」は落とす（`XC/B`はターンで終わった
 * という意味で、リバー欄の`/-`は情報を持たない）。逆に途中の空ストリートは
 * `-`で残す ―― `XC/-/B`は「ターンでは動かずリバーでベット」であって、
 * 詰めてしまうと`XC/B`（ターンでベット）と区別が付かなくなる。
 * 3ストリートとも空なら`null`（呼び出し側がem dashへ倒す）。
 *
 * 引数が欠けている場合も`null`へ倒す（MUST）: このデータはchrome.runtime
 * メッセージ越しにbackgroundから来るので、拡張の更新途中など送信側が
 * 古い形のまま応答する瞬間があり得る。#127と同じ方針で、HUDを落とさない。
 *
 * Exported for direct unit testing.
 */
export function formatPostflopLines(lines: PostflopLines | null | undefined): string | null {
  if (!lines) return null
  const streets = [lines.flop, lines.turn, lines.river]
  let lastPlayed = -1
  streets.forEach((street, index) => {
    if (street) lastPlayed = index
  })
  if (lastPlayed < 0) return null
  return streets.slice(0, lastPlayed + 1).map(street => street ?? '-').join('/')
}

/** Signed chip result with grouping; unknown source accounting stays '-'. */
const formatNetChips = (entry: RecentHandEntry): string =>
  entry.netChips === null
    ? '-'
    : entry.netChips > 0
      ? `+${entry.netChips.toLocaleString()}`
      : entry.netChips.toLocaleString()

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

  // 件数スイッチャー行。HUD幅240pxのうち右端に寄せる。
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '3px',
    padding: '0 1px 3px',
    fontSize: '9px',
    color: HUD_MUTED_TEXT_COLOR,
  } as CSSProperties,

  limitButton: {
    background: 'transparent',
    border: 'none',
    padding: '0 2px',
    margin: 0,
    cursor: 'pointer',
    fontSize: '9px',
    lineHeight: 1.2,
    color: HUD_MUTED_TEXT_COLOR,
  } as CSSProperties,

  limitButtonActive: {
    color: '#66ccff',
    fontWeight: 'bold',
  } as CSSProperties,

  /**
   * 最大100件（RECENT_HANDS_LIMIT_OPTIONSの上限）をスクロールで収める。
   * react-windowによる仮想化は入れない: HandLogが仮想化しているのは行数が
   * 原理的に無制限（セッション全体のログ）だからで、こちらは上限100行×6セル
   * ＝HUD1枚あたり高々600ノードに固定されている。`<table>`の行を仮想化すると
   * セル幅の自動調整が効かなくなり、240px幅での列詰めをこちらで作り込む
   * ことになるので、費用対効果が合わない。
   */
  scroller: {
    maxHeight: '220px',
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
  } as CSSProperties,

  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '9px',
    tableLayout: 'auto' as const,
  } as CSSProperties,

  headerCell: {
    color: '#aaaaaa',
    fontWeight: 'bold',
    textAlign: 'right' as const,
    padding: '1px 2px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.15)',
    whiteSpace: 'nowrap' as const,
    // スクロール時もヘッダーを残す（100件表示だと確実にスクロールするため）。
    position: 'sticky' as const,
    top: 0,
    // ヘッダーの下を行が透けて通らないよう、HUD背景（rgba(0,0,0,0.5)）と
    // 同系でほぼ不透明の黒を敷く。
    background: 'rgba(0, 0, 0, 0.92)',
    zIndex: 1,
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

  lost: {
    color: '#ff6b6b',
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
 *
 * 表示件数はスイッチャー（10/25/50/100）で切り替えられ、選択は端末ローカルに
 * 永続化される（#341、recent-hands-config.ts）。件数を変えると再フェッチする
 * が、backgroundは常に最大件数で組み立ててキャッシュしているので、DB読み取り
 * は増えない（recent-hands-service.tsの`buildRecentHandsCacheKey`参照）。
 */
export const RecentHandsPanel = memo(({ playerId, handEpoch }: RecentHandsPanelProps) => {
  const [status, setStatus] = useState<FetchStatus>('loading')
  const [data, setData] = useState<RecentHandsResult | undefined>(undefined)
  // `null` = 保存済み件数をまだ読めていない。この間はフェッチしない
  // （既定値で1回フェッチしてから保存値で即やり直す、という二度手間と
  // 表示のちらつきを避ける）。
  const [limit, setLimit] = useState<number | null>(null)
  const activeLimit = limit ?? DEFAULT_RECENT_HANDS_LIMIT
  const panelProps = {
    id: `recent-hands-panel-${playerId}`,
    role: 'region',
    'aria-label': `Player ${playerId}の直近ハンド`,
    'data-testid': 'recent-hands-panel',
    'data-player-id': playerId,
  } as const

  // 保存済みの件数を読み、以後は他パネル／他タブでの変更にも追従する。
  useEffect(() => {
    let cancelled = false
    loadRecentHandsLimit().then(stored => {
      if (!cancelled) setLimit(stored)
    })
    const unsubscribe = subscribeRecentHandsLimit(next => {
      if (!cancelled) setLimit(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const handleSelectLimit = useCallback((next: number) => {
    setLimit(next)
    saveRecentHandsLimit(next)
  }, [])

  useEffect(() => {
    if (limit === null) return
    let cancelled = false
    setStatus('loading')
    setData(undefined)

    const message: GetRecentHandsMessage = { action: 'getRecentHands', playerId, limit }
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
    // limit: 件数スイッチャーの選択（#341）。
  }, [playerId, handEpoch, limit])

  // 件数スイッチャーはローディング／エラー／0件のいずれでも操作できる必要が
  // ある（0件は「その件数で0件」ではなくフィルター起因のこともあるため、
  // ここで件数を戻せないと詰む）。
  const limitSwitcher = (
    <div style={styles.toolbar} data-testid="recent-hands-limit-switcher">
      <span>件数</span>
      {RECENT_HANDS_LIMIT_OPTIONS.map(option => (
        <button
          key={option}
          type="button"
          style={option === activeLimit ? { ...styles.limitButton, ...styles.limitButtonActive } : styles.limitButton}
          aria-pressed={option === activeLimit}
          aria-label={`直近${option}ハンドを表示`}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation()
            handleSelectLimit(option)
          }}
        >
          {option}
        </button>
      ))}
    </div>
  )

  if (status === 'loading') {
    return (
      <div style={styles.panel} {...panelProps}>
        {limitSwitcher}
        <div style={styles.placeholder}>Loading hands…</div>
      </div>
    )
  }

  if (status === 'error' || !data) {
    return (
      <div style={styles.panel} {...panelProps}>
        {limitSwitcher}
        <div style={styles.placeholder}>—</div>
      </div>
    )
  }

  if (data.hands.length === 0) {
    return (
      <div style={styles.panel} {...panelProps}>
        {limitSwitcher}
        <div style={styles.placeholder}>No hands yet</div>
      </div>
    )
  }

  const now = Date.now()

  return (
    <div style={styles.panel} {...panelProps}>
      {limitSwitcher}
      <div style={styles.scroller}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>時刻</th>
              <th style={styles.headerCell}>Pos</th>
              <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>カード</th>
              <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>ライン</th>
              <th
                style={{ ...styles.headerCell, ...styles.headerCellLeft }}
                title="フロップ/ターン/リバーの自分のアクション（X=チェック B=ベット C=コール R=レイズ F=フォールド、!=オールイン）"
              >F/T/R</th>
              <th style={styles.headerCell}>損益</th>
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
                <td style={{ ...styles.cell, ...styles.cellLeft }} data-testid="recent-hands-streets">
                  {formatPostflopLines(entry.postflopLines) ?? <span style={styles.notWon}>—</span>}
                </td>
                <td style={styles.cell}>
                  <span style={entry.netChips === null || entry.netChips === 0
                    ? styles.notWon
                    : entry.netChips > 0
                      ? styles.won
                      : styles.lost}>{formatNetChips(entry)}</span>
                  {entry.wentToShowdown && <span style={styles.showdownMarker} title="ショーダウン">●</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
})

RecentHandsPanel.displayName = 'RecentHandsPanel'
