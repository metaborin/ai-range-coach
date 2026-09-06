import { MAX_REQUEST_BYTES } from '../../shared/analysis'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message) }
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

export function failure(error: unknown): Response {
  return error instanceof ApiError
    ? json({ errorCode: error.code, message: error.message }, error.status)
    : json({ errorCode: 'server_error', message: '分析の受付を確認できませんでした。同じ要求の状態を確認してください。' }, 503)
}

/** Bound actual streamed bytes; Content-Length is only an early rejection hint. */
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'invalid_content_type', '分析データはJSONで送信してください。')
  }
  const declared = Number(request.headers.get('content-length'))
  if (declared > MAX_REQUEST_BYTES) throw new ApiError(413, 'body_too_large', '送信データが6 MiBを超えています。')
  if (!request.body) throw new ApiError(400, 'invalid_input', '分析データがありません。')
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let total = 0, text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel()
        throw new ApiError(413, 'body_too_large', '送信データが6 MiBを超えています。')
      }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'invalid_input', '分析データを読み取れません。保存した内容を確認してください。')
  } finally { reader.releaseLock() }
}

export async function passwordMatches(header: string | null, password: string): Promise<boolean> {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (supplied.length > 1024) return false
  const encode = new TextEncoder()
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode.encode(supplied)),
    crypto.subtle.digest('SHA-256', encode.encode(password)),
  ])
  const a = new Uint8Array(actual), b = new Uint8Array(expected)
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0 && supplied.length >= 24
}
