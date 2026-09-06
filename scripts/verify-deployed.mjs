import { chromium, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const { repository } = JSON.parse(readFileSync('deployment.config.json', 'utf8'))
const url = new URL(process.env.DEPLOYED_APP_URL || '')
const base = `/${repository}/`
if (url.protocol !== 'https:' || url.pathname !== base || url.search || url.hash) throw new Error('Set DEPLOYED_APP_URL to the exact HTTPS app URL')
const expectedCommit = process.env.EXPECTED_COMMIT
if (expectedCommit && !/^[a-f0-9]{40}$/i.test(expectedCommit)) throw new Error('EXPECTED_COMMIT must be a full commit SHA')
mkdirSync('evidence', { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const responses = []
context.on('response', response => {
  if (/^https?:/.test(response.url())) responses.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] || '' })
})
try {
  const page = await context.newPage()
  const documentResponse = await page.goto(url.href, { waitUntil: 'networkidle' })
  expect(documentResponse.status()).toBe(200)
  expect(page.url()).toBe(url.href)
  await expect(page.getByRole('button', { name: '1球の動画を選ぶ' })).toBeVisible()
  const assetUrls = await page.locator('script[src],link[href]').evaluateAll(elements => elements.map(element => element.getAttribute('src') || element.getAttribute('href')))
  for (const reference of assetUrls) {
    const asset = new URL(reference, page.url())
    expect(asset.origin).toBe(url.origin)
    expect(asset.pathname.startsWith(base)).toBe(true)
    const response = await page.request.get(asset.href)
    expect(response.status()).toBe(200)
    const type = response.headers()['content-type'] || ''
    if (asset.pathname.endsWith('.js')) expect(type).toMatch(/javascript/)
    if (asset.pathname.endsWith('.css')) expect(type).toMatch(/text\/css/)
    if (asset.pathname.endsWith('.png')) expect(Array.from((await response.body()).subarray(0, 8))).toEqual([137,80,78,71,13,10,26,10])
  }
  const manifestResponse = await page.request.get(new URL('manifest.webmanifest', url).href)
  expect(manifestResponse.status()).toBe(200)
  const manifest = await manifestResponse.json()
  expect(manifest).toMatchObject({ id: base, start_url: base, scope: base, display: 'standalone' })
  for (const icon of manifest.icons) {
    expect(new URL(icon.src, url).pathname.startsWith(base)).toBe(true)
    const response = await page.request.get(new URL(icon.src, url).href)
    expect(response.status()).toBe(200)
    expect(Array.from((await response.body()).subarray(0, 8))).toEqual([137,80,78,71,13,10,26,10])
  }
  const swResponse = await page.request.get(new URL('sw.js', url).href)
  expect(swResponse.status()).toBe(200)
  expect(swResponse.headers()['content-type']).toMatch(/javascript/)
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return { secure: isSecureContext, scope: registration?.scope, state: registration?.active?.state, controller: navigator.serviceWorker.controller?.scriptURL }
  }), { timeout: 20000 }).toEqual({ secure: true, scope: url.href, state: 'activated', controller: new URL('sw.js', url).href })
  await page.getByText('ホーム画面・オフラインの準備', { exact: true }).click()
  await page.getByRole('button', { name: 'オフラインの準備を確認', exact: true }).click()
  await expect(page.getByText(/オフライン準備完了：/)).toBeVisible()
  const build = await page.locator('.pwa-info small').innerText()
  if (expectedCommit) expect(build).toContain(expectedCommit.slice(0, 12))
  const cacheAudit = await page.evaluate(async () => Promise.all((await caches.keys()).map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) }))))
  expect(cacheAudit.length).toBeGreaterThan(0)
  for (const cache of cacheAudit) {
    expect(cache.name.startsWith('ai-range-coach-')).toBe(true)
    for (const cachedUrl of cache.urls) {
      const entry = new URL(cachedUrl)
      expect(entry.origin).toBe(url.origin)
      expect(entry.pathname.startsWith(base)).toBe(true)
    }
  }
  expect(responses.every(response => response.status >= 200 && response.status < 400 && new URL(response.url).pathname.startsWith(base))).toBe(true)
  await page.screenshot({ path: 'evidence/deployed-mobile.png', fullPage: true })
  const result = { checkedAt: new Date().toISOString(), url: page.url(), build, expectedCommit, browser: browser.version(), manifest, assetUrls, cacheAudit, responses, result: 'passed', iPhone: 'not tested' }
  writeFileSync('evidence/deployed-verification.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ result: result.result, url: result.url, build, browser: result.browser, assets: assetUrls.length, scope: url.href, iPhone: result.iPhone }, null, 2))
} finally { await context.close(); await browser.close() }
