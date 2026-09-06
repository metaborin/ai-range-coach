import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import jpeg from 'jpeg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCENES, createSession, makeDummy, validateSession, type MediaAsset } from './domain';
import { openStorage, DATABASE_VERSION, type RangeDatabase } from './storage';
import { AnalysisService, type LocalAnalysisRequest } from './analysisService';
import { sourceFingerprint, makeAnalysisRequest } from './analysisSnapshot';
import { validateAnalysisRequest, validateAdvice, jpegDimensions, type AiAnalysis } from '../shared/analysis';

function fixture() {
  const assets = new Map<string, MediaAsset>();
  function add(kind: 'video' | 'frame', blob: Blob) {
    const id = crypto.randomUUID(); assets.set(id, { id, kind, blob, mimeType: blob.type, sizeBytes: blob.size }); return id;
  }
  const session = createSession({ assetId: add('video', new Blob(['synthetic'], { type: 'video/webm' })), fileName: 'never-send-this.webm', durationSec: 5, width: 16, height: 16 });
  const shot = session.sets[0].shots[0];
  SCENES.forEach((scene, index) => {
    const bytes = jpeg.encode({ width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 30 + index * 30) }, 80).data;
    shot.scenes[scene] = { assetId: add('frame', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })), requestedTimeSec: index + 0.12, observedTimeSec: index + 0.1,
      timeBasis: 'video-current-time', width: 16, height: 16 };
  });
  shot.selfReport = { contact: 'good', direction: 'center' };
  return { session, assets };
}
function result(local: LocalAnalysisRequest): AiAnalysis {
  return { id: local.requestId, kind: 'ai', requestId: local.requestId, shotId: local.shotId, inputRevision: local.inputRevision,
    fingerprint: local.fingerprint, sourceFingerprint: local.sourceFingerprint, createdAt: new Date().toISOString(), model: 'test-model', promptVersion: 'phase1-1', schemaVersion: '1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, advice: { status: 'ok', observations: [{ scene: 'finish', text: '静止画の説明' }],
      limitations: ['自作画像を使う契約試験です。'], nextFocus: '同じ位置から撮影する。', reason: '試験のため。', check: '全身が写るか確認する。' } };
}
const close: (() => Promise<void>)[] = [];
async function setup() {
  const name = `analysis-test-${crypto.randomUUID()}`;
  const storage = await openStorage(name);
  const db = await openDB<RangeDatabase>(name, DATABASE_VERSION);
  close.push(async () => { storage.close(); db.close(); await deleteDB(name); });
  const data = fixture(); await storage.save(data.session, data.assets);
  return { ...data, name, storage, db, service: new AnalysisService(storage, 'https://analysis.test.invalid') };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(close.splice(0).map(fn => fn())); });

