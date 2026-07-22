import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import { useEffect, useId, useMemo, useState } from 'react'
import {
  GITHUB_RELEASES_URL,
  WHATS_NEW_ENTRIES,
  selectWhatsNewEntry,
  type WhatsNewEntry,
} from '../../constants/whats-new'
import type { AcknowledgeWhatsNewMessage } from '../../types/messages'
import { compareVersions } from '../../utils/version-compare'
import { SectionCard } from './SectionCard'
import { SectionHeading } from './SectionHeading'
import { sendMessageWithTimeout } from './send-message'

const FEATURED_ENTRY_COUNT = 2
const COLLAPSED_POINT_COUNT = 2

interface WhatsNewSectionProps {
  /** Test seam; production always uses the curated newest-first list. */
  entries?: WhatsNewEntry[]
}

const disclosureButtonSx = {
  minWidth: 0,
  p: 0,
  mt: 0.5,
  fontSize: '0.75rem',
  lineHeight: 1.4,
  textTransform: 'none',
}

const EntryHeader = ({ entry, id }: { entry: WhatsNewEntry, id?: string }) => (
  <Typography id={id} variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
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

const FeaturedEntry = ({ entry, isFirst }: { entry: WhatsNewEntry, isFirst: boolean }) => {
  const [expanded, setExpanded] = useState(false)
  const headingId = useId()
  const pointsId = useId()
  const isLong = entry.points.length > COLLAPSED_POINT_COUNT
  const visiblePoints = isLong && !expanded
    ? entry.points.slice(0, COLLAPSED_POINT_COUNT)
    : entry.points

  return (
    <Box component="article" aria-labelledby={headingId} sx={{ mt: isFirst ? 0 : 1.5 }}>
      <EntryHeader entry={entry} id={headingId} />
      <Box id={pointsId}>
        <EntryPoints points={visiblePoints} />
      </Box>
      {isLong && (
        <Button
          size="small"
          variant="text"
          aria-expanded={expanded}
          aria-controls={pointsId}
          aria-label={`v${entry.version}の更新情報を${expanded ? '折りたたむ' : '続きを読む'}`}
          onClick={() => setExpanded(current => !current)}
          sx={disclosureButtonSx}
        >
          {expanded ? '折りたたむ' : '続きを読む'}
        </Button>
      )}
    </Box>
  )
}

/**
 * 更新情報（What's New）セクション。実行中バージョン以下の最新2件を最初から
 * 表示し、長い本文だけをエントリ内の「続きを読む」で省略する。3件目以前は
 * 「過去の更新情報」にまとめ、設定操作へ早く到達できる初期高さを保つ。
 *
 * マウント時に`acknowledgeWhatsNew`メッセージ（`message-router.ts`→
 * `src/background/whats-new-badge.ts`）を送り、拡張機能アイコンのバッジ
 * （未読があれば）を解消する。未読が無い状態で送っても副作用は無い（冪等）。
 */
export const WhatsNewSection = ({ entries = WHATS_NEW_ENTRIES }: WhatsNewSectionProps) => {
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const historyId = useId()

  useEffect(() => {
    // Popupが開かれた = ユーザーが更新情報を目にする機会があった、という
    // ことなのでバッジを解消する。応答は使わないので待たない（fire-and-forget）。
    sendMessageWithTimeout<{ success: boolean }>({ action: 'acknowledgeWhatsNew' } as AcknowledgeWhatsNewMessage)
  }, [])

  const currentVersion = useMemo(() => chrome.runtime.getManifest().version, [])
  const current = useMemo(() => selectWhatsNewEntry(currentVersion, entries), [currentVersion, entries])
  // current以下だけを残すことで、リリース前に先行追加された未来のエントリを
  // 最新2件にも過去の折りたたみにも混ぜない（PR #172のfuture-entry guard）。
  const availableEntries = useMemo(
    () => entries.filter(entry => {
      if (!current) return false
      const cmp = compareVersions(entry.version, current.version)
      return cmp !== null && cmp <= 0
    }),
    [current, entries]
  )
  const featuredEntries = availableEntries.slice(0, FEATURED_ENTRY_COUNT)
  const historyEntries = availableEntries.slice(FEATURED_ENTRY_COUNT)

  // キュレーション済みエントリが無い（例: 全エントリより古いバージョン）の
  // 場合は空のカードを描画しない。
  if (!current) return null

  return (
    <SectionCard>
      <SectionHeading>更新情報</SectionHeading>

      {featuredEntries.map((entry, index) => (
        <FeaturedEntry key={entry.version} entry={entry} isFirst={index === 0} />
      ))}

      {historyEntries.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Button
            size="small"
            variant="text"
            aria-expanded={historyExpanded}
            aria-controls={historyId}
            onClick={() => setHistoryExpanded(currentExpanded => !currentExpanded)}
            sx={{ ...disclosureButtonSx, mt: 0 }}
          >
            {historyExpanded ? '▼' : '▶'} 過去の更新情報（{historyEntries.length}件）
          </Button>
          <Box id={historyId} hidden={!historyExpanded}>
            {historyEntries.map(entry => (
              <Box component="article" key={entry.version} sx={{ mt: 1 }}>
                <EntryHeader entry={entry} />
                <EntryPoints points={entry.points} />
              </Box>
            ))}
          </Box>
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
