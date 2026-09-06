import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  SCENES, SCENE_LABELS, referencedAssetIds, validateSession, validateVideoMetadata,
  type MediaAsset, type Session,
} from './domain';

export const DATABASE_NAME = 'ai-range-coach';
export const DATABASE_VERSION = 1;

export interface RangeDatabase extends DBSchema {
  sessions: { key: string; value: Session };
  assets: { key: string; value: MediaAsset };
}

type WriteTransaction = IDBPTransaction<RangeDatabase, ['sessions', 'assets'], 'readwrite'>;

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
    snapshot.updatedAt = new Date().toISOString();
    const tx = this.database.transaction(['sessions', 'assets'], 'readwrite');
    const done = tx.done;
    void done.catch(() => undefined);
    try {
      const sessionStore = tx.objectStore('sessions');
      const assetStore = tx.objectStore('assets');
      const records = await sessionStore.getAll();
      const previous = records.find((record) => record.id === snapshot.id);
      const protectedIds = new Set(records.filter((record) => record.id !== snapshot.id).flatMap((record) => [...referencedAssetIds(record)]));
      const nextIds = referencedAssetIds(snapshot);
      for (const id of nextIds) {
        const existing = await assetStore.get(id);
        const incoming = snapshotAssets.get(id)!;
        // Asset IDs are immutable. Re-extraction or video replacement gets a new ID.
        if (!existing) await assetStore.add(incoming);
        else if (existing.kind !== incoming.kind || existing.mimeType !== incoming.mimeType || existing.sizeBytes !== incoming.sizeBytes) {
          throw new RecordValidationError(['既存の素材IDに別のデータを上書きできません。動画・画像を指定し直してください。']);
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

  async delete(id: string): Promise<void> {
    const tx = this.database.transaction(['sessions', 'assets'], 'readwrite');
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
    },
    blocking() { db.close(); },
  });
  return new SessionStorage(db);
}
