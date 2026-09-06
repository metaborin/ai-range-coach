import { ApiError } from './http'
import { requestTimestamp, REQUEST_RETENTION_MS, RESULT_RETENTION_MS } from '../../shared/analysis'

export const REQUEST_LIFETIME_MS = REQUEST_RETENTION_MS
export const RESULT_LIFETIME_MS = RESULT_RETENTION_MS
export const LOCK_LIFETIME_MS = 90 * 1000
const AUTH_WINDOW_MS = 5 * 60 * 1000

export interface RequestRow {
  request_id: string; fingerprint: string; shot_id: string; input_revision: number
  source_fingerprint: string; created_at: string; accepted_at: number; retry_until: number
  state: 'pending' | 'succeeded' | 'failed' | 'unknown' | 'expired'
  lock_until: number; result_expires_at: number | null; result_json: string | null; error_code: string | null
}
export interface Reservation {
  requestId: string; fingerprint: string; shotId: string; inputRevision: number
  sourceFingerprint: string; createdAt: string
}

export function idCreatedAt(id: string): number {
  const created = requestTimestamp(id)
  if (created === null) throw new ApiError(400, 'invalid_request_id', '要求IDを確認してください。')
  return created
}

export function quotaPeriods(now: number) {
  const jst = new Date(now + 9 * 60 * 60 * 1000)
  const date = jst.toISOString()
  const midnight = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1) - 9 * 60 * 60 * 1000
  const monthEnd = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 60 * 60 * 1000
  return [
    { key: `day:${date.slice(0, 10)}`, limit: 20, expires: midnight },
    { key: `month:${date.slice(0, 7)}`, limit: 100, expires: monthEnd },
  ]
}

