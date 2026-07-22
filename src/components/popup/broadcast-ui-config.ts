import type { UIConfig } from '../../types/hand-log'
import { content_scripts } from '../../../manifest.json'

const gameUrlPatterns = content_scripts[0]!.matches

const isExpectedOneWayDeliveryError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  return error.message.includes('Receiving end does not exist') ||
    error.message.includes('message port closed before a response was received')
}

export const broadcastUIConfig = (config: UIConfig): void => {
  chrome.tabs.query({ url: gameUrlPatterns }, (tabs) => {
    tabs.forEach(tab => {
      if (!tab.id) return

      chrome.tabs.sendMessage(tab.id, {
        action: 'updateUIConfig',
        config,
      }).catch(error => {
        // A matching game tab can still lose its content script while
        // navigating or reloading. The persisted config will be loaded when
        // the receiver returns, so this one-shot delivery is best-effort.
        if (!isExpectedOneWayDeliveryError(error)) {
          console.warn(`[popup] Failed to update UI config in tab ${tab.id}:`, error)
        }
      })
    })
  })
}
