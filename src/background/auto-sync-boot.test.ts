/**
 * background.ts's cold-start auth-restore wiring (independent release-audit
 * finding, "cold-start auth-restore race loses the initial sync"):
 *
 * `firebaseAuthService`'s auth-state restore is independent of
 * `service.ready` (IndexedDB init) -- there is no ordering guarantee between
 * the two. Reading `getCurrentUser()` before the restore resolves can see
 * "signed out" for an already-signed-in user, silently skipping
 * `autoSyncService.initialize()`'s initial sync for the rest of this Service
 * Worker's lifetime.
 */
import { initializeAutoSyncOnReady, createSignInTransitionHandler } from './auto-sync-boot'

describe('initializeAutoSyncOnReady', () => {
  test('awaits authService.ready() before reading getCurrentUser(), so a signed-in user still gets initialize() called exactly once even when the caller starts before auth restore resolves (the audit\'s exact race)', async () => {
    let resolveAuthReady: () => void = () => {}
    const authReadyPromise = new Promise<void>(resolve => { resolveAuthReady = resolve })
    let restoreCompleted = false

    const authService = {
      ready: jest.fn(() => authReadyPromise.then(() => { restoreCompleted = true })),
      // If initializeAutoSyncOnReady ever read this BEFORE awaiting ready()
      // (the bug), this would return null here since restoreCompleted is
      // still false at that point -- exactly reproducing "an already
      // signed-in user looks signed out because IndexedDB init won the
      // race".
      getCurrentUser: jest.fn(() => (restoreCompleted ? { uid: 'user-a' } : null))
    }
    const initialize = jest.fn().mockResolvedValue(undefined)
    const syncService = { initialize }

    const donePromise = initializeAutoSyncOnReady(authService, syncService)

    // Let the race play out for a few microtask hops -- long enough that a
    // version reading getCurrentUser() synchronously (without awaiting
    // ready()) would already have called it and observed "signed out".
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(initialize).not.toHaveBeenCalled()
    expect(authService.getCurrentUser).not.toHaveBeenCalled()

    // Auth restore resolves -- service.ready effectively "won" the race in
    // this scenario (the auth-restore promise hadn't settled while the
    // caller was already running).
    resolveAuthReady()
    await donePromise

    expect(authService.getCurrentUser).toHaveBeenCalledTimes(1)
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  test('does not call initialize() when no user is signed in after restore', async () => {
    const authService = {
      ready: jest.fn().mockResolvedValue(undefined),
      getCurrentUser: jest.fn().mockReturnValue(null)
    }
    const initialize = jest.fn().mockResolvedValue(undefined)

    await initializeAutoSyncOnReady(authService, { initialize })

    expect(initialize).not.toHaveBeenCalled()
  })
})

describe('createSignInTransitionHandler', () => {
  test('does NOT treat the first callback invocation as a transition (avoids double-invoking initialize() on top of initializeAutoSyncOnReady\'s cold-start call), but DOES fire on a later signed-out -> signed-in transition (source \'restore\'), and is idempotent on repeat', () => {
    const initialize = jest.fn().mockResolvedValue(undefined)
    const handler = createSignInTransitionHandler({ initialize })

    // First-ever callback: represents the initial post-restore notification
    // on Service Worker startup, which may already be "signed in". This must
    // NOT trigger initialize() here -- that case is already handled by
    // initializeAutoSyncOnReady() in background.ts's service.ready.then()
    // block.
    handler({ uid: 'user-a' }, 'restore')
    expect(initialize).not.toHaveBeenCalled()

    // Explicit sign-out.
    handler(null, 'sign-out')
    expect(initialize).not.toHaveBeenCalled()

    // A real transition: signed-out -> signed-in (not sourced from the
    // interactive popup sign-in flow).
    handler({ uid: 'user-a' }, 'restore')
    expect(initialize).toHaveBeenCalledTimes(1)

    // Idempotent: repeating the same signed-in state must not re-trigger.
    handler({ uid: 'user-a' }, 'restore')
    expect(initialize).toHaveBeenCalledTimes(1)

    // Sign out, then sign back in -- a genuinely new transition -- fires again.
    handler(null, 'sign-out')
    handler({ uid: 'user-a' }, 'restore')
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  // Independent release-audit follow-up: codex post-merge review on this PR,
  // P2, "Avoid double auto-sync initialization on popup sign-in".
  // firebaseAuthService.signInWithGoogle() (the ONLY thing that produces a
  // 'sign-in'-sourced transition) notifies onAuthStateChange listeners
  // SYNCHRONOUSLY, before its own persistAuthState() await -- well before
  // background/message-router.ts's handleFirebaseSignIn (its only caller)
  // gets to its own explicit `await autoSyncService.onAuthStateChanged(user)`
  // call. Firing initialize() here too used to race that explicit call:
  // AutoSyncService.initialize()'s bookkeeping isn't guarded by `_isSyncing`
  // until performSync() itself starts, so two overlapping first-time
  // initialize() calls could each read a stale snapshot and clobber the
  // timestamp the other just wrote, forcing a duplicate initial cloud sync.
  test('does NOT call initialize() on a \'sign-in\'-sourced transition, since that path (background/message-router.ts) always has its own explicit initialize() caller', () => {
    const initialize = jest.fn().mockResolvedValue(undefined)
    const handler = createSignInTransitionHandler({ initialize })

    handler(null, 'sign-out') // establish a signed-out baseline
    handler({ uid: 'user-a' }, 'sign-in') // the popup-driven interactive sign-in

    expect(initialize).not.toHaveBeenCalled()
  })

  test('routes a rejected initialize() to onError instead of throwing', async () => {
    const error = new Error('boom')
    const initialize = jest.fn().mockRejectedValue(error)
    const onError = jest.fn()
    const handler = createSignInTransitionHandler({ initialize }, onError)

    handler(null, 'sign-out') // establish a signed-out baseline
    expect(() => handler({ uid: 'user-a' }, 'restore')).not.toThrow() // triggers initialize()

    // Flush the rejected promise's microtask.
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(error)
  })

  test('defaults to a no-op error handler when onError is not provided', async () => {
    const initialize = jest.fn().mockRejectedValue(new Error('boom'))
    const handler = createSignInTransitionHandler({ initialize })

    handler(null, 'sign-out')
    handler({ uid: 'user-a' }, 'restore')

    await Promise.resolve()
    await Promise.resolve()
    // No assertion needed beyond "did not throw / did not reject unhandled" --
    // jest would surface an unhandled rejection as a test failure otherwise.
  })
})
