export const MAX_VIDEO_BYTES = 104_857_600;
export const MAX_VIDEO_SECONDS = 30;

export interface VideoInfo {
  url: string;
  durationSec: number;
  width: number;
  height: number;
}

export interface CapturedFrame {
  blob: Blob;
  requestedTimeSec: number;
  observedTimeSec: number;
  timeBasis: 'video-frame-callback' | 'video-current-time';
  width: number;
  height: number;
}

const loading = new WeakMap<HTMLVideoElement, { url: string; cancel: () => void }>();
const aborted = () => new DOMException('動画の処理を取り消しました。もう一度操作してください。', 'AbortError');
const decodeError = () => new Error('この動画を読み込めませんでした。別の短い動画を選んでください。');

export function validateVideoSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw new Error('動画ファイルが空か、容量を読み取れません。別の動画を選んでください。');
  }
  if (sizeBytes > MAX_VIDEO_BYTES) {
    throw new Error('動画は100 MiB以下のものを選んでください。');
  }
}

export function validateVideoMetadata(durationSec: number, width: number, height: number): void {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error('動画の長さを確認できません。別の短い動画を選んでください。');
  }
  if (durationSec > MAX_VIDEO_SECONDS) {
    throw new Error('動画は30秒以下のものを選んでください。');
  }
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('動画の画像を読み取れません。この端末で再生できる別の動画を選んでください。');
  }
}

/** The caller owns a successful URL until releaseVideo. Failed loads release theirs. */
export async function loadVideo(video: HTMLVideoElement, blob: Blob, signal?: AbortSignal): Promise<VideoInfo> {
  validateVideoSize(blob.size);
  if (signal?.aborted) throw aborted();
  loading.get(video)?.cancel();
  const url = URL.createObjectURL(blob);
  return new Promise<VideoInfo>((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', check);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('canplay', check);
      video.removeEventListener('error', failDecode);
      signal?.removeEventListener('abort', cancel);
      if (loading.get(video)?.url === url) loading.delete(video);
    };
    const fail = (reason: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      releaseVideo(video, url);
      reject(reason);
    };
    const cancel = () => fail(aborted());
    const failDecode = () => fail(decodeError());
    const check = () => {
      if (finished) return;
      if (video.src !== url) return fail(aborted());
      if (video.readyState < 1) return;
      try {
        validateVideoMetadata(video.duration, video.videoWidth, video.videoHeight);
      } catch (error) {
        fail(error);
        return;
      }
      // Metadata alone is insufficient: require one decoded image, without autoplay.
      if (video.readyState < 2) return;
      finished = true;
      cleanup();
      resolve({ url, durationSec: video.duration, width: video.videoWidth, height: video.videoHeight });
    };
    const timer = setTimeout(() => fail(new Error('動画の読み込みが時間内に完了しませんでした。もう一度選ぶか、別の短い動画をお試しください。')), 15_000);
    loading.set(video, { url, cancel });
    signal?.addEventListener('abort', cancel, { once: true });
    video.addEventListener('loadedmetadata', check);
    video.addEventListener('loadeddata', check);
    video.addEventListener('canplay', check);
    video.addEventListener('error', failDecode);
    try {
      video.pause();
      video.preload = 'auto';
      video.playsInline = true;
      video.muted = true;
      video.src = url;
      video.load();
      check();
    } catch (error) {
      fail(error instanceof DOMException && error.name === 'AbortError' ? aborted() : decodeError());
    }
  });
}

export function releaseVideo(video: HTMLVideoElement, url: string): void {
  const pending = loading.get(video);
  if (pending?.url === url) {
    pending.cancel();
    return;
  }
  // A late cleanup from a previous load must not detach the replacement video.
  if (video.src === url) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  URL.revokeObjectURL(url);
}

type FrameTime = Pick<CapturedFrame, 'observedTimeSec' | 'timeBasis'>;
type SettledFrame = FrameTime & { currentTimeSec: number };

/** One controller per loaded video; dispose before replacing the source. */
export class MediaController {
  private readonly lifetime = new AbortController();
  private readonly source: string;
  private busy = false;
  private settledPosition: { requestedTimeSec: number; currentTimeSec: number } | undefined;
  private readonly invalidatePosition = () => { this.settledPosition = undefined; };

  constructor(private readonly video: HTMLVideoElement) {
    this.source = video.src;
    this.settledPosition = { requestedTimeSec: video.currentTime, currentTimeSec: video.currentTime };
    video.addEventListener('seeking', this.invalidatePosition);
    video.addEventListener('playing', this.invalidatePosition);
  }

