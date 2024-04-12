/**
 * content script: DOM にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
 */
import { ApiResponse, PokerChaseService } from './app'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { origin } from './background'
import { web_accessible_resources } from '../manifest.json'
import App from './components/App'
import Popup from './components/Popup'

const service = new PokerChaseService(window)
/** WebSocket 由来のハンドデータを Service Worker に渡す */
window.addEventListener('message', async (event: MessageEvent<ApiResponse>) => {
  /** @see https://developer.mozilla.org/ja/docs/Web/API/Window/postMessage#%E3%82%BB%E3%82%AD%E3%83%A5%E3%83%AA%E3%83%86%E3%82%A3%E3%81%AE%E8%80%83%E6%85%AE%E4%BA%8B%E9%A0%85 */
  if (event.source === window && event.origin === origin && event.data.ApiTypeId) {
    const message = await chrome.runtime.sendMessage<ApiResponse, ApiResponse>(event.data) /** to `service_worker` */
    service.eventHandler(message) /** to overlay `App.tsx` */
  }
})

/** WebSocket Hook 用 <script/> を DOM に注入する */
const injectScript = (file: string, node: string) => {
  const th = document.getElementsByTagName(node)[0]
  const s = document.createElement('script')
  s.setAttribute('type', 'text/javascript')
  s.setAttribute('src', file)
  th.appendChild(s)
}
injectScript(chrome.runtime.getURL(web_accessible_resources.at(0)?.resources.at(0)!), 'body')

/**
 * React DOM のエントリーポイントを作成する
 * @see ./index.html
 */
const unityContainer = document.querySelector('#unity-container')
if (unityContainer) {
  const appRoot = document.createElement('div')
  unityContainer.appendChild(appRoot)
  createRoot(appRoot).render(createElement(App))
}
const popupRoot = document.querySelector('#popup-root')
if (popupRoot) {
  createRoot(popupRoot).render(createElement(Popup))
}
