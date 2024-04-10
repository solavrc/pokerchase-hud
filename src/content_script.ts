/**
 * content script: DOM にアクセスできる
 * @see https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts?hl=ja
 * @see https://developer.mozilla.org/ja/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
 */
import { ApiResponse } from './app'
import { origin } from './background'
import { renderApp } from './components/App'
import { renderOptions } from './components/Popup'
import { web_accessible_resources } from '../manifest.json'

/** WebSocket 由来のハンドデータを Service Worker に渡す */
window.addEventListener('message', (event: MessageEvent<ApiResponse>) => {
  /** @see https://developer.mozilla.org/ja/docs/Web/API/Window/postMessage#%E3%82%BB%E3%82%AD%E3%83%A5%E3%83%AA%E3%83%86%E3%82%A3%E3%81%AE%E8%80%83%E6%85%AE%E4%BA%8B%E9%A0%85 */
  if (event.source === window && event.origin === origin && event.data.ApiTypeId)
    chrome.runtime.sendMessage(event.data) /** to `service_worker` */
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
const [popupRootId, overlayRootId] = ['popup-root', 'overlay-root']
if (document.getElementById(popupRootId)) {
  renderOptions(document.getElementById(popupRootId)!)
} else if (!document.getElementById(overlayRootId)) {
  const overlayRoot = document.createElement('div')
  overlayRoot.setAttribute('id', overlayRootId)
  document.body.appendChild(overlayRoot)
  renderApp(overlayRoot)
}
