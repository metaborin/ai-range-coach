import { test, expect, type Locator, type Page } from './safe-network'

const fixture = 'tests/fixtures/synthetic.webm'
const captureButton = (page: Page) => page.getByRole('button', { name: 'この場面にする', exact: true })
const timeline = (page: Page) => page.getByRole('slider', { name: 'タイムライン' })
const mode = (page: Page, name: string) => page.getByRole('group', { name: '移動幅', exact: true }).getByRole('button', { name, exact: true })

async function seek(page: Page, requested: number) {
  await expect(timeline(page)).toBeEnabled()
  await timeline(page).fill(String(requested))
  await expect(captureButton(page)).toBeEnabled()
}

async function captureAt(page: Page, scene: string, requested: number) {
  await page.getByRole('button', { name: `${scene}を選ぶ`, exact: true }).click()
  await seek(page, requested)
  await captureButton(page).click()
  await expect(page.getByAltText(scene, { exact: true })).toBeVisible()
  await expect(captureButton(page)).toBeEnabled()
}

async function circlePosition(locator: Locator) {
  return locator.evaluate(async (element: HTMLVideoElement | HTMLImageElement) => {
    if (element instanceof HTMLImageElement) await element.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')!
    context.drawImage(element, 0, 0, 320, 180)
    const pixels = context.getImageData(0, 0, 320, 180).data
    let count = 0, totalX = 0
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const offset = (y * 320 + x) * 4
      if (pixels[offset] > 215 && pixels[offset + 1] > 215 && pixels[offset + 2] > 205) { count++; totalX += x }
    }
    return { count, x: totalX / count }
  })
}

async function displayedRequest(page: Page) {
  return Number((await page.getByLabel('指定位置', { exact: true }).innerText()).match(/指定 ([\d.]+)/)![1])
}

