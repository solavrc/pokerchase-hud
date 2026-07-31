import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import HandLog from '../components/HandLog'
import Hud from '../components/Hud'
import Popup from '../components/Popup'
import {
  POPUP_BOOT_LOCAL_STORAGE_KEY,
  resolveBootBackgroundColor,
} from '../components/popup/popup-boot-theme'
import { POPUP_THEME_STORAGE_KEY } from '../components/popup/popup-theme-storage'
import { defaultStatDisplayConfigs } from '../stats'
import type { StatDisplayConfig } from '../types'
import { DEFAULT_UI_CONFIG, type UIConfig } from '../types/hand-log'
import {
  mergeUIConfigWithLocalScale,
  UI_SCALE_STORAGE_KEY,
} from '../utils/ui-config-storage'
import { installChromeMock } from './mock-chrome'
import {
  MOCK_SCENARIOS,
  type MockScenarioId,
  type TableSeat,
} from './mock-data'
import {
  ACTION_BAR,
  BOARD_CENTER,
  BOARD_SLOTS,
  CHROME,
  FELT,
  FELT_RADIUS,
  HERO_CARDS,
  HERO_CARD_STAGGER,
  HERO_HAND_LABEL,
  POT,
  RAIL,
  RAIL_RADIUS,
  RAIL_STUDS,
  SEATS,
  pointStyle,
  rectStyle,
} from './table-layout'

const chromeMock = installChromeMock()

/**
 * One seat: a character portrait behind a name plate, with face-down cards
 * above it. The plate keeps its two-line shape but shows placeholders -- the
 * table is a shell (see the scope note in `table-layout.ts`), so it never
 * asserts a stack or a name. The HUD panel above it is where real values live.
 */
const Seat = ({ index, seat }: { index: number; seat: TableSeat }) => {
  const layout = SEATS[index]!
  const plateClass = [
    'pc-plate',
    seat.isHero && 'pc-plate--hero',
    seat.empty && 'pc-plate--empty',
  ].filter(Boolean).join(' ')

  return (
    <>
      {!seat.empty && <div aria-hidden="true" className="pc-portrait" style={rectStyle(layout.portrait)} />}

      {!seat.empty && !seat.isHero && (
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
              <span className="pc-plate__stack">—</span>
              <span className="pc-plate__name">—</span>
            </>
          )}
      </div>
    </>
  )
}

/** Fixed client chrome: menu, blind panel, clock, help and the promo rail. */
const GameChrome = () => (
  <>
    <div className="pc-menu" style={rectStyle(CHROME.menu)}><span>メニュー</span></div>

    <div className="pc-info" style={rectStyle(CHROME.stakes)}>
      <span>SB/BB</span>
      <strong>—</strong>
    </div>
    <div className="pc-info" style={rectStyle(CHROME.ante)}>
      <span>アンティ</span>
      <strong>—</strong>
    </div>

    <div className="pc-pill" style={rectStyle(CHROME.clock)}>—</div>
    <div className="pc-pill" style={rectStyle(CHROME.street)}>—</div>

    <div className="pc-help" style={rectStyle(CHROME.help)}>ヘルプ</div>
    <div className="pc-emoji" style={rectStyle(CHROME.emoji)} />
    <div className="pc-promo" style={rectStyle(CHROME.promo)}>SIDE<br />GAME</div>
    <div className="pc-guide" style={rectStyle(CHROME.guide)}>
      <span>Ctrl</span> ガイド表示/非表示
    </div>
  </>
)

/**
 * Bottom betting bar. Controls only -- the buttons carry their labels but no
 * amounts, because what matters here is which part of the screen the bar
 * occupies (it is the largest thing a HUD panel can end up behind), not what
 * any particular hand costs to call.
 */
const ActionBar = () => (
  <div className="pc-actionbar">
    <div className="pc-actionbar__frame" style={rectStyle(ACTION_BAR.frame)} />
    <div className="pc-preaction" style={rectStyle(ACTION_BAR.preAction)}>
      <span aria-hidden="true" />
      チェック<br />フォールド
    </div>

    <div className="pc-action pc-action--pale" style={rectStyle(ACTION_BAR.buttons[0]!)}>フォールド</div>
    <div className="pc-action" style={rectStyle(ACTION_BAR.buttons[1]!)}>コール</div>
    <div className="pc-action" style={rectStyle(ACTION_BAR.buttons[2]!)}>レイズ</div>

    <div className="pc-stepper pc-stepper--minus" style={rectStyle(ACTION_BAR.minus)}><span /></div>
    {ACTION_BAR.multipliers.map(({ label, wordLabel, ...rect }) => (
      <div
        className={`pc-multiplier${wordLabel ? ' pc-multiplier--word' : ''}`}
        key={label}
        style={rectStyle(rect)}
      >
        {label}
      </div>
    ))}
    <div className="pc-slider" style={rectStyle(ACTION_BAR.slider)} />
    <div className="pc-slider__knob" style={pointStyle(ACTION_BAR.sliderKnob)} />
    <div className="pc-stepper pc-stepper--plus" style={rectStyle(ACTION_BAR.plus)}><span /></div>
  </div>
)

