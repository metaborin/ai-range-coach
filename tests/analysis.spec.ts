import { expect, test, type Page, type Route } from './safe-network'
import { makeDummy, SCENE_LABELS, type Session } from '../src/domain'
import { validateAnalysisRequest, type AnalysisReply, type AnalysisRequest, type CoachingAdvice } from '../shared/analysis'
import { readFileSync } from 'node:fs'

// Only the API boundary is simulated. The app, decoder, JPEG capture, snapshots,
// fingerprints and IndexedDB use the production implementation and real fixture.
// Do not retain traces with request bodies or Authorization headers.
test.use({ trace: 'off', viewport: { width: 390, height: 844 } })
const apiUrl = 'https://analysis.test.invalid'
const testPassword = 'test-only-application-password'
const scenes = ['address', 'top', 'impact', 'finish'] as const

async function config(page: Page, enabled = true) {
  await page.route('**/analysis-config.json', route => route.fulfill({
    json: { apiUrl: enabled ? apiUrl : '' }, headers: { 'cache-control': 'no-store' },
  }))
}
async function saveShot(page: Page) {
  await page.goto('./')
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/synthetic.webm')
  const capture = page.getByRole('button', { name: 'この場面にする', exact: true })
  await expect(capture).toBeEnabled()
  for (let index = 0; index < scenes.length; index++) {
    await page.getByRole('slider', { name: 'タイムライン' }).fill(String(index + 0.5))
    await expect(capture).toBeEnabled()
    await capture.click()
    await expect(page.getByAltText(SCENE_LABELS[scenes[index]], { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click()
  await page.getByRole('group', { name: /^当たり/ }).getByRole('button', { name: 'わからない', exact: true }).click()
  await page.getByRole('button', { name: 'ほぼまっすぐ', exact: true }).click()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  await expect(page.getByText('未分析。分析しなくても、この記録を保存できます。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
  await expect(page.getByText('保存しました', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '1球のAI分析' })).toBeVisible()
}
async function records(page: Page) {
  return page.evaluate(async () => new Promise<Session[]>((resolve, reject) => {
    const request = indexedDB.open('ai-range-coach')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sessions', 'readonly')
      const result = transaction.objectStore('sessions').getAll()
      transaction.oncomplete = () => { database.close(); resolve(result.result) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
}
async function durableSummary(page: Page) {
  return page.evaluate(async () => new Promise<{ stores: string[]; metadata: unknown[]; assetCount: number; hasSensitiveData: boolean }>((resolve, reject) => {
    const request = indexedDB.open('ai-range-coach')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result, stores = Array.from(database.objectStoreNames)
      const transaction = database.transaction(stores, 'readonly')
      const requests = stores.map(name => ({ name, request: transaction.objectStore(name).getAll() }))
      transaction.oncomplete = () => {
        const metadata = requests.filter(item => item.name !== 'sessions' && item.name !== 'assets').flatMap(item => item.request.result)
        const json = JSON.stringify(metadata)
        const hasSensitiveData = /jpegBase64|Authorization|test-only-application-password/.test(json)
          || JSON.stringify(localStorage).includes('test-only-application-password')
          || JSON.stringify(sessionStorage).includes('test-only-application-password')
        const assetCount = requests.find(item => item.name === 'assets')!.request.result.length
        database.close(); resolve({ stores, metadata, assetCount, hasSensitiveData })
      }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  }))
}
function successfulReply(request: AnalysisRequest, status: CoachingAdvice['status'] = 'ok'): AnalysisReply {
  const createdAt = new Date().toISOString()
  return {
    requestId: request.requestId, fingerprint: request.fingerprint, shotId: request.input.shotId,
    inputRevision: request.input.inputRevision, state: 'succeeded', createdAt: request.createdAt,
    retryUntil: new Date(Date.parse(request.createdAt) + 86_400_000).toISOString(),
    resultExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    result: {
      id: request.requestId, kind: 'ai', requestId: request.requestId, shotId: request.input.shotId,
      inputRevision: request.input.inputRevision, sourceFingerprint: request.input.sourceFingerprint,
      fingerprint: request.fingerprint, createdAt, model: 'test-model', promptVersion: 'phase1-1', schemaVersion: '1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      advice: status === 'ok' ? {
        status, observations: [{ scene: 'top', text: 'テスト画像では動く円が見えます。' }],
        limitations: ['自作の非人物画像による通信・保存試験で、ゴルフ助言の品質確認ではありません。'],
        nextFocus: '次は全身が入る位置から撮影してください。', reason: '4場面を同じ画角で確認するためです。',
        check: '撮影後、頭と足が画面内に収まっているか確認してください。',
      } : {
        status, observations: [], limitations: ['人物が写っていないため技術的な判断はできません。'],
        nextFocus: '全身が入る位置から短い動画を撮影してください。', reason: 'スイングが画像に写っていません。',
        check: '保存前に4画像すべてに身体が写っているか確認してください。',
      },
    },
  }
}
async function reply(route: Route, body: AnalysisReply) {
  await route.fulfill({ json: body, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } })
}
async function enterPassword(page: Page) {
  const input = page.getByLabel('アプリ専用パスワード', { exact: true })
  await expect(input).toHaveAttribute('type', 'password')
  await input.fill(testPassword)
}
async function reopen(page: Page) {
  await page.reload()
  await page.getByRole('button', { name: '記録を開く', exact: true }).click()
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled()
}

test('unconfigured analysis stays disabled; a real local record and a Phase 0 dummy remain readable', async ({ page }, info) => {
  await config(page, false)
  let apiCalls = 0
  await page.route(`${apiUrl}/**`, route => { apiCalls++; return route.abort() })
  await saveShot(page)
  await expect(page.getByText('AI分析は準備中です。動画の操作と端末保存は引き続き使えます。')).toBeVisible()
  await expect(page.getByRole('button', { name: 'AIで分析する', exact: true })).toBeDisabled()
  await info.attach('phase1-unconfigured-mobile.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  expect((await records(page))[0].sets[0].analysisResult).toBeNull()
  const stored = (await records(page))[0]
  stored.sets[0].analysisResult = makeDummy(stored.sets[0].shots[0].id)
  delete stored.sets[0].shots[0].inputRevision
  delete stored.sets[0].shots[0].inputFingerprint
  await page.evaluate(async session => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('ai-range-coach')
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction('sessions', 'readwrite')
      transaction.objectStore('sessions').put(session)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
    request.onerror = () => reject(request.error)
  }), stored)
  await reopen(page)
  await expect(page.getByRole('heading', { name: '旧見本（AI分析ではありません）', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '1球のAI分析' }).getByText('未分析', { exact: true })).toBeVisible()
  await expect(page.locator('.frames img')).toHaveCount(4)
  expect(apiCalls).toBe(0)
})

test('shipped runtime config does not send analysis on video save or reopen; password and an explicit action are required', async ({ page, liveApiGuard }, info) => {
  // Intentionally use the real production config. Never enter a credential or
  // click analysis here; the context guard also blocks unexpected live requests.
  await saveShot(page)
  const expected = JSON.parse(readFileSync('public/analysis-config.json', 'utf8')) as { apiUrl: string }
  const response = await page.request.get(new URL('analysis-config.json', page.url()).href)
  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual(expected)
  const password = page.getByLabel('アプリ専用パスワード', { exact: true })
  await expect(password).toHaveValue('')
  await expect(page.getByRole('button', { name: 'AIで分析する', exact: true })).toBeDisabled()
  if (expected.apiUrl) {
    await expect(password).toBeEnabled()
    await expect(page.getByText('AI分析は準備中です。動画の操作と端末保存は引き続き使えます。')).toHaveCount(0)
  } else await expect(password).toBeDisabled()
  await reopen(page)
  await expect(password).toHaveValue('')
  if (expected.apiUrl) await expect(password).toBeEnabled()
  else await expect(page.getByText('AI分析は準備中です。動画の操作と端末保存は引き続き使えます。')).toBeVisible()
  await expect(page.getByRole('button', { name: 'AIで分析する', exact: true })).toBeDisabled()
  expect((await records(page))[0].sets[0].analysisResult).toBeNull()
  expect((await durableSummary(page)).metadata.length).toBe(0)
  expect(liveApiGuard.blockedRequests).toBe(0)
  const build = await page.locator('.pwa-info small').textContent()
  expect(build).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  await info.attach('shipped-config-explicit-only.json', {
    body: JSON.stringify({ appUrl: page.url(), apiUrl: expected.apiUrl, build,
      configured: Boolean(expected.apiUrl), credentialEntered: false, analysisClicked: false,
      pendingRequests: 0, blockedUnexpectedRequests: liveApiGuard.blockedRequests, liveApiPermitted: false }),
    contentType: 'application/json',
  })
  await info.attach('shipped-config-saved-mobile.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
})

test('explicit double tap sends one fixed four-JPEG snapshot; result persists and reopens offline without API calls', async ({ page, context }, info) => {
  test.setTimeout(90_000)
  await config(page)
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let accepted: AnalysisRequest | undefined
  await page.route(`${apiUrl}/**`, async route => {
    calls++
    const body = route.request().postDataJSON() as AnalysisRequest
    // Validation binds JPEG bytes, scene order, limits, times and self-report.
    accepted = await validateAnalysisRequest(body)
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'fingerprint', 'input', 'requestId'])
    expect(Object.keys(body.input).sort()).toEqual(['durationSec', 'frames', 'inputRevision', 'selfReport', 'shotId', 'sourceFingerprint'])
    expect(body.input.selfReport).toEqual({ contact: 'unknown', direction: 'center' })
    expect(body.input.frames.map(frame => frame.requestedTimeSec)).toEqual([0.5, 1.5, 2.5, 3.5])
    expect(body.input.frames.every(frame => frame.width === 320 && frame.height === 180)).toBe(true)
    expect(route.request().headers().authorization === `Bearer ${testPassword}`).toBe(true)
    const summary = await durableSummary(page)
    expect(summary.metadata.some(value => (value as { requestId?: string; state?: string }).requestId === body.requestId && (value as { state?: string }).state === 'pending')).toBe(true)
    expect(summary.hasSensitiveData).toBe(false)
    expect(summary.assetCount).toBe(5)
    await gate
    await reply(route, successfulReply(body))
  })
  await saveShot(page)
  expect(calls).toBe(0)
  await expect(page.getByText('画像4枚と当たり・方向をAIに送信します。API利用料が発生します。', { exact: true })).toBeVisible()
  await enterPassword(page)
  const start = page.getByRole('button', { name: 'AIで分析する', exact: true })
  await start.evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await expect.poll(() => calls).toBe(1)
  await expect(page.getByText(/分析中… 経過 \d+ 秒/)).toBeVisible()
  const sourceBeforeResult = await page.locator('video').getAttribute('src')
  await page.getByRole('button', { name: '再生', exact: true }).click()
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.1)
  release()
  await expect(page.getByText('分析結果をこの端末に保存しました。', { exact: true })).toBeVisible()
  expect(await page.locator('video').getAttribute('src')).toBe(sourceBeforeResult)
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '一時停止', exact: true }).click()
  expect((await records(page))[0].sets[0].analysisResult).toMatchObject({ kind: 'ai', fingerprint: accepted!.fingerprint })
  expect((await durableSummary(page)).hasSensitiveData).toBe(false)
  await expect(page.getByText('次は全身が入る位置から撮影してください。', { exact: true })).toBeVisible()
  await page.getByLabel('アプリ専用パスワード', { exact: true }).fill('')
  await info.attach('phase1-mock-result-mobile.png', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  await page.getByText('ホーム画面・オフラインの準備', { exact: true }).click()
  await page.getByRole('button', { name: 'オフラインの準備を確認', exact: true }).click()
  await expect(page.getByText(/オフライン準備完了：/)).toBeVisible()
  await context.setOffline(true)
  try {
    await reopen(page)
    await expect(page.getByText('次は全身が入る位置から撮影してください。', { exact: true })).toBeVisible()
    await expect(page.getByLabel('アプリ専用パスワード', { exact: true })).toHaveValue('')
    await expect(page.getByRole('button', { name: '新しく分析する（再度料金が発生）', exact: true })).toBeDisabled()
    await expect(page.locator('.frames img')).toHaveCount(4)
    await page.getByRole('button', { name: '再生', exact: true }).click()
    await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.1)
    await page.getByRole('button', { name: '一時停止', exact: true }).click()
    expect(calls).toBe(1)
  } finally { await context.setOffline(false) }
})

test('lost response is unknown; restart checks the same persisted request and displays insufficient evidence', async ({ page }) => {
  await config(page)
  let starts = 0, checks = 0
  let original: AnalysisRequest | undefined
  await page.route(`${apiUrl}/**`, async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as AnalysisRequest
      starts++; original = body
      await route.abort('failed')
    } else {
      checks++
      expect(new URL(route.request().url()).pathname.endsWith(`/${original!.requestId}`)).toBe(true)
      expect(route.request().postDataBuffer()).toBeNull()
      await reply(route, successfulReply(original!, 'insufficient_evidence'))
    }
  })
  await saveShot(page)
  await enterPassword(page)
  await page.getByRole('button', { name: 'AIで分析する', exact: true }).click()
  await expect(page.getByRole('button', { name: '同じ要求の状態を確認', exact: true })).toBeEnabled()
  await expect(page.getByText(/前の分析要求の結果が不明です/)).toBeVisible()
  await reopen(page)
  expect([starts, checks]).toEqual([1, 0])
  await expect(page.getByLabel('アプリ専用パスワード', { exact: true })).toHaveValue('')
  await enterPassword(page)
  await page.getByRole('button', { name: '同じ要求の状態を確認', exact: true }).click()
  await expect(page.getByText('判断材料が足りません', { exact: true })).toBeVisible()
  await expect(page.getByText('分析結果をこの端末に保存しました。', { exact: true })).toBeVisible()
  expect([starts, checks]).toEqual([1, 1])
  expect((await records(page))[0].sets[0].analysisResult).toMatchObject({ kind: 'ai', requestId: original!.requestId, advice: { status: 'insufficient_evidence' } })
})

