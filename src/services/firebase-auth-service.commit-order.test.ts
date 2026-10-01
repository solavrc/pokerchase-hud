import assert from 'node:assert/strict'
import { FirebaseAuthService } from './firebase-auth-service'

// すべて架空の資格情報。Chromeの書込み順逆転を仮定せず、保存成功後の
// Promise完了だけを遅らせるケースも含めて、実クラスの公開APIを検証する。
const AUTH_KEY = 'firebaseRestAuthState'
const stateFor = (uid: string, idToken: string) => ({
  uid, email: `${uid}@example.test`, displayName: null, photoURL: null,
  idToken, refreshToken: `synthetic-refresh-${uid}`, expiresAt: Date.now() + 3_600_000
})
type State = ReturnType<typeof stateFor>
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const response = (body: unknown): Response => ({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)
}) as Response
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const observe = <T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> =>
  promise.then(value => ({ value }), error => ({ error }))

const refreshed = {
  user_id: 'user-a', id_token: 'synthetic-a-refreshed',
  refresh_token: 'synthetic-a-rotated', expires_in: '3600'
}

describe('認証refreshと資格情報commitの順序', () => {
  const originalFetch = global.fetch
  let stored: State | undefined
  let service: FirebaseAuthService
  let writes: string[]
  let removals: number
  let beforeSet: (state: State) => Promise<void>
  let afterSet: (state: State) => Promise<void>
  let beforeRemove: () => Promise<void>
  let refreshResponse: () => Promise<Response>
  let nextSignIn: State
  let fetchedSignIn: ReturnType<typeof deferred<void>>

  beforeEach(async () => {
    stored = stateFor('user-a', 'synthetic-a-original')
    writes = []
    removals = 0
    beforeSet = async () => {}
    afterSet = async () => {}
    beforeRemove = async () => {}
    refreshResponse = async () => response(refreshed)
    nextSignIn = stateFor('user-b', 'synthetic-b-signed-in')
    fetchedSignIn = deferred()

    ;(jest.spyOn(chrome.storage.local, 'get') as jest.SpyInstance)
      .mockImplementation(async () => stored ? { [AUTH_KEY]: copy(stored) } : {})
    ;(jest.spyOn(chrome.storage.local, 'set') as jest.SpyInstance)
      .mockImplementation(async (items: Record<string, State>) => {
        const candidate = copy(items[AUTH_KEY]!)
        writes.push(candidate.idToken)
        await beforeSet(candidate)
        stored = candidate
        await afterSet(candidate)
      })
    ;(jest.spyOn(chrome.storage.local, 'remove') as jest.SpyInstance)
      .mockImplementation(async () => {
        removals++
        await beforeRemove()
        stored = undefined
      })
    ;(jest.spyOn(chrome.storage.local, 'setAccessLevel') as jest.SpyInstance)
      .mockResolvedValue(undefined)
    ;(jest.spyOn(chrome.identity, 'getAuthToken') as jest.SpyInstance)
      .mockImplementation((_details: unknown, callback: (token: string) => void) => {
        callback('synthetic-google-token')
      })
    ;(jest.spyOn(chrome.identity, 'removeCachedAuthToken') as jest.SpyInstance)
      .mockImplementation((_details: unknown, callback: () => void) => callback())

    global.fetch = async (input) => {
      const url = String(input)
      if (url.includes('securetoken.googleapis.com')) return refreshResponse()
      if (url.includes('identitytoolkit.googleapis.com')) {
        const result = response({
          localId: nextSignIn.uid, email: nextSignIn.email,
          idToken: nextSignIn.idToken, refreshToken: nextSignIn.refreshToken, expiresIn: '3600'
        })
        fetchedSignIn.resolve()
        return result
      }
      if (url.startsWith('https://accounts.google.com/o/oauth2/revoke?')) return response({})
      throw new Error('テストが想定していないネットワーク要求')
    }
    service = new FirebaseAuthService()
    await service.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  const restored = async () => {
    const next = new FirebaseAuthService()
    await next.ready()
    return next
  }

  test('保存完了前は旧トークンを公開し、成功後だけ更新する', async () => {
    const entered = deferred()
    const release = deferred()
    beforeSet = async () => { entered.resolve(); await release.promise }
    const generation = service.getAuthGeneration()
    const refreshing = service.getIdToken(true)
    await entered.promise
    let tokenDuringCommit: string
    try { tokenDuringCommit = await service.getIdToken() } finally { release.resolve() }
    assert.equal(await refreshing, refreshed.id_token)
    assert.equal(tokenDuringCommit, 'synthetic-a-original')
    assert.equal(await service.getIdToken(), refreshed.id_token)
    assert.equal(await (await restored()).getIdToken(), refreshed.id_token)
    assert.equal(service.getAuthGeneration(), generation)
  })

  test('refreshの保存失敗でメモリだけを更新せず、後続commitも実行できる', async () => {
    const generation = service.getAuthGeneration()
    beforeSet = async () => { throw new Error('synthetic storage failure') }
    await assert.rejects(service.getIdToken(true), /synthetic storage failure/)
    const tokenAfterFailure = await service.getIdToken()
    assert.equal(tokenAfterFailure, 'synthetic-a-original')
    assert.equal(await (await restored()).getIdToken(), 'synthetic-a-original')
    assert.equal(service.getAuthGeneration(), generation)
    beforeSet = async () => {}
    await service.signInWithGoogle()
    assert.equal(await service.getIdToken(), 'synthetic-b-signed-in')
  })

  test('保存成功後の応答待ち中にBへログインしても、AのrefreshにBのtokenを返さない', async () => {
    const entered = deferred()
    const release = deferred()
    afterSet = async state => {
      if (state.idToken === refreshed.id_token) { entered.resolve(); await release.promise }
    }
    const refreshing = observe(service.getIdToken(true))
    await entered.promise
    const signingIn = service.signInWithGoogle()
    let wroteBBeforeCompletion: boolean
    try {
      await fetchedSignIn.promise
      await tick()
      wroteBBeforeCompletion = writes.includes('synthetic-b-signed-in')
    } finally { release.resolve() }
    const result = await refreshing
    await signingIn
    assert.equal(result.error, undefined)
    assert.equal(result.value, refreshed.id_token)
    assert.equal(wroteBBeforeCompletion, false)
    assert.equal(service.getCurrentUser()?.uid, 'user-b')
    assert.equal(stored?.uid, 'user-b')
    assert.equal((await restored()).getCurrentUser()?.uid, 'user-b')
  })

  test('refreshの保存完了までログアウトの削除を待ち、null参照や認証復活を起こさない', async () => {
    const entered = deferred()
    const release = deferred()
    afterSet = async () => { entered.resolve(); await release.promise }
    const refreshing = observe(service.getIdToken(true))
    await entered.promise
    const signingOut = service.signOut()
    let removedBeforeCompletion: number
    try { await tick(); removedBeforeCompletion = removals } finally { release.resolve() }
    const result = await refreshing
    await signingOut
    assert.equal(result.error, undefined)
    assert.equal(result.value, refreshed.id_token)
    assert.equal(removedBeforeCompletion, 0)
    assert.equal(service.getCurrentUser(), null)
    assert.equal(stored, undefined)
    assert.equal((await restored()).getCurrentUser(), null)
  })

  test('Bのcommit待ちに入ったAのrefreshは、キュー実行時に世代を再確認する', async () => {
    const entered = deferred()
    const release = deferred()
    beforeSet = async state => {
      if (state.uid === 'user-b') { entered.resolve(); await release.promise }
    }
    const signingIn = service.signInWithGoogle()
    await entered.promise
    const refreshing = observe(service.getIdToken(true))
    try { await tick() } finally { release.resolve() }
    await signingIn
    const result = await refreshing
    assert.equal(result.error, undefined)
    assert.equal(result.value, refreshed.id_token)
    assert.deepEqual(writes, ['synthetic-b-signed-in'])
    assert.equal(stored?.uid, 'user-b')
    assert.equal((await restored()).getCurrentUser()?.uid, 'user-b')
  })

  test('ネットワーク待ちはログアウトを止めず、A→B→A後の古いrefreshを保存しない', async () => {
    const requested = deferred()
    const release = deferred<Response>()
    refreshResponse = () => { requested.resolve(); return release.promise }
    const refreshing = observe(service.getIdToken(true))
    await requested.promise
    try {
      await service.signOut()
      await service.signInWithGoogle()
      await service.signOut()
      nextSignIn = stateFor('user-a', 'synthetic-a-new-session')
      await service.signInWithGoogle()
    } finally { release.resolve(response(refreshed)) }
    const result = await refreshing
    assert.equal(result.error, undefined)
    assert.equal(result.value, refreshed.id_token)
    assert.equal(writes.includes(refreshed.id_token), false)
    assert.equal(await service.getIdToken(), 'synthetic-a-new-session')
    assert.equal(await (await restored()).getIdToken(), 'synthetic-a-new-session')
  })

  test('refresh後のログアウト削除が失敗しても、保存済みtokenとの整合性を維持する', async () => {
    const entered = deferred()
    const release = deferred()
    afterSet = async () => { entered.resolve(); await release.promise }
    beforeRemove = async () => { throw new Error('synthetic removal failure') }
    const refreshing = service.getIdToken(true)
    await entered.promise
    const signingOut = observe(service.signOut())
    try { await tick() } finally { release.resolve() }
    assert.equal(await refreshing, refreshed.id_token)
    const result = await signingOut
    assert.match(String(result.error), /synthetic removal failure/)
    assert.equal(await service.getIdToken(), refreshed.id_token)
    assert.equal(await (await restored()).getIdToken(), refreshed.id_token)
    beforeRemove = async () => {}
    await service.signOut()
    assert.equal((await restored()).getCurrentUser(), null)
  })
})
