import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import jpeg from 'jpeg-js'
import { ANALYSIS_LABELS, ANALYSIS_SCENES, computeFingerprint } from '../../shared/analysis.ts'

// These fixed strings belong only to the isolated test runtime, never a deployment.
export const PASSWORD = 'test-only-password-never-for-production'
export const API_KEY = 'test-only-upstream-key-never-for-production'
export const ORIGIN = 'https://metaborin.github.io'
export const advice = {
  status: 'ok', observations: [{ scene: 'finish', text: 'フィニッシュの姿勢が画像内に写っています。' }],
  limitations: ['1球の静止画だけでは恒常的な癖は判断できません。'],
  nextFocus: '無理のない強さでフィニッシュを保ってみましょう。',
  reason: '今回確認する行動を1つに絞るためです。', check: '次の1球で無理なく止まれたか確認します。',
}
export const upstreamResult = (value = advice) => ({
  status: 'completed', model: 'gpt-5.6-terra',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600, output_tokens_details: { reasoning_tokens: 40 } },
})
export const upstreamResponse = (value = upstreamResult(), status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
export function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export async function waitFor(predicate) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Expected local test condition did not occur')
}
export async function analysisRequest(options = {}) {
  const now = options.now ?? Date.now()
  const pixels = Buffer.alloc(16 * 16 * 4)
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 30; pixels[i + 1] = 100; pixels[i + 2] = 180; pixels[i + 3] = 255 }
  const jpegBase64 = jpeg.encode({ width: 16, height: 16, data: pixels }, 80).data.toString('base64')
  const input = {
    shotId: options.shotId ?? randomUUID(), inputRevision: 0, sourceFingerprint: 'a'.repeat(64), durationSec: 5,
    selfReport: { contact: 'good', direction: 'center' },
    frames: ANALYSIS_SCENES.map((scene, index) => ({ scene, label: ANALYSIS_LABELS[scene], requestedTimeSec: index + 0.4,
      observedTimeSec: index + 0.4, timeBasis: 'video-current-time', width: 16, height: 16, jpegBase64 })),
  }
  return { requestId: `${now}_${randomUUID()}`, createdAt: new Date(now).toISOString(), fingerprint: await computeFingerprint(input), input }
}
export async function harness(handler = () => upstreamResponse(), overrides = {}) {
  const calls = []
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'backend-test', modules: true, scriptPath: resolve('dist/worker.mjs'), compatibilityDate: '2026-09-06',
    durableObjects: { ANALYSIS: { className: 'AnalysisCoordinator', useSQLite: true } },
    bindings: { APP_PASSWORD: PASSWORD, OPENAI_API_KEY: API_KEY, OPENAI_MODEL: 'gpt-5.6-terra', ALLOWED_ORIGIN: ORIGIN, ENVIRONMENT: 'production', ...overrides },
    unsafeInspectDurableObjects: true, log: new Log(LogLevel.ERROR),
    outboundService: async request => {
      calls.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) })
      return handler(calls.length)
    },
  }))
  await mf.ready
  return {
    mf, calls,
    async sql(query, ...values) {
      const storage = await mf.unsafeGetDurableObjectStorage('backend-test', 'AnalysisCoordinator', { name: 'owner' })
      return storage.exec(query, ...values)
    },
    send(input, headers = {}) {
      return mf.dispatchFetch('https://api.test/v1/analyses', { method: 'POST', headers: {
        Origin: ORIGIN, Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json', ...headers,
      }, body: typeof input === 'string' ? input : JSON.stringify(input) })
    },
    get(id, headers = {}) {
      return mf.dispatchFetch(`https://api.test/v1/analyses/${id}`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${PASSWORD}`, ...headers } })
    },
    close: () => mf.dispose(),
  }
}
