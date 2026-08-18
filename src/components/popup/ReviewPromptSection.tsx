import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { StarRounded } from '@mui/icons-material'
import { useCallback, useEffect, useState } from 'react'
import { buildChromeWebStoreReviewUrl } from '../../constants/review-prompt'
import { PENDING_UPDATE_STORAGE_KEY, type PendingUpdateState } from '../../constants/update'
import { MIN_VERSION_GATE_STORAGE_KEY, type MinVersionGateState } from '../../services/min-version-gate'
import { REBUILD_ADVISORY_STORAGE_KEY, type RebuildAdvisoryState } from '../../background/rebuild-advisory'
import type {
  GetReviewPromptMessage,
  MessageResponse,
  ResolveReviewPromptMessage,
  ReviewPromptResponse,
} from '../../types/messages'
import type { ReviewPromptChoice } from '../../constants/review-prompt'
import { sendMessageWithTimeout } from './send-message'

const REVIEW_PROMPT_MESSAGE_TIMEOUT_MS = 5000

/**
 * Chrome ウェブストアのレビュー依頼バナー（sola承認）。
 *
 * 表示可否の判定材料（累計ハンド数・スヌーズ・決着）はすべてbackgroundの
 * `review-prompt.ts`が持っており、ここはその boolean を受け取って描画し、
 * 押されたボタンを送り返すだけ（storage keyの書き込み主体をbackgroundに
 * 一本化している）。
 *
 * **他バナーとの優先順位**: バッジの優先順位（rebuild > update > 情報系,
 * AGENTS.md「Badge precedence」）と同じ考え方で、データ再構築アドバイザリ・
 * 保留中アップデート・サポート終了ゲートのいずれかが出ている間は自分を
 * 引っ込める。「サポートが終了しました」の隣で「評価してください」と
 * 出るのは体験として悪い。
 *
 * 抑制キーはマウント時に読み、`chrome.storage.onChanged`にも追従する。
 * SW起動後の非同期min-version判定やupdate検出で上位バナーが後から現れても、
 * レビュー依頼が同時表示されないことをMUST維持する。
 */
export const ReviewPromptSection = () => {
  const [visible, setVisible] = useState(false)
  const [suppressed, setSuppressed] = useState(true)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    let cancelled = false

    // フェイルオープン: 応答なし/エラー時は非表示のまま（依頼バナーは
    // 出ない方に倒す）
    sendMessageWithTimeout<ReviewPromptResponse>(
      { action: 'getReviewPrompt' } as GetReviewPromptMessage,
      REVIEW_PROMPT_MESSAGE_TIMEOUT_MS
    ).then((response) => {
      if (!cancelled && response?.success && response.visible) {
        setVisible(true)
      }
    })

    const suppressionKeys = [
      REBUILD_ADVISORY_STORAGE_KEY,
      PENDING_UPDATE_STORAGE_KEY,
      MIN_VERSION_GATE_STORAGE_KEY,
    ]
    let suppressionReadGeneration = 0
    const refreshSuppression = () => {
      const generation = ++suppressionReadGeneration
      chrome.storage.local.get(suppressionKeys, (result: Record<string, any>) => {
        if (cancelled) return
        if (generation !== suppressionReadGeneration) return
        // 読めなかった場合は抑制したまま（優先度の高いバナーを隠すより、
        // 依頼を出さない方が安全側）
        if (chrome.runtime.lastError) return
        const advisory = result?.[REBUILD_ADVISORY_STORAGE_KEY] as RebuildAdvisoryState | undefined
        const pendingUpdate = result?.[PENDING_UPDATE_STORAGE_KEY] as PendingUpdateState | undefined
        const gate = result?.[MIN_VERSION_GATE_STORAGE_KEY] as MinVersionGateState | undefined
        setSuppressed(
          !!advisory?.pendingVersion || !!pendingUpdate?.pending || gate?.supported === false
        )
      })
    }
    refreshSuppression()

    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return
      if (suppressionKeys.some(key => changes[key])) refreshSuppression()
    }
    chrome.storage.onChanged.addListener(handleStorageChange)

    return () => {
      cancelled = true
      chrome.storage.onChanged.removeListener(handleStorageChange)
    }
  }, [])

  const resolve = useCallback((choice: ReviewPromptChoice) =>
    sendMessageWithTimeout<MessageResponse>(
      { action: 'resolveReviewPrompt', choice } as ResolveReviewPromptMessage,
      REVIEW_PROMPT_MESSAGE_TIMEOUT_MS
    ), [])

  // `chrome.runtime.id`はmanifestの`key`から決まる固定値。取得できない
  // 異常系ではレビューページを組み立てられないため、バナー自体を出さない
  const reviewUrl = chrome.runtime.id ? buildChromeWebStoreReviewUrl(chrome.runtime.id) : undefined

  const persistChoice = useCallback(async (choice: ReviewPromptChoice): Promise<boolean> => {
    // 応答なし・保存失敗はunknown state。成功を確認できるまではバナーを残し、
    // 再試行できるようボタンを戻す。とくにratedは、Popup破棄より前に決着が
    // 永続化されたことを確認してからストアを開く必要がある。
    setResolving(true)
    const response = await resolve(choice)
    if (!response?.success) {
      setResolving(false)
      return false
    }
    setVisible(false)
    return true
  }, [resolve])

  const handleRate = useCallback(async () => {
    if (await persistChoice('rated')) {
      if (reviewUrl) chrome.tabs.create({ url: reviewUrl })
    }
  }, [persistChoice, reviewUrl])

  const handleLater = useCallback(() => {
    void persistChoice('later')
  }, [persistChoice])

  const handleDismiss = useCallback(() => {
    void persistChoice('dismissed')
  }, [persistChoice])

  if (!visible || suppressed || !reviewUrl) return null

  return (
    <Box sx={{ mt: 1 }}>
      {/* severity="info"（お知らせ扱い）のまま、アイコンだけ★=評価の語彙に
        差し替える。色はテーマの`warning`（ダーク=ゴールド#d9a842 /
        ライト=ブロンズ#b9812c）で、既定のinfo青より両テーマのパレットに馴染む */}
      <Alert
        severity="info"
        icon={<StarRounded fontSize="inherit" sx={{ color: 'warning.main' }} />}
      >
        <Typography variant="body2">
          PokerChase HUD は役に立っていますか？
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', mt: 0.25 }}>
          Chrome ウェブストアでの評価・レビューが今後の開発の励みになります。
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
          <Button size="small" color="inherit" onClick={handleRate} disabled={resolving}>
            {resolving ? '処理しています...' : '評価する'}
          </Button>
          <Button size="small" color="inherit" onClick={handleLater} disabled={resolving}>
            後で
          </Button>
          <Button size="small" color="inherit" onClick={handleDismiss} disabled={resolving}>
            今後表示しない
          </Button>
        </Box>
      </Alert>
    </Box>
  )
}
