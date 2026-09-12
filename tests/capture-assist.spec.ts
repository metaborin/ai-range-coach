import { test, expect, type Page, type Locator } from './safe-network'
import { SCENES, SCENE_LABELS, type MediaAsset, type Session } from '../src/domain'

test.use({ viewport: { width: 390, height: 844 }, trace: 'off' })
const fixture = 'tests/fixtures/synthetic.webm'
const anchor = (page: Page) => page.getByRole('button', { name: 'このあたりを基準にする', exact: true })
const timeline = (page: Page) => page.getByRole('slider', { name: 'タイムライン', exact: true })
const next = (page: Page) => page.getByRole('button', { name: 'この4枚で進む', exact: true })
const review = (page: Page) => page.getByRole('heading', { name: '4枚をまとめて確認', exact: true })
const manual = (page: Page) => page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true })

async function readImage(image: Locator) {
  return image.evaluate(async (element: HTMLImageElement) => {
    await element.decode()
    const bytes = await (await fetch(element.src)).arrayBuffer()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const canvas = document.createElement('canvas')
    canvas.width = element.naturalWidth; canvas.height = element.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(element, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0, totalX = 0
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const index = (y * canvas.width + x) * 4
      if (pixels[index] > 215 && pixels[index + 1] > 215 && pixels[index + 2] > 205) { count++; totalX += x }
    }
    const card = element.closest('.frame')!
    return { sha256: Array.from(digest, value => value.toString(16).padStart(2, '0')).join(''),
      width: canvas.width, height: canvas.height, pixel: Array.from(context.getImageData(5, 5, 1, 1).data),
      circleX: totalX / count, circlePixels: count,
      requestedTime: Number(card.textContent!.match(/指定 ([\d.]+) 秒/)![1]),
      observedTime: Number(card.textContent!.match(/取得 ([\d.]+) 秒/)![1]) }
  })
}
async function shownImages(page: Page) {
  // Opening a saved record is asynchronous; wait for its cards before counting
  // genuinely missing candidates. No fixed delay or fabricated media is used.
  await expect(page.locator('.frames')).toBeVisible()
  return Promise.all(SCENES.map(async scene => {
    const image = page.getByAltText(SCENE_LABELS[scene], { exact: true })
    return await image.count() ? { scene, ...await readImage(image) } : { scene, missing: true as const }
  }))
}
async function persisted(page: Page) {
  return page.evaluate(async () => {
    const data = await new Promise<{ sessions: Session[]; assets: MediaAsset[] }>((resolve, reject) => {
      const request = indexedDB.open('ai-range-coach')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result, transaction = database.transaction(['sessions', 'assets'], 'readonly')
        const sessions = transaction.objectStore('sessions').getAll(), assets = transaction.objectStore('assets').getAll()
        transaction.oncomplete = () => { database.close(); resolve({ sessions: sessions.result, assets: assets.result }) }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    })
    const assets = await Promise.all(data.assets.map(async asset => ({ id: asset.id, kind: asset.kind, type: asset.blob.type,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('') })))
    return { sessions: data.sessions, assets: assets.sort((a, b) => a.id.localeCompare(b.id)) }
  })
}
async function load(page: Page) {
  await page.goto('./')
  await page.locator('input[type=file]').setInputFiles(fixture)
  await expect(page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(anchor(page)).toBeEnabled()
}
async function generate(page: Page, at: number, replace = false) {
  await timeline(page).fill(String(at))
  await expect(anchor(page)).toBeEnabled()
  if (replace) page.once('dialog', dialog => dialog.accept())
  await anchor(page).click()
  await expect(review(page)).toBeVisible({ timeout: 15000 })
}
async function repair(page: Page, scene: keyof typeof SCENE_LABELS, at: number) {
  await page.getByRole('button', { name: `${SCENE_LABELS[scene]}を直す`, exact: true }).click()
  const capture = page.getByRole('button', { name: 'この場面にする', exact: true })
  await expect(capture).toBeEnabled()
  await timeline(page).fill(String(at))
  await expect(capture).toBeEnabled()
  await capture.click()
  await expect(review(page)).toBeVisible()
}
async function inputsAndSave(page: Page) {
  await next(page).click()
  await page.getByRole('group', { name: /^当たり/ }).getByRole('button', { name: '良い', exact: true }).click()
  await page.getByRole('button', { name: 'ほぼまっすぐ', exact: true }).click()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
  await expect(page.getByText('保存しました', { exact: true })).toBeVisible()
}
async function delayEncoding(page: Page) {
  return page.evaluateHandle(() => {
    const held = new Set<() => void>()
    const state = { delay: 450, pending: 0, delivered: 0, fail: false, hold: false, heldCount: 0,
      releaseOne: () => held.values().next().value?.(), releaseAll: () => [...held].forEach(release => release()) }
    const native = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      const fail = state.fail, delay = state.delay
      state.pending++
      native.call(this, value => {
        let delivered = false, timer = 0
        const deliver = () => {
          if (delivered) return
          delivered = true; clearTimeout(timer); held.delete(deliver); state.heldCount = held.size
          state.pending--; state.delivered++; callback(fail ? null : value)
        }
        if (state.hold) {
          held.add(deliver); state.heldCount = held.size
          // A bounded test pause below the production encoder timeout. Keep the
          // real JPEG, then release it explicitly to avoid missing brief progress.
          timer = window.setTimeout(deliver, 4000)
        } else timer = window.setTimeout(deliver, delay)
      }, type, quality)
    }
    return state
  })
}
async function waitFirstCandidate(page: Page, encoding: Awaited<ReturnType<typeof delayEncoding>>) {
  await expect.poll(() => encoding.evaluate(state => state.heldCount)).toBe(1)
  await encoding.evaluate(state => state.releaseOne())
  await expect(page.getByText(/候補を作成中… 取得済み 1 \/ 対象 4 枚/)).toBeVisible()
  await expect.poll(() => encoding.evaluate(state => state.heldCount)).toBe(1)
}

