import { it } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { analysisRequest, API_KEY, upstreamResponse } from './helpers.mjs'

async function moduleFromSource(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { callOpenAI, UPSTREAM_TIMEOUT_MS } = await moduleFromSource('src/openai.ts')
const { quotaPeriods } = await moduleFromSource('src/ledger.ts')
const settings = { OPENAI_API_KEY: API_KEY, OPENAI_MODEL: 'gpt-5.6-terra' }

it('aborts one direct upstream request at the deadline and keeps its outcome uncertain without retry', async () => {
  let calls = 0, signal
  const input = await analysisRequest()
  assert.equal(UPSTREAM_TIMEOUT_MS, 60_000)
  const fetcher = async (_url, options) => {
    calls++
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('test timeout', 'AbortError')), { once: true })
    })
  }
  await assert.rejects(callOpenAI(input, settings, fetcher, 20), error => error.code === 'timeout' && error.uncertain === true)
  assert.equal(calls, 1)
  assert.equal(signal.aborted, true)
})

it('does not retry network loss or HTTP redirects, and clears its timer after success', async () => {
  const input = await analysisRequest()
  let calls = 0, signal
  await assert.rejects(callOpenAI(input, settings, async () => {
    calls++
    throw new TypeError('isolated test connection lost')
  }), error => error.code === 'network_unknown' && error.uncertain === true)
  assert.equal(calls, 1)
  await assert.rejects(callOpenAI(input, settings, async (_url, options) => {
    calls++
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302, headers: { Location: 'https://unrelated.invalid' } })
  }), error => error.code === 'upstream_rejected' && error.uncertain === false)
  assert.equal(calls, 2)
  const result = await callOpenAI(input, settings, async (_url, options) => { signal = options.signal; return upstreamResponse() }, 20)
  assert.equal(result.kind, 'ai')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(signal.aborted, false)
})

it('switches daily and monthly quota periods at Japanese midnight including the year boundary', () => {
  const before = quotaPeriods(Date.parse('2026-12-31T14:59:59.999Z'))
  const after = quotaPeriods(Date.parse('2026-12-31T15:00:00.000Z'))
  assert.deepEqual(before.map(v => [v.key, v.limit, new Date(v.expires).toISOString()]), [
    ['day:2026-12-31', 20, '2026-12-31T15:00:00.000Z'],
    ['month:2026-12', 100, '2026-12-31T15:00:00.000Z'],
  ])
  assert.deepEqual(after.map(v => [v.key, v.limit, new Date(v.expires).toISOString()]), [
    ['day:2027-01-01', 20, '2027-01-01T15:00:00.000Z'],
    ['month:2027-01', 100, '2027-01-31T15:00:00.000Z'],
  ])
})