  dispose(): void {
    this.lifetime.abort();
    this.video.removeEventListener('seeking', this.invalidatePosition);
    this.video.removeEventListener('playing', this.invalidatePosition);
    this.settledPosition = undefined;
  }

  async seek(time: number): Promise<void> {
    await this.run(async (signal) => {
      this.validateTime(time, false);
      this.video.pause();
      await this.moveTo(time, signal);
    });
  }

  async capture(time: number, signal?: AbortSignal): Promise<CapturedFrame> {
    return this.run(async (operationSignal) => {
      this.validateTime(time, true);
      this.video.pause();
      const { currentTimeSec, ...frame } = await this.moveTo(time, operationSignal);
      this.assertCurrent();
      if (operationSignal.aborted) throw aborted();
      if (this.video.seeking || !this.video.paused || !this.atTime(currentTimeSec)) throw aborted();
      const scale = Math.min(1, 1280 / Math.max(this.video.videoWidth, this.video.videoHeight));
      const width = Math.max(1, Math.round(this.video.videoWidth * scale));
      const height = Math.max(1, Math.round(this.video.videoHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('静止画を作成できませんでした。もう一度お試しください。');
        try {
          context.drawImage(this.video, 0, 0, width, height);
        } catch {
          throw new Error('動画の画像を静止画にできませんでした。別の位置で再試行するか、別の動画を選んでください。');
        }
        const blob = await this.encode(canvas, operationSignal);
        this.assertCurrent();
        if (this.video.seeking || !this.video.paused || !this.atTime(currentTimeSec)) throw aborted();
        return { blob, requestedTimeSec: time, ...frame, width, height };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }, signal);
  }

  private async run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.assertCurrent();
    if (signal?.aborted) throw aborted();
    if (this.busy) throw new Error('動画の位置調整・静止画作成が終わるまでお待ちください。');
    // Cancel this request without disposing the controller used by manual seeking.
    const operationAbort = new AbortController();
    const cancel = () => operationAbort.abort();
    this.lifetime.signal.addEventListener('abort', cancel, { once: true });
    signal?.addEventListener('abort', cancel, { once: true });
    this.busy = true;
    try {
      const result = await operation(operationAbort.signal);
      if (operationAbort.signal.aborted) throw aborted();
      return result;
    } finally {
      this.busy = false;
      this.lifetime.signal.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private assertCurrent(): void {
    if (this.lifetime.signal.aborted || this.video.src !== this.source) throw aborted();
  }

  private atTime(time: number): boolean {
    return Math.abs(this.video.currentTime - time) < 0.000001;
  }

  private validateTime(time: number, capture: boolean): void {
    validateVideoMetadata(this.video.duration, this.video.videoWidth, this.video.videoHeight);
    if (!Number.isFinite(time) || time < 0 || time > this.video.duration) {
      throw new Error('動画の範囲内の時刻を指定してください。');
    }
    if (capture && time === this.video.duration) {
      throw new Error('動画の終端は場面に指定できません。少し戻してから指定してください。');
    }
  }

  private moveTo(time: number, signal: AbortSignal): Promise<SettledFrame> {
    const video = this.video;
    // Comparing only currentTime can skip a new request when the browser exposes
    // a rounded position. Only a previously settled, identical request may skip.
    const previous = this.settledPosition;
    const needsSeek = video.seeking || !previous
      || Math.abs(previous.requestedTimeSec - time) >= 0.000001
      || !this.atTime(previous.currentTimeSec);
    this.settledPosition = undefined;
    return new Promise((resolve, reject) => {
      let finished = false;
      let issued = false;
      let issuedAt = Infinity;
      let seekCompleted = !needsSeek;
      let sawSeeking = false;
      let settledTime: number | undefined;
      let frameId: number | undefined;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      let paintTimeout: ReturnType<typeof setTimeout> | undefined;
      let raf: number | undefined;
      const hasFrames = typeof video.requestVideoFrameCallback === 'function';
      const cleanup = () => {
        clearTimeout(deadline);
        clearTimeout(fallback);
        clearTimeout(paintTimeout);
        if (raf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        if (frameId !== undefined && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameId);
        video.removeEventListener('seeking', onSeeking);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('playing', onAbort);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('canplay', ready);
        video.removeEventListener('error', onError);
        video.removeEventListener('emptied', onAbort);
        signal.removeEventListener('abort', onAbort);
      };
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(aborted());
      const onError = () => fail(decodeError());
      const done = (frame?: FrameTime) => {
        if (finished) return;
        try { this.assertCurrent(); } catch (error) { fail(error); return; }
        if (!seekCompleted || settledTime === undefined || video.seeking || !video.paused
          || video.readyState < 2 || !this.atTime(settledTime)) {
          fail(new Error('動画の位置が変更されました。止めてからもう一度指定してください。'));
          return;
        }
        finished = true;
        cleanup();
        this.settledPosition = { requestedTimeSec: time, currentTimeSec: settledTime };
        resolve({ currentTimeSec: settledTime, ...(frame ?? { observedTimeSec: settledTime, timeBasis: 'video-current-time' }) });
      };
      const paintThenDone = () => {
        // A paused, same-time seek may never yield an rVFC. Never wait indefinitely.
        paintTimeout = setTimeout(() => done(), 120);
        if (typeof requestAnimationFrame === 'function') {
          raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => done()); });
        }
      };
      const ready = () => {
        if (finished || !issued || !seekCompleted || video.seeking || video.readyState < 2) return;
        if (!video.paused || !Number.isFinite(video.currentTime) || video.currentTime < 0 || video.currentTime > video.duration) { fail(aborted()); return; }
        // The actual browser position may be rounded. Keep that observation tied
        // to this completed seek, rather than treating it as the next request.
        settledTime ??= video.currentTime;
        if (!this.atTime(settledTime)) { fail(aborted()); return; }
        if (fallback === undefined) fallback = setTimeout(paintThenDone, hasFrames ? 350 : 0);
      };
      const onSeeking = () => {
        if (!issued || finished) return;
        if (!needsSeek || sawSeeking) { fail(aborted()); return; }
        sawSeeking = true;
      };
      const onSeeked = () => {
        if (!issued || finished || video.seeking) return;
        seekCompleted = true;
        ready();
      };
      const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
        frameId = undefined;
        if (finished) return;
        // Ignore notifications from before this seek, including an old queued frame.
        if (issued && seekCompleted && settledTime !== undefined && !video.seeking && video.paused
          && video.readyState >= 2 && this.atTime(settledTime)
          && Number.isFinite(metadata.presentationTime) && metadata.presentationTime >= issuedAt
          && Number.isFinite(metadata.mediaTime) && metadata.mediaTime >= 0 && metadata.mediaTime <= video.duration) {
          done({ observedTimeSec: metadata.mediaTime, timeBasis: 'video-frame-callback' });
        } else {
          frameId = video.requestVideoFrameCallback(onFrame);
        }
      };
      const deadline = setTimeout(() => fail(new Error('動画の位置調整が時間内に完了しませんでした。もう一度お試しください。')), 8_000);
      video.addEventListener('seeking', onSeeking);
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('playing', onAbort);
      video.addEventListener('loadeddata', ready);
      video.addEventListener('canplay', ready);
      video.addEventListener('error', onError);
      video.addEventListener('emptied', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.assertCurrent();
        // Register before assigning currentTime, otherwise Safari may miss the frame.
        if (hasFrames) frameId = video.requestVideoFrameCallback(onFrame);
        issuedAt = performance.now();
        issued = true;
        if (needsSeek) video.currentTime = time;
        ready();
      } catch (error) {
        fail(error);
      }
    });
  }

  private encode(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.video.removeEventListener('seeking', cancel);
        this.video.removeEventListener('playing', cancel);
        this.video.removeEventListener('emptied', cancel);
      };
      const fail = (reason: unknown) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(reason);
      };
      const cancel = () => fail(aborted());
      const timer = setTimeout(() => fail(new Error('静止画の作成が時間内に完了しませんでした。もう一度お試しください。')), 5_000);
      signal.addEventListener('abort', cancel, { once: true });
      this.video.addEventListener('seeking', cancel, { once: true });
      this.video.addEventListener('playing', cancel, { once: true });
      this.video.addEventListener('emptied', cancel, { once: true });
      try {
        this.assertCurrent();
        canvas.toBlob((blob) => {
          if (finished) return;
          if (!blob || blob.size === 0 || blob.type !== 'image/jpeg') {
            fail(new Error('JPEG静止画を作成できませんでした。別の位置で再試行してください。'));
            return;
          }
          finished = true;
          cleanup();
          resolve(blob);
        }, 'image/jpeg', 0.85);
      } catch {
        fail(new Error('静止画を作成できませんでした。この動画で再試行するか、別の動画を選んでください。'));
      }
    });
  }
}
