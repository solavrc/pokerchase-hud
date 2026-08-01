import Alert from '@mui/material/Alert'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Typography from '@mui/material/Typography'
import { useEffect, useState, type ChangeEvent } from 'react'
import { EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY } from '../../replay/protocol'

/**
 * リプレイ取り込みのオプトイン（既定OFF）。
 *
 * **「取得はセッション終了後」であることをユーザーに読める位置で示す**のが
 * このセクションの要件（sola裁定）。トグルの文言だけでは、対局中に通信が
 * 走ると誤解されうる。
 *
 * `chrome.storage.sync` に置く理由は `content_script.ts` のコメント参照
 * （`storage.local` は content script から遮断されている）。
 */
export const ReplayImportSection = () => {
  const [enabled, setEnabled] = useState(false)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    chrome.storage.sync.get(EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY)
      .then(stored => {
        if (!cancelled) setEnabled(stored[EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY] === true)
      })
      .catch(() => {
        if (!cancelled) setError('リプレイ取り込みの設定を読み込めませんでした。')
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })
    return () => { cancelled = true }
  }, [])

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const nextEnabled = event.target.checked
    setPending(true)
    setError('')
    // 楽観的更新（Popup ↔ Background の既存パターン）。失敗したら戻す。
    setEnabled(nextEnabled)
    try {
      await chrome.storage.sync.set({
        [EXPERIMENTAL_REPLAY_IMPORT_STORAGE_KEY]: nextEnabled
      })
    } catch {
      setEnabled(!nextEnabled)
      setError('リプレイ取り込みの設定を更新できませんでした。')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        リプレイ取り込み（試験機能）
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={enabled}
            disabled={pending}
            onChange={handleChange}
          />
        }
        label="ショーダウンで伏せられた手札を取り込む"
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        有効にすると、自分が参加したハンドの詳細をゲームのリプレイ機能と同じ
        APIから取得します。取得は<strong>対局が終わったあと</strong>にまとめて
        行われ、対局中は一切通信しません（1件ずつ1.5秒間隔）。
        取得できるのは<strong>直近3日ぶん</strong>のハンドだけで、それより古い
        ものはサーバ側で閲覧期限切れになります。既定は無効です。
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </>
  )
}
