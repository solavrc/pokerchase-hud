/** !!! CONTENT_SCRIPTS、WEB_ACCESSIBLE_RESOURCESからインポートしないこと !!! */
/**
 * 公開リプレイ取り込みのオプトインとプレミアムパスの期限の検証状態を所有する。
 *
 * 開発者フラグはこの状態機械を無条件にバイパスする。公開経路は、ACTIVEの
 * fairness gateを通り、認証エンベロープを持つゲームタブから`/replay/list`を
 * 1回だけ取得できた場合に限り有効になる（MUST）。
 */
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  PUBLIC_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_IMPORT_ACCESS_STORAGE_KEY,
  REPLAY_VERIFY_IN_SESSION,
  REPLAY_VERIFY_NO_AUTH,
  type ReplayAccessPhase,
  type ReplayAccessRecord,
  type ReplayEntitlement
} from '../replay/protocol'
import { connectedPorts } from './ports'
import {
  getActivePort,
  isActivePortOutsideSession
} from './active-port'
import {
  requestReplayVerification,
  type ReplayVerificationOutcome
} from './replay-fetch-bridge'

export interface ReplayAccessView extends ReplayAccessRecord {
  publicEnabled: boolean
  developerBypass: boolean
  effectiveEnabled: boolean
}

export interface ReplayAccessDeps {
  now: () => number
  isOutsideSession: () => boolean
  resolveVerificationPort: () => chrome.runtime.Port | undefined
  requestVerification: (port: chrome.runtime.Port) => Promise<ReplayVerificationOutcome>
}

const DEFAULT_RECORD: ReplayAccessRecord = { phase: 'disabled' }
let authReadyPorts = new WeakSet<chrome.runtime.Port>()
let verificationInFlight: Promise<boolean> | undefined
let initialized = false

const readFlags = async (): Promise<{
  developerBypass: boolean
  publicEnabled: boolean
}> => {
  try {
    const stored = await chrome.storage.sync.get([
      EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
      PUBLIC_REPLAY_IMPORT_STORAGE_KEY
    ])
    return {
      developerBypass: stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true,
      publicEnabled: stored[PUBLIC_REPLAY_IMPORT_STORAGE_KEY] === true
    }
  } catch {
    return { developerBypass: false, publicEnabled: false }
  }
}

const isReplayAccessPhase = (value: unknown): value is ReplayAccessPhase =>
  value === 'disabled' || value === 'pending-session' || value === 'pending-auth' ||
  value === 'checking' || value === 'verified' || value === 'expired' || value === 'error'

export const readReplayAccessRecord = async (): Promise<ReplayAccessRecord> => {
  try {
    const stored = await chrome.storage.local.get(REPLAY_IMPORT_ACCESS_STORAGE_KEY)
    const value = stored[REPLAY_IMPORT_ACCESS_STORAGE_KEY]
    if (typeof value !== 'object' || value === null ||
      !isReplayAccessPhase((value as ReplayAccessRecord).phase)) return DEFAULT_RECORD
    return value as ReplayAccessRecord
  } catch {
    return DEFAULT_RECORD
  }
}

const writeRecord = async (record: ReplayAccessRecord): Promise<void> => {
  await chrome.storage.local.set({ [REPLAY_IMPORT_ACCESS_STORAGE_KEY]: record })
}

/**
 * 検証の依頼先は**ACTIVEポートだけ**（MUST）。
 *
 * 「ACTIVE tokenが無いときは接続中の任意のポートを使う」という緩和は置けない。
 * `isActivePortOutsideSession()` は token未生成・unknown・reconnect猶予を
 * すべて対局中として扱うので、tokenが無い状態はそもそもこの関数の手前で
 * 弾かれており、緩和は到達しないうえに不変条件と矛盾する。
 *
 * 認証エンベロープを捕獲済みであることも要る ―― 未捕獲のポートへ投げると
 * `/replay/list` は撃たれず、待ちだけが上限まで残る。
 */
const defaultResolveVerificationPort = (): chrome.runtime.Port | undefined => {
  const activePort = getActivePort()
  if (!activePort) return undefined
  return connectedPorts.has(activePort) && authReadyPorts.has(activePort)
    ? activePort
    : undefined
}

const DEFAULT_DEPS: ReplayAccessDeps = {
  now: () => Date.now(),
  isOutsideSession: isActivePortOutsideSession,
  resolveVerificationPort: defaultResolveVerificationPort,
  requestVerification: requestReplayVerification
}

const isEntitled = (entitlement: ReplayEntitlement, now: number): boolean =>
  entitlement.isExpiredCardOpen === false &&
  Number.isFinite(entitlement.cardOpenEndDate) &&
  entitlement.cardOpenEndDate * 1000 > now

