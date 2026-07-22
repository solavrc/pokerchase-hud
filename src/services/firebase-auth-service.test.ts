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

describe('FirebaseAuthService.signOut -- durable state removal', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('does not publish an in-memory sign-out when removing the persisted auth state fails', async () => {
    const storedState = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: storedState })

    const service = new FirebaseAuthService()
    await service.ready()
    expect(service.getCurrentUser()?.uid).toBe('user-a')
    const generationBeforeSignOut = service.getAuthGeneration()

    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((_options: unknown, callback: (result: { token: string }) => void) => {
      callback({ token: 'chrome-token' })
    }) as typeof chrome.identity.getAuthToken)
    ;(jest.spyOn(chrome.storage.local, 'remove') as jest.SpyInstance)
      .mockRejectedValueOnce(new Error('chrome.storage.local.remove failed'))

    await expect(service.signOut()).rejects.toThrow('chrome.storage.local.remove failed')

    // A failed durable commit must not expose a transient signed-out state
    // that reverses on the next Service Worker startup. The persisted token
    // is still present, so the current instance must remain consistently
    // signed in and let the popup report the sign-out failure.
    expect(service.getCurrentUser()?.uid).toBe('user-a')
    // The reservation is deliberately retained: work that started before
    // the failed attempt must still see that an auth-sensitive operation
    // intervened, even though no signed-out state was published.
    expect(service.getAuthGeneration()).toBe(generationBeforeSignOut + 1)

    const restartedService = new FirebaseAuthService()
    await restartedService.ready()
    expect(restartedService.getCurrentUser()?.uid).toBe('user-a')
  })

  test('invalidates in-flight work before durable removal, but publishes sign-out only after removal commits', async () => {
    const storedState = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: storedState })

    const service = new FirebaseAuthService()
    await service.ready()
    const generationBeforeSignOut = service.getAuthGeneration()
    const capturedUser = service.getCurrentUser()!
    const listener = jest.fn()
    service.onAuthStateChange(listener)
    await new Promise(resolve => setTimeout(resolve, 0)) // consume the listener's initial restore callback
    listener.mockClear()

    // No Chrome identity token means there is no external-revocation leg to
    // exercise here; this test isolates the local durable commit boundary.
    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((_options: unknown, callback: (result?: { token: string }) => void) => {
      callback(undefined)
    }) as typeof chrome.identity.getAuthToken)

    const originalRemove = (chrome.storage.local.remove as jest.Mock).getMockImplementation()!
    let removeStarted = false
    let releaseRemove: (() => void) | undefined
    jest.spyOn(chrome.storage.local, 'remove').mockImplementation(async (keys: string | string[]) => {
      removeStarted = true
      await new Promise<void>(resolve => { releaseRemove = resolve })
      return originalRemove(keys)
    })

    const signOut = service.signOut()
    while (!removeStarted) await Promise.resolve()

    // The generation reservation is visible immediately, invalidating work
    // that snapshotted the old session, while user-facing auth state and
    // listeners remain unchanged until the durable delete succeeds. Capture
    // it as if a sync started inside this pending-removal window.
    expect(service.getAuthGeneration()).toBe(generationBeforeSignOut + 1)
    const generationSnapshottedWhileRemovePending = service.getAuthGeneration()
    expect(service.getCurrentUser()?.uid).toBe('user-a')
    expect(listener).not.toHaveBeenCalled()
    await expect(capturedUser.getIdToken(true)).rejects.toThrow('Sign-out is in progress')

    releaseRemove?.()
    await signOut

    expect(service.getCurrentUser()).toBeNull()
    // A second increment at publication invalidates work that began during
    // the remove() window with user A plus the reservation generation.
    expect(service.getAuthGeneration()).toBe(generationBeforeSignOut + 2)
    expect(service.getAuthGeneration()).toBeGreaterThan(generationSnapshottedWhileRemovePending)
    expect(listener).toHaveBeenCalledWith(null, 'sign-out')

    const restartedService = new FirebaseAuthService()
    await restartedService.ready()
    expect(restartedService.getCurrentUser()).toBeNull()
  })

  test('waits for a slow sign-out before requesting a new Chrome token', async () => {
    const storedState = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: storedState })

    const service = new FirebaseAuthService()
    await service.ready()
    const generationBeforeSignOut = service.getAuthGeneration()

    let finishNonInteractiveLookup: (() => void) | undefined
    let interactiveLookupCount = 0
    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((options: { interactive?: boolean }, callback: (result?: { token: string }) => void) => {
      if (options.interactive) {
        interactiveLookupCount++
        callback({ token: 'new-chrome-token' })
      } else {
        finishNonInteractiveLookup = () => callback(undefined)
      }
    }) as typeof chrome.identity.getAuthToken)

    const originalFetch = global.fetch
    const signInFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: 'b-token',
        refreshToken: 'b-refresh-token',
        expiresIn: '3600',
        localId: 'user-b',
        email: 'b@example.com'
      })
    })
    global.fetch = signInFetch as any

    try {
      const signOut = service.signOut()

      // Reservation and pending marker are established synchronously before
      // the non-interactive Chrome lookup returns.
      expect(service.getAuthGeneration()).toBe(generationBeforeSignOut + 1)
      expect(finishNonInteractiveLookup).toBeDefined()

      const signIn = service.signInWithGoogle()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(interactiveLookupCount).toBe(0)
      expect(signInFetch).not.toHaveBeenCalled()
      expect(service.getCurrentUser()?.uid).toBe('user-a')

      finishNonInteractiveLookup?.()
      await signOut
      expect((await signIn).uid).toBe('user-b')
      expect(interactiveLookupCount).toBe(1)
      expect(signInFetch).toHaveBeenCalledTimes(1)
      expect(service.getCurrentUser()?.uid).toBe('user-b')
    } finally {
      global.fetch = originalFetch
    }
  })

  test('lets a newer sign-in publish after an older pending sign-out finishes instead of clobbering it', async () => {
    const storedState = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: storedState })

    const service = new FirebaseAuthService()
    await service.ready()

    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((options: { interactive?: boolean }, callback: (result?: { token: string }) => void) => {
      callback(options.interactive ? { token: 'new-chrome-token' } : undefined)
    }) as typeof chrome.identity.getAuthToken)

    const originalRemove = (chrome.storage.local.remove as jest.Mock).getMockImplementation()!
    let removeStarted = false
    let releaseRemove: (() => void) | undefined
    const removeSpy = jest.spyOn(chrome.storage.local, 'remove').mockImplementation(async (keys: string | string[]) => {
      removeStarted = true
      await new Promise<void>(resolve => { releaseRemove = resolve })
      return originalRemove(keys)
    })

    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: 'b-token',
        refreshToken: 'b-refresh-token',
        expiresIn: '3600',
        localId: 'user-b',
        email: 'b@example.com'
      })
    }) as any

    try {
      const signOut = service.signOut()
      while (!removeStarted) await Promise.resolve()

      // A duplicate popup/message request must join the existing destructive
      // operation rather than queue a second auth-state removal behind it.
      const duplicateSignOut = service.signOut()

      // The newer sign-in may complete its network exchange, but must wait
      // behind the older durable removal before publishing or persisting B.
      const signIn = service.signInWithGoogle()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(service.getCurrentUser()?.uid).toBe('user-a')

      releaseRemove?.()
      await signOut
      await duplicateSignOut
      const userB = await signIn

      expect(removeSpy).toHaveBeenCalledTimes(1)
      expect(userB.uid).toBe('user-b')
      expect(service.getCurrentUser()?.uid).toBe('user-b')

      const restartedService = new FirebaseAuthService()
      await restartedService.ready()
      expect(restartedService.getCurrentUser()?.uid).toBe('user-b')
    } finally {
      global.fetch = originalFetch
    }
  })

  test('keeps a newer sign-in blocked through external token revocation side effects', async () => {
    const storedState = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: storedState })

    const service = new FirebaseAuthService()
    await service.ready()

    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((options: { interactive?: boolean }, callback: (result?: { token: string }) => void) => {
      callback({ token: options.interactive ? 'new-chrome-token' : 'old-chrome-token' })
    }) as typeof chrome.identity.getAuthToken)
    const originalRemoveCachedAuthToken = chrome.identity.removeCachedAuthToken
    ;(chrome.identity as any).removeCachedAuthToken = jest.fn(((_details: unknown, callback?: () => void) => {
      callback?.()
    }) as any)

    let revokeStarted = false
    let releaseRevoke: (() => void) | undefined
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockImplementation((input: string) => {
      if (input.includes('accounts.google.com/o/oauth2/revoke')) {
        revokeStarted = true
        return new Promise(resolve => {
          releaseRevoke = () => resolve({ ok: true })
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          idToken: 'b-token',
          refreshToken: 'b-refresh-token',
          expiresIn: '3600',
          localId: 'user-b',
          email: 'b@example.com'
        })
      })
    }) as any

    try {
      const signOut = service.signOut()
      while (!revokeStarted) await Promise.resolve()
      expect(service.getCurrentUser()).toBeNull()

      const signIn = service.signInWithGoogle()
      await new Promise(resolve => setTimeout(resolve, 0))
      // The Firebase exchange may finish, but B is not published until the
      // older sign-out's revoke request has also settled.
      expect(service.getCurrentUser()).toBeNull()

      releaseRevoke?.()
      await signOut
      expect((await signIn).uid).toBe('user-b')
      expect(service.getCurrentUser()?.uid).toBe('user-b')
    } finally {
      global.fetch = originalFetch
      if (originalRemoveCachedAuthToken) {
        ;(chrome.identity as any).removeCachedAuthToken = originalRemoveCachedAuthToken
      } else {
        delete (chrome.identity as Partial<typeof chrome.identity>).removeCachedAuthToken
      }
    }
  })

  test('releases sign-in after a stalled Google revoke request times out', async () => {
    jest.useFakeTimers()
    const storedState = {
      uid: 'user-a',
      email: 'a@example.com',
      displayName: null,
      photoURL: null,
      idToken: 'a-token',
      refreshToken: 'a-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000
    }
    await chrome.storage.local.set({ firebaseRestAuthState: storedState })

    const service = new FirebaseAuthService()
    await service.ready()

    let interactiveLookupCount = 0
    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((options: { interactive?: boolean }, callback: (result?: { token: string }) => void) => {
      if (options.interactive) interactiveLookupCount++
      callback({ token: options.interactive ? 'new-chrome-token' : 'old-chrome-token' })
    }) as typeof chrome.identity.getAuthToken)
    const originalRemoveCachedAuthToken = chrome.identity.removeCachedAuthToken
    ;(chrome.identity as any).removeCachedAuthToken = jest.fn(((_details: unknown, callback?: () => void) => {
      callback?.()
    }) as any)

    let revokeStarted = false
    const originalFetch = global.fetch
    global.fetch = jest.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input.includes('accounts.google.com/o/oauth2/revoke')) {
        revokeStarted = true
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          idToken: 'b-token',
          refreshToken: 'b-refresh-token',
          expiresIn: '3600',
          localId: 'user-b',
          email: 'b@example.com'
        })
      })
    }) as any

    try {
      const signOut = service.signOut()
      while (!revokeStarted) await Promise.resolve()

      const signIn = service.signInWithGoogle()
      await Promise.resolve()
      expect(interactiveLookupCount).toBe(0)

      await jest.advanceTimersByTimeAsync(30_000)
      await signOut
      expect((await signIn).uid).toBe('user-b')
      expect(interactiveLookupCount).toBe(1)
      expect(service.getCurrentUser()?.uid).toBe('user-b')
    } finally {
      jest.useRealTimers()
      global.fetch = originalFetch
      if (originalRemoveCachedAuthToken) {
        ;(chrome.identity as any).removeCachedAuthToken = originalRemoveCachedAuthToken
      } else {
        delete (chrome.identity as Partial<typeof chrome.identity>).removeCachedAuthToken
      }
    }
  })
})
