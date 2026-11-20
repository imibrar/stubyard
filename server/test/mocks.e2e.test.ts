import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { newId } from '../src/util.js';

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

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!haveMailpit)('API mocks, cleanup, export/import', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-mocks-test-'));
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
      callbackDelayMs: 150,
      timeoutHoldMs: 400,
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    const r = await api('POST', '/api/projects', { name: 'Shop', generateUsers: { admins: 1, customers: 2 } });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers with a templated mock and records mock + scenario in the traffic log', async () => {
    const created = await api('POST', '/api/projects/shop/mocks', {
      name: 'Get user',
      method: 'GET',
      path: '/users/:id',
      scenarios: [
        {
          name: 'OK',
          status: 200,
          headers: { 'x-trace': '{{headers.x-req}}' },
          body: '{"id":"{{params.id}}","expand":"{{query.expand}}","rid":"{{uuid}}","at":"{{now}}"}',
        },
        { name: 'Not found', status: 404, body: '{"error":"user {{params.id}} not found"}' },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.activeScenario).toBe('OK');

    const r = await api('GET', '/mock/shop/api/users/42?expand=orders', undefined, { 'x-req': 'abc' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.headers.get('x-trace')).toBe('abc');
    expect(r.body).toMatchObject({ id: '42', expand: 'orders' });
    expect(r.body.rid).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(r.body.at))).toBe(false);

    const logId = r.headers.get('x-hub-request-id')!;
    const log = await waitFor(async () => {
      const l = (await api('GET', `/api/logs/${logId}`)).body;
      return l.outcome !== 'pending' && l.resolved.mock ? l : null;
    });
    expect(log.outcome).toBe('ok');
    expect(log.resolved).toMatchObject({ mock: 'Get user', scenario: 'OK', params: { id: '42' } });
  });

  it('matches on query, headers and body in priority order', async () => {
    await api('POST', '/api/projects/shop/mocks', {
      name: 'Pay big',
      method: 'POST',
      path: '/payments',
      match: { bodyJson: { 'amount.value': 1000 }, headers: { 'X-Tenant': 'acme' } },
      scenarios: [{ name: 'Declined', status: 402, body: '{"status":"declined","by":"{{body.customer.email}}"}' }],
    });
    await api('POST', '/api/projects/shop/mocks', {
      name: 'Pay any',
      method: 'POST',
      path: '/payments',
      scenarios: [{ name: 'Approved', status: 201, body: '{"status":"approved"}' }],
    });
    await api('POST', '/api/projects/shop/mocks', {
      name: 'Search',
      method: 'GET',
      path: '/search',
      match: { query: { q: '*', page: '2' } },
      scenarios: [{ name: 'Page 2', status: 200, body: 'page two of {{query.q}}' }],
    });
    await api('POST', '/api/projects/shop/mocks', { name: 'Files', path: '/files/*', match: { bodyContains: 'secret' }, scenarios: [{ name: 'OK', body: 'file {{params.*}}' }] });

    const big = await api('POST', '/mock/shop/api/payments', { amount: { value: 1000 }, customer: { email: 'a@b.c' } }, { 'x-tenant': 'acme' });
    expect(big.status).toBe(402);
    expect(big.body).toEqual({ status: 'declined', by: 'a@b.c' });
    const otherTenant = await api('POST', '/mock/shop/api/payments', { amount: { value: 1000 } }, { 'x-tenant': 'other' });
    expect(otherTenant.status).toBe(201);
    const small = await api('POST', '/mock/shop/api/payments', { amount: { value: 5 } }, { 'x-tenant': 'acme' });
    expect(small.body).toEqual({ status: 'approved' });

    const page2 = await api('GET', '/mock/shop/api/search?q=shoes&page=2');
    expect(page2.body).toBe('page two of shoes');
    expect((await api('GET', '/mock/shop/api/search?q=shoes&page=3')).status).toBe(404);

    const file = await api('PUT', '/mock/shop/api/files/a/b.txt', 'top secret', { 'content-type': 'text/plain' });
    expect(file.body).toBe('file a/b.txt');

    // Move "Pay any" above "Pay big": now it wins.
    await api('PATCH', '/api/projects/shop/mocks/Pay%20any', { position: 1 });
    const now = await api('POST', '/mock/shop/api/payments', { amount: { value: 1000 } }, { 'x-tenant': 'acme' });
    expect(now.status).toBe(201);
    await api('PATCH', '/api/projects/shop/mocks/Pay%20any', { position: 10 });
  });

  it('logs unmatched calls as 404 listing the mocks', async () => {
    const r = await api('DELETE', '/mock/shop/api/nothing/here');
    expect(r.status).toBe(404);
    expect(r.body.mocks.map((m: any) => m.name)).toContain('Get user');
    expect(r.body.mocks.find((m: any) => m.name === 'Get user').reason).toBe('path differs');
    const log = await waitFor(async () => {
      const l = (await api('GET', `/api/logs/${r.headers.get('x-hub-request-id')}`)).body;
      return l.outcome !== 'pending' ? l : null;
    });
    expect(log.outcome).toBe('unmatched');
    expect(log.resolved).toMatchObject({ project: 'shop', mock: null });
  });

  it('switches the active scenario live and lets X-Hub-Scenario pick one per request', async () => {
    const sw = await api('PATCH', '/api/projects/shop/mocks/Get%20user/active-scenario', { scenario: 'Not found' });
    expect(sw.status).toBe(200);
    expect(sw.body.activeScenario).toBe('Not found');
    const r = await api('GET', '/mock/shop/api/users/7');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'user 7 not found' });
    const log = await waitFor(async () => {
      const l = (await api('GET', `/api/logs/${r.headers.get('x-hub-request-id')}`)).body;
      return l.outcome !== 'pending' && l.resolved.scenario ? l : null;
    });
    expect(log.outcome).toBe('forced_error');
    expect(log.resolved).toMatchObject({ mock: 'Get user', scenario: 'Not found', scenarioSource: 'active' });

    const ok = await api('GET', '/mock/shop/api/users/7', undefined, { 'x-hub-scenario': 'ok' });
    expect(ok.status).toBe(200);
    const forced = await api('GET', '/mock/shop/api/users/7', undefined, { 'x-hub-scenario': '503' });
    expect(forced.status).toBe(503);

    expect((await api('PATCH', '/api/projects/shop/mocks/Get%20user/active-scenario', { scenario: 'nope' })).status).toBe(400);
    await api('PATCH', '/api/projects/shop/mocks/Get%20user/active-scenario', { scenario: 'OK' });
    expect((await api('GET', '/mock/shop/api/users/7')).status).toBe(200);
  });

  it('simulates timeouts and dropped connections', async () => {
    const m = await api('POST', '/api/projects/shop/mocks', {
      name: 'Gateway',
      path: '/gateway',
      scenarios: [
        { name: 'OK', body: '{}' },
        { name: 'Timeout', behaviour: 'timeout' },
        { name: 'Drop', behaviour: 'drop-connection' },
        { name: 'Slow', delayMs: 300, body: 'slow' },
      ],
      activeScenario: 'Timeout',
    });
    expect(m.status).toBe(201);
    expect(m.body.scenarios[2].behaviour).toBe('drop');

    const t0 = Date.now();
    await expect(fetch(base + '/mock/shop/api/gateway')).rejects.toThrow();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);

    await expect(fetch(base + '/mock/shop/api/gateway', { headers: { 'x-hub-scenario': 'Drop' } })).rejects.toThrow();

    const t1 = Date.now();
    const slow = await api('GET', '/mock/shop/api/gateway', undefined, { 'x-hub-scenario': 'Slow' });
    expect(slow.body).toBe('slow');
    expect(Date.now() - t1).toBeGreaterThanOrEqual(280);

    const hits = await waitFor(async () => {
      const h = (await api('GET', '/api/projects/shop/mocks/Gateway/hits')).body;
      return h.length >= 3 && h.every((x: any) => x.outcome !== 'pending') ? h : null;
    });
    const logs = await Promise.all(hits.map((h: any) => api('GET', `/api/logs/${h.id}`).then((r) => r.body)));
    const byScenario = Object.fromEntries(logs.map((l: any) => [l.resolved.scenario, l]));
    expect(byScenario.Timeout).toMatchObject({ outcome: 'forced_error', errorType: 'simulated_timeout', resStatus: null });
    expect(byScenario.Drop).toMatchObject({ outcome: 'forced_error', errorType: 'simulated_drop' });
    expect(byScenario.Slow).toMatchObject({ outcome: 'ok', resStatus: 200 });

    const list = (await api('GET', '/api/projects/shop/mocks')).body;
    expect(list.find((x: any) => x.name === 'Gateway').hits).toBe(3);
  });

  it('validates mocks and supports CRUD by name', async () => {
    expect((await api('POST', '/api/projects/shop/mocks', { name: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/projects/shop/mocks', { name: 'Get user', path: '/a' })).status).toBe(409);
    expect((await api('POST', '/api/projects/shop/mocks', { path: '/a', method: 'FETCH' })).status).toBe(400);
    expect((await api('POST', '/api/projects/shop/mocks', { path: '/a', scenarios: [{ name: 'a', status: 99 }] })).status).toBe(400);
    const c = await api('POST', '/api/projects/shop/mocks', { path: '/tmp', method: 'get' });
    expect(c.body).toMatchObject({ name: 'GET /tmp', method: 'GET', scenarios: [{ name: 'OK', status: 200, behaviour: 'respond' }] });
    const u = await api('PATCH', `/api/projects/shop/mocks/${c.body.id}`, { enabled: false });
    expect(u.body.enabled).toBe(false);
    expect((await api('GET', '/mock/shop/api/tmp')).status).toBe(404);
    expect((await api('DELETE', '/api/projects/shop/mocks/GET%20%2Ftmp')).status).toBe(200);
  });

  it('resets rules ("Reset all rules") and counters on project reset', async () => {
    await api('POST', '/api/projects/shop/users/customer1/rules', { channel: 'sms', action: 'fail' });
    await api('POST', '/api/projects/shop/users/admin/rules', { action: 'reject', count: 2 });
    const reset = await api('POST', '/api/projects/shop/rules/reset');
    expect(reset.body.deleted).toBe(2);
    expect((await api('GET', '/api/projects/shop/users/customer1/rules')).body).toEqual([]);

    expect((await api('GET', '/api/projects/shop/mocks/Get%20user')).body.hits).toBeGreaterThan(0);
    const r = await api('POST', '/api/projects/shop/reset');
    expect(r.status).toBe(200);
    expect((await api('GET', '/api/projects/shop/mocks/Get%20user')).body.hits).toBe(0);
  });

  it('round-trips the project configuration through export / import', async () => {
    await api('PATCH', '/api/projects/shop', { settings: { otpRegex: 'code (\\d{6})', autoResetDays: 3 } });
    await api('PATCH', '/api/projects/shop/users/customer2', { pinned: true, password: 'S3cret!' });
    await api('POST', '/api/projects/shop/providers', { preset: 'twilio', slug: 'sms-primary', labels: ['primary'], config: { statusCallbackUrl: 'http://app/status' } });
    await api('POST', '/api/projects/shop/providers/sms-primary/rules', { action: 'down', minutes: 10 });
    await api('POST', '/api/projects/shop/users/customer1/rules', { channel: 'sms', action: 'fail', count: 1, instance: 'sms-primary', errorCode: '30003' });
    const admin = (await api('GET', '/api/projects/shop/users/admin')).body;
    await api('POST', '/api/projects/shop/authenticators', { label: 'Admin 2FA', secret: 'JBSWY3DPEHPK3PXP', testUserId: admin.id });

    const plain = (await api('GET', '/api/projects/shop/export')).body;
    expect(plain.format).toBe('stubyard-project');
    expect(plain.authenticators).toBeUndefined();
    const exp = await api('GET', '/api/projects/shop/export?secrets=1&download=1');
    expect(exp.headers.get('content-disposition')).toMatch(/stubyard-shop\.json/);
    expect(exp.body.authenticators).toHaveLength(1);

    const imp = await api('POST', '/api/projects/import', { json: JSON.stringify(exp.body), slug: 'shop-copy', mode: 'create' });
    expect(imp.status).toBe(201);
    expect(imp.body.project.slug).toBe('shop-copy');
    expect(imp.body.imported).toMatchObject({ users: 3, providers: 2, rules: 2, authenticators: 1 });

    const orig = (await api('GET', '/api/projects/shop/overview')).body;
    const copy = (await api('GET', '/api/projects/shop-copy/overview')).body;
    expect(copy.project.settings).toMatchObject({ otpRegex: 'code (\\d{6})', autoResetDays: 3 });
    const strip = (u: any) => ({ name: u.name, role: u.role, email: u.email, phone: u.phone, pinned: u.pinned, password: u.password });
    expect(copy.users.map(strip)).toEqual(orig.users.map(strip));
    expect(copy.providers.map((p: any) => [p.slug, p.preset, p.isDefault, p.config])).toEqual(orig.providers.map((p: any) => [p.slug, p.preset, p.isDefault, p.config]));
    const userRules = (await api('GET', '/api/projects/shop-copy/users/customer1/rules')).body;
    const copyInst = copy.providers.find((p: any) => p.slug === 'sms-primary');
    expect(userRules).toMatchObject([{ action: 'fail', channel: 'sms', remainingCount: 1, errorCode: '30003', providerInstanceId: copyInst.id }]);
    expect((await api('GET', '/api/projects/shop-copy/providers/sms-primary/rules')).body).toMatchObject([{ action: 'down' }]);
    const copyAdmin = copy.users.find((u: any) => u.role === 'admin');
    expect(copy.authenticators).toMatchObject([{ label: 'Admin 2FA', testUserId: copyAdmin.id }]);
    const codeA = (await api('GET', '/api/projects/shop/authenticators/code?label=Admin%202FA')).body.code;
    const codeB = (await api('GET', '/api/projects/shop-copy/authenticators/code?label=Admin%202FA')).body.code;
    expect(codeB).toBe(codeA);
    const mocksA = (await api('GET', '/api/projects/shop/mocks')).body.map((m: any) => [m.name, m.path, m.scenarios, m.activeScenario]);
    const mocksB = (await api('GET', '/api/projects/shop-copy/mocks')).body.map((m: any) => [m.name, m.path, m.scenarios, m.activeScenario]);
    expect(mocksB).toEqual(mocksA);
    expect((await api('GET', '/mock/shop-copy/api/users/9')).body.id).toBe('9');

    // Same slug again → 409; replace mode overwrites the configuration.
    expect((await api('POST', '/api/projects/import', { json: exp.body, slug: 'shop-copy' })).status).toBe(409);
    await api('DELETE', '/api/projects/shop-copy/mocks/Search');
    const rep = await api('POST', '/api/projects/import', { json: exp.body, slug: 'shop-copy', mode: 'replace' });
    expect(rep.status).toBe(200);
    expect((await api('GET', '/api/projects/shop-copy/mocks')).body).toHaveLength(mocksA.length);
    expect((await api('GET', '/api/projects/shop-copy/users')).body).toHaveLength(3);

    expect((await api('POST', '/api/projects/import', { json: { hello: 1 }, slug: 'x' })).status).toBe(400);
  });

  it('prunes traffic logs past retention and supports filtering / paging the log', async () => {
    const hub = running.hub;
    const p = hub.projects.getBySlug('shop')!;
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const insert = hub.db.prepare(
      "INSERT INTO traffic_logs (id, project_id, direction, protocol, method, url, received_at, outcome, resolved) VALUES (?, ?, 'inbound', 'http', 'GET', '/old', ?, 'ok', ?)",
    );
    const user = hub.users.requireRef(p.id, 'customer1');
    for (let i = 0; i < 5; i++) insert.run(newId(), p.id, old, JSON.stringify({ testUserIds: [user.id], instance: 'sms-primary' }));
    insert.run(newId(), null, old, '{}');

    const byUser = (await api('GET', '/api/logs?project=shop&user=customer1')).body;
    expect(byUser.length).toBe(5);
    expect((await api('GET', '/api/logs?project=shop&instance=sms-primary&limit=2')).body).toHaveLength(2);
    const page1 = (await api('GET', '/api/logs?project=shop&limit=3')).body;
    const page2 = (await api('GET', `/api/logs?project=shop&limit=3&before=${page1[2].id}`)).body;
    expect(page2[0].id < page1[2].id).toBe(true);

    const r = await api('POST', '/api/system/maintenance');
    expect(r.body.logsExpired).toBe(6);
    expect((await api('GET', '/api/logs?project=shop&user=customer1')).body).toHaveLength(0);
    const storage = (await api('GET', '/api/system/storage')).body;
    expect(storage.retention).toMatchObject({ logRetentionDays: 7, maxDbMb: 500 });
    expect(storage.counts.api_mocks).toBeGreaterThan(0);
    expect(storage.lastRun.logsExpired).toBe(6);
  });

  it('factory reset needs confirmation and deletes everything but the HTTPS CA', async () => {
    expect((await api('POST', '/api/factory-reset', { confirm: 'yes' })).status).toBe(400);
    const caBefore = (await api('GET', '/api/ca.crt')).body;
    const r = await api('POST', '/api/factory-reset', { confirm: 'DELETE EVERYTHING' });
    expect(r.status).toBe(200);
    expect(r.body.projects).toBe(2);
    expect((await api('GET', '/api/projects')).body).toEqual([]);
    expect((await api('GET', '/api/logs')).body).toEqual([]);
    expect((await api('GET', '/api/ca.crt')).body).toBe(caBefore);
    expect((await api('GET', '/mock/shop/api/users/1')).status).toBe(404);
  });
});
