/**
 * HandLogコンポーネント - 最適化バージョン
 * バーチャル化を使用したリアルタイムハンド履歴ログオーバーレイ
 */

import React, { useState, useEffect, useLayoutEffect, useRef, CSSProperties, useCallback, useMemo, memo } from 'react'
import { List, useListRef, getScrollbarSize } from 'react-window'
import {
  HandLogEntry,
  HandLogEntryType,
  HandLogConfig,
  HandLogLayout,
  DEFAULT_HAND_LOG_CONFIG
} from '../types/hand-log'
import { formatHandLogEntries } from '../utils/hand-log-text'
import {
  HAND_LOG_MIN_HEIGHT,
  HAND_LOG_MIN_WIDTH,
  isValidHandLogLayout,
  loadHandLogLayout,
  saveHandLogLayout,
} from '../utils/ui-config-storage'

interface HandLogProps {
  entries: HandLogEntry[]
  config?: Partial<HandLogConfig>
  onClearLog?: () => void
  scale?: number
  scrollToLatest?: boolean
}

const HAND_LOG_MOVE_GRIP_SIZE = 16
const HAND_LOG_BORDER_WIDTH = 1
const HAND_LOG_DRAG_THRESHOLD = 4
/**
 * 既定位置は画面左上からの固定オフセット。右下基準
 * （viewportWidth - 余白 - 幅*scale）をやめた理由は2つある:
 *
 * 1. 右下基準は「viewportを正しく読めている」ことがそのまま位置の正しさに
 *    なる。environmentが実ウィンドウより大きいと左端が実ウィンドウの外へ
 *    落ちる ―― 実機で「ウィンドウを画面半分にした状態でリセットしたら
 *    ログが消え、最大化したら現れた」として観測された。左上固定なら
 *    viewportに一切依存しないので、この経路自体が存在しない。
 * 2. 右下隅は座標系の最も外側の点でもある。ユーザーが自分でドラッグして
 *    置く内側の位置と違い、参照フレームが少しでもずれると真っ先に画面外へ
 *    出る。加えて席のHUDパネル（Hud.tsxのSEAT_POSITIONS、下段70%）と
 *    アクションボタン帯に挟まれ、既定サイズ400x100が必ず何かに重なる。
 *
 * 左上ではゲーム側のメニュー/SB・BB/アンティと重なるが、そこは許容する
 * （sola指定: 「どのみちユーザーが動かせる」）。既定倍率ならネームプレート
 * には届かない。
 */
const HAND_LOG_DEFAULT_LEFT = 10
const HAND_LOG_DEFAULT_TOP = 10
const HAND_LOG_FONT_FAMILY = 'Consolas, Monaco, "Courier New", monospace'
const HAND_LOG_SEPARATOR_HEIGHT = 10
const HAND_LOG_ENTRY_PADDING_X = 8
const HAND_LOG_ENTRY_PADDING_Y = 1
const HAND_LOG_ENTRY_LINE_HEIGHT = 1.2
const HAND_LOG_TIMESTAMP_FONT_SIZE_OFFSET = 2
const HAND_LOG_TIMESTAMP_MARGIN_RIGHT = 8
const HAND_LOG_TIMESTAMP_TEXT = '[00:00:00]'

type HandLogInteractionMode = 'move' | 'resize'

interface HandLogEnvironment {
  scale: number
  viewportWidth: number
  viewportHeight: number
}

interface ActiveHandLogInteraction {
  phase: 'interacting'
  mode: HandLogInteractionMode
  startX: number
  startY: number
  startLayout: HandLogLayout
  startEnvironment: HandLogEnvironment
  moved: boolean
}

interface IdleHandLogInteraction {
  phase: 'idle'
}

type HandLogInteraction =
  | IdleHandLogInteraction
  | ActiveHandLogInteraction

interface HandLogLoad {
  id: number
  scale: number
}

interface HandLogLayoutMachine {
  layout: HandLogLayout
  environment: HandLogEnvironment
  interaction: HandLogInteraction
  pendingEnvironment: HandLogEnvironment | null
  activeLoad: HandLogLoad | null
}

type HandLogMachineAction =
  | { type: 'environmentChanged', environment: HandLogEnvironment }
  | { type: 'loadStarted', load: HandLogLoad }
  | { type: 'loadResolved', load: HandLogLoad, layout: HandLogLayout | undefined }
  | { type: 'externalLayout', layout: HandLogLayout }
  | { type: 'reset', environment: HandLogEnvironment }
  | { type: 'interactionStarted', mode: HandLogInteractionMode, x: number, y: number }
  | { type: 'pointerMoved', x: number, y: number }
  | { type: 'interactionFinished', deferPersistenceForLoad?: boolean }

