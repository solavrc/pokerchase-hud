import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import HandLog from '../components/HandLog'
import Hud from '../components/Hud'
import type { StatDisplayConfig } from '../types'
import { installChromeMock } from './mock-chrome'
import {
  MOCK_SCENARIOS,
  type MockScenario,
  type MockScenarioId,
  type TableSeat,
} from './mock-data'
import {
  ACTION_BAR,
  BOARD_CENTER,
  CHROME,
  FELT,
  HERO_CARDS,
  HERO_CARD_STAGGER,
  HERO_HAND_LABEL,
  HERO_TIMER,
  POT,
  RAIL,
  RAIL_STUDS,
  SEATS,
  pointStyle,
  rectStyle,
} from './table-layout'

const chromeMock = installChromeMock()
const STAT_DISPLAY_CONFIGS: StatDisplayConfig[] = []

const CARD_COLORS: Record<string, string> = {
  '♣': 'card--black',
  '♦': 'card--red',
  '♥': 'card--red',
  '♠': 'card--black',
}

const BLIND_LABELS: Record<NonNullable<TableSeat['blind']>, string> = {
  BB: 'BB',
  BTN: 'D',
  SB: 'SB',
}

const cardClassName = (card: string): string => {
  const suit = card.slice(-1)
  return `pc-card ${CARD_COLORS[suit] ?? 'card--black'}`
}

const Card = ({ card, style }: { card: string; style?: React.CSSProperties }) => (
  <span className={cardClassName(card)} style={style}>
    <span className="pc-card__index">
      <b>{card.slice(0, -1)}</b>
      <i>{card.slice(-1)}</i>
    </span>
    <i aria-hidden="true" className="pc-card__pip">{card.slice(-1)}</i>
  </span>
)

/**
 * One seat, drawn as the real client does: a character portrait behind a name
 * plate (stack over name), face-down cards above the plate, an action bubble
 * over the portrait's head, and the seat's blind marker plus committed chips
 * out on the felt. Every coordinate comes from `table-layout.ts`.
 */
const Seat = ({ dealt, index, seat }: { dealt: boolean; index: number; seat: TableSeat }) => {
  const layout = SEATS[index]!
  const plateClass = [
    'pc-plate',
    seat.isHero && 'pc-plate--hero',
    seat.highlight && 'pc-plate--highlight',
    seat.folded && 'pc-plate--folded',
    seat.empty && 'pc-plate--empty',
  ].filter(Boolean).join(' ')

  return (
    <>
      {!seat.empty && <div aria-hidden="true" className="pc-portrait" style={rectStyle(layout.portrait)} />}

      {dealt && !seat.empty && !seat.folded && !seat.isHero && (
        <div aria-hidden="true" className="pc-holecards" style={rectStyle(layout.cards)}>
          <span />
          <span />
        </div>
      )}

      <div className={plateClass} style={rectStyle(layout.plate)}>
        {seat.empty
          ? <span className="pc-plate__empty">空席</span>
          : (
            <>
              <span className="pc-plate__stack">{seat.stack}</span>
              <span className="pc-plate__name">{seat.name}</span>
            </>
          )}
      </div>

      {seat.action && (
        <span className="pc-bubble" style={pointStyle(layout.bubble)}>{seat.action}</span>
      )}

      {seat.blind && (
        <span
          className={`pc-blind pc-blind--${seat.blind.toLowerCase()}`}
          style={pointStyle(layout.badge)}
        >
          {BLIND_LABELS[seat.blind]}
        </span>
      )}

      {seat.bet && (
        <div className="pc-bet" style={pointStyle(layout.bet)}>
          <span aria-hidden="true" className="pc-chips" />
          <span className="pc-bet__amount">{seat.bet}</span>
        </div>
      )}
    </>
  )
}

