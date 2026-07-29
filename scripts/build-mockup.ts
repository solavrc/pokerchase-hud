import { build, context, type BuildOptions } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const outputDirectory = resolve('mockup-dist')
const shouldServe = process.argv.includes('--serve')

rmSync(outputDirectory, { force: true, recursive: true })
mkdirSync(outputDirectory, { recursive: true })
copyFileSync('mockup/index.html', resolve(outputDirectory, 'index.html'))

const options: BuildOptions = {
  bundle: true,
  define: {
    'process.env.NODE_ENV': '"development"',
  },
  entryNames: '[name]',
  entryPoints: {
    mockup: 'src/mockup/index.tsx',
    styles: 'src/mockup/styles.css',
  },
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
  outdir: outputDirectory,
  platform: 'browser',
  sourcemap: true,
  target: ['chrome123'],
}

if (shouldServe) {
  const buildContext = await context(options)
  await buildContext.watch()
  const server = await buildContext.serve({
    host: '127.0.0.1',
    port: 4173,
    servedir: outputDirectory,
  })
  console.log(`HUD visual mockup: http://127.0.0.1:${server.port}`)
} else {
  await build(options)
  console.log(`HUD visual mockup built in ${outputDirectory}`)
}
