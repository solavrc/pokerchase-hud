/**
 * content_script.ts - リプレイ傍受スクリプト（replay_bridge.js）の条件付き注入
 *
 * リプレイの fetch / XMLHttpRequest 傍受は `replay_bridge.ts` に分離され、
 * `experimentalReplayImportEnabled` が有効なときにだけ WAR `<script>` として
 * 注入される。無効ユーザーの実行環境には傍受コードが一切載らない（fetch/XHR は
 * 素のまま）。ここではその注入ゲートを検証する:
 *
 *   - 無効時: WebSocket hook（web_accessible_resource.js）は常時注入されるが、
 *     replay_bridge.js は注入されない
 *   - 有効時: replay_bridge.js が注入される
 *   - `<script>` は取り消せないので、有効化が複数回起きても注入は1回きり（冪等）
 *
 * content_script.ts は import時の副作用として window/storage リスナー登録と
 * ポート接続、スクリプト注入を行う（初期化関数のexportは無い）ので、他の
 * content_script テストと同じく毎テスト fresh に require する。fresh import
 * ごとに storage.onChanged リスナーが積み上がるため、冪等テストでは `set()`
 * （全リスナーへ配送される）ではなく、その import が登録した固有のリスナーを
 * 直接呼んで隔離する。
 */
import { EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY } from './replay/protocol'

const WS_HOOK_FILE = 'web_accessible_resource.js'
const REPLAY_BRIDGE_FILE = 'replay_bridge.js'

const injectedScriptSrcs = (): string[] =>
  Array.from(document.querySelectorAll('script'), s => s.getAttribute('src') || '')

const countScriptsMatching = (needle: string): number =>
  injectedScriptSrcs().filter(src => src.includes(needle)).length

// storage.get().then() のマイクロタスクと script.load を跨ぐため、マクロタスク
// 境界まで送る。
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('content_script replay bridge conditional injection', () => {
  beforeEach(() => {
    jest.resetModules()
    // RuntimePortManager.connect() が import時に走るのでポートを与える。
    ;(chrome.runtime as any).connect = jest.fn(() => ({
      postMessage: jest.fn(),
      disconnect: jest.fn(),
      onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
      onDisconnect: { addListener: jest.fn(), removeListener: jest.fn() },
    }))
    // 前テストが注入した <script> を持ち越さない。
    document.body.innerHTML = ''
  })

  test('does not inject the replay bridge when the flag is disabled', async () => {
    // storage は空（KEY未設定）＝無効。
    jest.isolateModules(() => { require('./content_script') })
    await flush()

    // WebSocket hook は無効でも常時注入される（HUDの土台）。
    expect(countScriptsMatching(WS_HOOK_FILE)).toBe(1)
    // リプレイ傍受は注入されない。
    expect(countScriptsMatching(REPLAY_BRIDGE_FILE)).toBe(0)
  })

  test('injects the replay bridge when the flag is already enabled at load', async () => {
    // fresh import が読む get() を有効で解決させる（set()は使わない ―― 積み上がった
    // 他importのリスナーを起こしてスクリプトを二重注入させないため）。
    ;(chrome.storage.sync.get as jest.Mock).mockResolvedValue({
      [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: true
    })

    jest.isolateModules(() => { require('./content_script') })
    await flush()

    expect(countScriptsMatching(WS_HOOK_FILE)).toBe(1)
    expect(countScriptsMatching(REPLAY_BRIDGE_FILE)).toBe(1)
  })

  test('injects the replay bridge on a later enable transition', async () => {
    // 無効で起動 → 後からフラグが有効になったら注入する。
    jest.isolateModules(() => { require('./content_script') })
    await flush()
    expect(countScriptsMatching(REPLAY_BRIDGE_FILE)).toBe(0)

    // この import が登録した storage.onChanged リスナーを直接呼ぶ。
    const onChanged = (chrome.storage.onChanged.addListener as jest.Mock).mock.calls.at(-1)![0]
    onChanged({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: { newValue: true } }, 'sync')
    await flush()

    expect(countScriptsMatching(REPLAY_BRIDGE_FILE)).toBe(1)
  })

  test('injects at most once across repeated enables (the <script> cannot be un-injected)', async () => {
    jest.isolateModules(() => { require('./content_script') })
    await flush()

    const onChanged = (chrome.storage.onChanged.addListener as jest.Mock).mock.calls.at(-1)![0]
    onChanged({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: { newValue: true } }, 'sync')
    await flush()
    onChanged({ [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: { newValue: true } }, 'sync')
    await flush()

    expect(countScriptsMatching(REPLAY_BRIDGE_FILE)).toBe(1)
  })
})
