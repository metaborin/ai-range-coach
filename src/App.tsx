import { useEffect, useRef, useState } from 'react'
import { VideoPanel } from './VideoPanel'
import { PwaStatus } from './PwaStatus'
import { appPath } from './deployment'
import { validateVideoSize } from './media'
import { CONTACT_LABELS, DIRECTION_LABELS, SCENES, SCENE_LABELS, createSession, makeDummy, newId, validateSession,
  type Contact, type Direction, type MediaAsset, type Scene, type Session } from './domain'
import { openStorage, storageErrorMessage, type SessionStorage } from './storage'

type View = 'home' | 'video' | 'input' | 'result' | 'saved'
const sceneHints: Record<Scene, string> = {
  address: '振り始める前の、構えたところ', top: 'クラブを振り上げて、切り返すあたり',
  impact: 'クラブがボールに当たる前後。いちばん近い場面でOK', finish: '振り終わったところ',
}
const dateLabel = (value: string) => new Date(value).toLocaleString('ja-JP')
function AssetImage({ asset, label }: { asset?: MediaAsset; label: string }) {
  const imageRef = useRef<HTMLImageElement>(null)
  useEffect(() => {
    if (!asset) return
    const image = imageRef.current!, url = URL.createObjectURL(asset.blob)
    image.src = url
    return () => { image.removeAttribute('src'); URL.revokeObjectURL(url) }
  }, [asset])
  return asset ? <img ref={imageRef} alt={label} /> : <div className="empty-frame">未指定</div>
}

