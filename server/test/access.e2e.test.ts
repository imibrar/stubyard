import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createHub, startHub, type RunningHub } from '../src/index.js';
import { registerAccess, registeredRoutes } from '../src/access/hook.js';
import { isKnownOtherRoute, routeAccess } from '../src/access/permissions.js';
import { adminPasswordHash } from '../src/access/password.js';

/**
 * Sign-in (teams plan T1, Single admin mode): login, sessions, CSRF, API tokens, the permission table, and the
 * app-facing endpoints that must stay open. Requests go over real HTTP: app.inject() calls count as stubyard's own
 * internal calls and skip sign-in by design.
 */

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery';

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

function client(base: () => string) {
  return async function call<T = any>(method: string, p: string, o: { json?: unknown; form?: string; headers?: Record<string, string>; raw?: string; ct?: string } = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    let body: string | undefined;
    if (o.json !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form !== undefined) {
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
      body = o.form;
    } else if (o.raw !== undefined) {
      if (o.ct) headers['content-type'] = o.ct;
      body = o.raw;
    }
    const r = await fetch(base() + p, { method, headers, body, redirect: 'manual' });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T, text, headers: r.headers };
  };
}

const cookieOf = (r: Res) => (r.headers.get('set-cookie') ?? '').split(';')[0];

describe('sign-in: Open mode (no admin configured)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';
  const call = client(() => base);

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-open-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('works without sign-in, exactly as before', async () => {
    expect(hub.access.mode).toBe('open');
    const sys = await call('GET', '/api/system');
    expect(sys.status).toBe(200);
    expect(Object.keys(sys.body).sort()).toEqual(['labels', 'mailpit', 'name', 'ports', 'presets', 'tls', 'version']);
    expect((await call('POST', '/api/projects', { json: { name: 'Open' } })).status).toBe(201);
    expect((await call('GET', '/api/projects')).status).toBe(200);
    expect((await call('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(200);
  });

  it('answers /api/auth/me with mode "open" and 404s the rest of /api/auth', async () => {
    expect((await call('GET', '/api/auth/me')).body).toEqual({ mode: 'open', user: null, csrf: null, via: null });
    expect((await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } })).status).toBe(404);
    expect((await call('GET', '/api/auth/tokens')).status).toBe(404);
    expect((await call('POST', '/api/auth/tokens', { json: { name: 'x' } })).status).toBe(404);
  });
});

