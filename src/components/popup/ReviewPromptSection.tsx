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
 * 抑制キーの購読はマウント時の一度きり（`chrome.storage.onChanged`は
 * 購読しない）。Popupを開いたまま更新が降ってきた場合にバナーが2枚
 * 並ぶだけで実害が無く、短命なPopupのためにもう1つ購読を増やす価値が
 * 無いため。
 */
export const ReviewPromptSection = () => {
  const [visible, setVisible] = useState(false)
  const [suppressed, setSuppressed] = useState(true)
  const [rating, setRating] = useState(false)

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

    chrome.storage.local.get(
      [REBUILD_ADVISORY_STORAGE_KEY, PENDING_UPDATE_STORAGE_KEY, MIN_VERSION_GATE_STORAGE_KEY],
      (result: Record<string, any>) => {
        if (cancelled) return
        // 読めなかった場合は抑制したまま（優先度の高いバナーを隠すより、
        // 依頼を出さない方が安全側）
        if (chrome.runtime.lastError) return
        const advisory = result?.[REBUILD_ADVISORY_STORAGE_KEY] as RebuildAdvisoryState | undefined
        const pendingUpdate = result?.[PENDING_UPDATE_STORAGE_KEY] as PendingUpdateState | undefined
        const gate = result?.[MIN_VERSION_GATE_STORAGE_KEY] as MinVersionGateState | undefined
        setSuppressed(
          !!advisory?.pendingVersion || !!pendingUpdate?.pending || gate?.supported === false
        )
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  const resolve = useCallback((choice: ReviewPromptChoice) =>
    sendMessageWithTimeout(
      { action: 'resolveReviewPrompt', choice } as ResolveReviewPromptMessage,
      REVIEW_PROMPT_MESSAGE_TIMEOUT_MS
    ), [])

  // `chrome.runtime.id`はmanifestの`key`から決まる固定値。取得できない
  // 異常系ではレビューページを組み立てられないため、バナー自体を出さない
  const reviewUrl = chrome.runtime.id ? buildChromeWebStoreReviewUrl(chrome.runtime.id) : undefined

  const handleRate = useCallback(async () => {
    // 記録の完了を待ってからタブを開く: 新規タブへ切り替わるとPopupは
    // 破棄されるため、送信しっぱなしだと決着が失われうる。タイムアウト時
    // （応答なし）はストアページを開く方を優先する -- ユーザーの意図を
    // 妨げないのが優先で、記録漏れは「後日もう一度聞かれる」だけで済む。
    //
    // 待っている間はバナーを消さずボタンをdisabledにする（UpdateSectionの
    // applyingと同じ形）。先に消してしまうと、SWのコールドスタートで
    // 往復が延びたときに「押したのに何も起きない」無反応の窓ができ、
    // そこでPopupを閉じられると`rated`だけ記録されてストアは開かれない
    // -- 二度と聞かない状態になってしまう
    setRating(true)
    await resolve('rated')
    setVisible(false)
    if (reviewUrl) chrome.tabs.create({ url: reviewUrl })
  }, [resolve, reviewUrl])

  const handleLater = useCallback(() => {
    setVisible(false)
    void resolve('later')
  }, [resolve])

  const handleDismiss = useCallback(() => {
    setVisible(false)
    void resolve('dismissed')
  }, [resolve])

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
          <Button size="small" color="inherit" onClick={handleRate} disabled={rating}>
            {rating ? '開いています...' : '評価する'}
          </Button>
          <Button size="small" color="inherit" onClick={handleLater} disabled={rating}>
            後で
          </Button>
          <Button size="small" color="inherit" onClick={handleDismiss} disabled={rating}>
            今後表示しない
          </Button>
        </Box>
      </Alert>
    </Box>
  )
}
