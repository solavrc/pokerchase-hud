import { build, BuildOptions, Plugin } from 'esbuild'
import { copyFileSync, mkdirSync } from 'fs'
import { parse } from 'path'
import { resolve } from 'path'
import manifest from './manifest.json'

const {
  background: { service_worker },
  content_scripts: [{ js: [content_script] }],
  web_accessible_resources: [{ resources: [web_accessible_resource] }]
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
  treeShaking: true,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
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
  ...(e2eManifestPlugin ? [e2eManifestPlugin] : [])]
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
