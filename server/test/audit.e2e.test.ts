import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { adminPasswordHash } from '../src/access/password.js';

/**
 * Audit log (teams plan T3) against a real Postgres: GET /api/audit (instance admins) and
 * GET /api/projects/:slug/audit (project admins, their project only), filters, paging, CSV and the retention prune.
 *
 * Needs STUBYARD_TEST_DATABASE_URL (a database whose name contains "test"); this file works in its own database
 * "<name>_audit", created next to it, so it can run in parallel with test/teams.e2e.test.ts.
 *   ./scripts/test-postgres.sh test/audit.e2e.test.ts
 */

const DB_URL = process.env.STUBYARD_TEST_DATABASE_URL ?? '';
const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const dbName = (() => {
  try {
    return decodeURIComponent(new URL(DB_URL).pathname.slice(1));
  } catch {
    return '';
  }
})();
const ready = !!DB_URL && /test/i.test(dbName) && fs.existsSync(MAILPIT_BIN);
if (!ready) console.warn('[audit.e2e] skipped: set STUBYARD_TEST_DATABASE_URL (or run ./scripts/test-postgres.sh test/audit.e2e.test.ts)');

const ADMIN = 'owner@example.test';
const ADMIN_PW = 'owner password 123';
const PW = 'member password 1';
const DAY = 86_400_000;

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

