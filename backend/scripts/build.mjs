import { build } from 'esbuild'
await build({
  entryPoints: ['src/index.ts'], outdir: 'dist', entryNames: 'worker', outExtension: { '.js': '.mjs' },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:workers'], sourcemap: false, minify: false,
})
