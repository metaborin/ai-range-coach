import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  SCENES, SCENE_LABELS, referencedAssetIds, validateSession, validateVideoMetadata,
  type MediaAsset, type Session,
} from './domain';
import { sourceFingerprint } from './analysisSnapshot';
import { validateAiAnalysis, type AiAnalysis } from '../shared/analysis';
import type { LocalAnalysisRequest } from './analysisTypes';

export const DATABASE_NAME = 'ai-range-coach';
export const DATABASE_VERSION = 2;

export interface RangeDatabase extends DBSchema {
  sessions: { key: string; value: Session };
  assets: { key: string; value: MediaAsset };
  analysisRequests: { key: string; value: LocalAnalysisRequest };
}

type WriteTransaction = IDBPTransaction<RangeDatabase, ['sessions', 'assets', 'analysisRequests'], 'readwrite'>;

/** An optional synchronous commit policy allows isolated transaction-failure tests. */
export type CommitPolicy = (transaction: WriteTransaction, operation: 'save' | 'delete') => void;

export class RecordValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('\n'));
    this.name = 'RecordValidationError';
  }
}

function validateAssets(session: Session, assets: Map<string, MediaAsset>): string[] {
  const errors: string[] = [];
  for (const set of session.sets) for (const shot of set.shots) {
    const video = assets.get(shot.video.assetId);
    if (!video || video.kind !== 'video') errors.push('元動画のデータがありません。');
    else errors.push(...validateVideoMetadata({ ...shot.video, sizeBytes: video.sizeBytes }));
    for (const scene of SCENES) {
      const capture = shot.scenes[scene];
      const frame = capture && assets.get(capture.assetId);
      if (!frame || frame.kind !== 'frame' || frame.mimeType !== 'image/jpeg' || frame.blob?.type !== 'image/jpeg') {
        errors.push(`${SCENE_LABELS[scene]}のJPEG画像がありません。`);
      }
    }
  }
  for (const id of referencedAssetIds(session)) {
    const asset = assets.get(id);
    if (!asset || asset.id !== id || !(asset.blob instanceof Blob) || asset.blob.size === 0
      || asset.sizeBytes !== asset.blob.size || asset.mimeType !== asset.blob.type) {
      errors.push('動画または画像のデータが不完全です。選択・抽出し直してください。');
    }
  }
  return errors;
}

export function storageErrorMessage(error: unknown): string {
  if (error instanceof RecordValidationError) return error.errors.join('\n');
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') {
    return '端末の保存容量が足りません。不要な保存記録などを整理してから再試行してください。編集中の内容はこの画面に残っています。';
  }
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'VersionError' || name === 'NotAllowedError') {
    return 'この環境では保存領域を利用できません。ブラウザの設定と起動モードを確認してください。既存の記録は削除していません。';
  }
  return '保存領域の操作に失敗しました。編集中の内容を残して再試行できます。既存の記録は変更していません。';
}

export class SessionStorage {
  constructor(
    private readonly database: IDBPDatabase<RangeDatabase>,
    private readonly commitPolicy?: CommitPolicy,
  ) {}

  close(): void { this.database.close(); }

