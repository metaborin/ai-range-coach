export const ANALYSIS_SCENES = ['address', 'top', 'impact', 'finish'] as const
export type AnalysisScene = typeof ANALYSIS_SCENES[number]
export const ANALYSIS_LABELS = { address: 'アドレス', top: 'トップ', impact: 'インパクト付近', finish: 'フィニッシュ' } as const
export const CONTACT_LABELS = { good: '良い', fair: 'まずまず', poor: 'ミス', unknown: 'わからない' } as const
export const DIRECTION_LABELS = { left: '左', center: 'ほぼまっすぐ', right: '右', unknown: 'わからない' } as const
export const MAX_IMAGE_BYTES = 1024 * 1024
export const MAX_IMAGES_BYTES = 4 * MAX_IMAGE_BYTES
export const MAX_REQUEST_BYTES = 6 * 1024 * 1024
export const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000
export const RESULT_RETENTION_MS = 10 * 60 * 1000
export const PROMPT_VERSION = 'phase1-2'
export const SCHEMA_VERSION = '1'
export type AnalysisState = 'pending' | 'succeeded' | 'failed' | 'unknown' | 'expired' | 'not_found'
export interface AnalysisFrame {
  scene: AnalysisScene
  label: string
  requestedTimeSec: number
  observedTimeSec: number
  timeBasis: 'video-frame-callback' | 'video-current-time'
  width: number
  height: number
  jpegBase64: string
}
export interface AnalysisInput {
  shotId: string
  inputRevision: number
  sourceFingerprint: string
  durationSec: number
  selfReport: { contact: 'good' | 'fair' | 'poor' | 'unknown'; direction: 'left' | 'center' | 'right' | 'unknown' }
  frames: AnalysisFrame[]
}
export interface AnalysisRequest {
  requestId: string
  createdAt: string
  fingerprint: string
  input: AnalysisInput
}
export interface CoachingAdvice {
  status: 'ok' | 'insufficient_evidence'
  observations: { scene: AnalysisScene; text: string }[]
  limitations: string[]
  nextFocus: string
  reason: string
  check: string
}
export interface AiAnalysis {
  id: string
  kind: 'ai'
  requestId: string
  shotId: string
  inputRevision: number
  sourceFingerprint: string
  fingerprint: string
  createdAt: string
  model: string
  promptVersion: string
  schemaVersion: string
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; reasoningTokens?: number }
  advice: CoachingAdvice
}
export interface AnalysisReply {
  requestId: string
  fingerprint: string
  shotId: string
  inputRevision: number
  state: AnalysisState
  createdAt: string
  retryUntil: string
  resultExpiresAt?: string
  result?: AiAnalysis
  errorCode?: string
  message?: string
}
const shortString = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
export const ADVICE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'observations', 'limitations', 'nextFocus', 'reason', 'check'],
  properties: {
    status: { type: 'string', enum: ['ok', 'insufficient_evidence'] },
    observations: { type: 'array', maxItems: 4, items: {
      type: 'object', additionalProperties: false, required: ['scene', 'text'],
      properties: { scene: { type: 'string', enum: [...ANALYSIS_SCENES] }, text: shortString(180) },
    } },
    limitations: { type: 'array', minItems: 1, maxItems: 4, items: shortString(180) },
    nextFocus: shortString(100), reason: shortString(240), check: shortString(180),
  },
} as const
const badInput = () => new Error('送信内容を確認できません。4場面と当たり・方向を確認してください。')
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v)
export const isFingerprint = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v) && v >= 0
export function requestTimestamp(requestId: string): number | null {
  if (!/^\d{13}_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId)) return null
  const value = Number(requestId.slice(0, 13))
  return Number.isSafeInteger(value) ? value : null
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export function decodeBase64(value: string): Uint8Array {
  if (value.length === 0 || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw badInput()
  let decoded: string
  try { decoded = atob(value) } catch { throw badInput() }
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  if (bytes.length > MAX_IMAGE_BYTES || btoa(decoded) !== value) throw badInput()
  return bytes
}
/** Parse JPEG marker lengths/SOF/SOS/EOI; does not decompress untrusted image data. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const fail = () => { throw badInput() }
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return fail()
  let position = 2, width = 0, height = 0, scans = 0
  while (position < bytes.length) {
    if (bytes[position++] !== 0xff) return fail()
    while (bytes[position] === 0xff) position++
    const marker = bytes[position++]
    if (marker === 0xd9) {
      if (!scans || !width || position !== bytes.length) return fail()
      return { width, height }
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return fail()
    const length = (bytes[position] << 8) | bytes[position + 1]
    if (length < 2 || position + length > bytes.length) return fail()
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width || length < 11 || bytes[position + 2] !== 8) return fail()
      height = (bytes[position + 3] << 8) | bytes[position + 4]
      width = (bytes[position + 5] << 8) | bytes[position + 6]
      const components = bytes[position + 7]
      if (![1, 3].includes(components) || length !== 8 + 3 * components || width < 1 || height < 1 || Math.max(width, height) > 1280) return fail()
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return fail()
    position += length
    if (marker === 0xda) {
      if (!width) return fail()
      scans++
      while (position < bytes.length) {
        if (bytes[position] !== 0xff) { position++; continue }
        const next = bytes[position + 1]
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { position += 2; continue }
        break
      }
    }
  }
  return fail()
}
/** Canonical digest binds each decoded JPEG byte and all analysis inputs. */
export async function computeFingerprint(input: AnalysisInput): Promise<string> {
  const frames = await Promise.all(input.frames.map(async frame => ({
    scene: frame.scene, label: frame.label, requestedTimeSec: frame.requestedTimeSec,
    observedTimeSec: frame.observedTimeSec, timeBasis: frame.timeBasis, width: frame.width, height: frame.height,
    sha256: await sha256(decodeBase64(frame.jpegBase64)),
  })))
  const canonical = { shotId: input.shotId, inputRevision: input.inputRevision, sourceFingerprint: input.sourceFingerprint,
    durationSec: input.durationSec, selfReport: { contact: input.selfReport.contact, direction: input.selfReport.direction }, frames }
  return sha256(new TextEncoder().encode(JSON.stringify(canonical)))
}
export async function validateAnalysisRequest(value: unknown): Promise<AnalysisRequest> {
  if (!object(value) || !exact(value, ['requestId', 'createdAt', 'fingerprint', 'input']) || typeof value.requestId !== 'string') throw badInput()
  const timestamp = requestTimestamp(value.requestId)
  if (timestamp === null || value.createdAt !== new Date(timestamp).toISOString() || !isFingerprint(value.fingerprint)) throw badInput()
  const input = value.input
  if (!object(input) || !exact(input, ['shotId', 'inputRevision', 'sourceFingerprint', 'durationSec', 'selfReport', 'frames'])
    || !id(input.shotId) || !integer(input.inputRevision) || !isFingerprint(input.sourceFingerprint)
    || !number(input.durationSec) || input.durationSec <= 0 || input.durationSec > 30 || !object(input.selfReport)
    || !exact(input.selfReport, ['contact', 'direction']) || !['good', 'fair', 'poor', 'unknown'].includes(input.selfReport.contact as string)
    || !['left', 'center', 'right', 'unknown'].includes(input.selfReport.direction as string)
    || !Array.isArray(input.frames) || input.frames.length !== 4) throw badInput()
  let previous = -1, bytesTotal = 0
  for (let index = 0; index < 4; index++) {
    const frame = input.frames[index]
    if (!object(frame) || !exact(frame, ['scene', 'label', 'requestedTimeSec', 'observedTimeSec', 'timeBasis', 'width', 'height', 'jpegBase64'])
      || frame.scene !== ANALYSIS_SCENES[index] || frame.label !== ANALYSIS_LABELS[ANALYSIS_SCENES[index]]
      || !number(frame.requestedTimeSec) || frame.requestedTimeSec <= previous || frame.requestedTimeSec < 0 || frame.requestedTimeSec >= input.durationSec
      || !number(frame.observedTimeSec) || frame.observedTimeSec < 0 || frame.observedTimeSec > input.durationSec
      || !['video-frame-callback', 'video-current-time'].includes(frame.timeBasis as string) || typeof frame.jpegBase64 !== 'string') throw badInput()
    const bytes = decodeBase64(frame.jpegBase64)
    const dimensions = jpegDimensions(bytes)
    bytesTotal += bytes.length
    if (frame.width !== dimensions.width || frame.height !== dimensions.height || bytesTotal > MAX_IMAGES_BYTES) throw badInput()
    previous = frame.requestedTimeSec
  }
  const request = value as unknown as AnalysisRequest
  if (await computeFingerprint(request.input) !== request.fingerprint) throw badInput()
  return request
}
export function validateAdvice(value: unknown): value is CoachingAdvice {
  if (!object(value) || !exact(value, ['status', 'observations', 'limitations', 'nextFocus', 'reason', 'check'])
    || !['ok', 'insufficient_evidence'].includes(value.status as string) || !Array.isArray(value.observations) || value.observations.length > 4
    || !Array.isArray(value.limitations) || value.limitations.length < 1 || value.limitations.length > 4
    || !text(value.nextFocus, 100) || !text(value.reason, 240) || !text(value.check, 180)) return false
  return value.observations.every(v => object(v) && exact(v, ['scene', 'text']) && ANALYSIS_SCENES.includes(v.scene as AnalysisScene) && text(v.text, 180))
    && value.limitations.every(v => text(v, 180))
}
export function validateAiAnalysis(value: unknown): value is AiAnalysis {
  if (!object(value) || value.kind !== 'ai' || typeof value.requestId !== 'string' || requestTimestamp(value.requestId) === null
    || value.id !== value.requestId || !id(value.shotId) || !integer(value.inputRevision)
    || !isFingerprint(value.sourceFingerprint) || !isFingerprint(value.fingerprint) || !text(value.model, 100)
    || !text(value.promptVersion, 40) || !text(value.schemaVersion, 40) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !object(value.usage) || !integer(value.usage.inputTokens) || !integer(value.usage.outputTokens) || !integer(value.usage.totalTokens)
    || (value.usage.reasoningTokens !== undefined && !integer(value.usage.reasoningTokens)) || !validateAdvice(value.advice)) return false
  return value.usage.totalTokens >= value.usage.inputTokens && value.usage.totalTokens >= value.usage.outputTokens
}
