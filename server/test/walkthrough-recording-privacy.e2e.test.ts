import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import type { Hub } from '../src/hub.js';
import { startHub, type RunningHub } from '../src/index.js';

/**
 * Walkthrough recording privacy and limits (the security review of R1): the storyboard recordPrivacy lists and how
 * they reach the recorder, URL redaction (segment URL, Meta href, the segment header), non-latin URLs, the replay
 * page and its Content-Security-Policy, chunks refused once the run is no longer active and dropped after a pause,
 * heartbeat chunks (no segment), the segment count cap, and the uncompressed caps per segment and per walkthrough.
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
// Dynamic import: the client lives in the packages/client workspace (outside this tsconfig's rootDir).
let c: any;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}
const ok = async <T = any>(method: string, p: string, body?: unknown, status = 200): Promise<T> => {
  const r = await api<T>(method, p, body);
  expect(r.status, `${method} ${p}: ${JSON.stringify(r.body)}`).toBe(status);
  return r.body;
};

const P = 'rec';
const PB = `/api/projects/${P}`;
const W = `${PB}/walkthroughs`;
const ORIGIN = 'http://app.rec.test:3183';

const STORYBOARD = (record?: string) => ({
  name: 'Recorded flow',
  actors: [{ key: 'admin', role: 'admin' }],
  steps: [
    { id: 'login', kind: 'login', actor: 'admin', title: 'Log in', intent: 'Sign in as the admin' },
    { id: 'home', kind: 'open', title: 'Home', intent: 'Open the home page', url: '/home' },
    { id: 'look', kind: 'instruction', title: 'Look around', intent: 'Check the page' },
  ],
  ...(record ? { record } : {}),
});

/** rrweb-like events (Meta, FullSnapshot, IncrementalSnapshot, Custom). */
const meta = (ts: number, href = `${ORIGIN}/home`) => ({ type: 4, data: { href, width: 1280, height: 800 }, timestamp: ts });
const full = (ts: number) => ({ type: 2, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { left: 0, top: 0 } }, timestamp: ts });
const move = (ts: number, x = 10) => ({ type: 3, data: { source: 1, positions: [{ x, y: 20, id: 1, timeOffset: 0 }] }, timestamp: ts });
const step = (ts: number, stepId: string) => ({ type: 5, data: { tag: 'stubyard.step', payload: { stepId } }, timestamp: ts });

const start = (body: Record<string, unknown> = {}) => ok('POST', W, { storyboard: 'recorded', origin: ORIGIN, ...body }, 201);
const chunk = (id: string, key: string, seq: number, events: unknown[], extra: Record<string, unknown> = {}) =>
  api('POST', `${W}/${id}/recording/chunks`, { segment: { key, url: `${ORIGIN}/home`, stepId: 'home' }, seq, events, ...extra });

