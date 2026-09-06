import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_LABELS, DIRECTION_LABELS, DUMMY_DISCLAIMER, DUMMY_FOCUS, MAX_VIDEO_BYTES,
  SCENES, createSession, makeDummy, newId, validateSession, validateVideoMetadata,
  type Contact, type Direction, type Session,
} from './domain';

function completeSession(): Session {
  const session = createSession({ assetId: crypto.randomUUID(), fileName: 'swing.mov', durationSec: 4, width: 1920, height: 1080 });
  const shot = session.sets[0].shots[0];
  SCENES.forEach((scene, index) => {
    shot.scenes[scene] = {
      assetId: crypto.randomUUID(), requestedTimeSec: index, observedTimeSec: index + 0.01,
      timeBasis: 'video-frame-callback', width: 1280, height: 720,
    };
  });
  shot.selfReport = { contact: 'good', direction: 'center' };
  session.sets[0].analysisResult = makeDummy(shot.id);
  return session;
}

describe('Phase 0 record contract', () => {
  it('creates independent IDs, one set / one shot, and genuinely unselected inputs', () => {
    const video = { assetId: 'video-1', fileName: 'swing.mov', durationSec: 4, width: 1920, height: 1080 };
    const first = createSession(video);
    const second = createSession(video);
    expect(first.schemaVersion).toBe(1);
    expect(first.sets).toHaveLength(1);
    expect(first.sets[0].shots).toHaveLength(1);
    expect(first.sets[0].shots[0].selfReport).toEqual({ contact: null, direction: null });
    expect(first.sets[0].analysisResult).toBeNull();
    expect(new Set([first.id, first.sets[0].id, first.sets[0].shots[0].id, second.id, second.sets[0].id, second.sets[0].shots[0].id]).size).toBe(6);
    first.sets[0].shots[0].video.fileName = 'changed.mp4';
    expect(second.sets[0].shots[0].video.fileName).toBe('swing.mov');
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      const fallbackIds = [newId(), createSession(video).id, makeDummy('shot').id];
      expect(new Set(fallbackIds).size).toBe(3);
      for (const id of fallbackIds) expect(id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
    } finally { vi.unstubAllGlobals(); }
  });

  it('accepts all explicit self-report choices, but rejects null / invalid choices and extra sets or shots', () => {
    for (const contact of Object.keys(CONTACT_LABELS) as Contact[]) {
      for (const direction of Object.keys(DIRECTION_LABELS) as Direction[]) {
        const session = completeSession();
        session.sets[0].shots[0].selfReport = { contact, direction };
        expect(validateSession(session), `${contact} / ${direction}`).toEqual([]);
      }
    }
    for (const field of ['contact', 'direction'] as const) {
      const session = completeSession();
      session.sets[0].shots[0].selfReport[field] = null;
      expect(validateSession(session).join(), field).toContain('選んでください');
    }
    const session = completeSession();
    session.sets[0].shots[0].selfReport.contact = 'excellent' as Contact;
    expect(validateSession(session)).not.toEqual([]);
    for (const mutate of [
      (record: Session) => { record.sets = []; },
      (record: Session) => { record.sets.push(structuredClone(record.sets[0])); },
      (record: Session) => { record.sets[0].shots = []; },
      (record: Session) => { record.sets[0].shots.push(structuredClone(record.sets[0].shots[0])); },
    ]) {
      const record = completeSession();
      mutate(record);
      expect(validateSession(record).join()).toContain('1セット・1球');
    }
  });

  it('always produces one fixed dummy exercise without claiming analysis', () => {
    const a = makeDummy('shot-a');
    const b = makeDummy('shot-b');
    expect(a.id).not.toBe(b.id);
    expect(a.inputShotIds).toEqual(['shot-a']);
    expect(b.inputShotIds).toEqual(['shot-b']);
    expect(a.nextFocus).toBe(DUMMY_FOCUS);
    expect(b.nextFocus).toBe(a.nextFocus);
    expect(a.disclaimer).toBe(DUMMY_DISCLAIMER);
    expect(a.analyzed).toBe(false);
    expect(a.kind).toBe('dummy');
    const session = completeSession();
    session.sets[0].analysisResult = b;
    expect(validateSession(session).join()).toContain('動作確認用の見本');
  });
});

describe('video acceptance boundaries', () => {
  const metadata = { durationSec: 5, width: 1920, height: 1080, sizeBytes: 1024 };
  it('enforces all duration / byte / dimension boundaries, including 30 seconds and exactly 100 MiB', () => {
    for (const durationSec of [0, -1, NaN, Infinity, 30.001]) {
      expect(validateVideoMetadata({ ...metadata, durationSec }).join(), `duration ${durationSec}`).toContain('30秒以下');
    }
    for (const durationSec of [0.001, 5, 15, 30]) {
      expect(validateVideoMetadata({ ...metadata, durationSec }), `duration ${durationSec}`).toEqual([]);
    }
    for (const sizeBytes of [MAX_VIDEO_BYTES - 1, MAX_VIDEO_BYTES]) {
      expect(validateVideoMetadata({ ...metadata, sizeBytes }), `size ${sizeBytes}`).toEqual([]);
    }
    for (const sizeBytes of [0, -1, MAX_VIDEO_BYTES + 1, NaN, Infinity, 1.5]) {
      expect(validateVideoMetadata({ ...metadata, sizeBytes }).join(), `size ${sizeBytes}`).toContain('104857600');
    }
    for (const dimensions of [{ width: 0, height: 1080 }, { width: 1920, height: 0 }, { width: NaN, height: 1 }]) {
      expect(validateVideoMetadata({ ...metadata, ...dimensions }).join()).toContain('縦横');
    }
  });
});

describe('four scene timing and capture validation', () => {
  it('enforces four complete strictly increasing times inside the video, allowing zero and nearby distinct times', () => {
    for (const times of [
      [0, 0, 2, 3], [0, 2, 1, 3], [-0.1, 1, 2, 3], [0, 1, 2, 4],
      [0, 1, 2, 4.01], [0, 1, NaN, 3], [0, 1, 2, Infinity],
    ]) {
      const session = completeSession();
      SCENES.forEach((scene, index) => { session.sets[0].shots[0].scenes[scene]!.requestedTimeSec = times[index]; });
      expect(validateSession(session), `times ${times}`).not.toEqual([]);
    }
    for (const scene of SCENES) {
      const session = completeSession();
      delete session.sets[0].shots[0].scenes[scene];
      expect(validateSession(session).join(), scene).toContain('画像を指定');
    }
    const session = completeSession();
    const shot = session.sets[0].shots[0];
    shot.video.durationSec = 30;
    [0, 0.01, 0.02, 29.999].forEach((time, index) => { shot.scenes[SCENES[index]]!.requestedTimeSec = time; });
    expect(validateSession(session)).toEqual([]);
  });
  it('requires a valid observed time / clock basis and rejects oversized or upscaled frames', () => {
    const session = completeSession();
    const capture = session.sets[0].shots[0].scenes.address!;
    capture.observedTimeSec = NaN;
    expect(validateSession(session).join()).toContain('抽出時刻');
    capture.observedTimeSec = 0;
    capture.timeBasis = 'video-current-time';
    expect(validateSession(session)).toEqual([]);
    session.sets[0].shots[0].scenes.top!.width = 1281;
    expect(validateSession(session).join()).toContain('画像サイズ');
    session.sets[0].shots[0].scenes.top!.width = 1280;
    session.sets[0].shots[0].video.width = 640;
    expect(validateSession(session).join()).toContain('画像サイズ');
  });
});