export default function App() {
  // Binary media lives outside React state; UI state contains IDs and metadata.
  const assets = useRef(new Map<string, MediaAsset>())
  const storage = useRef<Promise<SessionStorage> | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const actionGate = useRef(false)
  const [view, setView] = useState<View>('home')
  const [draft, setDraft] = useState<Session | null>(null)
  const [history, setHistory] = useState<Session[]>([])
  const [selected, setSelected] = useState<Scene>('address')
  const [dirty, setDirty] = useState(false)
  const [persisted, setPersisted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [working, setWorking] = useState(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  const [mediaReady, setMediaReady] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function getStorage() {
    if (!storage.current) storage.current = openStorage().catch((cause: unknown) => { storage.current = null; throw cause })
    return storage.current
  }
  async function refreshHistory() { setHistory(await (await getStorage()).list()) }
  useEffect(() => { void refreshHistory().catch((cause: unknown) => setError(storageErrorMessage(cause))) }, [])
  useEffect(() => {
    if (!dirty) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
  const shot = draft?.sets[0].shots[0]
  const videoAsset = shot ? assets.current.get(shot.video.assetId) : undefined
  const blocked = saving || working || mediaBusy
  function edit(change: (next: Session) => void) {
    setDraft((current) => {
      if (!current) return current
      const next = structuredClone(current); change(next); next.sets[0].analysisResult = null
      return next
    })
    setDirty(true); setMessage(''); setError('')
  }
  function chooseFile() { if (!blocked) { fileInput.current!.value = ''; fileInput.current!.click() } }
  function goHome() {
    if (blocked || (dirty && !window.confirm('未保存の変更を破棄してホームへ戻りますか？'))) return
    setView('home'); setDraft(null); setDirty(false); setPersisted(false); setMediaReady(false)
    assets.current = new Map(); setError(''); setMessage('')
    void refreshHistory().catch((cause: unknown) => setError(storageErrorMessage(cause)))
  }
  function sceneErrors() {
    if (!draft) return ['動画を選んでください。']
    const check = structuredClone(draft)
    check.sets[0].shots[0].selfReport = { contact: 'unknown', direction: 'unknown' }
    check.sets[0].analysisResult = makeDummy(check.sets[0].shots[0].id)
    return validateSession(check)
  }
  async function openRecord(id: string) {
    if (actionGate.current) return
    actionGate.current = true; setWorking(true); setError('')
    try {
      const record = await (await getStorage()).load(id)
      if (!record) throw new Error('記録が見つかりません。保存一覧を開き直してください。')
      assets.current = record.assets; setDraft(record.session); setPersisted(true); setDirty(false); setMediaReady(false); setView('saved')
    } catch (cause) { setError(storageErrorMessage(cause)) }
    finally { actionGate.current = false; setWorking(false) }
  }
  async function save() {
    if (!draft || actionGate.current) return
    const errors = validateSession(draft)
    if (errors.length) { setError(errors.join(' ')); return }
    actionGate.current = true; setSaving(true); setError(''); setMessage('')
    const snapshot = structuredClone(draft); snapshot.updatedAt = new Date().toISOString()
    try {
      await (await getStorage()).save(snapshot, assets.current)
      setDraft(snapshot); setDirty(false); setPersisted(true); setView('saved'); setMessage('保存しました')
      try { await refreshHistory() } catch { setError('保存は完了しました。保存一覧の更新は、ホームからもう一度お試しください。') }
    } catch (cause) { setDirty(true); setError(storageErrorMessage(cause)) }
    finally { actionGate.current = false; setSaving(false) }
  }
  async function remove() {
    if (!draft || actionGate.current || !window.confirm('この記録と、この記録だけで使う動画・4画像を端末から削除しますか？')) return
    actionGate.current = true; setWorking(true); setError('')
    try {
      await (await getStorage()).delete(draft.id)
      setView('home'); setDraft(null); setDirty(false); setPersisted(false); assets.current = new Map()
      setMessage('記録を削除しました')
      try { await refreshHistory() } catch { setError('削除は完了しました。保存一覧を開き直してください。') }
    } catch (cause) { setError(storageErrorMessage(cause)) }
    finally { actionGate.current = false; setWorking(false) }
  }
  function showDummy() {
    if (!draft) return
    const next = structuredClone(draft); next.sets[0].analysisResult = makeDummy(next.sets[0].shots[0].id)
    const errors = validateSession(next)
    if (errors.length) { setError(errors.join(' ')); return }
    setDraft(next); setError(''); setView('result')
  }
  function frames(canEdit: boolean) {
    if (!shot) return null
    return <div className="frames">{SCENES.map((scene, index) => {
      const frame = shot.scenes[scene]
      return <article className={`frame ${canEdit && scene === selected ? 'selected' : ''}`} key={scene}>
        <div className="frame-title"><span className="number">0{index + 1}</span><strong>{SCENE_LABELS[scene]}</strong></div>
        <AssetImage asset={frame ? assets.current.get(frame.assetId) : undefined} label={SCENE_LABELS[scene]} />
        {frame ? <div className="frame-time">指定 {frame.requestedTimeSec.toFixed(2)} 秒<br /><small>取得 {frame.observedTimeSec.toFixed(3)} 秒<br />{frame.timeBasis === 'video-frame-callback' ? '描画フレーム通知の時刻' : '再生位置の代替値（正確なフレーム時刻ではありません）'}</small></div> : <p className="hint">{sceneHints[scene]}</p>}
        {canEdit && <button className="full" disabled={blocked} aria-pressed={scene === selected} onClick={() => { setSelected(scene); setError('') }}>{SCENE_LABELS[scene]}を選ぶ</button>}
      </article>
    })}</div>
  }
  return <>
    <header className="app-header"><div className="brand"><img src={appPath('icon-192.png')} alt="" /><span>AIレンジコーチ</span></div><span className="phase">Phase 0</span></header>
    <div className="demo-banner">動作確認用の見本・動画未分析</div>
    <main>
      <input ref={fileInput} type="file" accept="video/*" className="file-input" aria-label="動画ファイル" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file || blocked) return
        try { validateVideoSize(file.size) } catch (cause) { setError(cause instanceof Error ? cause.message : '動画を選び直してください。'); return }
        if (draft && !window.confirm('動画を選び直すと、4場面・当たり・方向・見本結果をリセットします。保存済みの内容は、新しく保存できるまで残ります。変更しますか？')) return
        const id = newId(), asset: MediaAsset = { id, kind: 'video', mimeType: file.type, sizeBytes: file.size, blob: file }
        assets.current = new Map([[id, asset]])
        const meta = { assetId: id, fileName: file.name, durationSec: 0, width: 0, height: 0 }
        const next = draft ? structuredClone(draft) : createSession(meta)
        next.sets[0].shots[0].video = meta; next.sets[0].shots[0].scenes = {}
        next.sets[0].shots[0].selfReport = { contact: null, direction: null }; next.sets[0].analysisResult = null
        setDraft(next); setView('video'); setDirty(true); setSelected('address'); setMediaReady(false); setError(''); setMessage('')
      }} />
      {view === 'home' ? <>
        <section className="hero"><p className="eyebrow">1球ずつ、練習を記録。</p><h1>今日のひと振りを、<br />見返せるかたちに。</h1><p>動画の4つの場面と、<br />自分が感じた当たり・方向を残します。</p><button className="primary full" disabled={blocked} onClick={chooseFile}>1球の動画を選ぶ <span aria-hidden="true">＋</span></button><p className="hint">写真ライブラリの動画を1本選びます。</p></section>
        <section className="guide-card"><h2>まずは短い、通常撮影の動画で</h2><p>おすすめ：5〜15秒・1080p・30/60fps</p><p className="hint">受付は0秒超〜30秒以下・100 MiB以下。この上限は本プロジェクトの暫定値です。MOV／MP4も実際に読み込んで確認します。すべてのHEVC・4K・HDR・スロー動画への対応は保証しません。</p></section>
        <section className="history"><div className="section-heading"><h2>保存した1球</h2><span>{history.length} 件</span></div>
          {history.length === 0 ? <div className="empty-history"><span aria-hidden="true">○</span><p>保存した記録はここに並びます。</p></div> : history.map((item) => {
            const report = item.sets[0].shots[0].selfReport
            return <article className="history-item" key={item.id}><div><h3>{dateLabel(item.createdAt)}</h3><p>{report.contact ? CONTACT_LABELS[report.contact] : '未入力'} ・ {report.direction ? DIRECTION_LABELS[report.direction] : '未入力'}</p><small>1球 · 動作確認用の見本・動画未分析</small></div><button disabled={blocked} onClick={() => void openRecord(item.id)}>記録を開く</button></article>
          })}
        </section>
      </> : draft && shot && <>
        <div className="editor-heading"><button className="text-button" disabled={blocked} onClick={goHome}>ホームへ</button><span className={`save-status ${dirty ? 'unsaved' : ''}`} role="status">{saving ? '保存中…' : dirty || !persisted ? '未保存' : '保存済み'}</span></div>
        <ol className="steps" aria-label="記録の手順"><li className={view === 'video' ? 'current' : ''}>1 動画・4場面</li><li className={view === 'input' ? 'current' : ''}>2 当たり・方向</li><li className={view === 'result' || view === 'saved' ? 'current' : ''}>3 見本・保存</li></ol>
        {(view === 'video' || view === 'saved') && <section className="panel">
          <div className="section-heading"><h1>{view === 'saved' ? '保存した1球' : '動画と4つの場面'}</h1>{view === 'video' && <button disabled={blocked} onClick={chooseFile}>動画を選び直す</button>}</div>
          {view === 'video' && <div className="selected-scene"><span className="eyebrow">今から指定する場面</span><h2>{SCENE_LABELS[selected]}</h2><p>{sceneHints[selected]}</p></div>}
          {videoAsset && <VideoPanel key={videoAsset.id} asset={videoAsset} locked={saving || working} captureLabel="この場面にする" showCapture={view === 'video'}
            onBusy={setMediaBusy} onReady={(meta) => {
              setMediaReady(true)
              setDraft((current) => {
                if (!current || current.sets[0].shots[0].video.assetId !== videoAsset.id) return current
                const next = structuredClone(current)
                Object.assign(next.sets[0].shots[0].video, { durationSec: meta.durationSec, width: meta.width, height: meta.height })
                return next
              })
            }} onCapture={(frame) => {
              const oldId = shot.scenes[selected]?.assetId
              if (oldId) assets.current.delete(oldId)
              const id = newId()
              assets.current.set(id, { id, kind: 'frame', mimeType: frame.blob.type, sizeBytes: frame.blob.size, blob: frame.blob })
              edit((next) => { next.sets[0].shots[0].scenes[selected] = { assetId: id, requestedTimeSec: frame.requestedTimeSec, observedTimeSec: frame.observedTimeSec, timeBasis: frame.timeBasis, width: frame.width, height: frame.height } })
              setSelected(SCENES[Math.min(SCENES.indexOf(selected) + 1, 3)])
            }} />}
          <p className="hint">元動画：{shot.video.durationSec.toFixed(2)}秒 ・ {((videoAsset?.sizeBytes ?? 0) / 1048576).toFixed(1)} MiB</p>
        </section>}
        {(view === 'video' || view === 'result' || view === 'saved') && <section className="panel"><div className="section-heading"><h2>手動で選んだ4場面</h2><span>{Object.keys(shot.scenes).length} / 4</span></div>{frames(view === 'video')}
          {view === 'video' && <><p className="hint">アドレス → トップ → インパクト付近 → フィニッシュの順で、違う時刻を選んでください。終端は少し戻します。</p><button className="primary full" disabled={blocked || !mediaReady} onClick={() => {
            const errors = sceneErrors(); if (errors.length) { setError(errors.join(' ')); return }
            setError(''); setView('input')
          }}>当たりと方向へ</button></>}
        </section>}
        {view === 'input' && <section className="panel"><p className="eyebrow">自分が見た、感じた結果</p><h1>当たりと方向</h1>
          <fieldset><legend>当たり <small>{shot.selfReport.contact === null ? '未入力' : '入力済み'}</small></legend><div className="options">{(Object.entries(CONTACT_LABELS) as [Contact, string][]).map(([value, label]) => <button key={value} disabled={blocked} aria-pressed={shot.selfReport.contact === value} onClick={() => edit((next) => { next.sets[0].shots[0].selfReport.contact = value })}>{label}</button>)}</div></fieldset>
          <fieldset><legend>方向 <small>{shot.selfReport.direction === null ? '未入力' : '入力済み'}</small></legend><p className="hint">狙った方向に対して、本人が見届けた範囲で選んでください。</p><div className="options">{(Object.entries(DIRECTION_LABELS) as [Direction, string][]).map(([value, label]) => <button key={value} disabled={blocked} aria-pressed={shot.selfReport.direction === value} onClick={() => edit((next) => { next.sets[0].shots[0].selfReport.direction = value })}>{label}</button>)}</div></fieldset>
          <p className="hint">判断できなければ「わからない」で大丈夫です。</p><button className="primary full" disabled={blocked} onClick={showDummy}>見本結果へ</button><button className="full secondary-action" disabled={blocked} onClick={() => { setError(''); setView('video'); setMediaReady(false) }}>戻る</button>
        </section>}
        {(view === 'result' || view === 'saved') && <section className="result panel"><p className="eyebrow">動作確認用の見本・動画未分析</p><h2>練習課題の表示例</h2><p className="focus">{draft.sets[0].analysisResult?.nextFocus}</p><p className="hint">この内容は固定の表示例です。あなたの動画や入力を分析した結果ではありません。</p><dl className="self-report"><div><dt>本人の当たり</dt><dd>{shot.selfReport.contact ? CONTACT_LABELS[shot.selfReport.contact] : '未入力'}</dd></div><div><dt>本人の方向</dt><dd>{shot.selfReport.direction ? DIRECTION_LABELS[shot.selfReport.direction] : '未入力'}</dd></div></dl>
          {view === 'result' ? <><button className="primary full" disabled={blocked} onClick={() => void save()}>{saving ? '保存中…' : 'この端末に保存'}</button><button className="full secondary-action" disabled={blocked} onClick={() => { setView('input'); setError('') }}>内容を直す</button></> : <><p className="hint">更新：{dateLabel(draft.updatedAt)}</p><button className="primary full" disabled={blocked} onClick={() => { setView('video'); setSelected('address'); setMessage('') }}>編集</button><button className="danger full secondary-action" disabled={blocked} onClick={() => void remove()}>この記録を削除</button></>}
        </section>}
      </>}
      {working && <p role="status">記録を処理中…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {message && <p className="success" role="status">{message}</p>}
      <PwaStatus />
      <footer><p>動画・画像・入力は、この端末内に保存します。<br />外部へ送信しません。</p><p>元動画は写真アプリに残してください。端末内データの永久保存、Safariとホーム画面PWAの共有、未保存で終了した内容の復元は保証しません。</p></footer>
    </main>
  </>
}
