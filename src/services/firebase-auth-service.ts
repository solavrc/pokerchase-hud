/**
 * Firebase Authentication Service for Chrome Extension
 * Uses chrome.identity API for Google Sign-In
 */

import { 
  GoogleAuthProvider, 
  User, 
  signInWithCredential,
  signOut as firebaseSignOut,
  onAuthStateChanged
} from 'firebase/auth'
import { auth } from './firebase-config'

export class FirebaseAuthService {
  private currentUser: User | null = null
  private authStateListeners: ((user: User | null) => void)[] = []

  constructor() {
    // Listen to auth state changes
    onAuthStateChanged(auth, (user) => {
      this.currentUser = user
      this.notifyAuthStateListeners(user)
    })
  }

  /**
   * Sign in with Google using chrome.identity API
   */
  async signInWithGoogle(): Promise<User> {
    return new Promise((resolve, reject) => {
      // Get OAuth2 token using chrome.identity
      chrome.identity.getAuthToken({ interactive: true }, async (token) => {
        if (chrome.runtime.lastError || !token) {
          console.error('[FirebaseAuth] Chrome identity error:', chrome.runtime.lastError)
          reject(new Error(chrome.runtime.lastError?.message || 'Failed to get auth token'))
          return
        }

        console.log('[FirebaseAuth] Got Chrome auth token')

        try {
          // Get user info from Google API
          const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: { Authorization: `Bearer ${token}` }
          })
          const userInfo = await response.json()
          console.log('[FirebaseAuth] User info:', userInfo)

          // Create credential from the token
          const credential = GoogleAuthProvider.credential(null, token)
          
          // Sign in to Firebase
          const result = await signInWithCredential(auth, credential)
          console.log('[FirebaseAuth] Firebase sign in successful:', result.user.email)
          resolve(result.user)
        } catch (error) {
          console.error('[FirebaseAuth] Firebase sign in error:', error)
          reject(error)
        }
      })
    })
  }

  /**
   * Sign out from Firebase and revoke Chrome identity token
   */
  async signOut(): Promise<void> {
    // Sign out from Firebase
    await firebaseSignOut(auth)
    
    // Revoke the Chrome identity token
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (token) {
          chrome.identity.removeCachedAuthToken({ token }, () => {
            // Revoke the token on Google's servers
            fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
              .then(() => resolve())
              .catch(reject)
          })
        } else {
          resolve()
        }
      })
    })
  }

  /**
   * Get the current user
   */
  getCurrentUser(): User | null {
    return this.currentUser
  }

  /**
   * Check if user is signed in
   */
  isSignedIn(): boolean {
    return this.currentUser !== null
  }

  /**
   * Add auth state listener
   */
  onAuthStateChange(callback: (user: User | null) => void): () => void {
    this.authStateListeners.push(callback)
    
    // Call immediately with current state
    callback(this.currentUser)
    
    // Return unsubscribe function
    return () => {
      const index = this.authStateListeners.indexOf(callback)
      if (index > -1) {
        this.authStateListeners.splice(index, 1)
      }
    }
  }

  /**
   * Notify all auth state listeners
   */
  private notifyAuthStateListeners(user: User | null): void {
    this.authStateListeners.forEach(listener => listener(user))
  }

  /**
   * Get user display info
   */
  getUserInfo(): { email: string | null, displayName: string | null, photoURL: string | null, uid: string } | null {
    if (!this.currentUser) {
      return null
    }

    return {
      email: this.currentUser.email,
      displayName: this.currentUser.displayName,
      photoURL: this.currentUser.photoURL,
      uid: this.currentUser.uid
    }
  }
}

// Export singleton instance
export const firebaseAuthService = new FirebaseAuthService()