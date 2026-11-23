import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import type { Hub } from '../src/hub.js';
import { startHub, type RunningHub } from '../src/index.js';

/**
 * Walkthrough recording R1 (storyboards/recordings.ts, migration 27): the storyboard field and the start override,
 * chunk upload (segments, idempotent seq), the segment stream, the caps (chunk size, per-walkthrough MB with the stop),
 * pause / mode switch, delete, retention and the cascade on walkthrough delete; the @stubyard/client helpers.
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

describe('walkthrough recording (R1)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-recording-'));
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

  it('storyboard record: default off, kept on save; the default leaves the content hash alone', async () => {
    const sb = await ok('GET', `${PB}/storyboards/recorded`);
    expect(sb.record).toBe('dom');
    expect(sb.recordMaskAllInputs).toBe(false);
    await ok('PUT', `${PB}/storyboards/plain`, { ...STORYBOARD(), name: 'Plain' }, 201);
    const plain = await ok('GET', `${PB}/storyboards/plain`);
    expect(plain.record).toBe('off');
    // Same content with the default spelled out: unchanged (no version bump).
    const again = await ok('PUT', `${PB}/storyboards/plain`, { ...STORYBOARD(), name: 'Plain', record: 'off', recordMaskAllInputs: false });
    expect(again.version).toBe(1);
    expect((await api('PUT', `${PB}/storyboards/bad`, { ...STORYBOARD(), record: 'gif' })).status).toBe(400);
    // The bundle export carries the setting.
    const bundle = await ok('GET', `${PB}/storyboards/export?storyboards=recorded`);
    expect(bundle.storyboards[0].record).toBe('dom');
  });

  it('start: the storyboard default for tracked runs, the override, quick runs off unless asked, video → dom with a warning', async () => {
    const w = await start();
    expect(w.recording).toMatchObject({ mode: 'dom', requested: 'dom', paused: false, stopped: null, segmentCount: 0, bytes: 0, maxBytes: 50 * 1024 * 1024 });
    // The run's login recipe fields are masked, with the one-time-code default.
    expect(w.recording.maskSelectors).toEqual(expect.arrayContaining(['#totp-code', '#pw', 'input[autocomplete="one-time-code"]']));
    expect((await start({ record: 'off' })).recording.mode).toBe('off');
    expect((await start({ mode: 'quick' })).recording.mode).toBe('off');
    expect((await start({ mode: 'quick', record: 'dom' })).recording.mode).toBe('dom');
    const v = await start({ record: 'video', maskAllInputs: true });
    expect(v.recording).toMatchObject({ mode: 'dom', requested: 'video', maskAllInputs: true });
    expect(v.warnings.join(' ')).toMatch(/video.*reserved/);
    expect((await api('POST', W, { storyboard: 'recorded', record: 'film' })).status).toBe(400);
    const plain = await ok('POST', W, { storyboard: 'plain', origin: ORIGIN }, 201);
    expect(plain.recording.mode).toBe('off');
    expect(plain.recording.maskSelectors).toEqual([]);
    expect((await ok('POST', W, { storyboard: 'plain', origin: ORIGIN, record: 'dom' }, 201)).recording.mode).toBe('dom');
  });

  it('chunks: a segment per page load, retries of a seq are ignored, the list and the NDJSON stream (gzip or plain)', async () => {
    const w = await start();
    const t0 = Date.now() - 60_000;
    let r = await chunk(w.id, 'page-a', 0, [meta(t0), full(t0 + 1), step(t0 + 2, 'home')]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ segment: 1, seq: 0, stored: true, state: { mode: 'dom', paused: false, stopped: null, currentStepId: 'login', status: 'active' } });
    r = await chunk(w.id, 'page-a', 1, [move(t0 + 5000), move(t0 + 9000, 30)], { final: true });
    expect(r.body).toMatchObject({ segment: 1, seq: 1, stored: true });
    const again = await chunk(w.id, 'page-a', 1, [move(t0 + 5000)]);
    expect(again.status).toBe(200);
    expect(again.body.stored).toBe(false);
    r = await chunk(w.id, 'page-b', 0, [meta(t0 + 20_000, `${ORIGIN}/next`), full(t0 + 20_001)]);
    expect(r.body.segment).toBe(2);

    const list = await ok('GET', `${W}/${w.key}/recording`);
    expect(list.walkthrough).toMatchObject({ id: w.id, key: w.key, status: 'active' });
    expect(list.segmentCount).toBe(2);
    expect(list.segments.map((s: any) => [s.no, s.events, s.status, s.stepId])).toEqual([
      [1, 5, 'complete', 'home'],
      [2, 2, 'recording', 'home'],
    ]);
    expect(list.segments[0].durationMs).toBe(9000);
    expect(list.bytes).toBe(list.segments[0].bytes + list.segments[1].bytes);
    expect(list.bytes).toBeGreaterThan(0);

    // fetch accepts gzip and decodes it.
    const seg = await fetch(`${base}${W}/${w.id}/recording/segments/1`);
    expect(seg.headers.get('content-type')).toMatch(/application\/x-ndjson/);
    expect(seg.headers.get('content-encoding')).toBe('gzip');
    const lines = (await seg.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((e) => e.type)).toEqual([4, 2, 5, 3, 3]);
    expect(JSON.parse(seg.headers.get('x-recording-segment')!)).toMatchObject({ no: 1, events: 5 });
    // Raw gzip on the wire (one gzip stream).
    const raw = await new Promise<Buffer>((resolve, reject) => {
      import('node:http').then(({ get }) =>
        get(`${base}${W}/${w.id}/recording/segments/1`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
          const bufs: Buffer[] = [];
          res.on('data', (d) => bufs.push(d)).on('end', () => resolve(Buffer.concat(bufs))).on('error', reject);
        }).on('error', reject),
      );
    });
    expect(gunzipSync(raw).toString().trim().split('\n')).toHaveLength(5);
    // Plain when gzip is not accepted.
    const plain = await new Promise<string>((resolve, reject) => {
      import('node:http').then(({ get }) =>
        get(`${base}${W}/${w.id}/recording/segments/2`, { headers: { 'accept-encoding': 'identity' } }, (res) => {
          let s = '';
          res.setEncoding('utf8').on('data', (d) => (s += d)).on('end', () => resolve(s)).on('error', reject);
        }).on('error', reject),
      );
    });
    expect(plain.trim().split('\n')).toHaveLength(2);
    expect((await api('GET', `${W}/${w.id}/recording/segments/9`)).status).toBe(404);
    expect((await api('GET', `${W}/${w.id}/recording/segments/x`)).status).toBe(400);

    // The client helpers.
    const t = { apiUrl: base, project: P };
    expect((await c.getRecording(t, w.id)).segments).toHaveLength(2);
    expect(await c.getRecordingEvents(t, w.id, 2)).toHaveLength(2);
    const up = await c.uploadRecordingChunk(t, w.id, { segment: { key: 'page-c', url: `${ORIGIN}/c` }, seq: 0, events: [meta(t0 + 30_000)] });
    expect(up.segment).toBe(3);
    expect(c.recordingSegmentUrl(t, w.id, 3)).toBe(`${base}${W}/${w.id}/recording/segments/3`);
    // A new segment is announced (the dashboard's list), chunks of a segment are not.
    expect((await c.deleteRecording(t, w.id)).deleted).toBe(3);
    expect((await c.getRecording(t, w.id)).segments).toEqual([]);
  });

  it('validation: 409 when recording is off, 400 for bad input, 413 for a chunk over the size or event caps', async () => {
    const off = await start({ record: 'off' });
    const r = await chunk(off.id, 'k', 0, [meta(Date.now())]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Recording is off/);
    const w = await start();
    expect((await chunk(w.id, 'bad key!', 0, [])).status).toBe(400);
    expect((await chunk(w.id, 'k', -1, [])).status).toBe(400);
    expect((await chunk(w.id, 'k', 0, [{ nope: 1 }])).status).toBe(400);
    expect((await api('POST', `${W}/${w.id}/recording/chunks`, { segment: { key: 'k' }, seq: 0, events: 'x' })).status).toBe(400);
    const caps = hub.recordings!.caps;
    const saved = { ...caps };
    try {
      caps.chunkBytes = 200;
      const big = await chunk(w.id, 'k', 0, [full(Date.now()), ...Array.from({ length: 10 }, (_, i) => move(Date.now() + i))]);
      expect(big.status).toBe(413);
      expect(big.body.error).toMatch(/at most/);
      caps.chunkBytes = saved.chunkBytes;
      caps.chunkEvents = 2;
      expect((await chunk(w.id, 'k', 0, [move(1), move(2), move(3)])).status).toBe(413);
    } finally {
      Object.assign(caps, saved);
    }
    // A too-large body is refused by the route's body limit before it is parsed.
    const huge = await api('POST', `${W}/${w.id}/recording/chunks`, { segment: { key: 'k' }, seq: 0, events: [{ type: 3, timestamp: 1, data: 'x'.repeat(11 * 1024 * 1024) }] });
    expect(huge.status).toBe(413);
  });

  it('the per-walkthrough cap stops recording with a clear 413; delete clears the stop', async () => {
    await ok('PATCH', PB, { settings: { recordingMaxMb: 0.002 } }); // about 2 KB
    try {
      const w = await start();
      expect(w.recording.maxBytes).toBe(Math.round(0.002 * 1024 * 1024));
      const t0 = Date.now() - 10_000;
      expect((await chunk(w.id, 'p1', 0, [meta(t0), full(t0 + 1)])).status).toBe(201);
      // Random-ish data does not compress: over the cap.
      const noise = Array.from({ length: 200 }, (_, i) => ({ type: 3, data: { source: 5, text: randomBytes(24).toString('hex'), id: i }, timestamp: t0 + 100 + i }));
      const r = await chunk(w.id, 'p1', 1, noise);
      expect(r.status).toBe(413);
      expect(r.body.error).toMatch(/reached its .* limit \(project setting recordingMaxMb\)/);
      const v = await ok('GET', `${W}/${w.id}`);
      expect(v.recording.stopped).toMatch(/Recording stopped/);
      expect(v.recording.stoppedAt).toBeTruthy();
      const list = await ok('GET', `${W}/${w.id}/recording`);
      expect(list.segments[0].status).toBe('cut');
      // Every further chunk answers 413 until the recording is deleted (or turned on again).
      expect((await chunk(w.id, 'p2', 0, [meta(t0 + 5000)])).status).toBe(413);
      expect(await ok('DELETE', `${W}/${w.id}/recording`)).toMatchObject({ deleted: 1 });
      expect((await ok('GET', `${W}/${w.id}`)).recording).toMatchObject({ stopped: null, segmentCount: 0, bytes: 0 });
      expect((await chunk(w.id, 'p2', 0, [meta(t0 + 5000)])).status).toBe(201);
    } finally {
      await ok('PATCH', PB, { settings: { recordingMaxMb: null } });
    }
  });

  it('pause / resume and mode off / on through PATCH …/recording (the chunk answer carries the state)', async () => {
    const w = await start();
    let v = await ok('PATCH', `${W}/${w.id}/recording`, { paused: true });
    expect(v.recording.paused).toBe(true);
    let r = await chunk(w.id, 'p', 0, [meta(Date.now())]);
    expect(r.status).toBe(201); // events recorded before the pause still arrive
    expect(r.body.state.paused).toBe(true);
    v = await ok('PATCH', `${W}/${w.id}/recording`, { mode: 'off' });
    expect(v.recording).toMatchObject({ mode: 'off', paused: false });
    expect((await chunk(w.id, 'p', 1, [move(Date.now())])).status).toBe(409);
    v = await ok('PATCH', `${W}/${w.id}/recording`, { mode: 'dom' });
    expect(v.recording.mode).toBe('dom');
    r = await chunk(w.id, 'p', 1, [move(Date.now())]);
    expect(r.status).toBe(201);
    expect((await api('PATCH', `${W}/${w.id}/recording`, { paused: 'yes' })).status).toBe(400);
    expect((await api('PATCH', `${W}/${w.id}/recording`, { mode: 'film' })).status).toBe(400);
    const t = { apiUrl: base, project: P };
    expect((await c.setRecording(t, w.id, { paused: true })).recording.paused).toBe(true);
  });

  it('retention: recordings go recordingRetentionDays (default 14) after they ended; 0 keeps them', async () => {
    const w = await start();
    expect((await chunk(w.id, 'r', 0, [meta(Date.now())])).status).toBe(201);
    const count = () => (hub.db.prepare('SELECT COUNT(*) AS n FROM walkthrough_recordings WHERE walkthrough_id = ?').get(w.id) as { n: number }).n;
    await hub.maintenance.run(Date.now() + 10 * 86_400_000);
    expect(count()).toBe(1);
    await ok('PATCH', PB, { settings: { recordingRetentionDays: 0 } });
    await hub.maintenance.run(Date.now() + 100 * 86_400_000);
    expect(count()).toBe(1);
    await ok('PATCH', PB, { settings: { recordingRetentionDays: null } });
    const report = await hub.maintenance.run(Date.now() + 15 * 86_400_000);
    expect(report.error).toBeUndefined();
    expect(report.recordingsPurged).toBeGreaterThanOrEqual(1);
    expect(count()).toBe(0);
    // The walkthrough itself is still active and kept.
    expect((await api('GET', `${W}/${w.id}`)).status).toBe(200);
  });

  it('deleting the walkthrough removes its recording (segments and chunks cascade)', async () => {
    const w = await start();
    expect((await chunk(w.id, 'd', 0, [meta(Date.now()), full(Date.now())])).status).toBe(201);
    const n = (sql: string) => (hub.db.prepare(sql).get(w.id) as { n: number }).n;
    expect(n('SELECT COUNT(*) AS n FROM walkthrough_recording_chunks c JOIN walkthrough_recordings r ON r.id = c.recording_id WHERE r.walkthrough_id = ?')).toBe(1);
    const segId = (hub.db.prepare('SELECT id FROM walkthrough_recordings WHERE walkthrough_id = ?').get(w.id) as { id: string }).id;
    await ok('DELETE', `${W}/${w.id}`);
    expect(n('SELECT COUNT(*) AS n FROM walkthrough_recordings WHERE walkthrough_id = ?')).toBe(0);
    expect((hub.db.prepare('SELECT COUNT(*) AS n FROM walkthrough_recording_chunks WHERE recording_id = ?').get(segId) as { n: number }).n).toBe(0);
  });

  it('MCP: list_walkthrough_recordings and delete_walkthrough_recording', async () => {
    const w = await start();
    expect((await chunk(w.id, 'm', 0, [meta(Date.now())])).status).toBe(201);
    const rpc = async (name: string, args: unknown) => {
      const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream' });
      const res = r.body.result;
      return JSON.parse(res.content[0].text);
    };
    const list = await rpc('list_walkthrough_recordings', { project: P, id: w.key });
    expect(list.segments).toHaveLength(1);
    expect(await rpc('delete_walkthrough_recording', { project: P, id: w.key })).toMatchObject({ deleted: 1 });
  });
});

describe('recording: migration 27 on a v26 database', () => {
  it('adds the columns with their defaults and the two tables (CASCADE from walkthroughs)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-rec-mig-'));
    const db = new DB(path.join(dir, 'old.db'));
    db.exec('PRAGMA foreign_keys = ON');
    const { migrations } = await import('../src/db/migrations.js');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version <= 26)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    }
    db.prepare("INSERT INTO projects (id, slug, name, settings, created_at, updated_at) VALUES ('p1', 'old', 'Old', '{}', 'x', 'x')").run();
    db.prepare("INSERT INTO walkthroughs (id, project_id, key, label, executor, status, origin, snapshot, actors, vars, summary_note, started_at, updated_at) VALUES ('w1', 'p1', 'k1', '', 'human', 'finished', '', '{}', '{}', '{}', '', 'x', 'x')").run();
    migrate(db);
    expect(db.prepare("SELECT record, recording FROM walkthroughs WHERE id = 'w1'").get()).toEqual({ record: 'off', recording: '{}' });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'walkthrough_recording%'").all() as { name: string }[]).map((t) => t.name).sort();
    expect(tables).toEqual(['walkthrough_recording_chunks', 'walkthrough_recordings']);
    const cols = (db.prepare('PRAGMA table_info(storyboards)').all() as { name: string; dflt_value: string }[]).filter((c) => c.name.startsWith('record'));
    expect(cols.map((c) => [c.name, c.dflt_value])).toEqual([
      ['record', "'off'"],
      ['record_mask_all', '0'],
    ]);
    db.prepare("INSERT INTO walkthrough_recordings (id, walkthrough_id, project_id, segment_no, segment_key, started_at, ended_at, created_at) VALUES ('r1', 'w1', 'p1', 1, 'a', 'x', 'x', 'x')").run();
    db.prepare("INSERT INTO walkthrough_recording_chunks (recording_id, project_id, seq, events_count, bytes, data, created_at) VALUES ('r1', 'p1', 0, 1, 1, x'00', 'x')").run();
    expect(() => db.prepare("INSERT INTO walkthrough_recordings (id, walkthrough_id, project_id, segment_no, segment_key, started_at, ended_at, created_at) VALUES ('r2', 'w1', 'p1', 1, 'b', 'x', 'x', 'x')").run()).toThrow(/UNIQUE/);
    db.exec("DELETE FROM walkthroughs WHERE id = 'w1'");
    expect((db.prepare('SELECT COUNT(*) AS n FROM walkthrough_recording_chunks').get() as { n: number }).n).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
