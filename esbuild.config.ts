import { context, BuildOptions } from 'esbuild'
import { copyFileSync } from 'fs'
import { parse } from 'path'
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
    'src/' + parse(web_accessible_resource).name + '.ts'
  ],
  format: 'esm',
  outdir: 'dist',
  platform: 'browser',
  target: ['chrome123']
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
