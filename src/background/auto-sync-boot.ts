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
 * サインインが観測されるケースへの保険）。ただし「起動直後、リストア完了を
 * 通知する最初の1回」は遷移として数えない -- そこは上の
 * `initializeAutoSyncOnReady()`が既に担当済みであり、二重に数えると
 * cold start時に`initialize()`が無駄にもう一度呼ばれてしまう
 * （`AutoSyncService.initialize()`自体は世代ゲート・上限付きリトライで
 * 再入安全だが、意味のない二重呼び出しを増やす理由が無い）。
 */

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
 * 検知した時だけ`syncService.initialize()`を叩く。
 *
 * 内部状態は`null`（「まだ何も観測していない」）から始まる -- `false`ではない。
 * これは意図的: このコールバックの最初の1回の呼び出しは、Service Worker起動時の
 * リストア完了通知（＝その時点で既にサインイン済みかもしれない状態）を表す。
 * それを`initializeAutoSyncOnReady()`が既に処理した初回同期と重複カウントしない
 * ために、「まだ観測していない」→「signed-in」という最初の遷移は無視し、
 * その後の実際のsigned-out → signed-in遷移だけを拾う。
 */
export function createSignInTransitionHandler(
  syncService: AutoSyncBootSyncService,
  onError: (error: unknown) => void = () => {}
): (user: unknown) => void {
  let previousSignedIn: boolean | null = null

  return (user: unknown): void => {
    const isSignedIn = !!user
    if (isSignedIn && previousSignedIn === false) {
      syncService.initialize().catch(onError)
    }
    previousSignedIn = isSignedIn
  }
}
