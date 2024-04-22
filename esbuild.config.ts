import { context, BuildOptions, Plugin } from 'esbuild'
import { copyFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { parse } from 'path'
import { resolve, dirname } from 'path'
import manifest from './manifest.json'
import process from 'process'

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
    'src/' + parse(web_accessible_resource).name + '.ts'
  ],
  format: 'esm',
  outdir: 'dist',
  platform: 'browser',
  target: ['chrome123'],
  plugins: [{
    name: 'nodePolyfills',
    setup(build) {
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      build.onResolve({ filter: /^process$/ }, () => {
        /** `browser.js` OR `index.js` */
        return { path: resolve(__dirname, 'node_modules/process/browser.js') }
      })
      build.onResolve({ filter: /^events$/ }, () => {
        return { path: resolve(__dirname, 'node_modules/events/events.js') }
      })
      build.onResolve({ filter: /^buffer$/ }, () => {
        return { path: resolve(__dirname, 'node_modules/buffer/index.js') }
      })
      build.onResolve({ filter: /^stream$/ }, () => {
        return { path: resolve(__dirname, 'node_modules/stream-browserify/index.js') }
      })
    }
  }]
}

try {
  try {
    copyFileSync('src/index.html', 'dist/index.html')
    const buildContext = await context(options)
    if (process.argv.includes('--watch')) {
      await buildContext.watch()
      console.log('watch build succeeded')
    } else {
      await buildContext.rebuild()
      buildContext.dispose()
    }
  } catch (error) {
    console.error('esbuild build failed:', error)
  }
} catch (error) {
  process.exit(1)
}
