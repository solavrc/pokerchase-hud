/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * Popup ↔ Background の排他制御用の状態管理。
 *
 * `export`/`import`/`rebuild` のような長時間実行される操作は同時に1つしか
 * 実行できない（CLAUDE.md「Operation Exclusivity」参照）。Popup側は楽観的に
 * ボタンを無効化するが、Background側でも`currentOperationState`を見て
 * 二重実行を拒否することでサーバーサイドの保証とする。
 */

export interface OperationState {
  type: 'idle' | 'export' | 'import' | 'rebuild'
  format?: 'json' | 'pokerstars'
  progress?: number
  processed?: number
  total?: number
  message?: string
}

let currentOperationState: OperationState = { type: 'idle' }

/** 現在の操作状態を取得する（Popupの`getOperationState`クエリ用） */
export const getOperationState = (): OperationState => currentOperationState

/** 操作状態を更新する（進捗更新や完了/失敗時のidle復帰など） */
export const setOperationState = (state: OperationState): void => {
  currentOperationState = state
}

/** アイドル状態かどうか（同時実行不可な操作の開始可否判定用） */
export const isOperationIdle = (): boolean => currentOperationState.type === 'idle'
