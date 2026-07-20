/**
 * Unit tests for What's New entry selection (src/constants/whats-new.ts).
 */
import { selectWhatsNewEntry, type WhatsNewEntry } from './whats-new'

// Deliberately independent fixture (newest first) rather than the real
// WHATS_NEW_ENTRIES, so these tests stay stable as sola edits actual copy.
const FIXTURE_ENTRIES: WhatsNewEntry[] = [
  { version: '5.2.0', date: '2026-07-20', title: 'v5.2.0', points: [{ text: 'a' }] },
  { version: '5.1.0', date: '2026-07-18', title: 'v5.1.0', points: [{ text: 'b' }] },
  { version: '5.0.0', date: '2026-07-09', title: 'v5.0.0', points: [{ text: 'c' }] },
]

describe('selectWhatsNewEntry', () => {
  it('returns the exact-match entry when the current version has a curated entry', () => {
    expect(selectWhatsNewEntry('5.1.0', FIXTURE_ENTRIES)?.version).toBe('5.1.0')
  })

  it('falls back to the newest entry <= current version when there is no exact match (e.g. an uncurated patch bump)', () => {
    expect(selectWhatsNewEntry('5.2.3', FIXTURE_ENTRIES)?.version).toBe('5.2.0')
  })

  it('falls back across a full version gap (missing minor entry)', () => {
    expect(selectWhatsNewEntry('5.1.7', FIXTURE_ENTRIES)?.version).toBe('5.1.0')
  })

  it('returns undefined when current version is older than every curated entry', () => {
    expect(selectWhatsNewEntry('4.9.0', FIXTURE_ENTRIES)).toBeUndefined()
  })

  it('returns undefined for an empty entries list', () => {
    expect(selectWhatsNewEntry('5.2.0', [])).toBeUndefined()
  })

  it('ignores non-numeric-dotted current versions gracefully (fails open to undefined, never throws)', () => {
    expect(() => selectWhatsNewEntry('not-a-version', FIXTURE_ENTRIES)).not.toThrow()
    expect(selectWhatsNewEntry('not-a-version', FIXTURE_ENTRIES)).toBeUndefined()
  })

  it('treats missing trailing segments as zero (5.2 === 5.2.0)', () => {
    expect(selectWhatsNewEntry('5.2', FIXTURE_ENTRIES)?.version).toBe('5.2.0')
  })

  it('defaults to the real WHATS_NEW_ENTRIES export when no entries arg is passed', () => {
    // Smoke test: the default param wires up to the real curated list.
    // Uses the test-setup.ts chrome.runtime.getManifest() default ('5.1.0'),
    // which must have a curated entry for Popup.test.tsx et al. to render
    // without crashing.
    expect(selectWhatsNewEntry('5.1.0')).toBeDefined()
  })
})
