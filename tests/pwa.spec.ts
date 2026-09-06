import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const scenes = ['アドレス', 'トップ', 'インパクト付近', 'フィニッシュ']
const { repository } = JSON.parse(readFileSync('deployment.config.json', 'utf8')) as { repository: string }
const appPath = `/${repository}/`

async function saveRealVideoRecord(page: Page) {
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/synthetic.webm')
  const capture = page.getByRole('button', { name: 'この場面にする', exact: true })
  await expect(capture).toBeEnabled()
  for (let index = 0; index < scenes.length; index++) {
    await page.getByRole('slider', { name: 'タイムライン' }).fill(String(index + 0.5))
    await expect(capture).toBeEnabled()
    await capture.click()
    await expect(page.getByAltText(scenes[index], { exact: true })).toBeVisible()
    await expect(capture).toBeEnabled()
  }
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click()
  await page.getByRole('group', { name: /当たり/ }).getByRole('button', { name: 'わからない', exact: true }).click()
  await page.getByRole('button', { name: 'ほぼまっすぐ', exact: true }).click()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
  await expect(page.getByText('保存しました', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled()
}

async function expectDecodedSavedMedia(page: Page) {
  for (const label of scenes) {
    const image = page.getByAltText(label, { exact: true })
    await expect(image).toBeVisible()
    expect(await image.evaluate(async (element: HTMLImageElement) => {
      await element.decode()
      return element.naturalWidth > 0 && element.naturalHeight > 0 && Math.max(element.naturalWidth, element.naturalHeight) <= 1280
    })).toBe(true)
  }
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '再生', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  await page.getByRole('button', { name: '一時停止', exact: true }).click()
  await expect(page.getByText('未分析。分析しなくても、この記録を保存できます。', { exact: true })).toBeVisible()
  for (const time of ['0.50', '1.50', '2.50', '3.50']) await expect(page.getByText(`指定 ${time} 秒`, { exact: false })).toBeVisible()
}

async function expectActiveControlledWorker(page: Page) {
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return registration?.active?.state === 'activated' && Boolean(navigator.serviceWorker.controller)
  })).toBe(true)
  const expectedScope = new URL(appPath, page.url()).href
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBe(expectedScope)
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${expectedScope}sw.js`)
}

test('production manifest / static cache and offline restart restore a saved real video and four JPEGs', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Desktop Chromium PWA automation; does not represent an iPhone PWA result.')
  const requests: { url: string; method: string }[] = []
  context.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))
  await page.goto('./')
  await expectActiveControlledWorker(page)
  await page.getByText('ホーム画面・オフラインの準備', { exact: true }).click()
  await page.getByRole('button', { name: 'オフラインの準備を確認', exact: true }).click()
  await expect(page.getByText(/オフライン準備完了：/)).toBeVisible()
  const manifestResponse = await page.request.get(`${appPath}manifest.webmanifest`)
  expect(manifestResponse.ok()).toBe(true)
  const manifest = await manifestResponse.json()
  expect(manifest).toMatchObject({ id: appPath, name: 'AIレンジコーチ', start_url: appPath, scope: appPath, display: 'standalone', lang: 'ja' })
  for (const icon of manifest.icons as { src: string; sizes: string }[]) {
    expect(new URL(icon.src, page.url()).pathname.startsWith(appPath)).toBe(true)
    expect(['192x192', '512x512']).toContain(icon.sizes)
    const response = await page.request.get(icon.src)
    expect(response.ok()).toBe(true)
    expect(Array.from((await response.body()).subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  }
  await saveRealVideoRecord(page)
  const cachedRequests = await page.evaluate(async () => {
    const names = await caches.keys()
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => ({ url: request.url, method: request.method }))))).flat()
  })
  expect(cachedRequests.length).toBeGreaterThan(0)
  expect((await page.evaluate(() => caches.keys())).every(name => name.startsWith('ai-range-coach-'))).toBe(true)
  const origin = new URL(page.url()).origin
  for (const request of cachedRequests) {
    const url = new URL(request.url)
    expect(url.origin).toBe(origin)
    expect(url.pathname.startsWith(appPath)).toBe(true)
    expect(url.pathname).toMatch(/\.(?:js|css|html|png|webmanifest)$/)
    expect(request.method).toBe('GET')
  }
  // The actual original video and all frames live only in IndexedDB, not Cache Storage.
  expect(cachedRequests.some((request) => request.url.startsWith('blob:') || /\.(?:webm|mp4|mov|jpe?g)$/i.test(new URL(request.url).pathname))).toBe(false)
  for (const request of requests.filter((request) => /^https?:/.test(request.url))) {
    expect(new URL(request.url).origin).toBe(origin)
    expect(request.method).toBe('GET')
  }
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('button', { name: '記録を開く', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: '記録を開く', exact: true }).click()
  await expectDecodedSavedMedia(page)
  const auditPath = test.info().outputPath('static-cache-audit.json')
  const screenshotPath = test.info().outputPath('offline-restored-record.png')
  await writeFile(auditPath, JSON.stringify({ targetUrl: page.url(), build: await page.locator('.pwa-info small').innerText(), manifest, cachedRequests, requests }, null, 2))
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await test.info().attach('static-cache-audit.json', { path: auditPath, contentType: 'application/json' })
  await test.info().attach('offline-restored-record.png', { path: screenshotPath, contentType: 'image/png' })
  await context.setOffline(false)
})

test('[local dist] changed worker waits without reloading an unsaved draft; closing old clients retains saved data and sibling app storage', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Desktop Chromium worker lifecycle test; iPhone update verification remains separate.')
  // Updated service-worker main scripts cannot be intercepted by Playwright routes.
  // This isolated server reads dist without changing it or the shared preview server.
  const root = resolve('dist')
  let revision = 'A'
  const servedWorkerRevisions: string[] = []
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  }
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname
      if (pathname === '/' || pathname === '/other-app/') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        response.end('<!doctype html><title>Other application scope probe</title><p>Sibling application</p>')
        return
      }
      if (!pathname.startsWith(appPath)) { response.writeHead(404); response.end(); return }
      const withinApp = pathname.slice(appPath.length) || 'index.html'
      const file = resolve(root, withinApp)
      if (!file.startsWith(root + sep)) { response.writeHead(403); response.end(); return }
      try {
        let body = await readFile(file)
        if (pathname === `${appPath}sw.js`) {
          servedWorkerRevisions.push(revision)
          body = Buffer.concat([body, Buffer.from(`\n// PWA lifecycle test revision ${revision}\n`)])
        }
        response.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
        response.end(body)
      } catch { response.writeHead(404); response.end() }
    })()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a local TCP port')
  const origin = `http://127.0.0.1:${address.port}`
  const context = await browser.newContext()
  try {
    // Seed a different app's Cache Storage and IndexedDB before this app installs.
    // They share an origin; namespacing is collision avoidance, not a security boundary.
    const sibling = await context.newPage()
    await sibling.goto(`${origin}/other-app/`)
    await sibling.evaluate(async () => {
      await (await caches.open('other-app-cache-v1')).put('/other-app/keep.txt', new Response('keep-cache'))
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('other-app-database', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('values')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction('values', 'readwrite')
          transaction.objectStore('values').put('keep-database', 'sentinel')
          transaction.oncomplete = () => { database.close(); resolve() }
          transaction.onabort = () => { database.close(); reject(transaction.error) }
        }
      })
    })
    const page = await context.newPage()
    await page.goto(`${origin}${appPath}`)
    await expectActiveControlledWorker(page)
    await sibling.reload()
    expect(await sibling.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    expect(await sibling.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBeUndefined()
    await saveRealVideoRecord(page)
    await page.getByRole('button', { name: '編集', exact: true }).click()
    await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click()
    await page.getByRole('button', { name: '良い', exact: true }).click()
    await expect(page.getByText('未保存', { exact: true })).toBeVisible()
    const pageBeforeUpdate = await page.evaluate(() => performance.timeOrigin)
    revision = 'B'
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update() })
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe('installed')
    expect(servedWorkerRevisions).toContain('B')
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(pageBeforeUpdate)
    await expect(page.getByRole('button', { name: '良い', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('未保存', { exact: true })).toBeVisible()
    await page.getByText('ホーム画面・オフラインの準備', { exact: true }).click()
    await expect(page.getByText(/アプリの更新があります/)).toBeVisible()
    // Follow the product's save-before-update instructions, including the modified input.
    await page.getByRole('button', { name: '内容を確認', exact: true }).click()
    await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
    await expect(page.getByText('保存しました', { exact: true })).toBeVisible()
    // An uncontrolled blank page lets us observe activation after every old client closes.
    const reopened = await context.newPage()
    await page.close()
    await reopened.goto(`${origin}${appPath}`)
    await expectActiveControlledWorker(reopened)
    await expect.poll(() => reopened.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting === null)).toBe(true)
    await reopened.getByRole('button', { name: '記録を開く', exact: true }).click()
    await expectDecodedSavedMedia(reopened)
    await expect(reopened.locator('.self-report')).toContainText('良い')
    expect(await sibling.evaluate(async () => (await (await caches.open('other-app-cache-v1')).match('/other-app/keep.txt'))?.text())).toBe('keep-cache')
    expect(await sibling.evaluate(async () => new Promise((resolve, reject) => {
      const request = indexedDB.open('other-app-database', 1)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('values', 'readonly')
        const read = transaction.objectStore('values').get('sentinel')
        transaction.oncomplete = () => { database.close(); resolve(read.result) }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    }))).toBe('keep-database')
    await sibling.goto(`${origin}/`)
    expect(await sibling.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    expect(await sibling.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBeUndefined()
    await test.info().attach('local-worker-update-audit.json', { body: JSON.stringify({
      testedUrl: reopened.url(), publishedSiteTest: false, servedWorkerRevisions,
      scope: await reopened.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope),
      cacheNames: await reopened.evaluate(() => caches.keys()),
      build: await reopened.locator('.pwa-info small').innerText(),
      otherAppCacheRetained: true, otherAppDatabaseRetained: true, siblingAndRootUncontrolled: true,
    }, null, 2), contentType: 'application/json' })
    const screenshotPath = test.info().outputPath('updated-worker-restored-record.png')
    await reopened.screenshot({ path: screenshotPath, fullPage: true })
    await test.info().attach('updated-worker-restored-record.png', { path: screenshotPath, contentType: 'image/png' })
  } finally {
    await context.close()
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections() })
  }
})
