const options = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome123']
}

require('esbuild').build({
  entryPoints: ['src/content_script.ts'],
  outfile: 'dist/content_script.js',
  ...options
}).catch(() => process.exit(1))

require('esbuild').build({
  entryPoints: ['src/inject.ts'],
  outfile: 'dist/inject.js',
  ...options
}).catch(() => process.exit(1))