/** 開発者バイパスを含む、詳細取り込みの最終実効判定。 */
export const readReplayImportEnabled = async (
  now: number = Date.now()
): Promise<boolean> => {
  const flags = await readFlags()
  if (flags.developerBypass) return true
  if (!flags.publicEnabled) return false
  const record = await readReplayAccessRecord()
  const enabled = record.phase === 'verified' &&
    typeof record.cardOpenEndDate === 'number' &&
    record.cardOpenEndDate * 1000 > now
  if (!enabled && record.phase === 'verified') {
    void writeRecord({
      phase: 'expired',
      cardOpenEndDate: record.cardOpenEndDate,
      checkedAt: now
    })
  }
  return enabled
}

export const readReplayAccessView = async (): Promise<ReplayAccessView> => {
  const flags = await readFlags()
  const record = await readReplayAccessRecord()
  const paidEnabled = flags.publicEnabled && record.phase === 'verified' &&
    typeof record.cardOpenEndDate === 'number' && record.cardOpenEndDate * 1000 > Date.now()
  return {
    ...record,
    publicEnabled: flags.publicEnabled,
    developerBypass: flags.developerBypass,
    effectiveEnabled: flags.developerBypass || paidEnabled
  }
}

/**
 * 公開経路を検証する。並行する契機（toggle/auth-ready/session-end）は同じ1本へ
 * 合流し、`/replay/list`を重複発行しない。
 */
export const verifyReplayImportAccess = async (
  deps: ReplayAccessDeps = DEFAULT_DEPS
): Promise<boolean> => {
  if (verificationInFlight) return verificationInFlight
  verificationInFlight = (async () => {
    const flags = await readFlags()
    if (flags.developerBypass) return true
    if (!flags.publicEnabled) {
      // 検証はセッション終了・ポート接続など**取得サイクルの契機ごと**に
      // 呼ばれる。既に`disabled`なら書かない ―― 公開機能を一度も使っていない
      // ユーザーで、契機のたびに`storage.local`へ同じ値を書くのを避ける。
      if ((await readReplayAccessRecord()).phase !== 'disabled') {
        await writeRecord({ phase: 'disabled' })
      }
      return false
    }
    const current = await readReplayAccessRecord()
    const wasVerified = current.phase === 'verified' &&
      typeof current.cardOpenEndDate === 'number' &&
      current.cardOpenEndDate * 1000 > deps.now()
    if (!deps.isOutsideSession()) {
      if (!wasVerified) await writeRecord({ phase: 'pending-session' })
      return false
    }
    const port = deps.resolveVerificationPort()
    if (!port) {
      if (!wasVerified) await writeRecord({ phase: 'pending-auth' })
      return false
    }

    await writeRecord({ phase: 'checking' })
    const outcome = await deps.requestVerification(port)
    const latestFlags = await readFlags()
    if (latestFlags.developerBypass) return true
    if (!latestFlags.publicEnabled) {
      await writeRecord({ phase: 'disabled' })
      return false
    }
    const checkedAt = deps.now()
    if (!outcome.success) {
      // 「まだ撃てない」と「撃って失敗した」を分ける。ページ側・SW側どちらの
      // fairness gateで止まった場合も`pending-session`であり、`error`にしない
      // ―― 次の取得サイクルの先頭で必ず撃ち直されるため。
      await writeRecord({
        phase: outcome.error === REPLAY_VERIFY_NO_AUTH
          ? 'pending-auth'
          : outcome.error === REPLAY_VERIFY_IN_SESSION
            ? 'pending-session'
            : 'error',
        checkedAt,
        lastError: outcome.error
      })
      return false
    }
    if (!isEntitled(outcome.entitlement, checkedAt)) {
      await writeRecord({
        phase: 'expired',
        cardOpenEndDate: outcome.entitlement.cardOpenEndDate,
        checkedAt
      })
      return false
    }
    await writeRecord({
      phase: 'verified',
      cardOpenEndDate: outcome.entitlement.cardOpenEndDate,
      checkedAt
    })
    return true
  })().finally(() => { verificationInFlight = undefined })
  return verificationInFlight
}

/** エンベロープの値は受け取らず、保有しているportだけを記録する。 */
export const markReplayAuthReady = (port: chrome.runtime.Port): void => {
  authReadyPorts.add(port)
}

export const releaseReplayAuthPort = (port: chrome.runtime.Port): void => {
  authReadyPorts.delete(port)
}

/** storage変更と公開検証を接続する。background起動ごとに1回だけ呼ぶ。 */
export const initializeReplayAccess = (
  triggerVerification: () => Promise<void> = async () => {
    await verifyReplayImportAccess()
  }
): void => {
  if (initialized) return
  initialized = true
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (!changes[PUBLIC_REPLAY_IMPORT_STORAGE_KEY] &&
      !changes[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]) return
    void triggerVerification().catch(error => {
      console.warn('[replay-import] プレミアムパスの利用状態を確認できませんでした:', error)
    })
  })
  void triggerVerification().catch(error => {
    console.warn('[replay-import] プレミアムパスの利用状態を確認できませんでした:', error)
  })
}

/** テスト用。メモリ上の認証・直列化状態を初期化する。 */
export const __resetReplayAccessForTests = (): void => {
  authReadyPorts = new WeakSet<chrome.runtime.Port>()
  verificationInFlight = undefined
}
