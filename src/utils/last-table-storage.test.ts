/**
 * last-table-storage.ts —「最後の卓」スナップショットの組み立て・検証・保存。
 *
 * ここで守りたい性質は3つ:
 *  - 組み立てはヒーロー席と空席を落とし、実プレイヤーが居なければ何も書かない
 *    （空の記録で「最後の卓」を上書きしない）
 *  - 読み出しはフェイルクローズ（バージョン違い・型違い・座席重複は復元しない）
 *  - 書き込みはデバウンスされ、最後に予約した内容が1回だけ書かれる
 */
import {
  LAST_TABLE_SNAPSHOT_MESSAGE_TIMEOUT_MS,
  LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS,
  LAST_TABLE_SNAPSHOT_VERSION,
  buildLastTableSnapshot,
  cancelPendingLastTableSnapshotSave,
  loadLastTableSnapshot,
  parseLastTableSnapshot,
  restoreSeatStats,
  scheduleLastTableSnapshotSave,
} from './last-table-storage'
import type { PlayerStats } from '../types/entities'

const player = (playerId: number, name: string | null): PlayerStats => ({
  playerId,
  statResults: [
    ...(name === null ? [] : [{ id: 'playerName', name: 'Name', value: name, formatted: name }]),
    { id: 'hands', name: 'HAND', value: 120, formatted: '120' },
    { id: 'vpip', name: 'VPIP', value: [30, 120], formatted: '25.0% (30/120)' },
  ],
})

const EMPTY: PlayerStats = { playerId: -1 }

describe('buildLastTableSnapshot', () => {
  it('ヒーロー席(0)と空席を落とし、残りを表示座席indexつきで積む', () => {
    const snapshot = buildLastTableSnapshot(
      [player(1, 'Hero'), player(201, 'A'), EMPTY, player(203, 'C'), EMPTY, EMPTY],
      1_700_000_000_000
    )

    expect(snapshot).not.toBeNull()
    expect(snapshot!.version).toBe(LAST_TABLE_SNAPSHOT_VERSION)
    expect(snapshot!.savedAt).toBe(1_700_000_000_000)
    expect(snapshot!.seats.map(seat => [seat.seatIndex, seat.playerId, seat.playerName]))
      .toEqual([[1, 201, 'A'], [3, 203, 'C']])
  })

  it('ヒーロー以外に実プレイヤーが居なければnull（空の記録で上書きしない）', () => {
    expect(buildLastTableSnapshot([player(1, 'Hero'), EMPTY, EMPTY, EMPTY, EMPTY, EMPTY])).toBeNull()
    expect(buildLastTableSnapshot([])).toBeNull()
  })

  it('名前が取れない席はplayerName: nullで積む（席自体は捨てない）', () => {
    const snapshot = buildLastTableSnapshot([EMPTY, player(201, null), EMPTY, EMPTY, EMPTY, EMPTY])
    expect(snapshot!.seats[0]!.playerName).toBeNull()
    expect(snapshot!.seats[0]!.playerId).toBe(201)
  })

  it('保存できない形のstatResultsを持つ席は落とす（記録全体は壊さない）', () => {
    const weird = {
      playerId: 202,
      statResults: [{ id: 'potOdds', name: 'Odds', value: { pot: 100, call: 20 } }],
    } as unknown as PlayerStats
    const snapshot = buildLastTableSnapshot([EMPTY, player(201, 'A'), weird, EMPTY, EMPTY, EMPTY])
    expect(snapshot!.seats.map(seat => seat.playerId)).toEqual([201])
  })
})

describe('parseLastTableSnapshot', () => {
  const valid = {
    version: LAST_TABLE_SNAPSHOT_VERSION,
    savedAt: 1,
    seats: [{
      seatIndex: 1,
      playerId: 201,
      playerName: 'A',
      statResults: [{ id: 'hands', name: 'HAND', value: 120 }],
    }],
  }

  it('妥当な記録はそのまま返す', () => {
    expect(parseLastTableSnapshot(valid)).toEqual(valid)
  })

  it.each([
    ['未設定', undefined],
    ['null', null],
    ['文字列', 'nope'],
    ['バージョン違い', { ...valid, version: LAST_TABLE_SNAPSHOT_VERSION + 1 }],
    ['seats無し', { version: LAST_TABLE_SNAPSHOT_VERSION, savedAt: 1 }],
    ['seatsが空', { ...valid, seats: [] }],
    ['座席indexが範囲外', { ...valid, seats: [{ ...valid.seats[0], seatIndex: 0 }] }],
    ['playerId欠損', { ...valid, seats: [{ ...valid.seats[0], playerId: undefined }] }],
    ['statResultsの値が非対応型', {
      ...valid,
      seats: [{ ...valid.seats[0], statResults: [{ id: 'x', name: 'X', value: { a: 1 } }] }],
    }],
    ['同じ座席が重複', { ...valid, seats: [valid.seats[0], valid.seats[0]] }],
  ])('%s は復元しない（フェイルクローズ）', (_label, raw) => {
    expect(parseLastTableSnapshot(raw)).toBeNull()
  })
})