test('one anchor creates actual JPEG candidates; one repair preserves three images, then one confirmation saves/reopens offline without API', async ({ page, context, liveApiGuard }, info) => {
  await load(page)
  await generate(page, 2.4)
  await expect(page.getByText('仮の候補です。場面が合っているか確認してください', { exact: true })).toBeVisible()
  const initial = await shownImages(page)
  const expectedTimes = [0.4, 2.15, 2.4, 3.2]
  const colors = [[210, 40, 35], [30, 70, 220], [30, 70, 220], [220, 160, 30]]
  initial.forEach((frame, index) => {
    if ('missing' in frame) throw new Error('A full in-range batch omitted a candidate')
    expect(frame.requestedTime).toBe(expectedTimes[index])
    expect([frame.width, frame.height]).toEqual([320, 180])
    colors[index].forEach((channel, channelIndex) => expect(Math.abs(frame.pixel[channelIndex] - channel)).toBeLessThan(25))
    expect(frame.circlePixels).toBeGreaterThan(500)
    expect(Math.abs(frame.circleX - (Math.floor(frame.observedTime * 24) * 2 + 20))).toBeLessThan(5)
  })
  await info.attach('assist-four-candidates-mobile.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await repair(page, 'top', 2.05)
  const repaired = await shownImages(page)
  for (const index of [0, 2, 3]) expect(repaired[index]).toEqual(initial[index])
  expect(repaired[1]).toMatchObject({ requestedTime: 2.05 })
  expect('sha256' in repaired[1] && 'sha256' in initial[1] && repaired[1].sha256 !== initial[1].sha256).toBe(true)
  await expect(next(page)).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await inputsAndSave(page)
  const saved = await persisted(page)
  expect(saved.assets).toHaveLength(5)
  expect(saved.sessions[0].sets[0].analysisResult).toBeNull()
  SCENES.forEach((scene, index) => {
    const capture = saved.sessions[0].sets[0].shots[0].scenes[scene]!
    expect(capture.requestedTimeSec).toBe(index === 1 ? 2.05 : expectedTimes[index])
    expect(['video-frame-callback', 'video-current-time']).toContain(capture.timeBasis)
    expect(Number.isFinite(capture.observedTimeSec)).toBe(true)
  })
  await page.getByText('ホーム画面・オフラインの準備', { exact: true }).click()
  await page.getByRole('button', { name: 'オフラインの準備を確認', exact: true }).click()
  await expect(page.getByText(/オフライン準備完了：/)).toBeVisible()
  await context.setOffline(true)
  try {
    await page.reload()
    await page.getByRole('button', { name: '記録を開く', exact: true }).click()
    expect(await shownImages(page)).toEqual(repaired)
    await page.getByRole('button', { name: '再生', exact: true }).click()
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.1)
    await page.getByRole('button', { name: '一時停止', exact: true }).click()
    expect(await persisted(page)).toEqual(saved)
    expect(liveApiGuard.blockedRequests).toBe(0)
    await info.attach('assist-capture-audit.json', { body: JSON.stringify({ url: page.url(), build: await page.locator('.pwa-info small').textContent(), anchor: 2.4, initial, repaired,
      savedTimes: saved.sessions[0].sets[0].shots[0].scenes, offlineRestored: true, liveApiPermitted: false, golfPhaseAccuracyTested: false }), contentType: 'application/json' })
    await info.attach('assist-saved-offline-mobile.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  } finally { await context.setOffline(false) }
})

test('out-of-range candidates stay missing; manual repair enforces order and dismissed regeneration preserves existing images', async ({ page }, info) => {
  await load(page)
  await generate(page, 1.8)
  await expect(page.locator('.frames img')).toHaveCount(3)
  await expect(next(page)).toBeDisabled()
  const nearStart = await shownImages(page)
  expect(nearStart).toMatchObject([{ scene: 'address', missing: true }, { scene: 'top', requestedTime: 1.55 }, { scene: 'impact', requestedTime: 1.8 }, { scene: 'finish', requestedTime: 2.6 }])
  await repair(page, 'address', 0.2)
  const completedNearStart = await shownImages(page)
  expect(completedNearStart[0]).toMatchObject({ scene: 'address', requestedTime: 0.2 })
  for (const index of [1, 2, 3]) expect(completedNearStart[index]).toEqual(nearStart[index])
  await expect(next(page)).toBeEnabled()
  await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
  await generate(page, 0.15, true)
  await expect(page.locator('.frames img')).toHaveCount(2)
  await expect(next(page)).toBeDisabled()
  expect(await shownImages(page)).toMatchObject([{ scene: 'address', missing: true }, { scene: 'top', missing: true }, { scene: 'impact', requestedTime: 0.15 }, { scene: 'finish', requestedTime: 0.95 }])
  await repair(page, 'address', 0.05)
  await repair(page, 'top', 0.2)
  await expect(next(page)).toBeDisabled()
  await expect(page.getByText(/インパクト付近は前の場面より後に指定/)).toBeVisible()
  await repair(page, 'top', 0.1)
  await expect(next(page)).toBeEnabled()
  await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
  await generate(page, 4.5, true)
  const late = await shownImages(page)
  expect(late).toMatchObject([{ scene: 'address', requestedTime: 2.5 }, { scene: 'top', requestedTime: 4.25 }, { scene: 'impact', requestedTime: 4.5 }, { scene: 'finish', missing: true }])
  await expect(next(page)).toBeDisabled()
  await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
  await expect(anchor(page)).toBeEnabled()
  page.once('dialog', dialog => dialog.dismiss())
  await anchor(page).click()
  await manual(page).click()
  expect(await shownImages(page)).toEqual(late)
  expect((await persisted(page)).sessions).toHaveLength(0)
  await info.attach('assist-missing-audit.json', { body: JSON.stringify({ url: page.url(), build: await page.locator('.pwa-info small').textContent(), nearStartAnchor: 1.8, nearStart, completedNearStart, otherThreePreservedAfterAddressRepair: true, firstAnchor: 0.15, lateAnchor: 4.5, late, clampedToEndpoint: false, dismissedRegenerationPreservedImages: true }), contentType: 'application/json' })
})

test('cancelling, changing mode, re-anchoring and replacing video during delayed real encoding cannot mix old batches or alter the saved record', async ({ page }) => {
  test.setTimeout(90_000)
  await load(page)
  await generate(page, 2.4)
  await inputsAndSave(page)
  const saved = await persisted(page)
  await page.getByRole('button', { name: '編集', exact: true }).click()
  await expect(manual(page)).toHaveAttribute('aria-pressed', 'true')
  const original = await shownImages(page)
  const encoding = await delayEncoding(page)
  await encoding.evaluate(state => { state.delay = 0; state.hold = true })
  try {
    await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
    await timeline(page).fill('2.2')
    page.once('dialog', dialog => dialog.accept())
    await anchor(page).click()
    await waitFirstCandidate(page, encoding)
    await page.getByRole('button', { name: '候補作成を中断', exact: true }).click()
    await expect(page.getByText(/候補作成を中断しました。今回の候補は反映していません/)).toBeVisible()
    await expect(anchor(page)).toBeEnabled()
    await manual(page).click()
    expect(await shownImages(page)).toEqual(original)
    expect(await persisted(page)).toEqual(saved)
    await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
    await encoding.evaluate(state => { state.hold = false })
    await generate(page, 2.6, true)
    const replacement = await shownImages(page)
    expect(replacement).toMatchObject([{ requestedTime: 0.6 }, { requestedTime: 2.35 }, { requestedTime: 2.6 }, { requestedTime: 3.4 }])
    await encoding.evaluate(state => state.releaseAll())
    await expect.poll(() => encoding.evaluate(state => state.pending)).toBe(0)
    expect(await shownImages(page)).toEqual(replacement)
    await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
    await encoding.evaluate(state => { state.hold = true })
    await expect(anchor(page)).toBeEnabled()
    page.once('dialog', dialog => dialog.accept())
    await anchor(page).click()
    await waitFirstCandidate(page, encoding)
    await manual(page).click()
    await expect(page.getByRole('button', { name: 'この場面にする', exact: true })).toBeEnabled()
    await encoding.evaluate(state => state.releaseAll())
    await expect.poll(() => encoding.evaluate(state => state.pending)).toBe(0)
    expect(await shownImages(page)).toEqual(replacement)
    await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
    await expect(anchor(page)).toBeEnabled()
    page.once('dialog', dialog => dialog.accept())
    await anchor(page).click()
    await waitFirstCandidate(page, encoding)
    page.once('dialog', dialog => dialog.accept())
    await page.locator('input[type=file]').setInputFiles(fixture)
    await expect(anchor(page)).toBeEnabled()
    await encoding.evaluate(state => state.releaseAll())
    await manual(page).click()
    await expect.poll(() => encoding.evaluate(state => state.pending)).toBe(0)
    await expect(page.locator('.frames img')).toHaveCount(0)
    expect(await persisted(page)).toEqual(saved)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: 'ホームへ', exact: true }).click()
    await page.getByRole('button', { name: '記録を開く', exact: true }).click()
    expect(await shownImages(page)).toEqual(original)
    expect(await persisted(page)).toEqual(saved)
  } finally { await encoding.dispose() }
})

