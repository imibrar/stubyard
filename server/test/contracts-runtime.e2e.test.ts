import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

// C1 slice S5b: request checks for spec-backed mocks (report / strict) and the app's responses to webhook deliveries.
// No Mailpit needed (an in-memory hub like runs-verdict.e2e.test.ts).

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

let hub: Hub;
let close: () => Promise<void>;
let base: string;
let dataDir: string;
let appServer: http.Server;
let appUrl: string;
let projectId = '';

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
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
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** The finished log of a mock call (by its x-hub-request-id). */
const logOf = (res: { headers: Headers }) => {
  const id = res.headers.get('x-hub-request-id')!;
  expect(id).toBeTruthy();
  return waitFor(() => {
    const l = hub.traffic.repo.get(id);
    return l && l.respondedAt ? l : null;
  });
};

const CRM = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'CRM', version: '1.2.0' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/users': {
      post: {
        operationId: 'createUser',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, age: { type: 'integer' } } },
            },
          },
        },
        responses: { '201': { description: 'created', content: { 'application/json': { schema: { type: 'object' }, example: { id: 'u_1' } } } } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        security: [{ bearer: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' }, example: { id: 1 } } } } },
      },
    },
  },
});

const HOOKS = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'App hooks', version: '1.0.0' },
  servers: [{ url: 'http://localhost/app' }],
  paths: {
    '/webhooks/payment': {
      post: {
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', required: ['received'], properties: { received: { type: 'boolean' } } } } },
          },
        },
      },
    },
  },
});

