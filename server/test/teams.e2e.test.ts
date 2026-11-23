import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { adminPasswordHash } from '../src/access/password.js';
import type { PgAuthStore } from '../src/access/pg-store.js';

/**
 * Teams mode (teams plan T2) end to end against a real Postgres: roles per project, cross-project isolation (lists,
 * SSE, MCP, export, logs, mail), invites, disabled users, must-change-password, membership hooks, narrowed tokens,
 * schedules acting as their creator, audit rows and the factory reset.
 *
 * Needs STUBYARD_TEST_DATABASE_URL pointing at a throwaway database whose name contains "test" (the schema
 * "stubyard" in it is dropped first). ./scripts/test-postgres.sh starts one in Docker and runs this file.
 */

const DB_URL = process.env.STUBYARD_TEST_DATABASE_URL ?? '';
const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);
const dbName = (() => {
  try {
    return decodeURIComponent(new URL(DB_URL).pathname.slice(1));
  } catch {
    return '';
  }
})();
const ready = !!DB_URL && /test/i.test(dbName) && haveMailpit;
if (!ready) {
  console.warn(
    !DB_URL
      ? '[teams.e2e] skipped: set STUBYARD_TEST_DATABASE_URL (or run ./scripts/test-postgres.sh) to run the Teams mode tests against Postgres'
      : !/test/i.test(dbName)
        ? '[teams.e2e] skipped: the database name in STUBYARD_TEST_DATABASE_URL must contain "test" (its stubyard schema is dropped)'
        : '[teams.e2e] skipped: no Mailpit binary',
  );
}

const ADMIN = 'owner@example.test';
const ADMIN_PW = 'owner password 123';
const PW = 'member password 1';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (r: Res) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const ROLES = ['project_admin', 'project_manager', 'developer', 'designer', 'qa', 'viewer'] as const;
type R = (typeof ROLES)[number];

