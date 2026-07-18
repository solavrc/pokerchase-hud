/**
 * `npm run build:e2e` -- assembles a loadable, unpacked extension directory
 * at `e2e/.build/extension/` (gitignored) for the QA harness:
 *
 *   1. generate-e2e-manifest.ts writes the e2e manifest variant (adds a
 *      `http://localhost:<port>/*` match; production manifest.json is only
 *      ever read, never modified -- see that file for why this makes
 *      POKER_CHASE_ORIGIN resolve to the fixture origin).
 *   2. esbuild.config.ts is invoked with E2E_MANIFEST/E2E_OUTDIR so it
 *      bundles src/ against the e2e manifest into e2e/.build/extension/dist
 *      (dist/ at the repo root, used by `npm run build`, is untouched).
 *   3. The generated manifest and icons/ are copied alongside dist/ so the
 *      directory is a complete unpacked-extension load target.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateE2EManifest } from './generate-e2e-manifest.ts'
import { REPO_ROOT, E2E_MANIFEST_PATH, EXTENSION_DIR, EXTENSION_DIST_DIR } from '../config.ts'

export const buildE2E = (): string => {
  generateE2EManifest()

  execFileSync('npx', ['tsx', 'esbuild.config.ts'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_MANIFEST: E2E_MANIFEST_PATH,
      E2E_OUTDIR: EXTENSION_DIST_DIR,
    },
  })

  mkdirSync(EXTENSION_DIR, { recursive: true })
  copyFileSync(E2E_MANIFEST_PATH, join(EXTENSION_DIR, 'manifest.json'))
  cpSync(join(REPO_ROOT, 'icons'), join(EXTENSION_DIR, 'icons'), { recursive: true })

  return EXTENSION_DIR
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = buildE2E()
  console.log(`[build-e2e] extension ready at ${dir}`)
}