describe('Phase 1 immutable snapshots and safe local recovery', () => {
  it('saves without analysis and upgrades a real v1 database without deleting old dummy/media IDs', async () => {
    expect(validateSession(fixture().session)).toEqual([]);
    const data = fixture(); const shot = data.session.sets[0].shots[0]; data.session.sets[0].analysisResult = makeDummy(shot.id);
    const name = `migration-${crypto.randomUUID()}`;
    const old = await openDB(name, 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'id' }); db.createObjectStore('assets', { keyPath: 'id' }); } });
    await old.put('sessions', data.session); for (const asset of data.assets.values()) await old.put('assets', asset); old.close();
    const storage = await openStorage(name); close.push(async () => { storage.close(); await deleteDB(name); });
    const loaded = (await storage.load(data.session.id))!;
    expect(loaded.session).toEqual(data.session); expect(loaded.assets.size).toBe(5); expect(await storage.analysisList(data.session.id)).toEqual([]);
  });
  it('freezes four real JPEGs with labels/times but no video/name and persists ID before the single POST', async () => {
    const { service, session, db } = await setup();
    const local = await service.prepare(session.id);
    const request = await db.get('analysisRequests', local.requestId);
    expect(request?.state).toBe('pending'); expect(JSON.stringify(request)).not.toMatch(/jpegBase64|password|Bearer|fileName/);
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(await db.get('analysisRequests', local.requestId)).toBeDefined();
      expect(options.cache).toBe('no-store'); expect(options.credentials).toBe('omit');
      const body = JSON.parse(options.body as string);
      expect(body.input.frames.map((frame: { scene: string }) => frame.scene)).toEqual(SCENES);
      expect(JSON.stringify(body)).not.toMatch(/never-send-this|video\/|assetId|fileName/);
      await validateAnalysisRequest(body);
      return Response.json({ ...local, state: 'succeeded', result: result(local) });
    }); vi.stubGlobal('fetch', fetch);
    await service.start(local, 'test-only-password-not-a-production-secret');
    await expect(service.start(local, 'test-only')).rejects.toThrow('自動で再送しません'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('never sends when metadata persistence fails or another prepared request exists', async () => {
    const { service, storage, session } = await setup(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const policy = vi.spyOn(storage, 'prepareAnalysis').mockRejectedValueOnce(new DOMException('test', 'QuotaExceededError'));
    await expect(service.prepare(session.id)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled(); policy.mockRestore();
    await service.prepare(session.id); await expect(service.prepare(session.id)).rejects.toThrow('確認待ち'); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses only same-ID GET after uncertain POST and expires locally without silently creating a new ID', async () => {
    const { service, session, storage } = await setup(); const local = await service.prepare(session.id);
    const fetch = vi.fn().mockRejectedValueOnce(new Error('unsafe body must not escape')).mockResolvedValueOnce(Response.json({ ...local, state: 'pending' })); vi.stubGlobal('fetch', fetch);
    await expect(service.start(local, 'test-only')).rejects.toThrow('同じ要求'); expect((await service.list(session.id))[0].state).toBe('unknown');
    const restarted = new AnalysisService(storage, 'https://analysis.test.invalid'); await restarted.check(local, 'test-only');
    expect(fetch.mock.calls[1][0]).toBe(`https://analysis.test.invalid/v1/analyses/${local.requestId}`); expect(fetch.mock.calls[1][1].method).toBe('GET');
    await restarted.check({ ...local, retryUntil: new Date(0).toISOString() }, 'test-only'); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('detects same-ID same-size byte changes and marks late analysis stale without overwriting edits or another record', async () => {
    const { service, storage, session, assets } = await setup(); const local = await service.prepare(session.id);
    const before = await sourceFingerprint(session, assets);
    const asset = assets.get(session.sets[0].shots[0].scenes.top!.assetId)!;
    const bytes = new Uint8Array(await asset.blob.arrayBuffer()); bytes[bytes.length - 3] ^= 1;
    asset.blob = new Blob([bytes], { type: 'image/jpeg' });
    expect(await sourceFingerprint(session, assets)).not.toBe(before);
    session.sets[0].shots[0].selfReport.direction = 'right'; await storage.save(session, assets);
    const other = fixture(); await storage.save(other.session, other.assets); const otherBefore = await storage.load(other.session.id);
    expect(await service.saveResult(local, result(local))).toBe(true);
    const saved = (await storage.load(session.id))!.session; const shot = saved.sets[0].shots[0];
    expect(shot.selfReport.direction).toBe('right'); expect(shot.inputFingerprint).not.toBe(local.sourceFingerprint); expect(shot.inputRevision).toBe(1);
    expect(await storage.load(other.session.id)).toEqual(otherBefore);
    // Old editor save also retains an analysis that completed after it opened.
    await storage.save(session, assets); expect((await storage.load(session.id))!.session.sets[0].analysisResult?.kind).toBe('ai');
  });
  it('retains result on failed local save and retries storage without another API call; deleted record stays deleted', async () => {
    const { service, storage, session } = await setup(); const local = await service.prepare(session.id); const answer = result(local);
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...local, state: 'succeeded', result: answer })); vi.stubGlobal('fetch', fetch);
    const reply = await service.start(local, 'test-only');
    const fail = vi.spyOn(storage, 'saveAnalysisResult').mockRejectedValueOnce(new DOMException('test', 'QuotaExceededError'));
    await expect(service.saveResult(local, reply.result!)).rejects.toThrow(); await service.saveResult(local, reply.result!);
    expect(fetch).toHaveBeenCalledTimes(1); expect((await storage.load(session.id))!.session.sets[0].analysisResult).toEqual(answer); fail.mockRestore();
    await storage.delete(session.id); expect(await service.saveResult(local, answer)).toBe(false); expect(await storage.load(session.id)).toBeUndefined();
    expect((await service.list(session.id))[0].result).toBeUndefined();
    await storage.updateAnalysisRequest(local.requestId, { state: 'succeeded', result: answer });
    expect((await service.list(session.id))[0].result).toBeUndefined();
  });
  it('rejects mismatched result correlation and handles authentication errors without arbitrary response text', async () => {
    const { service, session } = await setup(); const local = await service.prepare(session.id);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...local, state: 'succeeded', result: { ...result(local), sourceFingerprint: 'a'.repeat(64) } }))
      .mockResolvedValueOnce(new Response('do not expose this', { status: 401 })); vi.stubGlobal('fetch', fetch);
    await expect(service.start(local, 'test-only')).rejects.toThrow('同じ要求');
    await expect(service.check(local, 'test-only')).rejects.toThrow('パスワード'); expect((await service.list(session.id))[0].state).toBe('failed');
  });
  it('validates real JPEG structure, label/time/enum/size and schema instead of accepting data URLs or arbitrary advice', async () => {
    const { session, assets } = fixture(); const now = Date.now();
    const body = await makeAnalysisRequest(session, assets, `${now}_${crypto.randomUUID()}`, new Date(now).toISOString());
    for (const mutate of [
      (b: typeof body) => { b.input.frames[0].jpegBase64 = 'https://example.invalid/image.jpg'; },
      (b: typeof body) => { b.input.frames[0].width = 99999; },
      (b: typeof body) => { b.input.frames[1].requestedTimeSec = 0; },
      (b: typeof body) => { b.input.frames[2].label = 'unknown'; },
    ]) { const changed = structuredClone(body); mutate(changed); await expect(validateAnalysisRequest(changed)).rejects.toThrow(); }
    expect(() => jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toThrow();
    expect(validateAdvice({ status: 'ok', nextFocus: ['two', 'tasks'] })).toBe(false);
    expect(validateAdvice({ ...result({ ...body, ...body.input, sessionId: session.id, state: 'pending', retryUntil: body.createdAt }).advice, status: 'insufficient_evidence' })).toBe(true);
  });
  it('rejects an unvalidated result attached to a failed/pending reply before the UI can render or persist it', async () => {
    const { service, session } = await setup(); const local = await service.prepare(session.id);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...local, state: 'failed', result: {} })));
    await expect(service.start(local, 'test-only')).rejects.toThrow('同じ要求');
    expect((await service.list(session.id))[0].result).toBeUndefined();
  });
});
