import { useEffect, useState } from 'react'
import { APP_BASE_PATH, appPath } from './deployment'
export function PwaStatus() {
  const [update, setUpdate] = useState(false)
  const [status, setStatus] = useState('未確認')
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return
    let alive = true
    void navigator.serviceWorker.register(appPath('sw.js'), { scope: APP_BASE_PATH }).then((registration) => {
      if (!alive) return
      setUpdate(Boolean(registration.waiting))
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', () => {
          if (alive && registration.waiting && navigator.serviceWorker.controller) setUpdate(true)
        })
      })
    }).catch(() => { if (alive) setStatus('準備できませんでした。オンラインで開き直してください。') })
    return () => { alive = false }
  }, [])
  async function check() {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
      setStatus('HTTPSで開いてください。LANのHTTPは動画操作の予備確認用です。'); return
    }
    setStatus('確認中…')
    const registration = await navigator.serviceWorker.getRegistration(APP_BASE_PATH)
    // An explicit check can discover an update without activating it or reloading.
    if (navigator.onLine && registration) void registration.update().catch(() => {})
    const control = navigator.serviceWorker.controller
    const expectedScope = new URL(APP_BASE_PATH, window.location.origin).href
    const expectedScript = new URL(appPath('sw.js'), window.location.origin).href
    if (registration?.scope !== expectedScope || registration.active?.state !== 'activated' || control?.scriptURL !== expectedScript) {
      setStatus('まだ準備中です。オンラインで少し待って、もう一度確認してください。'); return
    }
    const channel = new MessageChannel()
    const result = await new Promise<{ complete: boolean; count: number; total: number } | null>((resolve) => {
      const timeout = window.setTimeout(() => resolve(null), 4000)
      channel.port1.onmessage = (event) => { clearTimeout(timeout); resolve(event.data) }
      control.postMessage({ type: 'CHECK_CACHE' }, [channel.port2])
    })
    channel.port1.close()
    setStatus(result?.complete
      ? `オフライン準備完了：安全な接続・アプリの有効化とページ制御・必要資産 ${result.count}/${result.total} を確認しました。`
      : '必要資産の保存を確認できませんでした。オンラインで再確認してください。')
    setUpdate(Boolean(registration.waiting))
  }
  return <details className="pwa-info"><summary>ホーム画面・オフラインの準備</summary>
    <p>Safariの共有メニューから「ホーム画面に追加」。追加したアイコンから開いて、PWA内で新しく保存してください。</p>
    <button onClick={() => void check()}>オフラインの準備を確認</button>
    <p role="status">{status}</p>
    {update && <p className="notice">アプリの更新があります。作業を保存して、このアプリと同じURLのタブをすべて閉じ、開き直してください。編集中に自動で再読込しません。</p>}
    <small>対象ビルド：{__BUILD_ID__}</small>
  </details>
}
