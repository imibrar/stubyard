// Walkthrough recording R2, video mode, in the extension: the shared helpers (shared/video.ts), the offscreen
// recorder (offscreen/videoRecorder.ts: MediaRecorder chunks in order, media time and step markers, pause, stop and
// the final chunk, retries, the cap), the service worker (background/videoSync.ts: start, the offscreen messaging,
// chunk upload, following the run, the end) and the page side (content/videoMode.ts) and the views' state.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { handleVideoChunk, handleVideoEnded, readSession, startVideo, stopVideo, syncVideo, VIDEO_ENDED_KEY, type VideoDeps, type VideoUploadBody } from '../src/background/videoSync';
import { type MediaRecorderLike, VideoRecorder, type VideoRecorderDeps } from '../src/offscreen/videoRecorder';
import { CONTENT_VERSION, type ContentRequest } from '../src/shared/protocol';
import { defaultSettings, type Settings } from '../src/shared/settings';
import {
  captureConstraints,
  captureSize,
  NOT_INVOKED_HELP,
  pickVideoMime,
  type ToOffscreen,
  VIDEO_BITS_PER_SECOND,
  VIDEO_FPS,
  VIDEO_MAX_QUEUE,
  VIDEO_SESSION_KEY,
  VIDEO_TIMESLICE_MS,
  type VideoChunkMessage,
  type VideoChunkReply,
  type VideoEndedMessage,
  type VideoSession,
  videoMinutesLeft,
} from '../src/shared/video';
import { noteSecretField, resetVideoMode, setVideoMode, VIDEO_DOTS_ATTR, videoModeOn } from '../src/content/videoMode';
import { recordingText, recordingUiState } from '../src/run/RecordingBar';
import { choiceRecording, defaultRecording, startBody } from '../src/sidepanel/state';

const APP = 'http://app.test:3000';

