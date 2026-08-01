import { build, BuildOptions, Plugin } from 'esbuild'
import { sentryEsbuildPlugin } from '@sentry/esbuild-plugin'
import { execFileSync } from 'child_process'
import { copyFileSync, mkdirSync } from 'fs'
import { parse } from 'path'
import { resolve } from 'path'
import manifest from '../manifest.json'

const {
  background: { service_worker },
  content_scripts: [{ js: [content_script] }],
  // web_accessible_resource: WebSocket傍受（HUDの土台、常時注入）。
  // replay_bridge: リプレイ傍受（実験フラグ有効時のみ content_script が注入）。
  // どちらも WAR として dist/ へ出す必要があるので両方をエントリポイントにする。
  web_accessible_resources: [{ resources: [web_accessible_resource, replay_bridge] }]
} = manifest

// --- E2E QA harness support (see e2e/README.md) ---------------------------
// Both env vars are unset during the normal `npm run build`, so production
// output (outdir/manifest resolution) is completely unaffected. Set by
// `e2e/tools/build-e2e.ts` only.
//   E2E_OUTDIR   - build into this directory instead of `dist/`
//   E2E_MANIFEST - redirect every `manifest.json` import resolved while
//                  bundling (content_script.ts, background.ts,
//                  constants/runtime.ts) to this file instead of the real
//                  repo-root manifest.json, so POKER_CHASE_ORIGIN resolves
//                  to the e2e fixture origin in the e2e build only.
const outdir = process.env.E2E_OUTDIR || 'dist'
const e2eManifestOverride = process.env.E2E_MANIFEST

// --- Sentry telemetry build identity --------------------------------------
// Diagnostics are opt-in, so the maintainer's own play sessions are a primary
// source of signal -- especially schema-validation failures, which is how a
// PokerChase payload change becomes visible at all (see "Incident Diagnosis
// Practices" in AGENTS.md). Those events are captureMessage + structured
// context and need no source maps, so a build without an upload token is still
// worth reporting from. Telemetry is therefore compiled into every build except
// E2E; what changes between a release and a working build is only its identity.
//
//   SENTRY_ENVIRONMENT=production  - release workflow marker. Claims the plain
//                                    `pokerchase-hud@<version>` release name,
//                                    which the uploaded source maps belong to.
//   (unset)                        - a working build. Reports under
//                                    environment=development and a distinct
//                                    `+dev.<sha>` release, so it can never be
//                                    symbolicated against, or counted toward,
//                                    the published release.
//   SENTRY_DISABLED=true           - compile telemetry out entirely.
//
// The runtime per-profile opt-in and optional host grant still gate every
// build: a contributor who never enables 診断情報を送信 reports nothing.
const isProductionRelease = process.env.SENTRY_ENVIRONMENT === 'production'
const sentryEnabled =
  !e2eManifestOverride && process.env.SENTRY_DISABLED !== 'true'
const sentryUploadEnabled =
  sentryEnabled && Boolean(process.env.SENTRY_AUTH_TOKEN)
const sentryEnvironment = isProductionRelease ? 'production' : 'development'

/**
 * Short commit of the working build, with a `-dirty` marker when the tree has
 * uncommitted changes -- the marker is the point: it says the commit alone does
 * not identify what is running. Falls back to `unknown` outside a git checkout.
 */
const resolveBuildRevision = (): string => {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const revision = git('rev-parse', '--short', 'HEAD')
    return git('status', '--porcelain') ? `${revision}-dirty` : revision
  } catch {
    return 'unknown'
  }
}

const sentryRelease = isProductionRelease
  ? `pokerchase-hud@${manifest.version}`
  : `pokerchase-hud@${manifest.version}+dev.${resolveBuildRevision()}`

if (isProductionRelease && !sentryUploadEnabled) {
  console.warn(
    '[Sentry] Building a production release without SENTRY_AUTH_TOKEN; ' +
    'no source maps will be uploaded.'
  )
}
if (sentryEnabled) {
  console.log(`[Sentry] ${sentryEnvironment} build, release ${sentryRelease}`)
}
const e2eManifestPlugin: Plugin | undefined = e2eManifestOverride ? {
  name: 'e2e-manifest-override',
  setup(build) {
    const overridePath = resolve(process.cwd(), e2eManifestOverride)
    build.onResolve({ filter: /manifest\.json$/ }, () => ({ path: overridePath }))
  }
} : undefined
// ---------------------------------------------------------------------------

const options: BuildOptions = {
  bundle: true,
  entryPoints: [
    'src/' + parse(content_script).name + '.ts',
    'src/' + parse(service_worker).name + '.ts',
    'src/' + parse(web_accessible_resource).name + '.ts',
    'src/' + parse(replay_bridge).name + '.ts',
    'src/popup.ts',
    // Tiny synchronous, non-module boot script loaded in index.html's
    // <head> before popup.js -- see src/popup-boot.ts for why (eliminates
    // the white-flash-before-paint bug, fix/popup-white-flash). Emitted as
    // popup-boot.js alongside popup.js; no manifest change needed since
    // it's referenced only from index.html, not `manifest.json`.
    'src/popup-boot.ts'
  ],
  format: 'iife',
  logLevel: 'info',
  outdir,
  platform: 'browser',
  target: ['chrome123'],
  minify: true,
  sourcemap: sentryUploadEnabled ? 'external' : false,
  treeShaking: true,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.SENTRY_ENABLED': JSON.stringify(
      sentryEnabled ? 'true' : 'false'
    ),
    'process.env.SENTRY_ENVIRONMENT': JSON.stringify(sentryEnvironment),
    'process.env.SENTRY_RELEASE': JSON.stringify(sentryRelease),
    // ReadEntityStreamのキャッシュ無効化フラグ。ブラウザ（Service Worker）実行時には
    // 環境変数を設定する手段がそもそも無いため、ビルド時にfalseへ畳み込むことで
    // `process`オブジェクトへのランタイム依存を無くす（Node上のjestではテスト変換経由の
    // ためこのdefineは適用されず、実際の`process.env.DEBUG_NO_CACHE`を参照できる）。
    'process.env.DEBUG_NO_CACHE': 'false'
  },
  external: [],
  plugins: [{
    name: 'alias',
    setup(build) {
      // Material-UI optimizations
      build.onResolve({ filter: /^@mui\/material$/ }, () => ({
        path: '@mui/material/index.js',
        external: false
      }))
    }
  },
  ...(e2eManifestPlugin ? [e2eManifestPlugin] : []),
  ...(sentryUploadEnabled
    ? [sentryEsbuildPlugin({
        org: 'sola-works',
        project: 'pokerchase-hud',
        authToken: process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        release: {
          name: sentryRelease,
          inject: true,
          create: true,
          finalize: true
        },
        sourcemaps: {
          assets: [
            `${outdir}/**/*.js`,
            `${outdir}/**/*.js.map`
          ],
          filesToDeleteAfterUpload: `${outdir}/**/*.js.map`
        },
        bundleSizeOptimizations: {
          excludeDebugStatements: true,
          excludeTracing: true,
          excludeReplayShadowDom: true,
          excludeReplayIframe: true,
          excludeReplayWorker: true
        }
      })]
    : [])]
}

try {
  mkdirSync(outdir, { recursive: true })
  copyFileSync('src/index.html', `${outdir}/index.html`)
  await build(options)
  console.log('Build succeeded')
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
