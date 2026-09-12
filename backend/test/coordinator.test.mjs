import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeFingerprint } from '../../shared/analysis.ts'
import { advice, analysisRequest, API_KEY, deferred, harness, ORIGIN, PASSWORD, upstreamResponse, upstreamResult, waitFor } from './helpers.mjs'

describe('real SQLite Durable Object; only the OpenAI network is mocked', { concurrency: false }, () => {
  it('authenticates POST and GET, blocks denied origins and repeated password failures before any upstream call', async () => {
    const app = await harness()
    try {
      const input = await analysisRequest()
      assert.equal((await app.send(input, { Authorization: '' })).status, 401)
      assert.equal((await app.get(input.requestId, { Authorization: 'Bearer incorrect-test-password' })).status, 401)
      assert.equal((await app.send(input, { Origin: 'https://unrelated.invalid' })).status, 403)
      for (let i = 0; i < 8; i++) assert.equal((await app.get(input.requestId, { Authorization: '' })).status, 401)
      assert.equal((await app.send(input)).status, 429)
      assert.equal(app.calls.length, 0)
      assert.equal((await app.sql('SELECT * FROM requests')).length, 0)
      const preflight = await app.mf.dispatchFetch('https://api.test/v1/analyses', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } })
      assert.equal(preflight.status, 204)
      assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN)
      assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
      assert.equal((await app.sql('SELECT * FROM quota')).length, 0)
    } finally { await app.close() }
  })

  it('rejects invalid JPEG/metadata/fingerprint and actual streamed bodies above 6 MiB without using quota or OpenAI', async () => {
    const app = await harness()
    try {
      const original = await analysisRequest()
      for (const change of [
        value => { value.input.frames.pop() }, value => { value.input.frames[0].jpegBase64 = 'AAAA' },
        value => { value.input.frames[0].width = 5000 }, value => { value.input.frames[1].requestedTimeSec = 0.1 },
        value => { value.input.selfReport.direction = 'measured-ball-flight' }, value => { value.fingerprint = '0'.repeat(64) },
        value => { value.input.frames[0].imageUrl = 'https://unrelated.invalid/image.jpg' },
      ]) {
        const input = structuredClone(original)
        change(input)
        assert.equal((await app.send(input)).status, 400)
      }
      assert.equal((await app.send('not-json')).status, 400)
      const bytes = new TextEncoder().encode(`{"padding":"${'x'.repeat(6 * 1024 * 1024)}"}`)
      const response = await app.mf.dispatchFetch('https://api.test/v1/analyses', {
        method: 'POST', headers: { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' },
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }), duplex: 'half',
      })
      assert.equal(response.status, 413)
      assert.equal(app.calls.length, 0)
      assert.equal((await app.sql('SELECT * FROM quota')).length, 0)
    } finally { await app.close() }
  })

  it('atomically reserves one request/quota and returns duplicate pending/results without a second call', async () => {
    const release = deferred()
    const app = await harness(async () => { await release.promise; return upstreamResponse() })
    try {
      const input = await analysisRequest()
      const first = app.send(input)
      await waitFor(() => app.calls.length === 1)
      const same = await app.send(input)
      assert.equal(same.status, 202)
      assert.equal((await same.json()).state, 'pending')
      assert.equal((await (await app.get(input.requestId)).json()).state, 'pending')
      assert.equal((await app.send(await analysisRequest())).status, 409)
      const changed = structuredClone(input)
      changed.input.selfReport.contact = 'poor'
      changed.fingerprint = await computeFingerprint(changed.input)
      assert.equal((await app.send(changed)).status, 409)
      release.resolve()
      const response = await first
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
      const result = await response.json()
      assert.equal(result.state, 'succeeded')
      assert.equal(result.result.kind, 'ai')
      assert.equal(result.result.fingerprint, input.fingerprint)
      assert.equal(result.result.usage.reasoningTokens, 40)
      assert.equal((await (await app.send(input)).json()).result.id, input.requestId)
      assert.equal(app.calls.length, 1)
      assert.deepEqual((await app.sql('SELECT count FROM quota ORDER BY bucket')).map(row => row.count), [1, 1])
      const call = app.calls[0]
      assert.equal(call.url, 'https://api.openai.com/v1/responses')
      assert.equal(call.headers.get('authorization'), `Bearer ${API_KEY}`)
      assert.equal(call.body.model, 'gpt-5.6-terra')
      assert.equal(call.body.store, false)
      assert.deepEqual(call.body.reasoning, { effort: 'low' })
      assert.equal(call.body.max_output_tokens, 4096)
      assert.equal(call.body.text.format.strict, true)
      assert.equal(call.body.tools, undefined)
      assert.equal(call.body.previous_response_id, undefined)
      const content = call.body.input[0].content
      assert.equal(content.filter(item => item.type === 'input_image').length, 4)
      assert.ok(content.filter(item => item.type === 'input_image').every(item => item.image_url.startsWith('data:image/jpeg;base64,')))
      const stored = JSON.stringify(await app.sql('SELECT * FROM requests'))
      assert.equal(stored.includes(input.input.frames[0].jpegBase64), false)
      assert.equal(stored.includes(PASSWORD), false)
      assert.equal(stored.includes(API_KEY), false)
    } finally { release.resolve(); await app.close() }
  })

  it('enforces the Japanese day and month quotas transactionally before upstream calls', async () => {
    const app = await harness()
    try {
      const first = await analysisRequest()
      assert.equal((await (await app.send(first)).json()).state, 'succeeded')
      await app.sql("UPDATE quota SET count=20 WHERE bucket LIKE 'day:%'")
      assert.equal((await app.send(await analysisRequest())).status, 429)
      await app.sql("UPDATE quota SET count=1 WHERE bucket LIKE 'day:%'")
      await app.sql("UPDATE quota SET count=100 WHERE bucket LIKE 'month:%'")
      assert.equal((await app.send(await analysisRequest())).status, 429)
      assert.equal(app.calls.length, 1)
      assert.equal((await app.sql('SELECT * FROM requests')).length, 1)
    } finally { await app.close() }
  })

  it('distinguishes insufficient evidence from refusals, incomplete and invalid model output without retry', async () => {
    const responses = [
      upstreamResponse(upstreamResult({ ...advice, status: 'insufficient_evidence', nextFocus: '全身が画面に入る位置から撮影してください。' })),
      upstreamResponse({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'test refusal' }] }] }),
      upstreamResponse({ status: 'incomplete', output: [] }), upstreamResponse({ status: 'completed', output: [] }),
      new Response('not-json'), upstreamResponse(upstreamResult({ ...advice, nextFocus: ['two', 'tasks'] })),
      upstreamResponse({ error: 'test only' }, 429),
    ]
    const app = await harness(() => responses.shift())
    try {
      const expected = ['succeeded', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed']
      for (let index = 0; index < expected.length; index++) {
        const input = await analysisRequest()
        const reply = await (await app.send(input)).json()
        assert.equal(reply.state, expected[index])
        if (index === 0) assert.equal(reply.result.advice.status, 'insufficient_evidence')
        else assert.equal(reply.result, undefined)
        assert.equal((await (await app.send(input)).json()).state, expected[index])
        assert.equal(app.calls.length, index + 1)
      }
    } finally { await app.close() }
  })

  it('expires results, keeps tombstones and refuses expired IDs after deletion instead of creating new calls', async () => {
    const app = await harness()
    try {
      const input = await analysisRequest()
      const first = await (await app.send(input)).json()
      assert.ok(Date.parse(first.resultExpiresAt) <= Date.parse(first.result.createdAt) + 10 * 60 * 1000 + 1000)
      await app.sql('UPDATE requests SET result_expires_at=? WHERE request_id=?', Date.now() - 1, input.requestId)
      const expired = await (await app.get(input.requestId)).json()
      assert.equal(expired.state, 'expired')
      assert.equal(expired.result, undefined)
      assert.equal((await app.sql('SELECT result_json FROM requests'))[0].result_json, null)
      assert.equal((await (await app.send(input)).json()).state, 'expired')
      const old = await analysisRequest({ now: Date.now() - 25 * 60 * 60 * 1000 })
      assert.equal((await app.send(old)).status, 410)
      assert.equal((await (await app.get(old.requestId)).json()).state, 'expired')
      assert.equal((await (await app.get((await analysisRequest()).requestId)).json()).state, 'not_found')
      assert.equal(app.calls.length, 1)
    } finally { await app.close() }
  })

  it('keeps a previously stored prompt version and advice on GET or duplicate POST after an instruction update', async () => {
    const app = await harness()
    try {
      const input = await analysisRequest()
      const first = await (await app.send(input)).json()
      assert.equal(first.result.promptVersion, 'phase1-2')
      const previousResult = { ...first.result, promptVersion: 'phase1-1', advice: { ...first.result.advice, nextFocus: '従来の保存済み分析文。' } }
      await app.sql('UPDATE requests SET result_json=? WHERE request_id=?', JSON.stringify(previousResult), input.requestId)
      assert.deepEqual((await (await app.get(input.requestId)).json()).result, previousResult)
      assert.deepEqual((await (await app.send(input)).json()).result, previousResult)
      assert.equal(app.calls.length, 1)
    } finally { await app.close() }
  })

  it('recovers an interrupted persisted request as unknown and releases its bounded lock without resubmitting', async () => {
    const app = await harness()
    try {
      const input = await analysisRequest()
      assert.equal((await (await app.send(input)).json()).state, 'succeeded')
      await app.sql("UPDATE requests SET state='pending', result_json=NULL, result_expires_at=NULL, lock_until=? WHERE request_id=?", Date.now() + 60_000, input.requestId)
      await app.mf.unsafeEvictDurableObject('backend-test', 'AnalysisCoordinator', { name: 'owner' })
      assert.equal((await (await app.get(input.requestId)).json()).state, 'unknown')
      assert.equal((await app.send(await analysisRequest())).status, 409)
      assert.equal((await (await app.send(input)).json()).state, 'unknown')
      assert.equal(app.calls.length, 1)
      await app.sql('UPDATE requests SET lock_until=? WHERE request_id=?', Date.now() - 1, input.requestId)
      assert.equal((await (await app.send(await analysisRequest())).json()).state, 'succeeded')
      assert.equal(app.calls.length, 2)
    } finally { await app.close() }
  })

  it('stays unavailable with missing Secrets and rejects development origins in production', async () => {
    const app = await harness(undefined, { OPENAI_API_KEY: '' })
    try {
      assert.equal((await app.send(await analysisRequest())).status, 503)
      assert.equal((await app.send(await analysisRequest(), { Origin: 'http://localhost:5173' })).status, 403)
      assert.equal(app.calls.length, 0)
    } finally { await app.close() }
  })
})