/** Fixed client chrome: menu, blind panel, clock, help and the promo rail. */
const GameChrome = ({ scenario }: { scenario: MockScenario }) => (
  <>
    <div className="pc-menu" style={rectStyle(CHROME.menu)}><span>メニュー</span></div>

    <div className="pc-info" style={rectStyle(CHROME.stakes)}>
      <span>SB/BB</span>
      <strong>{scenario.stakes}</strong>
    </div>
    <div className="pc-info" style={rectStyle(CHROME.ante)}>
      <span>アンティ</span>
      <strong>{scenario.ante}</strong>
    </div>

    <div className="pc-pill" style={rectStyle(CHROME.clock)}>{scenario.clock}</div>
    <div className="pc-pill" style={rectStyle(CHROME.street)}>{scenario.phase}</div>

    <div className="pc-help" style={rectStyle(CHROME.help)}>ヘルプ</div>
    <div className="pc-emoji" style={rectStyle(CHROME.emoji)} />
    <div className="pc-promo" style={rectStyle(CHROME.promo)}>SIDE<br />GAME</div>
    <div className="pc-guide" style={rectStyle(CHROME.guide)}>
      <span>Ctrl</span> ガイド表示/非表示
    </div>
  </>
)

/** Bottom betting bar. Decorative: the mockup never drives real game input. */
const ActionBar = ({ scenario }: { scenario: MockScenario }) => {
  const isIdle = !scenario.callAmount

  return (
    <div className="pc-actionbar">
      <div className="pc-actionbar__frame" style={rectStyle(ACTION_BAR.frame)} />
      <div className="pc-preaction" style={rectStyle(ACTION_BAR.preAction)}>
        <span aria-hidden="true" />
        チェック<br />フォールド
      </div>

      <div
        className={`pc-action pc-action--pale${isIdle ? ' pc-action--idle' : ''}`}
        style={rectStyle(ACTION_BAR.buttons[0]!)}
      >
        フォールド
      </div>
      <div
        className={`pc-action${isIdle ? ' pc-action--idle' : ''}`}
        style={rectStyle(ACTION_BAR.buttons[1]!)}
      >
        コール<b>{scenario.callAmount ?? '—'}</b>
      </div>
      <div
        className={`pc-action${isIdle ? ' pc-action--idle' : ''}`}
        style={rectStyle(ACTION_BAR.buttons[2]!)}
      >
        レイズ<b>{scenario.raiseAmount ?? '—'}</b>
      </div>

      <div className="pc-stepper pc-stepper--minus" style={rectStyle(ACTION_BAR.minus)}><span /></div>
      <div className="pc-multiplier" style={rectStyle(ACTION_BAR.multiplier)}>x2.5</div>
      <div className="pc-slider" style={rectStyle(ACTION_BAR.slider)} />
      <div className="pc-slider__knob" style={rectStyle(ACTION_BAR.sliderKnob)} />
      <div className="pc-allin" style={rectStyle(ACTION_BAR.allIn)}>オールイン</div>
      <div className="pc-stepper pc-stepper--plus" style={rectStyle(ACTION_BAR.plus)}><span /></div>
    </div>
  )
}

