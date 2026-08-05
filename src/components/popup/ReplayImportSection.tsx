import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useEffect, useState, type ChangeEvent } from 'react'
import {
  EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY,
  PUBLIC_REPLAY_IMPORT_STORAGE_KEY,
  REPLAY_IMPORT_ACCESS_STORAGE_KEY,
  type ReplayAccessRecord
} from '../../replay/protocol'

const DISABLED_ACCESS: ReplayAccessRecord = { phase: 'disabled' }

const readAccessRecord = (value: unknown): ReplayAccessRecord =>
  typeof value === 'object' && value !== null && 'phase' in value
    ? value as ReplayAccessRecord
    : DISABLED_ACCESS

const readStorage = (
  area: chrome.storage.StorageArea,
  keys: string | string[]
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    try {
      area.get(keys, result => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        resolve(result)
      })
    } catch (error) {
      reject(error)
    }
  })

/** 公開オプトイン。開発者フラグとは別キーで、課金検証状態を可視化する。 */
export const ReplayImportSection = () => {
  const [publicEnabled, setPublicEnabled] = useState(false)
  const [developerBypass, setDeveloperBypass] = useState(false)
  const [access, setAccess] = useState<ReplayAccessRecord>(DISABLED_ACCESS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      readStorage(chrome.storage.sync, [
        PUBLIC_REPLAY_IMPORT_STORAGE_KEY,
        EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY
      ]),
      readStorage(chrome.storage.local, REPLAY_IMPORT_ACCESS_STORAGE_KEY)
    ]).then(([sync, local]) => {
      if (cancelled) return
      setPublicEnabled(sync[PUBLIC_REPLAY_IMPORT_STORAGE_KEY] === true)
      setDeveloperBypass(sync[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true)
      setAccess(readAccessRecord(local[REPLAY_IMPORT_ACCESS_STORAGE_KEY]))
    }).catch(() => {
      if (!cancelled) setError('リプレイ取り込みの設定を読み込めませんでした。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName === 'sync') {
        const publicChange = changes[PUBLIC_REPLAY_IMPORT_STORAGE_KEY]
        const developerChange = changes[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]
        if (publicChange) setPublicEnabled(publicChange.newValue === true)
        if (developerChange) setDeveloperBypass(developerChange.newValue === true)
      }
      if (areaName === 'local' && changes[REPLAY_IMPORT_ACCESS_STORAGE_KEY]) {
        setAccess(readAccessRecord(changes[REPLAY_IMPORT_ACCESS_STORAGE_KEY].newValue))
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      cancelled = true
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const nextEnabled = event.target.checked
    setLoading(true)
    setError('')
    setPublicEnabled(nextEnabled)
    if (nextEnabled) setAccess({ phase: 'checking' })
    try {
      await chrome.storage.sync.set({
        [PUBLIC_REPLAY_IMPORT_STORAGE_KEY]: nextEnabled
      })
    } catch {
      setPublicEnabled(!nextEnabled)
      setError('リプレイ取り込みの設定を更新できませんでした。')
    } finally {
      setLoading(false)
    }
  }

  const displayPhase = access.phase === 'verified' &&
    typeof access.cardOpenEndDate === 'number' && access.cardOpenEndDate * 1000 <= Date.now()
    ? 'expired'
    : access.phase

  const status = developerBypass
    ? <Alert severity="info" sx={{ mt: 1 }}>開発者設定により課金検証を省略して有効です。</Alert>
    : publicEnabled && displayPhase === 'checking'
      ? <Alert severity="info" sx={{ mt: 1 }}>カード公開の利用状態を確認中です。</Alert>
      : publicEnabled && displayPhase === 'pending-session'
        ? <Alert severity="info" sx={{ mt: 1 }}>対局終了後にカード公開の利用状態を確認します。</Alert>
        : publicEnabled && displayPhase === 'pending-auth'
          ? <Alert severity="info" sx={{ mt: 1 }}>ゲームのホーム画面を開くと確認されます。</Alert>
          : publicEnabled && displayPhase === 'verified'
            ? <Alert severity="success" sx={{ mt: 1 }}>カード公開の有効期間内のアカウントで利用できます。</Alert>
            : publicEnabled && displayPhase === 'expired'
              ? <Alert severity="warning" sx={{ mt: 1 }}>カード公開の有効期間外のため有効化されませんでした。</Alert>
              : publicEnabled && displayPhase === 'error'
                ? <Alert severity="warning" sx={{ mt: 1 }}>カード公開の利用状態を確認できませんでした。</Alert>
                : null

  return (
    <>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        リプレイ取り込み
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={publicEnabled}
            disabled={loading}
            onChange={handleChange}
          />
        }
        label="リプレイに記録された全員の手札を取り込む"
      />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        ゲームの<strong>〈手札公開機能〉</strong>が公開する範囲で、リプレイに記録された
        全プレイヤーの手札（フォールドした手札を含む）を直近ハンドに表示します。
        カード公開の有効期間内のアカウントでのみ利用できます。取得は
        <strong>対局が終わったあと</strong>に行われ、対局中は通信しません。
        取り込みを停止しても、取り込み済みのハンドは削除されません。既定は無効です。
      </Typography>
      {status}
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </>
  )
}
