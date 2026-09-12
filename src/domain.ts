import { CONTACT_LABELS, DIRECTION_LABELS, validateAiAnalysis, type AiAnalysis } from '../shared/analysis';
export { CONTACT_LABELS, DIRECTION_LABELS } from '../shared/analysis';
export type { AiAnalysis } from '../shared/analysis';
export type Scene = 'address' | 'top' | 'impact' | 'finish';
export type Contact = 'good' | 'fair' | 'poor' | 'unknown';
export type Direction = 'left' | 'center' | 'right' | 'unknown';

export const SCENES = ['address', 'top', 'impact', 'finish'] as const;
export const SCENE_LABELS: Record<Scene, string> = {
  address: 'アドレス', top: 'トップ', impact: 'インパクト付近', finish: 'フィニッシュ',
};
export const MAX_VIDEO_BYTES = 104857600;
export const MAX_VIDEO_SECONDS = 30;
export const MAX_FRAME_EDGE = 1280;
export const DUMMY_FOCUS = 'フィニッシュで、無理なく静止できる強さで振る。';
export const DUMMY_DISCLAIMER = '動作確認用の見本・動画未分析。動画・当たり・方向から生成した結果ではありません。';

export interface SceneCapture {
  assetId: string;
  requestedTimeSec: number;
  observedTimeSec: number;
  timeBasis: 'video-frame-callback' | 'video-current-time';
  width: number;
  height: number;
}

export interface Shot {
  id: string;
  inputRevision?: number;
  inputFingerprint?: string;
  order: number;
  video: {
    assetId: string;
    fileName: string;
    durationSec: number;
    width: number;
    height: number;
  };
  scenes: Partial<Record<Scene, SceneCapture>>;
  selfReport: { contact: Contact | null; direction: Direction | null };
}

export interface DummyAnalysis {
  id: string;
  kind: 'dummy';
  analyzed: false;
  createdAt: string;
  inputShotIds: string[];
  nextFocus: string;
  disclaimer: string;
}

export interface PracticeSet {
  id: string;
  createdAt: string;
  shots: Shot[];
  analysisResult: DummyAnalysis | AiAnalysis | null;
}

export interface Session {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  sets: PracticeSet[];
}

export interface MediaAsset {
  id: string;
  kind: 'video' | 'frame';
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
}

export interface VideoMetadata {
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
}

/** UUIDs identify local records, including during the preliminary LAN HTTP test. */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createSession(video: Shot['video']): Session {
  const now = new Date().toISOString();
  return {
    id: newId(), schemaVersion: 1, createdAt: now, updatedAt: now,
    sets: [{
      id: newId(), createdAt: now,
      shots: [{
        id: newId(), order: 1, video: { ...video }, scenes: {},
        selfReport: { contact: null, direction: null },
      }],
      analysisResult: null,
    }],
  };
}

export function makeDummy(shotId: string): DummyAnalysis {
  return {
    id: newId(), kind: 'dummy', analyzed: false,
    createdAt: new Date().toISOString(), inputShotIds: [shotId],
    nextFocus: DUMMY_FOCUS, disclaimer: DUMMY_DISCLAIMER,
  };
}

const isDimension = (value: number) => Number.isInteger(value) && value > 0;
const isId = (value: string) => typeof value === 'string' && value.trim().length > 0;
const isDate = (value: string) => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateVideoMetadata(video: VideoMetadata): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(video.durationSec) || video.durationSec <= 0 || video.durationSec > MAX_VIDEO_SECONDS) {
    errors.push('動画の長さは0秒より長く、30秒以下にしてください。');
  }
  if (!Number.isInteger(video.sizeBytes) || video.sizeBytes <= 0 || video.sizeBytes > MAX_VIDEO_BYTES) {
    errors.push('動画は空でない、100 MiB（104857600 bytes）以下のファイルを選んでください。');
  }
  if (!isDimension(video.width) || !isDimension(video.height)) {
    errors.push('動画の縦横の大きさを取得できません。別の動画を選んでください。');
  }
  return errors;
}

