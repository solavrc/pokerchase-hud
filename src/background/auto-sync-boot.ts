/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * Service Worker起動時のAutoSyncService初期化配線。
 *
 * WHY THIS FILE EXISTS (independent release-audit finding, "cold-start
 * auth-restore race loses the initial sync"): `background.ts`のservice
 * worker起動処理は、IndexedDB初期化（`service.ready`）とFirebase認証状態の
 * 復元（`firebaseAuthService`のコンストラクタが起動時にキックする非同期の
 * `restoreAuthState()`）という、互いに独立した2つの非同期処理を並行して
 * 走らせる。両者に順序保証は無い -- IndexedDB初期化の方が先に終わった場合、
 * `firebaseAuthService.getCurrentUser()`をその場で（`ready()`を待たずに）
 * 読むと、実際にはサインイン済みのユーザーが「サインアウト状態」に見えてしまい、
 * `autoSyncService.initialize()`が丸ごとスキップされる。以降このService
 * Workerが生きている間、次のバックログ閾値イベントか手動同期が発生するまで
 * 初回ダウンロードが走らない（サイレントな同期停止）。
 *
 * `initializeAutoSyncOnReady()`はこの競合そのものを閉じる: 呼び出し側の
 * `service.ready`解決順に関わらず、必ず`firebaseAuthService.ready()`
 * （このコードベースの既存のreadiness-barrierパターン -- `service.ready`、
 * `service.filtersRestored`と同じ発想）を待ってからサインイン状態を確認する。
 *
 * `createSignInTransitionHandler()`は、それとは別の防御層として、
 * `firebaseAuthService.onAuthStateChange`リスナー（`background.ts`内、
 * Popup即時描画用のauth cache書き込みに使っているのと同じリスナー）経由でも
 * サインイン「遷移」を検知して`initialize()`を叩けるようにする
 * （`background/message-router.ts`の明示的なサインインフロー
 * -- `autoSyncService.onAuthStateChanged(user)` -- を経由しない形で
 * サインインが観測されるケースへの保険）。ただし2つのケースは意図的に
 * 「遷移」として数えない:
 *
 * 1. 「起動直後、リストア完了を通知する最初の1回」-- そこは上の
 *    `initializeAutoSyncOnReady()`が既に担当済みであり、二重に数えると
 *    cold start時に`initialize()`が無駄にもう一度呼ばれてしまう。
 *
 * 2. `source === 'sign-in'`（codex post-merge review on this PR, P2,
 *    "Avoid double auto-sync initialization on popup sign-in"）:
 *    `firebaseAuthService.signInWithGoogle()`はリスナーを同期的に
 *    （自身の`persistAuthState()`のawaitより前に）通知する。その唯一の
 *    呼び出し元 `background/message-router.ts`の`handleFirebaseSignIn`は、
 *    `signInWithGoogle()`が解決した直後に自分自身で明示的に
 *    `autoSyncService.onAuthStateChanged(user)`（内部で`initialize()`を
 *    呼ぶ）をawaitしている -- つまりこのリスナー経由の同期通知は、その
 *    明示呼び出しより前に発火する。ここでも`initialize()`を呼ぶと、その
 *    明示呼び出しと競合する: `AutoSyncService.initialize()`自身の簿記処理
 *    （scoped `lastSyncTime`の読み取り・移行・書き込み）は`performSync()`が
 *    実際に始まるまで`_isSyncing`ラッチで保護されないため、重複した
 *    初回`initialize()`呼び出し同士が互いの書き込みを踏みつけ合い、
 *    初回クラウド同期が二重に走ってしまう。ポップアップ経由のサインインは
 *    常にこの明示呼び出しを持つため、`'sign-in'`ソースの遷移は無条件で
 *    スキップする。
 *
 * （`AutoSyncService.initialize()`自体は世代ゲート・上限付きリトライで
 * 再入安全だが、上記2つを除外しないと意味のない/有害な二重呼び出しを
 * 増やしてしまう）。
 */
import type { AuthChangeSource } from '../services/firebase-auth-service'

/** `initializeAutoSyncOnReady()`が必要とする最小限のFirebaseAuthService面 */
export interface AutoSyncBootAuthGate {
  ready(): Promise<void>
  getCurrentUser(): unknown
}

/** `initializeAutoSyncOnReady()`/`createSignInTransitionHandler()`が必要とする最小限のAutoSyncService面 */
export interface AutoSyncBootSyncService {
  initialize(): Promise<void>
}

/**
 * `service.ready`解決後に一度だけ呼ぶ。`authService.ready()`（Firebase認証状態の
 * 復元完了バリア）を必ず待ってからサインイン状態を確認するため、IndexedDB初期化と
 * 認証復元のどちらが先に終わっても、サインイン済みユーザーの初回同期を
 * 取りこぼさない。
 */
export async function initializeAutoSyncOnReady(
  authService: AutoSyncBootAuthGate,
  syncService: AutoSyncBootSyncService
): Promise<void> {
  await authService.ready()
  const user = authService.getCurrentUser()
  if (user) {
    await syncService.initialize()
  }
}

/**
 * `firebaseAuthService.onAuthStateChange`に渡すコールバックを作る。返す関数は
 * 「直近で観測した状態」を閉じ込め、signed-out → signed-in の実際の「遷移」を
 * 検知した時だけ`syncService.initialize()`を叩く -- ただし以下の2ケースは
 * 意図的に除外する（このファイル冒頭のコメント参照）:
 *
 * 1. コールバックの最初の1回の呼び出し（内部状態が`null`、つまり
 *    「まだ何も観測していない」→「signed-in」という最初の遷移) --
 *    Service Worker起動時のリストア完了通知を表し、
 *    `initializeAutoSyncOnReady()`が既に処理済み。
 *
 * 2. `source === 'sign-in'`（codex review, P2, "Avoid double auto-sync
 *    initialization on popup sign-in"） -- ポップアップ経由の明示的な
 *    サインインフローは常に自分自身で`initialize()`相当を呼ぶため、
 *    ここで呼ぶと二重初期化になる。
 */
export function createSignInTransitionHandler(
  syncService: AutoSyncBootSyncService,
  onError: (error: unknown) => void = () => {}
): (user: unknown, source: AuthChangeSource) => void {
  let previousSignedIn: boolean | null = null

  return (user: unknown, source: AuthChangeSource): void => {
    const isSignedIn = !!user
    if (isSignedIn && previousSignedIn === false && source !== 'sign-in') {
      syncService.initialize().catch(onError)
    }
    previousSignedIn = isSignedIn
  }
}