describe('permission table', () => {
  it('maps every registered /api route, and every other route is a known open or protected kind', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-perm-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    const hub = createHub(config, { mailpit: { baseUrl: 'http://127.0.0.1:1' } as never, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    try {
      const routes = registeredRoutes(app);
      expect(routes.length).toBeGreaterThan(400);
      const api = routes.filter((r) => r.url === '/api' || r.url.startsWith('/api/'));
      const unmapped = api.filter((r) => routeAccess(r.method, r.url) === null).map((r) => `${r.method} ${r.url}`);
      expect(unmapped, 'add these routes to server/src/access/permissions.ts').toEqual([]);
      const other = routes.filter((r) => !(r.url === '/api' || r.url.startsWith('/api/'))).filter((r) => !isKnownOtherRoute(r.url)).map((r) => `${r.method} ${r.url}`);
      expect(other, 'decide whether these non-/api routes are app-facing (open) or dashboard (protected)').toEqual([]);
      // A few rules spelled out.
      expect(routeAccess('GET', '/api/projects/:slug/features')).toEqual({ permission: 'project.view', scope: 'path' });
      expect(routeAccess('POST', '/api/projects/:slug/features')).toEqual({ permission: 'features.edit', scope: 'path' });
      expect(routeAccess('PATCH', '/api/projects/:slug/features/:ref')).toMatchObject({ permission: 'features.details' });
      expect(routeAccess('PUT', '/api/projects/:slug/storyboards/:key')).toMatchObject({ permission: 'storyboards.edit' });
      expect(routeAccess('POST', '/api/projects/:slug/walkthroughs/:id/finish')).toMatchObject({ permission: 'walkthroughs.run' });
      expect(routeAccess('PATCH', '/api/projects/:slug/providers/:instance')).toMatchObject({ permission: 'project.providers' });
      expect(routeAccess('POST', '/api/projects/:slug/reset')).toMatchObject({ permission: 'project.reset' });
      expect(routeAccess('PATCH', '/api/projects/:slug')).toMatchObject({ permission: 'project.settings' });
      expect(routeAccess('POST', '/api/factory-reset')).toMatchObject({ permission: 'instance.admin', scope: 'none' });
      expect(routeAccess('HEAD', '/api/system')).toMatchObject({ permission: 'public' });
      expect(routeAccess('GET', '/api/no-such-area')).toBeNull();
      expect(routeAccess('GET', '/mock/:project/:instance/*')).toBe('open');
      expect(routeAccess('POST', '/mcp')).toMatchObject({ permission: 'authenticated' });
      expect(routeAccess('GET', '/mailpit/*')).toMatchObject({ permission: 'project.view' });
    } finally {
      await app.close();
      hub.db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses a route the table does not cover when sign-in is on (default deny)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-deny-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: { email: EMAIL, passwordHash: adminPasswordHash(EMAIL, PASSWORD, '') } });
    const hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const app = Fastify();
    registerAccess(app, hub);
    app.get('/api/zz-unmapped', async () => ({ ok: true }));
    app.get('/api/system', async () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    try {
      const { secret } = await hub.access.createToken({ id: `admin:${EMAIL}`, email: EMAIL, name: 'Admin', role: 'admin' }, { name: 't' });
      expect((await fetch(`${base}/api/zz-unmapped`)).status).toBe(401);
      const r = await fetch(`${base}/api/zz-unmapped`, { headers: { authorization: `Bearer ${secret}` } });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toContain('No permission is defined');
      expect((await fetch(`${base}/api/system`)).status).toBe(200);
    } finally {
      await app.close();
      hub.db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('sign-in behind a proxy (STUBYARD_TRUST_PROXY)', () => {
  const run = async (trustProxy: Config['trustProxy']) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-proxy-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: { email: EMAIL, passwordHash: adminPasswordHash(EMAIL, PASSWORD, '') }, trustProxy });
    const hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    const login = (client: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9', headers: { host: 'localhost:4000', 'content-type': 'application/json', 'x-forwarded-for': client }, payload: JSON.stringify({ email: 'someone@example.test', password: 'wrong-password' }) });
    for (let i = 0; i < 5; i++) expect((await login('203.0.113.1')).statusCode).toBe(401);
    const sameClient = (await login('203.0.113.1')).statusCode;
    const otherClient = (await login('203.0.113.2')).statusCode;
    await app.close();
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    return { sameClient, otherClient };
  };

  it('keys the limiter on the real client address when the proxy is trusted', async () => {
    expect(await run(['10.9.9.0/24'])).toEqual({ sameClient: 429, otherClient: 401 });
    expect(await run(1)).toEqual({ sameClient: 429, otherClient: 401 });
  });

  it('ignores X-Forwarded-For by default (every client is the proxy)', async () => {
    expect(await run(false)).toEqual({ sameClient: 429, otherClient: 429 });
  });
});

describe('sign-in: cookie flags', () => {
  const start = async (overrides: Partial<Config>) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-cookie-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: { email: EMAIL, passwordHash: adminPasswordHash(EMAIL, PASSWORD, '') }, ...overrides });
    const hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'localhost:4000', 'content-type': 'application/json' }, payload: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    await app.close();
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    return String(login.headers['set-cookie']);
  };

  it('is HttpOnly, SameSite=Lax, Path=/ and lasts the session TTL; Secure + __Host- when configured', async () => {
    const plain = await start({ sessionTtlHours: 2 });
    expect(plain).toMatch(/^stubyard_session=[A-Za-z0-9_-]{40,};/);
    expect(plain).toContain('HttpOnly');
    expect(plain).toContain('SameSite=Lax');
    expect(plain).toContain('Path=/');
    expect(plain).toMatch(/Max-Age=(7200|7199)/);
    expect(plain).not.toContain('Secure');
    const secure = await start({ cookieSecure: true });
    expect(secure).toMatch(/^__Host-stubyard_session=/);
    expect(secure).toContain('; Secure');
  });

  it('defaults Secure from an https public URL', () => {
    expect(loadConfig({ publicUrl: 'https://hub.example.com', admin: null }).cookieSecure).toBe(true);
    expect(loadConfig({ publicUrl: 'http://localhost:4000', admin: null }).cookieSecure).toBe(false);
  });
});