describe.skipIf(!ready)('Teams mode (Postgres)', () => {
  let running: RunningHub;
  let dataDir: string;
  let base = '';
  let smtpPort = 0;
  let admin: Who;
  const members = {} as Record<R, Who>;
  let outsider: Who;
  let bob: Who; // developer in beta only
  let appServer: http.Server;
  let appUrl = '';
  const hits: string[] = [];

  async function call<T = any>(method: string, p: string, o: { json?: unknown; as?: Who | null; headers?: Record<string, string>; form?: string } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.as) {
      headers.cookie = o.as.cookie;
      if (method !== 'GET' && method !== 'HEAD') headers['x-stubyard-csrf'] = o.as.csrf;
    }
    let body: string | undefined;
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = o.form;
    }
    const r = await fetch(base + p, { method, headers, body, redirect: 'manual' });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T, text, headers: r.headers };
  }
  const bearer = (t: string) => ({ authorization: 'Bearer ' + t });
  const store = () => running.hub.access.store as PgAuthStore;

  async function login(email: string, password: string): Promise<Res> {
    return call('POST', '/api/auth/login', { json: { email, password } });
  }
  async function signIn(email: string, password: string): Promise<Who> {
    const r = await login(email, password);
    expect(r.status, r.text).toBe(200);
    return { cookie: cookieOf(r), csrf: r.body.csrf, id: r.body.user.id, email };
  }
  /** Admin creates the user with a temporary password; the user signs in and picks their own. */
  async function newUser(email: string, projects: { slug: string; role: string }[], role = 'member'): Promise<Who> {
    const c = await call('POST', '/api/team/users', { as: admin, json: { email, name: email.split('@')[0], role, projects, password: 'temporary pw 1' } });
    expect(c.status, c.text).toBe(201);
    const w = await signIn(email, 'temporary pw 1');
    const ch = await call('POST', '/api/auth/password', { as: w, json: { currentPassword: 'temporary pw 1', newPassword: PW } });
    expect(ch.status, ch.text).toBeLessThan(300);
    return w;
  }

  beforeAll(async () => {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS stubyard CASCADE');
    await c.end();

    appServer = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = 'http://127.0.0.1:' + (appServer.address() as net.AddressInfo).port;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-teams-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
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
      admin: { email: ADMIN, passwordHash: adminPasswordHash(ADMIN, ADMIN_PW, '') },
      databaseUrl: DB_URL,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = 'http://127.0.0.1:' + httpPort;
    admin = await signIn(ADMIN, ADMIN_PW);
    for (const [slug, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
      const p = await call('POST', '/api/projects', { as: admin, json: { name, slug, generateUsers: { customers: 1 } } });
      expect(p.status, p.text).toBe(201);
    }
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    appServer?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts in Teams mode with the env admin as instance admin, and reports Postgres health', async () => {
    expect(running.hub.access.mode).toBe('teams');
    const me = await call('GET', '/api/auth/me', { as: admin });
    expect(me.body).toMatchObject({ mode: 'teams', user: { email: ADMIN, role: 'admin', envAdmin: true, mustChangePassword: false }, projects: null });
    expect(me.body.roles.map((r: any) => r.id)).toEqual(expect.arrayContaining([...ROLES]));
    const sys = await call('GET', '/api/system', { as: admin });
    expect(sys.body.teams).toBe(true);
    expect(sys.body.postgres).toMatchObject({ ok: true, schemaVersion: expect.any(Number), serverVersion: expect.any(String) });
    expect(JSON.stringify(sys.body)).not.toContain(DB_URL);
    // Anonymous: the minimal public answer only.
    expect((await call('GET', '/api/system')).body).toEqual({ name: 'stubyard', version: expect.any(String), authRequired: true });
  });

  it('creates users with must_change_password: only /me, logout and the password change work until it is changed', async () => {
    const c = await call('POST', '/api/team/users', { as: admin, json: { email: 'Temp@Example.test', name: 'Temp', projects: [{ slug: 'alpha', role: 'viewer' }] } });
    expect(c.status, c.text).toBe(201);
    expect(c.body.temporaryPassword).toEqual(expect.any(String));
    expect(c.body.user).toMatchObject({ email: 'temp@example.test', role: 'member', mustChangePassword: true });
    expect((await call('POST', '/api/team/users', { as: admin, json: { email: 'temp@example.test' } })).status).toBe(409);
    const r = await login('temp@example.test', c.body.temporaryPassword);
    expect(r.status).toBe(200);
    expect(r.body.user.mustChangePassword).toBe(true);
    const w: Who = { cookie: cookieOf(r), csrf: r.body.csrf, id: r.body.user.id, email: 'temp@example.test' };
    const blocked = await call('GET', '/api/projects', { as: w });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('must_change_password');
    expect((await call('GET', '/api/auth/me', { as: w })).status).toBe(200);
    expect((await call('POST', '/api/auth/password', { as: w, json: { currentPassword: 'wrong one!', newPassword: PW } })).status).toBe(400); // not 401: that would sign the dashboard out
    expect((await call('POST', '/api/auth/password', { as: w, json: { currentPassword: c.body.temporaryPassword, newPassword: 'short' } })).status).toBe(400);
    const second = await signIn('temp@example.test', c.body.temporaryPassword);
    expect((await call('POST', '/api/auth/password', { as: w, json: { currentPassword: c.body.temporaryPassword, newPassword: PW } })).status).toBeLessThan(300);
    // This session goes on; the other session of the account ended.
    expect((await call('GET', '/api/projects', { as: w })).status).toBe(200);
    expect((await call('GET', '/api/auth/me', { as: second })).body.user).toBeNull();
    expect((await login('temp@example.test', c.body.temporaryPassword)).status).toBe(401);
    expect((await login('temp@example.test', PW)).body.user.mustChangePassword).toBe(false);
    // The env admin's password lives in the environment.
    expect((await call('POST', '/api/auth/password', { as: admin, json: { currentPassword: ADMIN_PW, newPassword: 'another one 1' } })).status).toBe(409);
    expect((await call('POST', '/api/team/users/' + admin.id + '/reset-password', { as: admin, json: {} })).status).toBe(409);
  });

  it('sets up one member per role in alpha, an outsider and a beta developer', async () => {
    for (const role of ROLES) members[role] = await newUser(role.replace('_', '-') + '@example.test', [{ slug: 'alpha', role }]);
    outsider = await newUser('outsider@example.test', []);
    bob = await newUser('bob@example.test', [{ slug: 'beta', role: 'developer' }]);
    const me = await call('GET', '/api/auth/me', { as: members.qa });
    expect(me.body).toMatchObject({ mode: 'teams', user: { role: 'member', envAdmin: false }, projects: { alpha: 'qa' } });
    const list = await call('GET', '/api/projects/alpha/members', { as: members.viewer });
    expect(list.status).toBe(200);
    expect(list.body.canManage).toBe(false);
    expect(list.body.members.map((m: any) => m.role).sort()).toEqual([...ROLES, 'viewer'].sort()); // + temp (viewer)
    expect((await call('GET', '/api/projects/alpha/members', { as: members.project_admin })).body.canManage).toBe(true);
  });

  it('enforces the role x route matrix', async () => {
    const feat = await call('POST', '/api/projects/alpha/features', { as: admin, json: { title: 'Matrix feature' } });
    expect(feat.status, feat.text).toBe(201);
    const ref = feat.body.key;
    /** loose: an allowed call may still fail in the handler (e.g. 404 for a missing record), as long as it is not 403. */
    type Case = { name: string; allowed: R[]; loose?: boolean; run: (w: Who, role: R) => Promise<Res> };
    const cases: Case[] = [
      { name: 'GET project', allowed: [...ROLES], run: (w) => call('GET', '/api/projects/alpha', { as: w }) },
      { name: 'GET messages', allowed: [...ROLES], run: (w) => call('GET', '/api/projects/alpha/messages', { as: w }) },
      { name: 'GET members', allowed: [...ROLES], run: (w) => call('GET', '/api/projects/alpha/members', { as: w }) },
      { name: 'PATCH project settings', allowed: ['project_admin'], run: (w) => call('PATCH', '/api/projects/alpha', { as: w, json: { name: 'Alpha' } }) },
      { name: 'GET export', allowed: ['project_admin'], run: (w) => call('GET', '/api/projects/alpha/export', { as: w }) },
      { name: 'GET member candidates', allowed: ['project_admin'], run: (w) => call('GET', '/api/projects/alpha/members/candidates', { as: w }) },
      { name: 'POST provider', allowed: ['project_admin', 'developer'], run: (w, r) => call('POST', '/api/projects/alpha/providers', { as: w, json: { preset: 'twilio', slug: 'sms-' + r.replace('_', '-') } }) },
      { name: 'POST feature', allowed: ['project_admin', 'project_manager', 'developer', 'qa'], run: (w, r) => call('POST', '/api/projects/alpha/features', { as: w, json: { title: 'By ' + r } }) },
      { name: 'PATCH feature details', allowed: [...ROLES.filter((r) => r !== 'viewer')], run: (w, r) => call('PATCH', '/api/projects/alpha/features/' + ref, { as: w, json: { details: 'Edited by ' + r } }) },
      { name: 'PATCH feature title', allowed: ['project_admin', 'project_manager', 'developer', 'qa'], run: (w, r) => call('PATCH', '/api/projects/alpha/features/' + ref, { as: w, json: { title: 'T ' + r } }) },
      { name: 'DELETE storyboard', allowed: ['project_admin', 'project_manager', 'developer', 'qa'], loose: true, run: (w) => call('DELETE', '/api/projects/alpha/storyboards/no-such-board', { as: w }) },
      { name: 'POST test user', allowed: ['project_admin', 'project_manager', 'developer', 'qa'], run: (w, r) => call('POST', '/api/projects/alpha/users', { as: w, json: { name: 'User ' + r } }) },
      { name: 'POST member', allowed: ['project_admin'], run: (w) => call('POST', '/api/projects/alpha/members', { as: w, json: { userId: outsider.id, role: 'viewer' } }) },
      { name: 'DELETE project (instance admin)', allowed: [], run: (w) => call('DELETE', '/api/projects/alpha', { as: w }) },
      { name: 'POST project (instance admin)', allowed: [], run: (w, r) => call('POST', '/api/projects', { as: w, json: { name: 'New ' + r } }) },
      { name: 'GET team users (instance admin)', allowed: [], run: (w) => call('GET', '/api/team/users', { as: w }) },
      { name: 'GET /mailpit (instance admin)', allowed: [], run: (w) => call('GET', '/mailpit/api/v1/messages', { as: w }) },
      { name: 'POST factory reset (instance admin)', allowed: [], run: (w) => call('POST', '/api/factory-reset', { as: w, json: { confirm: 'DELETE EVERYTHING' } }) },
    ];
    const wrong: string[] = [];
    for (const c of cases) {
      for (const role of ROLES) {
        await call('DELETE', '/api/projects/alpha/members/' + outsider.id, { as: admin }); // "POST member" adds them
        const r = await c.run(members[role], role);
        const ok = c.loose ? r.status !== 403 && r.status !== 401 : r.status < 300;
        if (ok !== c.allowed.includes(role) || (!ok && r.status !== 403)) wrong.push(c.name + ' as ' + role + ': ' + r.status + ' ' + r.text.slice(0, 120));
      }
      // Not a member: the project does not exist for them.
      const o = await c.run(outsider, 'viewer');
      await call('DELETE', '/api/projects/alpha/members/' + outsider.id, { as: admin }); // "POST member" adds them
      const expectOutsider = c.name.includes('instance admin') && !c.name.startsWith('DELETE project') ? 403 : 404;
      if (o.status !== expectOutsider) wrong.push(c.name + ' as outsider: ' + o.status + ' ' + o.text.slice(0, 120));
      if (o.status === 404 && o.body?.error !== 'Project "alpha" not found') wrong.push(c.name + ' as outsider: 404 without "not found"');
    }
    expect(wrong).toEqual([]);
    // Reset: project admins only.
    for (const role of ROLES.filter((r) => r !== 'project_admin')) expect((await call('POST', '/api/projects/alpha/reset', { as: members[role], json: {} })).status, role).toBe(403);
    expect((await call('POST', '/api/projects/alpha/reset', { as: members.project_admin, json: {} })).status).toBeLessThan(300);
  });

  it('keeps projects apart: list, project routes, logs, messages and mail', async () => {
    const list = await call('GET', '/api/projects', { as: bob });
    expect(list.body.map((p: any) => p.slug)).toEqual(['beta']);
    expect((await call('GET', '/api/projects', { as: outsider })).body).toEqual([]);
    expect((await call('GET', '/api/projects', { as: admin })).body.map((p: any) => p.slug).sort()).toEqual(['alpha', 'beta']);
    const nf = await call('GET', '/api/projects/alpha/users', { as: bob });
    expect(nf.status).toBe(404);
    expect(nf.body.error).toBe('Project "alpha" not found');
    expect((await call('GET', '/api/projects/alpha/export', { as: bob })).status).toBe(404);
    expect((await call('GET', '/api/stream?project=alpha', { as: bob })).status).toBe(404);

    // A traffic log in alpha (open /mock route), invisible to bob.
    const users = (await call('GET', '/api/projects/alpha/users', { as: admin })).body as any[];
    await call('POST', '/api/projects/alpha/providers', { as: admin, json: { preset: 'twilio', slug: 'sms' } });
    const sms = await call('POST', '/mock/alpha/sms/2010-04-01/Accounts/ACtest/Messages.json', { form: new URLSearchParams({ To: users[0].phone, From: '+15550001111', Body: 'secret alpha 4242' }).toString() });
    expect(sms.status, sms.text).toBe(201);
    const logId = sms.headers.get('x-hub-request-id')!;
    expect((await call('GET', '/api/logs/' + logId, { as: members.viewer })).status).toBe(200);
    expect((await call('GET', '/api/logs/' + logId, { as: bob })).status).toBe(404);
    const bobLogs = await call('GET', '/api/logs', { as: bob });
    expect(bobLogs.status).toBe(200);
    expect(bobLogs.text).not.toContain('secret alpha');
    expect((await call('GET', '/api/logs?project=alpha', { as: bob })).status).toBe(404);
    expect((await call('GET', '/api/logs?project=none', { as: bob })).body).toEqual(expect.anything());
    expect((await call('GET', '/api/logs', { as: members.viewer })).text).toContain(logId);

    // Mail in alpha: members read it through the filtered routes, others get 404, raw Mailpit is admin only.
    await nodemailer
      .createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'alpha', pass: 'x' } })
      .sendMail({
        from: 'a@alpha.app',
        to: users[0].email,
        subject: 'Alpha mail',
        text: 'Code 777111',
        html: '<p>Code <b>777111</b></p><script>parent.stolen = 1</script>',
        attachments: [
          { filename: 'evil.html', content: '<script>alert(document.cookie)</script>', contentType: 'text/html' },
          { filename: 'evil.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', contentType: 'image/svg+xml' },
          { filename: 'dot.png', content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), contentType: 'image/png' },
        ],
      });
    let msgs: any[] = [];
    for (let i = 0; i < 100 && !msgs.some((m) => m.subject === 'Alpha mail'); i++) {
      msgs = (await call('GET', '/api/projects/alpha/messages', { as: members.viewer })).body;
      await sleep(50);
    }
    const m = msgs.find((x) => x.subject === 'Alpha mail');
    expect(m).toBeTruthy();
    const detail = await call('GET', '/api/messages/' + m.id, { as: members.viewer });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body.mailpit ?? {})).not.toContain('/mailpit/');
    expect((await call('GET', '/api/messages/' + m.id, { as: bob })).status).toBe(404);
    const text = await call('GET', '/api/messages/' + m.id + '/mail/text', { as: members.viewer });
    expect(text.status).toBe(200);
    expect(text.text).toContain('777111');
    const html = await call('GET', '/api/messages/' + m.id + '/mail/html', { as: members.viewer });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html.headers.get('content-type')).toContain('text/html');
    // Attachments: HTML and SVG never render on stubyard's origin; raster images may show inline.
    const det = await call('GET', '/api/messages/' + m.id + '/mail/detail', { as: members.viewer });
    expect(det.status).toBe(200);
    const parts = det.body.Attachments as { FileName: string; PartID: string }[];
    const part = async (name: string) => call('GET', '/api/messages/' + m.id + '/mail/part/' + parts.find((p) => p.FileName === name)!.PartID, { as: members.viewer });
    for (const name of ['evil.html', 'evil.svg']) {
      const p = await part(name);
      expect(p.status, name).toBe(200);
      expect(p.headers.get('content-disposition'), name).toMatch(/^attachment;/);
      expect(p.headers.get('content-security-policy'), name).toContain('sandbox');
      expect(p.headers.get('content-security-policy'), name).toContain("default-src 'none'");
      expect(p.headers.get('x-content-type-options'), name).toBe('nosniff');
    }
    const png = await part('dot.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(png.headers.get('content-security-policy')).toContain('sandbox');
    const raw = await call('GET', '/api/messages/' + m.id + '/mail/raw', { as: members.viewer });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(raw.headers.get('content-security-policy')).toContain('sandbox');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await call('GET', '/api/messages/' + m.id + '/mail/text', { as: members.viewer })).headers.get('content-security-policy')).toContain('sandbox');
    expect((await call('GET', '/api/messages/' + m.id + '/mail/text', { as: bob })).status).toBe(404);
    expect((await call('GET', '/api/messages/' + m.id + '/mail/raw', { as: bob })).status).toBe(404);
    expect((await call('POST', '/api/messages/' + m.id + '/read', { as: bob, json: {} })).status).toBe(404);
    expect((await call('GET', '/mailpit/api/v1/messages', { as: members.viewer })).status).toBe(403);
    expect((await call('GET', '/mailpit/api/v1/messages', { as: admin })).status).toBe(200);
    // Storyboard matching and lint only see the caller's projects.
    expect((await call('GET', '/api/lint/check?project=alpha', { as: bob })).status).toBe(404);
  });

  it('filters the event stream per member', async () => {
    const projects = (await call('GET', '/api/projects', { as: admin })).body as any[];
    const alphaId = projects.find((p) => p.slug === 'alpha').id;
    const betaId = projects.find((p) => p.slug === 'beta').id;
    const open = async (w: Who) => {
      const ac = new AbortController();
      const r = await fetch(base + '/api/stream', { headers: { cookie: w.cookie, accept: 'text/event-stream' }, signal: ac.signal });
      expect(r.status).toBe(200);
      let text = '';
      const reader = r.body!.getReader();
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
          }
        } catch {
          /* aborted */
        }
      })();
      return { get text() { return text; }, close: async () => { ac.abort(); await pump; } };
    };
    const sBob = await open(bob);
    const sAdmin = await open(admin);
    const sView = await open(members.viewer);
    await sleep(100);
    await call('POST', '/api/projects/alpha/features', { as: admin, json: { title: 'SSE alpha' } });
    await call('POST', '/api/projects/beta/features', { as: admin, json: { title: 'SSE beta' } });
    await sleep(400);
    await Promise.all([sBob.close(), sAdmin.close(), sView.close()]);
    expect(sBob.text).toContain(betaId);
    expect(sBob.text).not.toContain(alphaId);
    expect(sView.text).toContain(alphaId);
    expect(sView.text).not.toContain(betaId);
    expect(sAdmin.text).toContain(alphaId);
    expect(sAdmin.text).toContain(betaId);
  });

  it('ends a member\'s stream when they are removed from the project', async () => {
    const tmp = await newUser('streamer@example.test', [{ slug: 'beta', role: 'viewer' }]);
    const ac = new AbortController();
    const r = await fetch(base + '/api/stream?project=beta', { headers: { cookie: tmp.cookie }, signal: ac.signal });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    await reader.read();
    expect((await call('DELETE', '/api/projects/beta/members/' + tmp.id, { as: admin })).status).toBeLessThan(300);
    const end = await Promise.race([(async () => { for (;;) { const x = await reader.read(); if (x.done) return 'ended'; } })(), sleep(3000).then(() => 'open')]);
    ac.abort();
    expect(end).toBe('ended');
  });

  it('filters /mcp: the tools list and every call run with the caller\'s permissions', async () => {
    const tok = await call('POST', '/api/auth/tokens', { as: members.developer, json: { name: 'mcp' } });
    expect(tok.status, tok.text).toBe(201);
    const mcp = (method: string, params: unknown, t = tok.body.secret) => call('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method, params }, headers: bearer(t) });
    const names = ((await mcp('tools/list', {})).body.result.tools as any[]).map((t) => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('get_messages');
    expect(names).not.toContain('create_project');
    expect(names).not.toContain('export_project'); // project.settings: project admins
    const adminTok = await call('POST', '/api/auth/tokens', { as: admin, json: { name: 'mcp admin' } });
    const adminNames = ((await mcp('tools/list', {}, adminTok.body.secret)).body.result.tools as any[]).map((t) => t.name);
    expect(adminNames).toEqual(expect.arrayContaining(['create_project', 'export_project']));

    const lp = await mcp('tools/call', { name: 'list_projects', arguments: {} });
    expect(lp.body.result.isError).toBeFalsy();
    expect(lp.body.result.content[0].text).toContain('alpha');
    expect(lp.body.result.content[0].text).not.toContain('beta');
    const other = await mcp('tools/call', { name: 'get_messages', arguments: { project: 'beta' } });
    expect(other.body.result.isError).toBe(true);
    expect(other.body.result.content[0].text).toContain('not found');
    const exp = await mcp('tools/call', { name: 'export_project', arguments: { project: 'alpha' } });
    expect(exp.body.result.isError).toBe(true);
    const cp = await mcp('tools/call', { name: 'create_project', arguments: { name: 'Sneaky' } });
    expect(cp.body.result.isError).toBe(true);
    expect((await call('GET', '/api/projects', { as: admin })).body.some((p: any) => p.name === 'Sneaky')).toBe(false);
    // An acting ticket only counts on stubyard's own in-process calls: from outside the header is ignored.
    const ticket = running.hub.access.actingHeadersFor({ userKey: admin.id });
    expect(Object.keys(ticket)).toEqual(['x-stubyard-acting']);
    expect((await call('GET', '/api/team/users', { headers: ticket })).status).toBe(401);
    expect((await call('GET', '/api/team/users', { headers: { ...ticket, ...bearer(tok.body.secret) } })).status).toBe(403);
    // The MCP tester's "this server" credential is confined to its project.
    const self = running.hub.access.selfAuthHeaders('alpha');
    expect((await call('GET', '/api/projects', { headers: self })).body.map((p: any) => p.slug)).toEqual(['alpha']);
    expect((await call('GET', '/api/projects/beta', { headers: self })).status).toBe(404);
    expect((await call('GET', '/api/team/users', { headers: self })).status).toBe(403);
  });

  it('narrows tokens to projects and a highest role', async () => {
    const mk = async (w: Who, json: unknown) => call('POST', '/api/auth/tokens', { as: w, json });
    expect((await mk(bob, { name: 'x', projects: ['alpha'] })).status).toBe(400); // not a member
    expect((await mk(bob, { name: 'x', maxRole: 'admin' })).status).toBe(400);
    const ro = await mk(members.developer, { name: 'read only', maxRole: 'viewer' });
    expect(ro.status, ro.text).toBe(201);
    expect(ro.body.token).toMatchObject({ projects: null, maxRole: 'viewer' });
    expect((await call('GET', '/api/projects/alpha/users', { headers: bearer(ro.body.secret) })).status).toBe(200);
    expect((await call('POST', '/api/projects/alpha/features', { json: { title: 'no' }, headers: bearer(ro.body.secret) })).status).toBe(403);
    const one = await mk(admin, { name: 'beta only', projects: ['beta'] });
    expect(one.status, one.text).toBe(201);
    const t = bearer(one.body.secret);
    expect((await call('GET', '/api/projects', { headers: t })).body.map((p: any) => p.slug)).toEqual(['beta']);
    expect((await call('GET', '/api/projects/alpha', { headers: t })).status).toBe(404);
    expect((await call('GET', '/api/team/users', { headers: t })).status).toBe(403);
    expect((await call('POST', '/api/projects/beta/features', { json: { title: 'by token' }, headers: t })).status).toBe(201);
    // A member's token follows the member: a role change applies at once.
    const dev = await mk(bob, { name: 'bob' });
    expect((await call('POST', '/api/projects/beta/features', { json: { title: 'bob' }, headers: bearer(dev.body.secret) })).status).toBe(201);
    await call('PATCH', '/api/projects/beta/members/' + bob.id, { as: admin, json: { role: 'viewer' } });
    expect((await call('POST', '/api/projects/beta/features', { json: { title: 'bob 2' }, headers: bearer(dev.body.secret) })).status).toBe(403);
    await call('PATCH', '/api/projects/beta/members/' + bob.id, { as: admin, json: { role: 'developer' } });
  });

  it('runs schedules with their creator\'s current permissions', async () => {
    const dev = members.developer;
    const tpl = await call('POST', '/api/projects/alpha/webhook-templates', { as: dev, json: { name: 'ping', targetUrl: appUrl + '/sched', bodyTemplate: '{"n":1}' } });
    expect(tpl.status, tpl.text).toBe(201);
    const target = { method: 'POST', path: '/webhook-templates/' + tpl.body.id + '/send' };
    const settled = async (id: string, ms = 5000) => {
      for (let i = 0; i < ms / 50; i++) {
        const s = (await call('GET', '/api/projects/alpha/schedules/' + id, { as: admin })).body;
        if (s.status === 'done' || s.status === 'failed') return s;
        await sleep(50);
      }
      throw new Error('schedule did not settle');
    };
    const a = await call('POST', '/api/projects/alpha/schedules', { as: dev, json: { ...target, delayMs: 50 } });
    expect(a.status, a.text).toBe(201);
    expect(a.body.createdBy).toBe(dev.id);
    expect(await settled(a.body.id)).toMatchObject({ status: 'done', lastStatus: 200 });
    const b = await call('POST', '/api/projects/alpha/schedules', { as: dev, json: { ...target, delayMs: 1500 } });
    expect(b.status).toBe(201);
    // The creator is demoted to viewer before it fires: the fire is refused.
    await call('PATCH', '/api/projects/alpha/members/' + dev.id, { as: admin, json: { role: 'viewer' } });
    expect(await settled(b.body.id)).toMatchObject({ status: 'failed', lastStatus: 403 });
    await call('PATCH', '/api/projects/alpha/members/' + dev.id, { as: admin, json: { role: 'developer' } });
    expect((await call('POST', '/api/projects/alpha/schedules', { as: members.viewer, json: { ...target, delayMs: 50 } })).status).toBe(403);
  });

  it('invites: single use, hashed, expire, and sign the new member in', async () => {
    const inv = await call('POST', '/api/team/invites', { as: admin, json: { project: 'alpha', projectRole: 'qa', name: 'Ivy' } });
    expect(inv.status, inv.text).toBe(201);
    const token: string = inv.body.token;
    expect(inv.body.path).toBe('/invite#' + token);
    expect(JSON.stringify((await call('GET', '/api/team/invites', { as: admin })).body)).not.toContain(token);
    const rows = await store().listInvites();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await call('POST', '/api/team/invites', { as: members.project_admin, json: {} })).status).toBe(403);
    const chk = await call('POST', '/api/auth/invite/check', { json: { token } });
    expect(chk.status, chk.text).toBe(200);
    expect(chk.body).toMatchObject({ name: 'Ivy', role: 'member', project: { slug: 'alpha', name: 'Alpha' }, projectRole: 'qa' });
    expect((await call('POST', '/api/auth/invite/check', { json: { token: token + 'x' } })).status).toBe(404);
    expect((await call('POST', '/api/auth/invite/accept', { json: { token, email: 'ivy@example.test', password: 'short' } })).status).toBe(400);
    const acc = await call('POST', '/api/auth/invite/accept', { json: { token, email: 'ivy@example.test', password: PW } });
    expect(acc.status, acc.text).toBe(201);
    const ivy: Who = { cookie: cookieOf(acc), csrf: acc.body.csrf, id: acc.body.user.id, email: 'ivy@example.test' };
    expect((await call('GET', '/api/auth/me', { as: ivy })).body).toMatchObject({ user: { email: 'ivy@example.test', name: 'Ivy', mustChangePassword: false }, projects: { alpha: 'qa' } });
    expect((await call('POST', '/api/auth/invite/accept', { json: { token, email: 'ivy2@example.test', password: PW } })).status).toBe(404);
    expect((await call('GET', '/api/team/invites', { as: admin })).body.invites.find((i: any) => i.id === inv.body.invite.id).status).toBe('accepted');
    // Revoked and expired invites do not work.
    const r2 = await call('POST', '/api/team/invites', { as: admin, json: { email: 'rev@example.test' } });
    await call('DELETE', '/api/team/invites/' + r2.body.invite.id, { as: admin });
    expect((await call('POST', '/api/auth/invite/check', { json: { token: r2.body.token } })).status).toBe(404);
    const r3 = await call('POST', '/api/team/invites', { as: admin, json: {} });
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    await c.query("UPDATE stubyard.invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [r3.body.invite.id]);
    await c.end();
    expect((await call('POST', '/api/auth/invite/check', { json: { token: r3.body.token } })).status).toBe(404);
    expect((await call('GET', '/api/team/invites', { as: admin })).body.invites.find((i: any) => i.id === r3.body.invite.id).status).toBe('expired');
    running.hub.access.inviteLimiter.succeed('invite', '127.0.0.1');
  });

  it('a disabled user loses sessions and tokens at once', async () => {
    const d = await newUser('leaver@example.test', [{ slug: 'alpha', role: 'developer' }]);
    const tok = await call('POST', '/api/auth/tokens', { as: d, json: { name: 'cli' } });
    expect((await call('GET', '/api/projects', { headers: bearer(tok.body.secret) })).status).toBe(200);
    expect((await call('PATCH', '/api/team/users/' + d.id, { as: members.project_admin, json: { disabled: true } })).status).toBe(403);
    expect((await call('PATCH', '/api/team/users/' + admin.id, { as: admin, json: { disabled: true } })).status).toBe(409);
    const off = await call('PATCH', '/api/team/users/' + d.id, { as: admin, json: { disabled: true } });
    expect(off.status, off.text).toBe(200);
    expect(off.body.user.disabled).toBe(true);
    expect((await call('GET', '/api/projects', { as: d })).status).toBe(401);
    expect((await call('GET', '/api/projects', { headers: bearer(tok.body.secret) })).status).toBe(401);
    expect((await login(d.email, PW)).status).toBe(401);
    running.hub.access.limiter.succeed(d.email, '127.0.0.1');
    await call('PATCH', '/api/team/users/' + d.id, { as: admin, json: { disabled: false } });
    expect((await login(d.email, PW)).status).toBe(200);
    // Reset password: sessions end, must change at next sign-in.
    const w = await signIn(d.email, PW);
    const keep = await call('POST', '/api/auth/tokens', { as: w, json: { name: 'kept' } });
    expect(keep.status).toBe(201);
    const rp = await call('POST', '/api/team/users/' + d.id + '/reset-password', { as: admin, json: {} });
    expect(rp.body.temporaryPassword).toEqual(expect.any(String));
    expect((await call('GET', '/api/projects', { as: w })).status).toBe(401);
    expect((await login(d.email, rp.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
    // A reset also revokes every API token of the account (it may be compromised).
    expect((await call('GET', '/api/projects', { headers: bearer(keep.body.secret) })).status).toBe(401);
    expect((await store().listAudit(20)).find((x) => x.action === 'user.password_reset' && x.target === d.id)?.detail).toMatchObject({ tokensRevoked: 1 });
    // The Members page shows the temporary password too.
    expect((await call('GET', '/api/projects/alpha/members', { as: admin })).body.members.find((x: any) => x.userId === d.id).mustChangePassword).toBe(true);
  });

  it('keeps memberships in step when a project is deleted or renamed', async () => {
    expect((await call('POST', '/api/projects', { as: admin, json: { name: 'Gamma', slug: 'gamma' } })).status).toBe(201);
    expect((await call('POST', '/api/projects/gamma/members', { as: admin, json: { userId: bob.id, role: 'viewer' } })).status).toBe(201);
    expect((await call('GET', '/api/projects/gamma', { as: bob })).status).toBe(200);
    expect((await call('DELETE', '/api/projects/gamma', { as: admin })).status).toBeLessThan(300);
    expect((await call('POST', '/api/projects', { as: admin, json: { name: 'Gamma', slug: 'gamma' } })).status).toBe(201);
    expect((await call('GET', '/api/projects/gamma', { as: bob })).status).toBe(404);
    expect((await call('GET', '/api/projects/gamma/members', { as: admin })).body.members).toEqual([]);
    // Rename (store hook; the slug cannot be changed over the API yet).
    await running.hub.access.onProjectRenamed('beta', 'beta-renamed');
    expect((await store().membersOf('beta-renamed')).map((m) => m.userId)).toContain(bob.id);
    expect(await store().membersOf('beta')).toEqual([]);
    await running.hub.access.onProjectRenamed('beta-renamed', 'beta');
    expect((await store().membersOf('beta')).map((m) => m.userId)).toContain(bob.id);
  });

  it('reports Postgres to members in the doctor and in /api/system without details', async () => {
    const doc = await call('GET', '/api/projects/alpha/doctor', { as: members.viewer });
    expect(doc.status).toBe(200);
    expect(doc.body.checks.find((c: any) => c.kind === 'postgres')).toMatchObject({ status: 'ok' });
    const sys = await call('GET', '/api/system', { as: members.viewer });
    expect(sys.body.postgres).toEqual({ ok: true });
  });

  it('writes audit rows', async () => {
    await sleep(200);
    const rows = await store().listAudit(1000);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['auth.login', 'auth.login_failed', 'user.create', 'member.add', 'member.role', 'member.remove', 'user.disable', 'user.enable', 'user.password_reset', 'token.create', 'invite.create', 'invite.accept', 'invite.revoke', 'project.create', 'project.delete', 'project.reset', 'project.settings']) {
      expect(actions.has(a), a).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toContain(PW);
    expect(JSON.stringify(rows)).not.toContain(ADMIN_PW);
  });

  it('factory reset: instance admins only; users stay, memberships go', async () => {
    expect((await call('POST', '/api/factory-reset', { as: members.project_admin, json: { confirm: 'DELETE EVERYTHING' } })).status).toBe(403);
    const r = await call('POST', '/api/factory-reset', { as: admin, json: { confirm: 'DELETE EVERYTHING' } });
    expect(r.status, r.text).toBeLessThan(300);
    expect((await store().allMemberships()).length).toBe(0);
    expect((await call('GET', '/api/team/users', { as: admin })).body.users.length).toBeGreaterThan(5);
    expect((await signIn(bob.email, PW)).id).toBe(bob.id);
    expect((await call('GET', '/api/projects', { as: bob })).body).toEqual([]);
    expect((await store().listAudit(50)).some((x) => x.action === 'system.factory_reset')).toBe(true);
  });

  it('demotes the previous env admin when STUBYARD_ADMIN_EMAIL changes (sessions and tokens revoked, audited)', async () => {
    const tok = await call('POST', '/api/auth/tokens', { as: admin, json: { name: 'old admin' } });
    expect(tok.status).toBe(201);
    const oldConfig = running.hub.config;
    await running.close();
    const NEW = 'new-owner@example.test';
    running = await startHub(loadConfig({ ...oldConfig, admin: { email: NEW, passwordHash: adminPasswordHash(NEW, ADMIN_PW, '') } }), { logger: pino({ level: 'silent' }) });
    const old = await store().getUser(admin.id);
    expect(old).toMatchObject({ role: 'member', envAdmin: false });
    expect((await call('GET', '/api/projects', { as: admin })).status).toBe(401);
    expect((await call('GET', '/api/projects', { headers: bearer(tok.body.secret) })).status).toBe(401);
    expect((await login(ADMIN, ADMIN_PW)).status).toBe(401);
    const me = await signIn(NEW, ADMIN_PW);
    expect((await call('GET', '/api/auth/me', { as: me })).body.user).toMatchObject({ email: NEW, role: 'admin', envAdmin: true });
    expect((await store().listAudit(20)).find((x) => x.action === 'user.env_admin_replaced')).toMatchObject({ target: admin.id, detail: { from: ADMIN, to: NEW } });
  }, 60_000);
});
