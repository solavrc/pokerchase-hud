/**
 * message-router.ts - updateBattleTypeFilter's lastKnownStats refresh vs.
 * hero-anchored recalc while spectating
 *
 * `updateBattleTypeFilter`'s handler calls `service.setBattleTypeFilter()`
 * (which internally awaits `ReadEntityStream.recalculateStats()` --
 * read-entity-stream.ts -- and, as part of that call's synchronous prefix
 * before its first `await`, sets `service.liveEvtDeal =
 * service.latestEvtDeal`, i.e. re-anchors the live-display seat context to
 * the hero's own last SEATED deal), then immediately (still synchronously,
 * before that promise settles) reads `getLastKnownStats()` (ports.ts) and
 * re-triggers `service.statsOutputStream.write(...)` with whatever lineup
 * was last broadcast live.
 *
 * While spectating after busting, `lastKnownStats` holds the *spectator*
 * table's lineup (a different, non-hero SeatUserIds array than
 * `service.latestEvtDeal`, which stays pinned to the hero's last seated
 * deal -- see aggregate-events-stream.ts's EVT_DEAL case). Racing this
 * `write()` against `recalculateStats()`'s `liveEvtDeal` re-anchor can
 * broadcast the spectator lineup paired with the hero-anchored `evtDeal`
 * (or vice versa), causing App.tsx to rotate/display the wrong seats.
 *
 * Fix: gate the extra `lastKnownStats` refresh on a lineup-identity check
 * against `service.latestEvtDeal.SeatUserIds` -- skip it outright when the
 * two are known to disagree (spectating a different table than the hero's
 * own last deal). `setBattleTypeFilter()`'s own `recalculateStats()` call
 * already recomputes and (re)broadcasts the hero-anchored stats correctly,
 * so nothing is lost by skipping the redundant, racy refresh in that case.
 * セッション終了後も振り返り用にこのキャッシュを保持するため、観戦lineupが
 * 入っている間も不一致ガードが必要になる。
 * When `service.latestEvtDeal` is unset (never yet known -- a state that
 * doesn't actually arise once a hero deal has ever landed, but is a
 * possible synthetic/test state), the mismatch can't be established, so
 * the refresh still runs as before (safe default: unchanged behavior).
 */
import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import { ApiType } from '../types'
import type { ApiEvent } from '../types'
import { registerMessageRouter } from './message-router'
import { getLastKnownStats, registerStreamSubscriptions, setLastKnownStats } from './ports'
import type { ChromeMessage, MessageResponse } from '../types/messages'

const HERO_ID = 1

const FILTER_OPTIONS = {
  gameTypes: { sng: true, mtt: true, ring: true }
}