describe.skipIf(!haveMailpit)('sign-in: Single admin mode end to end', () => {
  let running: RunningHub;
  let dataDir: string;
  let base = '';
  let smtpPort = 0;
  const call = client(() => base);
  let cookie = '';
  let csrf = '';
  let token = '';
  let tokenId = '';
  const asAdmin = (extra: Record<string, string> = {}) => ({ cookie, 'x-stubyard-csrf': csrf, ...extra });
  const bearer = (t = token) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-access-'));
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
      mailpitUrl: `http://127.0.0.1:${mpHttp}`,
      mailpitSmtpHost: '127.0.0.1',
      mailpitSmtpPort: mpSmtp,
      spawnMailpit: true,
      logLevel: 'silent',
      maintenanceIntervalMs: 0,
      admin: { email: EMAIL, passwordHash: adminPasswordHash(EMAIL, PASSWORD, '') },
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
  });
  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses anonymous calls to the API, the event stream, /mcp and /mailpit with 401', async () => {
    for (const [m, p] of [
      ['GET', '/api/projects'],
      ['GET', '/api/stream'],
      ['GET', '/api/logs'],
      ['GET', '/api/agent-guide'],
      ['GET', '/api/no-such-route'],
      ['GET', '/%61pi/projects'],
      ['GET', '/mailpit/api/v1/messages'],
    ] as const) {
      const r = await call(m, p);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('Bearer');
    }
    expect((await call('POST', '/api/projects', { json: { name: 'x' } })).status).toBe(401);
    expect((await call('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(401);
    expect((await call('POST', '/api/factory-reset', { json: { confirm: 'DELETE EVERYTHING' } })).status).toBe(401);
  });

  it('keeps the public allowlist open: /api/system (minimal), /api/auth/me, /api/ca.crt', async () => {
    const sys = await call('GET', '/api/system');
    expect(sys.status).toBe(200);
    expect(sys.body).toEqual({ name: 'stubyard', version: expect.any(String), authRequired: true });
    expect((await call('GET', '/api/auth/me')).body).toEqual({ mode: 'single', user: null, csrf: null, via: null });
    expect((await call('GET', '/api/ca.crt')).status).toBe(200);
    // A broken token on a public route is ignored (minimal answer), not an error.
    expect((await call('GET', '/api/system', { headers: bearer('sy_nope') })).body.authRequired).toBe(true);
  });

  it('rejects a wrong password or e-mail with 401 and no cookie', async () => {
    const bad = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: 'wrong password' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect((await call('POST', '/api/auth/login', { json: { email: 'other@example.test', password: PASSWORD } })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { json: { email: EMAIL } })).status).toBe(400);
    running.hub.access.limiter.succeed(EMAIL, '127.0.0.1');
  });

  it('keeps the Origin / JSON guard on the login', async () => {
    expect((await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD }, headers: { origin: 'http://evil.test' } })).status).toBe(403);
    expect((await call('POST', '/api/auth/login', { form: `email=${EMAIL}&password=x` })).status).toBe(415);
  });

  it('signs in (e-mail case-insensitive) and gets a session cookie and a CSRF token', async () => {
    const r = await call('POST', '/api/auth/login', { json: { email: '  Admin@Example.TEST ', password: PASSWORD } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.user).toEqual({ id: `admin:${EMAIL}`, email: EMAIL, name: 'Admin', role: 'admin' });
    expect(r.body.csrf).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    cookie = cookieOf(r);
    csrf = r.body.csrf;
    expect(cookie).toMatch(/^stubyard_session=/);
    // Only the hash of the cookie token is stored.
    const rows = running.hub.db.prepare('SELECT id FROM auth_sessions').all() as { id: string }[];
    expect(rows.some((x) => x.id === cookie.split('=')[1])).toBe(false);
    const me = await call('GET', '/api/auth/me', { headers: { cookie } });
    expect(me.body).toMatchObject({ mode: 'single', user: { email: EMAIL }, csrf, via: 'session' });
    const sys = await call('GET', '/api/system', { headers: { cookie } });
    expect(sys.body).toMatchObject({ name: 'stubyard', authRequired: true, ports: expect.any(Object) });
  });

  it('reads with the cookie; writes need the X-Stubyard-CSRF header', async () => {
    expect((await call('GET', '/api/projects', { headers: { cookie } })).status).toBe(200);
    const missing = await call('POST', '/api/projects', { json: { name: 'Shop', slug: 'shop' }, headers: { cookie } });
    expect(missing.status).toBe(403);
    expect(missing.body.error).toContain('X-Stubyard-CSRF');
    expect((await call('POST', '/api/projects', { json: { name: 'Shop', slug: 'shop' }, headers: { cookie, 'x-stubyard-csrf': 'wrong' } })).status).toBe(403);
    const ok = await call('POST', '/api/projects', { json: { name: 'Shop', slug: 'shop', generateUsers: { customers: 2 } }, headers: asAdmin() });
    expect(ok.status, ok.text).toBe(201);
  });

  it('streams events to a signed-in EventSource-style request (cookie)', async () => {
    const ac = new AbortController();
    const r = await fetch(`${base}/api/stream`, { headers: { cookie, accept: 'text/event-stream' }, signal: ac.signal });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('retry:');
    ac.abort();
  });

  it('creates an API token (secret shown once), lists it without the secret, and uses it', async () => {
    const created = await call('POST', '/api/auth/tokens', { json: { name: 'Claude Code' }, headers: asAdmin() });
    expect(created.status, created.text).toBe(201);
    token = created.body.secret;
    tokenId = created.body.token.id;
    expect(token).toMatch(/^sy_[A-Za-z0-9_-]{43}$/);
    expect(created.body.token).toMatchObject({ name: 'Claude Code', prefix: token.slice(0, 11), status: 'active', lastUsedAt: null, expiresAt: null });
    const list = await call('GET', '/api/auth/tokens', { headers: { cookie } });
    expect(list.body.tokens).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(JSON.stringify(running.hub.db.prepare('SELECT * FROM api_tokens').all())).not.toContain(token);

    // Bearer requests need no CSRF header.
    const p = await call('POST', '/api/projects', { json: { name: 'Bearer project' }, headers: bearer() });
    expect(p.status).toBe(201);
    expect((await call('GET', '/api/auth/me', { headers: bearer() })).body).toMatchObject({ user: { email: EMAIL }, csrf: null, via: 'token' });
    const after = await call('GET', '/api/auth/tokens', { headers: { cookie } });
    expect(after.body.tokens[0].lastUsedAt).not.toBeNull();
    // A token cannot manage tokens (a leaked one cannot mint more).
    expect((await call('POST', '/api/auth/tokens', { json: { name: 'more' }, headers: bearer() })).status).toBe(403);
    expect((await call('GET', '/api/auth/tokens', { headers: bearer() })).status).toBe(403);
    // Validation.
    expect((await call('POST', '/api/auth/tokens', { json: { name: '' }, headers: asAdmin() })).status).toBe(400);
    expect((await call('POST', '/api/auth/tokens', { json: { name: 'x', expiresInDays: 0 }, headers: asAdmin() })).status).toBe(400);
  });

  it('serves /mcp with a Bearer token, including tools that call the API internally', async () => {
    const list = await call('POST', '/mcp', { json: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: bearer() });
    expect(list.status).toBe(200);
    expect(list.body.result.tools.length).toBeGreaterThan(10);
    const tool = await call('POST', '/mcp', { json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }, headers: bearer() });
    expect(tool.status).toBe(200);
    expect(tool.body.result.isError).toBeFalsy();
    expect(tool.body.result.content[0].text).toContain('shop');
  });

  it('lets the MCP tester connect to "this server" (self credential, never stored)', async () => {
    const r = await call('POST', '/api/projects/shop/mcp-tester/connect', { json: { self: true }, headers: bearer() });
    expect(r.status, r.text).toBeLessThan(300);
    const targets = await call('GET', '/api/projects/shop/mcp-tester/targets', { headers: bearer() });
    expect(JSON.stringify(targets.body)).not.toContain('syi_');
    expect(JSON.stringify(running.hub.db.prepare('SELECT headers FROM mcp_targets').all())).not.toContain('syi_');
    // The self secret is not accepted as a normal token from outside... (here the test is on loopback too, so check the
    // shape instead: an unknown syi_ value is refused).
    expect((await call('GET', '/api/projects', { headers: bearer('syi_made-up') })).status).toBe(401);
  });

  it('keeps the app-facing endpoints open: SMTP, /mock, payment pages', async () => {
    // SMTP
    const users = (await call('GET', '/api/projects/shop/users', { headers: bearer() })).body as { email: string }[];
    await nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: { user: 'shop', pass: 'x' } }).sendMail({ from: 'a@shop.app', to: users[0].email, subject: 'Hello', text: 'Code 123456' });
    let got: any[] = [];
    for (let i = 0; i < 100 && !got.length; i++) {
      got = (await call('GET', '/api/projects/shop/messages', { headers: bearer() })).body;
      if (!got.length) await new Promise((r) => setTimeout(r, 50));
    }
    expect(got[0]).toMatchObject({ subject: 'Hello' });
    // /mock (Twilio) with no stubyard credentials, but with a stray session cookie + CSRF header that must not be logged
    expect((await call('POST', '/api/projects/shop/providers', { json: { preset: 'twilio', slug: 'sms' }, headers: bearer() })).status).toBe(201);
    const phone = ((await call('GET', '/api/projects/shop/users', { headers: bearer() })).body as { phone: string }[])[0].phone;
    const sms = await call('POST', '/mock/shop/sms/2010-04-01/Accounts/ACtest/Messages.json', {
      form: new URLSearchParams({ To: phone, From: '+15550001111', Body: 'hi' }).toString(),
      headers: { cookie: `${cookie}; app_cookie=1`, 'x-stubyard-csrf': csrf },
    });
    expect(sms.status, sms.text).toBe(201);
    const logId = sms.headers.get('x-hub-request-id')!;
    const log = (await call('GET', `/api/logs/${logId}`, { headers: bearer() })).body;
    const reqHeaders = JSON.stringify(log.reqHeaders ?? log.request?.headers ?? log);
    expect(reqHeaders).toContain('app_cookie=1');
    expect(reqHeaders).not.toContain(cookie.split('=')[1]);
    expect(reqHeaders).not.toContain(csrf);
    // A payment page
    const inst = await call('POST', '/api/projects/shop/payment-instances', { json: { preset: 'stripe-checkout', config: { webhookDelayMs: 0 } }, headers: bearer() });
    expect(inst.status, inst.text).toBe(201);
    const cs = await call('POST', '/pay/shop/stripe/v1/checkout/sessions', {
      form: new URLSearchParams({ mode: 'payment', success_url: 'http://app.test/ok', cancel_url: 'http://app.test/no', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': '500', 'line_items[0][price_data][product_data][name]': 'Tea', 'line_items[0][quantity]': '1' }).toString(),
      headers: { authorization: `Bearer ${inst.body.config.secretKey}` },
    });
    expect(cs.status, cs.text).toBe(200);
    const entry = await call('GET', new URL(cs.body.url).pathname);
    expect([200, 302]).toContain(entry.status);
    if (entry.status === 302) expect((await call('GET', new URL(entry.headers.get('location')!, base + new URL(cs.body.url).pathname).pathname)).status).toBe(200);
  });

  it('protects the dashboard storage upload on the open storage route', async () => {
    const s = await call('POST', '/api/projects/shop/storage', { json: { preset: 's3', slug: 's3' }, headers: bearer() });
    expect(s.status, s.text).toBe(201);
    const url = '/storage/shop/s3/__hub/objects/uploads/a.txt';
    expect((await call('PUT', url, { raw: 'hello', ct: 'text/plain' })).status).toBe(401);
    expect((await call('PUT', url, { raw: 'hello', ct: 'text/plain', headers: { cookie } })).status).toBe(403);
    expect((await call('PUT', url, { raw: 'hello', ct: 'text/plain', headers: asAdmin() })).status).toBe(201);
  });

  it('revokes a token, and refuses revoked and expired tokens', async () => {
    const t2 = await call('POST', '/api/auth/tokens', { json: { name: 'short', expiresInDays: 1 }, headers: asAdmin() });
    expect(t2.body.token.expiresAt).toBeTruthy();
    expect((await call('GET', '/api/projects', { headers: bearer(t2.body.secret) })).status).toBe(200);
    running.hub.db.prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), t2.body.token.id);
    const expired = await call('GET', '/api/projects', { headers: bearer(t2.body.secret) });
    expect(expired.status).toBe(401);
    expect(expired.body.error).toContain('not valid');
    const rev = await call('DELETE', `/api/auth/tokens/${tokenId}`, { headers: asAdmin() });
    expect(rev.status).toBe(200);
    expect(rev.body.token).toMatchObject({ status: 'revoked' });
    expect((await call('GET', '/api/projects', { headers: bearer() })).status).toBe(401);
    const list = (await call('GET', '/api/auth/tokens', { headers: { cookie } })).body.tokens as { id: string; status: string }[];
    expect(list.find((t) => t.id === tokenId)?.status).toBe('revoked');
    expect(list.find((t) => t.id === t2.body.token.id)?.status).toBe('expired');
    expect((await call('DELETE', '/api/auth/tokens/tok_nope', { headers: asAdmin() })).status).toBe(404);
    // A Bearer header that is not a valid token is refused even with a valid cookie.
    expect((await call('GET', '/api/projects', { headers: { cookie, authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('ends an expired session', async () => {
    const r = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });
    const c2 = cookieOf(r);
    expect((await call('GET', '/api/projects', { headers: { cookie: c2 } })).status).toBe(200);
    running.hub.db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE csrf = ?').run(new Date(Date.now() - 1000).toISOString(), r.body.csrf);
    expect((await call('GET', '/api/projects', { headers: { cookie: c2 } })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { headers: { cookie: c2 } })).body.user).toBeNull();
  });

  it('signs out: the session ends and the cookie is cleared', async () => {
    const out = await call('POST', '/api/auth/logout', { headers: asAdmin() });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^stubyard_session=; .*Max-Age=0/);
    expect((await call('GET', '/api/projects', { headers: { cookie } })).status).toBe(401);
  });

  it('keeps the Mailpit UI / API behind a random login only stubyard knows (sign-in on)', async () => {
    const mpUrl = running.hub.config.mailpitUrl;
    const direct = await fetch(`${mpUrl}/mailpit/api/v1/info`);
    expect(direct.status).toBe(401);
    const login = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });
    const viaHub = await call('GET', '/mailpit/api/v1/info', { headers: { cookie: cookieOf(login) } });
    expect(viaHub.status).toBe(200);
    expect(viaHub.headers.get('www-authenticate')).toBeNull();
    expect(running.hub.mailpit!.authHeaders().authorization).toMatch(/^Basic /);
  });

  it('runs at most a few password checks at once (more get 429 + Retry-After: 1) and never blocks the app endpoints', async () => {
    const t0 = Date.now();
    const burst = Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/api/auth/login', { json: { email: `burst${i}@example.test`, password: 'wrong-password' } })));
    const mock = await call('GET', '/mock/nope/nope');
    const mockMs = Date.now() - t0;
    const res = await burst;
    expect(mock.status).toBeLessThan(500);
    expect(mockMs).toBeLessThan(1000);
    const busy = res.filter((r) => r.status === 429);
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.every((r) => r.headers.get('retry-after') === '1')).toBe(true);
    expect(res.filter((r) => r.status === 401).length).toBeGreaterThan(0);
  });

  it('rate-limits failed sign-ins: other e-mails 5 per pair and 20 per IP in 15 min; the admin e-mail only slows down', async () => {
    const lim = running.hub.access.limiter as unknown as { failures: Map<string, number[]> };
    lim.failures.clear();
    // Another e-mail: a hard 15-minute block after 5 failures.
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/auth/login', { json: { email: 'x@example.test', password: `wrong-${i}-password` } })).status).toBe(401);
    const hard = await call('POST', '/api/auth/login', { json: { email: 'x@example.test', password: 'wrong-password' } });
    expect(hard.status).toBe(429);
    expect(Number(hard.headers.get('retry-after'))).toBeGreaterThan(800);
    // The admin e-mail: after 5 failures a short, growing wait, then the right password works.
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/auth/login', { json: { email: EMAIL, password: `wrong-${i}-password` } })).status).toBe(401);
    const slow = await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } });
    expect(slow.status).toBe(429);
    expect(Number(slow.headers.get('retry-after'))).toBeLessThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 2100));
    expect((await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } })).status).toBe(200);
    // 20 failures from one IP with made-up e-mails block every other e-mail from it, but not the admin's.
    lim.failures.clear();
    for (let i = 0; i < 20; i++) running.hub.access.limiter.fail(`made-up${i}@example.test`, '127.0.0.1');
    expect((await call('POST', '/api/auth/login', { json: { email: 'new@example.test', password: 'wrong-password' } })).status).toBe(429);
    expect((await call('POST', '/api/auth/login', { json: { email: EMAIL, password: PASSWORD } })).status).toBe(200);
    lim.failures.clear();
  });
});
