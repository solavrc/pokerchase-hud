import { memo, useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { Position } from '../../types/game'
import type { PostflopLines, RecentHandEntry, RecentHandsResult, StreetAction } from '../../types/stats'
import type { GetRecentHandsMessage, RecentHandsResponse, ErrorResponse } from '../../types/messages'
import { sendMessageWithTimeout } from '../popup/send-message'
import { suitColor } from '../../utils/card-utils'
import { HUD_MUTED_TEXT_COLOR } from './hudColors'
import {
  DEFAULT_RECENT_HANDS_PANEL_CONFIG,
  RECENT_HANDS_LIMIT_OPTIONS,
  loadRecentHandsPanelConfig,
  saveRecentHandsLimit,
  saveRecentHandsParticipationOnly,
  subscribeRecentHandsPanelConfig,
} from '../../utils/recent-hands-config'
import type { RecentHandsPanelConfig } from '../../utils/recent-hands-config'

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
 * 1アクションの表示トークン（#341の記号 + #354のサイズ）。
 * 例: `X` / `C` / `B33` / `R120` / `B75!`（`!`＝オールイン）。
 *
 * ポット比は`B`/`R`にだけ付く ―― チェック・コール・フォールドに「ポットの
 * 何%」は無い。比率が算出できなかったアグレッシブアクション（会計が欠けた
 * 古い行など）は記号だけに落ちる（数字を捏造しない）。
 */
export function formatStreetAction(action: StreetAction): string {
  const size = action.potPercent === null ? '' : String(action.potPercent)
  return `${action.letter}${size}${action.allIn ? '!' : ''}`
}

/**
 * ポストフロップ3ストリートを1セルに畳む（#341/#354）。ストリート区切りは`/`。
 *
 * 末尾側の「アクションが無いストリート」は落とす（`XC/B33`はターンで終わった
 * という意味で、リバー欄の`/-`は情報を持たない）。逆に途中の空ストリートは
 * `-`で残す ―― `XC/-/B50`は「ターンでは動かずリバーでベット」であって、
 * 詰めてしまうと`XC/B50`（ターンでベット）と区別が付かなくなる。
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
    .map(street => (Array.isArray(street) ? street : []))
  let lastPlayed = -1
  streets.forEach((street, index) => {
    if (street.length > 0) lastPlayed = index
  })
  if (lastPlayed < 0) return null
  return streets
    .slice(0, lastPlayed + 1)
    .map(street => (street.length > 0 ? street.map(formatStreetAction).join('') : '-'))
    .join('/')
}

/**
 * F/T/Rセルのツールチップ（#354）: 記号だけでは読めない実額を出す。
 * 列を増やさずに「B33が実際に何チップだったのか」へ到達できるようにする
 * （BB損益セルのツールチップと同じ考え方）。
 */
export function formatPostflopTooltip(lines: PostflopLines | null | undefined): string | undefined {
  if (!lines) return undefined
  const names = ['フロップ', 'ターン', 'リバー'] as const
  const parts = [lines.flop, lines.turn, lines.river].flatMap((street, index) => {
    if (!Array.isArray(street) || street.length === 0) return []
    const detail = street
      .filter(action => action.increment !== null && action.increment > 0 && action.potBefore !== null)
      .map(action => `${formatStreetAction(action)}=${action.increment!.toLocaleString()}（ポット${action.potBefore!.toLocaleString()}）`)
    return detail.length > 0 ? [`${names[index]}: ${detail.join(' ')}`] : []
  })
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * ライン（プリフロップ）セルのツールチップ（#354）。
 *
 * サイズを`preflopLine`の文字列へ埋め込まずツールチップにしたのは、
 * (1)`preflopLine`が`'Open-F'`のようにサフィックスを持つ documented な
 * タクソノミーで、数字を差し込む自然な位置が無いこと、(2)ライン列は既に
 * `ColdCall`が幅を決めており、そこへ数字を足すと240px幅のテーブルで
 * 一番広い列がさらに広がること、による。
 */
export function formatPreflopTooltip(entry: RecentHandEntry): string | undefined {
  const bb = entry.preflopRaiseToBB
  const chips = entry.preflopRaiseToChips
  if (typeof bb !== 'number' || !Number.isFinite(bb) || bb <= 0) return undefined
  if (typeof chips !== 'number' || !Number.isFinite(chips)) return undefined
  return `プリフロップ: ${formatBigBlinds(bb)}BB（${chips.toLocaleString()}チップ）へレイズ`
}

/**
 * BB表記を小数第1位で丸め、`.0`は落とす（`2.2` / `9`）。
 * Exported for direct unit testing.
 */
export function formatBigBlinds(value: number): string {
  return String(Number(value.toFixed(1)))
}

/** Signed chip result with grouping; unknown/なし の会計は '-'。 */
const formatNetChips = (entry: RecentHandEntry): string =>
  typeof entry.netChips !== 'number' || !Number.isFinite(entry.netChips)
    ? '-'
    : entry.netChips > 0
      ? `+${entry.netChips.toLocaleString()}`
      : entry.netChips.toLocaleString()

/**
 * 損益をBB単位（符号付き小数第1位）で表示する（#353）。
 *
 * 割る値はそのハンド自身の`bigBlind` ―― SNG/MTTはブラインドが上がるので、
 * 一覧の中でレベルの違うハンドをチップのまま並べても大小が比較できない。
 *
 * `bigBlind`が使えない行（`null`）はBBへ換算せずチップ表記へフォールバック
 * する（MUST）。行ごと隠したり0扱いにすると、実際には損益のあるハンドが
 * 無かったことになる。会計そのものが未確定（`netChips === null`）の行は
 * 従来どおり'-'。
 *
 * Exported for direct unit testing.
 */
export function formatNetBigBlinds(entry: RecentHandEntry): string {
  if (typeof entry.netChips !== 'number' || !Number.isFinite(entry.netChips)) return '-'
  const bigBlind = usableBigBlind(entry)
  if (bigBlind === null) return formatNetChips(entry)
  const bb = entry.netChips / bigBlind
  // -0.04 が '-0.0' になると損に見えるので、丸めた結果が0なら符号を落とす。
  const rounded = Number(bb.toFixed(1))
  if (rounded === 0) return '0.0'
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`
  
}

/**
 * BB換算に使える`bigBlind`か。`null`だけでなく**未設定・非有限・0以下**も
 * すべて利用不能として弾く（MUST）。このフィールドはchrome.runtimeメッセージ
 * 越しにbackgroundから来るので、拡張の更新途中など送信側が古い形のまま応答
 * すれば`undefined`が届き得る。#127と同じ方針で、表示側がHUDを落とさない。
 */
const usableBigBlind = (entry: RecentHandEntry): number | null =>
  typeof entry.bigBlind === 'number' && Number.isFinite(entry.bigBlind) && entry.bigBlind > 0
    ? entry.bigBlind
    : null

/** BB表記のセルに出すチップ実額のツールチップ（#353、列は増やさない）。 */
const netChipsTooltip = (entry: RecentHandEntry): string | undefined => {
  const bigBlind = usableBigBlind(entry)
  if (bigBlind === null) return undefined
  if (typeof entry.netChips !== 'number' || !Number.isFinite(entry.netChips)) return undefined
  return `${formatNetChips(entry)} チップ（BB=${bigBlind.toLocaleString()}）`
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
    // ヘッダーと同じ左右padding。列が1つ増えた分、240px幅の余裕を確保する。
    padding: '1px 2px',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,

  /**
   * ストリート列だけは折り返しを許す。レイズ応酬で表記が伸びたときに、
   * `nowrap`のまま最小幅を押し上げてテーブル全体を240pxからはみ出させる
   * （＝`overflowX: hidden`のscrollerに切られる）より、2行に折り返すほうが
   * 情報を失わない。
   */
  streetCell: {
    whiteSpace: 'normal' as const,
    wordBreak: 'break-all' as const,
    // サイズ表記が入って桁が揃わないと行ごとに列幅が揺れるため、等幅数字にする
    // （#354）。`tabular-nums`は全数字を同じ送り幅にするOpenType機能で、
    // フォント自体を等幅にするより字面が既存のUIと揃う。
    fontVariantNumeric: 'tabular-nums' as const,
    fontFeatureSettings: '"tnum" 1',
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
  // `null` = 保存済み設定をまだ読めていない。この間はフェッチしない
  // （既定値で1回フェッチしてから保存値で即やり直す、という二度手間と
  // 表示のちらつきを避ける）。
  const [config, setConfig] = useState<RecentHandsPanelConfig | null>(null)
  const activeConfig = config ?? DEFAULT_RECENT_HANDS_PANEL_CONFIG
  const panelProps = {
    id: `recent-hands-panel-${playerId}`,
    role: 'region',
    'aria-label': `Player ${playerId}の直近ハンド`,
    'data-testid': 'recent-hands-panel',
    'data-player-id': playerId,
  } as const

  // 保存済みの設定を読み、以後は他パネル／他タブでの変更にも追従する。
  useEffect(() => {
    let cancelled = false
    loadRecentHandsPanelConfig().then(stored => {
      if (!cancelled) setConfig(stored)
    })
    const unsubscribe = subscribeRecentHandsPanelConfig(patch => {
      // 未ロード中に通知が来ても、既定値をベースにpatchを当てて追従する。
      // 値が変わらないなら**同一オブジェクト**を返す: このパネル自身の操作が
      // 起こしたstorage書き込みの通知もここへ戻ってくるため、毎回新しい
      // オブジェクトを作るとフェッチeffectが二度走り、同じ条件のリクエストと
      // loading表示が重複する。
      if (cancelled) return
      setConfig(current => {
        const base = current ?? DEFAULT_RECENT_HANDS_PANEL_CONFIG
        const next = { ...base, ...patch }
        return next.limit === base.limit && next.participationOnly === base.participationOnly
          ? current
          : next
      })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const handleSelectLimit = useCallback((next: number) => {
    setConfig(current => ({ ...(current ?? DEFAULT_RECENT_HANDS_PANEL_CONFIG), limit: next }))
    saveRecentHandsLimit(next)
  }, [])

  const handleToggleParticipationOnly = useCallback(() => {
    setConfig(current => {
      const base = current ?? DEFAULT_RECENT_HANDS_PANEL_CONFIG
      const next = !base.participationOnly
      saveRecentHandsParticipationOnly(next)
      return { ...base, participationOnly: next }
    })
  }, [])

  useEffect(() => {
    if (config === null) return
    let cancelled = false
    setStatus('loading')
    setData(undefined)

    const message: GetRecentHandsMessage = {
      action: 'getRecentHands',
      playerId,
      limit: config.limit,
      participationOnly: config.participationOnly,
    }
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
    // 件数スイッチャー（#341）と「参加のみ」（#353）の選択。`config`
    // オブジェクトそのものではなく**値**へ依存する ―― 同じ設定で新しい
    // オブジェクトが作られても再フェッチしないようにするための二重の防御
    // （上のsetConfigでの同一性維持と合わせて）。
  }, [playerId, handEpoch, config === null, config?.limit, config?.participationOnly])

  // コントロール行はローディング／エラー／0件のいずれでも操作できる必要が
  // ある（0件は「その件数で0件」ではなくフィルター起因のこともあるため、
  // ここで条件を戻せないと詰む）。
  const controls = (
    <div style={styles.toolbar} data-testid="recent-hands-limit-switcher">
      <button
        type="button"
        style={activeConfig.participationOnly
          ? { ...styles.limitButton, ...styles.limitButtonActive }
          : styles.limitButton}
        aria-pressed={activeConfig.participationOnly}
        aria-label="参加のみ表示"
        title="プリフロップで自分からチップを入れたハンドだけを表示する（即フォールド・ウォークを隠す）"
        onMouseDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation()
          handleToggleParticipationOnly()
        }}
      >
        参加のみ
      </button>
      <span>件数</span>
      {RECENT_HANDS_LIMIT_OPTIONS.map(option => (
        <button
          key={option}
          type="button"
          style={option === activeConfig.limit ? { ...styles.limitButton, ...styles.limitButtonActive } : styles.limitButton}
          aria-pressed={option === activeConfig.limit}
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
        {controls}
        <div style={styles.placeholder}>Loading hands…</div>
      </div>
    )
  }

  if (status === 'error' || !data) {
    return (
      <div style={styles.panel} {...panelProps}>
        {controls}
        <div style={styles.placeholder}>—</div>
      </div>
    )
  }

  if (data.hands.length === 0) {
    return (
      <div style={styles.panel} {...panelProps}>
        {controls}
        {/* 0件の理由を「参加のみ」で消えたのか元々無いのかで書き分ける
            ―― 前者はトグルを戻せば見えると分かる必要がある（#353）。 */}
        <div style={styles.placeholder}>
          {activeConfig.participationOnly ? '参加したハンドなし' : 'No hands yet'}
        </div>
      </div>
    )
  }

  return (
    <div style={styles.panel} {...panelProps}>
      {controls}
      <div style={styles.scroller}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.headerCell}>Pos</th>
              <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>カード</th>
              <th style={{ ...styles.headerCell, ...styles.headerCellLeft }}>ライン</th>
              <th
                style={{ ...styles.headerCell, ...styles.headerCellLeft }}
                title="フロップ/ターン/リバーの自分のアクション（X=チェック B=ベット C=コール R=レイズ F=フォールド、!=オールイン）。B/Rの数字は直前のポットに対する比率(%)"
              >F/T/R</th>
              <th style={styles.headerCell} title="損益（そのハンドのBB単位）">損益(BB)</th>
            </tr>
          </thead>
          <tbody>
            {data.hands.map(entry => (
              <tr key={entry.handId} data-testid="recent-hands-row">
                <td style={styles.cell}>{positionLabel(entry.position)}</td>
                <td style={{ ...styles.cell, ...styles.cellLeft }} data-testid="recent-hands-cards">
                  {entry.holeCards ? (
                    entry.holeCards.map((card, i) => (
                      <span key={i} style={{ color: suitColor(card) }}>
                        {card}{i < entry.holeCards!.length - 1 ? ' ' : ''}
                      </span>
                    ))
                  ) : (
                    <span style={styles.notWon}>—</span>
                  )}
                </td>
                <td
                  style={{ ...styles.cell, ...styles.cellLeft }}
                  title={formatPreflopTooltip(entry)}
                  data-testid="recent-hands-preflop"
                >{entry.preflopLine ?? '—'}</td>
                <td
                  style={{ ...styles.cell, ...styles.cellLeft, ...styles.streetCell }}
                  title={formatPostflopTooltip(entry.postflopLines)}
                  data-testid="recent-hands-streets"
                >
                  {formatPostflopLines(entry.postflopLines) ?? <span style={styles.notWon}>—</span>}
                </td>
                <td style={styles.cell} title={netChipsTooltip(entry)}>
                  <span style={entry.netChips === null || entry.netChips === 0
                    ? styles.notWon
                    : entry.netChips > 0
                      ? styles.won
                      : styles.lost}>{formatNetBigBlinds(entry)}</span>
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
