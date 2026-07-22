import type { UIConfig } from '../../types/hand-log'

const GAME_URL_PATTERN = 'https://game.poker-chase.com/*'

export const broadcastUIConfig = (config: UIConfig): void => {
  chrome.tabs.query({ url: GAME_URL_PATTERN }, (tabs) => {
    tabs.forEach(tab => {
      if (!tab.id) return

      chrome.tabs.sendMessage(tab.id, {
        action: 'updateUIConfig',
        config,
      }).catch(error => {
        // A matching game tab can still lose its content script while
        // navigating or reloading. The persisted config will be loaded when
        // the receiver returns, so this one-shot delivery is best-effort.
        if (!(error instanceof Error) || !error.message.includes('Receiving end does not exist')) {
          console.warn(`[popup] Failed to update UI config in tab ${tab.id}:`, error)
        }
      })
    })
  })
}
