import { useEffect, useRef, useState } from 'react'
import { loadVideo, releaseVideo, MediaController } from './media'
import { moveRequestedPosition } from './position'
import type { MediaAsset, Scene } from './domain'

type Frame = Awaited<ReturnType<MediaController['capture']>>
type Props = {
  asset: MediaAsset
  locked?: boolean
  captureLabel: string
  showCapture?: boolean
  selectedScene?: Scene
  onCapture: (frame: Frame) => void
  onReady: (metadata: { durationSec: number; width: number; height: number }) => void
  onBusy: (busy: boolean) => void
}

export function VideoPanel({ asset, locked, captureLabel, showCapture = true, selectedScene, onCapture, onReady, onBusy }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controller = useRef<MediaController | null>(null)
  const callbacks = useRef({ onCapture, onReady, onBusy })
  callbacks.current = { onCapture, onReady, onBusy }
  const gate = useRef(false)
  const requestedPosition = useRef(0)
  const modeContext = useRef({ asset, selectedScene })
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [step, setStep] = useState<0.1 | 0.01>(selectedScene === 'impact' ? 0.01 : 0.1)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  function setRequestedPosition(value: number) {
    requestedPosition.current = value
    setTime(value)
  }
  useEffect(() => {
    if (modeContext.current.asset !== asset) setStep(0.1)
    else if (modeContext.current.selectedScene !== selectedScene && selectedScene === 'impact') setStep(0.01)
    modeContext.current = { asset, selectedScene }
  }, [asset, selectedScene])
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
    setRequestedPosition(0)
    setDuration(0)
    setPlaying(false)
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
        gate.current = false
        setBusy(false)
        callbacks.current.onBusy(false)
      }
    }
  }
  function move(delta: number) {
    void run(async (control) => {
      const target = moveRequestedPosition(requestedPosition.current, delta, duration)
      setRequestedPosition(target)
      await control.seek(target)
    })
  }
  const disabled = !ready || busy || locked
  return <div className="video-tools">
    <video ref={videoRef} playsInline muted preload="auto" aria-label="選んだ動画"
      onTimeUpdate={() => {
        const video = videoRef.current!
        // Seek events can report a rounded media time; keep the requested position.
        if (!gate.current && !video.paused && controller.current) setRequestedPosition(video.currentTime)
      }}
      onPlay={() => {
        setPlaying(true)
        if (!gate.current && controller.current) setRequestedPosition(videoRef.current!.currentTime)
      }} onPause={() => {
        setPlaying(false)
        if (!gate.current && controller.current) setRequestedPosition(videoRef.current!.currentTime)
      }}
      onError={() => { if (ready) setError('この動画を再生できませんでした。別の通常撮影の動画を選んでください。') }} />
    <div className="play-row">
      <button disabled={disabled} onClick={() => void run(async () => {
        const video = videoRef.current!
        const startPlayback = video.paused
        if (!startPlayback) video.pause()
        setRequestedPosition(video.currentTime)
        if (startPlayback) {
          try { await video.play() }
          catch { throw new Error('この動画を再生できませんでした。選び直してください。') }
        }
      })}>{playing ? '一時停止' : '再生'}</button>
      <output aria-label="指定位置">指定 {time.toFixed(3)} / {duration.toFixed(2)} 秒</output>
    </div>
    <label className="timeline-label">タイムライン
      <input aria-label="タイムライン" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(time, duration)} disabled={disabled}
        onChange={(event) => {
          const target = Number(event.target.value)
          void run(async (control) => { setRequestedPosition(target); await control.seek(target) })
        }} />
    </label>
    <div className="movement-mode" role="group" aria-label="移動幅">
      <span className="movement-label">移動幅</span>
      <div className="two-columns">
        <button disabled={disabled} aria-pressed={step === 0.1} onClick={() => setStep(0.1)}>通常：0.1秒</button>
        <button disabled={disabled} aria-pressed={step === 0.01} onClick={() => setStep(0.01)}>細かく：0.01秒</button>
      </div>
    </div>
    <div className="two-columns">
      <button disabled={disabled} onClick={() => move(-step)}>{step}秒戻る</button>
      <button disabled={disabled} onClick={() => move(step)}>{step}秒進む</button>
    </div>
    <p className="hint">選んだ秒数は要求する移動幅です。撮影間隔によっては同じ画像が続きます。動画に存在しない瞬間は作れず、正確なコマ送りや当たる瞬間の取得は保証しません。</p>
    {showCapture && <button className="primary full" disabled={disabled} onClick={() => void run(async (c) => {
      const frame = await c.capture(requestedPosition.current)
      if (controller.current === c) callbacks.current.onCapture(frame)
    })}>{busy ? '動画を準備中…' : captureLabel}</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>
}
