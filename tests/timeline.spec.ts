import { test, expect, type Locator, type Page } from './safe-network'
import type { Session } from '../src/domain'

const fixture = 'tests/fixtures/synthetic.webm'
const range = (page: Page) => page.getByRole('slider', { name: 'タイムライン', exact: true })
// The label changes while work is pending; retain the actual capture button.
const capture = (page: Page) => page.locator('.video-tools > button.primary')

async function delayFrameDelivery(page: Page) {
  await page.addInitScript(() => {
    const native = HTMLVideoElement.prototype.requestVideoFrameCallback
    if (!native) throw new Error('This Chromium test requires native rVFC')
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return native.call(this, (now, metadata) => { setTimeout(() => callback(now, metadata), 250) })
    }
  })
}

async function requested(page: Page) {
  const output = await page.getByLabel('指定位置', { exact: true }).innerText()
  return Number(output.match(/指定 ([\d.]+)/)![1])
}

async function seekAndWait(page: Page, time: number) {
  await range(page).fill(String(time))
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
}

async function captureScene(page: Page, label: string, time: number) {
  await page.getByRole('button', { name: `${label}を選ぶ`, exact: true }).click()
  await seekAndWait(page, time)
  await capture(page).click()
  await expect(page.getByAltText(label, { exact: true })).toBeVisible()
  await expect(capture(page)).toBeEnabled()
}

async function visualFrame(locator: Locator) {
  return locator.evaluate(async (element: HTMLVideoElement | HTMLImageElement) => {
    if (element instanceof HTMLImageElement) await element.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')!
    context.drawImage(element, 0, 0, 320, 180)
    const pixels = context.getImageData(0, 0, 320, 180).data
    let whiteCount = 0, whiteX = 0
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const offset = (y * 320 + x) * 4
      if (pixels[offset] > 215 && pixels[offset + 1] > 215 && pixels[offset + 2] > 205) { whiteCount++; whiteX += x }
    }
    return { whiteCount, circleX: whiteX / whiteCount, background: Array.from(context.getImageData(5, 5, 1, 1).data) }
  })
}

async function startDrag(page: Page, fraction = 0.1) {
  await range(page).scrollIntoViewIfNeeded()
  const box = (await range(page).boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * fraction, y)
  await page.mouse.down()
  return { box, y }
}