export class Ledger {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS requests (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, shot_id TEXT NOT NULL, input_revision INTEGER NOT NULL,
      source_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, accepted_at INTEGER NOT NULL, retry_until INTEGER NOT NULL,
      state TEXT NOT NULL, lock_until INTEGER NOT NULL, result_expires_at INTEGER, result_json TEXT, error_code TEXT
    )`)
    storage.sql.exec('CREATE TABLE IF NOT EXISTS quota (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)')
    storage.sql.exec('CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK(id=1), failures INTEGER NOT NULL, window_until INTEGER NOT NULL)')
  }

  recover(now: number): void {
    this.storage.transactionSync(() => {
      // A new instance cannot know whether an earlier upstream request finished.
      this.storage.sql.exec("UPDATE requests SET state='unknown', error_code='interrupted' WHERE state='pending'")
      this.clean(now)
    })
  }

  clean(now: number): void {
    this.storage.sql.exec("UPDATE requests SET state='unknown', error_code='timeout' WHERE state='pending' AND lock_until<=?", now)
    this.storage.sql.exec("UPDATE requests SET state='expired', result_json=NULL, error_code='result_expired' WHERE result_expires_at<=? AND result_json IS NOT NULL", now)
    this.storage.sql.exec('DELETE FROM requests WHERE retry_until<=?', now)
    this.storage.sql.exec('DELETE FROM quota WHERE expires_at<=?', now)
    this.storage.sql.exec('DELETE FROM auth WHERE window_until<=?', now)
  }

  get(id: string): RequestRow | undefined {
    return this.storage.sql.exec<RequestRow & Record<string, SqlStorageValue>>('SELECT * FROM requests WHERE request_id=?', id).toArray()[0]
  }

  authBlocked(now: number): boolean {
    const row = this.storage.sql.exec<{ failures: number; window_until: number }>('SELECT failures,window_until FROM auth WHERE id=1').toArray()[0]
    return Boolean(row && row.window_until > now && row.failures >= 10)
  }

  recordAuthFailure(now: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`INSERT INTO auth(id,failures,window_until) VALUES(1,1,?)
        ON CONFLICT(id) DO UPDATE SET failures=CASE WHEN window_until<=? THEN 1 ELSE failures+1 END,
        window_until=CASE WHEN window_until<=? THEN excluded.window_until ELSE window_until END`, now + AUTH_WINDOW_MS, now, now)
    })
  }

  reserve(input: Reservation, now: number): { row: RequestRow; fresh: boolean } {
    return this.storage.transactionSync(() => {
      this.clean(now)
      const existing = this.get(input.requestId)
      if (existing) {
        if (existing.fingerprint !== input.fingerprint || existing.shot_id !== input.shotId || existing.input_revision !== input.inputRevision) {
          throw new ApiError(409, 'request_conflict', '同じ要求IDで内容が変更されています。元の要求の状態を確認してください。')
        }
        return { row: existing, fresh: false }
      }
      const created = idCreatedAt(input.requestId)
      if (created + REQUEST_LIFETIME_MS <= now) throw new ApiError(410, 'request_expired', 'この要求の再確認期限が終了しています。自動では再分析しません。')
      if (created > now + 5 * 60 * 1000 || Date.parse(input.createdAt) !== created) {
        throw new ApiError(400, 'invalid_request_time', '端末の日時と要求の開始時刻を確認してください。')
      }
      const locked = this.storage.sql.exec('SELECT request_id FROM requests WHERE lock_until>? LIMIT 1', now).toArray().length > 0
      if (locked) throw new ApiError(409, 'analysis_busy', '別の分析を処理中です。先にその要求の状態を確認してください。')
      const periods = quotaPeriods(now)
      for (const period of periods) {
        const used = this.storage.sql.exec<{ count: number }>('SELECT count FROM quota WHERE bucket=?', period.key).toArray()[0]?.count ?? 0
        if (used >= period.limit) throw new ApiError(429, 'quota_exceeded', '日本時間の利用上限に達しました。1日20回・月100回までです。')
      }
      for (const period of periods) {
        this.storage.sql.exec('INSERT INTO quota(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1', period.key, period.expires)
      }
      this.storage.sql.exec(`INSERT INTO requests(request_id,fingerprint,shot_id,input_revision,source_fingerprint,created_at,accepted_at,retry_until,state,lock_until)
        VALUES(?,?,?,?,?,?,?,?,'pending',?)`, input.requestId, input.fingerprint, input.shotId, input.inputRevision,
        input.sourceFingerprint, input.createdAt, now, created + REQUEST_LIFETIME_MS, now + LOCK_LIFETIME_MS)
      return { row: this.get(input.requestId)!, fresh: true }
    })
  }

  finish(id: string, state: 'succeeded' | 'failed' | 'unknown', now: number, result?: unknown, errorCode?: string): RequestRow | undefined {
    return this.storage.transactionSync(() => {
      this.clean(now)
      const row = this.get(id)
      if (!row || row.state !== 'pending') return row
      const expires = result === undefined ? null : Math.min(now + RESULT_LIFETIME_MS, row.retry_until)
      this.storage.sql.exec(`UPDATE requests SET state=?, result_expires_at=?, result_json=?, error_code=?, lock_until=? WHERE request_id=? AND state='pending'`,
        state, expires, result === undefined ? null : JSON.stringify(result), errorCode ?? null, state === 'unknown' ? row.lock_until : 0, id)
      return this.get(id)
    })
  }

  async scheduleAlarm(now: number): Promise<void> {
    const times = this.storage.sql.exec<{ due: number }>(`SELECT MIN(due) AS due FROM (
      SELECT retry_until AS due FROM requests UNION ALL
      SELECT result_expires_at FROM requests WHERE result_json IS NOT NULL UNION ALL
      SELECT lock_until FROM requests WHERE state='pending' UNION ALL
      SELECT expires_at FROM quota UNION ALL SELECT window_until FROM auth
    )`).toArray()[0]?.due
    if (times == null) await this.storage.deleteAlarm()
    else await this.storage.setAlarm(Math.max(now + 1, times))
  }
}
