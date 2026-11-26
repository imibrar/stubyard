/**
 * Run expectations (A2 slice S1, migration 32): set at start (doc and array shorthand), PATCH / PUT replace and
 * append, GET, 400 with the issue path, 409 once the run is stopped, and the migration on a fresh database.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DB, migrate } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { startHub, type RunningHub } from '../src/index.js';
import { DEFAULT_CHECK_NAMES, mergeExpectations, parseExpectations } from '../src/runs/expectations.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

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
let base: string;
let dataDir: string;

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T };
}

const R = '/api/projects/hyper/runs';
const otp: any = { name: 'one OTP email to the customer', kind: 'message', channel: 'email', to: 'customer', otp: true, count: 1 };
const paid: any = { kind: 'payment', status: 'paid', amount: '150.00', currency: 'SAR', count: 1 };
const hooks: any = { kind: 'webhook', url: '/webhooks/moyasar', count: { min: 1 }, each: { status: '2xx' } };

describe('migration 32', () => {
  it('adds runs.expectations and walkthroughs.run_check on a fresh database, once', () => {
    expect(migrations.some((m) => m.version === 32)).toBe(true);
    const db = new DB(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    migrate(db); // idempotent
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; dflt_value: string | null; notnull: number }[]);
    expect(cols('runs').find((c) => c.name === 'expectations')).toMatchObject({ dflt_value: "'{}'", notnull: 1 });
    expect(cols('walkthroughs').some((c) => c.name === 'run_check')).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 32').get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe('expectation parsing', () => {
  it('accepts all six kinds, the array shorthand and defaults', () => {
    const doc = parseExpectations({
      items: [
        otp,
        paid,
        hooks,
        { kind: 'message', unassigned: true, count: 0 },
        { kind: 'provider_call', status: '4xx', count: 0, severity: 'warn' },
        { kind: 'traffic', outcome: ['unmatched', 'invalid'], count: 0, since: '2026-11-26T10:00:00Z' },
        { kind: 'lint', severity: 'error', count: 0 },
      ],
      defaults: { duplicateMessages: false },
    });
    expect(doc.items).toHaveLength(7);
    expect(doc.defaults).toEqual({ duplicateMessages: false });
    expect(parseExpectations([paid])).toEqual({ items: [paid], defaults: true });
    expect(parseExpectations(undefined)).toEqual({ items: [], defaults: true });
    expect(DEFAULT_CHECK_NAMES).toEqual(['providerCalls', 'appCallbacks', 'lintErrors', 'duplicateMessages', 'unassignedMessages', 'failedMessages', 'pendingWork', 'contractErrors']);
  });

  it('rejects bad input with zod issue paths', () => {
    const issue = (input: unknown) => {
      try {
        parseExpectations(input);
      } catch (e) {
        return (e as { statusCode: number; details: { issues: { path: string }[] } }).details.issues[0].path;
      }
      return null;
    };
    expect(issue([otp, paid, { kind: 'message', count: -1 }])).toBe('items[2].count');
    expect(issue([{ kind: 'nope' }])).toBe('items[0].kind');
    expect(issue([{ kind: 'message', chanel: 'sms' }])).toBe('items[0]'); // unknown key
    expect(issue([{ kind: 'webhook', status: '6xx' }])).toBe('items[0].status');
    expect(issue([{ kind: 'message', contains: Array(11).fill('x') }])).toBe('items[0].contains');
    expect(issue([{ kind: 'message', name: 'x'.repeat(121) }])).toBe('items[0].name');
    expect(issue([{ kind: 'payment', amount: '1,50' }])).toBe('items[0].amount');
    expect(issue([{ kind: 'message', count: { min: 3, max: 1 } }])).toBe('items[0].count');
    expect(issue({ defaults: { nope: false } })).toMatch(/^defaults/);
    expect(issue(Array(51).fill(paid))).toBe('items');
  });

  it('merges: replace, append items, overlay defaults', () => {
    const cur = parseExpectations({ items: [otp], defaults: { pendingWork: false } });
    expect(mergeExpectations(cur, { items: [paid] }, false)).toEqual({ items: [paid], defaults: true });
    const app = mergeExpectations(cur, { items: [paid], defaults: { duplicateMessages: false } }, true);
    expect(app.items).toEqual([otp, paid]);
    expect(app.defaults).toMatchObject({ pendingWork: false, duplicateMessages: false, providerCalls: true });
    expect(mergeExpectations(cur, { defaults: false }, true)).toEqual({ items: [otp], defaults: false });
    expect(() => mergeExpectations(parseExpectations(Array(50).fill(paid)), { items: [paid] }, true)).toThrow(/at most 50/);
  });
});

describe.skipIf(!haveMailpit)('run expectations API', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-runs-exp-test-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    const config = loadConfig({
      host: '127.0.0.1',
      httpPort,
      httpsPort,
      smtpPort,
      dataDir,
      webDir: path.join(dataDir, 'no-web'),
      mailpitBin: MAILPIT_BIN,
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Hyper' })).status).toBe(201);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sets expectations at start (doc and shorthand); the view counts the items', async () => {
    const a = await api('POST', R, { key: 'e1', expectations: { items: [otp, paid], defaults: { duplicateMessages: false } } });
    expect(a.status).toBe(201);
    expect(a.body.expectations).toEqual({ items: 2 });
    expect((await api('GET', `${R}/e1/expectations`)).body).toEqual({ items: [otp, paid], defaults: { duplicateMessages: false } });

    const b = await api('POST', R, { key: 'e2', expectations: [hooks] });
    expect(b.status).toBe(201);
    expect((await api('GET', `${R}/${b.body.id}/expectations`)).body).toEqual({ items: [hooks], defaults: true });

    // No expectations: the empty document with defaults on.
    expect((await api('POST', R, { key: 'e3' })).status).toBe(201);
    expect((await api('GET', `${R}/e3/expectations`)).body).toEqual({ items: [], defaults: true });
    expect((await api('GET', `${R}/e3`)).body.expectations).toEqual({ items: 0 });
  });

  it('400 with the issue path; nothing is created or changed', async () => {
    const bad = await api('POST', R, { key: 'e4', expectations: [otp, paid, { kind: 'message', count: -1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('items[2].count');
    expect(bad.body.details.issues[0].path).toBe('items[2].count');
    expect((await api('GET', `${R}/e4`)).status).toBe(404);

    const put = await api('PUT', `${R}/e1/expectations`, { items: [{ kind: 'lint', source: 'nowhere' }] });
    expect(put.status).toBe(400);
    expect(put.body.details.issues[0].path).toBe('items[0].source');
    const patch = await api('PATCH', `${R}/e1`, { label: 'changed', expectations: { defaults: { nope: false } } });
    expect(patch.status).toBe(400);
    const e1 = (await api('GET', `${R}/e1`)).body;
    expect(e1.label).toBe('');
    expect(e1.expectations).toEqual({ items: 2 });
  });

  it('PATCH and PUT replace; PUT ?append=1 appends items and merges defaults', async () => {
    const patch = await api('PATCH', `${R}/e1`, { expectations: [hooks] });
    expect(patch.status).toBe(200);
    expect(patch.body.expectations).toEqual({ items: 1 });
    expect((await api('GET', `${R}/e1/expectations`)).body).toEqual({ items: [hooks], defaults: true });

    const put = await api('PUT', `${R}/e1/expectations`, { items: [otp], defaults: { pendingWork: false } });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ items: [otp], defaults: { pendingWork: false } });

    const app = await api('PUT', `${R}/e1/expectations?append=1`, { items: [paid], defaults: { lintErrors: false } });
    expect(app.status).toBe(200);
    expect(app.body.items).toEqual([otp, paid]);
    expect(app.body.defaults).toMatchObject({ pendingWork: false, lintErrors: false, providerCalls: true });

    // A bare array appends too.
    expect((await api('PUT', `${R}/e1/expectations?append=1`, [hooks])).body.items).toHaveLength(3);
    expect((await api('GET', `${R}/e1/expectations`)).body.items).toEqual([otp, paid, hooks]);
  });

  it('409 once the run is stopped; GET still works', async () => {
    expect((await api('POST', `${R}/e2/stop`)).status).toBe(200);
    const put = await api('PUT', `${R}/e2/expectations`, { items: [otp] });
    expect(put.status).toBe(409);
    expect((await api('PATCH', `${R}/e2`, { expectations: [otp] })).status).toBe(409);
    expect((await api('GET', `${R}/e2/expectations`)).body).toEqual({ items: [hooks], defaults: true });
    expect((await api('GET', `${R}/e2/expectations`.replace('e2', 'nope'))).status).toBe(404);
  });
});