interface HandLogTransition {
  state: HandLogLayoutMachine
  persist?: HandLogLayout
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const sameEnvironment = (
  left: HandLogEnvironment,
  right: HandLogEnvironment
): boolean =>
  left.scale === right.scale &&
  left.viewportWidth === right.viewportWidth &&
  left.viewportHeight === right.viewportHeight

const readHandLogEnvironment = (scale: number): HandLogEnvironment => ({
  scale,
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
})

/**
 * 1軸ぶんのviewport上限。0はviewport未確定として上限なしに倒す。
 * 遷移直後などinnerWidth/innerHeightが一時的に0で読めることがあり、
 * それをそのまま制約にするとパネルが消えて位置も左上へ吸着してしまう。
 */
const getHandLogViewportLimit = (
  viewportSize: number,
  scale: number
): number =>
  viewportSize > 0 ? viewportSize / scale : Number.POSITIVE_INFINITY

/**
 * viewportに収まる実サイズ。viewportより大きいlayoutは表示だけを縮め、
 * 状態と永続化には触れない: 一時的に小さい画面（ウィンドウ縮小、別モニタ）が
 * ユーザーの指定サイズを恒久的に潰さないようにするため。
 */
const getHandLogDisplaySize = (
  layout: HandLogLayout,
  environment: HandLogEnvironment
): { width: number, height: number } => ({
  width: Math.min(
    layout.width,
    getHandLogViewportLimit(environment.viewportWidth, environment.scale)
  ),
  height: Math.min(
    layout.height,
    getHandLogViewportLimit(environment.viewportHeight, environment.scale)
  ),
})

/**
 * 表示中のパネル全体をviewport内へ収める。端からのはみ出しは許さない。
 * 下限0は常に効かせる: 上限だけがviewport依存で、負の座標はviewportが
 * 未確定でも正しくない（0読み取り時の既定layoutは大きな負値になる）。
 */
const clampHandLogPosition = (
  position: number,
  renderedSize: number,
  viewportSize: number
): number =>
  viewportSize > 0
    ? clamp(position, 0, Math.max(0, viewportSize - renderedSize))
    : Math.max(0, position)

const normalizeHandLogLayout = (
  layout: HandLogLayout,
  environment: HandLogEnvironment
): HandLogLayout => {
  const { scale, viewportWidth, viewportHeight } = environment
  const width = Math.max(HAND_LOG_MIN_WIDTH, layout.width)
  const height = Math.max(HAND_LOG_MIN_HEIGHT, layout.height)
  const displaySize = getHandLogDisplaySize(
    { ...layout, width, height },
    environment
  )

  return {
    ...layout,
    left: clampHandLogPosition(
      layout.left,
      displaySize.width * scale,
      viewportWidth
    ),
    top: clampHandLogPosition(
      layout.top,
      displaySize.height * scale,
      viewportHeight
    ),
    width,
    height,
  }
}

/**
 * リサイズ1軸ぶん。見えているサイズを起点にviewport実寸までで頭打ちにする
 * ので、画面外へあふれた分を掴んで引き延ばす操作にはならず、画面に映らない
 * 巨大サイズも作らない。
 *
 * ただし表示が1pxも変わらない操作では保存値に触れない。表示が上限へ貼り付い
 * ている軸（保存サイズがviewportより大きい／viewportが最小値すら収容できな
 * い）では、掴んでいない軸や外向きのドラッグまで保存値を表示上限へ落として
 * しまい、画面を広げても戻らない「見えない縮小」になるため。
 */
const resizeHandLogAxis = (
  startSize: number,
  startDisplaySize: number,
  delta: number,
  minimum: number,
  scale: number,
  viewportSize: number
): number => {
  const resized = clamp(
    startDisplaySize + delta / scale,
    minimum,
    getHandLogViewportLimit(viewportSize, scale)
  )
  return resized === startDisplaySize ? startSize : resized
}

const resizeHandLogLayout = (
  startLayout: HandLogLayout,
  startEnvironment: HandLogEnvironment,
  deltaX: number,
  deltaY: number
): HandLogLayout => {
  const { scale, viewportWidth, viewportHeight } = startEnvironment
  const startDisplaySize = getHandLogDisplaySize(startLayout, startEnvironment)

  return {
    ...startLayout,
    width: resizeHandLogAxis(
      startLayout.width,
      startDisplaySize.width,
      deltaX,
      HAND_LOG_MIN_WIDTH,
      scale,
      viewportWidth
    ),
    height: resizeHandLogAxis(
      startLayout.height,
      startDisplaySize.height,
      deltaY,
      HAND_LOG_MIN_HEIGHT,
      scale,
      viewportHeight
    ),
  }
}

const createDefaultHandLogLayout = (
  environment: HandLogEnvironment
): HandLogLayout =>
  normalizeHandLogLayout({
    left: HAND_LOG_DEFAULT_LEFT,
    top: HAND_LOG_DEFAULT_TOP,
    width: DEFAULT_HAND_LOG_CONFIG.width,
    height: DEFAULT_HAND_LOG_CONFIG.height,
  }, environment)

const createHandLogLayoutMachine = (
  environment: HandLogEnvironment
): HandLogLayoutMachine => ({
  layout: createDefaultHandLogLayout(environment),
  environment,
  interaction: { phase: 'idle' },
  pendingEnvironment: null,
  activeLoad: null,
})

const transitionHandLogLayout = (
  state: HandLogLayoutMachine,
  action: HandLogMachineAction
): HandLogTransition => {
  switch (action.type) {
    case 'environmentChanged': {
      if (state.interaction.phase === 'interacting') {
        const pendingEnvironment = sameEnvironment(
          state.environment,
          action.environment
        )
          ? null
          : action.environment
        if (
          (state.pendingEnvironment === null && pendingEnvironment === null) ||
          (
            state.pendingEnvironment !== null &&
            pendingEnvironment !== null &&
            sameEnvironment(state.pendingEnvironment, pendingEnvironment)
          )
        ) {
          return { state }
        }
        // The active environment is intentionally unchanged until finish, so
        // its in-flight load remains valid during the interaction.
        return {
          state: {
            ...state,
            pendingEnvironment,
          },
        }
      }
      if (sameEnvironment(state.environment, action.environment)) {
        return { state }
      }
      const scaleChanged = state.environment.scale !== action.environment.scale
      return {
        state: {
          ...state,
          layout: normalizeHandLogLayout(state.layout, action.environment),
          environment: action.environment,
          pendingEnvironment: null,
          activeLoad: scaleChanged ? null : state.activeLoad,
        },
      }
    }

    case 'loadStarted':
      if (state.interaction.phase === 'interacting') return { state }
      return {
        state: {
          ...state,
          activeLoad: action.load,
        },
      }

    case 'loadResolved': {
      if (
        state.activeLoad?.id !== action.load.id ||
        state.activeLoad.scale !== action.load.scale ||
        state.environment.scale !== action.load.scale
      ) {
        return { state }
      }
      if (!action.layout) {
        return { state }
      }
      if (
        state.interaction.phase === 'interacting' &&
        state.interaction.moved
      ) {
        return { state: { ...state, activeLoad: null } }
      }
      const layout = normalizeHandLogLayout(
        action.layout,
        state.environment
      )
      return {
        state: {
          ...state,
          layout,
          interaction:
            state.interaction.phase === 'interacting'
              ? { ...state.interaction, startLayout: layout }
              : state.interaction,
          activeLoad: null,
        },
      }
    }

    case 'externalLayout': {
      if (
        state.interaction.phase === 'interacting' &&
        state.interaction.moved
      ) {
        return { state }
      }
      const layout = normalizeHandLogLayout(
        action.layout,
        state.environment
      )
      return {
        state: {
          ...state,
          layout,
          interaction:
            state.interaction.phase === 'interacting'
              ? { ...state.interaction, startLayout: layout }
              : state.interaction,
          activeLoad: null,
        },
      }
    }

    case 'reset': {
      // 保持している environment ではなく、呼び出し側が読み直した実寸を採用する。
      // resizeイベントの取りこぼしなどで environment が実ウィンドウとずれていると、
      // 既定位置の算出も画面内クランプも同じ古い値を使うためズレを検出できず、
      // パネルが画面外に置かれても誰も気付けない（実機で発生した）。
      // リセットはユーザーが「今の画面で見える状態へ戻す」操作なので、
      // ここで環境を確定させ直すのが正しい。
      const environment = action.environment
      return {
        state: {
          ...state,
          layout: createDefaultHandLogLayout(environment),
          environment,
          interaction: { phase: 'idle' },
          pendingEnvironment: null,
          activeLoad: null,
        },
      }
    }

    case 'interactionStarted':
      if (state.interaction.phase === 'interacting') return { state }
      return {
        state: {
          ...state,
          interaction: {
            phase: 'interacting',
            mode: action.mode,
            startX: action.x,
            startY: action.y,
            startLayout: state.layout,
            startEnvironment: state.environment,
            moved: false,
          },
        },
      }

    case 'pointerMoved': {
      if (state.interaction.phase !== 'interacting') return { state }
      const deltaX = action.x - state.interaction.startX
      const deltaY = action.y - state.interaction.startY
      if (
        !state.interaction.moved &&
        Math.hypot(deltaX, deltaY) < HAND_LOG_DRAG_THRESHOLD
      ) {
        return { state }
      }
      const { startLayout, startEnvironment } = state.interaction
      const proposedLayout =
        state.interaction.mode === 'move'
          ? {
              ...startLayout,
              left: startLayout.left + deltaX,
              top: startLayout.top + deltaY,
            }
          : resizeHandLogLayout(
              startLayout,
              startEnvironment,
              deltaX,
              deltaY
            )
      return {
        state: {
          ...state,
          layout: normalizeHandLogLayout(
            proposedLayout,
            state.environment
          ),
          interaction: {
            ...state.interaction,
            moved: true,
          },
        },
      }
    }

    case 'interactionFinished': {
      if (state.interaction.phase !== 'interacting') return { state }
      const environment = state.pendingEnvironment ?? state.environment
      const layout = normalizeHandLogLayout(
        state.layout,
        environment
      )
      const shouldPersist =
        (
          state.interaction.moved ||
          state.pendingEnvironment !== null
        ) &&
        !action.deferPersistenceForLoad
      return {
        state: {
          ...state,
          layout,
          environment,
          interaction: { phase: 'idle' },
          pendingEnvironment: null,
          activeLoad: shouldPersist ? null : state.activeLoad,
        },
        persist: shouldPersist ? layout : undefined,
      }
    }
  }
}

const entryTypeColors: Record<HandLogEntryType, string> = {
  [HandLogEntryType.HEADER]: '#ffffff',
  [HandLogEntryType.SEAT]: '#aaaaaa',
  [HandLogEntryType.CARDS]: '#ffcc00',
  [HandLogEntryType.ACTION]: '#cccccc',
  [HandLogEntryType.STREET]: '#00ccff',
  [HandLogEntryType.SHOWDOWN]: '#ffcc00',
  [HandLogEntryType.SUMMARY]: '#aaaaaa',
  [HandLogEntryType.SYSTEM]: '#ff6666'
}

const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/**
 * canvas計測が使えない環境（jsdom等）で使う1文字送り幅のem比。
 * 半角: 想定フォントはMonaco / Courier New / 汎用monospaceが約0.6、
 * Consolasが約0.55。その中で最も広い値を既定にして、行数を過小評価しない側へ
 * 倒す（過大評価は行間が空くだけだが、過小評価は行の重なり＝欠落になる）。
 * 全角: 日本語フォントは等幅1em。
 */
export const FALLBACK_NARROW_CHAR_WIDTH_RATIO = 0.6
export const FALLBACK_WIDE_CHAR_WIDTH_RATIO = 1
/** 絵文字は全角より広い（実測: 8pxで`🐟`=10px） */
export const FALLBACK_EMOJI_CHAR_WIDTH_RATIO = 1.25
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u
const MIN_PLAUSIBLE_CHAR_WIDTH_RATIO = 0.1
const MAX_PLAUSIBLE_CHAR_WIDTH_RATIO = 3

/**
 * 全角として扱うコードポイント（East Asian Wide / Fullwidth 相当）。
 * 2つの用途がある:
 * 1. canvasが無い環境での幅フォールバック（半角0.6em / 全角1em）
 * 2. 折り返し機会の判定。CJKは空白が無くても文字間で改行できる
 * トランプのスート（♠♥♦♣）は等幅フォント側に収録されていて半角送りなので、
 * ここには含めない（実測でConsolas/Monaco系はASCIIと同じ送り幅）。
 */
const WIDE_CHAR_RANGES =
  'ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿' +
  'ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦'
// `\p{Ideographic}`で補助平面（CJK拡張B以降。`\u{20BB7}`など人名に出る）も
// 拾う。BMPの範囲指定だけでは半角扱いになり、幅も改行機会も取りこぼす。
const WIDE_CHAR_PATTERN = new RegExp(
  `[${WIDE_CHAR_RANGES}]|\\p{Ideographic}`,
  'u'
)

/**
 * 改行機会。CJKは空白が無くても文字間で改行できるが、全角＝改行機会では
 * ない。Chromeの実測では、半角カナ（4px）と絵文字（10px）は全角幅でなくても
 * 改行機会を持つ一方、トランプのスート`♠♥♦♣`や`★→✓①`は持たない。
 * 幅の判定（WIDE_CHAR_PATTERN）とは別の集合として扱う。
 * 絵文字は`\p{Emoji_Presentation}`で判定する。`\p{Extended_Pictographic}`は
 * `♠`まで含んでしまい、カード表記の行を余計に折り返す。
 */
const BREAK_OPPORTUNITY_PATTERN = new RegExp(
  `[${WIDE_CHAR_RANGES}\\uFF61-\\uFF9F]|\\p{Ideographic}|\\p{Emoji_Presentation}`,
  'u'
)

/**
 * 禁則処理。改行機会があっても、そこで改行してよいとは限らない。
 * 集合はChromeの既定（`line-break: auto`）を実測して確定したもの。
 * - 小書き仮名（ぁっゃゅょヵヶ）と長音符（ー）は既定では改行可能なので
 *   含めない（含めると逆に行数を過大評価する）
 * - ASCIIの`:`や`,`も対象。`{日本語名}: raises`のように全角の直後へASCII
 *   句読点が続く行がハンドログの主要な形なので、抜けると行が重なる
 */
/** 行頭禁則: 行の先頭に来られない文字 */
const NO_BREAK_BEFORE_PATTERN =
  /[\u3001\u3002\uFF0C\uFF0E\u30FB\uFF1A\uFF1B\uFF1F\uFF01\uFF09\uFF3D\uFF5D\u3009\u300B\u300D\u300F\u3011\u3015\u2026\u2025\u3005\u309D\u309E\uFF61\uFF63\uFF64\uFF65\uFF9E\uFF9F\u00B0\u2032\u2033\u2103\u00A2\u002C\u002E\u003A\u003B\u0021\u003F\u0029\u005D\u007D\u002F\u0025\u0027\u0022\u007C]/
/** 行末禁則: 直後で改行できない文字（開き括弧・前置記号） */
const NO_BREAK_AFTER_PATTERN =
  /[\uFF08\uFF3B\uFF5B\u3008\u300A\u300C\u300E\u3010\u3014\u2018\u201C\uFFE5\uFF04\u00A3\uFF62\u0028\u005B\u007B\u0024\u002B]/

/**
 * CSSが改行機会として扱う空白。`\s`はNBSP(U+00A0)・NARROW NBSP(U+202F)・
 * FIGURE SPACE(U+2007)まで真になるが、これらはUAX #14のGL（改行禁止）で、
 * CSSは前後で改行しない。空白扱いすると存在しない改行機会を作るうえ、
 * 行末でぶら下げて幅も落としてしまう。
 */
const BREAKABLE_SPACE_PATTERN =
  /^[ \t\n\r\f\v\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]/

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
    : null

/**
 * 書記素クラスタ単位に分割する。コードポイント単位で測ると、結合文字を含む
 * 名前（分解形の`ば`など）を基底文字＋結合文字の2文字分として数えてしまい、
 * DOMが1グリフとして描く実幅と合わない。
 */
const splitGraphemes = (text: string): string[] =>
  graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), segment => segment.segment)
    : Array.from(text)

