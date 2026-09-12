import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadVideo, MediaController, releaseVideo, validateVideoMetadata, validateVideoSize } from './media';
import { moveRequestedPosition } from './position';

class FakeVideo extends EventTarget {
  src = 'blob:original';
  duration = 5;
  videoWidth = 1920;
  videoHeight = 1080;
  readyState = 2;
  seeking = false;
  paused = true;
  preload = '';
  playsInline = false;
  muted = false;
  loadMode: 'ready' | 'metadata-only' | 'error' | 'silent' = 'ready';
  frameTime = 1.96;
  presentationTime: number | undefined;
  autoFrameNotifications = true;
  ignoreSeek = false;
  currentTimeQuantum = 0;
  seekAssignments: number[] = [];
  order: string[] = [];
  callbacks = new Map<number, VideoFrameRequestCallback>();
  nextFrame = 0;
  requestVideoFrameCallback: HTMLVideoElement['requestVideoFrameCallback'] | undefined;
  cancelVideoFrameCallback = (id: number) => { this.callbacks.delete(id); };
  private time = 0;

  get currentTime() { return this.currentTimeQuantum ? Math.floor(this.time / this.currentTimeQuantum) * this.currentTimeQuantum : this.time; }
  set currentTime(value: number) {
    this.order.push('seek');
    this.seekAssignments.push(value);
    if (this.ignoreSeek) return;
    this.time = value;
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
    setTimeout(() => {
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
      if (this.autoFrameNotifications) this.emitFrame();
    }, 0);
  }

  emitFrame() {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback(0, {
        mediaTime: this.frameTime,
        presentationTime: this.presentationTime ?? performance.now(),
      } as VideoFrameCallbackMetadata);
    }
  }

  enableFrames() {
    this.requestVideoFrameCallback = (callback) => {
      this.order.push('register-frame');
      const id = ++this.nextFrame;
      this.callbacks.set(id, callback);
      return id;
    };
  }

  pause() { this.paused = true; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  load() {
    this.readyState = 0;
    if (!this.src || this.loadMode === 'silent') return;
    setTimeout(() => {
      if (this.loadMode === 'error') { this.dispatchEvent(new Event('error')); return; }
      this.readyState = 1;
      this.dispatchEvent(new Event('loadedmetadata'));
      if (this.loadMode === 'metadata-only') return;
      this.readyState = 2;
      this.dispatchEvent(new Event('loadeddata'));
    }, 0);
  }

  element() { return this as unknown as HTMLVideoElement; }
}