test('fine requests move the decoded video, capture the latest requested image and preserve four saved scenes', async ({ page }, info) => {
  await page.goto('./')
  await page.locator('input[type=file]').setInputFiles(fixture)
  await page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  await expect(mode(page, '通常：0.1秒')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'インパクト付近を選ぶ', exact: true }).click()
  await expect(mode(page, '細かく：0.01秒')).toHaveAttribute('aria-pressed', 'true')
  await mode(page, '通常：0.1秒').click()
  await seek(page, 2.2)
  await page.getByRole('button', { name: '0.1秒進む', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  await expect(mode(page, '通常：0.1秒')).toHaveAttribute('aria-pressed', 'true')
  await expect(timeline(page)).toHaveValue('2.3')

  await captureAt(page, 'アドレス', 0.4)
  await captureAt(page, 'トップ', 1.4)
  // Advancing from top to impact selects fine mode; a manual normal choice above
  // remains effective while operating within that earlier impact selection.
  await expect(mode(page, '細かく：0.01秒')).toHaveAttribute('aria-pressed', 'true')
  await seek(page, 2.41)
  const before = await circlePosition(page.locator('video'))
  const forward = page.getByRole('button', { name: '0.01秒進む', exact: true })
  const accepted: number[] = []
  for (let index = 0; index < 10; index++) {
    await expect(forward).toBeEnabled()
    await forward.click()
    await expect(forward).toBeEnabled()
    accepted.push(await displayedRequest(page))
  }
  expect(accepted).toEqual([2.42, 2.43, 2.44, 2.45, 2.46, 2.47, 2.48, 2.49, 2.5, 2.51])
  await expect(timeline(page)).toHaveValue('2.51')
  await expect(page.getByLabel('指定位置', { exact: true })).toContainText('指定 2.510')
  const after = await circlePosition(page.locator('video'))
  expect(before.count).toBeGreaterThan(500)
  expect(after.count).toBeGreaterThan(500)
  // 24 fps footage can show the same frame on individual 0.01-second clicks.
  // Across 0.10 seconds this fixture's actual moving circle must advance.
  expect(after.x - before.x).toBeGreaterThan(2)
  expect(after.x - before.x).toBeLessThan(10)
  await captureButton(page).click()
  const impact = page.getByAltText('インパクト付近', { exact: true })
  await expect(impact).toBeVisible()
  const extracted = await circlePosition(impact)
  expect(Math.abs(extracted.x - after.x)).toBeLessThan(1)
  await expect(page.locator('.frame').filter({ has: impact })).toContainText('指定 2.51 秒')
  await captureAt(page, 'フィニッシュ', 3.4)
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click()
  await page.getByRole('group', { name: /^当たり/ }).getByRole('button', { name: '良い', exact: true }).click()
  await page.getByRole('button', { name: 'ほぼまっすぐ', exact: true }).click()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
  await expect(page.getByText('保存しました', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '記録を開く', exact: true }).click()
  for (const scene of ['アドレス', 'トップ', 'インパクト付近', 'フィニッシュ']) await expect(page.getByAltText(scene, { exact: true })).toBeVisible()
  expect(await circlePosition(page.getByAltText('インパクト付近', { exact: true }))).toEqual(extracted)
  await expect(page.locator('.frame').filter({ has: page.getByAltText('インパクト付近', { exact: true }) })).toContainText('指定 2.51 秒')
  await expect(page.locator('.self-report')).toContainText('良い')
  await page.getByRole('button', { name: '再生', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.1)
  await page.getByRole('button', { name: '一時停止', exact: true }).click()
  await info.attach('fine-seek-real-frame.json', { body: JSON.stringify({ url: page.url(), accepted, before, after, extracted, sourceFps: 24, eachClickRequiresDifferentFrame: false }, null, 2), contentType: 'application/json' })
})

test('fine controls synchronize timeline and paused playback, gate rapid clicks, clamp endpoints and reset on video replacement', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('./')
  const input = page.locator('input[type=file]')
  await input.setInputFiles(fixture)
  await page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  await mode(page, '細かく：0.01秒').click()
  await seek(page, 1.2)
  const forward = page.getByRole('button', { name: '0.01秒進む', exact: true })
  await forward.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await expect(forward).toBeEnabled()
  expect(await displayedRequest(page)).toBe(1.21)
  await page.getByRole('button', { name: '0.01秒戻る', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  expect(await displayedRequest(page)).toBe(1.2)

  await page.getByRole('button', { name: '再生', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(1.3)
  await page.getByRole('button', { name: '一時停止', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  const pausedAt = await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)
  expect(await displayedRequest(page)).toBeCloseTo(pausedAt, 3)
  await forward.click()
  await expect(forward).toBeEnabled()
  expect(await displayedRequest(page)).toBeCloseTo(pausedAt + 0.01, 3)

  await seek(page, 0)
  await page.getByRole('button', { name: '0.01秒戻る', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  expect(await displayedRequest(page)).toBe(0)
  await seek(page, 5)
  await forward.click()
  await expect(captureButton(page)).toBeEnabled()
  expect(await displayedRequest(page)).toBe(5)
  await captureButton(page).click()
  await expect(page.getByRole('alert')).toContainText('終端')
  await page.getByRole('button', { name: '0.01秒戻る', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  expect(await displayedRequest(page)).toBe(4.99)
  await captureButton(page).click()
  await expect(page.getByAltText('アドレス', { exact: true })).toBeVisible()
  await info.attach('fine-controls-mobile.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.getByRole('button', { name: /秒(?:進む|戻る)$/ }).count()).toBe(2)

  page.once('dialog', dialog => dialog.accept())
  await input.setInputFiles(fixture)
  await page.getByRole('button', { name: '1枚ずつ選ぶ', exact: true }).click()
  await expect(captureButton(page)).toBeEnabled()
  expect(await displayedRequest(page)).toBe(0)
  await expect(timeline(page)).toHaveValue('0')
  await expect(mode(page, '通常：0.1秒')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.frames img')).toHaveCount(0)
})
