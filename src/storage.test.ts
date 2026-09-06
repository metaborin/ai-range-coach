import 'fake-indexeddb/auto';
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENES, createSession, makeDummy, type MediaAsset, type Session } from './domain';
import { DATABASE_VERSION, RecordValidationError, SessionStorage, openStorage, storageErrorMessage, type CommitPolicy, type RangeDatabase } from './storage';

function record(seed = 'A'): { session: Session; assets: Map<string, MediaAsset> } {
  const assets = new Map<string, MediaAsset>();
  const addAsset = (kind: 'video' | 'frame', content: string) => {
    const id = crypto.randomUUID();
    const mimeType = kind === 'video' ? 'video/mp4' : 'image/jpeg';
    const blob = new Blob([content], { type: mimeType });
    assets.set(id, { id, kind, mimeType, sizeBytes: blob.size, blob });
    return id;
  };
  const session = createSession({ assetId: addAsset('video', `video-${seed}`), fileName: `${seed}.mp4`, durationSec: 5, width: 1920, height: 1080 });
  const shot = session.sets[0].shots[0];
  SCENES.forEach((scene, index) => {
    shot.scenes[scene] = {
      assetId: addAsset('frame', `jpeg-${seed}-${scene}`), requestedTimeSec: index,
      observedTimeSec: index + 0.01, timeBasis: 'video-frame-callback', width: 1280, height: 720,
    };
  });
  shot.selfReport = { contact: 'unknown', direction: 'center' };
  session.sets[0].analysisResult = makeDummy(shot.id);
  return { session, assets };
}