test('continuous delayed drag follows every input and commits the latest decoded preview into a saved scene', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await delayFrameDelivery(page)
  await page.goto('./')
  await page.locator('input[type=file]').setInputFiles(fixture)
  await page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true }).click()
  await expect(capture(page)).toBeEnabled()
  await captureScene(page, 'アドレス', 0.4)
  await captureScene(page, 'トップ', 1.4)
  const observation = await page.evaluateHandle(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="タイムライン"]')!
    const output = document.querySelector<HTMLOutputElement>('output[aria-label="指定位置"]')!
    let latestInput = Number(input.value)
    const displays: { latestInput: number; displayed: number }[] = []
    const noteInput = () => { latestInput = Number(input.value) }
    input.addEventListener('input', noteInput, true)
    const observer = new MutationObserver(() => {
      displays.push({ latestInput, displayed: Number(output.textContent!.match(/指定 ([\d.]+)/)![1]) })
    })
    observer.observe(output, { subtree: true, childList: true, characterData: true })
    return { finish: () => { observer.disconnect(); input.removeEventListener('input', noteInput, true); return displays } }
  })
  const { box, y } = await startDrag(page, 0.05)
  const points: { fraction: number; value: number; requested: number }[] = []
  for (const fraction of [0.08, 0.34, 0.18, 0.44, 0.26, 0.52]) {
    await page.mouse.move(box.x + box.width * fraction, y)
    await expect(range(page)).toBeEnabled()
    await expect(capture(page)).toBeDisabled()
    const value = Number(await range(page).inputValue())
    const shown = await requested(page)
    expect(shown).toBeCloseTo(value, 3)
    points.push({ fraction, value, requested: shown })
    await page.waitForTimeout(20)
  }
  expect(new Set(points.map(point => point.value)).size).toBe(points.length)
  points.slice(1).forEach((point, index) => {
    expect(Math.sign(point.value - points[index].value)).toBe(Math.sign(point.fraction - points[index].fraction))
  })
  const finalRequested = points.at(-1)!.value
  expect(finalRequested).toBeGreaterThan(2.4)
  expect(finalRequested).toBeLessThan(2.9)
  await page.mouse.up()
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(finalRequested)
  expect(Number(await range(page).inputValue())).toBe(finalRequested)
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(finalRequested, 3)
  const displays = await observation.evaluate(value => value.finish())
  await observation.dispose()
  expect(displays.length).toBeGreaterThanOrEqual(points.length)
  displays.forEach(display => expect(display.displayed).toBeCloseTo(display.latestInput, 3))

  // Fine movement starts from the latest drag request, never the first seek.
  await page.getByRole('button', { name: '0.01秒進む', exact: true }).click()
  await expect(capture(page)).toBeEnabled()
  expect(await requested(page)).toBeCloseTo(finalRequested + 0.01, 3)
  await page.getByRole('button', { name: '0.01秒戻る', exact: true }).click()
  await expect(capture(page)).toBeEnabled()
  expect(await requested(page)).toBe(finalRequested)
  const preview = await visualFrame(page.locator('video'))
  expect(preview.whiteCount).toBeGreaterThan(500)
  const previewTime = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)
  await capture(page).click()
  const image = page.getByAltText('インパクト付近', { exact: true })
  await expect(image).toBeVisible()
  const extracted = await visualFrame(image)
  expect(Math.abs(extracted.circleX - preview.circleX)).toBeLessThan(1)
  preview.background.forEach((channel, index) => expect(Math.abs(channel - extracted.background[index])).toBeLessThan(25))
  await expect(page.locator('.frame').filter({ has: image })).toContainText(`指定 ${finalRequested.toFixed(2)} 秒`)
  await captureScene(page, 'フィニッシュ', 3.4)
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click()
  await page.getByRole('group', { name: /^当たり/ }).getByRole('button', { name: '良い', exact: true }).click()
  await page.getByRole('button', { name: 'ほぼまっすぐ', exact: true }).click()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
  await expect(page.getByText('保存しました', { exact: true })).toBeVisible()
  const impactMetadata = await page.evaluate(async () => new Promise<NonNullable<Session['sets'][number]['shots'][number]['scenes']['impact']>>((resolve, reject) => {
    const request = indexedDB.open('ai-range-coach')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sessions', 'readonly')
      const read = transaction.objectStore('sessions').getAll()
      transaction.oncomplete = () => { database.close(); resolve((read.result[0] as Session).sets[0].shots[0].scenes.impact!) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
  expect(impactMetadata.requestedTimeSec).toBe(finalRequested)
  expect(['video-frame-callback', 'video-current-time']).toContain(impactMetadata.timeBasis)
  expect(Number.isFinite(impactMetadata.observedTimeSec)).toBe(true)
  if (impactMetadata.timeBasis === 'video-current-time') expect(impactMetadata.observedTimeSec).toBeCloseTo(previewTime, 3)
  else expect(Math.abs(impactMetadata.observedTimeSec - finalRequested)).toBeLessThan(1 / 24 + 0.01)
  await page.reload()
  await page.getByRole('button', { name: '記録を開く', exact: true }).click()
  await expect(page.getByAltText('インパクト付近', { exact: true })).toBeVisible()
  expect(await visualFrame(page.getByAltText('インパクト付近', { exact: true }))).toEqual(extracted)
  await expect(page.locator('.frame').filter({ has: page.getByAltText('インパクト付近', { exact: true }) })).toContainText(`指定 ${finalRequested.toFixed(2)} 秒`)
  await info.attach('timeline-drag-audit.json', { body: JSON.stringify({ targetUrl: page.url(), build: await page.locator('.pwa-info small').textContent(), delay: 'native rVFC delivered 250ms late; real video/canvas/IndexedDB', points, displays, finalRequested, previewTime, preview, extracted, impactMetadata }, null, 2), contentType: 'application/json' })
  await info.attach('timeline-saved-after-drag.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})

test('outside release, pointer cancellation, blur and rapid keyboard changes leave the timeline usable, then replacement resets it', async ({ page }, info) => {
  await delayFrameDelivery(page)
  await page.goto('./')
  const input = page.locator('input[type=file]')
  await input.setInputFiles(fixture)
  await page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true }).click()
  await expect(capture(page)).toBeEnabled()
  const checkpoints: { operation: string; value: number }[] = []

  let drag = await startDrag(page)
  await page.mouse.move(drag.box.x + drag.box.width * 0.35, drag.y)
  const cancelled = Number(await range(page).inputValue())
  await range(page).dispatchEvent('lostpointercapture', { pointerId: 999, pointerType: 'touch', bubbles: true })
  // Let decoding finish: the primary pointer must still own the drag lock.
  await page.waitForTimeout(600)
  await expect(capture(page)).toBeDisabled()
  await range(page).dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(cancelled)
  checkpoints.push({ operation: 'unrelated lostpointercapture ignored; pointercancel unlocks before pointerup', value: cancelled })
  await page.mouse.up()

  drag = await startDrag(page)
  await page.mouse.move(drag.box.x + drag.box.width * 0.45, drag.y)
  const blurred = Number(await range(page).inputValue())
  await range(page).evaluate(element => element.blur())
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(blurred)
  checkpoints.push({ operation: 'element blur unlocks before pointerup', value: blurred })
  await page.mouse.up()

  drag = await startDrag(page)
  await page.mouse.move(drag.box.x + drag.box.width * 0.4, drag.y)
  const windowBlurred = Number(await range(page).inputValue())
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(windowBlurred)
  checkpoints.push({ operation: 'dispatched window blur unlocks before pointerup', value: windowBlurred })
  await page.mouse.up()

  drag = await startDrag(page)
  await page.mouse.move(drag.box.x + drag.box.width + 40, drag.y - 30)
  const outside = Number(await range(page).inputValue())
  await page.mouse.up()
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(outside)
  checkpoints.push({ operation: 'release outside range', value: outside })

  await seekAndWait(page, 0)
  await startDrag(page, 0)
  await expect(capture(page)).toBeDisabled()
  expect(await requested(page)).toBe(0)
  await page.mouse.up()
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(0)
  checkpoints.push({ operation: 'tap existing zero-position thumb; no value change', value: 0 })

  await range(page).focus()
  await page.keyboard.press('Home')
  for (let index = 0; index < 10; index++) await page.keyboard.press('ArrowRight')
  await expect(range(page)).toHaveValue('0.1')
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(0.1)
  await page.keyboard.press('End')
  await expect(capture(page)).toBeEnabled({ timeout: 10000 })
  expect(await requested(page)).toBe(5)
  await capture(page).click()
  await expect(page.getByRole('alert')).toContainText('終端')
  await range(page).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(capture(page)).toBeEnabled()
  expect(await requested(page)).toBe(4.99)
  checkpoints.push({ operation: 'keyboard Home/10 ArrowRight/End/ArrowLeft', value: 4.99 })

  page.once('dialog', dialog => dialog.accept())
  await input.setInputFiles(fixture)
  await page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true }).click()
  await expect(capture(page)).toBeEnabled()
  await expect(range(page)).toHaveValue('0')
  expect(await requested(page)).toBe(0)
  // Beyond both the injected callback delay and the bounded fallback window.
  await page.waitForTimeout(600)
  expect(await requested(page)).toBe(0)
  await expect(range(page)).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.frames img')).toHaveCount(0)
  await info.attach('timeline-interruption-audit.json', { body: JSON.stringify({ targetUrl: page.url(), checkpoints, replacementAfterSettling: 0, inFlightReplacementTested: false }, null, 2), contentType: 'application/json' })
})
