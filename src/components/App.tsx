import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  POKER_CHASE_SERVICE_EVENT,
  POKER_CHASE_SESSION_END_EVENT,
  POKER_CHASE_SESSION_START_EVENT,
  type PokerChaseSessionStartDetail
} from "../constants/runtime"
import { ApiType, isApiEventType } from "../types"
import type { Options } from '../utils/options-storage'
import type { ExistPlayerStats, PlayerStats } from "../types"
import type { PokerChaseServiceData, StatsData } from "../content_script"
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
import {
  cancelPendingLastTableSnapshotSave,
  loadLastTableSnapshot,
  restoreSeatStats,
  scheduleLastTableSnapshotSave,
} from "../utils/last-table-storage"
import { isEditableShortcutTarget, matchesShortcut } from "../utils/keyboard-shortcut"
import {
  loadLocalUIScale,
  mergeUIConfigWithLocalScale,
  saveSyncedUIConfig,
} from "../utils/ui-config-storage"
import HandLog from "./HandLog"
import Hud from "./Hud"
import type { AllPlayersRealTimeStats } from "../realtime-stats/realtime-stats-service"

const EMPTY_SEATS: PlayerStats[] = Array.from({ length: 6 }, () => ({ playerId: -1 }))

// 監査指摘11（P2）「開いたドリルダウンパネルが無期限に古くなる」対応:
// ports.tsのACTIVE-port deliveryは既にPOKER_CHASE_SERVICE_EVENTの生payloadへ
// `handEpoch`（handCompletionEpochの現在値、詳細はports.ts参照）
// を積んでいるが、content_script.ts側の`StatsData`型（同ファイル定義）は
// 別ワークストリームが所有しておりこのフィールドをまだ宣言していない。
// content_script.tsの転送コード自体は型アサーションを経由するだけで実行時の
// フィールドを一切削らないため、実行時には確実に載ってくる -- ここでは
// content_script.tsを変更せず、ローカルに型を拡張して読み取るだけにする。
type StatsDataWithHandEpoch = StatsData & { handEpoch?: number }

// PlayerStats = ExistPlayerStats | { playerId: -1, statResults?: never[] }（zod union）。
// ExistPlayerStats.playerId は z.number()（リテラルでない）なので、TSの標準的な
// `stat.playerId !== -1` だけでは判別共用体として綺麗に絞り込まれない
// （bust-dimキャッシュへの書き込み時にExistPlayerStats型を要求するため必要）。
// 明示的な型ガード関数で確実に絞り込む。
const isExistPlayerStats = (stat: PlayerStats): stat is ExistPlayerStats =>
  stat.playerId !== -1

