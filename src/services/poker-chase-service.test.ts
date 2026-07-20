/**
 * PokerChaseService - explicit session persistence tests
 *
 * Covers the refactor that replaced the implicit persistence triggers
 * (hand-written getter/setter pairs + a monkey-patched `session.players.set`)
 * with an explicit `SessionState` class. These tests pin down the observable
 * behavior that must not regress:
 *  - mutations schedule a single debounced `chrome.storage.local.set` call
 *  - restoring from storage never re-triggers persistence
 *  - the persisted shape is unchanged, so state written by the old
 *    implementation still hydrates correctly
 */
import PokerChaseService, { PokerChaseDB } from '../app'
import { SessionState } from './poker-chase-service'
import { ApiType } from '../types'
import type { ApiEvent, PlayerStats } from '../types'
import { BattleType } from '../types/game'
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'

const STORAGE_KEY = PokerChaseService.STORAGE_KEY

const dealEvent: ApiEvent<ApiType.EVT_DEAL> = {
  ApiTypeId: ApiType.EVT_DEAL,
  SeatUserIds: [101, 102, 103],
  Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
  Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [0, 1], Chip: 5000, BetChip: 0 },
  OtherPlayers: [
    { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
    { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
  ],
  Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
  timestamp: 1000,
}

/** Clear the mocked chrome.storage.local state between tests */
async function clearStorage() {
  await chrome.storage.local.set({ [STORAGE_KEY]: undefined })
  jest.clearAllMocks()
}

function newService() {
  const db = new PokerChaseDB(indexedDB, IDBKeyRange)
  return new PokerChaseService({ db })
}

describe('PokerChaseService - explicit session persistence', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(async () => {
    jest.useRealTimers()
    await clearStorage()
  })

  test('N回の連続ミューテーションが1回のstorage.set呼び出しにデバウンスされる', async () => {
    const service = newService()
    await service.ready

    service.session.setId('session-1')
    service.session.setBattleType(BattleType.SIT_AND_GO)
    service.session.setName('Test Table')
    service.session.setPlayer(1, { name: 'Alice', rank: 'gold' })
    service.session.setPlayer(2, { name: 'Bob', rank: 'silver' })
    service.playerId = 1
    service.latestEvtDeal = dealEvent

    // Debounce window (500ms) hasn't elapsed yet
    expect(chrome.storage.local.set).not.toHaveBeenCalled()

    jest.advanceTimersByTime(500)
    // Allow the promise returned by chrome.storage.local.set to settle
    await Promise.resolve()

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1)
    const [payload] = (chrome.storage.local.set as jest.Mock).mock.calls[0]
    const state = payload[STORAGE_KEY]
    expect(state.playerId).toBe(1)
    expect(state.latestEvtDeal).toEqual(dealEvent)
    expect(state.session.id).toBe('session-1')
    expect(state.session.battleType).toBe(BattleType.SIT_AND_GO)
    expect(state.session.name).toBe('Test Table')
    expect(state.session.players).toEqual([
      [1, { name: 'Alice', rank: 'gold' }],
      [2, { name: 'Bob', rank: 'silver' }],
    ])
  })

  test('restoreState()はストレージへの書き戻し（persist）をトリガーしない', async () => {
    // Pre-seed storage as if a previous session had persisted state
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        playerId: 42,
        latestEvtDeal: dealEvent,
        session: {
          id: 'restored-session',
          battleType: BattleType.TOURNAMENT,
          name: 'Restored Table',
          players: [[1, { name: 'Alice', rank: 'gold' }]],
        },
        lastUpdated: Date.now(),
      },
    })
    jest.clearAllMocks()

    const service = newService()
    await service.ready

    // Restoration applied the values...
    expect(service.playerId).toBe(42)
    expect(service.session.id).toBe('restored-session')
    expect(service.session.battleType).toBe(BattleType.TOURNAMENT)
    expect(service.session.name).toBe('Restored Table')
    expect(service.session.players.get(1)).toEqual({ name: 'Alice', rank: 'gold' })

    // ...but did NOT schedule/trigger any persistence
    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })

  test('reset()はpersistをトリガーし、セッションをクリアする', async () => {
    const service = newService()
    await service.ready

    service.session.setId('session-1')
    service.session.setPlayer(1, { name: 'Alice', rank: 'gold' })
    jest.advanceTimersByTime(500)
    await Promise.resolve()
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1)

    service.resetSession()
    jest.advanceTimersByTime(500)
    await Promise.resolve()

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(2)
    const [payload] = (chrome.storage.local.set as jest.Mock).mock.calls[1]
    const state = payload[STORAGE_KEY]
    expect(state.session.id).toBeUndefined()
    expect(state.session.battleType).toBeUndefined()
    expect(state.session.name).toBeUndefined()
    expect(state.session.players).toEqual([])

    expect(service.session.id).toBeUndefined()
    expect(service.session.players.size).toBe(0)
  })

  test('setPlayer()によるプレイヤー追加はpersistをトリガーする', async () => {
    const service = newService()
    await service.ready

    service.session.setPlayer(7, { name: 'Carol', rank: 'diamond' })
    jest.advanceTimersByTime(500)
    await Promise.resolve()

    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1)
    expect(service.session.players.get(7)).toEqual({ name: 'Carol', rank: 'diamond' })
  })

  test('players の読み取り（get/size/entries）は可能で、setPlayer()経由でのみ更新される', async () => {
    const service = newService()
    await service.ready

    expect(service.session.players.size).toBe(0)
    service.session.setPlayer(7, { name: 'Carol', rank: 'diamond' })
    expect(service.session.players.size).toBe(1)
    expect(service.session.players.get(7)).toEqual({ name: 'Carol', rank: 'diamond' })
    expect(Array.from(service.session.players.entries())).toEqual([[7, { name: 'Carol', rank: 'diamond' }]])
    // Note: `session.players.set(...)` is a *compile-time* error (ReadonlyMap) -
    // enforced by `npm run typecheck`, not something we can assert at runtime
    // without `any`-casting past the type system.
  })

  test('旧フォーマットで永続化されたstateが正しくhydrateされる（ストレージ形式の後方互換性）', async () => {
    // This mirrors exactly what the OLD implementation (pre-refactor) wrote to
    // chrome.storage.local: playerId, latestEvtDeal, session:{id,battleType,name,players:[[k,v]...]}, lastUpdated
    const oldFormatState = {
      playerId: 123,
      latestEvtDeal: dealEvent,
      session: {
        id: 'legacy-session-456',
        battleType: BattleType.RING_GAME,
        name: 'Legacy Ring Table',
        players: [
          [101, { name: 'Player101', rank: 'legend' }],
          [102, { name: 'Player102', rank: 'diamond' }],
        ],
      },
      lastUpdated: 1700000000000,
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: oldFormatState })
    jest.clearAllMocks()

    const service = newService()
    await service.ready

    expect(service.playerId).toBe(123)
    expect(service.latestEvtDeal).toEqual(dealEvent)
    expect(service.session.id).toBe('legacy-session-456')
    expect(service.session.battleType).toBe(BattleType.RING_GAME)
    expect(service.session.name).toBe('Legacy Ring Table')
    expect(service.session.players.size).toBe(2)
    expect(service.session.players.get(101)).toEqual({ name: 'Player101', rank: 'legend' })
    expect(service.session.players.get(102)).toEqual({ name: 'Player102', rank: 'diamond' })

    // And hydrating must not have scheduled a persist
    jest.advanceTimersByTime(1000)
    await Promise.resolve()
    expect(chrome.storage.local.set).not.toHaveBeenCalled()
  })
})