test('failed candidate extraction and failed candidate save leave the last saved record intact', async ({ page }) => {
  await load(page)
  await generate(page, 2.4)
  await inputsAndSave(page)
  const saved = await persisted(page)
  await page.getByRole('button', { name: '編集', exact: true }).click()
  const original = await shownImages(page)
  const encoding = await delayEncoding(page)
  await encoding.evaluate(state => { state.delay = 0; state.fail = true })
  await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
  await expect(anchor(page)).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await anchor(page).click()
  await expect(page.getByRole('alert')).toContainText('候補を取得できませんでした。現在の画像は残しています。')
  await manual(page).click()
  expect(await shownImages(page)).toEqual(original)
  expect(await persisted(page)).toEqual(saved)
  await encoding.evaluate(state => { state.fail = false })
  await page.getByRole('button', { name: 'かんたんに4場面を選ぶ', exact: true }).click()
  await generate(page, 2.6, true)
  await next(page).click()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  const originalPut = await page.evaluateHandle(() => IDBObjectStore.prototype.put)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'sessions') { this.transaction.abort(); throw new DOMException('Intentional candidate-save failure', 'QuotaExceededError') }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  })
  try {
    await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('保存容量が足りません')
    expect(await persisted(page)).toEqual(saved)
    expect(await shownImages(page)).toMatchObject([{ requestedTime: 0.6 }, { requestedTime: 2.35 }, { requestedTime: 2.6 }, { requestedTime: 3.4 }])
  } finally {
    await page.evaluate(original => { IDBObjectStore.prototype.put = original }, originalPut)
    await originalPut.dispose(); await encoding.dispose()
  }
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'ホームへ', exact: true }).click()
  await page.getByRole('button', { name: '記録を開く', exact: true }).click()
  expect(await shownImages(page)).toEqual(original)
  expect(await persisted(page)).toEqual(saved)
})
