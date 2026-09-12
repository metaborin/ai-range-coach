import { it } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { analysisRequest, API_KEY, upstreamResponse } from './helpers.mjs'
import { ADVICE_SCHEMA, computeFingerprint, PROMPT_VERSION, SCHEMA_VERSION } from '../../shared/analysis.ts'

async function moduleFromSource(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { callOpenAI, UPSTREAM_TIMEOUT_MS } = await moduleFromSource('src/openai.ts')
const { quotaPeriods } = await moduleFromSource('src/ledger.ts')
const { CONTACT_LABELS, DIRECTION_LABELS } = await moduleFromSource('../src/domain.ts')
const settings = { OPENAI_API_KEY: API_KEY, OPENAI_MODEL: 'gpt-5.6-terra' }

it('sends every self-report choice in Japanese with the revised evidence limits and unchanged API contract', async () => {
  const contacts = { good: '良い', fair: 'まずまず', poor: 'ミス', unknown: 'わからない' }
  const directions = { left: '左', center: 'ほぼまっすぐ', right: '右', unknown: 'わからない' }
  assert.deepEqual(CONTACT_LABELS, contacts)
  assert.deepEqual(DIRECTION_LABELS, directions)
  assert.equal(PROMPT_VERSION, 'phase1-2')
  let calls = 0
  for (const [contact, contactLabel] of Object.entries(contacts)) for (const [direction, directionLabel] of Object.entries(directions)) {
    const input = await analysisRequest()
    input.input.selfReport = { contact, direction }
    input.fingerprint = await computeFingerprint(input.input)
    let sent
    const result = await callOpenAI(input, settings, async (_url, options) => {
      calls++
      sent = JSON.parse(options.body)
      return upstreamResponse()
    })
    assert.equal(sent.input[0].content[0].text, `本人申告（画像から測った結果ではありません）：当たり=${contactLabel}、目標に対する方向=${directionLabel}。撮影動画の長さ=5秒。`)
    assert.doesNotMatch(sent.input[0].content[0].text, /\b(good|fair|poor|left|center|right|unknown)\b/)
    assert.deepEqual(input.input.selfReport, { contact, direction })
    assert.equal(result.promptVersion, 'phase1-2')
    assert.equal(result.schemaVersion, SCHEMA_VERSION)
    assert.equal(result.fingerprint, input.fingerprint)
    const images = sent.input[0].content.filter(item => item.type === 'input_image')
    assert.deepEqual(images.map(item => item.image_url), input.input.frames.map(frame => `data:image/jpeg;base64,${frame.jpegBase64}`))
    assert.equal(images.length, 4)
    assert.equal(sent.model, 'gpt-5.6-terra')
    assert.deepEqual(sent.reasoning, { effort: 'low' })
    assert.equal(sent.max_output_tokens, 4096)
    assert.equal(sent.store, false)
    assert.equal(sent.text.format.strict, true)
    assert.deepEqual(sent.text.format.schema, ADVICE_SCHEMA)
    assert.equal(sent.tools, undefined)
    assert.equal(sent.previous_response_id, undefined)
    for (const rule of [
      /本人申告・静止画の観察・推測を区別/,
      /足の形だけから、実際の体重配分や体重移動の過程を断定しません/,
      /1枚のフィニッシュから「3秒止まれない」「バランスを崩した」と判断しません/,
      /良い当たり・ほぼまっすぐ/,
      /無理に矯正課題を作りません/,
      /再現性を確認する行動1つ/,
      /reasonは今回の観察または本人申告と、その行動を提案する理由を結び付け/,
      /一般的な練習案.*明記/,
      /nextFocusは1つ/,
      /別の矯正課題を混ぜない/,
      /insufficient_evidence/,
      /改善効果や分析の正確さを保証しません/,
    ]) assert.match(sent.instructions, rule)
  }
  assert.equal(calls, 16)
})

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