/** 結合文字・ゼロ幅文字だけのクラスタ（送り幅0が正しい） */
const ZERO_WIDTH_CLUSTER_PATTERN = /^[\p{M}\u200B-\u200D\u2060\uFEFF]+$/u

const charWidthCache = new Map<string, number>()

const getMeasurementContext = (): CanvasRenderingContext2D | null => {
  try {
    // jsdomはCanvasRenderingContext2D自体を定義しない。getContextを呼ぶと
    // "Not implemented"を吐くので、型の有無で先に判定して呼ばない。
    if (
      typeof document === 'undefined' ||
      typeof CanvasRenderingContext2D === 'undefined'
    ) return null
    return document.createElement('canvas').getContext('2d')
  } catch {
    return null
  }
}

/**
 * 実フォント・実フォントサイズでの書記素クラスタ1つぶんの送り幅(px)を
 * canvasで実測する。
 *
 * クラスタごとに測るのが要点。等幅フォント指定でも、日本語のように指定フォント
 * に収録されていない文字は約1emの日本語フォントへフォールバックして描画される
 * ため、ASCII基準の一律幅で数えると行数を最大1.7倍ほど過小評価する。逆に結合
 * 文字を基底文字と別々に測ると、DOMが1グリフに整形する名前を2文字分として
 * 数えて過大評価する。measureTextはレイアウトと同じフォント解決・整形を通るので
 * クラスタ単位ならどちらも実幅どおりになる（実測: 8pxで`0`=4.8px / `あ`=8px）。
 * canvasが無い環境（jsdom等）は半角/全角の保守的な比率で代替する。
 */
