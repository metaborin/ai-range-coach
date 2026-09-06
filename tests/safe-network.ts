import { expect, test as base, type BrowserContext } from '@playwright/test'
export * from '@playwright/test'

/** Test-only guard: mocked page routes take precedence; all live API traffic stops here. */
export async function guardLiveApi(context: BrowserContext, appOrigin: string) {
  const audit = { blockedRequests: 0 }
  await context.route(/^https?:\/\//, async route => {
    const url = new URL(route.request().url())
    if (url.origin !== appOrigin || /^\/v1\/analyses(?:\/|$)/.test(url.pathname)) {
      audit.blockedRequests++
      await route.abort('blockedbyclient')
      return
    }
    await route.fallback()
  })
  return audit
}

export const test = base.extend<{ liveApiGuard: { blockedRequests: number } }>({
  liveApiGuard: [async ({ context, baseURL }, use, info) => {
    if (!baseURL) throw new Error('Tests require the configured app baseURL')
    const audit = await guardLiveApi(context, new URL(baseURL).origin)
    await use(audit)
    await info.attach('no-live-api.json', {
      body: JSON.stringify({ blockedUnexpectedRequests: audit.blockedRequests, liveApiPermitted: false }),
      contentType: 'application/json',
    })
    expect(audit.blockedRequests, 'Unexpected live API traffic was blocked before sending').toBe(0)
  }, { auto: true }],
})
