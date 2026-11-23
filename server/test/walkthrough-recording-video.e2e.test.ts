import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Hub } from '../src/hub.js';
import { parseRange } from '../src/http/routes/walkthroughs.js';
import { startHub, type RunningHub } from '../src/index.js';
import { META_SEQ, webmSetDuration } from '../src/storyboards/recordings.js';

/**
 * Walkthrough recording R2, video mode (storyboards/recordings.ts): WebM chunks through the chunk endpoint (kind
 * 'video', base64), the metadata row (mime, duration, step markers), the WebM Duration fix, the file served with its
 * Content-Type and Range support (206 / 416), mode handling (a video run refuses DOM chunks and the other way round,
 * a switch keeps both kinds), the size cap stop, and delete. The real MediaRecorder output is checked by the headless
 * Chrome harness (packages/extension/test/widget-spike/recording2.py).
 */

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

let running: RunningHub;
let hub: Hub;
let base: string;
let dataDir: string;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers; raw: Buffer }> {
  const r = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = Buffer.from(await r.arrayBuffer());
  let parsed: unknown = raw.toString('utf8');
  try {
    parsed = JSON.parse(parsed as string);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: parsed as T, headers: r.headers, raw };
}
const ok = async <T = any>(method: string, p: string, body?: unknown, status = 200): Promise<T> => {
  const r = await api<T>(method, p, body);
  expect(r.status, `${method} ${p}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};

const P = 'recv';
const PB = `/api/projects/${P}`;
const W = `${PB}/walkthroughs`;
const ORIGIN = 'http://app.recv.test:3184';

const STORYBOARD = (record: string) => ({
  name: 'Video flow',
  actors: [{ key: 'admin', role: 'admin' }],
  steps: [
    { id: 'home', kind: 'open', title: 'Home', intent: 'Open the home page', url: '/home' },
    { id: 'look', kind: 'instruction', title: 'Look around', intent: 'Check the page' },
  ],
  record,
});
const start = (body: Record<string, unknown> = {}) => ok('POST', W, { storyboard: 'video', origin: ORIGIN, ...body }, 201);

// ---- A small WebM as Chrome's MediaRecorder writes it: Segment and Cluster of unknown size, Info without Duration.
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const el = (id: string, body: Buffer) => Buffer.concat([hex(id), Buffer.from([0x80 | body.length]), body]); // body < 127
const EBML_HEADER = el('1A45DFA3', Buffer.concat([el('4286', hex('01')), el('4282', Buffer.from('webm')), el('4287', hex('04')), el('4285', hex('02'))]));
const INFO = el('1549A966', Buffer.concat([el('2AD7B1', hex('0F4240')), el('4D80', Buffer.from('Chrome')), el('5741', Buffer.from('Chrome'))]));
const TRACKS = el('1654AE6B', el('AE', Buffer.concat([el('D7', hex('01')), el('83', hex('01')), el('86', Buffer.from('V_VP9'))])));
const SEGMENT_START = hex('18538067 01FFFFFFFFFFFFFF');
const CLUSTER_START = Buffer.concat([hex('1F43B675 01FFFFFFFFFFFFFF'), el('E7', hex('00'))]);
const block = (n: number, fill: number) => el('A3', Buffer.concat([hex('81 00 00 80'), Buffer.alloc(n, fill)]));
const CHUNK0 = Buffer.concat([EBML_HEADER, SEGMENT_START, INFO, TRACKS, CLUSTER_START, block(60, 1)]);
const CHUNK1 = Buffer.concat([block(90, 2), block(90, 3)]);
const CHUNK2 = Buffer.concat([hex('1F43B675 01FFFFFFFFFFFFFF'), el('E7', hex('13 88')), block(70, 4)]);

/** The Duration (ms, TimecodeScale 1 ms) in a WebM's Info, or null. */
function durationOf(b: Buffer): number | null {
  const i = b.indexOf(hex('4489 88'));
  return i < 0 ? null : b.readDoubleBE(i + 3);
}

const vchunk = (id: string, key: string, seq: number, data: Buffer, extra: Record<string, unknown> = {}) =>
  api('POST', `${W}/${id}/recording/chunks`, { kind: 'video', segment: { key, url: `${ORIGIN}/home`, stepId: 'home', startedAt: new Date(Date.now() - 20_000).toISOString() }, seq, data: data.toString('base64'), mime: 'video/webm;codecs=vp9', ...extra });

describe('walkthrough recording R2 (video)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-recording-video-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      apnsPort: 0,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: fs.existsSync(MAILPIT_BIN),
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    hub = running.hub;
    base = `http://127.0.0.1:${httpPort}`;
    await ok('POST', '/api/projects', { name: 'Recording video', slug: P, generateUsers: { admins: 1 } }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN] } });
    await ok('PUT', `${PB}/storyboards/video`, STORYBOARD('video'), 201);
    await ok('PUT', `${PB}/storyboards/dom`, STORYBOARD('dom'), 201);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('webmSetDuration: inserts Duration into Info, replaces an old one, leaves other files alone', () => {
    const fixed = webmSetDuration(CHUNK0, 14_000);
    expect(durationOf(fixed)).toBe(14_000);
    // Only Info grew (Duration: 11 bytes; its size field went from 1 to 8 bytes): the rest is byte for byte the same.
    expect(fixed.length).toBe(CHUNK0.length + 11 + 7);
    expect(fixed.subarray(fixed.length - (TRACKS.length + CLUSTER_START.length + block(60, 1).length)).equals(CHUNK0.subarray(CHUNK0.length - (TRACKS.length + CLUSTER_START.length + block(60, 1).length)))).toBe(true);
    const again = webmSetDuration(fixed, 20_000);
    expect(durationOf(again)).toBe(20_000);
    expect(again.length).toBe(fixed.length);
    // A TimecodeScale of 1 µs: the Duration is in those units.
    const usInfo = el('1549A966', Buffer.concat([el('2AD7B1', hex('03E8')), el('4D80', Buffer.from('x'))]));
    expect(durationOf(webmSetDuration(Buffer.concat([EBML_HEADER, SEGMENT_START, usInfo, TRACKS]), 2_000))).toBe(2_000_000);
    // A SeekHead (byte offsets would move), not WebM, no duration: unchanged.
    const withSeek = Buffer.concat([EBML_HEADER, SEGMENT_START, el('114D9B74', hex('00')), INFO]);
    expect(webmSetDuration(withSeek, 1000)).toBe(withSeek);
    expect(webmSetDuration(Buffer.from('not a webm file'), 1000).toString()).toBe('not a webm file');
    expect(webmSetDuration(CHUNK0, 0)).toBe(CHUNK0);
  });

  it('parseRange: single ranges, suffix, open end, invalid and multi-range', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
  });

  it('start: record video is the run mode, with the masking warning; PATCH mode video clears a stop', async () => {
    const w = await start();
    expect(w.recording).toMatchObject({ mode: 'video', requested: 'video', segmentCount: 0 });
    // Video uses the mask selectors too: those fields show dots while it records.
    expect(w.recording.maskSelectors).toEqual(expect.arrayContaining(['input[autocomplete~="one-time-code" i]', 'input[autocomplete~="cc-number" i]']));
    expect(w.warnings.join(' ')).toMatch(/video of the tab.*show as dots on screen/);
    const d = await start({ record: 'dom' });
    expect(d.recording.mode).toBe('dom');
    const v = await ok('PATCH', `${W}/${d.id}/recording`, { mode: 'video' });
    expect(v.recording).toMatchObject({ mode: 'video', requested: 'video' });
  });

  it('video chunks: stored in order, retries ignored, metadata (mime, duration, markers) in the list', async () => {
    const w = await start();
    let r = await vchunk(w.id, 'tab-1', 0, CHUNK0, { markers: [{ at: 0, stepId: 'home' }], durationMs: 5000, width: 1280, height: 720 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ segment: 1, seq: 0, stored: true, bytes: CHUNK0.length, state: { mode: 'video', paused: false, stopped: null, currentStepId: 'home', status: 'active' } });
    r = await vchunk(w.id, 'tab-1', 1, CHUNK1, { markers: [{ at: 6200, stepId: 'look' }], durationMs: 10_000 });
    expect(r.body).toMatchObject({ segment: 1, seq: 1, stored: true });
    const again = await vchunk(w.id, 'tab-1', 1, CHUNK1);
    expect(again.status).toBe(200);
    expect(again.body.stored).toBe(false);
    r = await vchunk(w.id, 'tab-1', 2, CHUNK2, { durationMs: 14_000, final: true, markers: [{ at: 13_000, stepId: 'look' }] });
    expect(r.body.stored).toBe(true);

    const list = await ok('GET', `${W}/${w.id}/recording`);
    expect(list).toMatchObject({ mode: 'video', segmentCount: 1, bytes: CHUNK0.length + CHUNK1.length + CHUNK2.length });
    expect(list.segments).toHaveLength(1);
    expect(list.segments[0]).toMatchObject({
      no: 1,
      kind: 'video',
      mime: 'video/webm;codecs=vp9',
      durationMs: 14_000,
      events: 3,
      status: 'complete',
      stepId: 'home',
      url: `${ORIGIN}/home`,
      // A repeated step in a row is kept once.
      markers: [
        { at: 0, stepId: 'home' },
        { at: 6200, stepId: 'look' },
      ],
    });
    // The metadata row is not counted in bytes and never served as video.
    const segId = list.segments[0].id;
    const metaRow = hub.db.prepare('SELECT bytes FROM walkthrough_recording_chunks WHERE recording_id = ? AND seq = ?').get(segId, META_SEQ) as { bytes: number };
    expect(metaRow.bytes).toBe(0);
    // The walkthrough view counts the same.
    expect((await ok('GET', `${W}/${w.id}`)).recording).toMatchObject({ mode: 'video', segmentCount: 1, bytes: list.bytes });
  });

  it('serves the video: Content-Type, Duration fixed, the chunks in order, Range (206, across chunks, suffix, 416)', async () => {
    const w = await start();
    await vchunk(w.id, 'tab-2', 0, CHUNK0, { durationMs: 4000 });
    await vchunk(w.id, 'tab-2', 1, CHUNK1, { durationMs: 9000 });
    await vchunk(w.id, 'tab-2', 2, CHUNK2, { durationMs: 12_345, final: true });
    const url = `${W}/${w.id}/recording/segments/1`;
    const full = await api('GET', url, undefined, { 'accept-encoding': 'gzip' });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/webm');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-encoding')).toBeNull(); // never gzip: WebM does not compress, and Range needs the bytes
    expect(full.headers.get('x-content-type-options')).toBe('nosniff');
    expect(JSON.parse(full.headers.get('x-recording-segment')!)).toMatchObject({ no: 1, kind: 'video', durationMs: 12_345 });
    const expected = Buffer.concat([webmSetDuration(CHUNK0, 12_345), CHUNK1, CHUNK2]);
    expect(Number(full.headers.get('content-length'))).toBe(expected.length);
    expect(full.raw.equals(expected)).toBe(true);
    expect(durationOf(full.raw)).toBe(12_345);

    const head = await api('GET', url, undefined, { range: 'bytes=0-99' });
    expect(head.status).toBe(206);
    expect(head.headers.get('content-range')).toBe(`bytes 0-99/${expected.length}`);
    expect(head.raw.equals(expected.subarray(0, 100))).toBe(true);
    // A range across the chunk boundaries.
    const a = expected.length - CHUNK2.length - 50;
    const mid = await api('GET', url, undefined, { range: `bytes=${a}-${a + 99}` });
    expect(mid.status).toBe(206);
    expect(mid.raw.equals(expected.subarray(a, a + 100))).toBe(true);
    const tail = await api('GET', url, undefined, { range: 'bytes=-30' });
    expect(tail.headers.get('content-range')).toBe(`bytes ${expected.length - 30}-${expected.length - 1}/${expected.length}`);
    expect(tail.raw.equals(expected.subarray(expected.length - 30))).toBe(true);
    const open = await api('GET', url, undefined, { range: `bytes=${expected.length - 5}-` });
    expect(open.raw.equals(expected.subarray(expected.length - 5))).toBe(true);
    const bad = await api('GET', url, undefined, { range: `bytes=${expected.length}-` });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe(`bytes */${expected.length}`);
    // A live segment is not cached.
    const live = await start();
    await vchunk(live.id, 'tab-3', 0, CHUNK0, { durationMs: 1000 });
    expect((await api('GET', `${W}/${live.id}/recording/segments/1`)).headers.get('cache-control')).toBe('no-store');
    expect(full.headers.get('cache-control')).toBe('private, max-age=60');
  });

  it('rejects bad video chunks: not base64, wrong mime, seq 0 without the WebM header, bad markers, too big', async () => {
    const w = await start();
    const bad = async (extra: Record<string, unknown>, status = 400) => {
      const r = await api('POST', `${W}/${w.id}/recording/chunks`, { kind: 'video', segment: { key: 'k' }, seq: 0, data: CHUNK0.toString('base64'), mime: 'video/webm', ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(status);
      return r.body;
    };
    expect((await bad({ data: '%%% not base64' })).error).toMatch(/base64/);
    expect((await bad({ data: 42 })).error).toMatch(/base64/);
    expect((await bad({ mime: 'video/mp4' })).error).toMatch(/video\/webm/);
    expect((await bad({ data: Buffer.from('hello world').toString('base64') })).error).toMatch(/EBML/);
    expect((await bad({ markers: [{ at: -1, stepId: 'home' }] })).error).toMatch(/markers\[0\]/);
    expect((await bad({ markers: 'x' })).error).toMatch(/markers/);
    expect((await bad({ durationMs: 'long' })).error).toMatch(/durationMs/);
    expect((await bad({ kind: 'gif' })).error).toMatch(/kind/);
    expect((await bad({ segment: { key: 'video.x' } })).error).toMatch(/segment.key/); // '.' is reserved for video keys
    const caps = hub.recordings!.caps;
    const saved = caps.chunkBytes;
    caps.chunkBytes = 100;
    try {
      expect((await bad({}, 413)).error).toMatch(/at most/);
    } finally {
      caps.chunkBytes = saved;
    }
    expect((await api('GET', `${W}/${w.id}/recording`)).body.segmentCount).toBe(0);
  });

  it('mode handling: a video run refuses DOM chunks and a DOM run video ones (409); a switch keeps both kinds', async () => {
    const v = await start();
    const domChunk = (id: string) => api('POST', `${W}/${id}/recording/chunks`, { segment: { key: 'page-a', url: `${ORIGIN}/home` }, seq: 0, events: [{ type: 4, data: { href: `${ORIGIN}/home`, width: 1280, height: 800 }, timestamp: Date.now() - 1000 }] });
    let r = await domChunk(v.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/records video, not the DOM/);
    const d = await start({ record: 'dom' });
    r = await vchunk(d.id, 'tab', 0, CHUNK0);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/records the DOM, not video/);
    const off = await start({ record: 'off' });
    expect((await vchunk(off.id, 'tab', 0, CHUNK0)).body.error).toMatch(/Recording is off/);

    // Video first, then the rest of the run as DOM: both kinds in one list, each served its own way.
    expect((await vchunk(v.id, 'tab', 0, CHUNK0, { durationMs: 3000, final: true })).status).toBe(201);
    await ok('PATCH', `${W}/${v.id}/recording`, { mode: 'dom' });
    expect((await domChunk(v.id)).status).toBe(201);
    const list = await ok('GET', `${W}/${v.id}/recording`);
    expect(list.mode).toBe('dom');
    expect(list.segments.map((s: any) => [s.no, s.kind])).toEqual([
      [1, 'video'],
      [2, 'dom'],
    ]);
    expect((await api('GET', `${W}/${v.id}/recording/segments/1`)).headers.get('content-type')).toBe('video/webm');
    expect((await api('GET', `${W}/${v.id}/recording/segments/2`)).headers.get('content-type')).toMatch(/ndjson/);
    // Paused: the chunk replies carry it, so the extension pauses the recorder.
    await ok('PATCH', `${W}/${v.id}/recording`, { mode: 'video' });
    await ok('PATCH', `${W}/${v.id}/recording`, { paused: true });
    expect((await vchunk(v.id, 'tab-b', 0, CHUNK0)).body.state).toMatchObject({ mode: 'video', paused: true });
  });

  it('cap: over recordingMaxMb the chunk is refused (413), recording stops and the segment is cut; what came in still plays', async () => {
    await ok('PATCH', PB, { settings: { recordingMaxMb: (CHUNK0.length + CHUNK1.length + 10) / 1024 / 1024 } });
    try {
      const w = await start();
      expect((await vchunk(w.id, 'tab', 0, CHUNK0, { durationMs: 5000 })).status).toBe(201);
      expect((await vchunk(w.id, 'tab', 1, CHUNK1, { durationMs: 10_000 })).status).toBe(201);
      const r = await vchunk(w.id, 'tab', 2, CHUNK2, { durationMs: 15_000 });
      expect(r.status).toBe(413);
      expect(r.body.error).toMatch(/reached its .* limit \(project setting recordingMaxMb\)/);
      const list = await ok('GET', `${W}/${w.id}/recording`);
      expect(list.stopped).toMatch(/limit/);
      expect(list.segments[0]).toMatchObject({ status: 'cut', durationMs: 10_000, bytes: CHUNK0.length + CHUNK1.length });
      // Still refused while stopped; the file so far is served whole.
      expect((await vchunk(w.id, 'tab', 3, CHUNK2)).status).toBe(413);
      const file = await api('GET', `${W}/${w.id}/recording/segments/1`);
      expect(file.raw.equals(Buffer.concat([webmSetDuration(CHUNK0, 10_000), CHUNK1]))).toBe(true);
      // Delete removes the video and its metadata; recording may go on.
      expect(await ok('DELETE', `${W}/${w.id}/recording`)).toEqual({ deleted: 1, bytes: CHUNK0.length + CHUNK1.length });
      expect(Number((hub.db.prepare('SELECT COUNT(*) AS n FROM walkthrough_recording_chunks c JOIN walkthrough_recordings r ON r.id = c.recording_id WHERE r.walkthrough_id = ?').get(w.id) as { n: number }).n)).toBe(0);
      expect((await ok('GET', `${W}/${w.id}/recording`)).stopped).toBeNull();
      expect((await api('GET', `${W}/${w.id}/recording/segments/1`)).status).toBe(404);
    } finally {
      await ok('PATCH', PB, { settings: { recordingMaxMb: null } });
    }
  });
});