const measureClusterWidth = (cluster: string, fontSize: number): number => {
  const key = `${fontSize}|${cluster}`
  const cached = charWidthCache.get(key)
  if (cached !== undefined) return cached

  // 結合文字・ゼロ幅文字だけのクラスタは送り幅0が正しい。canvasが0を返しても
  // 「壊れた計測」とみなさず、そのまま採用する
  const zeroWidth = ZERO_WIDTH_CLUSTER_PATTERN.test(cluster)
  const fallbackRatio = zeroWidth
    ? 0
    : EMOJI_PRESENTATION_PATTERN.test(cluster)
      ? FALLBACK_EMOJI_CHAR_WIDTH_RATIO
      : WIDE_CHAR_PATTERN.test(cluster)
        ? FALLBACK_WIDE_CHAR_WIDTH_RATIO
        : FALLBACK_NARROW_CHAR_WIDTH_RATIO
  let clusterWidth = fontSize * fallbackRatio
  const context = getMeasurementContext()
  if (context) {
    context.font = `${fontSize}px ${HAND_LOG_FONT_FAMILY}`
    const measured = context.measureText(cluster).width
    const ratio = measured / fontSize
    // 妥当性の下限は、全文字0pxを返すような壊れた計測環境で1行あたりの文字数が
    // 無限になるのを防ぐためのもの。0が正しいクラスタには適用しない
    if (
      Number.isFinite(ratio) &&
      ratio <= MAX_PLAUSIBLE_CHAR_WIDTH_RATIO &&
      (zeroWidth ? ratio >= 0 : ratio >= MIN_PLAUSIBLE_CHAR_WIDTH_RATIO)
    ) {
      clusterWidth = measured
    }
  }
  charWidthCache.set(key, clusterWidth)
  return clusterWidth
}

export type MeasureHandLogText = (text: string, fontSize: number) => number

/**
 * 文字列の描画幅(px)。等幅フォントにもCJKフォールバックにも字詰めは無いので、
 * 書記素クラスタごとの送り幅の総和で足りる。キャッシュはクラスタ単位なので、
 * 名前やアクション語が繰り返されるログでは実質すべてキャッシュヒットする。
 */
