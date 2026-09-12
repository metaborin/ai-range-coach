import { describe, expect, it, vi } from 'vitest';
import { collectCaptureCandidates, planCaptureCandidates, type CaptureAssistProgress } from './captureAssist';
import type { CapturedFrame } from './media';

const frameAt = (time: number): CapturedFrame => ({
  blob: new Blob(['synthetic-jpeg'], { type: 'image/jpeg' }),
  requestedTimeSec: time, observedTimeSec: Math.max(0, time - 0.01), timeBasis: 'video-current-time', width: 320, height: 180,
});

describe('local capture assistance', () => {
  it('uses provisional offsets in scene order and omits out-of-range scenes without clamping', () => {
    expect(planCaptureCandidates(2, 5)).toEqual([
      { scene: 'address', requestedTimeSec: 0 }, { scene: 'top', requestedTimeSec: 1.75 },
      { scene: 'impact', requestedTimeSec: 2 }, { scene: 'finish', requestedTimeSec: 2.8 },
    ]);
    expect(planCaptureCandidates(0.1, 0.5)).toEqual([{ scene: 'impact', requestedTimeSec: 0.1 }]);
    expect(planCaptureCandidates(0.05, 0.1)).toEqual([{ scene: 'impact', requestedTimeSec: 0.05 }]);
    expect(planCaptureCandidates(2.3, 3.1).some((target) => target.scene === 'finish')).toBe(false);
    expect(planCaptureCandidates(1.5, 2.3)).toEqual([
      { scene: 'top', requestedTimeSec: 1.25 }, { scene: 'impact', requestedTimeSec: 1.5 },
    ]);
    for (const anchor of [-1, NaN, Infinity, 5]) expect(() => planCaptureCandidates(anchor, 5)).toThrow();
    for (const duration of [0, -1, NaN, Infinity]) expect(() => planCaptureCandidates(0, duration)).toThrow();
  });

  it('extracts one frame at a time, retaining observed timing and reporting real completed counts', async () => {
    const progress: CaptureAssistProgress[] = [];
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const capture = vi.fn(async (time: number) => {
      running += 1; peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return frameAt(time);
    });
    const pending = collectCaptureCandidates(capture, 2, 5, {
      signal: new AbortController().signal, onProgress: (value) => progress.push(value),
    });
    expect(capture).toHaveBeenCalledTimes(1);
    for (let count = 1; count <= 4; count++) {
      releases.shift()!();
      // Let capture completion and the collector continuation each run.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(capture).toHaveBeenCalledTimes(Math.min(count + 1, 4));
    }
    const result = await pending;
    expect(peak).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.frames.top).toMatchObject({ requestedTimeSec: 1.75, observedTimeSec: 1.74, timeBasis: 'video-current-time' });
    expect(progress.map((value) => value.completed)).toEqual([0, 1, 2, 3, 4]);
    expect(progress.at(-1)).toEqual({ completed: 4, attempted: 4, total: 4 });
  });

  it('returns available images and missing scene details after an individual extraction failure', async () => {
    const capture = vi.fn(async (time: number) => {
      if (time === 1.75) throw new Error('JPEG画像を作成できませんでした。');
      return frameAt(time);
    });
    const result = await collectCaptureCandidates(capture, 2, 5, { signal: new AbortController().signal });
    expect(Object.keys(result.frames)).toEqual(['address', 'impact', 'finish']);
    expect(result.missing).toEqual(['top']);
    expect(result.failures).toEqual({ top: 'JPEG画像を作成できませんでした。' });
    expect(capture).toHaveBeenCalledTimes(4);
    const nearStart = await collectCaptureCandidates(capture, 0.1, 0.5, { signal: new AbortController().signal });
    expect(nearStart.missing).toEqual(['address', 'top', 'finish']);
    expect(nearStart.failures).toEqual({});
  });

  it('discards all results after cancellation even when an old capture resolves late, then allows a fresh run', async () => {
    const abort = new AbortController();
    let release: ((frame: CapturedFrame) => void) | undefined;
    const capture = vi.fn(() => new Promise<CapturedFrame>((resolve) => { release = resolve; }));
    const progress = vi.fn();
    const pending = collectCaptureCandidates(capture, 2, 5, { signal: abort.signal, onProgress: progress });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    release!(frameAt(0));
    await rejected;
    expect(capture).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledTimes(1);
    const fresh = await collectCaptureCandidates(async (time) => frameAt(time), 3, 5, { signal: new AbortController().signal });
    expect(fresh.frames.address?.requestedTimeSec).toBe(1);
    expect(fresh.frames.impact?.requestedTimeSec).toBe(3);
  });

  it('does no extraction for a pre-aborted request and treats source cancellation as cancellation', async () => {
    const abort = new AbortController(); abort.abort();
    const capture = vi.fn(async () => frameAt(0));
    await expect(collectCaptureCandidates(capture, 2, 5, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(capture).not.toHaveBeenCalled();
    await expect(collectCaptureCandidates(async () => {
      throw new DOMException('動画差し替え', 'AbortError');
    }, 2, 5, { signal: new AbortController().signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