describe('PokerChaseService - hero playerId survives session end + SW restart (sola 2026-07-20 field report)', () => {
  // 実地報告の再現: (1) 生ハンドでplayerIdが確定 → (2) セッション終盤、ヒーロー敗退後も
  // クライアントが他プレイヤーのテーブルを観戦し続ける観戦モードdeal（EVT_DEALだが
  // `Player`フィールドがundefined -- docs/api-events.md「EVT_DEAL: Playerフィールドの
  // 欠落」「観戦モード」参照）が届く → (3) ブラウザリロード（= SW再起動、
  // chrome.storage.localからの復元）。
  //
  // 修正前（aggregate-events-stream.ts のEVT_DEALケース）は観戦モードdealのたびに
  // `this.service.playerId = undefined` を無条件代入し、500msデバウンス後に
  // chrome.storage.localへその undefined が永続化されていた。このテストはそれを
  // playerIdセッターだけでなく実際のイベントパイプライン（handAggregateStream）経由で
  // 再現する。
  const spectatorDealEvent: ApiEvent<ApiType.EVT_DEAL> = {
    ApiTypeId: ApiType.EVT_DEAL,
    // 観戦中の別テーブルの顔ぶれ（ヒーロー=101はこの配列に含まれない）
    SeatUserIds: [201, 202, 203],
    Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: 0, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 0, SmallBlindSeat: 1, BigBlindSeat: 2 },
    // 観戦モード: Playerフィールド自体が存在しない
    OtherPlayers: [
      { SeatIndex: 0, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
      { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
      { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 200, IsSafeLeave: false },
    ],
    Progress: { Phase: 0, NextActionSeat: 0, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 300, SidePot: [] },
    timestamp: 1010,
  }

  const handResultsEvent: ApiEvent<ApiType.EVT_HAND_RESULTS> = {
    ApiTypeId: ApiType.EVT_HAND_RESULTS,
    CommunityCards: [],
    Pot: 400,
    SidePot: [],
    ResultType: 1, // トーナメント敗退（ヒーロー脱落）
    DefeatStatus: 1,
    HandId: 999,
    HandLog: '',
    Results: [{ UserId: 102, HoleCards: [], RankType: 10, Hands: [], HandRanking: 1, Ranking: -2, RewardChip: 400 }],
    Player: { SeatIndex: 0, BetStatus: -1, Chip: 0, BetChip: 0 },
    OtherPlayers: [
      { SeatIndex: 1, Status: 0, BetStatus: -1, Chip: 4900, BetChip: 0, IsSafeLeave: false },
      { SeatIndex: 2, Status: 0, BetStatus: -1, Chip: 4800, BetChip: 0, IsSafeLeave: false },
    ],
    timestamp: 1005,
  }

  // このdescribeブロックは実タイマーを使う: handAggregateStream.write()は
  // fake-indexeddb経由の実DB書き込みを伴い、jest.useFakeTimers()と組み合わせると
  // トランザクションのマイクロタスク順序が崩れてハングする（他のdescribeブロックが
  // fake timersを使えているのは、そちらがsession/playerIdのセッターを直接呼ぶだけで
  // DBを経由しないため）。500msデバウンスは実際に待つ。
  const waitForDebounce = () => new Promise(resolve => setTimeout(resolve, 600))

  afterEach(async () => {
    await clearStorage()
  })

  test('観戦モードdeal（Player欠落）はライブのplayerIdを消さない', async () => {
    const service = newService()
    await service.ready

    // (1) 生ハンドでplayerIdが確定
    service.handAggregateStream.write(dealEvent)
    await service.handAggregateStream.whenIdle()
    expect(service.playerId).toBe(101) // dealEvent: SeatUserIds[Player.SeatIndex=0] = 101

    service.handAggregateStream.write(handResultsEvent)
    await service.handAggregateStream.whenIdle()

    // (2) ヒーロー敗退後、他テーブルの観戦モードdealが届く（Playerフィールドなし）
    service.handAggregateStream.write(spectatorDealEvent)
    await service.handAggregateStream.whenIdle()

    // 修正前はここで undefined になっていた（観戦モードdealが無条件で
    // playerIdを上書きしていたため）
    expect(service.playerId).toBe(101)
    // latestEvtDeal（永続化対象・「ヒーロー在籍」の文脈）は観戦モードdealでは
    // 更新されず、直前のヒーロー在籍dealのまま保持される。これは
    // recalculateStats()/recalculateAllStats()（フィルター変更・バッチモード
    // 終了時の再計算）が常にヒーロー基準のSeatUserIdsを使うために必要
    // （codex #177 再レビューP2指摘 — 観戦モードdealでこれも更新すると、観戦中の
    // フィルター変更でヒーロー統計が観戦テーブルの顔ぶれに上書きされてしまう）。
    expect(service.latestEvtDeal?.SeatUserIds).toEqual(dealEvent.SeatUserIds)
    // liveEvtDeal（非永続化・「今配信中の席」の文脈）はPlayerの有無に関わらず
    // 追従する。観戦中の別テーブルの統計がApp.tsxで古いヒーロー席インデックスを
    // 基準に誤回転されないようにするため（codex #177 1回目のレビュー指摘）。
    expect(service.liveEvtDeal?.SeatUserIds).toEqual(spectatorDealEvent.SeatUserIds)
  })

  test('観戦モードdeal後もchrome.storage.localへplayerIdが正しく永続化され、SW再起動（新規service+restoreState）を跨いで生存する', async () => {
    const service = newService()
    await service.ready

    service.handAggregateStream.write(dealEvent)
    await service.handAggregateStream.whenIdle()
    service.handAggregateStream.write(handResultsEvent)
    await service.handAggregateStream.whenIdle()
    service.handAggregateStream.write(spectatorDealEvent)
    await service.handAggregateStream.whenIdle()

    // (3-a) 500msデバウンスを経てchrome.storage.localへ永続化される
    await waitForDebounce()

    expect(chrome.storage.local.set).toHaveBeenCalled()
    const lastCallIndex = (chrome.storage.local.set as jest.Mock).mock.calls.length - 1
    const [payload] = (chrome.storage.local.set as jest.Mock).mock.calls[lastCallIndex]
    const persisted = payload[STORAGE_KEY]
    // 修正前はここが undefined として永続化されていた
    expect(persisted.playerId).toBe(101)

    // (3-b) SW再起動をシミュレート: 新しいPokerChaseServiceインスタンスを作り、
    // 同じ（モックの）chrome.storage.localから復元する
    const restartedService = newService()
    await restartedService.ready

    expect(restartedService.playerId).toBe(101)
    // #158 事前ゲームヒーロー統計パス（background/import-export.tsのgetLatestSessionStats）
    // が要求する `!service.playerId` ガードを通過できることを確認
    expect(restartedService.playerId).toBeTruthy()
  })

  test('観戦モードを挟んでも、別アカウントへのログイン切り替え（新しいPlayerありdeal）はplayerIdを正しく上書きする', async () => {
    const service = newService()
    await service.ready

    service.handAggregateStream.write(dealEvent)
    await service.handAggregateStream.whenIdle()
    expect(service.playerId).toBe(101)

    service.handAggregateStream.write(spectatorDealEvent)
    await service.handAggregateStream.whenIdle()
    expect(service.playerId).toBe(101) // 観戦モードでは変化しない

    // 別アカウントでの再ログインを模した、Playerが存在する新しいdeal
    const otherAccountDeal: ApiEvent<ApiType.EVT_DEAL> = {
      ...dealEvent,
      SeatUserIds: [555, 102, 103],
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [2, 3], Chip: 5000, BetChip: 0 },
      timestamp: 1020,
    }
    service.handAggregateStream.write(otherAccountDeal)
    await service.handAggregateStream.whenIdle()

    expect(service.playerId).toBe(555)
  })

  test('観戦モード中にHUDフィルターを変更しても、統計は観戦テーブルの顔ぶれで上書きされない（codex #177 再レビューP2）', async () => {
    // 再現シナリオ: ヒーロー敗退→観戦モードdeal→（この状態で）フィルター変更。
    // setBattleTypeFilter()は本番でpopup/background.tsがフィルター保存時に呼ぶ
    // 経路で、内部でReadEntityStream.recalculateStats()を呼ぶ。これは
    // `!playerId || !latestEvtDeal`という素通しのガードしか持たないため、
    // latestEvtDealの中身がヒーロー在籍時点のSeatUserIdsなのか観戦テーブルの
    // SeatUserIdsなのかで結果が変わる。1段階目の修正（latestEvtDealをPlayer
    // 有無に関わらず追従させる）だとここで観戦テーブルの顔ぶれ（履歴なし）に
    // 上書きされてしまっていた。
    const service = newService()
    await service.ready

    service.handAggregateStream.write(dealEvent)
    await service.handAggregateStream.whenIdle()
    service.handAggregateStream.write(handResultsEvent)
    await service.handAggregateStream.whenIdle()

    // ヒーロー敗退後、他テーブルの観戦モードdealが届く
    service.handAggregateStream.write(spectatorDealEvent)
    await service.handAggregateStream.whenIdle()

    expect(service.playerId).toBe(101)
    expect(service.latestEvtDeal?.SeatUserIds).toEqual(dealEvent.SeatUserIds)

    // フィルター変更（本番の実際の呼び出し経路）
    const dataPromise = new Promise<PlayerStats[]>(resolve => {
      service.statsOutputStream.once('data', resolve)
    })
    await service.setBattleTypeFilter({ gameTypes: { sng: true, mtt: true, ring: true } })
    const stats = await dataPromise

    // 観戦テーブルの顔ぶれ（spectatorDealEvent: 201/202/203）ではなく、
    // ヒーロー在籍テーブルの顔ぶれ（dealEvent: 101/102/103）で再計算されている
    expect(stats.map(s => s.playerId)).toEqual(dealEvent.SeatUserIds)
    expect(stats.map(s => s.playerId)).not.toEqual(spectatorDealEvent.SeatUserIds)

    // codex #177 3巡目レビューP2「Preserve hero deal when recalculating
    // filters」: 上のフィルター変更前、observerモードdealによって
    // service.liveEvtDealはspectatorDealEvent（Player不在）を指していた。
    // recalculateStats()はlatestEvtDealを"読むだけ"のパスなので、明示的に
    // liveEvtDealをlatestEvtDealへ同期しないと、ports.tsのブロードキャストが
    // 「ヒーロー在籍の統計」を「Player不在のevtDeal」とペアリングしてしまい、
    // App.tsxが回転をスキップしてヒーローパネルを生の席（seat 0以外）に
    // 表示してしまう。ここでliveEvtDealがlatestEvtDeal（Player.SeatIndex=0）
    // と同期していることを確認する。
    expect(service.liveEvtDeal?.Player?.SeatIndex).toBe(0)
    expect(service.liveEvtDeal?.SeatUserIds).toEqual(dealEvent.SeatUserIds)
  })

  test('観戦モードdeal後にヒーロー在籍dealへ再アンカーすると、取り残されたliveEvtDealも即座に同期する（import/rebuild/auto-sync復元の再現、codex #177 3巡目レビューP2「Use restored deal context for batch broadcasts」）', async () => {
    // 再現シナリオ: ライブでヒーロー敗退→観戦モードdealが届く（liveEvtDealが
    // 観戦テーブルを指すようになる）→ その状態のままimport/rebuild/auto-sync
    // 相当の「service.latestEvtDeal = 復元されたヒーロー在籍deal」という直接
    // 代入が起きる（実際のコードはimport-export.ts の importData/rebuildAllData、
    // auto-sync-service.ts の restoreLatestDeal がこのパターンを使う）。
    //
    // liveEvtDealのgetterは`_liveEvtDeal ?? _latestEvtDeal`という
    // フォールバックしか持たないため、_liveEvtDealが観戦dealで既にセット
    // 済みだとフォールバックが効かず、latestEvtDealだけを更新しても
    // liveEvtDealは古い観戦dealを指したまま取り残されてしまう
    // （そのすぐ後にstatsOutputStream.write()で再ブロードキャストすると、
    // ports.tsが古いliveEvtDealとペアリングしてしまう）。
    const service = newService()
    await service.ready

    service.handAggregateStream.write(dealEvent)
    await service.handAggregateStream.whenIdle()
    service.handAggregateStream.write(handResultsEvent)
    await service.handAggregateStream.whenIdle()

    // ヒーロー敗退後、観戦モードdealが届く -- liveEvtDealが観戦テーブルを指す
    service.handAggregateStream.write(spectatorDealEvent)
    await service.handAggregateStream.whenIdle()
    expect(service.liveEvtDeal?.SeatUserIds).toEqual(spectatorDealEvent.SeatUserIds)
    expect(service.liveEvtDeal?.Player).toBeUndefined()

    // import/rebuild/auto-sync復元相当: 復元された（Player在籍の）dealを
    // service.latestEvtDealへ直接代入する
    const restoredHeroDeal: ApiEvent<ApiType.EVT_DEAL> = {
      ...dealEvent,
      SeatUserIds: [777, 102, 103],
      Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [4, 5], Chip: 5000, BetChip: 0 },
      timestamp: 2000,
    }
    service.latestEvtDeal = restoredHeroDeal

    // 修正前はここでliveEvtDealがspectatorDealEventのまま取り残されていた
    expect(service.liveEvtDeal?.SeatUserIds).toEqual(restoredHeroDeal.SeatUserIds)
    expect(service.liveEvtDeal?.Player?.SeatIndex).toBe(0)
  })
})

