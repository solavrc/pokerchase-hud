/**
 * Shared configuration for the E2E QA harness.
 *
 * A single source of truth for the fixture server port/origin, filesystem
 * layout, and the pinned Chrome for Testing build. Every other e2e module
 * (manifest generator, fixture server, harness, scenarios) imports from
 * here so they can never drift out of sync with each other.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Directory containing this file: `<repo>/e2e` */
export const E2E_DIR = __dirname
/** Repo root (parent of `e2e/`) */
export const REPO_ROOT = join(__dirname, '..')

/**
 * Port the fixture HTTP+WebSocket server listens on. Must stay in sync with
 * the origin baked into the e2e manifest by `tools/generate-e2e-manifest.ts`
 * (POKER_CHASE_ORIGIN is derived from `content_scripts[0].matches[0]` at
 * extension build time, so changing this after `npm run build:e2e` requires
 * rebuilding). Override with E2E_FIXTURE_PORT for local debugging only.
 */
export const FIXTURE_PORT = Number(process.env.E2E_FIXTURE_PORT || 18923)
export const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`

/** Build-time artifacts (generated manifest + built e2e extension). Gitignored. */
export const BUILD_DIR = join(E2E_DIR, '.build')
export const E2E_MANIFEST_PATH = join(BUILD_DIR, 'manifest.e2e.json')
export const EXTENSION_DIR = join(BUILD_DIR, 'extension')
export const EXTENSION_DIST_DIR = join(EXTENSION_DIR, 'dist')

/** Downloaded Chrome for Testing binaries. Gitignored, reused across runs. */
export const BROWSER_CACHE_DIR = join(E2E_DIR, '.cache')

/**
 * Chrome for Testing build to install/launch. Pinned (not "stable") so runs
 * are reproducible and don't trigger a re-download just because upstream
 * Chrome shipped a new version. Bump deliberately; see e2e/README.md.
 * Source: https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json
 * (channel "Stable" as of 2026-07-18)
 */
export const CHROME_BUILD_ID = process.env.E2E_CHROME_BUILD_ID || '151.0.7922.34'

/** Default fixture replayed by the smoke scenario / CLI when none is given. */
export const DEFAULT_FIXTURE = join(E2E_DIR, 'fixtures', 'session-3hands.ndjson')

/** Default directory for screenshots / DOM snapshots written by the CLI. */
export const DEFAULT_OUTPUT_DIR = join(E2E_DIR, 'out')

/** Static assets (fixture HTML page) served by the fixture server. */
export const PUBLIC_DIR = join(E2E_DIR, 'public')
