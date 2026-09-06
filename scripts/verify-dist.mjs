import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
function walk(dir) { return readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p] }) }
const files = walk('dist')
const { repository } = JSON.parse(readFileSync('deployment.config.json', 'utf8'))
const appPath = `/${repository}/`
const appUrl = new URL(appPath, 'https://pages.invalid')
const outputPaths = files.map(path => relative('dist', path).replaceAll('\\', '/'))
const assertions = []
function check(label, condition) { assertions.push({ label, passed: Boolean(condition) }) }
const source = walk('src').filter(p => !/\.test\.ts$/.test(p)).map(p => readFileSync(p, 'utf8')).join('\n')
const textFiles = files.filter(p => /\.(js|html|css|webmanifest)$/.test(p))
const distText = textFiles.map(p => readFileSync(p, 'utf8')).join('\n')
const html = readFileSync('dist/index.html', 'utf8')
const worker = readFileSync('dist/sw.js', 'utf8')
function existingAppAsset(reference) {
  const url = new URL(reference, appUrl)
  return url.origin === appUrl.origin && url.pathname.startsWith(appPath) && outputPaths.includes(url.pathname.slice(appPath.length))
}
check('No application upload, analytics or remote font code', !/\b(?:fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage)|https:\/\//.test(source))
check('No private keys or OpenAI-shaped API key literals in application and dist', !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-(?:proj-)?[A-Za-z0-9_-]{24,}/.test(source + distText))
check('No video fixture in dist', !files.some(p => /\.(mp4|mov|webm|rgb)$/i.test(p)))
check('Only static application assets are distributed, without reports, source maps, local paths or repository files', outputPaths.every(path => /\.(?:js|css|html|png|webmanifest)$/.test(path)) && !/handoff\/|evidence\/|node_modules\/|[A-Z]:[\\/](?:Users|Program Files)[\\/]/i.test(distText))
const manifest = JSON.parse(readFileSync('dist/manifest.webmanifest', 'utf8'))
check('Manifest id, start_url and scope match the confirmed repository subpath', manifest.id === appPath && manifest.start_url === appPath && manifest.scope === appPath)
check('Standalone Japanese manifest with real app-scoped icons', manifest.display === 'standalone' && manifest.lang === 'ja' && manifest.icons.length >= 2 && manifest.icons.every(icon => existingAppAsset(icon.src)))
const htmlAssets = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), match => match[1])
check('Every generated HTML script, style, manifest and icon reference resolves inside the application folder', htmlAssets.length >= 4 && htmlAssets.every(existingAppAsset))
check('Apple touch icon uses the repository subpath', html.includes(`rel="apple-touch-icon" href="${appPath}apple-touch-icon.png"`))
check('No site-root asset, manifest, icon or service-worker reference remains in distribution', !/["'`]\/(?:assets\/|sw\.js|index\.html|manifest\.webmanifest|apple-touch-icon\.png|icon-\d+\.png)/.test(distText))
const precacheReferences = Array.from(worker.matchAll(/"url":"([^"]+)"/g), match => match[1])
check('Injected precache URLs resolve to real files inside the application folder', precacheReferences.length > 0 && precacheReferences.every(existingAppAsset))
const precachePaths = precacheReferences.map(reference => new URL(reference, appUrl).pathname.slice(appPath.length))
check('Precache includes every distributed asset except the service worker itself', outputPaths.filter(path => path !== 'sw.js').every(path => precachePaths.includes(path)))
check('Service worker retains the application cache namespace and registration scope', worker.includes('ai-range-coach') && worker.includes('self.registration.scope'))
check('IndexedDB retains the existing application-specific database name', /DATABASE_NAME\s*=\s*['"]ai-range-coach['"]/.test(readFileSync('src/storage.ts', 'utf8')) && distText.includes('ai-range-coach'))
check('Service worker contains no skipWaiting', !worker.includes('skipWaiting'))
check('One source file input: video accept, no capture or multiple attributes', source.includes('type="file" accept="video/*"') && !/\b(?:multiple|capture)=/.test(source))
mkdirSync('evidence', { recursive: true })
writeFileSync('evidence/dist-verification.json', JSON.stringify({ at: new Date().toISOString(), repository, appPath, buildIds: [...new Set(distText.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?: \([a-f0-9]{12}\))?/g) || [])], assertions, precacheReferences, files: files.map(path => ({ path: relative('.', path).replaceAll('\\', '/'), bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) }, null, 2))
for (const item of assertions) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.label}`)
if (assertions.some(item => !item.passed)) process.exitCode = 1
