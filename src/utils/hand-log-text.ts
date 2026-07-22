import type { HandLogEntry } from '../types/hand-log'

/**
 * HandLogProcessor が生成した行を PokerStars 形式の1ハンドへ直列化する。
 * HUDのコピー、エクスポート、Service Worker consoleで同じ行順・改行を使う。
 */
export const formatHandLogEntries = (
  entries: ReadonlyArray<Pick<HandLogEntry, 'text'>>
): string => entries.map(entry => entry.text).join('\n')
