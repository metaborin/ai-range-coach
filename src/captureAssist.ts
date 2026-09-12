import { SCENES, type Scene } from './domain';
import type { CapturedFrame } from './media';

/**
 * Temporary normal-speed offsets, introduced for the 2026-09 capture-assist trial.
 * These reduce repeated seeking; they are not measured golf phase timings.
 * Change this single table after the user's real-video evaluation, recording why.
 */
export const CAPTURE_ASSIST_OFFSETS_SEC: Readonly<Record<Scene, number>> = Object.freeze({
  address: -1.5,
  top: -0.25,
  impact: 0,
  finish: 0.8,
});

export interface CaptureAssistResult {
  frames: Partial<Record<Scene, CapturedFrame>>;
  /** Every absent scene, whether out of range or failed to extract. */
  missing: Scene[];
  failures: Partial<Record<Scene, string>>;
}

export interface CaptureAssistProgress {
  completed: number;
  attempted: number;
  total: number;
}

export function planCaptureCandidates(anchorTimeSec: number, durationSec: number) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('動画の長さを確認してから、基準を指定してください。');
  }
  if (!Number.isFinite(anchorTimeSec) || anchorTimeSec < 0 || anchorTimeSec >= durationSec) {
    throw new Error('動画の範囲内を基準にしてください。終端の場合は少し戻してください。');
  }
  return SCENES.flatMap((scene) => {
    const offset = CAPTURE_ASSIST_OFFSETS_SEC[scene];
    // Match the movement controls' nanosecond arithmetic precision, without
    // snapping to a frame. Avoid treating 2.3 + 0.8 as below a 3.1-second end.
    const requestedTimeSec = offset === 0 ? anchorTimeSec : Math.round((anchorTimeSec + offset) * 1_000_000_000) / 1_000_000_000;
    // Omit unavailable scenes. Clamping would invent duplicate endpoint pictures.
    return requestedTimeSec >= 0 && requestedTimeSec < durationSec ? [{ scene, requestedTimeSec }] : [];
  });
}

const cancelled = () => new DOMException('候補作成を中断しました。', 'AbortError');

export async function collectCaptureCandidates(
  capture: (time: number, signal: AbortSignal) => Promise<CapturedFrame>,
  anchorTimeSec: number,
  durationSec: number,
  options: { signal: AbortSignal; onProgress?: (progress: CaptureAssistProgress) => void },
): Promise<CaptureAssistResult> {
  const targets = planCaptureCandidates(anchorTimeSec, durationSec);
  const frames: CaptureAssistResult['frames'] = {};
  const failures: CaptureAssistResult['failures'] = {};
  const { signal, onProgress } = options;
  let attempted = 0;
  const checkCancellation = () => { if (signal.aborted) throw cancelled(); };
  const progress = () => onProgress?.({ completed: Object.keys(frames).length, attempted, total: targets.length });
  checkCancellation();
  progress();
  for (const { scene, requestedTimeSec } of targets) {
    checkCancellation();
    try {
      const frame = await capture(requestedTimeSec, signal);
      checkCancellation();
      frames[scene] = frame;
    } catch (cause) {
      if (signal.aborted || (cause instanceof Error && cause.name === 'AbortError')) throw cancelled();
      failures[scene] = cause instanceof Error ? cause.message : '画像を取得できませんでした。手動で選び直してください。';
    }
    attempted += 1;
    progress();
  }
  checkCancellation();
  return { frames, missing: SCENES.filter((scene) => !frames[scene]), failures };
}
