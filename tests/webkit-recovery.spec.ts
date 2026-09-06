import { test, expect } from '@playwright/test'
test('Windows WebKit: rejected real fixture returns to selection without losing the app', async ({ page }, info) => {
  test.skip(info.project.name !== 'webkit', 'Specific to the observed Windows WebKit media backend limitation')
  await page.goto('./')
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/synthetic.webm')
  await expect(page.getByRole('alert')).toContainText('この動画を読み込めませんでした', { timeout: 20000 })
  await expect(page.getByRole('button', { name: '動画を選び直す', exact: true })).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/synthetic.webm')
  await expect(page.getByRole('alert')).toContainText('この動画を読み込めませんでした', { timeout: 20000 })
  await expect(page.getByRole('button', { name: '動画を選び直す', exact: true })).toBeEnabled()
  await info.attach('limitation.txt', { body: 'Windows WebKit 26.6: standalone native video element loading the same fixture also returned MediaError code 4. Decoding success is blocked; this passes only error/reselection recovery.', contentType: 'text/plain' })
})
