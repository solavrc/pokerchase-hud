/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * Popup ↔ Background の排他制御用の状態管理。
 *
 * `export`/`import`/`rebuild`/`sync` のような長時間実行される操作は同時に1つしか
 * 実行できない（CLAUDE.md「Operation Exclusivity」参照）。Popup側は楽観的に
 * ボタンを無効化するが、Background側でも`currentOperationState`を見て
 * 二重実行を拒否することでサーバーサイドの保証とする。
 */

export interface OperationState {
  type: 'idle' | 'export' | 'import' | 'rebuild' | 'sync' | 'delete'
  format?: 'json' | 'pokerstars'
  progress?: number
  processed?: number
  total?: number
  message?: string
}

let currentOperationState: OperationState = { type: 'idle' }

/**
 * `type: 'idle'`への遷移（export/import/rebuildの完了・失敗いずれか）を購読する
 * リスナー集合。`src/background/update-manager.ts`が「operation completion」
 * 時点での保留中アップデートの安全性再チェックをフックするために使う
 * （CLAUDE.md「Forced Update」参照）。operation-state.tsはupdate-managerに
 * 依存しない一方向の依存にするため、コールバック登録方式にしている。
 */
type IdleListener = () => void
const idleListeners: IdleListener[] = []

/** `type: 'idle'`への遷移時に呼ばれるリスナーを登録する。解除関数を返す */
export const onOperationBecameIdle = (listener: IdleListener): (() => void) => {
  idleListeners.push(listener)
  return () => {
    const index = idleListeners.indexOf(listener)
    if (index !== -1) idleListeners.splice(index, 1)
  }
}

/** 現在の操作状態を取得する（Popupの`getOperationState`クエリ用） */
export const getOperationState = (): OperationState => currentOperationState

/** 操作状態を更新する（進捗更新や完了/失敗時のidle復帰など） */
export const setOperationState = (state: OperationState): void => {
  const wasIdle = currentOperationState.type === 'idle'
  currentOperationState = state
  if (!wasIdle && state.type === 'idle') {
    // Listeners such as waitForOperationIdle() unsubscribe themselves while
    // handling this transition. Iterate over a snapshot so splicing the live
    // registry cannot skip the next waiter.
    for (const listener of [...idleListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[operation-state] onOperationBecameIdle listener failed:', error)
      }
    }
  }
}

/** アイドル状態かどうか（同時実行不可な操作の開始可否判定用） */
export const isOperationIdle = (): boolean => currentOperationState.type === 'idle'

/** 現在の長時間処理が終わるまで待つ。既にidleなら即座に解決する。 */
export const waitForOperationIdle = async (): Promise<void> => {
  if (isOperationIdle()) return

  await new Promise<void>(resolve => {
    const unsubscribe = onOperationBecameIdle(() => {
      unsubscribe()
      resolve()
    })

    // Check again after subscription so an idle transition between the
    // initial check and listener registration cannot leave this hung.
    if (isOperationIdle()) {
      unsubscribe()
      resolve()
    }
  })
}
