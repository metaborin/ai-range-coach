import { useEffect, useRef, useState } from 'react'
import { AnalysisHttpError, loadAnalysisConfig } from './analysisClient'
import { AnalysisService, type LocalAnalysisRequest } from './analysisService'
import { SCENE_LABELS, type Session } from './domain'
import { storageErrorMessage, type SessionStorage } from './storage'
import type { AiAnalysis } from '../shared/analysis'

type Props = {
  session: Session
  dirty: boolean
  visible: boolean
  getStorage: () => Promise<SessionStorage>
  onSaved: (sessionId: string) => Promise<void>
}
type HeldResult = { request: LocalAnalysisRequest; result: AiAnalysis }

export function AnalysisPanel({ session, dirty, visible, getStorage, onSaved }: Props) {
  const callbacks = useRef({ getStorage, onSaved })
  callbacks.current = { getStorage, onSaved }
  const live = useRef(true)
  const actionGate = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const service = useRef<{ url: string; value: AnalysisService } | null>(null)
  const [apiUrl, setApiUrl] = useState<string | null | undefined>(undefined)
  const [password, setPassword] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [attempt, setAttempt] = useState<LocalAnalysisRequest | null>(null)
  const [held, setHeld] = useState<HeldResult | null>(null)
  const [busy, setBusy] = useState<'prepare' | 'start' | 'check' | 'save' | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  async function getService(url = apiUrl || '') {
    if (!service.current || service.current.url !== url) {
      service.current = { url, value: new AnalysisService(await callbacks.current.getStorage(), url) }
    }
    return service.current.value
  }
  async function refreshAttempt(client: AnalysisService) {
    const requests = await client.list(session.id)
    const latest = [...requests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null
    if (live.current) setAttempt(latest)
    return latest
  }
  useEffect(() => {
    live.current = true
    void loadAnalysisConfig().then(async url => {
      if (!live.current) return
      setApiUrl(url)
      const client = await getService(url || '')
      const latest = await refreshAttempt(client)
      const saved = session.sets[0].analysisResult
      if (live.current && latest?.result && (saved?.kind !== 'ai' || saved.fingerprint !== latest.result.fingerprint || saved.createdAt !== latest.result.createdAt)) {
        setHeld({ request: latest, result: latest.result })
      }
    }).catch(() => { if (live.current) { setApiUrl(null); setError('分析の準備状況を読み込めませんでした。オンラインで開き直してください。') } })
    const updateOnline = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    return () => {
      live.current = false
      abort.current?.abort()
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
    // This panel is keyed by saved session ID and stays mounted while editing it.
    // Configuration and request lookup never initiate an analysis.
  }, [])
  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])

  async function storeResult(client: AnalysisService, value: HeldResult) {
    if (live.current) { setHeld(value); setBusy('save') }
    let stored: boolean
    try {
      stored = await client.saveResult(value.request, value.result)
    } catch {
      if (live.current) setError('分析結果の端末保存に失敗しました。結果はこの画面に残っています。保存し直してもAPIは呼び直しません。')
      return
    }
    if (!stored) {
      if (live.current) setError('元の記録が削除されたため、分析結果を保存できませんでした。')
      return
    }
    if (live.current) { setHeld(null); setNotice('分析結果をこの端末に保存しました。') }
    try { await callbacks.current.onSaved(value.request.sessionId) }
    catch { if (live.current) setError('分析結果の保存は完了しました。表示の更新は、記録を開き直して確認してください。') }
  }
  async function communicate(kind: 'start' | 'check') {
    if (actionGate.current || !apiUrl || !online || password.length < 24 || (kind === 'start' && (dirty || held))) return
    actionGate.current = true
    const controller = new AbortController()
    abort.current = controller
    setBusy(kind === 'start' ? 'prepare' : 'check'); setError(''); setNotice('')
    let local = kind === 'check' ? attempt : null
    let client: AnalysisService | undefined
    try {
      client = await getService()
      if (kind === 'start') {
        local = await client.prepare(session.id)
        if (live.current) setAttempt(local)
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
        if (live.current) setBusy('start')
      }
      if (!local) return
      const reply = kind === 'start'
        ? await client.start(local, password, controller.signal)
        : await client.check(local, password, controller.signal)
      if (live.current) setAttempt({ ...local, ...reply })
      if (reply.result) await storeResult(client, { request: local, result: reply.result })
      else if (live.current && reply.state === 'failed') setError('分析を完了できませんでした。専用パスワード・利用枠・画像の内容を確認してください。')
      await refreshAttempt(client)
    } catch (cause) {
      if (local && client) {
        try {
          const current = await refreshAttempt(client)
          if (!current || current.requestId === local.requestId && current.state === 'pending') {
            await client.markUnknown(local.requestId)
            await refreshAttempt(client)
          }
        } catch { if (live.current) setAttempt({ ...local, state: 'unknown' }) }
        if (live.current) setError(controller.signal.aborted
          ? '待機を中止しました。課金やサーバー側の処理を取り消したとは限りません。同じ要求の状態を確認してください。'
          : cause instanceof AnalysisHttpError ? cause.message
            : '通信の結果を確認できませんでした。新しく送信する前に、同じ要求の状態を確認してください。')
      } else if (live.current) setError(`送信前の記録を準備できませんでした。画像は送信していません。${storageErrorMessage(cause)}`)
    } finally {
      actionGate.current = false
      abort.current = null
      if (live.current) setBusy(null)
    }
  }
  async function retrySave() {
    if (!held || actionGate.current) return
    actionGate.current = true; setBusy('save'); setError(''); setNotice('')
    try { await storeResult(await getService(), held) }
    catch { if (live.current) setError('端末の保存領域を利用できませんでした。結果を残して再試行できます。') }
    finally { actionGate.current = false; if (live.current) setBusy(null) }
  }

  const shot = session.sets[0].shots[0]
  const savedResult = session.sets[0].analysisResult
  const result = held?.result || (savedResult?.kind === 'ai' ? savedResult : null)
  const stale = Boolean(result && (dirty
    || shot.inputRevision !== undefined && shot.inputRevision !== result.inputRevision
    || shot.inputFingerprint && shot.inputFingerprint !== result.sourceFingerprint))
  const unresolved = attempt && ['pending', 'unknown', 'not_found'].includes(attempt.state)
  const enabled = Boolean(apiUrl) && online && password.length >= 24 && !busy
  return <section className="panel analysis-panel" hidden={!visible} aria-label="1球のAI分析">
    <p className="eyebrow">保存した1球から、次に試すことを1つ</p><h2>AI分析</h2>
    {result ? <div className="analysis-result">
      {stale && <p className="notice">変更前の内容に対する分析です。現在の画像・時刻・本人入力で分析し直してください。</p>}
      {held && <p className="notice">この分析結果はまだ端末に保存できていません。</p>}
      <p className="analysis-state">{result.advice.status === 'insufficient_evidence' ? '判断材料が足りません' : '分析が完了しました'}</p>
      <h3>次の練習で試すこと</h3><p className="focus">{result.advice.nextFocus}</p>
      <h3>その理由</h3><p>{result.advice.reason}</p><h3>次の練習での確認方法</h3><p>{result.advice.check}</p>
      <h3>画像から見えたこと</h3><ul>{result.advice.observations.map((item, index) => <li key={index}><strong>{SCENE_LABELS[item.scene]}</strong>：{item.text}</li>)}</ul>
      <h3>判断の限界</h3><ul>{result.advice.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <p className="hint">当たり・方向は本人の申告です。画像から測定した球筋ではありません。</p>
      <small>分析日時：{new Date(result.createdAt).toLocaleString('ja-JP')} · モデル：{result.model}</small>
    </div> : <p className="analysis-state">未分析</p>}
    {apiUrl === undefined ? <p role="status">AI分析の準備状況を確認中…</p> : !apiUrl && <p className="notice">AI分析は準備中です。動画の操作と端末保存は引き続き使えます。</p>}
    {!online && <p className="notice">オフラインです。保存済みの動画や結果は使えます。新しい分析と状態確認には通信が必要です。</p>}
    <p className="send-explanation">画像4枚と当たり・方向をAIに送信します。API利用料が発生します。</p>
    <p className="hint">元動画・音声・元ファイル名は送信しません。</p>
    <label className="password-label">アプリ専用パスワード<input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={password} disabled={Boolean(busy) || !apiUrl}
      onChange={event => setPassword(event.target.value)} aria-describedby={`password-help-${session.id}`} /></label>
    <p className="hint" id={`password-help-${session.id}`}>OpenAIのAPIキーとは別の、24文字以上の専用パスワードです。このアプリでは画面を開いている間だけ保持し、端末の記録には保存しません。</p>
    {busy && <p role="status">{busy === 'prepare' ? '送信の準備中' : busy === 'check' ? '同じ要求の状態を確認中' : busy === 'save' ? '分析結果を保存中' : '分析中'}… 経過 {elapsed} 秒</p>}
    {busy && busy !== 'save' && <button className="full" onClick={() => abort.current?.abort()}>待機を中止</button>}
    {unresolved && !busy && <p className="notice">{attempt.state === 'pending' ? '処理の完了をまだ確認していません。' : '前の分析要求の結果が不明です。'} 同じ要求の状態を確認してください。新しい分析を自動で送信しません。</p>}
    {attempt?.state === 'failed' && !busy && <p className="notice">前の分析は完了しませんでした。内容や専用パスワード・利用枠を確認してから操作してください。</p>}
    {attempt && ['expired', 'not_found'].includes(attempt.state) && <p className="hint">確認できる結果が見つからないか、確認期限を過ぎています。新しい分析には再び料金が発生します。</p>}
    {held ? <button className="primary full" disabled={Boolean(busy)} onClick={() => void retrySave()}>結果をこの端末に保存し直す</button>
      : unresolved ? <>
        <button className="primary full" disabled={!enabled} onClick={() => void communicate('check')}>同じ要求の状態を確認</button>
        {attempt.state !== 'pending' && <button className="full secondary-action" disabled={!enabled || dirty} onClick={() => void communicate('start')}>新しく分析する（再度料金が発生）</button>}
      </> : <button className="primary full" disabled={!enabled || dirty} onClick={() => void communicate('start')}>{result ? '新しく分析する（再度料金が発生）' : 'AIで分析する'}</button>}
    {attempt && !unresolved && !held && attempt.state !== 'succeeded' && <button className="full secondary-action" disabled={!enabled} onClick={() => void communicate('check')}>同じ要求の状態を確認</button>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p className="success" role="status">{notice}</p>}
  </section>
}
