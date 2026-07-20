/**
 * FirebaseAuthService.getIdToken() -- stale token-refresh handling.
 *
 * codex post-merge review on #192, r3616116753, P1, "Count stale refreshes
 * as auth transitions": if an ID-token refresh for account A is still in
 * flight when the user signs into account B, applying the refresh response
 * back into the shared `currentState` unconditionally corrupts it (mixing
 * B's other fields with A's refreshed uid/token/refreshToken) and silently
 * resurrects A's uid into `getCurrentUser()` -- without ever advancing
 * `authGeneration`, defeating every `assertGenerationUnchanged()`
 * commit-point check built on top of it elsewhere in this codebase.
 */
import { FirebaseAuthService } from './firebase-auth-service'

describe('FirebaseAuthService.getIdToken -- stale refresh handling', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('discards a token refresh response for an account that is no longer current, without corrupting currentState or resurrecting the old uid (P1, codex review r3616116753)', async () => {
    const stateA = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-old-token',
      refreshToken: 'a-refresh-token',
      // Already expired -- forces getIdToken() to actually refresh.
      expiresAt: Date.now() - 1000
    }
    // Pre-seed storage so the service's own constructor-kicked-off restore
    // naturally loads this state -- avoids racing a manual currentState
    // assignment against that same async restore.
    await chrome.storage.local.set({ firebaseRestAuthState: stateA })

    const service = new FirebaseAuthService()
    await service.ready()
    expect(service.getCurrentUser()?.uid).toBe('user-a')

    const generationBeforeRefresh = (service as any).authGeneration

    const stateB = {
      uid: 'user-b',
      email: 'b@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'b-token',
      refreshToken: 'b-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }

    let resolveFetch: ((value: any) => void) | undefined
    // Switch to account B as a side effect of fetch() actually being
    // called -- guarantees the switch happens exactly once getIdToken()
    // has progressed past its early-return check and captured A's
    // refreshingUid/refreshToken, i.e. while A's refresh is genuinely "in
    // flight" (simulates exactly what signInWithGoogle() does
    // synchronously: currentState reassignment + authGeneration bump).
    const fetchMock = jest.fn().mockImplementation(() => {
      ;(service as any).currentState = stateB
      ;(service as any).authGeneration = generationBeforeRefresh + 1
      return new Promise(resolve => { resolveFetch = resolve })
    })
    const originalFetch = global.fetch
    global.fetch = fetchMock as any

    const tokenPromise = service.getIdToken()

    // Flush microtasks until getIdToken() has actually progressed past its
    // own `await this.ready()` and early-return check and reached the
    // fetch() call (which is what triggers the account switch above and
    // captures `resolveFetch`) -- `ready()` being already-resolved still
    // costs at least one microtask hop before the continuation runs.
    while (!resolveFetch) {
      await Promise.resolve()
    }

    // A's refresh now resolves.
    resolveFetch({
      ok: true,
      json: async () => ({
        id_token: 'a-refreshed-token',
        refresh_token: 'a-new-refresh-token',
        expires_in: '3600',
        user_id: 'user-a'
      })
    })

    const token = await tokenPromise
    global.fetch = originalFetch

    // The caller that started this refresh for A still gets A's refreshed
    // token back -- whatever in-flight operation requested it can still
    // complete using a valid, unexpired token for the account it actually
    // started with.
    expect(token).toBe('a-refreshed-token')

    // But currentState was NOT corrupted -- it still correctly reflects B,
    // completely untouched by A's stale refresh response. In particular,
    // getCurrentUser() must NOT have silently flipped back to A.
    expect(service.getCurrentUser()?.uid).toBe('user-b')
    expect((service as any).currentState).toEqual(stateB)

    // The discard itself doesn't bump authGeneration further -- nothing
    // NEW happened identity-wise here; the real transition to B already
    // bumped it when the switch was simulated above.
    expect((service as any).authGeneration).toBe(generationBeforeRefresh + 1)
  })

  test('applies a token refresh normally (persists it) when the account has NOT changed during the refresh', async () => {
    const stateA = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-old-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() - 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: stateA })

    const service = new FirebaseAuthService()
    await service.ready()

    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id_token: 'a-refreshed-token',
        refresh_token: 'a-new-refresh-token',
        expires_in: '3600',
        user_id: 'user-a'
      })
    }) as any

    const token = await service.getIdToken()
    global.fetch = originalFetch

    expect(token).toBe('a-refreshed-token')
    expect((service as any).currentState.idToken).toBe('a-refreshed-token')
    expect((service as any).currentState.refreshToken).toBe('a-new-refresh-token')
    expect(service.getCurrentUser()?.uid).toBe('user-a')
  })

  // Independent release-audit finding ("getIdToken's refresh path still has
  // an A->B->A ABA hole"): the two tests above only exercise a straight A->B
  // switch, where a bare uid comparison already catches the mismatch. This
  // one exercises the round trip the uid-only check is blind to: sign out A,
  // sign in B, back to A -- all while A's ORIGINAL refresh is still in
  // flight -- so by the time the stale response arrives, the live uid is
  // "user-a" again, string-equal to the snapshot, even though a fresh A
  // session (its own idToken/refreshToken, not the one that started this
  // refresh) is now live. Only the generation snapshot (which advances by 2
  // across the round trip) can tell the two A sessions apart.
  test('discards a stale token-refresh response across an A -> B -> A round trip, even though the uid matches again by the time it arrives (generation-gated ABA fix)', async () => {
    const stateA1 = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a1-old-token',
      refreshToken: 'a1-refresh-token',
      // Already expired -- forces getIdToken() to actually refresh.
      expiresAt: Date.now() - 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: stateA1 })

    const service = new FirebaseAuthService()
    await service.ready()
    expect(service.getCurrentUser()?.uid).toBe('user-a')

    const stateB = {
      uid: 'user-b',
      email: 'b@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'b-token',
      refreshToken: 'b-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    // A's SECOND, fresh sign-in after the A -> B -> A round trip -- a
    // DIFFERENT session than the one that started the in-flight refresh
    // below, even though it happens to share the same uid.
    const stateA2 = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a2-fresh-token',
      refreshToken: 'a2-fresh-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }

    let resolveFetch: ((value: any) => void) | undefined
    // Simulate the full A -> B -> A round trip as a side effect of fetch()
    // being called -- guarantees it happens exactly once getIdToken() has
    // captured A1's refreshingUid/refreshingGeneration/refreshToken, i.e.
    // while A1's refresh is genuinely "in flight".
    const fetchMock = jest.fn().mockImplementation(() => {
      ;(service as any).currentState = stateB
      ;(service as any).authGeneration += 1 // A -> B
      ;(service as any).currentState = stateA2
      ;(service as any).authGeneration += 1 // B -> A (a NEW A session)
      return new Promise(resolve => { resolveFetch = resolve })
    })
    const originalFetch = global.fetch
    global.fetch = fetchMock as any

    const tokenPromise = service.getIdToken()

    // Flush microtasks until getIdToken() has progressed past its own
    // `await this.ready()` and reached the fetch() call -- which is what
    // triggers the A1 -> B -> A2 round trip above and captures resolveFetch.
    while (!resolveFetch) {
      await Promise.resolve()
    }

    // The round trip has now happened (inside fetchMock, synchronously)
    // -- capture the resulting generation AFTER it, for the final assertion.
    const generationAfterRoundTrip = (service as any).authGeneration

    // A1's stale refresh now resolves.
    resolveFetch({
      ok: true,
      json: async () => ({
        id_token: 'a1-refreshed-token',
        refresh_token: 'a1-new-refresh-token',
        expires_in: '3600',
        user_id: 'user-a'
      })
    })

    const token = await tokenPromise
    global.fetch = originalFetch

    // The caller that started this refresh for A1 still gets the
    // freshly-fetched token back.
    expect(token).toBe('a1-refreshed-token')

    // But currentState was NOT corrupted: it still correctly reflects A2's
    // fresh session, completely untouched by A1's stale refresh response --
    // this is the crux of the ABA hole. A uid-only check would have seen
    // `currentState.uid === 'user-a' === refreshingUid` and wrongly applied
    // the stale response, silently reverting A2's fresh tokens back to A1's.
    expect(service.getCurrentUser()?.uid).toBe('user-a')
    expect((service as any).currentState).toEqual(stateA2)
    expect((service as any).currentState.idToken).toBe('a2-fresh-token')
    expect((service as any).currentState.refreshToken).toBe('a2-fresh-refresh-token')

    // Generation is unaffected by the discard itself -- it already advanced
    // by 2 (A1 -> B -> A2) before the stale response even arrived.
    expect((service as any).authGeneration).toBe(generationAfterRoundTrip)
  })
})
