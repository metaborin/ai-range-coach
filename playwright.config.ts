import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'node:fs'
const { repository } = JSON.parse(readFileSync('deployment.config.json', 'utf8')) as { repository: string }
const appUrl = process.env.DEPLOYED_APP_URL || process.env.E2E_BASE_URL || `http://127.0.0.1:4173/${repository}/`
const target = new URL(appUrl)
if (!['http:', 'https:'].includes(target.protocol) || target.pathname !== `/${repository}/` || target.search || target.hash) {
  throw new Error(`E2E target must end with /${repository}/ and have no query or fragment`)
}
export default defineConfig({
  testDir: './tests', timeout: 45000, workers: 1, fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'evidence/playwright-results.json' }]],
  metadata: { appUrl, target: process.env.DEPLOYED_APP_URL ? 'deployed HTTPS' : process.env.E2E_BASE_URL ? 'external preview' : 'local production preview' },
  use: { baseURL: appUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', testIgnore: '**/webkit-recovery.spec.ts', use: { ...devices['Desktop Chrome'] } },
    // Windows WebKit reports MEDIA_ERR_SRC_NOT_SUPPORTED for this VP8 fixture.
    // Keep a recovery test; successful media decoding remains a blocked check there.
    { name: 'webkit', testMatch: '**/webkit-recovery.spec.ts', use: { ...devices['Desktop Safari'] } },
  ],
})