describe('shared helpers', () => {
  it('picks VP9, then VP8, then plain WebM', () => {
    expect(pickVideoMime(() => true)).toBe('video/webm;codecs=vp9');
    expect(pickVideoMime((t) => !t.includes('vp9'))).toBe('video/webm;codecs=vp8');
    expect(pickVideoMime(() => false)).toBe('video/webm');
  });

  it('scales the capture to 1280 px wide at most, keeping the aspect ratio (even sizes)', () => {
    expect(captureSize(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(captureSize(1280, 800)).toEqual({ width: 1280, height: 800 });
    expect(captureSize(390, 844)).toEqual({ width: 390, height: 844 });
    expect(captureSize(2561, 1441)).toEqual({ width: 1280, height: 720 });
    expect(captureSize(undefined, undefined)).toEqual({ width: 1280, height: 800 });
    const c = captureConstraints('sid', { width: 1280, height: 720 }) as unknown as { audio: boolean; video: { mandatory: Record<string, unknown> } };
    expect(c.audio).toBe(false);
    expect(c.video.mandatory).toEqual({ chromeMediaSource: 'tab', chromeMediaSourceId: 'sid', maxWidth: 1280, maxHeight: 720, maxFrameRate: VIDEO_FPS });
  });

  it('minutes left under the cap at 500 kbps: 50 MB is about 13 minutes', () => {
    expect(VIDEO_BITS_PER_SECOND).toBe(500_000);
    expect(videoMinutesLeft(0, 50 * 1024 * 1024)).toBe(13);
    expect(videoMinutesLeft(25 * 1024 * 1024, 50 * 1024 * 1024)).toBe(6);
    expect(videoMinutesLeft(60 * 1024 * 1024, 50 * 1024 * 1024)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The offscreen recorder with a fake MediaRecorder and a fake clock

class FakeRecorder implements MediaRecorderLike {
  static last: FakeRecorder | null = null;
  static supported = (t: string) => t !== 'video/webm;codecs=vp9-never';
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  timeslice = 0;
  constructor(
    public stream: MediaStream,
    public options: { mimeType: string; videoBitsPerSecond: number },
  ) {
    FakeRecorder.last = this;
  }
  static isTypeSupported(t: string) {
    return FakeRecorder.supported(t);
  }
  start(timeslice?: number) {
    this.state = 'recording';
    this.timeslice = timeslice ?? 0;
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.emit(3);
      this.onstop?.();
    });
  }
  emit(n: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(n).fill(7)]) });
  }
}

function fakeStream() {
  const ended: (() => void)[] = [];
  const stopped: string[] = [];
  const track = {
    kind: 'video',
    getSettings: () => ({ width: 1280, height: 720 }),
    addEventListener: (ev: string, fn: () => void) => ev === 'ended' && ended.push(fn),
    stop: () => stopped.push('video'),
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  return { stream, end: () => ended.forEach((f) => f()), stopped };
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('offscreen recorder', () => {
  let clock: number;
  let sent: (VideoChunkMessage | VideoEndedMessage)[];
  let reply: (m: VideoChunkMessage) => VideoChunkReply | Promise<VideoChunkReply>;
  let timers: { fn: () => void; ms: number }[];
  let s: ReturnType<typeof fakeStream>;
  let constraints: MediaStreamConstraints[];
  let deps: VideoRecorderDeps;
  const session = (o: Partial<VideoSession> = {}): VideoSession => ({ tabId: 5, windowId: 1, project: 'p', walkthroughId: 'w1', key: 'vk1', startedAt: new Date().toISOString(), url: APP + '/a', stepId: 's1', paused: false, ...o });

  beforeEach(() => {
    clock = 1000;
    sent = [];
    timers = [];
    constraints = [];
    s = fakeStream();
    reply = () => ({ ok: true, bytes: 100, maxBytes: 50 * 1024 * 1024, state: { mode: 'video', paused: false, stopped: null, currentStepId: 's1', status: 'active' } });
    deps = {
      getUserMedia: async (c) => {
        constraints.push(c);
        return s.stream;
      },
      MediaRecorder: FakeRecorder,
      send: async (m) => {
        sent.push(m);
        return m.type === 'video.chunk' ? reply(m) : undefined;
      },
      toBase64: async (b) => `b64:${b.size}`,
      now: () => clock,
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
    };
  });
  const chunks = () => sent.filter((m): m is VideoChunkMessage => m.type === 'video.chunk');

  it('begins: tab capture constraints, VP9 at 500 kbps, a chunk every 5 s; reports the size', async () => {
    const r = new VideoRecorder(deps);
    const b = await r.begin('stream-1', session(), { width: 1280, height: 720 });
    expect(b).toEqual({ ok: true, mime: 'video/webm;codecs=vp9', width: 1280, height: 720 });
    expect((constraints[0] as unknown as { video: { mandatory: { chromeMediaSourceId: string } } }).video.mandatory.chromeMediaSourceId).toBe('stream-1');
    expect(FakeRecorder.last!.options).toEqual({ mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 500_000 });
    expect(FakeRecorder.last!.timeslice).toBe(VIDEO_TIMESLICE_MS);
    expect(r.status()).toMatchObject({ recording: true, key: 'vk1', paused: false });
    expect(await r.begin('stream-2', session(), { width: 1, height: 1 })).toEqual({ ok: false, error: 'A video is being recorded already' });
  });

  it('getUserMedia failing is an error, not a recording', async () => {
    deps.getUserMedia = async () => {
      throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    };
    const r = new VideoRecorder(deps);
    expect(await r.begin('x', session(), { width: 1280, height: 720 })).toEqual({ ok: false, error: 'The tab could not be captured: NotAllowedError: Permission denied' });
    expect(r.recording).toBe(false);
  });

  it('uploads chunks one at a time in seq order, with media time and step markers (pauses left out)', async () => {
    let release: (() => void) | null = null;
    reply = () =>
      new Promise((res) => {
        release = () => res({ ok: true, bytes: 100, maxBytes: 50 * 1024 * 1024, state: { mode: 'video', paused: false, stopped: null, currentStepId: 's1', status: 'active' } });
      });
    const r = new VideoRecorder(deps);
    await r.begin('sid', session(), { width: 1280, height: 720 });
    const rec = FakeRecorder.last!;
    clock += 5000;
    rec.emit(100);
    clock += 1000;
    r.step('s2');
    clock += 1000;
    r.pause();
    clock += 60_000; // paused: not media time
    r.resume();
    clock += 3000;
    rec.emit(200);
    await flush();
    // Only the first is in flight: the second waits for it.
    expect(chunks().map((c) => c.seq)).toEqual([0]);
    release!();
    await flush();
    expect(chunks().map((c) => c.seq)).toEqual([0, 1]);
    const [a, b] = chunks();
    expect(a).toMatchObject({ key: 'vk1', data: 'b64:100', mime: 'video/webm;codecs=vp9', durationMs: 5000, markers: [{ at: 0, stepId: 's1' }], width: 1280, height: 720, final: false });
    expect(b).toMatchObject({ data: 'b64:200', durationMs: 10_000, markers: [{ at: 6000, stepId: 's2' }] });
    release!();
    await flush();
    // Repeated steps add no marker.
    r.step('s2');
    clock += 5000;
    rec.emit(50);
    await flush();
    release!();
    await flush();
    expect(chunks()[2].markers).toEqual([]);
  });

  it('stop: the last data is the final chunk, then video.ended; the tracks are stopped', async () => {
    const r = new VideoRecorder(deps);
    await r.begin('sid', session(), { width: 1280, height: 720 });
    clock += 5000;
    FakeRecorder.last!.emit(100);
    await flush();
    r.stop('The walkthrough ended');
    await flush();
    expect(chunks().map((c) => [c.seq, c.final, c.data])).toEqual([
      [0, false, 'b64:100'],
      [1, true, 'b64:3'],
    ]);
    expect(sent.at(-1)).toEqual({ type: 'video.ended', key: 'vk1', reason: 'The walkthrough ended' });
    expect(s.stopped).toEqual(['video']);
    expect(r.recording).toBe(false);
  });

  it('the tab closing (track ended) finishes the video the same way', async () => {
    const r = new VideoRecorder(deps);
    await r.begin('sid', session(), { width: 1280, height: 720 });
    s.end();
    await flush();
    expect(chunks().at(-1)?.final).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'video.ended', reason: 'The tab was closed or its capture ended' });
  });

  it('a stop answer (413 at the cap, 409 off) ends the recording; nothing more is sent', async () => {
    reply = () => ({ ok: false, error: 'Recording stopped: limit', stop: true, status: 413 });
    const r = new VideoRecorder(deps);
    await r.begin('sid', session(), { width: 1280, height: 720 });
    FakeRecorder.last!.emit(100);
    await flush();
    expect(r.stopReason).toBe('Recording stopped: limit');
    expect(chunks()).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ type: 'video.ended', reason: 'Recording stopped: limit' });
  });

  it('stops by itself near the cap, so the last partial chunk still fits', async () => {
    reply = () => ({ ok: true, bytes: 50 * 1024 * 1024 - 1000, maxBytes: 50 * 1024 * 1024, state: { mode: 'video', paused: false, stopped: null, currentStepId: 's1', status: 'active' } });
    const r = new VideoRecorder(deps);
    await r.begin('sid', session(), { width: 1280, height: 720 });
    FakeRecorder.last!.emit(100);
    await flush();
    expect(r.stopReason).toMatch(/size limit/);
    expect(chunks().at(-1)?.final).toBe(true);
    expect(sent.at(-1)?.type).toBe('video.ended');
  });

  it('a network failure retries the same chunk later (order kept); too many waiting chunks stop it', async () => {
    let fail = true;
    const ok: VideoChunkReply = { ok: true, bytes: 1, maxBytes: 50 * 1024 * 1024, state: { mode: 'video', paused: false, stopped: null, currentStepId: 's1', status: 'active' } };
    reply = () => (fail ? { ok: false, error: 'fetch failed', stop: false } : ok);
    const r = new VideoRecorder(deps);
    await r.begin('sid', session(), { width: 1280, height: 720 });
    FakeRecorder.last!.emit(100);
    await flush();
    expect(chunks().map((c) => c.seq)).toEqual([0]);
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    fail = false;
    timers.shift()!.fn();
    await flush();
    FakeRecorder.last!.emit(100);
    await flush();
    expect(chunks().map((c) => c.seq)).toEqual([0, 0, 1]);
    // Offline for long: the queue fills up and the video stops.
    fail = true;
    for (let i = 0; i <= VIDEO_MAX_QUEUE; i++) FakeRecorder.last!.emit(10);
    await flush();
    expect(r.stopReason).toMatch(/could not be reached/);
  });

  it('starts paused when the run is paused', async () => {
    const r = new VideoRecorder(deps);
    await r.begin('sid', session({ paused: true }), { width: 1280, height: 720 });
    expect(FakeRecorder.last!.state).toBe('paused');
    clock += 10_000;
    expect(r.mediaMs()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The service worker

const view = (o: Partial<WalkthroughView> & { rec?: Record<string, unknown> } = {}) =>
  ({
    id: 'w1',
    status: 'active',
    currentStepId: 's1',
    ...o,
    recording: { mode: 'video', requested: 'video', maskAllInputs: false, paused: false, stopped: null, stoppedAt: null, maskSelectors: [], segmentCount: 0, bytes: 0, maxBytes: 50 * 1024 * 1024, ...o.rec },
  }) as unknown as WalkthroughView;

describe('service worker (videoSync)', () => {
  let settings: Settings;
  let store: Record<string, unknown>;
  let w: WalkthroughView;
  let tabs: Record<number, { id: number; windowId: number; url: string; width?: number; height?: number }>;
  let off: ToOffscreen[];
  let offStatus: { recording: boolean; key: string | null } | null;
  let begin: { ok: boolean; mime?: string; width?: number; height?: number; error?: string };
  let streamErr: Error | null;
  let content: { tabId: number; msg: ContentRequest }[];
  let uploads: { apiUrl: string; project: string; id: string; body: VideoUploadBody }[];
  let uploadErr: (Error & { status?: number }) | null;
  let hubState: { mode: string; paused: boolean; stopped: string | null; currentStepId: string | null; status: string };
  let closed: number;
  let deps: VideoDeps;
  const OFF = 'chrome-extension://ext/offscreen.html';

  beforeEach(() => {
    settings = { ...defaultSettings(), apiUrl: 'http://hub:4000', activeWalkthroughByWindow: { '1': { project: 'p', id: 'w1', origins: [APP] } } };
    store = {};
    w = view();
    tabs = { 5: { id: 5, windowId: 1, url: APP + '/home', width: 1920, height: 1080 } };
    off = [];
    offStatus = null;
    begin = { ok: true, mime: 'video/webm;codecs=vp9', width: 1280, height: 720 };
    streamErr = null;
    content = [];
    uploads = [];
    uploadErr = null;
    hubState = { mode: 'video', paused: false, stopped: null, currentStepId: 's1', status: 'active' };
    closed = 0;
    deps = {
      loadSettings: async () => structuredClone(settings),
      getWalkthrough: async () => w,
      session: {
        get: async (k) => (k in store ? { [k]: structuredClone(store[k]) } : {}),
        set: async (items) => void Object.assign(store, structuredClone(items)),
        remove: async (k) => void delete store[k],
      },
      getTab: async (id) => tabs[id] ?? null,
      getStreamId: async (id) => {
        if (streamErr) throw streamErr;
        return `stream-${id}`;
      },
      ensureOffscreen: async () => {},
      closeOffscreen: async () => void closed++,
      toOffscreen: async (msg) => {
        off.push(msg);
        if (msg.type === 'video.begin') {
          if (begin.ok) offStatus = { recording: true, key: msg.session.key };
          return begin;
        }
        if (msg.type === 'video.status') return offStatus ? { ...offStatus, paused: false, seq: 0, durationMs: 0, queued: 0 } : undefined;
        return offStatus;
      },
      ping: async () => CONTENT_VERSION,
      inject: async () => {},
      send: async (tabId, msg) => void content.push({ tabId, msg }),
      upload: async (apiUrl, project, id, body) => {
        if (uploadErr) throw uploadErr;
        uploads.push({ apiUrl, project, id, body });
        return { bytes: 1000, maxBytes: 50 * 1024 * 1024, state: hubState };
      },
      offscreenUrl: OFF,
      now: () => new Date('2026-11-23T10:00:00Z'),
    };
  });
  const types = () => off.map((m) => m.type).filter((t) => t !== 'video.status');

  it('start: checks the run, gets a stream id, opens the recorder with the scaled tab size, saves the session, tells the page', async () => {
    expect(await startVideo(5, deps)).toEqual({ ok: true });
    const b = off.find((m) => m.type === 'video.begin') as Extract<ToOffscreen, { type: 'video.begin' }>;
    expect(b.streamId).toBe('stream-5');
    expect(b.size).toEqual({ width: 1280, height: 720 });
    expect(b.session).toMatchObject({ tabId: 5, windowId: 1, project: 'p', walkthroughId: 'w1', url: APP + '/home', stepId: 's1', paused: false, startedAt: '2026-11-23T10:00:00.000Z' });
    expect(b.session.key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(await readSession(deps)).toMatchObject({ key: b.session.key, mime: 'video/webm;codecs=vp9', width: 1280, height: 720 });
    expect(content).toEqual([{ tabId: 5, msg: { type: 'recording.video', on: true } }]);
    // Again for the same tab and run: already running.
    expect(await startVideo(5, deps)).toEqual({ ok: true, already: true });
  });

  it('start refuses: no run in the window, a run that does not record video, an ended or stopped one, another tab', async () => {
    tabs[6] = { id: 6, windowId: 2, url: APP };
    expect(await startVideo(6, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/No walkthrough is open/) });
    expect(await startVideo(99, deps)).toMatchObject({ ok: false });
    w = view({ rec: { mode: 'dom' } });
    expect(await startVideo(5, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/does not record video/) });
    w = view({ status: 'finished' as never });
    expect(await startVideo(5, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/ended/) });
    w = view({ rec: { stopped: 'Recording stopped: limit' } });
    expect(await startVideo(5, deps)).toEqual({ ok: false, error: 'Recording stopped: limit' });
    w = view();
    expect((await startVideo(5, deps)).ok).toBe(true);
    tabs[7] = { id: 7, windowId: 1, url: APP };
    expect(await startVideo(7, deps)).toMatchObject({ ok: false, error: expect.stringMatching(/Another tab/) });
  });

  it('start: Chrome refusing the capture (extension not invoked on the tab) explains what to do; nothing is left behind', async () => {
    streamErr = new Error('Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.');
    expect(await startVideo(5, deps)).toEqual({ ok: false, error: NOT_INVOKED_HELP });
    expect(await readSession(deps)).toBeNull();
    streamErr = null;
    begin = { ok: false, error: 'The tab could not be captured: NotAllowedError' };
    expect(await startVideo(5, deps)).toEqual({ ok: false, error: 'The tab could not be captured: NotAllowedError' });
    expect(await readSession(deps)).toBeNull();
    expect(closed).toBe(1);
  });

  it('a stale session (the recorder is gone) does not block a new start', async () => {
    store[VIDEO_SESSION_KEY] = { tabId: 7, windowId: 1, project: 'p', walkthroughId: 'w0', key: 'old', startedAt: '', url: '', stepId: null, paused: false };
    expect(await startVideo(5, deps)).toEqual({ ok: true });
  });

  it('starts paused (origin) when the tab shows a page outside the run', async () => {
    tabs[5].url = 'https://accounts.example.com/login';
    expect(await startVideo(5, deps)).toEqual({ ok: true });
    expect(await readSession(deps)).toMatchObject({ paused: true, pausedFor: 'origin' });
    expect(content).toEqual([]);
  });

  it('chunks: only from the offscreen document and the running key; uploaded as kind video with the segment', async () => {
    await startVideo(5, deps);
    const s = (await readSession(deps))!;
    const msg: VideoChunkMessage = { type: 'video.chunk', key: s.key, seq: 0, data: 'AAAA', mime: 'video/webm;codecs=vp9', durationMs: 5000, markers: [{ at: 0, stepId: 's1' }], width: 1280, height: 720, final: false };
    expect(await handleVideoChunk(msg, { url: 'https://evil.test/' }, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleVideoChunk({ ...msg, key: 'other' }, { url: OFF }, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleVideoChunk(msg, { url: OFF }, deps)).toEqual({ ok: true, bytes: 1000, maxBytes: 50 * 1024 * 1024, state: hubState });
    expect(uploads[0]).toEqual({
      apiUrl: 'http://hub:4000',
      project: 'p',
      id: 'w1',
      body: { kind: 'video', segment: { key: s.key, url: APP + '/home', startedAt: s.startedAt, stepId: 's1' }, seq: 0, data: 'AAAA', mime: 'video/webm;codecs=vp9', durationMs: 5000, markers: [{ at: 0, stepId: 's1' }], width: 1280, height: 720, final: false },
    });
    uploadErr = Object.assign(new Error('limit'), { status: 413 });
    expect(await handleVideoChunk(msg, { url: OFF }, deps)).toEqual({ ok: false, error: 'limit', stop: true, status: 413 });
    uploadErr = new Error('fetch failed');
    expect(await handleVideoChunk(msg, { url: OFF }, deps)).toMatchObject({ ok: false, stop: false });
  });

  it('chunk replies carry the hub state: a pause, a step change and the run ending reach the recorder', async () => {
    await startVideo(5, deps);
    const s = (await readSession(deps))!;
    const msg: VideoChunkMessage = { type: 'video.chunk', key: s.key, seq: 1, data: '', mime: 'video/webm', durationMs: 1, markers: [], final: false };
    hubState = { ...hubState, paused: true, currentStepId: 's2' };
    await handleVideoChunk(msg, { url: OFF }, deps);
    await flush();
    expect(types()).toEqual(['video.begin', 'video.pause', 'video.step']);
    expect(await readSession(deps)).toMatchObject({ paused: true, pausedFor: 'run', stepId: 's2' });
    hubState = { ...hubState, paused: false, status: 'finished' };
    await handleVideoChunk({ ...msg, seq: 2 }, { url: OFF }, deps);
    await flush();
    expect(off.at(-1)).toEqual({ target: 'offscreen', type: 'video.stop', reason: 'The walkthrough ended' });
  });

  it('sync: follows pause / resume, pauses on another site and resumes back, stops when mode or run changes', async () => {
    await startVideo(5, deps);
    w = view({ rec: { paused: true } });
    expect(await syncVideo(deps)).toBe('paused');
    w = view();
    expect(await syncVideo(deps)).toBe('recording');
    expect(types()).toEqual(['video.begin', 'video.pause', 'video.resume']);
    // Another site in the tab: paused, the page is not told video is on there.
    tabs[5].url = 'https://mail.example.com/';
    content = [];
    expect(await syncVideo(deps, 5)).toBe('paused');
    expect(await readSession(deps)).toMatchObject({ pausedFor: 'origin' });
    expect(content).toEqual([]);
    tabs[5].url = APP + '/next';
    expect(await syncVideo(deps, 5)).toBe('recording');
    expect(content).toEqual([{ tabId: 5, msg: { type: 'recording.video', on: true } }]);
    // Other tabs' events are ignored.
    expect(await syncVideo(deps, 9)).toBe('none');
    w = view({ rec: { mode: 'dom' } });
    expect(await syncVideo(deps)).toBe('stopped');
    expect(off.at(-1)).toMatchObject({ type: 'video.stop', reason: expect.stringMatching(/switched off/) });
  });

  it('sync: the tab closed, the run closed in the window, or the recorder gone ends it', async () => {
    await startVideo(5, deps);
    settings.activeWalkthroughByWindow = {};
    expect(await syncVideo(deps)).toBe('stopped');
    expect(off.at(-1)).toMatchObject({ type: 'video.stop', reason: 'The run was closed in this window' });
    // The recorder has gone without saying so: the session is cleared here.
    settings.activeWalkthroughByWindow = { '1': { project: 'p', id: 'w1', origins: [APP] } };
    offStatus = null;
    expect(await syncVideo(deps)).toBe('stopped');
    expect(await readSession(deps)).toBeNull();
    expect(store[VIDEO_ENDED_KEY]).toMatchObject({ walkthroughId: 'w1', reason: 'The recorder stopped' });
    expect(content.at(-1)).toEqual({ tabId: 5, msg: { type: 'recording.video', on: false } });
  });

  it('video.ended: clears the session, keeps the reason, closes the offscreen document, tells the page', async () => {
    await startVideo(5, deps);
    const s = (await readSession(deps))!;
    await handleVideoEnded({ type: 'video.ended', key: s.key, reason: 'Recording stopped: limit' }, { url: 'https://evil.test/' }, deps);
    expect(await readSession(deps)).not.toBeNull();
    await handleVideoEnded({ type: 'video.ended', key: s.key, reason: 'Recording stopped: limit' }, { url: OFF }, deps);
    expect(await readSession(deps)).toBeNull();
    expect(store[VIDEO_ENDED_KEY]).toEqual({ walkthroughId: 'w1', reason: 'Recording stopped: limit', at: '2026-11-23T10:00:00.000Z' });
    expect(closed).toBe(1);
    expect(content.at(-1)).toEqual({ tabId: 5, msg: { type: 'recording.video', on: false } });
    // stopVideo with nothing running: nothing happens.
    await stopVideo('x', deps);
    expect(closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The page: dots over the extension's secret fills, the widget folded

describe('content: video mode', () => {
  afterEach(() => resetVideoMode());
  const widget = (collapsed: boolean | null) => {
    const calls: boolean[] = [];
    let state = collapsed;
    return {
      calls,
      w: {
        isCollapsed: () => state,
        toggle: (c: boolean) => {
          calls.push(c);
          state = c;
          return { ok: true as const, mounted: state !== null, collapsed: c };
        },
      },
    };
  };

  // happy-dom drops -webkit-text-security, so the style calls are watched (Chrome applies them: recording2.py).
  const watch = (el: HTMLElement) => {
    const calls: string[] = [];
    const set = el.style.setProperty.bind(el.style);
    const rm = el.style.removeProperty.bind(el.style);
    el.style.setProperty = (p: string, v: string | null, pr?: string) => (calls.push(`set ${p} ${v} ${pr ?? ''}`.trim()), set(p, v, pr));
    el.style.removeProperty = (p: string) => (calls.push(`remove ${p}`), rm(p));
    return calls;
  };

  it('a secret fill during video shows dots before the value lands; off restores the field', () => {
    document.body.innerHTML = '<input id="code" name="code"><input id="pw" type="password">';
    const code = document.getElementById('code') as HTMLInputElement;
    const pw = document.getElementById('pw') as HTMLInputElement;
    const cc = watch(code);
    const wd = widget(false);
    expect(setVideoMode(true, wd.w)).toEqual({ ok: true, on: true, hidden: 0 });
    expect(videoModeOn()).toBe(true);
    noteSecretField(code);
    expect(cc).toEqual(['set -webkit-text-security disc important']);
    expect(code.hasAttribute(VIDEO_DOTS_ATTR)).toBe(true);
    noteSecretField(pw);
    expect(setVideoMode(true, wd.w).hidden).toBe(2);
    expect(setVideoMode(false, wd.w)).toEqual({ ok: true, on: false, hidden: 0 });
    expect(cc.at(-1)).toBe('remove -webkit-text-security');
    expect(code.hasAttribute(VIDEO_DOTS_ATTR) || pw.hasAttribute(VIDEO_DOTS_ATTR)).toBe(false);
  });

  it('fields filled before video started get dots when it starts', () => {
    document.body.innerHTML = '<input id="otp">';
    const otp = document.getElementById('otp') as HTMLInputElement;
    noteSecretField(otp);
    expect(otp.hasAttribute(VIDEO_DOTS_ATTR)).toBe(false);
    expect(setVideoMode(true, widget(null).w).hidden).toBe(1);
    expect(otp.hasAttribute(VIDEO_DOTS_ATTR)).toBe(true);
  });

  it('the widget folds to its pill while video is on and opens again after, only if video folded it', () => {
    const open = widget(false);
    setVideoMode(true, open.w);
    setVideoMode(true, open.w); // idempotent
    setVideoMode(false, open.w);
    expect(open.calls).toEqual([true, false]);
    const folded = widget(true);
    setVideoMode(true, folded.w);
    setVideoMode(false, folded.w);
    expect(folded.calls).toEqual([]);
    const none = widget(null);
    expect(setVideoMode(true, none.w).on).toBe(true);
    expect(none.calls).toEqual([]);
  });
});

describe('views', () => {
  const s = (o: Partial<VideoSession> = {}): VideoSession => ({ tabId: 5, windowId: 1, project: 'p', walkthroughId: 'w1', key: 'k', startedAt: '', url: '', stepId: null, paused: false, ...o });
  it('video state: idle without a capture, on / paused with one, stopped, off', () => {
    expect(recordingUiState(view())).toBe('idle');
    expect(recordingUiState(view(), s())).toBe('on');
    expect(recordingUiState(view(), s({ paused: true, pausedFor: 'origin' }))).toBe('paused');
    expect(recordingUiState(view({ rec: { paused: true } }), s())).toBe('paused');
    expect(recordingUiState(view({ rec: { stopped: 'cap' } }), s())).toBe('stopped');
    expect(recordingUiState(view({ status: 'finished' as never }), s())).toBe('off');
  });

  it('video text: minutes left under the cap, why it is paused, the last end reason', () => {
    expect(recordingText(view(), 'on', false, s(), null)).toBe('Recording a video of this tab · at least 13 min left of 50 MB.');
    expect(recordingText(view({ rec: { bytes: 40 * 1024 * 1024 } }), 'on', true, s(), null)).toBe('Recording video · ≥2 min left');
    expect(recordingText(view(), 'paused', false, s({ paused: true, pausedFor: 'origin' }), null)).toMatch(/outside the run/);
    expect(recordingText(view({ rec: { paused: true } }), 'paused', true, s(), null)).toBe('Video paused');
    expect(recordingText(view(), 'idle', false, null, { walkthroughId: 'w1', reason: 'The tab was closed', at: '' })).toBe('Video recording is on for this run but not running (The tab was closed).');
  });

  it('Start screen: video as a choice and as the storyboard default', () => {
    expect(defaultRecording('video', 'tracked')).toBe('video');
    expect(defaultRecording('video', 'quick')).toBe('off');
    expect(choiceRecording('default', 'video', 'tracked')).toBe('video');
    expect(choiceRecording('video', 'off', 'tracked')).toBe('video');
    expect(choiceRecording('dom', 'video', 'tracked')).toBe('dom');
    const base = { storyboard: 's', origin: '', label: '', vars: {}, actors: {}, mode: 'tracked' as const };
    expect(startBody({ ...base, record: 'video' })).toMatchObject({ record: 'video' });
  });
});