test('late analysis cannot overwrite dirty edits; result save failure keeps advice and retry uses no new API call', async ({ page }) => {
  test.setTimeout(90_000)
  await config(page)
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`${apiUrl}/**`, async route => {
    calls++
    const request = route.request().postDataJSON() as AnalysisRequest
    if (calls === 1) await gate
    await reply(route, successfulReply(request))
  })
  await saveShot(page)
  await enterPassword(page)
  await page.getByRole('button', { name: 'AIで分析する', exact: true }).click()
  await expect.poll(() => calls).toBe(1)
  await page.getByRole('button', { name: '編集', exact: true }).click()
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click()
  await page.getByRole('button', { name: '左', exact: true }).click()
  await expect(page.getByRole('button', { name: '左', exact: true })).toHaveAttribute('aria-pressed', 'true')
  release()
  await expect.poll(async () => (await records(page))[0].sets[0].analysisResult?.kind).toBe('ai')
  await expect(page.getByRole('button', { name: '左', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('未保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '内容を確認', exact: true }).click()
  await page.getByRole('button', { name: 'この端末に保存', exact: true }).click()
  await expect(page.getByText('変更前の内容に対する分析です。現在の画像・時刻・本人入力で分析し直してください。', { exact: true })).toBeVisible()
  expect((await records(page))[0].sets[0].shots[0].selfReport.direction).toBe('left')
  const oldResult = (await records(page))[0].sets[0].analysisResult!
  const originalPut = await page.evaluateHandle(() => IDBObjectStore.prototype.put)
  await page.evaluate(oldId => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const session = value as Session
      if (this.name === 'sessions' && session.sets?.[0].analysisResult?.kind === 'ai' && session.sets[0].analysisResult.id !== oldId) {
        this.transaction.abort()
        throw new DOMException('Intentional result-save quota failure', 'QuotaExceededError')
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  }, oldResult.id)
  try {
    await page.getByRole('button', { name: '新しく分析する（再度料金が発生）', exact: true }).click()
    await expect(page.getByRole('button', { name: '結果をこの端末に保存し直す', exact: true })).toBeEnabled()
    await expect(page.getByText('この分析結果はまだ端末に保存できていません。', { exact: true })).toBeVisible()
    await expect(page.getByText('次は全身が入る位置から撮影してください。', { exact: true })).toBeVisible()
    expect((await records(page))[0].sets[0].analysisResult!.id).toBe(oldResult.id)
    expect(calls).toBe(2)
  } finally {
    await page.evaluate(original => { IDBObjectStore.prototype.put = original }, originalPut)
    await originalPut.dispose()
  }
  await page.getByRole('button', { name: '結果をこの端末に保存し直す', exact: true }).click()
  await expect(page.getByText('分析結果をこの端末に保存しました。', { exact: true })).toBeVisible()
  expect(calls).toBe(2)
  expect((await durableSummary(page)).assetCount).toBe(5)
  await expect(page.getByText('変更前の内容に対する分析です。現在の画像・時刻・本人入力で分析し直してください。', { exact: true })).toHaveCount(0)
  await reopen(page)
  expect(calls).toBe(2)
  await expect(page.locator('.self-report')).toContainText('左')
  await expect(page.getByText('次は全身が入る位置から撮影してください。', { exact: true })).toBeVisible()
})

test('pending-metadata failure sends nothing; cancelling wait retains the same request and refused result is not success', async ({ page }) => {
  await config(page)
  let starts = 0, checks = 0
  let accepted: AnalysisRequest | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`${apiUrl}/**`, async route => {
    if (route.request().method() === 'POST') {
      starts++; accepted = route.request().postDataJSON() as AnalysisRequest
      await gate
      await reply(route, successfulReply(accepted))
    } else {
      checks++
      expect(new URL(route.request().url()).pathname.endsWith(`/${accepted!.requestId}`)).toBe(true)
      const refused = successfulReply(accepted!)
      delete refused.result
      refused.state = 'failed'; refused.errorCode = 'upstream_refusal'
      await reply(route, refused)
    }
  })
  await saveShot(page)
  await enterPassword(page)
  const originalAdd = await page.evaluateHandle(() => IDBObjectStore.prototype.add)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'analysisRequests') {
        this.transaction.abort()
        throw new DOMException('Intentional pending-metadata quota failure', 'QuotaExceededError')
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
  })
  try {
    await page.getByRole('button', { name: 'AIで分析する', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('画像は送信していません。')
    expect(starts).toBe(0)
    expect((await durableSummary(page)).metadata.length).toBe(0)
  } finally {
    await page.evaluate(original => { IDBObjectStore.prototype.add = original }, originalAdd)
    await originalAdd.dispose()
  }
  await page.getByRole('button', { name: 'AIで分析する', exact: true }).click()
  await expect.poll(() => starts).toBe(1)
  await page.getByRole('button', { name: '待機を中止', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('課金やサーバー側の処理を取り消したとは限りません。')
  await expect(page.getByRole('button', { name: '同じ要求の状態を確認', exact: true })).toBeEnabled()
  release()
  await page.getByRole('button', { name: '同じ要求の状態を確認', exact: true }).click()
  await expect(page.getByText('前の分析は完了しませんでした。内容や専用パスワード・利用枠を確認してから操作してください。', { exact: true })).toBeVisible()
  await expect(page.getByText('分析が完了しました', { exact: true })).toHaveCount(0)
  expect((await records(page))[0].sets[0].analysisResult).toBeNull()
  expect([starts, checks]).toEqual([1, 1])
})