describe('restoreSeatStats', () => {
  it('statResultsに名前があればそれを正本にする', () => {
    const restored = restoreSeatStats({
      seatIndex: 1,
      playerId: 201,
      playerName: '別名',
      statResults: [{ id: 'playerName', name: 'Name', value: '表示名' }],
    })
    expect(restored.statResults).toHaveLength(1)
    expect(restored.statResults[0].value).toBe('表示名')
  })

  it('statResultsに名前が無ければ明示フィールドから補う', () => {
    const restored = restoreSeatStats({
      seatIndex: 1,
      playerId: 201,
      playerName: 'オポーネントA',
      statResults: [{ id: 'hands', name: 'HAND', value: 120 }],
    })
    expect(restored.playerId).toBe(201)
    expect(restored.statResults[0]).toMatchObject({ id: 'playerName', value: 'オポーネントA' })
    expect(restored.statResults[1]).toMatchObject({ id: 'hands' })
  })

  it('名前がどこにも無ければ補わない（捏造しない）', () => {
    const restored = restoreSeatStats({
      seatIndex: 1,
      playerId: 201,
      playerName: null,
      statResults: [{ id: 'hands', name: 'HAND', value: 120 }],
    })
    expect(restored.statResults).toHaveLength(1)
  })
})

describe('scheduleLastTableSnapshotSave', () => {
  const sentSnapshots = () =>
    (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .filter(([message]) => message?.action === 'setLastTableSnapshot')
      .map(([message]) => message.snapshot)

  beforeEach(() => {
    jest.useFakeTimers()
    ;(chrome.runtime.sendMessage as jest.Mock).mockClear()
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (_message: unknown, callback?: () => void) => callback?.()
    )
  })

  afterEach(() => {
    cancelPendingLastTableSnapshotSave()
    jest.useRealTimers()
  })

  const lineup = (name: string): PlayerStats[] =>
    [player(1, 'Hero'), player(201, name), EMPTY, EMPTY, EMPTY, EMPTY]

  it('デバウンス後に1回だけ送り、最後に予約した内容が勝つ', () => {
    scheduleLastTableSnapshotSave(lineup('1回目'))
    scheduleLastTableSnapshotSave(lineup('2回目'))
    expect(sentSnapshots()).toHaveLength(0)

    jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS)

    expect(sentSnapshots()).toHaveLength(1)
    expect(sentSnapshots()[0].seats[0].playerName).toBe('2回目')
  })

  it('content scriptから storage.local へは直接書かない（TRUSTED_CONTEXTSで遮断されている）', () => {
    ;(chrome.storage.local.set as jest.Mock).mockClear()
    scheduleLastTableSnapshotSave(lineup('A'))
    jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS)
    expect(chrome.storage.local.set as jest.Mock).not.toHaveBeenCalled()
  })

  it('保存する中身が無い呼び出しは予約自体しない（既存の記録を消さない）', () => {
    scheduleLastTableSnapshotSave([player(1, 'Hero'), EMPTY, EMPTY, EMPTY, EMPTY, EMPTY])
    jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS)
    expect(sentSnapshots()).toHaveLength(0)
  })

  it('cancelで予約を取り消せる', () => {
    scheduleLastTableSnapshotSave(lineup('A'))
    cancelPendingLastTableSnapshotSave()
    jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_SAVE_DEBOUNCE_MS)
    expect(sentSnapshots()).toHaveLength(0)
  })
})

describe('loadLastTableSnapshot', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    ;(chrome.runtime.sendMessage as jest.Mock).mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const validSnapshot = {
    version: LAST_TABLE_SNAPSHOT_VERSION,
    savedAt: 1,
    seats: [{
      seatIndex: 1,
      playerId: 201,
      playerName: 'A',
      statResults: [{ id: 'hands', name: 'HAND', value: 120 }],
    }],
  }

  const load = (): unknown[] => {
    const received: unknown[] = []
    loadLastTableSnapshot(snapshot => received.push(snapshot))
    return received
  }

  it('backgroundへgetLastTableSnapshotを送り、検証済みの記録を返す', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation((message, callback) => {
      expect(message).toEqual({ action: 'getLastTableSnapshot' })
      callback({ success: true, snapshot: validSnapshot })
    })
    expect(load()).toEqual([validSnapshot])
    // 直接storage.localを読んではならない（遮断されている）。
    expect(chrome.storage.local.get as jest.Mock).not.toHaveBeenCalled()
  })

  it('backgroundが返した記録も自前で検証する（多層防御）', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation((_message, callback) => {
      callback({ success: true, snapshot: { version: 999, savedAt: 1, seats: [] } })
    })
    expect(load()).toEqual([null])
  })

  it('失敗応答・snapshot無しはnull', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation((_message, callback) => {
      callback({ success: false, error: 'nope' })
    })
    expect(load()).toEqual([null])
  })

  it('応答が来なければタイムアウトでnull（HUDの描画を引きずらない）', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(() => undefined)
    const received = load()
    expect(received).toEqual([])
    jest.advanceTimersByTime(LAST_TABLE_SNAPSHOT_MESSAGE_TIMEOUT_MS)
    expect(received).toEqual([null])
  })

  it('sendMessageが投げてもnullを返す（読み取り失敗でHUDを落とさない）', () => {
    ;(chrome.runtime.sendMessage as jest.Mock).mockImplementation(() => {
      throw new Error('boom')
    })
    expect(load()).toEqual([null])
  })
})