describe('video bounds and lifecycle (stubbed metadata; not a codec compatibility test)', () => {
  let nextUrl = 0;
  const revoke = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    revoke.mockClear();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:test-${++nextUrl}`), revokeObjectURL: revoke });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('accepts the exact 100 MiB boundary and rejects empty or larger input before creating a URL', async () => {
    for (const size of [104_857_599, 104_857_600]) expect(() => validateVideoSize(size)).not.toThrow();
    for (const size of [0, -1, NaN, Infinity, 104_857_601]) expect(() => validateVideoSize(size)).toThrow();
    await expect(loadVideo(new FakeVideo().element(), new Blob())).rejects.toThrow('空');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('requires finite, positive duration/dimensions and accepts 30 seconds', () => {
    expect(() => validateVideoMetadata(30, 1080, 1920)).not.toThrow();
    for (const duration of [0, -1, NaN, Infinity, 30.001]) {
      expect(() => validateVideoMetadata(duration, 1080, 1920)).toThrow();
    }
    for (const dimension of [0, -1, NaN, Infinity]) {
      expect(() => validateVideoMetadata(5, dimension, 1080)).toThrow();
      expect(() => validateVideoMetadata(5, 1080, dimension)).toThrow();
    }
  });

  it('does not reject empty MIME and waits for decoded image data', async () => {
    const video = new FakeVideo();
    const pending = loadVideo(video.element(), new Blob(['local-video']));
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    expect(result).toMatchObject({ durationSec: 5, width: 1920, height: 1080 });
    expect(video.paused).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    releaseVideo(video.element(), result.url);
    expect(video.src).toBe('');
    expect(revoke).toHaveBeenCalledWith(result.url);
  });

  it('rejects decode failure and metadata-only timeout, releasing failed URLs', async () => {
    for (const mode of ['error', 'metadata-only'] as const) {
      const video = new FakeVideo();
      video.loadMode = mode;
      const result = expect(loadVideo(video.element(), new Blob(['video']))).rejects.toThrow(
        mode === 'error' ? '読み込めません' : '時間内',
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(video.src).toBe('');
    }
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('aborts old loads and does not let late URL cleanup detach a replacement', async () => {
    const video = new FakeVideo();
    video.loadMode = 'silent';
    const abort = new AbortController();
    const oldResult = expect(loadVideo(video.element(), new Blob(['old']), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const oldUrl = video.src;
    abort.abort();
    await oldResult;
    video.loadMode = 'ready';
    const pending = loadVideo(video.element(), new Blob(['new']));
    await vi.advanceTimersByTimeAsync(0);
    const fresh = await pending;
    releaseVideo(video.element(), oldUrl);
    expect(video.src).toBe(fresh.url);
  });
});

describe('frame extraction and competing operations (video/canvas stubs)', () => {
  let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn>; toBlob: ReturnType<typeof vi.fn> };
  const jpeg = new Blob(['jpeg-fixture'], { type: 'image/jpeg' });
  beforeEach(() => {
    vi.useFakeTimers();
    canvas = {
      width: 0, height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toBlob: vi.fn((callback: BlobCallback) => callback(jpeg)),
    };
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('finishes paused same-time capture even when rVFC and seeked never fire; keeps portrait ratio', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.videoWidth = 1080;
    video.videoHeight = 1920;
    const capture = new MediaController(video.element()).capture(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(await capture).toMatchObject({ requestedTimeSec: 0, observedTimeSec: 0, timeBasis: 'video-current-time', width: 720, height: 1280 });
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85);
    expect(video.order).not.toContain('seek');
    expect(video.callbacks.size).toBe(0);
  });

  it('registers rVFC before seeking, records observed frame time, and rejects overlapping work', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    const media = new MediaController(video.element());
    const first = media.capture(2);
    await expect(media.seek(3)).rejects.toThrow('お待ちください');
    await expect(media.capture(4)).rejects.toThrow('お待ちください');
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({ requestedTimeSec: 2, observedTimeSec: 1.96, timeBasis: 'video-frame-callback', width: 1280, height: 720 });
    expect(video.order.slice(0, 2)).toEqual(['register-frame', 'seek']);
  });

  it('keeps a 0.01-second seek busy after seeked until a presented frame is observed', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.autoFrameNotifications = false;
    const media = new MediaController(video.element());
    let completed = false;
    const pending = media.seek(0.01).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(video.seekAssignments).toEqual([0.01]);
    expect(video.seeking).toBe(false);
    expect(completed).toBe(false);
    expect(video.order.slice(0, 2)).toEqual(['register-frame', 'seek']);
    await expect(media.seek(0.02)).rejects.toThrow('お待ちください');
    video.frameTime = 0;
    video.emitFrame();
    await pending;
    expect(completed).toBe(true);
    expect(video.callbacks.size).toBe(0);
  });

  it('accepts ten accumulated 0.01-second requests even when both observed times stay unchanged', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.currentTimeQuantum = 1;
    video.frameTime = 0;
    const media = new MediaController(video.element());
    let requested = 0;
    for (let index = 0; index < 10; index++) {
      requested = moveRequestedPosition(requested, 0.01, video.duration);
      const pending = media.seek(requested);
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(video.currentTime).toBe(0);
    }
    expect(requested).toBe(0.1);
    expect(video.seekAssignments).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1]);
    const capture = media.capture(requested);
    await vi.advanceTimersByTimeAsync(500);
    expect(await capture).toMatchObject({ requestedTimeSec: 0.1, observedTimeSec: 0 });
  });

  it('finishes a paused fine seek through the finite paint fallback when rVFC never arrives', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.autoFrameNotifications = false;
    const pending = new MediaController(video.element()).seek(0.01);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBeUndefined();
    expect(video.seekAssignments).toEqual([0.01]);
    expect(video.callbacks.size).toBe(0);
  });

  it('does not label an old image with a new request when the setter never completes a seek', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.ignoreSeek = true;
    video.frameTime = 0;
    const failed = expect(new MediaController(video.element()).capture(0.01)).rejects.toThrow('時間内');
    // An unrelated presented notification is not proof that the requested seek happened.
    video.emitFrame();
    await vi.advanceTimersByTimeAsync(8_000);
    await failed;
    expect(canvas.toBlob).not.toHaveBeenCalled();
    expect(video.callbacks.size).toBe(0);
  });

  it('rejects a replaced controller and ignores its late rVFC while the replacement is seeking', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.autoFrameNotifications = false;
    const original = new MediaController(video.element());
    const oldResult = expect(original.seek(0.01)).rejects.toMatchObject({ name: 'AbortError' });
    const oldCallback = [...video.callbacks.values()][0];
    await vi.advanceTimersByTimeAsync(0);
    original.dispose();
    await oldResult;
    video.src = 'blob:replacement';
    const replacement = new MediaController(video.element());
    let completed = false;
    const fresh = replacement.seek(0.02).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    oldCallback(0, { mediaTime: 0.01, presentationTime: performance.now() } as VideoFrameCallbackMetadata);
    await Promise.resolve();
    expect(completed).toBe(false);
    video.frameTime = 0.02;
    video.emitFrame();
    await fresh;
    expect(completed).toBe(true);
  });

  it('supports missing rVFC without upscaling and rejects endpoint capture', async () => {
    const video = new FakeVideo();
    video.videoWidth = 320;
    video.videoHeight = 180;
    const media = new MediaController(video.element());
    await expect(media.capture(5)).rejects.toThrow('終端');
    const result = media.capture(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toMatchObject({ timeBasis: 'video-current-time', width: 320, height: 180 });
  });

  it('ignores an old queued rVFC even if currentTime already matches the new seek', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.frameTime = 0;
    video.presentationTime = -1;
    const result = new MediaController(video.element()).capture(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ observedTimeSec: 2, timeBasis: 'video-current-time' });
    expect(video.callbacks.size).toBe(0);
  });

  it('discards an in-flight encode after disposal, even when its callback eventually succeeds', async () => {
    let encodeCallback: BlobCallback | undefined;
    canvas.toBlob.mockImplementation((callback: BlobCallback) => { encodeCallback = callback; });
    const video = new FakeVideo();
    video.enableFrames();
    const media = new MediaController(video.element());
    const result = expect(media.capture(2)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(encodeCallback).toBeTypeOf('function');
    media.dispose();
    encodeCallback?.(jpeg);
    await result;
    await expect(media.seek(1)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports JPEG null failure and permits a subsequent successful retry', async () => {
    const video = new FakeVideo();
    const media = new MediaController(video.element());
    canvas.toBlob.mockImplementationOnce((callback: BlobCallback) => callback(null));
    const failed = expect(media.capture(0)).rejects.toThrow('JPEG静止画');
    await vi.advanceTimersByTimeAsync(200);
    await failed;
    const retried = media.capture(0);
    await vi.advanceTimersByTimeAsync(200);
    expect((await retried).blob).toBe(jpeg);
  });

  it('aborts only the capture request during encoding and keeps the controller usable for a new request', async () => {
    let oldCallback: BlobCallback | undefined;
    canvas.toBlob.mockImplementationOnce((callback: BlobCallback) => { oldCallback = callback; });
    const video = new FakeVideo();
    const media = new MediaController(video.element());
    const abort = new AbortController();
    const pending = expect(media.capture(0, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(200);
    expect(oldCallback).toBeTypeOf('function');
    abort.abort();
    await pending;
    const next = media.capture(1);
    oldCallback!(jpeg);
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toMatchObject({ requestedTimeSec: 1, blob: jpeg });
  });

  it('aborts an in-flight capture seek without waiting for its frame timeout', async () => {
    const video = new FakeVideo();
    video.enableFrames();
    video.autoFrameNotifications = false;
    const media = new MediaController(video.element());
    const abort = new AbortController();
    const result = expect(media.capture(1, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await result;
    expect(video.callbacks.size).toBe(0);
    const next = media.capture(2);
    await vi.advanceTimersByTimeAsync(500);
    expect((await next).requestedTimeSec).toBe(2);
  });
});