// ヒーローは常に配列index 0（rotateArrayFromIndexでヒーローの席をposition 0へ
// 回転済み。pregameフォールバック[background/import-export.tsのgetLatestSessionStats]
// も`[heroStat, ...emptySeats]`で同じ規約に従う）。
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
  const uiConfigChangedAfterMountRef = useRef(false)
  const uiScaleChangedAfterMountRef = useRef(false)
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
  // ドリルダウンパネルはHUDツリーにローカルな一時状態（グローバル設定への
  // 永続化は不要）。ポジション別は従来どおり高々1プレイヤー、直近ハンドは
  // playerIdの集合で管理して複数プレイヤーを独立に開閉できる。
  //
  // パネル種別間の従来の排他は維持する: ポジション別を開けば直近ハンド群を
  // 閉じ、直近ハンドを1つでも開けばポジション別を閉じる。今回外すのは
  // 「直近ハンドAを開くと直近ハンドBが閉じる」という同種パネル間の排他だけ。
  const [openPositionalPanelPlayerId, setOpenPositionalPanelPlayerId] = useState<number | null>(null)
  const [openRecentHandsPanelPlayerIds, setOpenRecentHandsPanelPlayerIds] = useState<ReadonlySet<number>>(() => new Set())
  // 監査指摘11（P2）対応: 生きたハンドが1件完了するたびに増える「hand epoch」
  // （ports.tsの`handCompletionEpoch`を反映、上のStatsDataWithHandEpoch
  // 参照）。Hud経由でドリルダウンパネルへpropとして渡し、そのフェッチeffectの
  // depsに含めることで、開いたままのパネルがハンド完了ごとに1回だけ再フェッチ
  // するようにする（実況の1アクションごとの更新では変化しないため再フェッチ
  // ストームは起きない）。
  const [handEpoch, setHandEpoch] = useState(0)
  // 「最後の卓の復元」(last-table-storage.ts): 前回のマウントで表示していた
  // ヒーロー以外の座席を、`chrome.storage.local`から読み戻したもの。
  // 表示専用（MUST）―― 統計パイプライン・ACTIVEポート判定・リプレイ取得の
  // 可否判定へは一切入力しない。ライブのラインナップが1度でも適用されたら
  // 空にする（ライブが常に権威）。
  const restoredSeatsRef = useRef<Map<number, ExistPlayerStats>>(new Map())
  // ライブの集計ラインナップを既に適用したか。非同期のストレージ読み取りが
  // ライブDEALより後に完了した場合に、古い卓で新しい卓を上書きしないための
  // ガード。
  const liveLineupAppliedRef = useRef(false)
  // セッション終了後のリプレイ詳細ドレインが`replayDetails`へ書くたびに（間引き
  // 済みで）増える「replay epoch」（background/replay-panel-refresh.tsと
  // ports.tsの`replayDetailEpoch`参照）。handEpochと別立てにしているのは、
  // この書き込みが変えるのが直近ハンドのホールカード列だけで、ポジション別
  // 統計は変わらないため ―― 開いたままの直近ハンドパネルにだけ渡す。
  const [replayEpoch, setReplayEpoch] = useState(0)
  // 309後、201通知が欠落しても最初の信頼済みヒーロー着席DEALを新境界にする。
  const awaitingTrustedSessionBoundaryRef = useRef(false)
  // 成功201の受信時刻より古いDEALを伴う遅延statsは、旧session計算の完了。
  const trustedSessionBoundaryTimestampRef = useRef<number | undefined>(undefined)

  // ユーザー指定キーでHUD + hand logを切り替える。App自体は非表示時も
  // マウントされたままなので、同じキーで必ず再表示できる。
  useEffect(() => {
    if (!configLoaded) return
    const shortcut = uiConfig.toggleShortcut
    if (!shortcut) return

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.repeat || isEditableShortcutTarget(event.target) || !matchesShortcut(event, shortcut)) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setUIConfig(current => {
        const next = { ...current, displayEnabled: !current.displayEnabled }
        saveSyncedUIConfig(next)
        return next
      })
    }

    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [configLoaded, uiConfig.toggleShortcut])

  const handleTogglePositionalPanel = useCallback((playerId: number) => {
    setOpenPositionalPanelPlayerId(prev => prev === playerId ? null : playerId)
    setOpenRecentHandsPanelPlayerIds(new Set())
  }, [])

  const handleToggleRecentHandsPanel = useCallback((playerId: number) => {
    setOpenPositionalPanelPlayerId(null)
    setOpenRecentHandsPanelPlayerIds(prev => {
      const next = new Set(prev)
      if (next.has(playerId)) next.delete(playerId)
      else next.add(playerId)
      return next
    })
  }, [])

  const closeAllDrillDownPanels = useCallback(() => {
    setOpenPositionalPanelPlayerId(null)
    setOpenRecentHandsPanelPlayerIds(new Set())
  }, [])

  /**
   * 空席のヒーロー以外の座席を、復元した「最後の卓」で埋める。
   *
   * 埋めるのは`playerId === -1`の座席だけ（MUST）: 実プレイヤーが入って
   * いる座席はライブか一括再計算が出した現在の値で、復元記録より常に新しい。
   * ヒーロー席(0)は対象外 ―― pregameキャリア統計が所有している
   * （last-table-storage.tsの`LAST_TABLE_HERO_SEAT_INDEX`参照）。
   */
  const withRestoredSeats = useCallback((base: PlayerStats[]): {
    stats: PlayerStats[]
    dimmedSeatIndices: Set<number>
  } => {
    const restored = restoredSeatsRef.current
    const dimmedSeatIndices = new Set<number>()
    if (restored.size === 0) return { stats: base, dimmedSeatIndices }
    const stats = base.map((stat, seatIndex) => {
      if (seatIndex === HERO_SEAT_INDEX || stat.playerId !== -1) return stat
      const restoredSeat = restored.get(seatIndex)
      if (!restoredSeat) return stat
      // 復元された座席は常にミュート表示（「離席」バッジ）にする。卓そのもの
      // が既に終わっているので、これは離席と同じ「今ここにいる人ではないが、
      // 統計とドリルダウンは読める」状態そのもの。
      dimmedSeatIndices.add(seatIndex)
      return restoredSeat
    })
    return { stats, dimmedSeatIndices }
  }, [])

  const discardRestoredLineup = useCallback(() => {
    restoredSeatsRef.current = new Map()
  }, [])

  const discardRetainedLineup = useCallback(() => {
    dimCacheRef.current.clear()
    discardRestoredLineup()
    setDimmedSeatIndices(new Set())
    setStats(EMPTY_SEATS)
    setAllPlayersRealTimeStats(undefined)
    setHeroOriginalSeatIndex(undefined)
    closeAllDrillDownPanels()
  }, [closeAllDrillDownPanels, discardRestoredLineup])

  // 表示中のラインナップからplayerIdが実際に消える境界（席交代、信頼できる
  // 一括更新、テーブル切替）で、その開状態もpruneする。離席とセッション終了は
  // statsを保持するためここでは消えず、直近ハンドへ引き続きアクセスできる。
  useEffect(() => {
    const displayedPlayerIds = new Set(
      stats.filter(isExistPlayerStats).map(stat => stat.playerId)
    )
    setOpenPositionalPanelPlayerId(prev => (
      prev !== null && !displayedPlayerIds.has(prev) ? null : prev
    ))
    setOpenRecentHandsPanelPlayerIds(prev => {
      let changed = false
      const next = new Set<number>()
      for (const playerId of prev) {
        if (displayedPlayerIds.has(playerId)) next.add(playerId)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [stats])

  // 離席後の統計とドリルダウンはレビュー用の表示なので、セッション終了や
  // フィルター変更だけでは削除してはならない（MUST NOT）。信頼できるヒーロー
  // 着席dealで同じ席に実プレイヤーが来た場合は、その新しい在席者で置換する。
  // 現在lineupにいないplayerIdは再集計できないため、フィルター変更後も最後に
  // 計算できたスナップショットを表示する。
  const handleStatsMessage = useCallback(
    ({ detail }: CustomEvent<PokerChaseServiceData>) => {
      // セッション終了後のリプレイ詳細ドレインからの通知（ports.tsの
      // `replayDetailEpoch`）。lineupも現在ハンド専用値も運ばないので、
      // 他の分岐へ落とさずここで完結させる。
      if ('replayEpoch' in detail) {
        if (typeof detail.replayEpoch === 'number') setReplayEpoch(detail.replayEpoch)
        return
      }
      // SPR・ポットオッズの実況更新はbackgroundでACTIVEポートにだけ配信される。
      // 集計lineupを触らず、現在ハンド専用値だけを更新する。
      if (detail.realTimeOnly) {
        if (detail.realTimeStats) setAllPlayersRealTimeStats(detail.realTimeStats)
        return
      }
      if (!('stats' in detail) || !detail.stats) return
      let mappedStats = detail.stats

      const isTrustedSeatedDeal = detail.evtDeal !== undefined
        && isApiEventType(detail.evtDeal, ApiType.EVT_DEAL)
        && detail.evtDeal.Player?.SeatIndex !== undefined
      const trustedDealTimestamp = isTrustedSeatedDeal
        ? detail.evtDeal!.timestamp
        : undefined
      const boundaryTimestamp = trustedSessionBoundaryTimestampRef.current
      if (
        awaitingTrustedSessionBoundaryRef.current &&
        boundaryTimestamp !== undefined &&
        (
          !isTrustedSeatedDeal ||
          trustedDealTimestamp === undefined || trustedDealTimestamp < boundaryTimestamp
        )
      ) {
        // 201後に完了した旧sessionの非同期集計でlineup/dimCacheを更新しては
        // ならない（MUST NOT）。保持表示は次の信頼済み着席DEALまで残す。
        return
      }
      if (isTrustedSeatedDeal && awaitingTrustedSessionBoundaryRef.current) {
        // 201が観測できなかった場合も、次のヒーロー着席DEALを新session境界と
        // して旧lineupを破棄しなければならない（MUST）。このDEALのlineupは
        // 同じcallback後半で直ちに描画する。
        awaitingTrustedSessionBoundaryRef.current = false
        trustedSessionBoundaryTimestampRef.current = undefined
        discardRetainedLineup()
      }

      // 観戦dealはPlayerが無いためヒーロー基準へ回転できず、別テーブルの席順かも
      // しれない。この未回転lineupでレビュー対象のHUDを上書きしてはならない
      // （MUST NOT）。現在ハンド専用値は上のACTIVE経路で更新済みなので、
      // ACTIVEポートへ届く集計更新でもlineupは変更しない。
      const isSpectatorDeal = detail.evtDeal !== undefined
        && isApiEventType(detail.evtDeal, ApiType.EVT_DEAL)
        && detail.evtDeal.Player === undefined
      if (isSpectatorDeal) {
        return
      }

      // ここから先はライブの集計ラインナップを実際に適用する。復元した
      // 「最後の卓」は前の卓の記録なので、ここで捨てる（MUST）―― ライブが
      // 常に権威で、この後の空席は本当の空席（"Waiting for Hand..."）か、
      // dimCacheが持つ*この*卓の離席者でなければならない。
      liveLineupAppliedRef.current = true
      discardRestoredLineup()

      // 監査指摘11（P2）対応: ports.tsが積んだhandEpochをそのまま状態へ反映する。
      // 実況の1アクションごとの更新（realTimeStatsのみの配信）ではports.ts側で
      // 値が据え置かれるため、setStateはされても値としては変化せず、開いた
      // パネルの再フェッチeffectは発火しない -- 生きたハンドが1件完了した
      // ときだけports.tsがこの値をインクリメントする。
      const incomingHandEpoch = (detail as StatsDataWithHandEpoch).handEpoch
      if (incomingHandEpoch !== undefined) {
        setHandEpoch(incomingHandEpoch)
      }

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
      //
      // テーブル移動時のキャッシュ無効化（#179 codex P2指摘、round2で判定ロジックを
      // 座席単位の一致/不一致比較に精緻化）: MTT/cashでヒーローが別テーブルへ
      // 移動すると、docs/api-events.md の通り `EVT_ENTRY_QUEUED` が再発行され
      // lineupが丸ごと入れ替わる。しかしこのシグナル自体はcontent_script.tsの
      // `latestStats`メッセージ(StatsData = {stats, evtDeal, realTimeStats})に
      // 含まれずUIまで届かないため、明示的な移動イベントにフックできない。
      //
      // 初版はhero以外の在席者playerIdを全座席分プールした集合同士の重複ゼロ判定
      // だったが、round2レビューで「A(座席1)がbustしてミュート中に、それまで
      // 誰も座ったことのない別座席へ新規プレイヤーBが着席しただけ」でも誤発火
      // する反例が指摘された(=Aの座席1はincomingで空のまま=判断材料なし、Bの
      // 座席は一度もキャッシュされたことがない=旧テーブルの記憶と比較しようが
      // ないのに、「hero以外の集合が丸ごと不連続」というだけでキャッシュ全体を
      // 消してしまっていた)。
      //
      // 精緻化した判定は「キャッシュに記録が残っている座席」だけを見て、座席単位で
      // 一致(continuity)/不一致(conflict)を数える:
      // - continuity: その座席の直近キャッシュと今回の在席者が同一playerId
      //   → 同じテーブルにいる動かぬ証拠(1つでもあれば以降のconflictは無視して
      //   クリアしない -- 一部の席だけ入れ替わる通常の席の乗っ取りと区別が
      //   つかないケースを「同一テーブル」側に倒す)。
      // - conflict: キャッシュがある座席に、キャッシュとは異なる実プレイヤーが
      //   今座っている → その座席自体は既存の下の上書きロジックで正しく
      //   更新されるので無害だが、"複数の座席で同時多発"していればテーブル
      //   ごと入れ替わった強い証拠になる。
      // - キャッシュはあるが今回incomingが空席(-1)、またはincomingにはいるが
      //   その座席がキャッシュに記録なし(まだ誰も座ったことのない座席)、は
      //   どちらの証拠にもならないので無視する(#179 round2の反例)。
      //
      // round3レビューで「conflictが1件でもあればクリア」も誤発火することが
      // 指摘された: ショートハンドで座席1がミュート中、座席2だけがA→Bへ
      // 通常の乗っ取りで入れ替わり、他の座席は全て空席というケース。この時
      // conflictは座席2の1件のみでcontinuityは0件になるが、これは単なる
      // 座席2の乗っ取り(すでに下の上書きロジックが正しく処理する)であって
      // テーブル移動ではない。座席1のミュートまで巻き込んでクリアするのは
      // 誤り。そこで閾値をconflict 2件以上(かつcontinuity 0件)に引き上げた
      // -- 複数の座席が"同時に"別人へ入れ替わっているという事象は、通常の
      // 単発の乗っ取り/リバイでは起きず、lineup全体が入れ替わるテーブル移動
      // でのみ自然に発生するため、より強い証拠になる。
      //
      // 残存する既知の限界(正直に記録しておく): 移動先テーブルの非hero在席が
      // ちょうど1人しかいない実際のテーブル移動は、この閾値だと即座には
      // 検知されない(conflictが1件しか立たないため)。許容範囲とする -- その
      // 1つの座席自体は上書きロジックで即座に正しい表示になり、残る他の
      // ミュート座席も後続のハンドで(a)本物の在席者到着で個別に上書きされる
      // か、(b)空席のまま次にconflictが2件以上になるタイミングでまとめて
      // クリアされる。「わからない時は消さない」という優先順位に沿っている。
      //
      // conflictが0件、または1件のみ(continuityの有無を問わず)なら何もしない
      // -- 例: hero以外が同一ハンドで全員同時bustした直後のhero単独lineup
      // (conflict 0件)や、通常の単発席乗っ取り(conflict 1件)。
      //
      // post-merge review P2「Avoid clearing dims on simultaneous seat churn」
      // （閾値2件でも、同一テーブルで2席が同時に別プレイヤーへ入れ替わっただけの
      // 通常churnを誤ってテーブル移動と判定し、無関係な他の空席のミュートまで
      // 巻き込んで消してしまうのでは、という指摘）を検討したが、この指摘が
      // 挙げる状況（cachedなhero以外座席がN件、うち2件がconflict、残りは
      // incoming=-1で判断材料なし、continuity 0件）は、下のround3反例テスト
      // 「hero以外が同一ハンドで全員同時bustした直後...その後、実際にテーブル
      // 移動して...」（App.test.tsx）が要求する「本物のテーブル移動を検知
      // すべきケース」と数値的シグネチャが区別不能（cached 5件・conflict
      // 2件・continuity 0件は両ケースに共通する）。conflict/continuityの比率や
      // 閾値をどう調整しても、一方を検知すればもう一方を誤検知するトレード
      // オフにしかならず、App.tsx側が持つ情報（座席インデックスとplayerIdの
      // 対応だけ）だけでは原理的に区別できない -- EVT_DEALにテーブル/セッションを
      // 一意に示すフィールドが無いこと（docs/api-events.md, `src/types/api.ts`
      // のEVT_DEALスキーマ確認済み）もこれを裏付ける。よって閾値は変更せず、
      // 既存のround1-3の判断（わからない時は消さない、ただし2件以上の同時
      // conflictは強い証拠として扱う）を維持する。
      const dimCache = dimCacheRef.current
      let hasContinuitySeat = false
      let conflictSeatCount = 0
      for (const [seatIndex, cached] of dimCache) {
        if (seatIndex === HERO_SEAT_INDEX) continue
        const incoming = mappedStats[seatIndex]
        if (incoming && isExistPlayerStats(incoming)) {
          if (incoming.playerId === cached.playerId) hasContinuitySeat = true
          else conflictSeatCount++
        }
      }
      const isTableChange = conflictSeatCount >= 2 && !hasContinuitySeat
      if (isTableChange) {
        dimCache.clear()
        closeAllDrillDownPanels()
      }

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

      // 「最後の卓の復元」: ここが唯一の書き込み点（MUST）。
      // ライブの1ハンド分パイプラインが出した表示ラインナップだけを保存する
      // ―― `latestStats`（インポート後のrefresh、マウント直後のpregame
      // ヒーロー単独フォールバック）は一括再計算の一発物で、特にpregameは
      // ヒーロー以外が空席の配列なので、そこで保存すると復元したばかりの
      // 記録を自分で消してしまう。保存はデバウンスされる
      // （last-table-storage.ts）。
      scheduleLastTableSnapshotSave(dimmedStats)
    },
    [closeAllDrillDownPanels, discardRestoredLineup, discardRetainedLineup]
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

  // セッション終了後も統計・離席表示・ドリルダウンはレビュー用に保持する。
  // SPR/ポットオッズは現在ハンドだけの値なので、終了通知ではそこだけを消す。
  const handleSessionEnd = useCallback(() => {
    awaitingTrustedSessionBoundaryRef.current = true
    trustedSessionBoundaryTimestampRef.current = undefined
    setAllPlayersRealTimeStats(undefined)
  }, [])

  const handleSessionStart = useCallback((event: CustomEvent<PokerChaseSessionStartDetail>) => {
    // 201は新しい着席lineupを持たないため保持表示を消さない。境界時刻より古い
    // 非同期statsを拒否し、最初の信頼済み着席DEALで破棄・置換する。ただし
    // SPR/ポットオッズは現在ハンド専用なので、309無しのMTTテーブル移動でも
    // 旧テーブルの値を残さない（MUST NOT）。
    awaitingTrustedSessionBoundaryRef.current = true
    trustedSessionBoundaryTimestampRef.current = event.detail.timestamp
    setAllPlayersRealTimeStats(undefined)
  }, [])

  useEffect(() => {
    window.addEventListener(POKER_CHASE_SESSION_END_EVENT, handleSessionEnd)
    return () => window.removeEventListener(POKER_CHASE_SESSION_END_EVENT, handleSessionEnd)
  }, [handleSessionEnd])

  useEffect(() => {
    window.addEventListener(POKER_CHASE_SESSION_START_EVENT, handleSessionStart)
    return () => window.removeEventListener(POKER_CHASE_SESSION_START_EVENT, handleSessionStart)
  }, [handleSessionStart])

  const handleChromeMessage = useCallback((message: ChromeMessage) => {
    if (message.action === "latestStats" && message.stats) {
      // インポート後のrefreshStats往復やマウント直後のpregameヒーロー単独
      // フォールバックは、bustミュートcacheを経由しない別経路（DBからの一括再計算）
      // なので、その場のstatsをそのまま反映する。ただし直前のライブ
      // ハンドでミュート表示中の座席があった場合、この一括更新後もそのミュート
      // フラグを引きずって別データに重ねて表示してしまわないよう、表示中の
      // ミュート集合はここでリセットする（次のライブEVT_DEALでdimCacheRef自体は
      // 引き続き使われるので、bustの記憶自体は失われない）。
      // 「最後の卓の復元」: この一括更新はヒーロー席（pregame）や再計算後の
      // ラインナップを運んでくるが、そこで空席のままの座席は復元記録で
      // 埋め直す。pregameフォールバックはヒーロー以外が全て空席の配列なので、
      // これが無いと「リロード直後に相手のHUDが消える」元の症状に戻る。
      const restored = withRestoredSeats(message.stats)
      setDimmedSeatIndices(restored.dimmedSeatIndices)
      setStats(restored.stats)

      // 信頼できるDB再計算がヒーロー統計を更新した場合は、次のライブ更新で
      // 古い値へ戻らないようヒーロー枠のキャッシュも同時に更新する。
      const heroEntry = message.stats[HERO_SEAT_INDEX]
      if (heroEntry && isExistPlayerStats(heroEntry)) {
        dimCacheRef.current.set(HERO_SEAT_INDEX, heroEntry)
      }
    } else if (message.action === "updateUIConfig" && message.config) {
      uiConfigChangedAfterMountRef.current = true
      setUIConfig(current => ({
        ...message.config,
        // Synchronized display/color updates must not replace the
        // authoritative device-local scale.
        scale: current.scale,
      }))
    } else if (message.action === "updateDeviceUIScale") {
      uiScaleChangedAfterMountRef.current = true
      setUIConfig(current => ({
        ...current,
        scale: message.scale,
      }))
    }
  }, [withRestoredSeats])

  useEffect(() => {
    chrome.runtime.onMessage.addListener(handleChromeMessage)
    return () => chrome.runtime.onMessage.removeListener(handleChromeMessage)
  }, [handleChromeMessage])

  /**
   * 「最後の卓の復元」(#358の保持表示の永続化、sola要望 2026-08):
   * マウント時に一度だけ、前回表示していたヒーロー以外のラインナップを
   * `chrome.storage.local`から読み戻し、離席と同じミュート表示で並べる。
   * これで拡張のリロード・ブラウザ再起動の直後でも、相手の統計と直近ハンド
   * ドリルダウン（IndexedDBを`playerId`で引く）へ即座に到達できる。
   *
   * 読み取りは非同期なので、その間にライブのラインナップが適用されていたら
   * 何もしない（MUST）―― 現在の卓を前の卓で塗り替えてはならない。
   * 壊れた/バージョン違い/欠損の記録は`loadLastTableSnapshot`が`null`へ
   * 倒すので、その場合は従来どおり空席から始まる（フェイルクローズ）。
   */
  useEffect(() => {
    let cancelled = false
    loadLastTableSnapshot(snapshot => {
      if (cancelled || !snapshot || liveLineupAppliedRef.current) return
      const restored = new Map<number, ExistPlayerStats>()
      for (const seat of snapshot.seats) {
        restored.set(seat.seatIndex, restoreSeatStats(seat))
      }
      restoredSeatsRef.current = restored
      setStats(previous => withRestoredSeats(previous).stats)
      setDimmedSeatIndices(previous => {
        const next = new Set(previous)
        for (const seatIndex of restored.keys()) next.add(seatIndex)
        return next
      })
    })
    // アンマウント時に、遅れて届く復元応答と未実行の保存予約を捨てる。
    // 次のマウントは自分で読み直し・書き直すので、消えたコンポーネントの
    // 表示を後から反映する意味はない。
    return () => {
      cancelled = true
      cancelPendingLastTableSnapshotSave()
    }
  }, [withRestoredSeats])

  // ハンドログイベントの処理
  const handleHandLogEvent = useCallback((event: CustomEvent<HandLogEvent>) => {
    const handLogEvent = event.detail

    switch (handLogEvent.type) {
      case "add":
        if (handLogEvent.entries) {
          setHandLogEntries((prev) => {
            // 同一entryオブジェクトの再送に対するガード（idはHandLogProcessorが
            // インスタンスnonce+連番で発行する衝突不可能な値なので、正当な新規行が
            // ここで誤って捨てられることはない）。イベント自体の重複処理防止は
            // ingestion側のRaw Event Lake dedup（background/event-ingestion.ts）が担う。
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
      uiConfigChangedAfterMountRef.current = true
      uiScaleChangedAfterMountRef.current = true
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
      loadLocalUIScale(localScale => {
        if (result.handLogConfig) {
          setHandLogConfig({
            ...DEFAULT_HAND_LOG_CONFIG,
            ...result.handLogConfig,
          })
        }
        const loadedUIConfig = mergeUIConfigWithLocalScale(result.uiConfig, localScale)
        setUIConfig(current => ({
          ...(uiConfigChangedAfterMountRef.current ? current : loadedUIConfig),
          scale: uiScaleChangedAfterMountRef.current
            ? current.scale
            : loadedUIConfig.scale,
        }))
        if (result.options?.filterOptions?.statDisplayConfigs) {
          setStatDisplayConfigs(result.options.filterOptions.statDisplayConfigs)
        }
        setConfigLoaded(true)
      })
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
      const nextUIConfig = changes['uiConfig']?.newValue as UIConfig | undefined
      if (nextUIConfig) {
        uiConfigChangedAfterMountRef.current = true
        setUIConfig(current => ({
          ...DEFAULT_UI_CONFIG,
          ...nextUIConfig,
          // Ignore legacy/cross-device scale values in the sync payload.
          scale: current.scale,
        }))
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
              isPositionalPanelOpen={openPositionalPanelPlayerId === position.stat.playerId}
              onTogglePositionalPanel={() => handleTogglePositionalPanel(position.stat.playerId)}
              isRecentHandsPanelOpen={openRecentHandsPanelPlayerIds.has(position.stat.playerId)}
              onToggleRecentHandsPanel={() => handleToggleRecentHandsPanel(position.stat.playerId)}
              handEpoch={handEpoch}
              replayEpoch={replayEpoch}
              hudDisplayMode={uiConfig.hudDisplayMode}
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