describe('atomic IndexedDB session and Blob storage', () => {
  let name: string;
  let storage: SessionStorage;
  let database: IDBPDatabase<RangeDatabase>;
  const connections: SessionStorage[] = [];

  beforeEach(async () => {
    name = `range-test-${crypto.randomUUID()}`;
    storage = await openStorage(name);
    connections.push(storage);
    database = await openDB<RangeDatabase>(name, DATABASE_VERSION);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    connections.splice(0).forEach((connection) => connection.close());
    database.close();
    await deleteDB(name);
  });

  const withPolicy = (database: IDBPDatabase<RangeDatabase>, policy: CommitPolicy) => new SessionStorage(database, policy);

  it('restores the original Blob, all four JPEG Blobs, times, inputs, and dummy after reopening', async () => {
    const { session, assets } = record();
    await storage.save(session, assets);
    storage.close();
    const reopened = await openStorage(name);
    connections.push(reopened);
    const restored = await reopened.load(session.id);
    expect(restored).toBeDefined();
    expect(restored!.session.id).toBe(session.id);
    expect(restored!.session.sets).toEqual(session.sets);
    expect(restored!.assets.size).toBe(5);
    for (const [id, expected] of assets) {
      const asset = restored!.assets.get(id)!;
      expect(asset.blob).toBeInstanceOf(Blob);
      expect(asset.mimeType).toBe(expected.mimeType);
      expect(asset.sizeBytes).toBe(expected.sizeBytes);
      expect(await asset.blob.text()).toBe(await expected.blob.text());
    }
    expect(await reopened.load('missing')).toBeUndefined();
  });

  it('keeps two one-shot records independent and preserves IDs across repeated saves', async () => {
    const first = record('A');
    const second = record('B');
    await storage.save(first.session, first.assets);
    await storage.save(second.session, second.assets);
    const unchanged = await storage.load(second.session.id);
    const firstIds = [first.session.id, first.session.sets[0].id, first.session.sets[0].shots[0].id];
    first.session.sets[0].shots[0].selfReport.contact = 'good';
    await storage.save(first.session, first.assets);
    await storage.save(first.session, first.assets);
    expect(await storage.list()).toHaveLength(2);
    expect(await database.count('assets')).toBe(10);
    const updated = (await storage.load(first.session.id))!.session;
    expect([updated.id, updated.sets[0].id, updated.sets[0].shots[0].id]).toEqual(firstIds);
    expect(updated.sets[0].shots[0].selfReport.contact).toBe('good');
    expect((await storage.load(second.session.id))!.session).toEqual(unchanged!.session);
  });

  it('rejects missing video / JPEG, mismatched byte / MIME metadata, and unselected input before writing', async () => {
    for (const fault of ['missing-video', 'missing-frame', 'wrong-size', 'wrong-mime', 'unselected']) {
      const { session, assets } = record();
      const shot = session.sets[0].shots[0];
      const frameId = shot.scenes.address!.assetId;
      if (fault === 'missing-video') assets.delete(shot.video.assetId);
      if (fault === 'missing-frame') assets.delete(frameId);
      if (fault === 'wrong-size') assets.get(frameId)!.sizeBytes += 1;
      if (fault === 'wrong-mime') assets.get(frameId)!.mimeType = 'image/png';
      if (fault === 'unselected') shot.selfReport.contact = null;
      await expect(storage.save(session, assets), fault).rejects.toBeInstanceOf(RecordValidationError);
      expect(await database.count('sessions'), fault).toBe(0);
      expect(await database.count('assets'), fault).toBe(0);
    }
  });

  it('does not reject a decoded source merely because the original file has an empty MIME type', async () => {
    const data = record();
    const video = data.assets.get(data.session.sets[0].shots[0].video.assetId)!;
    video.blob = new Blob(['decoded-video']);
    video.mimeType = '';
    video.sizeBytes = video.blob.size;
    await storage.save(data.session, data.assets);
    expect((await storage.load(data.session.id))!.assets.get(video.id)!.mimeType).toBe('');
  });

  it('waits for transaction completion and rolls back a failed new save, then allows retry', async () => {
    let fail = true;
    const failing = withPolicy(database, (tx) => { if (fail) tx.abort(); });
    const data = record();
    const draftBefore = structuredClone(data.session);
    await expect(failing.save(data.session, data.assets)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await storage.list()).toEqual([]);
    expect(await database.count('assets')).toBe(0);
    expect(data.session).toEqual(draftBefore);
    expect(data.assets.size).toBe(5);
    fail = false;
    await failing.save(data.session, data.assets);
    expect(await storage.list()).toHaveLength(1);
    expect(await database.count('assets')).toBe(5);
  });

  it('rolls back every change during failed video / frame replacement and preserves the editable draft', async () => {
    const before = record('old');
    await storage.save(before.session, before.assets);
    const savedBefore = (await storage.load(before.session.id))!;
    const replacement = record('new');
    const edited = structuredClone(before.session);
    const shot = edited.sets[0].shots[0];
    shot.video = replacement.session.sets[0].shots[0].video;
    shot.scenes = replacement.session.sets[0].shots[0].scenes;
    shot.selfReport = { contact: 'poor', direction: 'left' };
    edited.sets[0].analysisResult = makeDummy(shot.id);
    const failing = withPolicy(database, (tx) => { tx.abort(); });
    await expect(failing.save(edited, replacement.assets)).rejects.toMatchObject({ name: 'AbortError' });
    const restored = (await storage.load(before.session.id))!;
    expect(restored.session).toEqual(savedBefore.session);
    expect(await database.count('assets')).toBe(5);
    for (const [id, asset] of restored.assets) expect(await asset.blob.text()).toBe(await before.assets.get(id)!.blob.text());
    expect(edited.sets[0].shots[0].selfReport.contact).toBe('poor');
    await storage.save(edited, replacement.assets);
    expect(await database.count('assets')).toBe(5);
    expect((await storage.load(before.session.id))!.session.sets[0].shots[0].video.fileName).toBe('new.mp4');
    for (const id of before.assets.keys()) expect(await database.get('assets', id)).toBeUndefined();
  });

  it('rolls back a quota failure and explains capacity instead of claiming success', async () => {
    const old = record('old');
    await storage.save(old.session, old.assets);
    const before = (await storage.load(old.session.id))!.session;
    old.session.sets[0].shots[0].selfReport.direction = 'right';
    const quota = new DOMException('Injected storage quota failure', 'QuotaExceededError');
    const failing = withPolicy(database, () => { throw quota; });
    await expect(failing.save(old.session, old.assets)).rejects.toBe(quota);
    expect((await storage.load(old.session.id))!.session).toEqual(before);
    expect(storageErrorMessage(quota)).toContain('保存容量が足りません');
    expect(old.session.sets[0].shots[0].selfReport.direction).toBe('right');
  });

  it('surfaces unavailable storage with a Japanese recovery explanation', async () => {
    const unavailable = new DOMException('Injected unavailable storage', 'SecurityError');
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw unavailable; });
    await expect(openStorage(`${name}-unavailable`)).rejects.toBe(unavailable);
    expect(storageErrorMessage(unavailable)).toContain('保存領域を利用できません');
    expect(await database.count('sessions')).toBe(0);
  });

  it('deletes only the target and its unshared assets and protects another record', async () => {
    const a = record('A');
    const b = record('B');
    // Two records may reference the same immutable original video asset.
    const sharedVideoId = a.session.sets[0].shots[0].video.assetId;
    b.assets.delete(b.session.sets[0].shots[0].video.assetId);
    b.session.sets[0].shots[0].video.assetId = sharedVideoId;
    b.assets.set(sharedVideoId, a.assets.get(sharedVideoId)!);
    await storage.save(a.session, a.assets);
    await storage.save(b.session, b.assets);
    expect(await database.count('assets')).toBe(9);
    const beforeB = (await storage.load(b.session.id))!.session;
    await storage.delete(a.session.id);
    expect(await storage.load(a.session.id)).toBeUndefined();
    expect((await storage.load(b.session.id))!.session).toEqual(beforeB);
    expect(await database.count('assets')).toBe(5);
    expect(await database.get('assets', sharedVideoId)).toBeDefined();
    await storage.delete(b.session.id);
    expect(await database.count('sessions')).toBe(0);
    expect(await database.count('assets')).toBe(0);
  });

  it('does not collect shared assets while updating a record', async () => {
    const a = record('A');
    const b = record('B');
    const sharedId = a.session.sets[0].shots[0].video.assetId;
    b.assets.delete(b.session.sets[0].shots[0].video.assetId);
    b.session.sets[0].shots[0].video.assetId = sharedId;
    b.assets.set(sharedId, a.assets.get(sharedId)!);
    await storage.save(a.session, a.assets);
    await storage.save(b.session, b.assets);
    const updated = record('updated');
    const edited = structuredClone(a.session);
    edited.sets[0].shots[0].video = updated.session.sets[0].shots[0].video;
    edited.sets[0].shots[0].scenes = updated.session.sets[0].shots[0].scenes;
    await storage.save(edited, updated.assets);
    expect(await database.count('assets')).toBe(10);
    expect((await storage.load(b.session.id))!.assets.get(sharedId)).toBeDefined();
  });

  it('rolls back a failed delete with every Blob intact', async () => {
    const a = record('A');
    const b = record('B');
    await storage.save(a.session, a.assets);
    await storage.save(b.session, b.assets);
    const failing = withPolicy(database, (tx, operation) => { if (operation === 'delete') tx.abort(); });
    await expect(failing.delete(a.session.id)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await storage.list()).toHaveLength(2);
    expect(await database.count('assets')).toBe(10);
    expect((await storage.load(a.session.id))!.assets.size).toBe(5);
    expect((await storage.load(b.session.id))!.assets.size).toBe(5);
  });
});
