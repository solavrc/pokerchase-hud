import { build, BuildOptions } from 'esbuild'
import { copyFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { parse } from 'path'
import { resolve, dirname } from 'path'
import manifest from './manifest.json'

const {
  background: { service_worker },
  content_scripts: [{ js: [content_script] }],
  web_accessible_resources: [{ resources: [web_accessible_resource] }]
} = manifest

const options: BuildOptions = {
  bundle: true,
  entryPoints: [
    'src/' + parse(content_script).name + '.ts',
    'src/' + parse(service_worker).name + '.ts',
    'src/' + parse(web_accessible_resource).name + '.ts',
    'src/popup.ts'
  ],
  format: 'iife',
  logLevel: 'info',
  outdir: 'dist',
  platform: 'browser',
  target: ['chrome123'],
  minify: true,
  treeShaking: true,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    // ReadEntityStreamのキャッシュ無効化フラグ。ブラウザ（Service Worker）実行時には
    // 環境変数を設定する手段がそもそも無いため、ビルド時にfalseへ畳み込むことで
    // `process`オブジェクトへのランタイム依存を無くす（Node上のjestではts-jest経由の
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
  }, {
    name: 'nodePolyfills',
    setup(build) {
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      build.onResolve({ filter: /^events$/ }, () => {
        return { path: resolve(__dirname, 'node_modules/events/events.js') }
      })
    }
  }]
}

try {
  mkdirSync('dist', { recursive: true })
  copyFileSync('src/index.html', 'dist/index.html')
  await build(options)
  console.log('Build succeeded')
} catch (error) {
  console.error('Build failed:', error)
  process.exit(1)
}
