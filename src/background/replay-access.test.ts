import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  PUBLIC_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_VERIFY_IN_SESSION,
  REPLAY_VERIFY_NO_AUTH
} from '../replay/protocol'
import {
  __resetReplayAccessForTests,
  readReplayAccessRecord,
  readReplayImportEnabled,
  verifyReplayImportAccess,
  type ReplayAccessDeps
} from './replay-access'

const NOW = Date.UTC(2026, 7, 4, 3, 0, 0)
const PORT = { name: 'verification-port' } as chrome.runtime.Port

const ledger = (overrides: Partial<{
  cardOpenEndDate: number
  isExpiredCardOpen: boolean
}> = {}) => ({
  battleType: 0,
  hands: [],
  cardOpenEndDate: Math.floor(NOW / 1000) + 86_400,
  isExpiredCardOpen: false,
  ...overrides
})

describe('公開リプレイ取り込みの課金検証', () => {
  let outsideSession: boolean
  let verificationPort: chrome.runtime.Port | undefined
  let requestVerification: jest.Mock

  const deps = (): ReplayAccessDeps => ({
    now: () => NOW,
    isOutsideSession: () => outsideSession,
    resolveVerificationPort: () => verificationPort,
    requestVerification
  })

  beforeEach(async () => {
    __resetReplayAccessForTests()
    outsideSession = true
    verificationPort = PORT
    requestVerification = jest.fn().mockResolvedValue({
      success: true,
      entitlement: ledger()
    })
    await chrome.storage.sync.remove([
      EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
      PUBLIC_REPLAY_IMPORT_STORAGE_KEY
    ])
  })

  test('開発者フラグは公開トグルと課金検証を無条件にバイパスする', async () => {
    await chrome.storage.sync.set({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true })

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(true)
    await expect(readReplayImportEnabled(NOW)).resolves.toBe(true)
    expect(requestVerification).not.toHaveBeenCalled()
  })

  test('公開トグルは未来のCardOpenEndDateかつ未失効の応答でのみ有効になる', async () => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(true)

    expect(requestVerification).toHaveBeenCalledTimes(1)
    expect(requestVerification).toHaveBeenCalledWith(PORT)
    expect(await readReplayAccessRecord()).toMatchObject({
      phase: 'verified',
      cardOpenEndDate: Math.floor(NOW / 1000) + 86_400
    })
    await expect(readReplayImportEnabled(NOW)).resolves.toBe(true)
  })

  test.each([
    { isExpiredCardOpen: true, cardOpenEndDate: Math.floor(NOW / 1000) + 86_400 },
    { isExpiredCardOpen: false, cardOpenEndDate: Math.floor(NOW / 1000) }
  ])('失効フラグまたは期限切れ日時を拒否する: %p', async response => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })
    requestVerification.mockResolvedValue({ success: true, entitlement: ledger(response) })

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(false)

    expect(requestVerification).toHaveBeenCalledTimes(1)
    expect(await readReplayAccessRecord()).toMatchObject({ phase: 'expired' })
    await expect(readReplayImportEnabled(NOW)).resolves.toBe(false)
  })

  test('セッション中は保留し、終了後の契機で初めて検証する', async () => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })
    outsideSession = false

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(false)
    expect(requestVerification).not.toHaveBeenCalled()
    expect(await readReplayAccessRecord()).toEqual({ phase: 'pending-session' })

    outsideSession = true
    await expect(verifyReplayImportAccess(deps())).resolves.toBe(true)
    expect(requestVerification).toHaveBeenCalledTimes(1)
  })

  test('認証エンベロープを持つポートが無ければ通信せず保留する', async () => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })
    verificationPort = undefined

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(false)

    expect(requestVerification).not.toHaveBeenCalled()
    expect(await readReplayAccessRecord()).toEqual({ phase: 'pending-auth' })
  })

  // ページ側・SW側どちらのfairness gateで止まった場合も「まだ撃てない」であり、
  // `error`にはしない ―― 次の取得サイクルの先頭で必ず撃ち直されるため。
  test.each([
    [REPLAY_VERIFY_IN_SESSION, 'pending-session'],
    [REPLAY_VERIFY_NO_AUTH, 'pending-auth'],
    ['HTTP 503', 'error']
  ])('検証が%sで返ったら%sとして記録する', async (error, phase) => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })
    requestVerification.mockResolvedValue({ success: false, error })

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(false)

    expect(await readReplayAccessRecord()).toMatchObject({ phase, lastError: error })
    await expect(readReplayImportEnabled(NOW)).resolves.toBe(false)
  })

  test('公開トグルOFFのままなら`disabled`を書き直さない', async () => {
    const setSpy = jest.spyOn(chrome.storage.local, 'set')

    await expect(verifyReplayImportAccess(deps())).resolves.toBe(false)
    await expect(verifyReplayImportAccess(deps())).resolves.toBe(false)

    expect(setSpy).not.toHaveBeenCalled()
    expect(await readReplayAccessRecord()).toEqual({ phase: 'disabled' })
    setSpy.mockRestore()
  })

  test('同時に来た検証契機は1本の/listへ合流する', async () => {
    await chrome.storage.sync.set({ [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: true })
    let resolveRequest!: (value: unknown) => void
    requestVerification.mockReturnValue(new Promise(resolve => { resolveRequest = resolve }))

    const first = verifyReplayImportAccess(deps())
    const second = verifyReplayImportAccess(deps())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(requestVerification).toHaveBeenCalledTimes(1)
    resolveRequest({ success: true, entitlement: ledger() })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })
})
