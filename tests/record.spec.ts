import { test, expect, type BrowserContext, type Page, type TestInfo } from './safe-network';
import type { MediaAsset, Session } from '../src/domain';

const fixture = 'tests/fixtures/synthetic.webm';
const scenes = [
  { label: 'アドレス', time: 0.4, color: [210, 40, 35] },
  { label: 'トップ', time: 1.4, color: [40, 180, 75] },
  { label: 'インパクト付近', time: 2.4, color: [30, 70, 220] },
  { label: 'フィニッシュ', time: 3.4, color: [220, 160, 30] },
];

async function databaseSnapshot(page: Page) {
  return page.evaluate(async () => {
    const stored = await new Promise<{ sessions: Session[]; assets: MediaAsset[] }>((resolve, reject) => {
      const request = indexedDB.open('ai-range-coach');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['sessions', 'assets'], 'readonly');
        const sessions = transaction.objectStore('sessions').getAll();
        const assets = transaction.objectStore('assets').getAll();
        transaction.oncomplete = () => { database.close(); resolve({ sessions: sessions.result, assets: assets.result }); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    const assets = await Promise.all(stored.assets.map(async (asset) => {
      const buffer = await asset.blob.arrayBuffer();
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      return {
        id: asset.id, kind: asset.kind, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
        isBlob: asset.blob instanceof Blob, blobSize: asset.blob.size, blobType: asset.blob.type,
        firstBytes: Array.from(new Uint8Array(buffer).slice(0, 2)),
        sha256: Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join(''),
      };
    }));
    return { sessions: stored.sessions, assets: assets.sort((a, b) => a.id.localeCompare(b.id)) };
  });
}

function monitorRequests(context: BrowserContext) {
  const requests: { method: string; url: string; bodyBytes: number }[] = [];
  context.on('request', (request) => requests.push({
    method: request.method(), url: request.url(), bodyBytes: request.postDataBuffer()?.length ?? 0,
  }));
  return async (page: Page, info: TestInfo) => {
    await info.attach('network-requests.json', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' });
    const origin = new URL(page.url()).origin;
    const http = requests.filter((request) => /^https?:/.test(request.url));
    expect(http.length).toBeGreaterThan(0);
    expect(http.filter((request) => new URL(request.url).origin !== origin)).toEqual([]);
    expect(http.filter((request) => !['GET', 'HEAD'].includes(request.method) || request.bodyBytes > 0)).toEqual([]);
  };
}

async function captureScene(page: Page, label: string, time: number) {
  await page.getByRole('button', { name: `${label}を選ぶ`, exact: true }).click();
  await page.getByRole('slider', { name: 'タイムライン' }).fill(String(time));
  const capture = page.getByRole('button', { name: 'この場面にする', exact: true });
  await expect(capture).toBeEnabled();
  await capture.click();
  await expect(page.getByAltText(label, { exact: true })).toBeVisible();
  await expect(page.locator('.frame').filter({ has: page.getByAltText(label, { exact: true }) }))
    .toContainText(`指定 ${time.toFixed(2)} 秒`);
}

async function prepareFourScenes(page: Page) {
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  for (const scene of scenes) await captureScene(page, scene.label, scene.time);
}

async function readFrameColor(page: Page, label: string) {
  return page.getByAltText(label, { exact: true }).evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return { width: image.naturalWidth, height: image.naturalHeight, pixel: Array.from(context.getImageData(5, 5, 1, 1).data) };
  });
}

async function chooseReport(page: Page, contact: string, direction: string) {
  await page.getByRole('group', { name: /^当たり/ }).getByRole('button', { name: contact, exact: true }).click();
  await page.getByRole('group', { name: /^方向/ }).getByRole('button', { name: direction, exact: true }).click();
}

async function saveResult(page: Page, doubleClick = false) {
  const save = page.getByRole('button', { name: 'この端末に保存', exact: true });
  if (doubleClick) {
    // Two clicks in the same task exercise the synchronous guard before React rerenders.
    await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  } else await save.click();
  await expect(page.getByText('保存しました', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '編集', exact: true })).toBeEnabled();
}