export const measureHandLogTextWidth: MeasureHandLogText = (text, fontSize) => {
  let width = 0
  for (const cluster of splitGraphemes(text)) {
    width += measureClusterWidth(cluster, fontSize)
  }
  return width
}

/**
 * 折り返しの最小単位（トークン）へ分割する。トークン境界＝CSSが改行しうる位置。
 * - 空白の連なりは1トークン（行末でぶら下がる）
 * - 半角の連なりは1語
 * - CJKは1文字ずつが改行機会。ただし禁則位置では隣とくっつけて1トークンにする
 */
const tokenizeForWrap = (line: string): string[] => {
  const tokens: string[] = []
  let previous: string | undefined
  for (const cluster of splitGraphemes(line)) {
    const breaks = previous === undefined
      ? true
      : breakAllowedBetween(previous, cluster)
    if (breaks || tokens.length === 0) tokens.push(cluster)
    else tokens[tokens.length - 1] += cluster
    previous = cluster
  }
  return tokens
}

const breakAllowedBetween = (previous: string, next: string): boolean => {
  const previousIsSpace = BREAKABLE_SPACE_PATTERN.test(previous)
  const nextIsSpace = BREAKABLE_SPACE_PATTERN.test(next)
  // 空白の連なりは1トークン。空白とそれ以外の境目は必ず改行機会
  if (previousIsSpace || nextIsSpace) return previousIsSpace !== nextIsSpace
  if (NO_BREAK_AFTER_PATTERN.test(previous)) return false
  if (NO_BREAK_BEFORE_PATTERN.test(next)) return false
  // CJK・半角カナ・絵文字は空白が無くても文字間で改行できる。
  // 半角英数どうしは1語として繋がる
  return (
    BREAK_OPPORTUNITY_PATTERN.test(previous) ||
    BREAK_OPPORTUNITY_PATTERN.test(next)
  )
}

/**
 * EntryRowの`white-space: pre-wrap` + `word-break: break-word`に合わせて
 * 折り返し後の行数を数える。幅はすべてpxで扱う: 文字数で数えると半角と全角
 * （日本語のプレイヤー名など）が混ざった行を数えられない。
 *
 * 文字幅の総和を1行の幅で割るだけでも、単語境界での折り返しを無視して行数を
 * 過小評価する（"aaaaaa bbbbbb cccccc"は幅10文字ぶんなら実際は3行）。
 * - 空白は行末でぶら下がるので、収まらない場合はその行を埋めるだけ
 * - トークン（tokenizeForWrap参照）は現在行に収まらなければ次行へ送る
 * - 1行にも収まらない長いトークンだけをbreak-wordとしてクラスタ単位で分割する
 *
 * @param measureToken トークンの描画幅(px)。フォントサイズは呼び出し側で束縛する
 * @param initialUsedWidth 先頭に既に置かれている内容（タイムスタンプ）の幅(px)
 */
export const countWrappedLines = (
  text: string,
  availableWidth: number,
  measureToken: (token: string) => number,
  initialUsedWidth = 0
): number => {
  if (text.length === 0 && initialUsedWidth === 0) return 0

  const limit = Math.max(0, availableWidth)
  let lines = 1
  let used = Math.max(0, initialUsedWidth)

  text.split('\n').forEach((hardLine, hardLineIndex) => {
    if (hardLineIndex > 0) {
      lines += 1
      used = 0
    }
    for (const token of tokenizeForWrap(hardLine)) {
      const width = measureToken(token)
      if (BREAKABLE_SPACE_PATTERN.test(token)) {
        used = used + width <= limit ? used + width : limit
        continue
      }
      if (used + width <= limit) {
        used += width
        continue
      }
      if (used > 0) {
        lines += 1
        used = 0
      }
      if (width <= limit) {
        used = width
        continue
      }
      // 1行に収まらない語だけをbreak-wordとして割る
      for (const cluster of splitGraphemes(token)) {
        const clusterWidth = measureToken(cluster)
        if (used > 0 && used + clusterWidth > limit) {
          lines += 1
          used = 0
        }
        used += clusterWidth
      }
    }
  })

  return lines
}

export interface HandLogRowMetrics {
  /**
   * 折り返しに使える本文幅(px)。
   * = リスト幅 - スクロールバー幅 - EntryRowの左右padding
   */
  textWidth: number
  fontSize: number
  showTimestamps: boolean
  /** 文字列→描画幅(px)。既定はcanvas実測（テストからの差し替え口） */
  measureText?: MeasureHandLogText
}

/**
 * 仮想リストの行高を、実際の本文幅で折り返した行数から求める。
 * `boxSizing: border-box`のEntryRowに与える高さなので、上下paddingを含む。
 */
export const estimateEntryRowHeight = (
  text: string,
  {
    textWidth,
    fontSize,
    showTimestamps,
    measureText = measureHandLogTextWidth
  }: HandLogRowMetrics
): number => {
  // タイムスタンプは本文より小さいフォントの別spanなので、そのフォントで測る
  const timestampWidth = showTimestamps
    ? measureText(
      HAND_LOG_TIMESTAMP_TEXT,
      Math.max(fontSize - HAND_LOG_TIMESTAMP_FONT_SIZE_OFFSET, 1)
    ) + HAND_LOG_TIMESTAMP_MARGIN_RIGHT
    : 0
  const lines = countWrappedLines(
    text,
    textWidth,
    token => measureText(token, fontSize),
    timestampWidth
  )
  return lines * fontSize * HAND_LOG_ENTRY_LINE_HEIGHT + HAND_LOG_ENTRY_PADDING_Y * 2
}

interface EntryRowData {
  items: Array<{ entry: HandLogEntry, isSeparator: boolean }>
  showTimestamps: boolean
  copiedHandId: number | null
  onEntryClick: (entry: HandLogEntry) => void
  fontSize: number
}

