import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const { repository } = JSON.parse(readFileSync(new URL('./deployment.config.json', import.meta.url), 'utf8')) as { repository: string }
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repository)) throw new Error('Invalid deployment repository name')
const base = `/${repository}/`
const commit = process.env.GITHUB_SHA?.match(/^[0-9a-f]{40}$/i)?.[0].slice(0, 12)
const buildId = `${new Date().toISOString()}${commit ? ` (${commit})` : ''}`

export default defineConfig({
  base,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [react(), VitePWA({
    strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts',
    base, scope: base, injectRegister: false, registerType: 'prompt',
    includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
    manifest: {
      id: base, name: 'AIレンジコーチ', short_name: 'レンジコーチ', lang: 'ja',
      start_url: base, scope: base, display: 'standalone',
      theme_color: '#164d3c', background_color: '#f5f5ee',
      icons: [
        { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    injectManifest: { globPatterns: ['**/*.{js,css,html,png,webmanifest}'] },
  })],
})
