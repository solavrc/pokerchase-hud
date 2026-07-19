import React from 'react'
import { createRoot } from 'react-dom/client'
import Popup, { type PopupProps } from './components/Popup'
import { loadPopupThemeMode } from './components/popup/popup-theme-storage'

// Resolve the persisted popupTheme mode *before* the first render() call so
// the popup never paints with the wrong theme and then swaps
// (flash-of-wrong-theme). chrome.storage.sync reads are served from a local
// cache and resolve well before anything would otherwise have painted,
// since nothing is rendered yet at this point.
loadPopupThemeMode().then((initialPopupThemeMode) => {
  const root = createRoot(document.getElementById('popup-root')!)
  root.render(React.createElement<PopupProps>(Popup, { initialPopupThemeMode }))
})
