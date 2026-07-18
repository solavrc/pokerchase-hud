/**
 * Generates the e2e-only manifest variant used by `npm run build:e2e`.
 *
 * The production `manifest.json` at the repo root is never modified. This
 * script reads it, clones it, and *prepends* a `http://localhost:<port>/*`
 * match pattern to `content_scripts[0].matches` and
 * `web_accessible_resources[0].matches` so that:
 *
 *   1. Chrome injects `content_script.js` on the local fixture page.
 *   2. `POKER_CHASE_ORIGIN` (src/constants/runtime.ts), which is computed at
 *      *build* time as `new URL(content_scripts[0].matches[0]).origin`,
 *      resolves to the fixture origin instead of the production game origin
 *      -- this is what lets the real `web_accessible_resource.ts` WebSocket
 *      hook's `window.postMessage` reach `content_script.ts`'s listener.
 *
 * The production match (`https://game.poker-chase.com/*`) is kept as a
 * second entry, so the change is additive: an extension built from this
 * manifest would still (in principle) work against the real game too.
 *
 * Output is written to `e2e/.build/manifest.e2e.json` (gitignored build
 * artifact) -- the checked-in root `manifest.json` is only ever read, never
 * written.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, BUILD_DIR, E2E_MANIFEST_PATH, FIXTURE_ORIGIN } from '../config.ts'

interface Manifest {
  content_scripts: Array<{ matches: string[]; js: string[] }>
  web_accessible_resources: Array<{ matches: string[]; resources: string[] }>
  [key: string]: unknown
}

export const generateE2EManifest = (): string => {
  const raw = readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf-8')
  const manifest: Manifest = JSON.parse(raw)

  const localMatch = `${FIXTURE_ORIGIN}/*`

  const firstContentScript = manifest.content_scripts[0]
  if (!firstContentScript) throw new Error('manifest.json: content_scripts[0] missing')
  firstContentScript.matches = [localMatch, ...firstContentScript.matches]

  const firstWAR = manifest.web_accessible_resources[0]
  if (!firstWAR) throw new Error('manifest.json: web_accessible_resources[0] missing')
  firstWAR.matches = [localMatch, ...firstWAR.matches]

  mkdirSync(BUILD_DIR, { recursive: true })
  writeFileSync(E2E_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

  return E2E_MANIFEST_PATH
}

// Allow `tsx e2e/tools/generate-e2e-manifest.ts` as a standalone CLI step.
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = generateE2EManifest()
  console.log(`[generate-e2e-manifest] wrote ${path}`)
}
