/**
 * Regression test for codex's post-merge review on PR #198 (P2, "Avoid
 * double auto-sync initialization on popup sign-in"):
 *
 * `firebaseAuthService.signInWithGoogle()` notifies `onAuthStateChange`
 * listeners SYNCHRONOUSLY, before its own `persistAuthState()` await (see
 * that method's doc comment). Its only caller,
 * `background/message-router.ts`'s `handleFirebaseSignIn`, explicitly
 * awaits `autoSyncService.onAuthStateChanged(user)` (which calls
 * `initialize()`) right after `signInWithGoogle()` itself resolves.
 *
 * `background.ts`'s auth-cache listener also observes every auth-state
 * change via the same `onAuthStateChange` mechanism. Before this fix, its
 * sign-in-transition backstop (`createSignInTransitionHandler()`) called
 * `autoSyncService.initialize()` on ANY signed-out -> signed-in transition,
 * including one sourced from `signInWithGoogle()` -- so a popup-driven sign
 * in produced TWO overlapping `initialize()` calls: one fired synchronously
 * from inside `signInWithGoogle()` itself (via this listener), and one from
 * message-router.ts's own explicit call shortly after. Both call sites
 * intended for `initialize()` to be the FIRST invocation for that account,
 * so racing them could each read a stale bookkeeping snapshot and clobber
 * the timestamp the other had just written, forcing a duplicate initial
 * cloud sync.
 *
 * This test wires up the real `FirebaseAuthService` (to get the actual
 * synchronous-notify-before-persist timing) with background.ts's real
 * listener shape, then drives an interactive sign-in exactly the way
 * message-router.ts does, and asserts `initialize()` is called exactly
 * once overall.
 */
import { FirebaseAuthService } from '../services/firebase-auth-service'
import { createSignInTransitionHandler } from './auto-sync-boot'

describe('popup sign-in path does not double-initialize auto sync', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('signInWithGoogle() followed by message-router.ts\'s own explicit initialize() call results in exactly one initialize() call, even with background.ts\'s sign-in-transition listener also wired up', async () => {
    const authService = new FirebaseAuthService()
    await authService.ready() // no stored state -> starts signed out

    const initialize = jest.fn().mockResolvedValue(undefined)
    const onError = jest.fn()

    // Mirrors background.ts's real wiring: the sign-in-transition backstop,
    // registered on the SAME onAuthStateChange listener used for the popup
    // auth cache.
    const handleAuthSignInTransition = createSignInTransitionHandler({ initialize }, onError)
    authService.onAuthStateChange((user, source) => {
      handleAuthSignInTransition(user, source)
    })

    jest.spyOn(chrome.identity, 'getAuthToken').mockImplementation(((_opts: unknown, callback: (result: { token: string }) => void) => {
      callback({ token: 'chrome-token' })
    }) as typeof chrome.identity.getAuthToken)

    const originalFetch = global.fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        idToken: 'id-token',
        refreshToken: 'refresh-token',
        expiresIn: '3600',
        localId: 'user-a',
        email: 'a@example.com'
      })
    }) as any

    // Mirrors background/message-router.ts's handleFirebaseSignIn exactly:
    // sign in interactively, then explicitly initialize auto sync.
    const user = await authService.signInWithGoogle()
    global.fetch = originalFetch
    expect(user.uid).toBe('user-a')

    // message-router.ts's own explicit call
    // (autoSyncService.onAuthStateChanged(user) -> initialize() for a
    // present user).
    await initialize()

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})
