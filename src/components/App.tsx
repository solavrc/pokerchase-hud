import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { POKER_CHASE_SERVICE_EVENT, POKER_CHASE_SESSION_END_EVENT } from "../constants/runtime"
import { ApiType, isApiEventType } from "../types"
import type { Options } from '../utils/options-storage'
import type { ExistPlayerStats, PlayerStats } from "../types"
import type { StatsData } from "../content_script"
import { defaultStatDisplayConfigs } from "../stats"
import type { StatDisplayConfig } from "../types"
import type {
  HandLogConfig,
  HandLogEntry,
  HandLogEvent,
  UIConfig
} from "../types/hand-log"
import { DEFAULT_HAND_LOG_CONFIG, DEFAULT_UI_CONFIG } from "../types/hand-log"
import type {
  ChromeMessage,
} from "../types/messages"
import { rotateArrayFromIndex } from "../utils/array-utils"
import { consumePendingStats } from "../utils/pending-stats-cache"
import HandLog from "./HandLog"
import Hud from "./Hud"
import type { AllPlayersRealTimeStats } from "../realtime-stats/realtime-stats-service"

const EMPTY_SEATS: PlayerStats[] = Array.from({ length: 6 }, () => ({ playerId: -1 }))

// PlayerStats = ExistPlayerStats | { playerId: -1, statResults?: never[] }（zod union）。
// ExistPlayerStats.playerId は z.number()（リテラルでない）なので、TSの標準的な
// `stat.playerId !== -1` だけでは判別共用体として綺麗に絞り込まれない
// （bust-dimキャッシュへの書き込み時にExistPlayerStats型を要求するため必要）。
// 明示的な型ガード関数で確実に絞り込む。
const isExistPlayerStats = (stat: PlayerStats): stat is ExistPlayerStats =>
  stat.playerId !== -1

// ヒーローは常に配列index 0（rotateArrayFromIndexでヒーローの席をposition 0へ
// 回転済み。pregameフォールバック[background/import-export.tsのgetLatestSessionStats]
// も`[heroStat, ...emptySeats]`で同じ規約に従う）。sola仕様: セッション終了後も
// hero以外だけクリアする（#158でhero単独のキャリア統計はpregameで別途復元される）。
const HERO_SEAT_INDEX = 0