describe('SessionState (standalone unit tests)', () => {
  test('明示的なセッターは全てnotifyChangeを一度だけ呼ぶ', () => {
    const notifyChange = jest.fn()
    const session = new SessionState(notifyChange)

    session.setId('s1')
    session.setBattleType(BattleType.SIT_AND_GO)
    session.setName('Table')
    session.setPlayer(1, { name: 'Alice', rank: 'gold' })
    session.reset()

    expect(notifyChange).toHaveBeenCalledTimes(5)
  })

  test('hydrate()はnotifyChangeを呼ばない', () => {
    const notifyChange = jest.fn()
    const session = new SessionState(notifyChange)

    session.hydrate({
      id: 's1',
      battleType: BattleType.TOURNAMENT,
      name: 'Table',
      players: [[1, { name: 'Alice', rank: 'gold' }]],
    })

    expect(notifyChange).not.toHaveBeenCalled()
    expect(session.id).toBe('s1')
    expect(session.battleType).toBe(BattleType.TOURNAMENT)
    expect(session.name).toBe('Table')
    expect(session.players.get(1)).toEqual({ name: 'Alice', rank: 'gold' })
  })

  test('toJSON()は永続化形式（players配列化済み）を返す', () => {
    const session = new SessionState(() => { })
    session.setId('s1')
    session.setBattleType(BattleType.SIT_AND_GO)
    session.setName('Table')
    session.setPlayer(1, { name: 'Alice', rank: 'gold' })

    expect(session.toJSON()).toEqual({
      id: 's1',
      battleType: BattleType.SIT_AND_GO,
      name: 'Table',
      players: [[1, { name: 'Alice', rank: 'gold' }]],
    })
  })
})