type Res<T = any> = { status: number; body: T; text: string; headers: Headers };
type Who = { cookie: string; csrf: string; id: string; email: string };
const cookieOf = (r: Res) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ready)('Audit log (Teams mode, Postgres)', () => {
  let running: RunningHub;
  let dataDir: string;
  let base = '';
  let auditUrl = '';
  let admin: Who;
  let alphaAdmin: Who;
  let alphaDev: Who;
  let betaAdmin: Who;
  let outsider: Who;

  async function call<T = any>(method: string, p: string, o: { json?: unknown; as?: Who | null } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    if (o.as) {
      headers.cookie = o.as.cookie;
      if (method !== 'GET') headers['x-stubyard-csrf'] = o.as.csrf;
    }
    let body: string | undefined;
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    }
    const r = await fetch(base + p, { method, headers, body });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T, text, headers: r.headers };
  }
  async function signIn(email: string, password: string): Promise<Who> {
    const r = await call('POST', '/api/auth/login', { json: { email, password } });
    expect(r.status, r.text).toBe(200);
    return { cookie: cookieOf(r), csrf: r.body.csrf, id: r.body.user.id, email };
  }
  async function newUser(email: string, projects: { slug: string; role: string }[]): Promise<Who> {
    const c = await call('POST', '/api/team/users', { as: admin, json: { email, name: email.split('@')[0], projects, password: 'temporary pw 1' } });
    expect(c.status, c.text).toBe(201);
    const w = await signIn(email, 'temporary pw 1');
    expect((await call('POST', '/api/auth/password', { as: w, json: { currentPassword: 'temporary pw 1', newPassword: PW } })).status).toBeLessThan(300);
    return w;
  }
  /** Waits until the fire-and-forget audit writes of the last calls are in. */
  async function settle(): Promise<void> {
    await sleep(150);
  }
  async function sql(q: string, args: unknown[] = []) {
    const c = new pg.Client({ connectionString: auditUrl });
    await c.connect();
    try {
      return (await c.query(q, args)).rows;
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    const auditDb = `${dbName}_audit`;
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${auditDb}"`);
    await c.query(`CREATE DATABASE "${auditDb}"`);
    await c.end();
    const u = new URL(DB_URL);
    u.pathname = '/' + encodeURIComponent(auditDb);
    auditUrl = u.toString();

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-audit-'));
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
      mailpitUrl: 'http://127.0.0.1:' + mpHttp,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
      auditRetentionDays: 365,
      admin: { email: ADMIN, passwordHash: adminPasswordHash(ADMIN, ADMIN_PW, '') },
      databaseUrl: auditUrl,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = 'http://127.0.0.1:' + httpPort;
    admin = await signIn(ADMIN, ADMIN_PW);
    // alpha: created without a slug in the body (the audit row takes it from the answer).
    expect((await call('POST', '/api/projects', { as: admin, json: { name: 'Alpha' } })).body.slug).toBe('alpha');
    expect((await call('POST', '/api/projects', { as: admin, json: { name: 'Beta', slug: 'beta' } })).status).toBe(201);
    alphaAdmin = await newUser('alpha-admin@example.test', [{ slug: 'alpha', role: 'project_admin' }]);
    alphaDev = await newUser('alpha-dev@example.test', [{ slug: 'alpha', role: 'developer' }]);
    betaAdmin = await newUser('beta-admin@example.test', [{ slug: 'beta', role: 'project_admin' }]);
    outsider = await newUser('outsider@example.test', []);
    // A few audited actions.
    expect((await call('PATCH', '/api/projects/alpha', { as: alphaAdmin, json: { description: 'x', settings: { defaultPassword: 'Secret-Default-1', retentionDays: 3 } } })).status).toBe(200);
    expect((await call('GET', '/api/projects/alpha/export?secrets=1', { as: alphaAdmin })).status).toBe(200);
    expect((await call('PATCH', '/api/projects/beta', { as: betaAdmin, json: { name: 'Beta 2' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/login', { json: { email: 'alpha-dev@example.test', password: 'wrong password!' } })).status).toBe(401);
    await settle();
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (auditUrl) {
      const c = new pg.Client({ connectionString: DB_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${dbName}_audit" WITH (FORCE)`).catch(() => undefined);
      await c.end();
    }
  });

  it('serves the whole log to instance admins only, newest first', async () => {
    const r = await call('GET', '/api/audit', { as: admin });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const ids = r.body.entries.map((e: any) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(r.body.entries[0]).toMatchObject({ id: expect.any(Number), at: expect.any(String), action: expect.any(String) });
    expect(r.body.entries.some((e: any) => 'ip' in e)).toBe(true);
    for (const w of [alphaAdmin, alphaDev, betaAdmin, outsider]) expect((await call('GET', '/api/audit', { as: w })).status, w.email).toBe(403);
    expect((await call('GET', '/api/audit')).status).toBe(401);
    expect((await call('GET', '/api/audit/actions', { as: alphaAdmin })).status).toBe(403);
    const acts = await call('GET', '/api/audit/actions', { as: admin });
    expect(acts.body.actions).toEqual(expect.arrayContaining(['auth.login', 'auth.login_failed', 'project.create', 'project.settings', 'project.export', 'member.add', 'user.create']));
    expect(acts.body.actions).toEqual([...acts.body.actions].sort());
  });

  it('records the slug of a project created without one, the changed settings (names only) and exports', async () => {
    const all = (await call('GET', '/api/audit?limit=500', { as: admin })).body.entries as any[];
    expect(all.find((e) => e.action === 'project.create' && e.project === 'alpha')).toMatchObject({ user: { id: admin.id, email: ADMIN } });
    const s = all.find((e) => e.action === 'project.settings' && e.project === 'alpha');
    expect(s.detail.fields).toEqual(['description', 'settings.defaultPassword', 'settings.retentionDays']);
    expect(s.user.email).toBe('alpha-admin@example.test');
    expect(all.find((e) => e.action === 'project.export')).toMatchObject({ project: 'alpha', detail: { secrets: true } });
    expect(JSON.stringify(all)).not.toContain('Secret-Default-1');
    expect(JSON.stringify(all)).not.toContain(PW);
  });

  it('gives project admins their own project only, without client addresses', async () => {
    const r = await call('GET', '/api/projects/alpha/audit?limit=500', { as: alphaAdmin });
    expect(r.status, r.text).toBe(200);
    const rows = r.body.entries as any[];
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((e) => e.project === 'alpha')).toBe(true);
    expect(rows.some((e) => 'ip' in e)).toBe(false);
    // The free text does not match the hidden client address either (the admin view does).
    const ip = ((await call('GET', '/api/audit?project=alpha&limit=1', { as: admin })).body.entries[0] as any).ip as string;
    expect(ip).toBeTruthy();
    expect((await call('GET', '/api/audit?project=alpha&q=' + encodeURIComponent(ip), { as: admin })).body.entries.length).toBeGreaterThan(0);
    expect((await call('GET', '/api/projects/alpha/audit?q=' + encodeURIComponent(ip), { as: alphaAdmin })).body.entries).toEqual([]);
    expect(rows.map((e) => e.action)).toEqual(expect.arrayContaining(['project.create', 'member.add', 'project.settings', 'project.export']));
    // ?project= cannot widen the view.
    const sneaky = await call('GET', '/api/projects/alpha/audit?project=beta', { as: alphaAdmin });
    expect(sneaky.body.entries.every((e: any) => e.project === 'alpha')).toBe(true);
    // Another project: 404 like any project the member is not in; a developer of the project: 403.
    expect((await call('GET', '/api/projects/beta/audit', { as: alphaAdmin })).status).toBe(404);
    expect((await call('GET', '/api/projects/alpha/audit', { as: alphaDev })).status).toBe(403);
    expect((await call('GET', '/api/projects/alpha/audit', { as: outsider })).status).toBe(404);
    expect((await call('GET', '/api/projects/beta/audit', { as: betaAdmin })).body.entries.every((e: any) => e.project === 'beta')).toBe(true);
    // Instance admins can read a project's view too.
    expect((await call('GET', '/api/projects/alpha/audit', { as: admin })).status).toBe(200);
    const acts = await call('GET', '/api/projects/alpha/audit/actions', { as: alphaAdmin });
    expect(acts.body.actions).toContain('project.export');
    expect(acts.body.actions).not.toContain('auth.login');
  });

  it('hides rows of an earlier project with the same slug from the project view', async () => {
    expect((await call('POST', '/api/projects', { as: admin, json: { name: 'Gamma', slug: 'gamma' } })).status).toBe(201);
    await settle();
    await sql("UPDATE audit_log SET at = now() - interval '2 days' WHERE project_slug = 'gamma'");
    expect((await call('GET', '/api/projects/gamma/audit', { as: admin })).body.entries).toEqual([]);
    expect((await call('GET', '/api/projects/gamma/audit/actions', { as: admin })).body.actions).toEqual([]);
    expect((await call('GET', '/api/audit?project=gamma', { as: admin })).body.entries.length).toBeGreaterThan(0);
    // No margin: a row from just before this project's creation (an earlier project with the slug) stays hidden.
    const created = (await call('GET', '/api/projects/gamma', { as: admin })).body.createdAt as string;
    await sql(`UPDATE audit_log SET at = $1::timestamptz - interval '1 second', action = 'project.reset' WHERE project_slug = 'gamma'`, [created]);
    expect((await call('GET', '/api/projects/gamma/audit', { as: admin })).body.entries).toEqual([]);
    expect((await call('GET', '/api/projects/gamma/audit/actions', { as: admin })).body.actions).toEqual([]);
    await sql(`UPDATE audit_log SET at = $1::timestamptz WHERE project_slug = 'gamma'`, [created]);
    expect((await call('GET', '/api/projects/gamma/audit/actions', { as: admin })).body.actions).toEqual(['project.reset']);
  });

  it('filters by user (id or e-mail), project, action (exact or prefix), time and text', async () => {
    const q = async (qs: string, as: Who = admin) => {
      const r = await call('GET', '/api/audit?limit=500&' + qs, { as });
      expect(r.status, qs + ' ' + r.text).toBe(200);
      return r.body.entries as any[];
    };
    const byEmail = await q('user=ALPHA-ADMIN@example.test');
    expect(byEmail.length).toBeGreaterThan(0);
    expect(byEmail.every((e) => e.user?.id === alphaAdmin.id)).toBe(true);
    expect((await q('user=' + alphaAdmin.id)).length).toBe(byEmail.length);
    expect((await q('project=beta')).every((e) => e.project === 'beta')).toBe(true);
    const logins = await q('action=auth.login');
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((e) => e.action === 'auth.login')).toBe(true);
    const auth = await q('action=auth.*');
    expect(new Set(auth.map((e) => e.action))).toEqual(new Set(['auth.login', 'auth.login_failed']));
    const two = await q('action=member.add,project.export');
    expect(new Set(two.map((e) => e.action))).toEqual(new Set(['member.add', 'project.export']));
    const failed = await q('q=alpha-dev@example.test&action=auth.login_failed');
    expect(failed.length).toBe(1);
    expect(failed[0].target).toBe('alpha-dev@example.test');
    expect((await q('q=defaultPassword')).some((e) => e.action === 'project.settings')).toBe(true); // in the details
    expect(await q('q=100%25_')).toEqual([]); // LIKE wildcards are literal
    const future = new Date(Date.now() + DAY).toISOString();
    expect(await q('from=' + encodeURIComponent(future))).toEqual([]);
    expect((await q('to=' + encodeURIComponent(future))).length).toBeGreaterThan(5);
    const today = new Date().toISOString().slice(0, 10);
    expect((await q('from=' + today + '&to=' + today)).length).toBeGreaterThan(5); // a date "to" includes that day
    expect(await q('to=2000-01-01')).toEqual([]);
    for (const bad of ['from=yesterday', 'action=' + encodeURIComponent('drop table'), 'limit=0', 'limit=501', 'before=-1', 'q=' + 'x'.repeat(201)]) {
      expect((await call('GET', '/api/audit?' + bad, { as: admin })).status, bad).toBe(400);
    }
  });

  it('pages by id with nextBefore, without gaps or repeats', async () => {
    const all = (await call('GET', '/api/audit?limit=500', { as: admin })).body.entries.map((e: any) => e.id);
    expect(all.length).toBeGreaterThan(6);
    const seen: number[] = [];
    let before: number | null = null;
    for (let i = 0; i < 100; i++) {
      const r: Res = await call('GET', '/api/audit?limit=3' + (before ? '&before=' + before : ''), { as: admin });
      expect(r.body.entries.length).toBeLessThanOrEqual(3);
      seen.push(...r.body.entries.map((e: any) => e.id));
      before = r.body.nextBefore;
      if (before === null) break;
      expect(before).toBe(r.body.entries[r.body.entries.length - 1].id);
    }
    expect(seen).toEqual(all);
    // Filters and paging together.
    const p1 = await call('GET', '/api/audit?action=member.add&limit=1', { as: admin });
    const p2 = await call('GET', '/api/audit?action=member.add&limit=1&before=' + p1.body.nextBefore, { as: admin });
    expect(p2.body.entries[0].action).toBe('member.add');
    expect(p2.body.entries[0].id).toBeLessThan(p1.body.entries[0].id);
  });

  it('exports the filtered rows as CSV (formula-safe)', async () => {
    await running.hub.access.audit(null, 'test.csv', { target: '=HYPERLINK("x")', detail: { note: 'a, "quoted"\nline' } });
    const r = await fetch(base + '/api/audit?format=csv&action=test.csv', { headers: { cookie: admin.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="stubyard-audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await r.text();
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe('id,at,user_email,user_id,action,project,target,ip,detail');
    expect(text).toContain('"\'=HYPERLINK(""x"")"');
    expect(text).toContain('test.csv');
    const proj = await fetch(base + '/api/projects/alpha/audit?format=csv', { headers: { cookie: alphaAdmin.cookie } });
    const ptext = await proj.text();
    expect(ptext.split('\r\n')[0]).toBe('id,at,user_email,user_id,action,project,target,detail');
    expect(proj.headers.get('content-disposition')).toContain('stubyard-audit-alpha-');
    expect((await fetch(base + '/api/audit?format=csv', { headers: { cookie: alphaAdmin.cookie } })).status).toBe(403);
  });

  it('prunes rows past STUBYARD_AUDIT_RETENTION_DAYS in the maintenance job (0 keeps them)', async () => {
    await sql("INSERT INTO audit_log (at, action, target) VALUES (now() - interval '400 days', 'test.old', 'old'), (now() - interval '300 days', 'test.recent', 'recent')");
    const cfg = running.hub.config as { auditRetentionDays: number };
    cfg.auditRetentionDays = 0;
    let rep = await running.hub.maintenance.run();
    expect(rep.auditPurged).toBeUndefined();
    expect((await sql("SELECT count(*)::int AS n FROM audit_log WHERE action = 'test.old'"))[0].n).toBe(1);
    cfg.auditRetentionDays = 365;
    rep = await running.hub.maintenance.run();
    expect(rep.error).toBeUndefined();
    expect(rep.auditPurged).toBe(1);
    expect((await sql("SELECT action FROM audit_log WHERE action LIKE 'test.%' ORDER BY action")).map((r) => r.action)).toEqual(['test.csv', 'test.recent']);
    // A later "now" (as the job sees it) prunes the 300-day row too.
    rep = await running.hub.maintenance.run(Date.now() + 100 * DAY);
    expect(rep.auditPurged).toBeGreaterThanOrEqual(1);
    expect((await sql("SELECT count(*)::int AS n FROM audit_log WHERE action = 'test.recent'"))[0].n).toBe(0);
    // The maintenance run itself is audited (through the API).
    expect((await call('POST', '/api/system/maintenance', { as: admin })).status).toBe(200);
    await settle();
    expect((await call('GET', '/api/audit?action=system.maintenance', { as: admin })).body.entries.length).toBe(1);
    const storage = await call('GET', '/api/system/storage', { as: admin });
    expect(storage.body.retention.auditRetentionDays).toBe(365);
  });
});