describe('contract runtime checks (C1 S5b)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-rt-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    // The app: answers webhook deliveries with a body that violates the HOOKS spec ("received" must be a boolean).
    appServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"received":"yes"}'));
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;

    const project = await api('POST', '/api/projects', { name: 'Shop' });
    expect(project.status).toBe(201);
    projectId = project.body.id;
    const imported = await hub.contracts.import(projectId, { name: 'crm', source: { kind: 'inline', text: CRM }, prefix: '/crm' });
    expect(imported.created.length).toBe(2);
  });

  afterAll(async () => {
    await close?.();
    await new Promise<void>((r) => (appServer ? appServer.close(() => r()) : r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('records a clean result for a valid request', async () => {
    const r = await api('POST', '/mock/shop/api/crm/users', { email: 'a@b.co', age: 30 });
    expect(r.status).toBe(201);
    const log = await logOf(r);
    expect(log.contract).toMatchObject({ v: 1, subject: 'mock-request', source: 'spec', spec: { name: 'crm', version: '1.2.0' }, mode: 'report', enforced: false, level: null });
    expect(log.contract!.operation).toMatchObject({ key: 'POST /users', operationId: 'createUser' });
    expect(log.contractLevel).toBeNull();
    expect(log.resolved.contract).toMatchObject({ spec: 'crm', operation: 'POST /users', level: null });
  });

  it('report mode: an invalid body is recorded and the mock still answers', async () => {
    const r = await api('POST', '/mock/shop/api/crm/users', { age: 'old' });
    expect(r.status).toBe(201);
    const log = await logOf(r);
    expect(log.contractLevel).toBe('error');
    expect(log.contract!.enforced).toBe(false);
    expect(log.contract!.counts.error).toBeGreaterThanOrEqual(2);
    expect(log.contract!.issues.every((i) => i.check === 'contract.body')).toBe(true);
    expect(log.outcome).toBe('ok');
  });

  it('records an unknown operation under the prefix (no mock answers it)', async () => {
    const r = await api('GET', '/mock/shop/api/crm/orders');
    expect(r.status).toBe(404);
    const log = await logOf(r);
    expect(log.contractLevel).toBe('error');
    expect(log.contract!.issues[0]).toMatchObject({ check: 'contract.unknown-operation', where: 'operation' });
    expect(log.contract!.operation).toBeNull();
  });

  it('report mode: missing auth is a warning only', async () => {
    const r = await api('GET', '/mock/shop/api/crm/users/7');
    expect(r.status).toBe(200);
    const log = await logOf(r);
    expect(log.contractLevel).toBe('warn');
    expect(log.contract!.issues[0].check).toBe('contract.auth-missing');
  });

  it('strict mode answers the stubyard contract error instead of the mock', async () => {
    hub.contracts.update(projectId, 'crm', { mode: 'strict' });

    const bad = await api('POST', '/mock/shop/api/crm/users', { age: 'old' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'Request does not match the OpenAPI contract', spec: 'crm', operation: 'POST /users' });
    expect(bad.body.issues.length).toBeGreaterThan(0);
    expect(bad.body.requestId).toBe(bad.headers.get('x-hub-request-id'));
    const log = await logOf(bad);
    expect(log.contract).toMatchObject({ mode: 'strict', enforced: true, level: 'error' });
    expect(log.outcome).toBe('invalid');

    const noAuth = await api('GET', '/mock/shop/api/crm/users/7');
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.issues[0].check).toBe('contract.auth-missing');

    const ok = await api('GET', '/mock/shop/api/crm/users/7', undefined, { authorization: 'Bearer sekret-token-123' });
    expect(ok.status).toBe(200);
    expect((await logOf(ok)).contract).toMatchObject({ mode: 'strict', enforced: false, level: null });

    // A bad path param with credentials: the token never shows up in the stored issues.
    const badId = await api('GET', '/mock/shop/api/crm/users/abc', undefined, { authorization: 'Bearer sekret-token-123', cookie: 'sid=cookie-value-xyz' });
    expect(badId.status).toBe(400);
    expect(badId.text).not.toContain('sekret-token-123');
    expect(JSON.stringify((await logOf(badId)).contract)).not.toMatch(/sekret-token-123|cookie-value-xyz/);

    // X-Hub-Contract: report downgrades one request.
    const reported = await api('POST', '/mock/shop/api/crm/users', { age: 'old' }, { 'x-hub-contract': 'report' });
    expect(reported.status).toBe(201);
    expect((await logOf(reported)).contract).toMatchObject({ mode: 'report', enforced: false, level: 'error' });

    // X-Hub-Contract: off skips the check.
    const off = await api('POST', '/mock/shop/api/crm/users', { age: 'old' }, { 'x-hub-contract': 'off' });
    expect(off.status).toBe(201);
    expect((await logOf(off)).contract).toBeNull();

    hub.contracts.update(projectId, 'crm', { mode: 'report' });
    expect((await api('POST', '/mock/shop/api/crm/users', { age: 'old' })).status).toBe(201);
  });

  it("checks the app's response to a webhook template with a contract", async () => {
    await hub.contracts.import(projectId, { name: 'app-hooks', role: 'app', source: { kind: 'inline', text: HOOKS } });
    const t = await api('POST', '/api/projects/shop/webhook-templates', {
      name: 'payment.done',
      targetUrl: `${appUrl}/app/webhooks/payment`,
      bodyTemplate: '{"id":"{{uuid}}"}',
      contract: { spec: 'app-hooks', operation: 'POST /webhooks/payment' },
    });
    expect(t.status, t.text).toBe(201);
    const r = await api('POST', `/api/projects/shop/webhook-templates/${t.body.id}/send`, {});
    expect(r.status, r.text).toBe(200);
    const log = await waitFor(() => hub.traffic.repo.get(r.body.logId)?.contract ? hub.traffic.repo.get(r.body.logId) : null);
    expect(log!.contract).toMatchObject({ subject: 'app-response', spec: { name: 'app-hooks' }, operation: { key: 'POST /webhooks/payment' }, level: 'error' });
    expect(log!.contract!.issues[0]).toMatchObject({ check: 'contract.response-body', side: 'response' });

    // Without an explicit contract the role=app spec is auto-matched (server path /app stripped).
    const auto = await api('POST', '/api/projects/shop/webhook-templates', { name: 'payment.auto', targetUrl: `${appUrl}/app/webhooks/payment`, bodyTemplate: '{}' });
    const ar = await api('POST', `/api/projects/shop/webhook-templates/${auto.body.id}/send`, {});
    const alog = await waitFor(() => hub.traffic.repo.get(ar.body.logId)?.contract ? hub.traffic.repo.get(ar.body.logId) : null);
    expect(alog!.contract).toMatchObject({ subject: 'app-response', level: 'error' });

    // An outbound call that matches no app operation is not checked.
    const other = await api('POST', '/api/projects/shop/webhook-templates', { name: 'other', targetUrl: `${appUrl}/elsewhere`, bodyTemplate: '{}' });
    const or = await api('POST', `/api/projects/shop/webhook-templates/${other.body.id}/send`, {});
    expect(or.status).toBe(200);
    expect(hub.traffic.repo.get(or.body.logId)!.contract).toBeNull();
  });

  it('a project without specs: no contract field and no behaviour change', async () => {
    expect((await api('POST', '/api/projects', { name: 'Plain' })).status).toBe(201);
    expect((await api('POST', '/api/projects/plain/mocks', { name: 'Users', method: 'POST', path: '/crm/users', scenarios: [{ name: 'OK', status: 201, body: '{"id":1}' }] })).status).toBe(201);
    const r = await api('POST', '/mock/plain/api/crm/users', { age: 'old' }, { 'x-hub-contract': 'strict' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 1 });
    const log = await logOf(r);
    expect(log.contract).toBeNull();
    expect(log.contractLevel).toBeNull();
    expect(log.resolved.contract).toBeUndefined();
    const miss = await api('GET', '/mock/plain/api/crm/orders');
    expect(miss.status).toBe(404);
    expect((await logOf(miss)).contract).toBeNull();
  });
});
