import React from 'react'
import { createRoot } from 'react-dom/client'
import Popup, { type PopupProps } from './components/Popup'
import { ImportPage } from './components/ImportPage'
import { isImportPageSearch } from './constants/import-page'
import { loadCachedPopupThemeMode } from './components/popup/popup-theme-storage'

// Render synchronously from the local theme mirror. Waiting for
// chrome.storage.sync here used to put an unbounded async callback directly
// on the extension-icon-click -> first-content critical path. Popup reconciles
// this startup hint with the authoritative sync value after mount.
const initialPopupThemeMode = loadCachedPopupThemeMode()
const isImportPage = isImportPageSearch(window.location.search)
if (isImportPage) {
  document.body.style.width = 'auto'
  document.body.style.minHeight = '100vh'
  document.title = 'PokerChase HUD - NDJSONインポート'
}
const root = createRoot(document.getElementById('popup-root')!)
root.render(
  isImportPage
    ? React.createElement(ImportPage, { initialPopupThemeMode })
    : React.createElement<PopupProps>(Popup, { initialPopupThemeMode })
)
