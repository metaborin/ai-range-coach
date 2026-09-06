import { DurableObject } from 'cloudflare:workers'
import { validateAnalysisRequest, type AiAnalysis, type AnalysisReply, type AnalysisRequest } from '../../shared/analysis'
import { ApiError, failure, json, passwordMatches, readJson } from './http'
import { idCreatedAt, Ledger, REQUEST_LIFETIME_MS, type RequestRow } from './ledger'
import { callOpenAI, UpstreamError } from './openai'

export interface Env {
  ANALYSIS: DurableObjectNamespace
  APP_PASSWORD?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL: string
  ALLOWED_ORIGIN: string
  ENVIRONMENT?: string
}

const stateMessages: Record<string, string> = {
  pending: '分析中です。同じ要求IDで状態を確認できます。',
  failed: '分析結果を取得できませんでした。同じ要求を自動で再送しません。',
  unknown: '通信や実行が中断され、課金を含む成否を確定できません。同じ要求を自動で再送しません。',
  expired: 'サーバーの結果保存期限が終了しました。端末に保存済みの結果を確認してください。',
}
function reply(row: RequestRow): AnalysisReply {
  return {
    requestId: row.request_id, fingerprint: row.fingerprint, shotId: row.shot_id, inputRevision: row.input_revision,
    state: row.state, createdAt: row.created_at, retryUntil: new Date(row.retry_until).toISOString(),
    ...(row.result_expires_at === null ? {} : { resultExpiresAt: new Date(row.result_expires_at).toISOString() }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as AiAnalysis }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(stateMessages[row.state] ? { message: stateMessages[row.state] } : {}),
  }
}

export class AnalysisCoordinator extends DurableObject<Env> {
  private readonly ledger: Ledger
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ledger = new Ledger(ctx.storage)
    ctx.blockConcurrencyWhile(async () => {
      this.ledger.recover(Date.now())
      await this.ledger.scheduleAlarm(Date.now())
    })
  }

  async alarm(): Promise<void> {
    // Alarm deliveries may be retried. They only delete/expire metadata, never call OpenAI.
    this.ctx.storage.transactionSync(() => this.ledger.clean(Date.now()))
    await this.ledger.scheduleAlarm(Date.now())
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (!this.env.APP_PASSWORD || this.env.APP_PASSWORD.length < 24 || !this.env.OPENAI_API_KEY || this.env.OPENAI_MODEL !== 'gpt-5.6-terra') {
        throw new ApiError(503, 'not_configured', 'AI分析は準備中です。サーバーのSecretとモデル設定を確認してください。')
      }
      const now = Date.now()
      if (this.ledger.authBlocked(now)) throw new ApiError(429, 'auth_throttled', '認証試行が続いたため一時的に制限しています。5分ほど待ってください。')
      const authenticated = await passwordMatches(request.headers.get('authorization'), this.env.APP_PASSWORD)
      if (this.ledger.authBlocked(Date.now())) throw new ApiError(429, 'auth_throttled', '認証試行が続いたため一時的に制限しています。5分ほど待ってください。')
      if (!authenticated) {
        this.ledger.recordAuthFailure(Date.now())
        await this.ledger.scheduleAlarm(Date.now())
        throw new ApiError(401, 'unauthorized', 'アプリ専用パスワードを確認してください。')
      }
      this.ctx.storage.transactionSync(() => this.ledger.clean(Date.now()))
      const url = new URL(request.url)
      if (url.search) throw new ApiError(400, 'invalid_query', 'URLに認証情報や入力データを付けないでください。')
      if (request.method === 'GET' && url.pathname.startsWith('/v1/analyses/')) {
        const id = url.pathname.slice('/v1/analyses/'.length)
        const created = idCreatedAt(id)
        if (created > Date.now() + 5 * 60 * 1000) throw new ApiError(400, 'invalid_request_time', '端末の日時を確認してください。')
        const row = this.ledger.get(id)
        await this.ledger.scheduleAlarm(Date.now())
        if (row) return json(reply(row))
        const expired = created + REQUEST_LIFETIME_MS <= Date.now()
        return json({ requestId: id, fingerprint: '', shotId: '', inputRevision: 0, state: expired ? 'expired' : 'not_found',
          createdAt: new Date(created).toISOString(), retryUntil: new Date(created + REQUEST_LIFETIME_MS).toISOString(),
          message: expired ? '要求の再確認期限が終了しています。自動では再分析しません。' : 'この要求の受付を確認できません。自動では再送しません。',
        } satisfies AnalysisReply)
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/analyses') throw new ApiError(404, 'not_found', '分析APIの送信先を確認してください。')
      let input: AnalysisRequest
      const raw = await readJson(request)
      try { input = await validateAnalysisRequest(raw) }
      catch { throw new ApiError(400, 'invalid_input', '送信内容を確認できません。4場面と当たり・方向を確認してください。') }
      const reservation = this.ledger.reserve({ requestId: input.requestId, fingerprint: input.fingerprint,
        shotId: input.input.shotId, inputRevision: input.input.inputRevision, sourceFingerprint: input.input.sourceFingerprint, createdAt: input.createdAt }, Date.now())
      if (!reservation.fresh) return json(reply(reservation.row), reservation.row.state === 'pending' ? 202 : 200)
      // Persist cleanup scheduling before making the only upstream request.
      await this.ledger.scheduleAlarm(Date.now())
      let row: RequestRow | undefined
      try {
        const result = await callOpenAI(input, { OPENAI_API_KEY: this.env.OPENAI_API_KEY, OPENAI_MODEL: this.env.OPENAI_MODEL })
        row = this.ledger.finish(input.requestId, 'succeeded', Date.now(), result)
      } catch (error) {
        const upstream = error instanceof UpstreamError ? error : new UpstreamError('network_unknown', true)
        row = this.ledger.finish(input.requestId, upstream.uncertain ? 'unknown' : 'failed', Date.now(), undefined, upstream.code)
      }
      await this.ledger.scheduleAlarm(Date.now())
      if (!row) throw new ApiError(410, 'request_expired', 'この要求の再確認期限が終了しました。')
      return json(reply(row))
    } catch (error) { return failure(error) }
  }
}

function cors(response: Response, origin: string | null, allowed: string): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('Vary', 'Origin')
  if (origin === allowed) {
    headers.set('Access-Control-Allow-Origin', allowed)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  }
  return new Response(response.body, { status: response.status, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin')
    const allowed = env.ENVIRONMENT === 'development' && /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(env.ALLOWED_ORIGIN)
      ? env.ALLOWED_ORIGIN : 'https://metaborin.github.io'
    try {
      if (origin && origin !== allowed) throw new ApiError(403, 'origin_denied', 'この画面からの分析要求は許可されていません。')
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin, allowed)
      // Stream the body straight to the one personal object; no image work at the edge.
      const response = await env.ANALYSIS.get(env.ANALYSIS.idFromName('owner')).fetch(request)
      return cors(response, origin, allowed)
    } catch (error) { return cors(failure(error), origin, allowed) }
  },
} satisfies ExportedHandler<Env>