  async list(): Promise<Session[]> {
    const records = await this.database.getAll('sessions');
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<{ session: Session; assets: Map<string, MediaAsset> } | undefined> {
    const tx = this.database.transaction(['sessions', 'assets'], 'readonly');
    const done = tx.done;
    void done.catch(() => undefined);
    const session = await tx.objectStore('sessions').get(id);
    if (!session) { await done; return undefined; }
    if (session.schemaVersion !== 1) {
      await done;
      throw new RecordValidationError(['この保存形式は現在のアプリでは開けません。保存データは残しています。']);
    }
    const assets = new Map<string, MediaAsset>();
    await Promise.all([...referencedAssetIds(session)].map(async (assetId) => {
      const asset = await tx.objectStore('assets').get(assetId);
      if (asset) assets.set(assetId, asset);
    }));
    await done;
    const errors = [...validateSession(session), ...validateAssets(session, assets)];
    if (errors.length) throw new RecordValidationError(errors);
    return { session, assets };
  }

  async save(session: Session, assets: Map<string, MediaAsset>): Promise<void> {
    // Snapshot and validate before opening a transaction. Blob encoding happens in media.ts.
    const snapshot = structuredClone(session);
    const snapshotAssets = new Map(assets);
    const errors = [...validateSession(snapshot), ...validateAssets(snapshot, snapshotAssets)];
    if (errors.length) throw new RecordValidationError(errors);
    const fingerprint = await sourceFingerprint(snapshot, snapshotAssets);
    snapshot.updatedAt = new Date().toISOString();
    const tx = this.database.transaction(['sessions', 'assets', 'analysisRequests'], 'readwrite');
    const done = tx.done;
    void done.catch(() => undefined);
    try {
      const sessionStore = tx.objectStore('sessions');
      const assetStore = tx.objectStore('assets');
      const records = await sessionStore.getAll();
      const previous = records.find((record) => record.id === snapshot.id);
      const shot = snapshot.sets[0].shots[0];
      const previousShot = previous?.sets[0].shots[0];
      shot.inputRevision = (previousShot?.inputRevision ?? 0) + (previousShot && previousShot.inputFingerprint !== fingerprint ? 1 : 0);
      shot.inputFingerprint = fingerprint;
      // An editor opened before analysis finished must not erase the completed result.
      const latestAnalysis = previous?.sets[0].analysisResult;
      if (latestAnalysis?.kind === 'ai' && (snapshot.sets[0].analysisResult?.kind !== 'ai'
        || latestAnalysis.createdAt >= snapshot.sets[0].analysisResult.createdAt)) snapshot.sets[0].analysisResult = latestAnalysis;
      const protectedIds = new Set(records.filter((record) => record.id !== snapshot.id).flatMap((record) => [...referencedAssetIds(record)]));
      const nextIds = referencedAssetIds(snapshot);
      for (const id of nextIds) {
        const existing = await assetStore.get(id);
        const incoming = snapshotAssets.get(id)!;
        // Normal extraction allocates new IDs. Also account for same-ID frame bytes.
        if (!existing) await assetStore.add(incoming);
        else if (existing.kind !== incoming.kind || existing.mimeType !== incoming.mimeType || existing.sizeBytes !== incoming.sizeBytes) {
          throw new RecordValidationError(['既存の素材IDに別のデータを上書きできません。動画・画像を指定し直してください。']);
        }
        else if (incoming.kind === 'frame') {
          if (protectedIds.has(id)) throw new RecordValidationError(['共有された画像は新しく抽出してください。']);
          await assetStore.put(incoming);
        }
      }
      await sessionStore.put(snapshot);
      if (previous) for (const id of referencedAssetIds(previous)) {
        if (!nextIds.has(id) && !protectedIds.has(id)) await assetStore.delete(id);
      }
      this.commitPolicy?.(tx, 'save');
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* A failed or completed transaction is already inactive. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async analysisList(sessionId: string): Promise<LocalAnalysisRequest[]> {
    return (await this.database.getAll('analysisRequests')).filter(item => item.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async prepareAnalysis(local: LocalAnalysisRequest, expected: Session): Promise<void> {
    const tx = this.database.transaction(['sessions', 'analysisRequests'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const current = await tx.objectStore('sessions').get(local.sessionId);
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('保存内容が変わりました。記録を開き直して確認してください。');
      const outstanding = (await tx.objectStore('analysisRequests').getAll()).some(item => item.state === 'pending' && Date.now() - Date.parse(item.createdAt) < 90000);
      if (outstanding) throw new Error('確認待ちの分析があります。既存の要求の状態を確認してください。');
      const shot = current.sets[0].shots[0];
      shot.inputRevision = local.inputRevision; shot.inputFingerprint = local.sourceFingerprint;
      await tx.objectStore('sessions').put(current);
      await tx.objectStore('analysisRequests').add(local);
      await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* already inactive */ } await tx.done.catch(() => undefined); throw error; }
  }

  async updateAnalysisRequest(requestId: string, update: Partial<Pick<LocalAnalysisRequest, 'state' | 'result' | 'errorCode'>>, onlyPending = false): Promise<void> {
    const tx = this.database.transaction(['sessions', 'analysisRequests'], 'readwrite');
    void tx.done.catch(() => undefined);
    const local = await tx.objectStore('analysisRequests').get(requestId);
    if (local && (!onlyPending || local.state === 'pending')) {
      const next = { ...local, ...update };
      if (!await tx.objectStore('sessions').get(local.sessionId)) delete next.result;
      await tx.objectStore('analysisRequests').put(next);
    }
    await tx.done;
  }

  async saveAnalysisResult(local: LocalAnalysisRequest, result: AiAnalysis): Promise<boolean> {
    if (!validateAiAnalysis(result) || result.requestId !== local.requestId || result.shotId !== local.shotId
      || result.fingerprint !== local.fingerprint || result.sourceFingerprint !== local.sourceFingerprint
      || result.inputRevision !== local.inputRevision) throw new Error('分析結果の対象を確認できませんでした。');
    for (let attempt = 0; attempt < 3; attempt++) {
      const loaded = await this.load(local.sessionId);
      if (!loaded) return false;
      const actualFingerprint = await sourceFingerprint(loaded.session, loaded.assets);
      const tx = this.database.transaction(['sessions', 'analysisRequests'], 'readwrite');
      void tx.done.catch(() => undefined);
      try {
        const current = await tx.objectStore('sessions').get(local.sessionId);
        if (!current) { await tx.done; return false; }
        if (JSON.stringify(current) !== JSON.stringify(loaded.session)) { await tx.done; continue; }
        const shot = current.sets[0].shots[0];
        if (shot.id !== local.shotId) { await tx.done; return false; }
        if (shot.inputFingerprint !== actualFingerprint) {
          shot.inputRevision = (shot.inputRevision ?? 0) + 1;
          shot.inputFingerprint = actualFingerprint;
        }
        const previous = current.sets[0].analysisResult;
        // Never replace a newer analysis; old results stay tied to their own snapshot.
        if (previous?.kind !== 'ai' || previous.createdAt <= result.createdAt) current.sets[0].analysisResult = result;
        current.updatedAt = new Date().toISOString();
        await tx.objectStore('sessions').put(current);
        await tx.objectStore('analysisRequests').put({ ...local, state: 'succeeded', result });
        await tx.done;
        return true;
      } catch (error) { try { tx.abort(); } catch { /* already inactive */ } await tx.done.catch(() => undefined); throw error; }
    }
    throw new Error('別の画面で記録が変更されました。結果の保存をもう一度お試しください。');
  }

  async delete(id: string): Promise<void> {
    const tx = this.database.transaction(['sessions', 'assets', 'analysisRequests'], 'readwrite');
    const done = tx.done;
    void done.catch(() => undefined);
    try {
      const records = await tx.objectStore('sessions').getAll();
      const target = records.find((session) => session.id === id);
      if (target) {
        const protectedIds = new Set(records.filter((session) => session.id !== id).flatMap((session) => [...referencedAssetIds(session)]));
        await tx.objectStore('sessions').delete(id);
        for (const assetId of referencedAssetIds(target)) {
          if (!protectedIds.has(assetId)) await tx.objectStore('assets').delete(assetId);
        }
        for (const local of await tx.objectStore('analysisRequests').getAll()) {
          if (local.sessionId !== id) continue;
          delete local.result; // Keep only the no-resend ID/status, never a deleted record's advice.
          await tx.objectStore('analysisRequests').put(local);
        }
      }
      this.commitPolicy?.(tx, 'delete');
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* Preserve the original failure. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }
}

export async function openStorage(name = DATABASE_NAME): Promise<SessionStorage> {
  const db = await openDB<RangeDatabase>(name, DATABASE_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore('sessions', { keyPath: 'id' });
        database.createObjectStore('assets', { keyPath: 'id' });
      }
      if (oldVersion < 2) database.createObjectStore('analysisRequests', { keyPath: 'requestId' });
    },
    blocking() { db.close(); },
  });
  return new SessionStorage(db);
}