describe('walkthrough recording privacy and limits', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-recording-privacy-'));
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
    // Dynamic import: the client lives in the packages/client workspace (outside this tsconfig's rootDir).
    c = await import(new URL('../../packages/client/src/walkthroughs.ts', import.meta.url).pathname);
    await ok('POST', '/api/projects', { name: 'Recording', slug: P, generateUsers: { admins: 1 } }, 201);
    await ok('PATCH', PB, { settings: { appOrigins: [ORIGIN] } });
    await ok('PUT', `${PB}/login-recipes/admin`, { role: 'admin', loginUrl: '/login', fields: { password: '#pw' }, twoFactor: { kind: 'email-otp', selector: '#totp-code' } }, 201);
    await ok('PUT', `${PB}/storyboards/recorded`, STORYBOARD('dom'), 201);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const events = async (id: string, no: number) => {
    const r = await fetch(`${base}${W}/${id}/recording/segments/${no}`);
    return { status: r.status, header: r.headers.get('x-recording-segment'), text: await r.text() };
  };

  it('recordPrivacy: saved and shown, empty lists leave the hash alone, the run gets the lists', async () => {
    const lists = { unmaskSelectors: ['input[type=search]'], maskSelectors: ['#acct-no'], maskTextSelectors: ['.api-key'], blockSelectors: ['.secret-panel'] };
    const put = await ok('PUT', `${PB}/storyboards/private`, { ...STORYBOARD('dom'), name: 'Private', recordPrivacy: lists }, 201);
    expect(put.version).toBe(1);
    expect((await ok('GET', `${PB}/storyboards/private`)).recordPrivacy).toEqual(lists);
    await ok('PUT', `${PB}/storyboards/plain2`, { ...STORYBOARD('dom'), name: 'Plain 2' }, 201);
    const same = await ok('PUT', `${PB}/storyboards/plain2`, { ...STORYBOARD('dom'), name: 'Plain 2', recordPrivacy: { unmaskSelectors: [] } });
    expect(same.version).toBe(1);
    expect((await ok('GET', `${PB}/storyboards/plain2`)).recordPrivacy).toBeUndefined();
    const tooMany = Array.from({ length: 51 }, (_, i) => `#f${i}`);
    expect((await api('PUT', `${PB}/storyboards/bad`, { ...STORYBOARD('dom'), recordPrivacy: { blockSelectors: tooMany } })).status).toBe(400);
    const w = await start({ storyboard: 'private' });
    expect(w.recording).toMatchObject({ mode: 'dom', maskAllInputs: false, maskAllText: false, unmaskSelectors: lists.unmaskSelectors, maskTextSelectors: lists.maskTextSelectors, blockSelectors: lists.blockSelectors });
    expect(w.recording.maskSelectors).toEqual(expect.arrayContaining(['#acct-no', '#pw', '#totp-code', 'input[autocomplete~="cc-number" i]']));
    // Strict masking: nothing is unmasked, all text is masked.
    const s = await start({ storyboard: 'private', maskAllInputs: true });
    expect(s.recording).toMatchObject({ maskAllInputs: true, maskAllText: true, unmaskSelectors: [] });
  });

  it('URLs are redacted: segment URL, Meta href, the list and the segment header; non-latin URLs work', async () => {
    const w = await start();
    const t0 = Date.now() - 10_000;
    const leak = `${ORIGIN}/reset?reset_token=URLTOKEN-RESET-9f8e7d&lang=en#access_token=FRAGTOKEN`;
    const r = await api('POST', `${W}/${w.id}/recording/chunks`, { segment: { key: 'u1', url: leak, stepId: 'home' }, seq: 0, events: [meta(t0, leak), full(t0 + 1)] });
    expect(r.status).toBe(201);
    const list = await ok('GET', `${W}/${w.id}/recording`);
    expect(list.segments[0].url).toBe(`${ORIGIN}/reset?reset_token=*&lang=*#access_token=*`);
    const ev = await events(w.id, 1);
    expect(ev.status).toBe(200);
    const all = ev.text + ev.header + JSON.stringify(list) + JSON.stringify(await ok('GET', `${W}/${w.id}`));
    expect(all).not.toContain('URLTOKEN');
    expect(all).not.toContain('FRAGTOKEN');
    expect(JSON.parse(ev.text.split('\n')[0]).data.href).toBe(`${ORIGIN}/reset?reset_token=*&lang=*#access_token=*`);
    // A non-latin URL: stored percent-encoded, the header stays ASCII (was a 500).
    expect((await api('POST', `${W}/${w.id}/recording/chunks`, { segment: { key: 'u2', url: `${ORIGIN}/café/✓`, stepId: 'home' }, seq: 0, events: [meta(t0 + 10, `${ORIGIN}/café/✓`), full(t0 + 11)] })).status).toBe(201);
    const ev2 = await events(w.id, 2);
    expect(ev2.status).toBe(200);
    expect(ev2.header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(ev2.header!).url).toBe(`${ORIGIN}/caf%C3%A9/%E2%9C%93`);
    // Not http(s): no URL kept.
    expect((await api('POST', `${W}/${w.id}/recording/chunks`, { segment: { key: 'u3', url: 'javascript:alert(1)', stepId: 'home' }, seq: 0, events: [meta(t0 + 20), full(t0 + 21)] })).status).toBe(201);
    expect((await ok('GET', `${W}/${w.id}/recording`)).segments[2].url).toBe('');
  });

  it('the replay page: empty HTML with a CSP that loads nothing from the network, no referrer', async () => {
    const w = await start();
    const r = await fetch(`${base}${W}/${w.id}/recording/player`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const csp = r.headers.get('content-security-policy')!;
    for (const d of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", 'style-src \'unsafe-inline\'']) expect(csp).toContain(d);
    // Images: data: URLs and the run's app origin only (the recorded page's own images).
    expect(csp).toMatch(new RegExp(`img-src data: [^;]*${ORIGIN.replace(/[.:/]/g, '\\$&')}`));
    expect(csp).not.toMatch(/\*|https?:\/\/(?!app\.rec\.test)/);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await r.text()).not.toMatch(/<script/i);
    expect((await fetch(`${base}${W}/nope/recording/player`)).status).toBe(404);
  });

  it('heartbeats: an empty chunk answers the state and makes no segment; the run ended: 409', async () => {
    const w = await start();
    for (let i = 0; i < 5; i++) {
      const h = await chunk(w.id, `hb${i}`, 0, []);
      expect(h.status).toBe(200);
      expect(h.body).toMatchObject({ stored: false, state: { mode: 'dom', paused: false } });
    }
    expect((await ok('GET', `${W}/${w.id}/recording`)).segments).toEqual([]);
    expect((await chunk(w.id, 'live', 0, [meta(Date.now() - 1000), full(Date.now() - 999)])).status).toBe(201);
    await ok('POST', `${W}/${w.id}/abandon`, {});
    // A recorder that has not heard yet is refused (it stops); a new segment too.
    expect((await chunk(w.id, 'late', 0, [meta(Date.now())])).status).toBe(409);
    expect((await chunk(w.id, 'hb-late', 0, [])).status).toBe(409);
  });

  it('video: an empty chunk is a heartbeat (no segment); a run that ended answers 409; the URL is redacted', async () => {
    const w = await start({ record: 'video' });
    const v = (key: string, seq: number, data: string, extra: Record<string, unknown> = {}) =>
      api('POST', `${W}/${w.id}/recording/chunks`, { kind: 'video', segment: { key, url: `${ORIGIN}/a?token=VIDTOKEN`, stepId: 'home' }, seq, data, mime: 'video/webm', durationMs: 1000, markers: [], final: false, ...extra });
    const hb = await v('vk', 0, '');
    expect(hb.status).toBe(200);
    expect(hb.body.stored).toBe(false);
    expect((await ok('GET', `${W}/${w.id}/recording`)).segments).toEqual([]);
    const first = await v('vk', 0, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm-bytes')]).toString('base64'));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const list = await ok('GET', `${W}/${w.id}/recording`);
    expect(list.segments[0].url).toBe(`${ORIGIN}/a?token=*`);
    expect(JSON.stringify(list)).not.toContain('VIDTOKEN');
    await ok('POST', `${W}/${w.id}/abandon`, {});
    expect((await v('vk2', 0, '')).status).toBe(409);
  });

  it('pause drops events after it (also of a new segment) and the heartbeat says paused', async () => {
    const w = await start();
    expect((await chunk(w.id, 'a', 0, [meta(Date.now() - 2000), full(Date.now() - 1999)])).status).toBe(201);
    await ok('PATCH', `${W}/${w.id}/recording`, { paused: true });
    const after = Date.now() + 500;
    const r = await chunk(w.id, 'a', 1, [move(after), move(after + 10)]);
    expect(r.body.state.paused).toBe(true); // the seq is kept (in order), its events are not
    // A new segment made while paused (a snapshot taken with a password shown) is not created.
    const n = await chunk(w.id, 'b', 0, [meta(after), full(after + 1)]);
    expect(n.body.stored).toBe(false);
    const list = await ok('GET', `${W}/${w.id}/recording`);
    expect(list.segments.map((s: { events: number }) => s.events)).toEqual([2]);
    expect((await ok('GET', `${W}/${w.id}`)).recording.pausedAt).toBeTruthy();
    await ok('PATCH', `${W}/${w.id}/recording`, { paused: false });
    expect((await ok('GET', `${W}/${w.id}`)).recording.pausedAt).toBeNull();
  });

  it('caps: segments per run, uncompressed bytes per segment (segmentFull) and per walkthrough', async () => {
    const caps = hub.recordings!.caps;
    const saved = { ...caps };
    try {
      caps.maxSegments = 3;
      const w = await start();
      const t0 = Date.now() - 10_000;
      for (let i = 0; i < 3; i++) expect((await chunk(w.id, `s${i}`, 0, [meta(t0 + i), full(t0 + i)])).status).toBe(201);
      const four = await chunk(w.id, 's3', 0, [meta(t0 + 5), full(t0 + 5)]);
      expect(four.status).toBe(413);
      expect(four.body.error).toMatch(/3 segments/);
      Object.assign(caps, saved);

      // A segment holds segmentRawBytes uncompressed: the recorder is told to start a new one.
      caps.segmentRawBytes = 4000;
      const w2 = await start();
      const text = (n: number, ts: number) => ({ type: 3, timestamp: ts, data: { source: 0, texts: [{ id: 1, value: 'a'.repeat(n) }], attributes: [], removes: [], adds: [] } });
      expect((await chunk(w2.id, 'big', 0, [meta(t0), full(t0 + 1), text(2000, t0 + 2)])).status).toBe(201);
      const full2 = await chunk(w2.id, 'big', 1, [text(3000, t0 + 3)]);
      expect(full2.status).toBe(413);
      expect(full2.body.details).toMatchObject({ segmentFull: true });
      expect((await ok('GET', `${W}/${w2.id}`)).recording.stopped).toBeNull(); // recording goes on
      expect((await chunk(w2.id, 'big2', 0, [meta(t0 + 4), full(t0 + 5)])).status).toBe(201);
      const segs = (await ok('GET', `${W}/${w2.id}/recording`)).segments;
      expect(segs[0]).toMatchObject({ status: 'complete' });
      expect(segs[0].rawBytes).toBeGreaterThan(2000);
      Object.assign(caps, saved);

      // Per walkthrough: repeated text compresses to almost nothing, the uncompressed cap still stops it.
      await ok('PATCH', PB, { settings: { recordingMaxMb: 0.01 } }); // ~10 KB compressed, ~100 KB uncompressed
      const w3 = await start();
      let stopped: { status: number; body: { error: string } } | null = null;
      for (let i = 0; i < 40 && !stopped; i++) {
        const r = await chunk(w3.id, 'rep', i, [text(20_000, t0 + 10 + i)]);
        if (r.status !== 201) stopped = r;
      }
      expect(stopped?.status).toBe(413);
      expect(stopped?.body.error).toMatch(/uncompressed/);
      const v = await ok('GET', `${W}/${w3.id}/recording`);
      expect(v.bytes).toBeLessThan(Math.round(0.01 * 1024 * 1024));
    } finally {
      Object.assign(caps, saved);
      await ok('PATCH', PB, { settings: { recordingMaxMb: null } });
    }
  });

});