const Mockup = () => {
  const [scenarioId, setScenarioId] = useState<MockScenarioId>('turn-decision')
  const [scale, setScale] = useState(1)
  const [showHandLog, setShowHandLog] = useState(true)
  const [dimTable, setDimTable] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [hudRevision, setHudRevision] = useState(0)
  const scenario = MOCK_SCENARIOS[scenarioId]

  const resetHudPositions = () => {
    chromeMock.clearHudPositions()
    setHudRevision((revision) => revision + 1)
  }

  return (
    <main className={`mockup${dimTable ? ' mockup--dimmed' : ''}`}>
      <section className="pc-scene" aria-label="PokerChase のゲーム画面を模したモック背景">
        <div aria-hidden="true" className="pc-backdrop" />
        <div aria-hidden="true" className="pc-rail" style={rectStyle(RAIL)} />
        {RAIL_STUDS.map((stud) => (
          <div aria-hidden="true" className="pc-stud" key={`${stud.l}-${stud.t}`} style={pointStyle(stud)} />
        ))}
        <div aria-hidden="true" className="pc-felt" style={rectStyle(FELT)}>
          <div className="pc-felt__ring" />
        </div>

        <div className="pc-pot" style={rectStyle(POT)}>Pot : {scenario.pot}</div>

        <div
          className="pc-board"
          aria-label={`Board: ${scenario.board.join(' ') || 'none'}`}
          style={{ left: `${BOARD_CENTER.l}%`, top: `${BOARD_CENTER.t}%` }}
        >
          {scenario.board.map((card) => <Card card={card} key={card} />)}
        </div>

        {/* Nobody holds cards until the hand is dealt -- hero's own hole cards
            are the tell, since the client only shows them from EVT_DEAL on. */}
        {scenario.seats.map((seat, index) => (
          <Seat
            dealt={scenario.heroCards.length > 0}
            index={index}
            key={`${scenario.id}-${index}`}
            seat={seat}
          />
        ))}

        {scenario.heroCards.length > 0 && (
          <>
            <div
              className="pc-herocards"
              aria-label={`Hero cards: ${scenario.heroCards.join(' ')}`}
              style={rectStyle(HERO_CARDS)}
            >
              {scenario.heroCards.map((card, index) => (
                <Card
                  card={card}
                  key={card}
                  style={index > 0
                    ? { transform: `translateY(calc(var(--u) * ${HERO_CARD_STAGGER}))` }
                    : undefined}
                />
              ))}
            </div>
            {scenario.heroHandLabel && (
              <div className="pc-handlabel" style={pointStyle(HERO_HAND_LABEL)}>
                {scenario.heroHandLabel}
              </div>
            )}
            <div className="pc-herotimer" style={rectStyle(HERO_TIMER)}>
              <span aria-hidden="true" />
              10
            </div>
          </>
        )}

        <GameChrome scenario={scenario} />
        <ActionBar scenario={scenario} />
      </section>

      <button
        aria-expanded={panelOpen}
        className="control-trigger"
        onClick={() => setPanelOpen((isOpen) => !isOpen)}
        type="button"
      >
        <span aria-hidden="true">◎</span>
        モック操作
      </button>

      {panelOpen && (
        <aside className="control-panel" aria-label="Mockup controls">
          <div className="control-panel__header">
            <div>
              <span>POKERCHASE HUD</span>
              <h1>Visual mockup</h1>
            </div>
            <button aria-label="操作パネルを閉じる" onClick={() => setPanelOpen(false)} type="button">×</button>
          </div>
          <p>本番 HUD コンポーネントを固定データ上で確認します。</p>

          <label className="control-field">
            <span>表示状態</span>
            <select
              onChange={(event) => setScenarioId(event.target.value as MockScenarioId)}
              value={scenarioId}
            >
              {Object.values(MOCK_SCENARIOS).map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>

          <label className="control-field">
            <span>HUD 倍率 <output>{scale.toFixed(1)}×</output></span>
            <input
              max="1.4"
              min="0.7"
              onChange={(event) => setScale(Number(event.target.value))}
              step="0.1"
              type="range"
              value={scale}
            />
          </label>

          <label className="control-toggle">
            <input
              checked={showHandLog}
              onChange={(event) => setShowHandLog(event.target.checked)}
              type="checkbox"
            />
            <span>ハンドログを表示</span>
          </label>

          <label className="control-toggle">
            <input
              checked={dimTable}
              onChange={(event) => setDimTable(event.target.checked)}
              type="checkbox"
            />
            <span>背景を暗くして可読性を確認</span>
          </label>

          <button className="reset-button" onClick={resetHudPositions} type="button">
            HUD のドラッグ位置をリセット
          </button>
          <small>
            背景は e2e/public/assets/table-backdrop.jpg を実測した座標で再現しています。
            HUD 上端のハンドルをドラッグできます。統計パネルはクリックでコピーします。
          </small>
        </aside>
      )}

      <div className="mock-badge">
        <span />
        MOCK DATA · {scenario.label}
      </div>

      {scenario.stats.map((stat, index) => (
        <Hud
          actualSeatIndex={index}
          key={`${scenario.id}-${hudRevision}-${index}`}
          playerPotOdds={scenario.playerPotOdds[index]}
          realTimeStats={index === 0 ? scenario.realTimeStats : undefined}
          scale={scale}
          stat={stat}
          statDisplayConfigs={STAT_DISPLAY_CONFIGS}
        />
      ))}

      {showHandLog && (
        <HandLog
          config={{ enabled: true, opacity: 0.76, position: 'bottom-right' }}
          entries={scenario.handLogEntries}
          key={`${scenario.id}-${hudRevision}-log`}
          scale={scale}
        />
      )}
    </main>
  )
}

const root = document.getElementById('mockup-root')

if (!root) throw new Error('Missing #mockup-root')

createRoot(root).render(<Mockup />)
