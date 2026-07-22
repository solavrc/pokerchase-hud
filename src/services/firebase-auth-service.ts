/**
 * Firebase Authentication Service for Chrome Extension.
 *
 * Uses chrome.identity for Google OAuth and Firebase Auth REST endpoints for
 * Firebase ID tokens. Keeping the Firebase Auth SDK out of the extension
 * bundle avoids MV3 remote-code scanner matches for gapi/reCAPTCHA loaders.
 */

import { firebaseConfig } from './firebase-config'

export interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  getIdToken: (forceRefresh?: boolean) => Promise<string>
}

/**
 * Why a given auth-state change is being announced to `onAuthStateChange`
 * listeners: `'restore'` (Service Worker startup -- both the one-time
 * `restoreAuthState()` broadcast and the synthesized "here's the current
 * state" call a newly-registered listener gets), `'sign-in'`
 * (`signInWithGoogle()`), or `'sign-out'` (`signOut()`).
 *
 * Exists so a listener can distinguish an INTERACTIVE sign-in from other
 * kinds of transitions without guessing from timing alone (codex post-merge
 * review on this PR, P2, "Avoid double auto-sync initialization on popup
 * sign-in"): `signInWithGoogle()`'s only caller,
 * `background/message-router.ts`'s `handleFirebaseSignIn`, already
 * explicitly awaits `autoSyncService.onAuthStateChanged(user)` (which calls
 * `initialize()`) immediately after `signInWithGoogle()` resolves -- and
 * `signInWithGoogle()` notifies listeners SYNCHRONOUSLY, well before that.
 * A listener that reacted to every signed-in transition uniformly (e.g.
 * `background.ts`'s auth-cache listener, see
 * `src/background/auto-sync-boot.ts`'s `createSignInTransitionHandler()`)
 * would therefore call `initialize()` a SECOND time for the exact same
 * sign-in, racing the explicit call: `AutoSyncService.initialize()`'s own
 * bookkeeping (scoped `lastSyncTime` read/migrate/write) isn't guarded by
 * its `_isSyncing` latch until `performSync()` itself starts, so two
 * overlapping first-time `initialize()` calls can each read a stale
 * snapshot and clobber the timestamp the other just wrote, forcing a
 * duplicate initial cloud sync. Tagging the source lets such a listener
 * skip `'sign-in'`-sourced transitions specifically, since that path always
 * has its own explicit caller.
 */
export type AuthChangeSource = 'restore' | 'sign-in' | 'sign-out'

interface StoredAuthState {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  idToken: string
  refreshToken: string
  expiresAt: number
}

interface FirebaseSignInResponse {
  idToken: string
  refreshToken: string
  expiresIn: string
  localId: string
  email?: string
  displayName?: string
  photoUrl?: string
}

interface FirebaseRefreshResponse {
  id_token: string
  refresh_token: string
  expires_in: string
  user_id: string
}

export class FirebaseAuthService {
  private static readonly STORAGE_KEY = 'firebaseRestAuthState'
  private currentState: StoredAuthState | null = null
  private authStateListeners: ((user: AuthUser | null, source: AuthChangeSource) => void)[] = []
  private restorePromise: Promise<void>
  /**
   * Sign-out operation currently owning every local and external side effect.
   * New token work must not start while this exists, a concurrent sign-in
   * waits for `completion` (which always resolves), and duplicate sign-outs
   * join `operation` so they observe the original success/failure instead of
   * starting a second destructive removal.
   */
  private pendingSignOut: { operation: Promise<void>, completion: Promise<void> } | null = null
  /**
   * Monotonic counter, incremented on every auth-state TRANSITION (sign-in,
   * sign-out, or the initial restore-from-storage on startup). Sign-out uses
   * two increments: one reservation before its durable storage commit, then
   * one when `null` is actually published. This invalidates work started
   * both before and during a slow removal; if removal fails, only the
   * reservation remains. Never decremented, and never bumped by a
   * same-account token refresh (`getIdToken(forceRefresh)`'s `currentState`
   * reassignment preserves the same `uid`).
   *
   * WHY (codex post-merge review on #192, r3615389112, P1, "Detect ABA
   * account switches before committing bookkeeping"): callers used to
   * compare a snapshotted uid string against `getCurrentUser()?.uid` to
   * detect a mid-pass account switch. That is blind to an A -> B -> A
   * round trip: by the time the check runs, the live uid is back to "A",
   * string-equal to the snapshot, even though a DIFFERENT account (B) was
   * live in between and may have driven whatever cloud read/write the
   * check was meant to guard. This counter can't be fooled by a value
   * cycling back -- an A -> B -> A round trip still advances it by (at
   * least) 2, so a caller comparing the snapshotted GENERATION (not the
   * uid) correctly detects that *something* changed in between, regardless
   * of whether the uid happens to match again afterward.
   */
  private authGeneration = 0

