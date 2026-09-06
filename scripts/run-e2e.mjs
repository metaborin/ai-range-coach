import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const { repository } = JSON.parse(readFileSync('deployment.config.json', 'utf8'))
const externalUrl = process.env.DEPLOYED_APP_URL || process.env.E2E_BASE_URL
const appUrl = externalUrl || `http://127.0.0.1:4173/${repository}/`
const target = new URL(appUrl)
if (!['http:', 'https:'].includes(target.protocol) || target.pathname !== `/${repository}/` || target.search || target.hash) {
  throw new Error(`E2E target must end with /${repository}/ and have no query or fragment`)
}
if (process.env.DEPLOYED_APP_URL && target.protocol !== 'https:') throw new Error('DEPLOYED_APP_URL must use HTTPS')
let preview
let runner
const stop = () => { runner?.kill(); preview?.kill() }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  if (!externalUrl) {
    // Own the exact preview child, avoiding Windows npm-shell tree teardown hangs.
    await new Promise((resolveReady, reject) => {
      const probe = createServer()
      probe.once('error', () => reject(new Error('4173番ポートが使用中です。プレビューを停止してから、E2Eを再実行してください。')))
      probe.listen(4173, '127.0.0.1', () => probe.close(resolveReady))
    })
    preview = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { windowsHide: true, stdio: 'pipe' })
    preview.stdout.on('data', () => {})
    preview.stderr.on('data', data => process.stderr.write(data))
    let ready = false
    for (let i = 0; i < 50; i++) {
      if (preview.exitCode !== null) throw new Error('E2E用プレビューが起動できませんでした。')
      try { ready = (await fetch(appUrl, { signal: AbortSignal.timeout(500) })).ok } catch { /* startup */ }
      if (ready) break
      await delay(200)
    }
    if (!ready) throw new Error('E2E用プレビューの起動が時間内に完了しませんでした。')
  }
  console.log(`E2E target: ${appUrl}${externalUrl ? ' (existing deployment; isolated browser storage)' : ' (local production build)'}`)
  console.log('Worker A/B update and sibling-app scope checks use a separate local dist server.')
  runner = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit' })
  process.exitCode = await new Promise((resolveExit, reject) => { runner.once('error', reject); runner.once('exit', code => resolveExit(code ?? 1)) })
} finally {
  stop()
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