const App = memo(() => {
  const [stats, setStats] = useState<PlayerStats[]>(EMPTY_SEATS)
  const [handLogEntries, setHandLogEntries] = useState<HandLogEntry[]>([])
  const [handLogConfig, setHandLogConfig] = useState<HandLogConfig>(
    DEFAULT_HAND_LOG_CONFIG
  )
  const [uiConfig, setUIConfig] = useState<UIConfig>(DEFAULT_UI_CONFIG)
  const [statDisplayConfigs, setStatDisplayConfigs] = useState<StatDisplayConfig[]>(defaultStatDisplayConfigs)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [shouldScrollToLatest, setShouldScrollToLatest] = useState(false)
  const [allPlayersRealTimeStats, setAllPlayersRealTimeStats] = useState<AllPlayersRealTimeStats | undefined>()
  const [heroOriginalSeatIndex, setHeroOriginalSeatIndex] = useState<number | undefined>()
  // bustしたプレイヤーの薄暗い表示（sola仕様）: 表示座席index(rotate後、Hudの
  // `seat-${actualSeatIndex}`キーと同じ空間)ごとに直近の実データ入りPlayerStatsを
  // キャッシュする。ライブの1ハンド分イベント(handleStatsMessage)でのみ読み書きし、
  // ミュート状態にはReactの再レンダリングを要さないのでuseRefに置く -- 読み書きは
  // 常に同一の同期的コールバック内で完結する。
  const dimCacheRef = useRef<Map<number, ExistPlayerStats>>(new Map())
  // 現在ミュート表示中の座席index集合。Hudへ`isDimmed`として渡す。
  const [dimmedSeatIndices, setDimmedSeatIndices] = useState<ReadonlySet<number>>(new Set())
  // ドリルダウンパネル（ポジション別 / 直近ハンド）: 開いているのは常にどちらか
  // 一方、高々1プレイヤー分（HUDツリーにローカルなReact state。グローバル設定
  // への永続化はv1では不要）。#128のポジション別ドリルダウンの単一state管理を
  // 拡張し、パネル種別を持たせることで両パネルを互いに排他にしている。
  const [openPanel, setOpenPanel] = useState<{ playerId: number, kind: 'positional' | 'recentHands' } | null>(null)

  const handleTogglePositionalPanel = useCallback((playerId: number) => {
    setOpenPanel(prev => (prev?.kind === 'positional' && prev.playerId === playerId) ? null : { playerId, kind: 'positional' })
  }, [])

  const handleToggleRecentHandsPanel = useCallback((playerId: number) => {
    setOpenPanel(prev => (prev?.kind === 'recentHands' && prev.playerId === playerId) ? null : { playerId, kind: 'recentHands' })
  }, [])

  const handleStatsMessage = useCallback(
    ({ detail }: CustomEvent<StatsData>) => {
      let mappedStats = detail.stats
      
      // Update real-time stats if available
      if (detail.realTimeStats) {
        setAllPlayersRealTimeStats(detail.realTimeStats)
      }

      // Player（ヒーロー）情報を含むEVT_DEALがある場合、ヒーローをポジション0に配置するよう席を回転
      if (detail.evtDeal && isApiEventType(detail.evtDeal, ApiType.EVT_DEAL) && detail.evtDeal.Player?.SeatIndex !== undefined) {
        const heroSeatIndex = detail.evtDeal.Player.SeatIndex
        
        // Store hero's original seat index for mapping
        setHeroOriginalSeatIndex(heroSeatIndex)

        mappedStats = rotateArrayFromIndex(detail.stats, heroSeatIndex)
      }

      // bustしたプレイヤーの薄暗い表示（sola仕様）:「bustしたプレイヤーのstatsは
      // 即座にクリアせず、背景色薄くするなどして表示自体は目立たず続けて欲しい。
      // MTTやcashでは空いたシートに誰か他のプレイヤーが座ることがあるので更新漏れが
      // ないように注意」。
      //
      // - 新しいlineupで座席に実プレイヤー(playerId !== -1)がいれば、常にそれが
      //   正。キャッシュを最新化してミュート解除する -- 新規プレイヤーの着席
      //   (#2 席の乗っ取り)も、bust前のプレイヤーの再入室(#2b リバイ/再接続)も
      //   同じ扱いでよい(SeatUserIdsが示す通りに信頼し、それ以上ハンドをまたいだ
      //   同一性の推測はしない)。
      // - 座席が空(playerId === -1)でキャッシュがあれば、最後の実データ入り
      //   PlayerStatsをそのまま使い続けミュート表示にする。
      // - 座席が空でキャッシュも無ければ、これまで通り{playerId:-1}
      //   ("Waiting for Hand...")のまま。
      const dimCache = dimCacheRef.current
      const nextDimmedSeatIndices = new Set<number>()
      const dimmedStats = mappedStats.map((stat, seatIndex) => {
        if (stat.playerId === -1) {
          const cached = dimCache.get(seatIndex)
          if (cached) {
            nextDimmedSeatIndices.add(seatIndex)
            return cached
          }
          return stat
        }
        // playerId !== -1: 生きた着席者。同じ座席の以前の値（別プレイヤーの
        // bust後の残骸を含む）を必ず上書きする。
        if (isExistPlayerStats(stat)) {
          dimCache.set(seatIndex, stat)
        }
        return stat
      })

      setDimmedSeatIndices(nextDimmedSeatIndices)
      setStats(dimmedStats)
    },
    []
  )

  useEffect(() => {
    window.addEventListener(
      POKER_CHASE_SERVICE_EVENT,
      handleStatsMessage
    )

    // Warm-SW race: content_script.ts's chrome.runtime.onMessage listener is
    // registered at module load and always receives a 'latestStats' response,
    // but it can only hand it off via a window CustomEvent -- if that arrives
    // before this effect runs (React flushes effects asynchronously after the
    // initial commit), there was no listener yet and the event is lost. Pick
    // up anything content_script.ts cached in the gap (see
    // pending-stats-cache.ts) now that the listener above is registered.
    const pendingStats = consumePendingStats()
    if (pendingStats) {
      handleStatsMessage({ detail: pendingStats } as CustomEvent<StatsData>)
    }

    return () => {
      window.removeEventListener(
        POKER_CHASE_SERVICE_EVENT,
        handleStatsMessage
      )
    }
  }, [handleStatsMessage])

  // セッション終了(EVT_SESSION_RESULTS)でhero以外のHUDパネルをクリアする(sola仕様:
  // 「引き続きセッション終了後はhero以外のstatsはクリアしてOK」)。bustミュート表示中
  // だった座席も対象に含む -- ミュートは「同一セッション内で席が空いている間」の
  // 表示であり、セッションをまたいで残す理由が無いため。heroパネル(座席0)は#158の
  // 通りここでは一切触らない(pregameでのキャリア統計復元は別経路)。
  const handleSessionEnd = useCallback(() => {
    const dimCache = dimCacheRef.current
    for (const seatIndex of Array.from(dimCache.keys())) {
      if (seatIndex !== HERO_SEAT_INDEX) dimCache.delete(seatIndex)
    }
    setDimmedSeatIndices(prev => {
      if (!prev.has(HERO_SEAT_INDEX) && prev.size === 0) return prev
      return prev.has(HERO_SEAT_INDEX) ? new Set([HERO_SEAT_INDEX]) : new Set()
    })
    setStats(prev => prev.map((stat, seatIndex) => (
      seatIndex === HERO_SEAT_INDEX ? stat : { playerId: -1 }
    )))
  }, [])

  useEffect(() => {
    window.addEventListener(POKER_CHASE_SESSION_END_EVENT, handleSessionEnd)
    return () => window.removeEventListener(POKER_CHASE_SESSION_END_EVENT, handleSessionEnd)
  }, [handleSessionEnd])

  const handleChromeMessage = useCallback((message: ChromeMessage) => {
    if (message.action === "latestStats" && message.stats) {
      // インポート後のrefreshStats往復やマウント直後のpregameヒーロー単独
      // フォールバックは、bustミュートcacheを経由しない別経路（DBからの一括再計算）
      // なので、その場のstatsをそのまま反映するだけでよい。ただし直前のライブ
      // ハンドでミュート表示中の座席があった場合、この一括更新後もそのミュート
      // フラグを引きずって別データに重ねて表示してしまわないよう、表示中の
      // ミュート集合はここでリセットする（次のライブEVT_DEALでdimCacheRef自体は
      // 引き続き使われるので、bustの記憶自体は失われない）。
      setDimmedSeatIndices(new Set())
      setStats(message.stats)
    } else if (message.action === "updateUIConfig" && message.config) {
      setUIConfig(message.config)
    }
  }, [])

  useEffect(() => {
    chrome.runtime.onMessage.addListener(handleChromeMessage)
    return () => chrome.runtime.onMessage.removeListener(handleChromeMessage)
  }, [handleChromeMessage])

  // ハンドログイベントの処理
  const handleHandLogEvent = useCallback((event: CustomEvent<HandLogEvent>) => {
    const handLogEvent = event.detail

    switch (handLogEvent.type) {
      case "add":
        if (handLogEvent.entries) {
          setHandLogEntries((prev) => {
            // IDで重複エントリをチェック
            const existingIds = new Set(prev.map((e) => e.id))
            const newEntries = handLogEvent.entries!.filter(
              (e) => !existingIds.has(e.id)
            )
            return [...prev, ...newEntries]
          })
        }
        break
      case "update":
        if (handLogEvent.entries && handLogEvent.handId) {
          setHandLogEntries((prev) => {
            // undefined handId（現在の未完了ハンド）とこのhandIdに一致するエントリを削除
            const otherEntries = prev.filter(
              (entry) =>
                entry.handId !== handLogEvent.handId &&
                entry.handId !== undefined
            )

            return [...otherEntries, ...handLogEvent.entries!]
          })
        }
        break
      case "clear":
        setHandLogEntries([])
        break
      case "removeIncomplete":
        // 未完了のハンド（handIdがundefined）のみを削除
        setHandLogEntries((prev) => prev.filter((entry) => entry.handId !== undefined))
        break
    }
  }, [])

  useEffect(() => {
    window.addEventListener(
      "handLogEvent",
      handleHandLogEvent as EventListener
    )
    return () =>
      window.removeEventListener(
        "handLogEvent",
        handleHandLogEvent as EventListener
      )
  }, [handleHandLogEvent])

  const handleConfigUpdate = useCallback(
    (event: CustomEvent<HandLogConfig>) => {
      setHandLogConfig(event.detail)
    },
    []
  )

  const handleUIConfigUpdate = useCallback(
    (event: CustomEvent<UIConfig>) => {
      setUIConfig(event.detail)
    },
    []
  )

  const handleClearLog = useCallback(() => {
    setHandLogEntries([])
  }, [])
  
  // グローバルクリックイベントを処理
  useEffect(() => {
    const handleGlobalClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      
      // クリックがログウィンドウ内かチェック
      const isClickInsideLog = target.closest('[style*="position: fixed"][style*="backdrop-filter"]')
      
      if (!isClickInsideLog && handLogEntries.length > 0) {
        // ログウィンドウ外をクリックした場合、最新ログまでスクロール
        setShouldScrollToLatest(true)
        // フラグをリセット
        setTimeout(() => setShouldScrollToLatest(false), 100)
      }
    }
    
    document.addEventListener('click', handleGlobalClick)
    return () => document.removeEventListener('click', handleGlobalClick)
  }, [handLogEntries.length])

  // ストレージから設定を読み込み
  useEffect(() => {
    chrome.storage.sync.get(["handLogConfig", "uiConfig", "options"], (result: Record<string, any>) => {
      if (result.handLogConfig) {
        setHandLogConfig({
          ...DEFAULT_HAND_LOG_CONFIG,
          ...result.handLogConfig,
        })
      }
      if (result.uiConfig) {
        setUIConfig({
          ...DEFAULT_UI_CONFIG,
          ...result.uiConfig,
        })
      }
      if (result.options?.filterOptions?.statDisplayConfigs) {
        setStatDisplayConfigs(result.options.filterOptions.statDisplayConfigs)
      }
      setConfigLoaded(true)
    })

    // 平坦'options'キーの変更を購読する。マウント時の一括get()は一度きりのため、
    // その後に発生する書き込み — background起動時のマージ書き戻し（新統計の追加、
    // #100/#109）やPopupでの保存（#111で書き込み元はPopupに一本化）— を反映するには
    // この購読が必要。これが無いと、拡張更新時に既に開いていたゲームタブのHUDには
    // 新しい統計列が表示されないままになる（マウント時get()との起動レースも
    // 同様に救済される）。
    const handleOptionsStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'sync') return
      const nextOptions = changes['options']?.newValue as Options | undefined
      if (nextOptions?.filterOptions?.statDisplayConfigs) {
        setStatDisplayConfigs(nextOptions.filterOptions.statDisplayConfigs)
      }
    }
    chrome.storage.onChanged?.addListener(handleOptionsStorageChange)

    // ポップアップからの設定更新をリッスン
    window.addEventListener(
      "updateHandLogConfig",
      handleConfigUpdate as EventListener
    )
    window.addEventListener(
      "updateUIConfig",
      handleUIConfigUpdate as EventListener
    )
    return () => {
      chrome.storage.onChanged?.removeListener(handleOptionsStorageChange)
      window.removeEventListener(
        "updateHandLogConfig",
        handleConfigUpdate as EventListener
      )
      window.removeEventListener(
        "updateUIConfig",
        handleUIConfigUpdate as EventListener
      )
    }
  }, [handleConfigUpdate, handleUIConfigUpdate])

  // 席のポジションはhandleStatsMessageで既に正しくマッピングされている
  const seatPositions = useMemo(() => {
    // Stats配列は既に回転されてヒーローがポジション0にいる
    return stats.map((stat, index) => {
      // Calculate original seat index from display position
      const originalSeatIndex = heroOriginalSeatIndex !== undefined 
        ? (index + heroOriginalSeatIndex) % 6
        : index
      
      return {
        playerId: stat.playerId,
        actualSeatIndex: index,  // 席は既にマッピングされているのでindexを直接使用
        originalSeatIndex,       // 元の席番号（playerPotOdds取得用）
        stat,
      }
    })
  }, [stats, heroOriginalSeatIndex])

  if (!configLoaded) {
    return null
  }

  if (!uiConfig.displayEnabled) {
    return null
  }

  return (
    <>
      {seatPositions.map(
        (position) =>
          position && (
            <Hud
              key={`seat-${position.actualSeatIndex}`}
              actualSeatIndex={position.actualSeatIndex}
              stat={position.stat}
              scale={uiConfig.scale}
              statDisplayConfigs={statDisplayConfigs}
              realTimeStats={position.actualSeatIndex === 0 ? allPlayersRealTimeStats?.heroStats : undefined}
              playerPotOdds={allPlayersRealTimeStats?.playerStats[position.originalSeatIndex]}
              isPositionalPanelOpen={openPanel?.kind === 'positional' && openPanel.playerId === position.stat.playerId}
              onTogglePositionalPanel={() => handleTogglePositionalPanel(position.stat.playerId)}
              isRecentHandsPanelOpen={openPanel?.kind === 'recentHands' && openPanel.playerId === position.stat.playerId}
              onToggleRecentHandsPanel={() => handleToggleRecentHandsPanel(position.stat.playerId)}
              hudDisplayMode={uiConfig.hudDisplayMode}
              hudColorCoding={uiConfig.hudColorCoding}
              isDimmed={dimmedSeatIndices.has(position.actualSeatIndex)}
            />
          )
      )}

      {/* ハンドログオーバーレイ */}
      <HandLog
        entries={handLogEntries}
        config={handLogConfig}
        onClearLog={handleClearLog}
        scale={uiConfig.scale}
        scrollToLatest={shouldScrollToLatest}
      />
    </>
  )
})

export default App
