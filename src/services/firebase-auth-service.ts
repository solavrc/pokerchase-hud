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
  private authStateListeners: ((user: AuthUser | null) => void)[] = []
  private restorePromise: Promise<void>
  /**
   * Monotonic counter, incremented on every auth-state TRANSITION (sign-in,
   * sign-out, or the initial restore-from-storage on startup) -- never on a
   * same-account token refresh (`getIdToken(forceRefresh)`'s `currentState`
   * reassignment preserves the same `uid`, so it does NOT bump this).
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
      await this.persistAuthState()
      this.notifyAuthStateListeners(this.getCurrentUser())
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
    const previousToken = await this.getChromeAuthToken(false).catch(() => null)
    this.currentState = null
    this.authGeneration++ // sign-out transition -- see authGeneration's doc comment
    await chrome.storage.local.remove(FirebaseAuthService.STORAGE_KEY)
    this.notifyAuthStateListeners(null)

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
    if (!this.currentState) {
      throw new Error('User not authenticated')
    }

    if (!forceRefresh && this.currentState.expiresAt - Date.now() > 5 * 60 * 1000) {
      return this.currentState.idToken
    }

    const response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.currentState.refreshToken
        }).toString()
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Firebase token refresh failed: ${response.status} ${errorText}`)
    }

    const result = await response.json() as FirebaseRefreshResponse
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
   * Add auth state listener.
   */
  onAuthStateChange(callback: (user: AuthUser | null) => void): () => void {
    this.authStateListeners.push(callback)
    this.ready().then(() => callback(this.getCurrentUser())).catch(() => callback(null))

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
    this.notifyAuthStateListeners(this.getCurrentUser())
  }

  private async persistAuthState(): Promise<void> {
    if (this.currentState) {
      await chrome.storage.local.set({ [FirebaseAuthService.STORAGE_KEY]: this.currentState })
    }
  }

  private notifyAuthStateListeners(user: AuthUser | null): void {
    this.authStateListeners.forEach(listener => listener(user))
  }
}

export const firebaseAuthService = new FirebaseAuthService()