test('actual video → four distinct JPEGs → input → save/reload/edit/replace/discard/delete, without uploads', async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const verifyRequests = monitorRequests(context);
  await page.goto('./');
  await prepareFourScenes(page);
  const colors: number[][] = [];
  for (const scene of scenes) {
    const frame = await readFrameColor(page, scene.label);
    expect([frame.width, frame.height]).toEqual([320, 180]);
    expect(frame.pixel[3]).toBe(255);
    scene.color.forEach((value, channel) => expect(Math.abs(frame.pixel[channel] - value)).toBeLessThan(20));
    colors.push(frame.pixel);
  }
  expect(new Set(colors.map((color) => color.join(','))).size).toBe(4);
  await info.attach('actual-four-frame-colors.json', { body: JSON.stringify(colors), contentType: 'application/json' });

  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click();
  await page.getByRole('button', { name: '内容を確認', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当たりを選んでください');
  await expect(page.getByRole('alert')).toContainText('方向を選んでください');
  expect((await databaseSnapshot(page)).sessions).toHaveLength(0);
  await chooseReport(page, 'わからない', 'わからない');
  await page.getByRole('button', { name: '内容を確認', exact: true }).click();
  await expect(page.getByText('未分析。分析しなくても、この記録を保存できます。', { exact: true })).toBeVisible();
  await expect(page.locator('.result')).not.toContainText('フィニッシュで、無理なく静止できる強さで振る。');
  await saveResult(page, true);

  const saved = await databaseSnapshot(page);
  expect(saved.sessions).toHaveLength(1);
  expect(saved.assets).toHaveLength(5);
  expect(saved.sessions[0].sets).toHaveLength(1);
  expect(saved.sessions[0].sets[0].shots).toHaveLength(1);
  expect(saved.sessions[0].sets[0].shots[0].selfReport).toEqual({ contact: 'unknown', direction: 'unknown' });
  expect(saved.sessions[0].sets[0].analysisResult).toBeNull();
  for (const asset of saved.assets) {
    expect(asset.isBlob).toBe(true);
    expect(asset.blobSize).toBeGreaterThan(0);
    expect(asset.blobSize).toBe(asset.sizeBytes);
    if (asset.kind === 'frame') {
      expect(asset.blobType).toBe('image/jpeg');
      expect(asset.firstBytes).toEqual([255, 216]);
    }
  }
  const originalSource = await page.locator('video').getAttribute('src');
  await page.reload();
  await expect(page.getByRole('button', { name: '記録を開く', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '記録を開く', exact: true }).click();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  expect(await page.locator('video').getAttribute('src')).not.toBe(originalSource);
  for (const scene of scenes) {
    const restored = await readFrameColor(page, scene.label);
    expect(restored.pixel).toEqual(colors[scenes.indexOf(scene)]);
  }
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.1);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();

  await page.getByRole('button', { name: '編集', exact: true }).click();
  await captureScene(page, 'トップ', 1.6);
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click();
  await chooseReport(page, '良い', 'ほぼまっすぐ');
  await page.getByRole('button', { name: '内容を確認', exact: true }).click();
  await saveResult(page);
  const edited = await databaseSnapshot(page);
  expect(edited.sessions).toHaveLength(1);
  expect(edited.sessions[0].id).toBe(saved.sessions[0].id);
  expect(edited.sessions[0].sets[0].shots[0].scenes.top?.requestedTimeSec).toBe(1.6);
  expect(edited.sessions[0].sets[0].shots[0].selfReport).toEqual({ contact: 'good', direction: 'center' });
  expect(edited.assets).toHaveLength(5);
  expect(edited.assets.some((asset) => asset.id === saved.sessions[0].sets[0].shots[0].scenes.top?.assetId)).toBe(false);

  await page.getByRole('button', { name: '編集', exact: true }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('.frames img')).toHaveCount(4);
  expect(await databaseSnapshot(page)).toEqual(edited);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('input[type=file]').setInputFiles(fixture);
  await expect(page.locator('.frames img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'この場面にする', exact: true })).toBeEnabled();
  expect(await databaseSnapshot(page)).toEqual(edited);
  for (const scene of scenes) await captureScene(page, scene.label, scene.time);
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click();
  await expect(page.getByRole('group').getByRole('button', { pressed: true })).toHaveCount(0);
  await page.getByRole('button', { name: '内容を確認', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当たりを選んでください');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'ホームへ', exact: true }).click();
  await expect(page.getByRole('heading', { name: '当たりと方向', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'ホームへ', exact: true }).click();
  await page.getByRole('button', { name: '記録を開く', exact: true }).click();
  await expect(page.locator('.self-report')).toContainText('良い');
  await expect(page.locator('.frame').filter({ has: page.getByAltText('トップ', { exact: true }) })).toContainText('指定 1.60 秒');
  expect(await databaseSnapshot(page)).toEqual(edited);

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'この記録を削除', exact: true }).click();
  expect(await databaseSnapshot(page)).toEqual(edited);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'この記録を削除', exact: true }).click();
  await expect(page.getByText('記録を削除しました', { exact: true })).toBeVisible();
  expect(await databaseSnapshot(page)).toEqual({ sessions: [], assets: [] });
  await verifyRequests(page, info);
});

test('injected quota failure preserves edited UI and old committed video/JPEGs, then same-ID retry succeeds', async ({ page, context }, info) => {
  test.setTimeout(60_000);
  const verifyRequests = monitorRequests(context);
  await page.goto('./');
  await prepareFourScenes(page);
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click();
  await chooseReport(page, 'わからない', 'わからない');
  await page.getByRole('button', { name: '内容を確認', exact: true }).click();
  await saveResult(page);
  const before = await databaseSnapshot(page);

  await page.getByRole('button', { name: '編集', exact: true }).click();
  await captureScene(page, 'トップ', 1.6);
  await page.getByRole('button', { name: '当たりと方向へ', exact: true }).click();
  await chooseReport(page, 'ミス', '左');
  await page.getByRole('button', { name: '内容を確認', exact: true }).click();

  const originalPut = await page.evaluateHandle(() => IDBObjectStore.prototype.put);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'sessions') {
        // The new frame add already ran in this transaction; abort must roll it back too.
        this.transaction.abort();
        throw new DOMException('Intentional test quota failure', 'QuotaExceededError');
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  try {
    await page.getByRole('button', { name: 'この端末に保存', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('保存容量が足りません');
    await expect(page.getByText('保存しました', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'この端末に保存', exact: true })).toBeEnabled();
    await expect(page.locator('.self-report')).toContainText('ミス');
    await expect(page.locator('.self-report')).toContainText('左');
    await expect(page.locator('.frame').filter({ has: page.getByAltText('トップ', { exact: true }) })).toContainText('指定 1.60 秒');
    expect(await databaseSnapshot(page)).toEqual(before);
  } finally {
    await page.evaluate((original) => { IDBObjectStore.prototype.put = original; }, originalPut);
    await originalPut.dispose();
  }
  await saveResult(page);
  const after = await databaseSnapshot(page);
  expect(after.sessions).toHaveLength(1);
  expect(after.sessions[0].id).toBe(before.sessions[0].id);
  expect(after.sessions[0].sets[0].shots[0].selfReport).toEqual({ contact: 'poor', direction: 'left' });
  expect(after.sessions[0].sets[0].shots[0].scenes.top?.requestedTimeSec).toBe(1.6);
  expect(after.assets).toHaveLength(5);
  expect(after.assets.find((asset) => asset.kind === 'video')).toEqual(before.assets.find((asset) => asset.kind === 'video'));
  await page.reload();
  await page.getByRole('button', { name: '記録を開く', exact: true }).click();
  await expect(page.locator('.self-report')).toContainText('ミス');
  await expect(page.locator('.self-report')).toContainText('左');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  await verifyRequests(page, info);
});
