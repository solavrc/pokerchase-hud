/**
 * Simple numeric-dotted version comparator (e.g. `"5.1.0"` vs `"5.2"`).
 *
 * Used by the remote min-version gate (`src/services/min-version-gate.ts`) to
 * decide whether the running extension version is at least as new as the
 * `minSupportedVersion` published in Firestore. Deliberately not a full
 * semver implementation (no pre-release/build-metadata handling) — the
 * extension's own version scheme (`manifest.json`'s `version`) is always
 * numeric-dotted, and so is the value an owner would type into the remote
 * config doc.
 */

/**
 * Compares two numeric-dotted version strings segment by segment.
 * Missing trailing segments are treated as `0` (so `"5.1"` === `"5.1.0"`).
 *
 * Returns `-1` if `a < b`, `0` if equal, `1` if `a > b`, or `null` if either
 * string contains a non-numeric segment (callers must treat `null` as
 * "cannot compare" and fail open rather than block on it).
 */
export const compareVersions = (a: string, b: string): number | null => {
  const segmentsA = a.split('.')
  const segmentsB = b.split('.')
  const length = Math.max(segmentsA.length, segmentsB.length)

  for (let i = 0; i < length; i++) {
    const rawA = segmentsA[i] ?? '0'
    const rawB = segmentsB[i] ?? '0'
    // Reject anything that isn't a plain non-negative integer segment
    // (empty string, whitespace, "1a", "-1", etc.) rather than trusting
    // Number()'s permissive coercion (e.g. Number('') === 0, Number(' ') === 0).
    if (!/^\d+$/.test(rawA) || !/^\d+$/.test(rawB)) return null

    const numA = Number(rawA)
    const numB = Number(rawB)
    if (numA !== numB) return numA < numB ? -1 : 1
  }

  return 0
}

/**
 * `true` when `current` is strictly below `minimum`. Non-comparable inputs
 * (see `compareVersions`) return `false` — fail open, never block on a
 * version string we can't parse.
 */
export const isVersionBelow = (current: string, minimum: string): boolean => {
  const comparison = compareVersions(current, minimum)
  return comparison !== null && comparison < 0
}
