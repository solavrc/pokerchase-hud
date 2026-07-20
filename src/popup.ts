import React from 'react'
import { createRoot } from 'react-dom/client'
import Popup, { type PopupProps } from './components/Popup'
import { loadCachedPopupThemeMode } from './components/popup/popup-theme-storage'

// Render synchronously from the local theme mirror. Waiting for
// chrome.storage.sync here used to put an unbounded async callback directly
// on the extension-icon-click -> first-content critical path. Popup reconciles
// this startup hint with the authoritative sync value after mount.
const initialPopupThemeMode = loadCachedPopupThemeMode()
const root = createRoot(document.getElementById('popup-root')!)
root.render(React.createElement<PopupProps>(Popup, { initialPopupThemeMode }))