const Mockup = () => {
  const [scenarioId, setScenarioId] = useState<MockScenarioId>('turn-decision')
  const [showHandLog, setShowHandLog] = useState(true)
  const [showPopup, setShowPopup] = useState(false)
  const [dimTable, setDimTable] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [hudRevision, setHudRevision] = useState(0)
  const scenario = MOCK_SCENARIOS[scenarioId]

  /*
   * The popup writes HUD display settings to the same storage the production
   * App.tsx reads, so read them the same way (including its
   * DEFAULT_UI_CONFIG merge and the device-local scale override). Without
   * this, changing サイズ / 表示 / コンパクト / 統計カラー in the mocked popup
   * would look applied while the HUD under review never moved.
   */
  const [uiConfig, setUIConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG)
  /*
   * Cloned, never the shared array. `Popup` seeds its own state from the same
   * exported `defaultStatDisplayConfigs` and its reorder handler swaps
   * `config.order` IN PLACE, so holding those objects here would let a
   * not-yet-applied reorder reach the HUD the next time `orderedStats`
   * recomputes. Production cannot hit this -- popup and content script are
   * separate JS contexts -- but the mock runs both in one page.
   */
  const [statDisplayConfigs, setStatDisplayConfigs] = useState<StatDisplayConfig[]>(
    () => defaultStatDisplayConfigs.map((config) => ({ ...config })),
  )

  useEffect(() => {
    const readConfig = () => {
      chrome.storage.sync.get(['uiConfig', 'options'], (synced: Record<string, any>) => {
        chrome.storage.local.get(UI_SCALE_STORAGE_KEY, (local: Record<string, any>) => {
          setUIConfig(mergeUIConfigWithLocalScale(synced.uiConfig, local[UI_SCALE_STORAGE_KEY]))
          const configs = synced.options?.filterOptions?.statDisplayConfigs
          // Cloned for the same reason as the initial state above: the mock's
          // storage hands back the very objects the popup put in.
          if (configs) {
            setStatDisplayConfigs(configs.map((config: StatDisplayConfig) => ({ ...config })))
          }
        })
      })
    }
    readConfig()
    // A mock can afford to re-read everything on any change.
    chrome.storage.onChanged.addListener(readConfig)
    return () => chrome.storage.onChanged.removeListener(readConfig)
  }, [])

  const scale = uiConfig.scale

  /*
   * Production hands the HUD results that were already produced in config
   * order (`StatsRegistry.calculateWithConfig` sorts enabled configs by
   * `order` before computing). `Hud`'s own `filterEnabledDisplayStats()` only
   * filters, so a static fixture keeps its authored order and reordering
   * stats in the popup would appear to do nothing. Sort the fixture the same
   * way. Results the popup does not manage (e.g. `playerName`) have no order
   * and stay in front, keeping the header lookups working.
   */
  const orderedStats = useMemo(() => {
    const orderById = new Map(statDisplayConfigs.map((config) => [config.id, config.order]))
    return scenario.stats.map((stat) => {
      if (!('statResults' in stat) || !stat.statResults) return stat
      const statResults = [...stat.statResults].sort((a, b) => {
        const left = orderById.get(a.id)
        const right = orderById.get(b.id)
        if (left === undefined && right === undefined) return 0
        if (left === undefined) return -1
        if (right === undefined) return 1
        return left - right
      })
      return { ...stat, statResults }
    })
  }, [scenario, statDisplayConfigs])

  /*
   * The popup frame has to keep supplying the ground colour that the real
   * popup page paints on `html`, and both of that colour's inputs can change
   * while the popup is open: the user picks 自動/ダーク/ライト inside `Popup`
   * (persisted to `chrome.storage.sync`), or the OS scheme flips under 自動.
   * Neither re-renders this component on its own, so subscribe to both --
   * otherwise the frame keeps the colour it had at mount and the popup's own
   * transparent gaps read as the wrong theme.
   */
  const [popupThemeMode, setPopupThemeMode] = useState<string | null>(
    () => window.localStorage.getItem(POPUP_BOOT_LOCAL_STORAGE_KEY),
  )
  const [prefersDarkScheme, setPrefersDarkScheme] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'sync') return
      const change = changes[POPUP_THEME_STORAGE_KEY]
      if (change) setPopupThemeMode((change.newValue as string | undefined) ?? null)
    }
    chrome.storage.onChanged.addListener(onStorageChange)

    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const onSchemeChange = (event: MediaQueryListEvent) => setPrefersDarkScheme(event.matches)
    scheme.addEventListener('change', onSchemeChange)

    return () => {
      chrome.storage.onChanged.removeListener(onStorageChange)
      scheme.removeEventListener('change', onSchemeChange)
    }
  }, [])

  const popupBackground = resolveBootBackgroundColor(popupThemeMode, prefersDarkScheme)

  const resetHudPositions = () => {
    chromeMock.clearHudPositions()
    setHudRevision((revision) => revision + 1)
  }

  return (
    <main className={`mockup${dimTable ? ' mockup--dimmed' : ''}`}>
      <section className="pc-scene" aria-label="PokerChase のゲーム画面を模したモック背景">
        <div aria-hidden="true" className="pc-backdrop" />
        <div
          aria-hidden="true"
          className="pc-rail"
          style={{ ...rectStyle(RAIL), borderRadius: RAIL_RADIUS }}
        />
        {RAIL_STUDS.map((stud) => (
          <div aria-hidden="true" className="pc-stud" key={`${stud.l}-${stud.t}`} style={pointStyle(stud)} />
        ))}
        <div
          aria-hidden="true"
          className="pc-felt"
          style={{ ...rectStyle(FELT), borderRadius: FELT_RADIUS }}
        >
          <div className="pc-felt__ring" />
        </div>

        <div className="pc-pot" style={rectStyle(POT)}>Pot : —</div>

        <div
          aria-hidden="true"
          className="pc-board"
          style={{ left: `${BOARD_CENTER.l}%`, top: `${BOARD_CENTER.t}%` }}
        >
          {Array.from({ length: BOARD_SLOTS }, (_, slot) => (
            <span className="pc-card pc-card--slot" key={`board-${slot}`} />
          ))}
        </div>

        {scenario.seats.map((seat, index) => (
          <Seat index={index} key={`${scenario.id}-${index}`} seat={seat} />
        ))}

        <div aria-hidden="true" className="pc-herocards" style={rectStyle(HERO_CARDS)}>
          <span className="pc-card pc-card--slot" />
          <span
            className="pc-card pc-card--slot"
            style={{ transform: `translateY(calc(var(--u) * ${HERO_CARD_STAGGER}))` }}
          />
        </div>
        <div className="pc-handlabel" style={pointStyle(HERO_HAND_LABEL)}>—</div>

        <GameChrome />
        <ActionBar />
      </section>

      <button
        aria-expanded={panelOpen}
        className={`control-trigger${showPopup ? ' control-trigger--shifted' : ''}`}
        onClick={() => setPanelOpen((isOpen) => !isOpen)}
        type="button"
      >
        <span aria-hidden="true">◎</span>
        モック操作
      </button>

      {panelOpen && (
        <aside
          className={`control-panel${showPopup ? ' control-panel--shifted' : ''}`}
          aria-label="Mockup controls"
        >
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
            {/* Same 0.5-2.0 / 0.1 range the popup enforces (`isValidUIScale`,
                `requestScaleChange`) -- both write the one stored scale, so a
                narrower range here would snap a popup-set value on first
                touch. */}
            <input
              max="2"
              min="0.5"
              onChange={(event) => chrome.runtime.sendMessage({
                action: 'setDeviceUIScale',
                scale: Number(event.target.value),
              })}
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
              checked={showPopup}
              onChange={(event) => setShowPopup(event.target.checked)}
              type="checkbox"
            />
            <span>ポップアップを表示</span>
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

      <div className={`mock-badge${showPopup ? ' mock-badge--shifted' : ''}`}>
        <span />
        {scenario.label}
      </div>

      {/* `uiConfig.displayEnabled` is the popup's 表示/非表示 switch; production
          App.tsx renders nothing at all when it is off. */}
      {uiConfig.displayEnabled && orderedStats.map((stat, index) => (
        <Hud
          actualSeatIndex={index}
          hudColorCoding={uiConfig.hudColorCoding}
          hudDisplayMode={uiConfig.hudDisplayMode}
          key={`${scenario.id}-${hudRevision}-${index}`}
          playerPotOdds={scenario.playerPotOdds[index]}
          realTimeStats={index === 0 ? scenario.realTimeStats : undefined}
          scale={scale}
          stat={stat}
          statDisplayConfigs={statDisplayConfigs}
        />
      ))}

      {/* The action popup. Chrome hangs it off the toolbar button, i.e. the
          top-right corner above the page -- so that is where the mock puts it,
          at the real 380px body width (src/index.html). That page paints the
          theme ground colour on `html` and leaves `body` transparent, so the
          frame has to supply it here or the table shows through the gaps
          between the popup's cards. Colour comes from the popup's own boot
          resolver rather than a fourth hand-copy of the hex. */}
      {showPopup && (
        <aside
          className="mock-popup"
          aria-label="拡張機能のポップアップ"
          style={{ background: popupBackground }}
        >
          <Popup />
        </aside>
      )}

      {uiConfig.displayEnabled && showHandLog && (
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