  constructor() {
    this.restorePromise = this.restoreAuthState()
  }

  /**
   * Current auth-state generation. See `authGeneration`'s doc comment.
   * Callers that need to detect a mid-operation account switch (including
   * an A -> B -> A round trip) should snapshot this alongside
   * `getCurrentUser()?.uid` at the start of the operation and compare
   * generations (not uid strings) before any consequential commit.
   */
  getAuthGeneration(): number {
    return this.authGeneration
  }

  async ready(): Promise<void> {
    await this.restorePromise
  }

  /**
   * Sign in with Google using chrome.identity API.
   */
  async signInWithGoogle(): Promise<AuthUser> {
    const token = await this.getChromeAuthToken(true)
    console.log('[FirebaseAuth] Got Chrome auth token')

    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${firebaseConfig.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            postBody: `access_token=${encodeURIComponent(token)}&providerId=google.com`,
            requestUri: `https://${chrome.runtime.id}.chromiumapp.org/`,
            returnIdpCredential: false,
            returnSecureToken: true
          })
        }
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Firebase sign-in failed: ${response.status} ${errorText}`)
      }

      const result = await response.json() as FirebaseSignInResponse
      // A sign-out that started while the Google/Firebase network exchange
      // above was in flight owns the durable auth-storage commit. Publish and
      // persist this newer sign-in only AFTER that older removal settles, so
      // the sign-out cannot delete or overwrite the newly authenticated
      // account when it resumes.
      await this.waitForPendingSignOut()
      this.currentState = {
        uid: result.localId,
        email: result.email ?? null,
        displayName: result.displayName ?? null,
        photoURL: result.photoUrl ?? null,
        idToken: result.idToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + Number(result.expiresIn) * 1000
      }
      this.authGeneration++ // sign-in transition -- see authGeneration's doc comment
      // Notify listeners SYNCHRONOUSLY, in the same step as the currentState/
      // authGeneration mutation above -- BEFORE the persistAuthState() await
      // (codex review r3615952256, P2, "Clear stale sync state when
      // exposing the new user"). Moving this earlier closes the window
      // where getCurrentUser()/getAuthGeneration() already report the NEW
      // account but registered listeners (e.g. AutoSyncService clearing its
      // own stale in-memory state, see its constructor) hadn't been told
      // yet -- during a direct A->B sign-in, anything reading auth state in
      // that gap used to see B live while dependent state still reflected
      // A. persistAuthState() below is a fire-and-forget durability step
      // from listeners' perspective; it doesn't need to precede them.
      this.notifyAuthStateListeners(this.getCurrentUser(), 'sign-in')
      await this.persistAuthState()
      console.log('[FirebaseAuth] Firebase sign in successful:', this.currentState.email)
      return this.getCurrentUser()!
    } catch (error) {
      console.error('[FirebaseAuth] Firebase sign in error:', error)
      throw error
    }
  }

  /**
   * Sign out from Firebase and revoke Chrome identity token.
   */
  async signOut(): Promise<void> {
    // Coalesce duplicate requests with the operation already in progress.
    // In particular, never let a second sign-out queue behind the first and
    // then erase a newer sign-in that was waiting on the same completion.
    const existingSignOut = this.pendingSignOut
    if (existingSignOut) {
      await existingSignOut.operation
      return
    }

    // performSignOut() runs synchronously through its generation reservation
    // and first token lookup before returning this promise. The marker is
    // therefore installed before signOut() yields to any later sign-in.
    const operation = this.performSignOut()
    const pendingSignOut = {
      operation,
      // Sign-in should be released after a failed sign-out too: the old
      // account remains intact and the newer successful sign-in may replace
      // it. Duplicate sign-out callers use `operation` above and still see
      // the real failure.
      completion: operation.then(() => {}, () => {})
    }
    this.pendingSignOut = pendingSignOut

    try {
      await operation
    } finally {
      if (this.pendingSignOut === pendingSignOut) this.pendingSignOut = null
    }
  }

  private async performSignOut(): Promise<void> {
    // Reserve the sign-out generation BEFORE the durable storage commit.
    // This is also before the first await (the Chrome token lookup), so a
    // sign-in started while that lookup is slow must wait for this operation.
    this.authGeneration++

    const previousToken = await this.getChromeAuthToken(false).catch(() => null)
    await chrome.storage.local.remove(FirebaseAuthService.STORAGE_KEY)

    // Publish only after the durable removal commits. Keep currentState intact
    // on failure so logout cannot reverse after a Service Worker restart.
    this.currentState = null
    this.authGeneration++
    this.notifyAuthStateListeners(null, 'sign-out')

    if (previousToken) {
      await new Promise<void>((resolve) => {
        chrome.identity.removeCachedAuthToken({ token: previousToken }, () => resolve())
      })
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${previousToken}`).catch(() => {})
    }
  }

  /**
   * Get the current user.
   */
  getCurrentUser(): AuthUser | null {
    if (!this.currentState) {
      return null
    }

    return {
      uid: this.currentState.uid,
      email: this.currentState.email,
      displayName: this.currentState.displayName,
      photoURL: this.currentState.photoURL,
      getIdToken: (forceRefresh = false) => this.getIdToken(forceRefresh)
    }
  }

  /**
   * Get a valid Firebase ID token for REST API requests.
   */
  async getIdToken(forceRefresh = false): Promise<string> {
    await this.ready()
    // A captured AuthUser object can outlive the moment sign-out starts, so
    // checking only getCurrentUser() at the Firestore call site is not
    // sufficient. Fail before using or refreshing any token while the
    // durable removal is pending; callers surface/retry this like any other
    // auth failure.
    if (this.pendingSignOut) {
      throw new Error('Sign-out is in progress')
    }
    if (!this.currentState) {
      throw new Error('User not authenticated')
    }

    if (!forceRefresh && this.currentState.expiresAt - Date.now() > 5 * 60 * 1000) {
      return this.currentState.idToken
    }

    // Snapshot which identity this refresh is FOR, before the network await
    // (codex review r3616116753, P1, "Count stale refreshes as auth
    // transitions"): if the user signs into a DIFFERENT account while this
    // refresh is in flight, applying the response back into the shared
    // `currentState` unconditionally would silently corrupt it -- spreading
    // the NEW account's other fields (`...this.currentState`, which by then
    // already reflects the NEW account) together with the OLD account's
    // refreshed uid/token/refreshToken, resurrecting the OLD uid into
    // `currentState.uid` (and therefore `getCurrentUser()`).
    //
    // A bare uid snapshot is not enough on its own, though (independent
    // release-audit finding, "getIdToken's refresh path still has an
    // A->B->A ABA hole"): sign out A, sign in B, then back to A -- all while
    // THIS refresh (started for A) is still in flight -- and the live uid by
    // the time the response arrives is "user-a" again, string-equal to
    // `refreshingUid` below, even though a DIFFERENT account (B) was live in
    // between and A's *current* session (a fresh sign-in, not the same one
    // that started this refresh) has its own idToken/refreshToken already.
    // Applying the stale response would silently overwrite that fresh A
    // session's tokens with the old, discarded ones. `authGeneration` is
    // bumped on every auth-state TRANSITION (sign-in, sign-out, restore --
    // see its doc comment) and can't be fooled by a value cycling back: an
    // A->B->A round trip still advances it by (at least) 2. Snapshotting it
    // here alongside the uid and requiring BOTH to still match before
    // committing closes the hole a uid-only check leaves open.
    const refreshingUid = this.currentState.uid
    const refreshingGeneration = this.authGeneration
    const refreshToken = this.currentState.refreshToken

    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }).toString()
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Firebase token refresh failed: ${response.status} ${errorText}`)
    }

    const result = await response.json() as FirebaseRefreshResponse

    // Discard a stale refresh response: EITHER the account live NOW is not
    // the one this refresh was requested for (uid mismatch), OR the uid
    // happens to match again but a DIFFERENT account was live in between
    // (generation mismatch -- the A->B->A case the uid check alone misses,
    // see the comment above `refreshingGeneration`). Still return the
    // freshly-fetched token to THIS caller -- whatever in-flight operation
    // asked for it (e.g. a Firestore call already under way for the OLD
    // account) can still complete using a valid, unexpired token for the
    // account it actually started with -- but do NOT let it become the new
    // shared `currentState`, and do NOT persist it.
    if (this.currentState?.uid !== refreshingUid || this.authGeneration !== refreshingGeneration) {
      console.warn('[FirebaseAuth] Discarding a token refresh for a no-longer-current account/generation (the signed-in account changed while the refresh was in flight)')
      return result.id_token
    }

    this.currentState = {
      ...this.currentState,
      uid: result.user_id,
      idToken: result.id_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + Number(result.expires_in) * 1000
    }
    await this.persistAuthState()
    return this.currentState.idToken
  }

  /**
   * Check if user is signed in.
   */
  isSignedIn(): boolean {
    return this.currentState !== null
  }

  /**
   * Add auth state listener. The callback also receives the `source` of the
   * change (see `AuthChangeSource`'s doc comment) -- the initial "here's the
   * current state" call every newly-registered listener gets (once `ready()`
   * resolves) is tagged `'restore'`, same as the one-time
   * `restoreAuthState()` broadcast, since both represent "the currently
   * known state as of the last restore/transition," not a fresh sign-in.
   */
  onAuthStateChange(callback: (user: AuthUser | null, source: AuthChangeSource) => void): () => void {
    this.authStateListeners.push(callback)
    this.ready().then(() => callback(this.getCurrentUser(), 'restore')).catch(() => callback(null, 'restore'))

    return () => {
      const index = this.authStateListeners.indexOf(callback)
      if (index > -1) {
        this.authStateListeners.splice(index, 1)
      }
    }
  }

  /**
   * Get user display info.
   */
  getUserInfo(): { email: string | null, displayName: string | null, photoURL: string | null, uid: string } | null {
    const user = this.getCurrentUser()
    if (!user) {
      return null
    }

    return {
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      uid: user.uid
    }
  }

  private async getChromeAuthToken(interactive: boolean): Promise<string> {
    return await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (result) => {
        const token = typeof result === 'string' ? result : result?.token
        if (chrome.runtime.lastError || !token) {
          reject(new Error(chrome.runtime.lastError?.message || 'Failed to get auth token'))
          return
        }
        resolve(token)
      })
    })
  }

  private async restoreAuthState(): Promise<void> {
    const stored = await chrome.storage.local.get(FirebaseAuthService.STORAGE_KEY) as Record<string, StoredAuthState | undefined>
    this.currentState = stored[FirebaseAuthService.STORAGE_KEY] ?? null
    // Initial-restore transition -- see authGeneration's doc comment. Every
    // Service Worker (re)start is a fresh generation baseline, even when it
    // restores the SAME account: a sync pass whose in-memory snapshot was
    // taken before an SW restart is not meaningfully "the same pass"
    // afterward regardless of whether the restored uid matches.
    this.authGeneration++
    this.notifyAuthStateListeners(this.getCurrentUser(), 'restore')
  }

  private async persistAuthState(): Promise<void> {
    if (this.currentState) {
      await chrome.storage.local.set({ [FirebaseAuthService.STORAGE_KEY]: this.currentState })
    }
  }

  /** Wait until the current sign-out and all of its side effects settle. */
  private async waitForPendingSignOut(): Promise<void> {
    while (this.pendingSignOut) {
      await this.pendingSignOut.completion
    }
  }

  private notifyAuthStateListeners(user: AuthUser | null, source: AuthChangeSource): void {
    this.authStateListeners.forEach(listener => listener(user, source))
  }
}

export const firebaseAuthService = new FirebaseAuthService()