// Hero's last SEATED deal (persisted context: service.latestEvtDeal).
const HERO_DEAL: ApiEvent<ApiType.EVT_DEAL> = {
  ApiTypeId: ApiType.EVT_DEAL,
  SeatUserIds: [HERO_ID, 2, 3, 4, 5, 6],
  Game: { CurrentBlindLv: 1, NextBlindUnixSeconds: -1, Ante: 0, SmallBlind: 100, BigBlind: 200, ButtonSeat: 3, SmallBlindSeat: 0, BigBlindSeat: 1 },
  Player: { SeatIndex: 0, BetStatus: 1, HoleCards: [], Chip: 5000, BetChip: 0 },
  OtherPlayers: [
    { SeatIndex: 1, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 100, IsSafeLeave: false },
    { SeatIndex: 2, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 3, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 4, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
    { SeatIndex: 5, Status: 0, BetStatus: 1, Chip: 5000, BetChip: 0, IsSafeLeave: false },
  ],
  Progress: { Phase: 0, NextActionSeat: 2, NextActionTypes: [2, 3, 4, 5], NextExtraLimitSeconds: 1, MinRaise: 400, Pot: 500, SidePot: [] },
  timestamp: 1000,
}

describe('message-router updateBattleTypeFilter -- spectator lastKnownStats refresh vs. hero-anchored recalc', () => {
  let db: PokerChaseDB
  let service: PokerChaseService
  let messageListener: (request: ChromeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: MessageResponse) => void) => boolean | void
  let writeSpy: jest.SpyInstance

  beforeEach(async () => {
    db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    service.playerId = HERO_ID

    ;(global as any).chrome.tabs = {
      sendMessage: jest.fn(),
      query: jest.fn((_query, callback) => callback([])),
    }
    ;(chrome.runtime.onMessage.addListener as jest.Mock).mockClear()

    registerMessageRouter(service, db, 'https://example.com/*')
    registerStreamSubscriptions(service, 'https://example.com/*')
    messageListener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0]

    // write() itself is the message-router-only extra refresh under test --
    // setBattleTypeFilter()'s own recalculateStats() call pushes via a
    // different method (this.push(), not write()), so spying on write()
    // isolates exactly the call site the fix guards.
    writeSpy = jest.spyOn(service.statsOutputStream, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    // 保留中の500msデバウンスpersistState()タイマーの取り消しは、上の
    // trackServiceForTeardown()（test-service-teardown.ts）が登録するルート
    // afterEachが行う。#336はここで直接clearTimeoutしていたが、privateフィールド
    // 名の変更を型検査が捕まえられないため公開APIへ一本化した（同ファイルの
    // 規約ガードテスト参照）。取り消さないと、このインスタンスのタイマーが後続
    // テストのbeforeEach窓で発火し、playerId/latestEvtDealを共有storageモックへ
    // 書き戻す — 「latestEvtDeal未設定」のcontrolテストが遅いCIで落ちた原因
    // （CI run 30687009635）。
    jest.restoreAllMocks()
    delete (global as any).chrome.tabs
    setLastKnownStats([])
    db.close()
    await db.delete()
  })

  // Dispatch updateBattleTypeFilter and await the listener's sendResponse,
  // which fires once setBattleTypeFilter()'s promise chain settles. The
  // write() under test happens synchronously inside the listener, but
  // draining the full handler deterministically (instead of hoping a single
  // setTimeout(0) macrotask hop covers it) keeps the recalc chain from
  // racing afterEach's db teardown.
  const dispatchFilterUpdate = (handLimit?: unknown) => new Promise<void>(resolve => {
    const filterOptions = handLimit === undefined
      ? FILTER_OPTIONS
      : { ...FILTER_OPTIONS, handLimit }
    messageListener(
      { action: 'updateBattleTypeFilter', filterOptions } as unknown as ChromeMessage,
      {} as chrome.runtime.MessageSender,
      jest.fn(() => { resolve() })
    )
  })

  test.each([
    [0.5, undefined],
    [10, undefined],
    [300, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [0, undefined],
    [-1, undefined],
    [501, 500],
    [20, 20],
    [50, 50],
    [100, 100],
    [200, 200],
    [500, 500],
    [null, undefined],
  ])('message router normalizes handLimit=%p before applying the service filter', async (input, expected) => {
    await dispatchFilterUpdate(input)
    expect(service.handLimitFilter).toBe(expected)
  })

  test('message router treats a missing handLimit as ALL', async () => {
    await dispatchFilterUpdate()
    expect(service.handLimitFilter).toBeUndefined()
  })

  test('spectating a different table than the hero\'s last deal: the extra refresh is skipped (lineup mismatch)', async () => {
    // Hero's own last seated deal is known...
    service.latestEvtDeal = HERO_DEAL
    // ...but the last LIVE broadcast (ports.ts's lastKnownStats) is a
    // different table's lineup -- the spectator state this bug targets.
    const spectatorLineup = [
      { playerId: 10, statResults: [] } as any,
      { playerId: 20, statResults: [] } as any,
      { playerId: 30, statResults: [] } as any,
      { playerId: 40, statResults: [] } as any,
    ]
    setLastKnownStats(spectatorLineup)

    await dispatchFilterUpdate()

    // The mismatched spectator refresh must not fire -- it would race
    // service.liveEvtDeal's hero-anchored re-sync from recalculateStats()
    // and risk broadcasting spectator stats paired with the hero's evtDeal.
    expect(writeSpy).not.toHaveBeenCalled()
    // 信頼済み再計算がヒーロー基準lineupへ更新する。不一致の観戦write経路では
    // クリアも上書きもされない。
    expect(getLastKnownStats().map(stat => stat.playerId)).toEqual(HERO_DEAL.SeatUserIds)
  })

  test('hero still seated (lineup matches latestEvtDeal): the extra refresh still fires as before', async () => {
    service.latestEvtDeal = HERO_DEAL
    setLastKnownStats(HERO_DEAL.SeatUserIds.map(playerId => ({ playerId, statResults: [] } as any)))

    await dispatchFilterUpdate()

    expect(writeSpy).toHaveBeenCalledWith(HERO_DEAL.SeatUserIds)
  })

  test('control: latestEvtDeal not yet known -- mismatch cannot be established, refresh still fires (unchanged default behavior)', async () => {
    // service.latestEvtDeal deliberately left unset.
    setLastKnownStats([{ playerId: 2, statResults: [] } as any])

    await dispatchFilterUpdate()

    expect(writeSpy).toHaveBeenCalledWith([2])
  })

  test('playerId unknown even though latestEvtDeal is set (restored/corrupt intermediate state): recalculateStats() cannot run, so the refresh still fires as the only broadcast (codex #188 review)', async () => {
    // A state read-entity-stream.ts's recalculateStats() can't act on: it
    // early-returns on `!playerId || !latestEvtDeal` (read-entity-stream.ts),
    // so if this refresh were skipped too, a filter change would silently
    // stop updating the visible HUD stats entirely.
    service.playerId = undefined
    service.latestEvtDeal = HERO_DEAL
    // A mismatching lineup by SeatUserIds -- if the mismatch check alone
    // gated the skip (ignoring whether recalc can actually run), this would
    // wrongly be dropped.
    setLastKnownStats([
      { playerId: 10, statResults: [] } as any,
      { playerId: 20, statResults: [] } as any,
    ])

    await dispatchFilterUpdate()

    expect(writeSpy).toHaveBeenCalledWith([10, 20])
  })

  test('filter update is recomputed in the background without forwarding a tab-local cache invalidation', async () => {
    service.latestEvtDeal = HERO_DEAL
    setLastKnownStats(HERO_DEAL.SeatUserIds.map(playerId => ({ playerId, statResults: [] } as any)))

    await dispatchFilterUpdate()

    expect(chrome.tabs.query).not.toHaveBeenCalled()
    expect(writeSpy).toHaveBeenCalledWith(HERO_DEAL.SeatUserIds)
  })
})
