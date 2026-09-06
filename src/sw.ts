/// <reference lib="webworker" />
import { cacheNames, setCacheNameDetails } from 'workbox-core'
import { precacheAndRoute, createHandlerBoundToURL, getCacheKeyForURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision?: string | null }> }
// Own only this app's cache; do not enumerate or remove sibling apps' caches.
setCacheNameDetails({ prefix: 'ai-range-coach', suffix: self.registration.scope })
const entries = self.__WB_MANIFEST
precacheAndRoute(entries)
const scopePath = new URL(self.registration.scope).pathname
registerRoute(new NavigationRoute(createHandlerBoundToURL(new URL('index.html', self.registration.scope).href), {
  allowlist: [new RegExp(`^${scopePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)],
}))
// The first install claims the page. Updates wait until all old clients close.
// No skipWaiting or automatic page reload: an edited shot must stay intact.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CHECK_CACHE') return
  event.waitUntil((async () => {
    const cache = await caches.open(cacheNames.precache)
    const results = await Promise.all(entries.map(async (entry) => {
      const url = typeof entry === 'string' ? entry : entry.url
      const key = getCacheKeyForURL(url)
      return Boolean(key && await cache.match(key))
    }))
    event.ports[0]?.postMessage({ complete: results.length > 0 && results.every(Boolean), count: results.filter(Boolean).length, total: results.length })
  })())
})
