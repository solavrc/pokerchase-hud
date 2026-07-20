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
  // dimmedSeatIndicesの同期読み取り用ミラー（#179 P2「Invalidate dimmed stats
  // on filter recomputes」指摘への対応で追加）。フィルター変更ハンドラー
  // (handleBattleTypeFilterUpdate)は「今どの座席がミュート表示中か」を
  // setState外の同期コードから知る必要があるが、React stateのprevは
  // updater関数の外では読めない（読めても次コミットまで反映保証がない）。
  // setDimmedSeatIndicesを呼ぶ全箇所をapplyDimmedSeatIndices経由に統一し、
  // 常にこのrefと状態を同時に更新することで、後続のイベントハンドラーが
  // 呼ばれた時点では既に最新値になっている（dimCacheRefと同じ理由でuseRefを
  // 使う）。
  const dimmedSeatIndicesRef = useRef<ReadonlySet<number>>(new Set())
  const applyDimmedSeatIndices = useCallback((next: ReadonlySet<number>) => {
    dimmedSeatIndicesRef.current = next
    setDimmedSeatIndices(next)
  }, [])
  // 現在表示中のstatsの同期読み取り用ミラー（#191 post-merge review descope
  // pass1「Avoid clearing freshly rebuilt live-seat cache」指摘への対応で追加、
  // dimmedSeatIndicesRefと同じ理由）。handleBattleTypeFilterUpdateが「この
  // 座席は今まさにライブ在籍中か」を判定するのに使う -- フィルター変更は
  // ユーザー操作起点の独立したイベントなので、React stateのコミット
  // （useEffect経由）で十分間に合う。
  const statsRef = useRef<PlayerStats[]>(EMPTY_SEATS)
  useEffect(() => {
    statsRef.current = stats
  }, [stats])
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

  // 仕様（PR #191、オーナー承認の縮小スコープ、2026-07-20。sola:
  // 「それほど重要な機能ではないので、bで十分です」）:
  //
  // - bustしたプレイヤーのdim表示・ヒーローの身元保持は「連続したライブ
  //   シーケンス」の中でのみ保証する: bust→dim（離席バッジ）→同じ席への
  //   実着席で即座に通常表示へ復帰、そして生の309（セッション終了）で
  //   hero以外の全パネルをクリアしつつheroパネルだけはdimCache経由で
  //   保持する（下のhandleSessionEnd）。
  // - それ以外の曖昧な境界（観戦モードdeal、ページリロード/再マウント、
  //   フィルター変更による再計算、`latestStats`一括配信）は、個別に
  //   「今どちらの文脈か」を検証・追跡する仕組みを持たず、単純に
  //   dimCacheを適用しない/表示中のミュートをクリアするだけにする
  //   （観戦モードdealはdimCacheの読み書きを丸ごとスキップし生のlineupを
  //   そのまま表示、フィルター変更・一括配信はミュート表示状態を
  //   リセットする）。
  // - 3巡のpost-merge reviewで「観戦中もヒーローの身元を検証付きで
  //   追跡し続ける」「セッションが今アクティブかを独立に追跡する」という
  //   方向へ機構を積み増したが（heroPlayerIdRef、sessionActiveRef、
  //   trustedRotationゲート）、そのたびに新しい境界ケースが見つかり続けた
  //   （詳細はPR #191のレビュー履歴）。この機能の重要度に見合わないと
  //   判断し、それらは全て撤回した。テーブル移動検知ヒューリスティック
  //   （下記conflictSeatCount）はこの縮小スコープの一部として現状維持
  //   （round1-3で既に磨き込み済み、既知の限界も含めて許容範囲）。
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

      // 観戦モードdeal（#179 post-merge review P2「Avoid applying dim cache to
      // unrotated spectator deals」指摘）: EVT_DEAL.Playerがundefinedのとき
      // （docs/api-events.md「観戦モード」-- ヒーロー敗退後もクライアントが
      // 他プレイヤーのテーブルを受信し続けるケース。CLAUDE.md「Hero playerId
      // must survive spectator-mode deals」も参照）、上の回転は行われず
      // mappedStatsは生の（ヒーロー自身のテーブルとすら限らない、別テーブル
      // かもしれない）席順のまま届く。これはaggregate-events-stream.tsの
      // liveEvtDealがPlayer有無に関わらず毎回追従する設計（#177）により、
      // ports.tsのライブブロードキャストが観戦中の別テーブルの新しい顔ぶれを
      // そのまま流してくることに由来する（docs/api-events.md「テーブル移動
      // キメラハンド」と同根 -- クライアントは移動/観戦先のイベントを普通に
      // 受信し続ける）。
      //
      // dimCacheは表示座席（回転後、hero=0）空間のキーで運用しているため、
      // この生の（別空間かもしれない）席順にそのまま適用すると、無関係な
      // 別テーブルの空席に旧テーブルのミュートプレイヤーが誤って表示されて
      // しまう（座席インデックスの数値がたまたま一致するだけの偶然の一致）。
      // evtDeal自体が存在しないケース（テストや初回未初期化など、mappedStats
      // が既に表示座席空間にある前提で運用してきたケース、下のdimCacheロジック
      // 一式のテストカバレッジもこの前提）とは区別し、「evtDealがEVT_DEALとして
      // 存在するのにPlayerがundefined」という観戦確定シグナルがある時だけ
      // dimCacheの読み書き（テーブル移動検知・ミュート適用の両方）を丸ごと
      // スキップし、mappedStatsをそのまま表示する。dimCache自体はクリアしない
      // （観戦は一時的な状態で、ヒーロー在籍dealに戻ればまた正しい空間で
      // 再開できる -- #179 P2「Preserve the hero by player id at session end」
      // 対応のためHERO_SEAT_INDEXのエントリを観戦中も保持し続ける必要がある、
      // 下のhandleSessionEnd参照）。
      const isSpectatorDeal = detail.evtDeal !== undefined
        && isApiEventType(detail.evtDeal, ApiType.EVT_DEAL)
        && detail.evtDeal.Player === undefined
      if (isSpectatorDeal) {
        applyDimmedSeatIndices(new Set())
        setStats(mappedStats)
        return
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
      // クリアされるか、(c)セッション終了でクリアされる。「わからない時は
      // 消さない」というsola仕様の優先順位（bustパネルが1テンポ遅れて消える
      // 程度の実害 < 無関係な旧テーブルのbustパネルを誤って蘇らせる実害）に
      // 沿っている。
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

      applyDimmedSeatIndices(nextDimmedSeatIndices)
      setStats(dimmedStats)
    },
    [applyDimmedSeatIndices]
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
    // #179 post-merge review P2「Preserve the hero by player id at session
    // end」指摘: 直前の更新が観戦モードdeal（上のisSpectatorDeal分岐）だった
    // 場合、stats[HERO_SEAT_INDEX]は観戦中の別テーブルの生の席0でしかなく、
    // ヒーローとは限らない。isSpectatorDeal分岐はdimCacheの読み書き自体を
    // 丸ごとスキップするため、dimCacheのHERO_SEAT_INDEXエントリには直近の
    // ヒーロー在籍dealで記録された本物のExistPlayerStatsが（観戦dealを何件
    // 挟んでも上書きされずに）残り続けている。それを優先的に使い、万一まだ
    // 一度もヒーロー在籍dealを見ていない（キャッシュが空の）場合だけ
    // 従来通りstats[HERO_SEAT_INDEX]をフォールバックとして使う。
    const heroStat = dimCache.get(HERO_SEAT_INDEX)
    for (const seatIndex of Array.from(dimCache.keys())) {
      if (seatIndex !== HERO_SEAT_INDEX) dimCache.delete(seatIndex)
    }
    const prevDimmed = dimmedSeatIndicesRef.current
    if (prevDimmed.size !== 0) {
      applyDimmedSeatIndices(prevDimmed.has(HERO_SEAT_INDEX) ? new Set([HERO_SEAT_INDEX]) : new Set())
    }
    setStats(prev => prev.map((stat, seatIndex) => (
      seatIndex === HERO_SEAT_INDEX ? (heroStat ?? stat) : { playerId: -1 }
    )))
  }, [applyDimmedSeatIndices])

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
      applyDimmedSeatIndices(new Set())
      setStats(message.stats)

      // post-merge review descope pass1「Prefer visible hero stats after
      // batch refreshes」指摘: この経路（信頼できるDB再計算）が席0のヒーロー
      // 統計をこの時点の最新値に更新しても、dimCacheのHERO_SEAT_INDEX
      // エントリ自体はここでは触れていなかった。セッション中に一度でも
      // ライブのヒーロー在籍dealを見ていれば、dimCacheにはその時点の
      // （インポート前の、より古い）ヒーロー統計が残ったままになる。この
      // 状態で、次のライブハンド（dimCacheを打ち直す機会）を挟まずに
      // セッションが終了(309)すると、handleSessionEndは`dimCache.get(
      // HERO_SEAT_INDEX)`を優先するため、たった今表示したはずのより新しい
      // 値ではなく、古いキャッシュ値へロールバックして表示してしまう。
      // ここでdimCacheのヒーロー枠も同時に最新化しておけば、この経路も
      // ライブ経路（handleTrustedLineup相当）と同じく「常に最新のヒーロー
      // 値をdimCacheに保つ」という一貫した不変条件を満たす。
      const heroEntry = message.stats[HERO_SEAT_INDEX]
      if (heroEntry && isExistPlayerStats(heroEntry)) {
        dimCacheRef.current.set(HERO_SEAT_INDEX, heroEntry)
      }
    } else if (message.action === "updateUIConfig" && message.config) {
      setUIConfig(message.config)
    }
  }, [applyDimmedSeatIndices])

  useEffect(() => {
    chrome.runtime.onMessage.addListener(handleChromeMessage)
    return () => chrome.runtime.onMessage.removeListener(handleChromeMessage)
  }, [handleChromeMessage])

  // フィルター変更時にdimCacheを無効化する（#179 post-merge review P2
  // 「Invalidate dimmed stats on filter recomputes」指摘）: バトルタイプ/
  // テーブルサイズ/ハンド数フィルターが変わると、message-router.tsの
  // `updateBattleTypeFilter`ハンドラーがgetLastKnownStats()（現在の生の
  // 座席、bustした座席は-1のまま）で`service.statsOutputStream.write()`を
  // 再トリガーする。bustしてミュート表示中の座席はこの再計算対象に含まれない
  // （-1のプレイヤーIDに対して計算しようがない）ため、その座席のdimCache
  // エントリは古いフィルターの統計のまま残ってしまい、席が戻るかセッションが
  // 終わるまで新フィルターが反映されない可視バグになる。
  //
  // content_script.tsは`updateBattleTypeFilter`メッセージを受け取るたびに
  // 同名のwindowイベントを既にdispatchしている（Popup.tsxのフィルター系UI
  // 全て — gameTypes/tableSize/handLimitいずれの変更もこの1経路を通る — が
  // 発火元）が、これまでApp.tsxは購読していなかった。ここで購読し、
  // dimCache自体（非hero座席分すべて）を無条件で無効化する。
  //
  // 当初はdimmedSeatIndicesRef（現在ミュート「表示」中の座席集合）に含まれる
  // 座席だけをクリアしていたが、post-merge review P2「Clear cached muted
  // seats even after dim state resets」指摘で反例が見つかった: dimmedSeat
  // Indicesを空にリセットしつつdimCacheRef自体は生かしたままにするパスが
  // 他に2つある --
  //   (1) `latestStats` chromeメッセージ経路（handleChromeMessage、インポート
  //       後のrefreshStats往復・バッチ再計算）。「バッチ更新はミュート状態を
  //       経由しない」仕様どおりdimmedSeatIndicesは空にするが、dimCacheの
  //       中身はそのまま。
  //   (2) 上の観戦モードdeal分岐（isSpectatorDeal）。表示は生のlineupに
  //       切り替えてdimmedSeatIndicesを空にするが、dimCacheはヒーロー在籍
  //       dealに戻った時に正しく再開できるよう意図的に一切触らない。
  // この状態でフィルターが変わると、dimmedSeatIndicesRef基準のクリアでは
  // 「今は見えていないが後で複活し得る」dimCacheの中身を見逃す -- 後続の
  // ライブ更新でその座席が引き続き空席(-1)のままなら、
  // handleStatsMessageの通常ロジックがdimCacheから古いフィルターの統計を
  // 拾って再びミュート表示してしまう。
  //
  // 対策: dimCache自体はheroを除く「今まさにライブ在籍中ではない」全
  // エントリを無条件でクリアする(ミュート表示中の座席・orphanedな座席の
  // 両方を含む)。表示(`stats`/`dimmedSeatIndices`)の書き換えは従来どおり
  // 「今まさにミュート表示中」の座席だけに限定する -- 今「Waiting for
  // Hand...」で見えている座席には触れる必要が無く、ライブ在籍中の座席を
  // 一瞬ブランクにする不要なちらつきも避けられる。
  //
  // post-merge review descope pass1「Avoid clearing freshly rebuilt
  // live-seat cache」指摘: 当初は「ライブ在籍中の座席分も含めて無条件で
  // クリアしても、直後に届く再計算ブロードキャストがhandleStatsMessageの
  // 通常経路でdimCache.set()を打ち直すので実害は無い」としていたが、この
  // 順序保証は誤りだった。message-router.tsのupdateBattleTypeFilter
  // ハンドラーは`service.setBattleTypeFilter()`（再計算・再ブロードキャスト
  // をトリガー、ポート経由）と、このwindowイベントの転送
  // （`chrome.tabs.query`→`chrome.tabs.sendMessage`、2段のchrome API
  // ラウンドトリップ）を並行して開始するだけで、どちらが先に届くかは
  // DBクエリ量やIPCの負荷次第で入れ替わりうる。再計算ブロードキャストが
  // 先に届いてdimCacheをフレッシュな値で打ち直した直後にこのハンドラーが
  // 動くと、そのフレッシュな値ごと無条件で消してしまい、対戦相手がその
  // 席で次にbustした時にdim表示が出ない（キャッシュが空のまま）という、
  // 縮小スコープの核であるはずの「連続したライブシーケンス内でのbust→
  // dim」自体が壊れてしまう。
  //
  // 対処: 「今まさにライブ在籍中」（=statsRef上そのplayerIdが-1でなく、
  // かつ現在ミュート表示中でもない、つまりキャッシュ値ではなく生きた
  // 実データがそのまま表示されている）座席のキャッシュはクリア対象から
  // 除外する。ミュート表示中（キャッシュ値を経由して表示されている）・
  // 完全に空席（orphaned含む）の座席だけを引き続きクリアする。
  const handleBattleTypeFilterUpdate = useCallback(() => {
    const dimCache = dimCacheRef.current
    const currentStats = statsRef.current
    const currentlyDimmed = dimmedSeatIndicesRef.current
    const nonHeroCachedSeats = Array.from(dimCache.keys()).filter(seatIndex => {
      if (seatIndex === HERO_SEAT_INDEX) return false
      const isLiveNow = !currentlyDimmed.has(seatIndex) && currentStats[seatIndex]?.playerId !== -1
      return !isLiveNow
    })
    if (nonHeroCachedSeats.length === 0) return
    for (const seatIndex of nonHeroCachedSeats) dimCache.delete(seatIndex)

    const dimmedNonHeroSeats = Array.from(dimmedSeatIndicesRef.current).filter(
      seatIndex => seatIndex !== HERO_SEAT_INDEX
    )
    if (dimmedNonHeroSeats.length === 0) return
    const clearedSet = new Set(dimmedNonHeroSeats)
    applyDimmedSeatIndices(
      dimmedSeatIndicesRef.current.has(HERO_SEAT_INDEX) ? new Set([HERO_SEAT_INDEX]) : new Set()
    )
    setStats(prev => prev.map((stat, seatIndex) => (
      clearedSet.has(seatIndex) ? { playerId: -1 } : stat
    )))
  }, [applyDimmedSeatIndices])

  useEffect(() => {
    window.addEventListener('updateBattleTypeFilter', handleBattleTypeFilterUpdate as EventListener)
    return () => window.removeEventListener('updateBattleTypeFilter', handleBattleTypeFilterUpdate as EventListener)
  }, [handleBattleTypeFilterUpdate])

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
