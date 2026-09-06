import { SCENES, SCENE_LABELS, type Session, type MediaAsset } from './domain';
import { sha256, MAX_IMAGE_BYTES, computeFingerprint, validateAnalysisRequest, type AnalysisInput, type AnalysisRequest } from '../shared/analysis';

/** Hash original bytes, including when an asset ID is reused. No encoding or mutation. */
export async function sourceFingerprint(session: Session, assets: Map<string, MediaAsset>): Promise<string> {
  const shot = session.sets[0].shots[0];
  const frames = await Promise.all(SCENES.map(async scene => {
    const frame = shot.scenes[scene]!;
    const asset = assets.get(frame.assetId)!;
    return { scene, ...frame, sha256: await sha256(new Uint8Array(await asset.blob.arrayBuffer())) };
  }));
  return sha256(new TextEncoder().encode(JSON.stringify({ shotId: shot.id, videoId: shot.video.assetId,
    durationSec: shot.video.durationSec, selfReport: { contact: shot.selfReport.contact, direction: shot.selfReport.direction }, frames })));
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let start = 0; start < bytes.length; start += 8192) text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
}

async function sendingCopy(asset: MediaAsset, width: number, height: number): Promise<{ blob: Blob; width: number; height: number }> {
  if (asset.blob.size <= MAX_IMAGE_BYTES) return { blob: asset.blob, width, height };
  // Encode only an in-memory copy. Saved JPEGs and videos are never changed.
  const url = URL.createObjectURL(asset.blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('送信用画像の準備が時間内に完了しませんでした。')), 10000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('送信用画像を読み込めませんでした。')); };
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    for (const scale of [1, 0.8, 0.6]) {
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('送信用画像を準備できませんでした。');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('送信用画像の準備が時間内に完了しませんでした。')), 10000);
        canvas.toBlob(value => { clearTimeout(timer); if (value) resolve(value); else reject(new Error('送信用画像を準備できませんでした。')); }, 'image/jpeg', 0.72);
      });
      if (blob.size <= MAX_IMAGE_BYTES) return { blob, width: canvas.width, height: canvas.height };
    }
    throw new Error('送信画像が大きすぎます。短い通常動画から場面を指定し直してください。');
  } finally { URL.revokeObjectURL(url); }
}

export async function makeAnalysisRequest(session: Session, assets: Map<string, MediaAsset>, requestId: string, createdAt: string): Promise<AnalysisRequest> {
  const shot = session.sets[0].shots[0];
  if (shot.selfReport.contact === null || shot.selfReport.direction === null) throw new Error('当たり・方向を保存してください。');
  const fingerprint = await sourceFingerprint(session, assets);
  const input: AnalysisInput = {
    shotId: shot.id, inputRevision: (shot.inputRevision ?? 0) + (shot.inputFingerprint && shot.inputFingerprint !== fingerprint ? 1 : 0),
    sourceFingerprint: fingerprint, durationSec: shot.video.durationSec,
    selfReport: { contact: shot.selfReport.contact, direction: shot.selfReport.direction },
    frames: await Promise.all(SCENES.map(async scene => {
      const capture = shot.scenes[scene]!;
      const copy = await sendingCopy(assets.get(capture.assetId)!, capture.width, capture.height);
      return { scene, label: SCENE_LABELS[scene], requestedTimeSec: capture.requestedTimeSec,
        observedTimeSec: capture.observedTimeSec, timeBasis: capture.timeBasis,
        width: copy.width, height: copy.height, jpegBase64: base64(new Uint8Array(await copy.blob.arrayBuffer())) };
    })),
  };
  return validateAnalysisRequest({ requestId, createdAt, fingerprint: await computeFingerprint(input), input });
}
