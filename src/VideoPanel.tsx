import { useEffect, useRef, useState } from 'react'
import { loadVideo, releaseVideo, MediaController } from './media'
import type { MediaAsset } from './domain'

type Frame = Awaited<ReturnType<MediaController['capture']>>
type Props = {
  asset: MediaAsset
  locked?: boolean
  captureLabel: string
  showCapture?: boolean
  onCapture: (frame: Frame) => void
  onReady: (metadata: { durationSec: number; width: number; height: number }) => void
  onBusy: (busy: boolean) => void
}

export function VideoPanel({ asset, locked, captureLabel, showCapture = true, onCapture, onReady, onBusy }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controller = useRef<MediaController | null>(null)
  const callbacks = useRef({ onCapture, onReady, onBusy })
  callbacks.current = { onCapture, onReady, onBusy }
  const gate = useRef(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => {
    const video = videoRef.current!
    const abort = new AbortController()
    let url: string | undefined
    let live = true
    gate.current = true
    callbacks.current.onBusy(true)
    setReady(false)
    setBusy(true)
    setError('')
    setTime(0)
    void loadVideo(video, asset.blob, abort.signal).then((loaded) => {
      if (!live) { releaseVideo(video, loaded.url); return }
      url = loaded.url
      controller.current = new MediaController(video)
      setDuration(loaded.durationSec)
      setReady(true)
      callbacks.current.onReady(loaded)
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : 'この動画を読み込めませんでした。選び直してください。')
    }).finally(() => {
      if (live) { gate.current = false; setBusy(false); callbacks.current.onBusy(false) }
    })
    return () => {
      live = false
      abort.abort()
      controller.current?.dispose()
      controller.current = null
      if (url) releaseVideo(video, url)
    }
  }, [asset])

  async function run(action: (control: MediaController) => Promise<void>) {
    if (gate.current || locked || !controller.current) return
    gate.current = true
    setBusy(true)
    callbacks.current.onBusy(true)
    setError('')
    const control = controller.current
    try { await action(control) }
    catch (cause) { if (controller.current === control) setError(cause instanceof Error ? cause.message : '動画を少し動かして、もう一度お試しください。') }
    finally {
      if (controller.current === control) {
        setTime(videoRef.current?.currentTime ?? 0)
        gate.current = false
        setBusy(false)
        callbacks.current.onBusy(false)
      }
    }
  }
  const disabled = !ready || busy || locked
  return <div className="video-tools">
    <video ref={videoRef} playsInline muted preload="auto" aria-label="選んだ動画"
      onTimeUpdate={() => setTime(videoRef.current?.currentTime ?? 0)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onError={() => { if (ready) setError('この動画を再生できませんでした。別の通常撮影の動画を選んでください。') }} />
    <div className="play-row">
      <button disabled={disabled} onClick={() => {
        const video = videoRef.current!
        if (!video.paused) video.pause()
        else void video.play().catch(() => setError('この動画を再生できませんでした。選び直してください。'))
      }}>{playing ? '一時停止' : '再生'}</button>
      <output aria-label="再生時刻">{time.toFixed(2)} / {duration.toFixed(2)} 秒</output>
    </div>
    <label className="timeline-label">タイムライン
      <input aria-label="タイムライン" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(time, duration)} disabled={disabled}
        onChange={(event) => { const target = Number(event.target.value); void run((c) => c.seek(target)) }} />
    </label>
    <div className="two-columns">
      <button disabled={disabled} onClick={() => void run((c) => c.seek(Math.max(0, (videoRef.current?.currentTime ?? 0) - 0.1)))}>0.1秒戻る</button>
      <button disabled={disabled} onClick={() => void run((c) => c.seek(Math.min(duration, (videoRef.current?.currentTime ?? 0) + 0.1)))}>0.1秒進む</button>
    </div>
    <p className="hint">0.1秒は移動の目安です。正確なコマ送りや、ボールに当たる瞬間の取得は保証しません。</p>
    {showCapture && <button className="primary full" disabled={disabled} onClick={() => void run(async (c) => {
      const frame = await c.capture(videoRef.current!.currentTime)
      if (controller.current === c) callbacks.current.onCapture(frame)
    })}>{busy ? '動画を準備中…' : captureLabel}</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>
}
