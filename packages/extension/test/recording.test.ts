// Walkthrough recording R1 in the extension: the masking rules and rrweb options (shared/recording.ts), the recorder's
// chunks, flushes, segments per page load and pause (content/recorder.ts, with a fake rrweb and fake timers), the
// content request wiring, and the service worker's sync and chunk relay (background/recordingSync.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalkthroughView } from '@stubyard/client/storyboard-types';
import { handleRecordingChunk, recordingConfig, type RecordingDeps, syncRecordingTab, syncRecordingTabs } from '../src/background/recordingSync';
import { Recorder, type RecorderDeps, type RrwebRecord } from '../src/content/recorder';
import { CONTENT_VERSION, type ContentRequest } from '../src/shared/protocol';
import { FLUSH_EVENTS, FLUSH_MS, isSensitiveInput, RECORD_BLOCK_SELECTOR, type RecordingChunkMessage, type RecordingChunkReply, type RecordingConfig, recordOptions, STEP_EVENT_TAG } from '../src/shared/recording';
import { defaultSettings, type Settings } from '../src/shared/settings';
import { recordingUiState } from '../src/run/RecordingBar';
import { defaultRecording, startBody } from '../src/sidepanel/state';

const el = (html: string) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
};

describe('masking', () => {
  it('always masks passwords, one-time codes, card fields and OTP-looking names', () => {
    for (const html of [
      '<input type="password">',
      '<input type="text" data-rr-is-password>',
      '<input autocomplete="one-time-code">',
      '<input autocomplete="cc-number">',
      '<input name="totp">',
      '<input id="mfaCode">',
      '<input name="otp_code">',
      '<input placeholder="2FA code">',
      '<input name="verification-code">',
      '<input name="cvv">',
    ])
      expect(isSensitiveInput(el(html), []), html).toBe(true);
    for (const html of ['<input type="text" name="email">', '<input name="topic">', '<input name="description">', '<input name="shipping">', '<textarea name="notes"></textarea>'])
      expect(isSensitiveInput(el(html), []), html).toBe(false);
  });

  it('masks the run selectors (the 2FA field of the login recipe) and fields stubyard filled as secrets', () => {
    expect(isSensitiveInput(el('<input id="code-box">'), ['#code-box'])).toBe(true);
    expect(isSensitiveInput(el('<input id="x">'), ['##bad', '#x'])).toBe(true); // an invalid selector is skipped
    const plain = el('<input id="plain">');
    const marked = new WeakSet<Element>([plain]);
    expect(isSensitiveInput(plain, [], marked)).toBe(true);
    expect(isSensitiveInput(plain, [])).toBe(false);
  });

  it('builds the rrweb options: widget blocked, sampling, per-element mask, maskAllInputs', () => {
    const o = recordOptions({ maskAllInputs: false, maskSelectors: ['#code'] });
    expect(o.blockSelector).toBe(RECORD_BLOCK_SELECTOR);
    expect(o.blockSelector).toContain('[data-stubyard-widget]');
    expect(o.sampling).toMatchObject({ mousemove: 50, scroll: 150, input: 'last' });
    expect(o.recordCanvas).toBe(false);
    expect(o.maskAllInputs).toBe(false);
    expect(o.maskInputOptions.text && o.maskInputOptions.email && o.maskInputOptions.password).toBe(true);
    expect(o.maskInputFn('alice@example.com', el('<input type="email">') as HTMLElement)).toBe('alice@example.com');
    expect(o.maskInputFn('s3cret', el('<input type="password">') as HTMLElement)).toBe('******');
    expect(o.maskInputFn('123456', el('<input id="code">') as HTMLElement)).toBe('******');
    const all = recordOptions({ maskAllInputs: true, maskSelectors: [] });
    expect(all.maskAllInputs).toBe(true);
    expect(all.maskInputFn('alice', el('<input type="text">') as HTMLElement)).toBe('*****');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The recorder

interface FakeRrweb extends RrwebRecord {
  starts: Record<string, unknown>[];
  stops: number;
  emit: ((e: unknown) => void) | null;
  custom: { tag: string; payload: unknown }[];
}
function fakeRrweb(): FakeRrweb {
  const f = ((opts: Record<string, unknown> & { emit: (e: unknown) => void }) => {
    f.starts.push(opts);
    f.emit = opts.emit;
    opts.emit({ type: 4, timestamp: 1, data: { href: 'x' } }); // Meta
    opts.emit({ type: 2, timestamp: 1, data: {} }); // FullSnapshot
    return () => {
      f.stops++;
      f.emit = null;
    };
  }) as FakeRrweb;
  f.starts = [];
  f.stops = 0;
  f.emit = null;
  f.custom = [];
  f.addCustomEvent = (tag, payload) => {
    f.custom.push({ tag, payload });
    f.emit?.({ type: 5, timestamp: 2, data: { tag, payload } });
  };
  return f;
}

const CFG: RecordingConfig = { project: 'p', walkthroughId: 'w1', stepId: 's1', paused: false, maskAllInputs: false, maskSelectors: [] };
const okReply = (o: Partial<Extract<RecordingChunkReply, { ok: true }>['state']> = {}): RecordingChunkReply => ({
  ok: true,
  state: { mode: 'dom', paused: false, stopped: null, currentStepId: 's1', status: 'active', ...o },
});

let rr: FakeRrweb;
let chunks: RecordingChunkMessage[];
let reply: (m: RecordingChunkMessage) => RecordingChunkReply | undefined;
let rec: Recorder;
let keys: number;
let stops: string[];

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useRealTimers();
  rr = fakeRrweb();
  chunks = [];
  reply = () => okReply();
  keys = 0;
  stops = [];
  const deps: RecorderDeps = {
    record: rr,
    send: async (m) => {
      chunks.push(structuredClone(m));
      return reply(m);
    },
    win: window,
    newKey: () => `seg${++keys}`,
    onStop: (r) => stops.push(r),
  };
  rec = new Recorder(deps);
});

describe('recorder', () => {
  afterEach(() => rec.stop()); // its page listeners go with it
  it('starts one segment with a step marker, flushes every 5 s, and sends a final chunk on stop', async () => {
    vi.useFakeTimers();
    expect(rec.apply(CFG)).toEqual({ recording: true });
    expect(rr.starts).toHaveLength(1);
    expect(rr.starts[0]).toMatchObject({ blockSelector: RECORD_BLOCK_SELECTOR });
    expect(rr.custom).toEqual([{ tag: STEP_EVENT_TAG, payload: { stepId: 's1' } }]);
    expect(chunks).toHaveLength(0);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'recording.chunk', project: 'p', walkthroughId: 'w1', seq: 0, final: false, segment: { key: 'seg1', stepId: 's1', url: location.href } });
    expect(chunks[0].events).toHaveLength(3); // meta, snapshot, step marker
    vi.advanceTimersByTime(FLUSH_MS); // nothing new: nothing sent
    expect(chunks).toHaveLength(1);
    rr.emit!({ type: 3, timestamp: 3, data: {} });
    vi.advanceTimersByTime(FLUSH_MS);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    rec.stop();
    expect(rr.stops).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ seq: 2, final: true, events: [] });
    vi.advanceTimersByTime(FLUSH_MS * 3);
    expect(chunks).toHaveLength(3); // the timer is gone
  });

  it('sends early once a chunk holds FLUSH_EVENTS events', () => {
    rec.apply(CFG);
    for (let i = 0; i < FLUSH_EVENTS; i++) rr.emit!({ type: 3, timestamp: i, data: {} });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].events).toHaveLength(FLUSH_EVENTS);
  });

  it('is idempotent and turns step changes into markers in the same segment', () => {
    rec.apply(CFG);
    rec.apply(CFG);
    expect(rr.starts).toHaveLength(1);
    rec.apply({ ...CFG, stepId: 's2' });
    expect(rr.starts).toHaveLength(1);
    expect(rr.custom.map((c) => c.payload)).toEqual([{ stepId: 's1' }, { stepId: 's2' }]);
  });

  it('pause ends the segment (final chunk); resume starts a new one', () => {
    rec.apply(CFG);
    rec.apply({ ...CFG, paused: true });
    expect(rec.active).toBe(false);
    expect(rr.stops).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ final: true, segment: { key: 'seg1' } });
    rr.emit?.({ type: 3, timestamp: 9, data: {} }); // nothing records while paused
    rec.apply({ ...CFG, paused: false, stepId: 's3' });
    expect(rec.active).toBe(true);
    expect(rec.segmentKey).toBe('seg2');
    rec.flush();
    expect(chunks.at(-1)).toMatchObject({ seq: 0, segment: { key: 'seg2', stepId: 's3' } });
  });

  it('one segment per page load: pagehide sends the final chunk, a bfcache restore starts a new segment', () => {
    rec.apply(CFG);
    window.dispatchEvent(new Event('pagehide'));
    expect(rec.active).toBe(false);
    expect(chunks.at(-1)).toMatchObject({ final: true, segment: { key: 'seg1' } });
    const ev = new Event('pageshow') as Event & { persisted?: boolean };
    Object.defineProperty(ev, 'persisted', { value: true });
    window.dispatchEvent(ev);
    expect(rec.segmentKey).toBe('seg2');
    expect(rr.starts).toHaveLength(2);
  });

  it('flushes (not final) when the page is hidden', () => {
    rec.apply(CFG);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].final).toBe(false);
    expect(rec.active).toBe(true);
  });

  it('stops for good when the hub refuses (cap reached) and ignores later configs of that run', async () => {
    reply = () => ({ ok: false, error: 'Recording stopped: limit', stop: true, status: 413 });
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(false);
    expect(stops).toEqual(['Recording stopped: limit']);
    expect(rec.apply({ ...CFG, stepId: 's2' })).toEqual({ recording: false });
    expect(rr.starts).toHaveLength(1);
    // Another run records again.
    reply = () => okReply();
    expect(rec.apply({ ...CFG, walkthroughId: 'w2' })).toEqual({ recording: true });
  });

  it('keeps chunks that failed for a network reason and sends them again with the next flush', async () => {
    let fail = true;
    reply = () => (fail ? undefined : okReply());
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    fail = false;
    rr.emit!({ type: 3, timestamp: 5, data: {} });
    rec.flush();
    await flushAsync();
    expect(chunks.map((c) => c.seq)).toEqual([0, 0, 1]);
  });

  it('follows the hub state from a chunk reply: a pause made elsewhere, a step change', async () => {
    reply = () => okReply({ currentStepId: 's9' });
    rec.apply(CFG);
    rec.flush();
    await flushAsync();
    expect(rec.config?.stepId).toBe('s9');
    expect(rr.custom.at(-1)?.payload).toEqual({ stepId: 's9' });
    reply = () => okReply({ currentStepId: 's9', paused: true });
    rr.emit!({ type: 3, timestamp: 5, data: {} });
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(false);
    reply = () => okReply({ mode: 'off' });
    rec.apply({ ...CFG, stepId: 's9' });
    rec.flush();
    await flushAsync();
    expect(rec.active).toBe(false);
    expect(stops.at(-1)).toBe('recording is off');
  });

  it('a changed mask config starts a fresh segment with the new options', () => {
    rec.apply(CFG);
    rec.apply({ ...CFG, maskAllInputs: true });
    expect(rr.starts).toHaveLength(2);
    expect(rr.starts[1]).toMatchObject({ maskAllInputs: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The content requests

describe('content requests', () => {
  it('recording.start / recording.stop drive the page recorder; setValue secret marks the field', async () => {
    const { installContent, handleRequest, pageRecorder } = await import('../src/content/index');
    const rrc = fakeRrweb();
    const sent: unknown[] = [];
    const runtime = {
      onMessage: { addListener: () => {}, removeListener: () => {} },
      sendMessage: async (m: unknown) => {
        sent.push(m);
        return okReply();
      },
      getURL: (p: string) => `chrome-extension://x/${p}`,
      id: 'x',
    };
    const inst = installContent(window, runtime as never, `test-${Math.random()}`, undefined, undefined, { record: rrc });
    expect(inst).not.toBeNull();
    const r1 = await handleRequest({ type: 'recording.start', config: CFG } as ContentRequest);
    expect(r1).toMatchObject({ ok: true, recording: true });
    expect(rrc.starts).toHaveLength(1);
    document.body.innerHTML = '<input id="pw2" type="text">';
    await handleRequest({ type: 'setValue', selector: '#pw2', value: 'hunter2', secret: true } as ContentRequest);
    expect(pageRecorder()!.marked.has(document.getElementById('pw2')!)).toBe(true);
    const r2 = await handleRequest({ type: 'recording.stop' } as ContentRequest);
    expect(r2).toMatchObject({ ok: true, recording: false });
    await flushAsync();
    expect(sent.some((m) => (m as { type?: string }).type === 'recording.chunk')).toBe(true);
    inst!.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The service worker

const APP = 'http://localhost:3183';
const view = (o: Partial<WalkthroughView> & { rec?: Partial<NonNullable<WalkthroughView['recording']>> } = {}): WalkthroughView =>
  ({
    id: 'w1',
    status: 'active',
    currentStepId: 's1',
    ...o,
    recording: { mode: 'dom', requested: 'dom', maskAllInputs: false, paused: false, stopped: null, stoppedAt: null, maskSelectors: ['#totp'], segmentCount: 0, bytes: 0, maxBytes: 1, ...o.rec },
  }) as unknown as WalkthroughView;

describe('service worker', () => {
  let settings: Settings;
  let versions: Record<number, string | null>;
  let sent: { tabId: number; msg: ContentRequest }[];
  let injected: number[];
  let reads: number;
  let w: WalkthroughView;
  let deps: RecordingDeps;
  let uploads: unknown[];
  let uploadErr: (Error & { status?: number }) | null;

  beforeEach(() => {
    settings = { ...defaultSettings(), apiUrl: 'http://hub:4000', activeWalkthroughByWindow: { '1': { project: 'p', id: 'w1', origins: [APP] } } };
    versions = {};
    sent = [];
    injected = [];
    reads = 0;
    uploads = [];
    uploadErr = null;
    w = view();
    deps = {
      loadSettings: async () => structuredClone(settings),
      ping: async (id) => versions[id] ?? null,
      inject: async (id) => {
        injected.push(id);
        versions[id] = CONTENT_VERSION;
      },
      send: async (tabId, msg) => void sent.push({ tabId, msg }),
      getWalkthrough: async () => {
        reads++;
        return w;
      },
      upload: async (apiUrl, project, id, chunk) => {
        if (uploadErr) throw uploadErr;
        uploads.push({ apiUrl, project, id, chunk });
        return { state: { mode: 'dom', paused: false, stopped: null, currentStepId: 's1', status: 'active' } };
      },
    };
  });

  it('config: only active runs that record (dom, not stopped)', () => {
    const a = { project: 'p', id: 'w1' };
    expect(recordingConfig(a, view())).toEqual({ project: 'p', walkthroughId: 'w1', stepId: 's1', paused: false, maskAllInputs: false, maskSelectors: ['#totp'] });
    expect(recordingConfig(a, view({ rec: { mode: 'off' } }))).toBeNull();
    expect(recordingConfig(a, view({ rec: { stopped: 'cap' } }))).toBeNull();
    expect(recordingConfig(a, view({ status: 'passed' as never }))).toBeNull();
    expect(recordingConfig(a, null)).toBeNull();
  });

  it('starts the recorder on app-origin tabs of the run window (injecting), stops it elsewhere, one hub read per pass', async () => {
    versions[3] = CONTENT_VERSION;
    versions[4] = CONTENT_VERSION;
    const r = await syncRecordingTabs(
      [
        { id: 2, windowId: 1, url: `${APP}/a` },
        { id: 3, windowId: 1, url: 'https://other.example/' },
        { id: 4, windowId: 9, url: `${APP}/b` },
        { id: 5, windowId: 9, url: `${APP}/c` },
      ],
      deps,
    );
    expect(r).toEqual(['recording', 'stopped', 'stopped', 'none']);
    expect(injected).toEqual([2]);
    expect(reads).toBe(1);
    expect(sent.find((s) => s.tabId === 2)?.msg).toMatchObject({ type: 'recording.start', config: { walkthroughId: 'w1', maskSelectors: ['#totp'] } });
    expect(sent.filter((s) => s.msg.type === 'recording.stop').map((s) => s.tabId)).toEqual([3, 4]);
  });

  it('stops when the run no longer records, and needs the run origins', async () => {
    versions[2] = CONTENT_VERSION;
    w = view({ rec: { mode: 'off' } });
    expect(await syncRecordingTab({ id: 2, windowId: 1, url: `${APP}/a` }, deps)).toBe('stopped');
    w = view();
    settings.activeWalkthroughByWindow['1'] = { project: 'p', id: 'w1' }; // an older panel: no origins
    expect(await syncRecordingTab({ id: 2, windowId: 1, url: `${APP}/a` }, deps)).toBe('stopped');
  });

  it('relays chunks only from the top frame of a run app page, with the settings hub URL', async () => {
    const msg: RecordingChunkMessage = { type: 'recording.chunk', project: 'p', walkthroughId: 'w1', segment: { key: 'k1', url: `${APP}/a`, startedAt: 'x', stepId: 's1' }, seq: 0, events: [{ type: 4, timestamp: 1 }], final: false };
    const top = { id: 'ext', tab: { id: 2, windowId: 1, url: `${APP}/a` }, frameId: 0, url: `${APP}/a` };
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: true, state: { mode: 'dom' } });
    expect(uploads).toEqual([{ apiUrl: 'http://hub:4000', project: 'p', id: 'w1', chunk: { segment: msg.segment, seq: 0, events: msg.events, final: false } }]);
    expect(await handleRecordingChunk(msg, { ...top, frameId: 3 }, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleRecordingChunk(msg, { ...top, url: 'https://evil.example/' }, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleRecordingChunk({ ...msg, walkthroughId: 'w2' }, top, deps)).toMatchObject({ ok: false, stop: true });
    expect(await handleRecordingChunk(msg, { ...top, tab: { ...top.tab, windowId: 9 } }, deps)).toMatchObject({ ok: false, stop: true });
    expect(uploads).toHaveLength(1);
    uploadErr = Object.assign(new Error('Recording stopped: limit'), { status: 413 });
    expect(await handleRecordingChunk(msg, top, deps)).toEqual({ ok: false, error: 'Recording stopped: limit', stop: true, status: 413 });
    uploadErr = new Error('fetch failed');
    expect(await handleRecordingChunk(msg, top, deps)).toMatchObject({ ok: false, stop: false });
  });
});

describe('views', () => {
  it('recording UI state and the Start screen choice', () => {
    expect(recordingUiState(view())).toBe('on');
    expect(recordingUiState(view({ rec: { paused: true } }))).toBe('paused');
    expect(recordingUiState(view({ rec: { stopped: 'cap' } }))).toBe('stopped');
    expect(recordingUiState(view({ rec: { mode: 'off' } }))).toBe('off');
    expect(recordingUiState(view({ status: 'passed' as never }))).toBe('off');
    expect(defaultRecording('dom', 'tracked')).toBe('dom');
    expect(defaultRecording('video', 'tracked')).toBe('video');
    expect(defaultRecording('dom', 'quick')).toBe('off');
    const base = { storyboard: 's', origin: '', label: '', vars: {}, actors: {}, mode: 'tracked' as const };
    expect(startBody(base)).not.toHaveProperty('record');
    expect(startBody({ ...base, record: 'default' })).not.toHaveProperty('record');
    expect(startBody({ ...base, record: 'off' })).toMatchObject({ record: 'off' });
  });
});
