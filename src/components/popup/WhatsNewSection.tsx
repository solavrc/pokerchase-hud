import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useEffect, useMemo } from 'react'
import {
  GITHUB_RELEASES_URL,
  WHATS_NEW_ENTRIES,
  selectWhatsNewEntry,
  type WhatsNewEntry,
} from '../../constants/whats-new'
import type { AcknowledgeWhatsNewMessage } from '../../types/messages'
import { SectionCard } from './SectionCard'
import { SectionHeading } from './SectionHeading'
import { sendMessageWithTimeout } from './send-message'

const EntryHeader = ({ entry }: { entry: WhatsNewEntry }) => (
  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
    v{entry.version}（{entry.date}）{entry.title}
  </Typography>
)

const EntryPoints = ({ points }: { points: WhatsNewEntry['points'] }) => (
  <Box component="ul" sx={{ m: 0, pl: 2.5, '& li': { mb: 0.5 } }}>
    {points.map((point, index) => (
      <Typography key={index} component="li" variant="body2" sx={{ lineHeight: 1.4 }}>
        {point.text}
        {point.why && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {point.why}
          </Typography>
        )}
      </Typography>
    ))}
  </Box>
)

/**
 * 更新情報（What's New）セクション。バージョンごとにキュレーションされた
 * 変更点（`src/constants/whats-new.ts`のWHATS_NEW_ENTRIES）を、現在の
 * `chrome.runtime.getManifest().version`に対応するエントリを中心に表示する。
 * 過去のエントリは`<details>`で折りたたみ、フッターにGitHub Releasesへの
 * リンクを置く。
 *
 * マウント時に`acknowledgeWhatsNew`メッセージ（`message-router.ts`→
 * `src/background/whats-new-badge.ts`）を送り、拡張機能アイコンのバッジ
 * （未読があれば）を解消する。未読が無い状態で送っても副作用は無い（冪等）。
 */
export const WhatsNewSection = () => {
  useEffect(() => {
    // Popupが開かれた = ユーザーが更新情報を目にする機会があった、という
    // ことなのでバッジを解消する。応答は使わないので待たない（fire-and-forget）。
    sendMessageWithTimeout<{ success: boolean }>({ action: 'acknowledgeWhatsNew' } as AcknowledgeWhatsNewMessage)
  }, [])

  const currentVersion = useMemo(() => chrome.runtime.getManifest().version, [])
  const current = useMemo(() => selectWhatsNewEntry(currentVersion), [currentVersion])
  const olderEntries = useMemo(
    () => WHATS_NEW_ENTRIES.filter(entry => entry.version !== current?.version),
    [current]
  )

  // キュレーション済みエントリが無い（例: 新しすぎるバージョンでこのファイルへ
  // まだ追記されていない）場合は何も描画しない -- 空のカードを見せるより、
  // セクションごと出さない方が誠実
  if (!current) return null

  return (
    <SectionCard>
      <SectionHeading>更新情報</SectionHeading>

      <EntryHeader entry={current} />
      <EntryPoints points={current.points} />

      {olderEntries.length > 0 && (
        <Box component="details" sx={{ mt: 1.5 }}>
          <Box
            component="summary"
            sx={{ cursor: 'pointer', fontSize: '0.8125rem', color: 'text.secondary', userSelect: 'none' }}
          >
            過去の更新情報（{olderEntries.length}件）
          </Box>
          {olderEntries.map(entry => (
            <Box key={entry.version} sx={{ mt: 1 }}>
              <EntryHeader entry={entry} />
              <EntryPoints points={entry.points} />
            </Box>
          ))}
        </Box>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 1.5 }}>
        <Link href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer" color="inherit">
          すべての変更を見る (GitHub Releases)
        </Link>
      </Typography>
    </SectionCard>
  )
}