/** Validates a complete Phase 0 record, including its fixed dummy result. */
export function validateSession(session: Session): string[] {
  const errors: string[] = [];
  if (session.schemaVersion !== 1) errors.push('この保存形式は現在のアプリでは開けません。');
  if (!isId(session.id) || !isDate(session.createdAt) || !isDate(session.updatedAt)) {
    errors.push('記録の識別情報が不正です。');
  }
  if (session.sets.length !== 1 || session.sets[0].shots.length !== 1) {
    return [...errors, 'Phase 0では1記録につき1セット・1球を保存します。'];
  }
  const set = session.sets[0];
  const shot = set.shots[0];
  if (!isId(set.id) || !isId(shot.id) || !isDate(set.createdAt) || shot.order !== 1) {
    errors.push('セット・球の識別情報が不正です。');
  }
  if (!isId(shot.video.assetId)) errors.push('元動画がありません。');
  errors.push(...validateVideoMetadata({ ...shot.video, sizeBytes: 1 }));
  if (shot.selfReport.contact === null || !Object.hasOwn(CONTACT_LABELS, shot.selfReport.contact)) {
    errors.push('当たりを選んでください。「わからない」でも保存できます。');
  }
  if (shot.selfReport.direction === null || !Object.hasOwn(DIRECTION_LABELS, shot.selfReport.direction)) {
    errors.push('方向を選んでください。「わからない」でも保存できます。');
  }
  let previous = -1;
  const sceneAssets = new Set<string>();
  for (const scene of SCENES) {
    const capture = shot.scenes[scene];
    const label = SCENE_LABELS[scene];
    if (!capture) { errors.push(`${label}の画像を指定してください。`); continue; }
    if (!isId(capture.assetId) || sceneAssets.has(capture.assetId) || capture.assetId === shot.video.assetId) {
      errors.push(`${label}の画像の識別情報が不正です。`);
    }
    sceneAssets.add(capture.assetId);
    const time = capture.requestedTimeSec;
    if (!Number.isFinite(time) || time < 0 || time >= shot.video.durationSec) {
      errors.push(`${label}は動画の開始から終端より前に指定してください。終端では少し戻してください。`);
    } else if (time <= previous) {
      errors.push(`${label}は前の場面より後に指定してください。同じ時刻にはできません。`);
    }
    previous = time;
    if (!Number.isFinite(capture.observedTimeSec) || capture.observedTimeSec < 0 || capture.observedTimeSec > shot.video.durationSec
      || !['video-frame-callback', 'video-current-time'].includes(capture.timeBasis)) {
      errors.push(`${label}の抽出時刻が不正です。画像を指定し直してください。`);
    }
    if (!isDimension(capture.width) || !isDimension(capture.height)
      || Math.max(capture.width, capture.height) > MAX_FRAME_EDGE
      || capture.width > shot.video.width || capture.height > shot.video.height) {
      errors.push(`${label}の画像サイズが不正です。画像を指定し直してください。`);
    }
  }
  const analysis = set.analysisResult;
  if (analysis?.kind === 'ai') {
    if (!validateAiAnalysis(analysis) || analysis.shotId !== shot.id) errors.push('AI分析の保存形式が不正です。');
  } else if (analysis && (!isId(analysis.id) || analysis.kind !== 'dummy' || analysis.analyzed !== false
    || !isDate(analysis.createdAt) || analysis.nextFocus !== DUMMY_FOCUS || analysis.disclaimer !== DUMMY_DISCLAIMER
    || analysis.inputShotIds.length !== 1 || analysis.inputShotIds[0] !== shot.id)) {
    errors.push('動作確認用の見本の保存形式が不正です。');
  }
  return errors;
}

export function referencedAssetIds(session: Session): Set<string> {
  const ids = new Set<string>();
  for (const set of session.sets) for (const shot of set.shots) {
    ids.add(shot.video.assetId);
    for (const scene of SCENES) if (shot.scenes[scene]) ids.add(shot.scenes[scene].assetId);
  }
  return ids;
}
