import { IDBKeyRange, indexedDB } from 'fake-indexeddb'
import PokerChaseService, { PokerChaseDB } from '../app'
import type { ApiEvent } from '../types'
import { ApiType } from '../types'
import { trackServiceForTeardown } from '../utils/test-service-teardown'
import {
  prefetchStatsLedgerBaselines,
  registerEventIngestion,
} from './event-ingestion'
import { connectedPorts } from './ports'

const makeService = (ensurePlayerBaselines: (playerIds: readonly number[]) => Promise<void>): PokerChaseService => ({
  statsLedger: { ensurePlayerBaselines },
} as unknown as PokerChaseService)

const joinUser = (userId: number) => ({
  UserId: userId,
  UserName: 'player',
  FavoriteCharaId: '',
  CostumeId: '',
  EmblemId: '',
  IsCpu: false,
  IsOfficial: false,
  SettingDecoIds: ['', '', '', '', '', '', ''],
  Rank: {
    RankId: 'rank-id',
    RankName: '',
    RankLvId: 'rank-lv-id',
    RankLvName: '',
  },
})

describe('stats ledger baseline prefetch', () => {
  test('313は現在の席にいる正IDだけを重複なく先読みする', () => {
    const ensurePlayerBaselines = jest.fn((_playerIds: readonly number[]) => Promise.resolve())
    const service = makeService(ensurePlayerBaselines)

    prefetchStatsLedgerBaselines(service, {
      ApiTypeId: ApiType.EVT_PLAYER_SEAT_ASSIGNED,
      SeatUserIds: [101, -1, 0, 202, 101, Number.MAX_SAFE_INTEGER + 1],
    } as ApiEvent)

    expect(ensurePlayerBaselines).toHaveBeenCalledWith([101, 202])
  })

  test('301は途中参加者、303は313欠落時の実ラインナップを先読みする', () => {
    const ensurePlayerBaselines = jest.fn((_playerIds: readonly number[]) => Promise.resolve())
    const service = makeService(ensurePlayerBaselines)

    prefetchStatsLedgerBaselines(service, {
      ApiTypeId: ApiType.EVT_PLAYER_JOIN,
      JoinUser: { UserId: 303 },
    } as ApiEvent)
    prefetchStatsLedgerBaselines(service, {
      ApiTypeId: ApiType.EVT_DEAL,
      SeatUserIds: [303, 404, -1, 404],
    } as ApiEvent)

    expect(ensurePlayerBaselines.mock.calls).toEqual([[[303]], [[303, 404]]])
  })

  test('baselineを即時起動し、破棄前に待てる完了Promiseを返す', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const ensurePlayerBaselines = jest.fn(() => pending)

    const completion = prefetchStatsLedgerBaselines(makeService(ensurePlayerBaselines), {
      ApiTypeId: ApiType.EVT_DEAL,
      SeatUserIds: [505],
    } as ApiEvent)
    expect(ensurePlayerBaselines).toHaveBeenCalledWith([505])

    let completed = false
    void completion?.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)

    release()
    await completion
    expect(completed).toBe(true)
  })

  test('失敗ログにplayer ID・payload・例外messageを含めない', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const ensurePlayerBaselines = jest.fn(() =>
      Promise.reject(new Error('secret payload for player 606'))
    )

    const completion = prefetchStatsLedgerBaselines(makeService(ensurePlayerBaselines), {
      ApiTypeId: ApiType.EVT_PLAYER_JOIN,
      JoinUser: { UserId: 606, Secret: 'raw-secret' },
    } as unknown as ApiEvent)
    await completion

    expect(warnSpy).toHaveBeenCalledWith(
      '[StatsLedger] Baseline prefetch failed (player-join)'
    )
    const serializedCalls = JSON.stringify(warnSpy.mock.calls)
    expect(serializedCalls).not.toContain('606')
    expect(serializedCalls).not.toContain('secret')
    warnSpy.mockRestore()
  })

  test('processEventはstream投入より先にprefetchを開始する', async () => {
    const db = new PokerChaseDB(indexedDB, IDBKeyRange)
    await db.open()
    const service = trackServiceForTeardown(new PokerChaseService({ db }))
    await service.ready
    const order: string[] = []
    jest.spyOn(service.statsLedger, 'ensurePlayerBaselines').mockImplementation(async () => {
      order.push('prefetch')
    })
    jest.spyOn(service.handLogStream, 'write').mockImplementation(((..._args: unknown[]) => {
      order.push('stream')
      return true
    }) as typeof service.handLogStream.write)

    ;(chrome.runtime as any).onConnect = { addListener: jest.fn() }
    registerEventIngestion(service)
    const connectListener = (chrome.runtime as any).onConnect.addListener.mock.calls[0][0]
    const disconnectHandlers: Array<() => void> = []
    const mockPort = {
      name: PokerChaseService.POKER_CHASE_SERVICE_EVENT,
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn((fn: () => void) => disconnectHandlers.push(fn)) },
      postMessage: jest.fn(),
    }
    connectListener(mockPort)
    const onMessage = mockPort.onMessage.addListener.mock.calls[0][0]

    try {
      await onMessage({
        ApiTypeId: ApiType.EVT_PLAYER_JOIN,
        timestamp: 1_000,
        JoinUser: joinUser(707),
        JoinPlayer: {
          BetChip: 0,
          BetStatus: 0,
          Chip: 10_000,
          SeatIndex: 0,
          Status: 0,
        },
      })

      expect(order.slice(0, 2)).toEqual(['prefetch', 'stream'])
    } finally {
      disconnectHandlers.forEach(disconnect => disconnect())
      connectedPorts.clear()
      db.close()
      await db.delete()
    }
  })
})