const EntryRow = ({ index, style, items, showTimestamps, copiedHandId, onEntryClick, fontSize }: {
  index: number
  style: CSSProperties
  ariaAttributes: {
    'aria-posinset': number
    'aria-setsize': number
    role: 'listitem'
  }
} & EntryRowData): React.ReactElement | null => {
  const item = items[index]

  if (!item) return null

  if (item.isSeparator) {
    return (
      <div style={{
        ...style,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        padding: `0 ${HAND_LOG_ENTRY_PADDING_X}px`
      }}>
        <div style={{
          borderTop: '1px solid rgba(255, 255, 255, 0.2)',
          width: '100%',
          opacity: 0.5
        }} />
      </div>
    )
  }

  const { entry } = item
  const [isHovered, setIsHovered] = useState(false)

  const entryStyle: CSSProperties = {
    // 行高の推定（estimateEntryRowHeight）はテキスト幅を
    // 「行幅 - 左右padding」として計算する。ホスト側CSSのbox-sizingに
    // 左右されないよう、ここで明示する。react-windowが与えるheightにも
    // 上下paddingが含まれるようになるため、垂直方向の勘定とも一致する。
    boxSizing: 'border-box',
    color: entryTypeColors[entry.type],
    lineHeight: HAND_LOG_ENTRY_LINE_HEIGHT,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    opacity: entry.type === HandLogEntryType.SEAT ? 0.8 : 1,
    cursor: 'pointer',
    transition: 'background-color 0.1s ease',
    backgroundColor: isHovered
      ? 'rgba(255, 255, 255, 0.1)'
      : copiedHandId === entry.handId
        ? 'rgba(0, 200, 0, 0.2)'
        : 'transparent',
    padding: `${HAND_LOG_ENTRY_PADDING_Y}px ${HAND_LOG_ENTRY_PADDING_X}px`,
    fontSize
  }

  const timestampStyle: CSSProperties = {
    color: '#666666',
    fontSize: fontSize - HAND_LOG_TIMESTAMP_FONT_SIZE_OFFSET,
    marginRight: `${HAND_LOG_TIMESTAMP_MARGIN_RIGHT}px`
  }

  return (
    <div
      style={{ ...style, ...entryStyle }}
      onClick={() => onEntryClick(entry)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {showTimestamps && (
        <span style={timestampStyle}>
          [{formatTimestamp(entry.timestamp)}]
        </span>
      )}
      {entry.text}
    </div>
  )
}

const HandLog = memo<HandLogProps>(({ entries, config: userConfig, onClearLog, scale = 1, scrollToLatest }) => {
  const config = useMemo(() => ({ ...DEFAULT_HAND_LOG_CONFIG, ...userConfig }), [userConfig])
  const listRef = useListRef(null)
  const [copiedHandId, setCopiedHandId] = useState<number | null>(null)
  const [layoutMachine, setLayoutMachine] =
    useState<HandLogLayoutMachine>(() =>
      createHandLogLayoutMachine(readHandLogEnvironment(scale))
    )
  const layoutMachineRef = useRef(layoutMachine)
  const loadSequenceRef = useRef(0)
  const requestedLoadScaleRef = useRef<number | null>(null)
  const latestScaleRef = useRef(scale)
  latestScaleRef.current = scale
  const measuredScrollbarRatioRef = useRef(
    typeof window === 'undefined' ? 1 : window.devicePixelRatio
  )
  const [showCopied, setShowCopied] = useState(false)
  const [showCleared, setShowCleared] = useState(false)
  const lastClickTimeRef = useRef<number>(0)

  const commitLayoutAction = useCallback((
    action: HandLogMachineAction,
    render = true
  ) => {
    const transition = transitionHandLogLayout(
      layoutMachineRef.current,
      action
    )
    if (transition.state !== layoutMachineRef.current) {
      layoutMachineRef.current = transition.state
      if (render) {
        setLayoutMachine(transition.state)
      }
    }
    if (transition.persist) {
      saveHandLogLayout(transition.persist)
    }
  }, [])

  // セパレーターを追加するためエントリを処理
  const processedItems = useMemo(() => {
    const items: Array<{ entry: HandLogEntry, isSeparator: boolean }> = []
    const handGroups = new Map<number | undefined, HandLogEntry[]>()

    // handIdでエントリをグループ化
    entries.forEach(entry => {
      const group = handGroups.get(entry.handId) || []
      group.push(entry)
      handGroups.set(entry.handId, group)
    })

    // セパレーター付きでエントリを追加
    let isFirstHand = true
    handGroups.forEach((handEntries, handId) => {
      if (!isFirstHand && handId !== undefined) {
        items.push({ entry: handEntries[0]!, isSeparator: true })
      }
      isFirstHand = false

      handEntries.forEach(entry => {
        items.push({ entry, isSeparator: false })
      })
    })

    return items
  }, [entries])

  // Display-only shrink: the layout kept by the machine remains persistable.
  const displaySize = getHandLogDisplaySize(
    layoutMachine.layout,
    layoutMachine.environment
  )
  // border-boxなのでbody部はborderぶん内側になる。
  const bodyWidth = Math.max(
    0,
    displaySize.width - HAND_LOG_BORDER_WIDTH * 2
  )
  const bodyHeight = Math.max(
    0,
    displaySize.height - HAND_LOG_BORDER_WIDTH * 2
  )

  // Listは`overflow: auto`なので、Windows/Linuxのような非オーバーレイ
  // スクロールバー環境では行の包含ブロックがその幅だけ狭くなる。
  // `scrollbarGutter: 'stable'`でスクロール有無に関わらず同じ幅を確保し、
  // 推定と実描画のどちらの状態でも一致させる（オーバーレイ環境では0）。
  const [scrollbarWidth, setScrollbarWidth] = useState(() => getScrollbarSize())

  // 折り返しに使える本文幅。行はリスト幅いっぱい（width:100%）なので、
  // 行の包含ブロックはbody幅からスクロールバー幅を除いた分で、そこから
  // EntryRow自身の左右paddingだけがテキスト幅を狭める。保存幅ではなく
  // 表示幅から引くのが要点: viewportが保存幅より狭いときは表示だけが縮み、
  // 折り返しは縮んだ側で起きる。
  const entryTextWidth = Math.max(
    0,
    bodyWidth - scrollbarWidth - HAND_LOG_ENTRY_PADDING_X * 2
  )

  // アイテムの高さを計算
  // 本文幅・フォントサイズ・タイムスタンプ有無が変わるとこのコールバックの
  // identityも変わり、react-window側の行境界キャッシュ（rowHeightに対する
  // useMemo）が破棄されて再計算される。
  const getItemSize = useCallback((index: number) => {
    const item = processedItems[index]
    if (!item) return 0
    if (item.isSeparator) return HAND_LOG_SEPARATOR_HEIGHT

    return estimateEntryRowHeight(item.entry.text, {
      textWidth: entryTextWidth,
      fontSize: config.fontSize,
      showTimestamps: config.showTimestamps
    })
  }, [processedItems, entryTextWidth, config.fontSize, config.showTimestamps])

  // Prop scale and viewport dimensions are inputs to the same layout machine
  // as pointer interaction. useLayoutEffect updates scale before paint while
  // idle; an active interaction keeps rendering its start environment and
  // applies the pending environment through the common finish transition.
  useLayoutEffect(() => {
    commitLayoutAction({
      type: 'environmentChanged',
      environment: readHandLogEnvironment(scale),
    })
  }, [scale, commitLayoutAction])

  useEffect(() => {
    // A scale change during pointer interaction is loaded only after the
    // interaction ends. This avoids adding another layout-machine lifecycle
    // branch while ensuring the latest scale still gets an authoritative load.
    if (layoutMachine.interaction.phase === 'interacting') return
    if (requestedLoadScaleRef.current === scale) return
    requestedLoadScaleRef.current = scale
    const load = {
      id: ++loadSequenceRef.current,
      scale,
    }
    commitLayoutAction({ type: 'loadStarted', load })
    loadHandLogLayout(savedLayout => {
      commitLayoutAction({
        type: 'loadResolved',
        load,
        layout: savedLayout,
      })
    })
  }, [scale, layoutMachine.interaction.phase, commitLayoutAction])

  useEffect(() => {
    const handleViewportResize = () => {
      // ページズーム（やモニタ間移動）はスクロールバーのCSSピクセル幅を変える。
      // 物理幅は変わらないので、ズームアウトすると実際のgutterは広がる。
      // getScrollbarSize()は初回値をモジュール内にキャッシュするため、
      // devicePixelRatioが変わったときだけ強制的に測り直す
      // （毎resizeでプローブを挿すと余計な強制レイアウトになる）。
      if (window.devicePixelRatio !== measuredScrollbarRatioRef.current) {
        measuredScrollbarRatioRef.current = window.devicePixelRatio
        setScrollbarWidth(getScrollbarSize(true))
      }
      // A stale passive-effect listener may fire after a new scale render.
      commitLayoutAction({
        type: 'environmentChanged',
        environment: readHandLogEnvironment(latestScaleRef.current),
      })
    }
    const handleReset = () => {
      commitLayoutAction({
        type: 'reset',
        environment: readHandLogEnvironment(latestScaleRef.current),
      })
    }
    const handleUpdate = (event: Event) => {
      const nextLayout = (event as CustomEvent<unknown>).detail
      if (!isValidHandLogLayout(nextLayout)) return
      commitLayoutAction({ type: 'externalLayout', layout: nextLayout })
    }
    window.addEventListener('resize', handleViewportResize)
    window.addEventListener('resetHandLogLayout', handleReset)
    window.addEventListener('updateHandLogLayout', handleUpdate)
    return () => {
      window.removeEventListener('resize', handleViewportResize)
      window.removeEventListener('resetHandLogLayout', handleReset)
      window.removeEventListener('updateHandLogLayout', handleUpdate)
    }
  }, [scale, commitLayoutAction])

  // 新しいエントリが到着したとき自動的に下にスクロール
  useEffect(() => {
    if (listRef.current && processedItems.length > 0) {
      listRef.current.scrollToRow({ index: processedItems.length - 1, align: "end" })
    }
  }, [processedItems.length])
  
  // 外部クリックでスクロールをトリガー
  useEffect(() => {
    if (scrollToLatest && listRef.current && processedItems.length > 0) {
      listRef.current.scrollToRow({ index: processedItems.length - 1, align: "end" })
    }
  }, [scrollToLatest, processedItems.length])

  // ハンドをクリップボードにコピー
  const copyHandToClipboard = useCallback(async (handId: number | undefined) => {
    try {
      if (!handId) {
        console.warn('No handId found for clicked entry')
        return
      }

      const handEntries = entries.filter(e => e.handId === handId)
      if (handEntries.length === 0) {
        console.warn('No entries found for handId:', handId)
        return
      }

      const logText = formatHandLogEntries(handEntries)

      await navigator.clipboard.writeText(logText)
      setCopiedHandId(handId)
      setShowCopied(true)

      setTimeout(() => {
        setShowCopied(false)
        setCopiedHandId(null)
      }, 1500)
    } catch (error) {
      console.error('Failed to copy hand to clipboard:', error)
    }
  }, [entries])

  // エントリクリックを処理
  const handleEntryClick = useCallback((entry: HandLogEntry) => {
    copyHandToClipboard(entry.handId)
  }, [copyHandToClipboard])

  // コンテナクリックを処理 - ダブルクリックでクリア
  const handleContainerClick = useCallback((_e: React.MouseEvent) => {
    if (layoutMachineRef.current.interaction.phase === 'interacting') return

    const currentTime = Date.now()
    const timeSinceLastClick = currentTime - lastClickTimeRef.current
    lastClickTimeRef.current = currentTime

    if (timeSinceLastClick < 300 && onClearLog) {
      onClearLog()
      setShowCleared(true)
      setTimeout(() => setShowCleared(false), 1500)
    }
  }, [onClearLog])

  const handleInteractionStart = useCallback((
    mode: HandLogInteractionMode,
    e: React.MouseEvent
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    commitLayoutAction({
      type: 'interactionStarted',
      mode,
      x: e.clientX,
      y: e.clientY,
    })
  }, [commitLayoutAction])

  const finishLayoutInteraction = useCallback((render = true) => {
    const current = layoutMachineRef.current
    if (current.interaction.phase !== 'interacting') return

    const deferredScaleLoad =
      requestedLoadScaleRef.current !== latestScaleRef.current
    const deferPersistenceForLoad =
      !current.interaction.moved &&
      (
        deferredScaleLoad ||
        (
          current.pendingEnvironment !== null &&
          current.activeLoad !== null
        )
      )

    if (current.interaction.moved && deferredScaleLoad) {
      // An intentional move/resize wins over the deferred saved layout.
      // Mark the new scale handled so the post-finish effect cannot rewind it.
      requestedLoadScaleRef.current = latestScaleRef.current
    }

    commitLayoutAction({
      type: 'interactionFinished',
      deferPersistenceForLoad,
    }, render)
  }, [commitLayoutAction])

  useEffect(() => {
    const interaction = layoutMachine.interaction
    const interactionMode =
      interaction.phase === 'interacting' ? interaction.mode : null
    if (!interactionMode) return

    const cursor = interactionMode === 'move' ? 'grabbing' : 'nwse-resize'
    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'

    const finishInteraction = () => {
      finishLayoutInteraction()
    }

    const handleMouseMove = (event: MouseEvent) => {
      // A mouseup released outside the browser may never reach the document.
      // The first move after re-entry exposes the released primary button, so
      // finish without applying that stale pointer position.
      if ((event.buttons & 1) === 0) {
        finishInteraction()
        return
      }
      commitLayoutAction({
        type: 'pointerMoved',
        x: event.clientX,
        y: event.clientY,
      })
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', finishInteraction)
    window.addEventListener('blur', finishInteraction)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', finishInteraction)
      window.removeEventListener('blur', finishInteraction)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [
    layoutMachine.interaction.phase,
    layoutMachine.interaction.phase === 'interacting'
      ? layoutMachine.interaction.mode
      : null,
    finishLayoutInteraction,
  ])

  // Unmount uses the exact same transition/persistence outlet as
  // mouseup/blur, but skips the render after the component is gone.
  useEffect(() => () => {
    finishLayoutInteraction(false)
  }, [finishLayoutInteraction])

  // 無効の場合はレンダリングしない
  if (!config.enabled) return null

  const { layout, environment } = layoutMachine
  const { width, height } = displaySize
  const interactionMode =
    layoutMachine.interaction.phase === 'interacting'
      ? layoutMachine.interaction.mode
      : null

  // コンテナスタイル
  const containerStyle: CSSProperties = {
    position: 'fixed',
    // border込みでwidth/heightちょうどに収める。content-boxのままだと
    // 実寸がborder分だけ大きく、画面端の判定と2px（scale倍）ずれる。
    boxSizing: 'border-box',
    left: layout.left,
    top: layout.top,
    width: width,
    height,
    backgroundColor: `rgba(0, 0, 0, ${config.opacity})`,
    backdropFilter: 'blur(4px)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '4px',
    padding: '0',
    transform: `scale(${environment.scale})`,
    transformOrigin: 'top left',
    overflowY: 'hidden',
    overflowX: 'hidden',
    fontFamily: HAND_LOG_FONT_FAMILY,
    fontSize: config.fontSize,
    color: '#ffffff',
    // Keep the move grip and resize corner above player HUD panels (z-index
    // 9999) so an overlap cannot make either interaction unreachable.
    zIndex: 10000,
    boxShadow: '0 2px 4px rgba(0, 0, 0, 0.3)',
    cursor: 'default'
  }

  // 右上は移動専用。ヘッダー帯を廃してログ本文へ高さを明け渡す代わりに、
  // 右下のリサイズ角と対になる最小限の掴める領域だけを重ねる。行頭は必ず
  // 文字で埋まる一方、行末は余白になりやすいので左上ではなく右上に置く。
  const moveGripStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    top: 0,
    width: HAND_LOG_MOVE_GRIP_SIZE,
    height: HAND_LOG_MOVE_GRIP_SIZE,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: interactionMode === 'move' ? 'grabbing' : 'grab',
    // ログ本文へ重なるので、地の文と混ざらない程度には輪郭を持たせる。
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderLeft: '1px solid rgba(255, 255, 255, 0.2)',
    borderBottom: '1px solid rgba(255, 255, 255, 0.2)',
    borderRadius: '0 4px 0 4px',
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 11,
    lineHeight: 1,
    letterSpacing: -1,
    userSelect: 'none',
    zIndex: 2,
  }

  const resizeCornerStyle: CSSProperties = {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    cursor: 'nwse-resize',
    background: 'linear-gradient(135deg, transparent 48%, rgba(255, 255, 255, 0.9) 50%)',
    zIndex: 2,
  }

  const rowProps: EntryRowData = {
    items: processedItems,
    showTimestamps: config.showTimestamps,
    copiedHandId,
    onEntryClick: handleEntryClick,
    fontSize: config.fontSize
  }

  return (
    <div
      style={containerStyle}
      onClick={handleContainerClick}
    >
      {/* 左上は移動専用。右下はリサイズ専用。 */}
      <div
        data-testid="hand-log-move-grip"
        title="ドラッグしてハンドログを移動"
        style={moveGripStyle}
        onMouseDown={(event) => handleInteractionStart('move', event)}
        onClick={(event) => event.stopPropagation()}
      >
        <span aria-hidden="true">⠿</span>
      </div>

      {processedItems.length > 0 ? (
        <List
          listRef={listRef}
          rowCount={processedItems.length}
          rowHeight={getItemSize}
          rowComponent={EntryRow}
          rowProps={rowProps}
          style={{
            height: bodyHeight,
            width: bodyWidth,
            // 行高の推定がスクロールバー幅を常に差し引くので、実際の行幅も
            // スクロール有無で変わらないよう固定する（entryTextWidth参照）。
            scrollbarGutter: 'stable',
          }}
        />
      ) : (
        <div style={{
          height: bodyHeight,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666666',
          textAlign: 'center',
          fontSize: config.fontSize - 1
        }}>
          Waiting for hand...
        </div>
      )}

      <div
        data-testid="hand-log-resize-corner"
        title="ドラッグしてハンドログのサイズを変更"
        style={resizeCornerStyle}
        onMouseDown={(event) => handleInteractionStart('resize', event)}
        onClick={(event) => event.stopPropagation()}
      />

      {/* ステータスインジケーター */}
      {showCopied && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'rgba(0, 200, 0, 0.9)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '4px',
          fontWeight: 'bold',
          pointerEvents: 'none',
          zIndex: 1000
        }}>
          Copied Hand!
        </div>
      )}
      {showCleared && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'rgba(200, 0, 0, 0.9)',
          color: 'white',
          padding: '8px 16px',
          borderRadius: '4px',
          fontWeight: 'bold',
          pointerEvents: 'none',
          zIndex: 1000
        }}>
          Cleared!
        </div>
      )}
    </div>
  )
})

HandLog.displayName = 'HandLog'

export default HandLog
