/**
 * Forced Update（sola承認）関連のstorage keyと状態型。
 *
 * background/update-manager.ts（実処理）とcomponents/popup/UpdateSection.tsx
 * （表示）の両方から参照される。意図的にサイドエフェクトフリーな独立モジュール
 * として切り出している: popupがこれをbackground/update-manager.tsから直接
 * importすると、そのモジュールのimport連鎖（services/auto-sync-serviceの
 * シングルトン初期化がPokerChaseDB/Firestoreバックアップスタックを構築する）
 * ごとpopupバンドルで実行されてしまうため（codex review, PR #150）。
 */
export const PENDING_UPDATE_STORAGE_KEY = 'pendingUpdate'

export interface PendingUpdateState {
  pending: boolean
  version?: string
  detectedAt?: number
  /** 直近の「今すぐ適用」失敗理由（Popup表示用）。適用成功時は消える(pending: false) */
  lastBlockedReason?: string
}
