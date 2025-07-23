/**
 * Firebase configuration for PokerChase HUD
 *
 * Note: Replace these values with your actual Firebase project configuration
 * You can find these values in the Firebase Console:
 * Project Settings > General > Your apps > Web app
 */

import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getStorage } from 'firebase/storage'
import { getFirestore } from 'firebase/firestore'

// Firebase configuration object
const firebaseConfig = {
  apiKey: "AIzaSyDflMV4xVPhKxsN_k0daWFOsCLn3CEtDAs",
  authDomain: "pokerchase-hud.firebaseapp.com",
  projectId: "pokerchase-hud",
  storageBucket: "pokerchase-hud.firebasestorage.app",
  messagingSenderId: "412594878670",
  appId: "1:412594878670:web:9b6f891e7b7493dba5b89f"
}

// Initialize Firebase
const app = initializeApp(firebaseConfig)

// Initialize Firebase services
export const auth = getAuth(app)
export const storage = getStorage(app)
export const firestore = getFirestore(app)

// Export the app instance
export default app
