import { useEffect, useRef, useState } from 'react'
import { loadVideo, releaseVideo, MediaController } from './media'
import { moveRequestedPosition } from './position'
import { LatestSeekQueue } from './latestSeek'
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
  const seekQueue = useRef<LatestSeekQueue | null>(null)
  const callbacks = useRef({ onCapture, onReady, onBusy })
  callbacks.current = { onCapture, onReady, onBusy }
  const gate = useRef(false)
  const seekPending = useRef(false)
  const dragPointer = useRef<number | null>(null)
  const playbackTracking = useRef(false)
  const positionSettled = useRef(false)
  const requestedPosition = useRef(0)
  const modeContext = useRef({ asset, selectedScene })
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [positionReady, setPositionReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [step, setStep] = useState<0.1 | 0.01>(selectedScene === 'impact' ? 0.01 : 0.1)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')
  function setRequestedPosition(value: number) {
    requestedPosition.current = value
    setTime(value)
  }
  function isBusy() { return gate.current || seekPending.current || dragPointer.current !== null }
  function updateBusy() {
    const value = isBusy()
    setBusy(value)
    callbacks.current.onBusy(value)
  }
  function setPositionSettled(value: boolean) {
    positionSettled.current = value
    setPositionReady(value)
  }
  function finishTimeline() {
    if (dragPointer.current === null) return
    dragPointer.current = null
    // A tap at the existing thumb may not emit input. Settle that position too.
    if (!seekPending.current && !positionSettled.current) seekQueue.current?.request(requestedPosition.current)
    updateBusy()
  }
  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (event.pointerId === dragPointer.current) finishTimeline()
    }
    const hidden = () => { if (document.hidden) finishTimeline() }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('blur', finishTimeline)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('blur', finishTimeline)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [])
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
    seekPending.current = false
    dragPointer.current = null
    playbackTracking.current = false
    updateBusy()
    setReady(false)
    setPositionSettled(false)
    setError('')
    setRequestedPosition(0)
    setDuration(0)
    setPlaying(false)
    void loadVideo(video, asset.blob, abort.signal).then((loaded) => {
      if (!live) { releaseVideo(video, loaded.url); return }
      url = loaded.url
      const control = new MediaController(video)
      controller.current = control
      seekQueue.current = new LatestSeekQueue(time => control.seek(time), (state) => {
        if (!live || controller.current !== control) return
        seekPending.current = state.pending
        setPositionSettled(state.settled)
        if (state.pending) setError('')
        else if (!state.settled) setError(state.error instanceof Error ? state.error.message : '動画を少し動かして、もう一度お試しください。')
        updateBusy()
      })
      setDuration(loaded.durationSec)
      setPositionSettled(true)
      setReady(true)
      callbacks.current.onReady(loaded)
    }).catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : 'この動画を読み込めませんでした。選び直してください。')
    }).finally(() => {
      if (live) { gate.current = false; updateBusy() }
    })
    return () => {
      live = false
      dragPointer.current = null
      playbackTracking.current = false
      seekQueue.current?.dispose()
      seekQueue.current = null
      abort.abort()
      controller.current?.dispose()
      controller.current = null
      seekPending.current = false
      gate.current = false
      callbacks.current.onBusy(false)
      if (url) releaseVideo(video, url)
    }
  }, [asset])

  async function run(action: (control: MediaController) => Promise<void>) {
    if (isBusy() || locked || !controller.current) return
    gate.current = true
    updateBusy()
    setError('')
    const control = controller.current
    try { await action(control) }
    catch (cause) { if (controller.current === control) setError(cause instanceof Error ? cause.message : '動画を少し動かして、もう一度お試しください。') }
    finally {
      if (controller.current === control) {
        gate.current = false
        updateBusy()
      }
    }
  }
  function move(delta: number) {
    if (isBusy()) return
    requestTimeline(moveRequestedPosition(requestedPosition.current, delta, duration))
  }
  function requestTimeline(target: number) {
    if (!ready || locked || gate.current || !seekQueue.current) return
    playbackTracking.current = false
    setRequestedPosition(target)
    // The range stays interactive while this queue keeps only one latest target.
    seekQueue.current.request(target)
    videoRef.current!.pause()
    setPlaying(false)
  }
  const disabled = !ready || busy || locked
  const timelineDisabled = !ready || gate.current || locked
  return <div className="video-tools">
    <video ref={videoRef} playsInline muted preload="auto" aria-label="選んだ動画"
      onTimeUpdate={() => {
        const video = videoRef.current!
        // Seek events can report a rounded media time; keep the requested position.
        if (!isBusy() && playbackTracking.current && !video.paused && controller.current) setRequestedPosition(video.currentTime)
      }}
      onPlay={() => {
        if (!videoRef.current!.paused) setPlaying(true)
      }} onPause={() => {
        const video = videoRef.current!
        if (!video.paused) return
        setPlaying(false)
        if (!isBusy() && playbackTracking.current && controller.current) setRequestedPosition(video.currentTime)
        playbackTracking.current = false
      }}
      onError={() => { if (ready) setError('この動画を再生できませんでした。別の通常撮影の動画を選んでください。') }} />
    <div className="play-row">
      <button disabled={disabled} onClick={() => void run(async () => {
        const video = videoRef.current!
        const startPlayback = video.paused
        playbackTracking.current = startPlayback
        if (!startPlayback) { video.pause(); setPlaying(false) }
        setRequestedPosition(video.currentTime)
        if (startPlayback) {
          try { await video.play(); setPositionSettled(true) }
          catch { playbackTracking.current = false; throw new Error('この動画を再生できませんでした。選び直してください。') }
        }
      })}>{playing ? '一時停止' : '再生'}</button>
      <output aria-label="指定位置">指定 {time.toFixed(3)} / {duration.toFixed(2)} 秒</output>
    </div>
    <label className="timeline-label">タイムライン
      <input aria-label="タイムライン" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(time, duration)} disabled={timelineDisabled}
        onPointerDown={(event) => {
          if (timelineDisabled || !event.isPrimary || event.button !== 0) return
          dragPointer.current = event.pointerId
          playbackTracking.current = false
          setPositionSettled(false)
          updateBusy()
          videoRef.current!.pause()
          setPlaying(false)
        }}
        onLostPointerCapture={(event) => { if (event.pointerId === dragPointer.current) finishTimeline() }}
        onBlur={finishTimeline}
        onChange={(event) => requestTimeline(Number(event.target.value))} />
    </label>
    <p className="hint">バーは押したまま動かせます。離した位置で停止し、動画の表示が整うと場面を選べます。</p>
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
    {showCapture && <button className="primary full" disabled={disabled || !positionReady} onClick={() => void run(async (c) => {
      playbackTracking.current = false
      const frame = await c.capture(requestedPosition.current)
      if (controller.current === c) callbacks.current.onCapture(frame)
    })}>{busy ? '動画を準備中…' : captureLabel}</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>
}
