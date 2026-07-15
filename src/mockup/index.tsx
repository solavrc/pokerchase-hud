import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import HandLog from '../components/HandLog'
import Hud from '../components/Hud'
import type { StatDisplayConfig } from '../types'
import { installChromeMock } from './mock-chrome'
import {
  MOCK_SCENARIOS,
  type MockScenarioId,
  type TableSeat,
} from './mock-data'

const chromeMock = installChromeMock()
const STAT_DISPLAY_CONFIGS: StatDisplayConfig[] = []

const CARD_COLORS: Record<string, string> = {
  '♣': 'card--black',
  '♦': 'card--red',
  '♥': 'card--red',
  '♠': 'card--black',
}

const cardClassName = (card: string): string => {
  const suit = card.slice(-1)
  return `playing-card ${CARD_COLORS[suit] ?? 'card--black'}`
}

const Seat = ({ index, seat }: { index: number; seat: TableSeat }) => (
  <div className={`table-seat table-seat--${index}${seat.isHero ? ' table-seat--hero' : ''}`}>
    <div className="seat-avatar" aria-hidden="true">
      {seat.name === 'empty' ? '+' : seat.name.slice(0, 1).toUpperCase()}
    </div>
    <div className="seat-copy">
      <span className="seat-name">{seat.name}</span>
      <span className="seat-stack">{seat.stack}</span>
    </div>
    {seat.action && <span className="seat-action">{seat.action}</span>}
  </div>
)

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
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />

      <header className="game-bar">
        <div>
          <span className="game-bar__caption">VISUAL LAB</span>
          <strong>{scenario.stakes}</strong>
        </div>
        <div className="game-bar__phase">
          <span>{scenario.eyebrow}</span>
          <strong>{scenario.phase}</strong>
        </div>
        <div className="game-bar__timer" aria-label="decision timer">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span className="is-muted" />
          <span className="is-muted" />
          <span className="is-muted" />
        </div>
      </header>

      <section className="table-stage" aria-label="Synthetic six-max poker table">
        <div className="table-rail">
          <div className="table-felt">
            <div className="felt-mark">
              <span>PC</span>
              <small>HUD LAB</small>
            </div>
            <div className="board" aria-label={`Board: ${scenario.board.join(' ') || 'none'}`}>
              {scenario.board.map((card) => (
                <span className={cardClassName(card)} key={card}>{card}</span>
              ))}
              {scenario.board.length === 0 && <span className="board-empty">WAITING FOR HAND</span>}
            </div>
            <div className="pot-display">
              <span>POT</span>
              <strong>{scenario.pot}</strong>
            </div>
            {scenario.heroCards.length > 0 && (
              <div className="hero-cards" aria-label={`Hero cards: ${scenario.heroCards.join(' ')}`}>
                {scenario.heroCards.map((card) => (
                  <span className={cardClassName(card)} key={card}>{card}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {scenario.seats.map((seat, index) => (
          <Seat index={index} key={`${scenario.id}-${index}`} seat={seat} />
        ))}
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
          <small>HUD 上端のハンドルをドラッグできます。統計パネルはクリックでコピーします。</small>
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
