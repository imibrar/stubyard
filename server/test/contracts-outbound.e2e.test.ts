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

// C1 slice S13b: the app's answers to stubyard's outbound calls checked against role=app specs, end to end: a local
// app answers webhook templates (wrong body, undeclared status), a template's own contract overrides the auto-match,
// a payment webhook is auto-matched, and an outbound call no app operation covers is not checked.
// No Mailpit needed (an in-memory hub like contracts-runtime.e2e.test.ts).

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

/** How the local app answers, by request path (default 200 {"received":true}). */
const answers = new Map<string, { status: number; body: string; contentType?: string }>();

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
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

/** The app's webhook API: POST /hooks/orders answers 200 {received: boolean} (or 202); servers path /app is stripped. */
const APP = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'My app', version: '3.1.0' },
  servers: [{ url: 'https://myapp.example.com/app' }],
  paths: {
    '/hooks/orders': {
      post: {
        operationId: 'orderHook',
        responses: {
          '200': {
            description: 'ok',
            headers: { 'X-Request-Id': { required: true, schema: { type: 'string' } } },
            content: { 'application/json': { schema: { type: 'object', required: ['received'], properties: { received: { type: 'boolean' } } } } },
          },
          '202': { description: 'queued' },
        },
      },
    },
    '/hooks/stripe': {
      post: {
        operationId: 'stripeHook',
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['received'], properties: { received: { type: 'boolean' } } } } } },
        },
      },
    },
  },
});

/** A second app spec (the admin service) whose operation a template can name explicitly. */
const ADMIN = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Admin', version: '1.0.0' },
  paths: {
    '/events': {
      post: {
        operationId: 'adminEvent',
        responses: { '204': { description: 'no content' } },
      },
    },
  },
});

const PJ = '/api/projects/shop';

async function template(name: string, targetUrl: string, extra: Record<string, unknown> = {}) {
  const t = await api('POST', `${PJ}/webhook-templates`, { name, targetUrl, bodyTemplate: '{"id":"{{uuid}}"}', ...extra });
  expect(t.status, t.text).toBe(201);
  return t.body as { id: string; contract: unknown };
}

/** Send a template; answers its delivery log (with the contract result when one is recorded). */
async function send(id: string) {
  const r = await api('POST', `${PJ}/webhook-templates/${id}/send`, {});
  expect(r.status, r.text).toBe(200);
  expect(r.body.logId).toBeTruthy();
  return waitFor(() => {
    const l = hub.traffic.repo.get(r.body.logId);
    return l && l.respondedAt ? l : null;
  });
}

describe("contract checks of the app's answers to outbound calls (C1 S13b)", () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-out-'));
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
    appServer = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const a = answers.get((req.url ?? '').split('?')[0]) ?? { status: 200, body: '{"received":true}' };
        res.writeHead(a.status, { 'content-type': a.contentType ?? 'application/json', 'x-request-id': 'req-1' }).end(a.body);
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Shop' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    await new Promise<void>((r) => (appServer ? appServer.close(() => r()) : r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a role=app spec creates no mocks; before it exists nothing is checked', async () => {
    const plain = await template('before', `${appUrl}/app/hooks/orders`);
    expect((await send(plain.id)).contract).toBeNull();

    const r = await api('POST', `${PJ}/contracts/specs`, { spec: APP, name: 'my-app', role: 'app' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.spec).toMatchObject({ role: 'app', operations: 2 });
    expect(r.body.created).toEqual([]);
    expect((await api('GET', `${PJ}/mocks`)).body).toEqual([]);
    expect((await api('GET', `${PJ}/contracts/specs`)).body[0]).toMatchObject({ name: 'my-app', mockBaseUrl: null });
  });

  it('auto-match: a clean answer passes; a wrong body gives an app-response issue', async () => {
    const t = await template('order.created', `${appUrl}/app/hooks/orders`);
    const ok = await send(t.id);
    expect(ok.contract).toMatchObject({ subject: 'app-response', source: 'spec', spec: { name: 'my-app', version: '3.1.0' }, operation: { key: 'POST /hooks/orders', operationId: 'orderHook' }, level: null });
    expect(ok.resolved.contract).toMatchObject({ spec: 'my-app', operation: 'POST /hooks/orders', level: null });

    answers.set('/app/hooks/orders', { status: 200, body: '{"received":"yes","extra":1}' });
    const bad = await send(t.id);
    expect(bad.outcome).toBe('ok');
    expect(bad.contractLevel).toBe('error');
    expect(bad.contract!.issues[0]).toMatchObject({ check: 'contract.response-body', side: 'response', pointer: '/received' });
    expect(bad.contract!.enforced).toBe(false);
  });

  it('an undeclared status gives a response-status issue; a declared one without a body schema passes', async () => {
    const t = await template('order.updated', `${appUrl}/app/hooks/orders`);
    answers.set('/app/hooks/orders', { status: 500, body: 'boom', contentType: 'text/plain' });
    const bad = await send(t.id);
    expect(bad.resStatus).toBe(500);
    expect(bad.outcome).toBe('rejected');
    expect(bad.contractLevel).toBe('error');
    expect(bad.contract!.issues.map((i) => i.check)).toEqual(['contract.response-status']);

    answers.set('/app/hooks/orders', { status: 202, body: '' });
    expect((await send(t.id)).contract).toMatchObject({ level: null, counts: { error: 0 } });
    answers.delete('/app/hooks/orders');
  });

  it('the issues show up in the summary (subject app-response) and in /api/logs?contract=issues', async () => {
    const sum = await api('GET', `${PJ}/contracts/issues?subject=app-response`);
    expect(sum.status, sum.text).toBe(200);
    expect(sum.body).toMatchObject({ project: 'shop', withIssues: 2, error: 2 });
    expect(sum.body.byCheck.map((c: any) => c.check).sort()).toEqual(['contract.response-body', 'contract.response-status']);
    expect((await api('GET', `${PJ}/contracts/issues?subject=mock-request`)).body).toMatchObject({ checked: 0 });
    const logs = (await api('GET', '/api/logs?project=shop&contract=issues')).body as any[];
    expect(logs).toHaveLength(2);
  });

  it("a template's contract overrides the auto-match: another spec, an unmatched URL, a missing spec; null goes back to auto", async () => {
    expect((await api('POST', `${PJ}/contracts/specs`, { spec: ADMIN, name: 'admin', role: 'app' })).status).toBe(201);

    // The URL auto-matches my-app (200 {"received":true} is fine there), but the template names admin's operation.
    const t = await template('to-admin', `${appUrl}/app/hooks/orders`, { contract: { spec: 'admin', operation: 'POST /events' } });
    expect(t.contract).toEqual({ spec: 'admin', operation: 'POST /events' });
    const named = await send(t.id);
    expect(named.contract).toMatchObject({ spec: { name: 'admin' }, operation: { key: 'POST /events' }, level: 'error' });
    expect(named.contract!.issues[0].check).toBe('contract.response-status');

    // A URL no spec covers is checked when the template names the operation.
    const elsewhere = await template('elsewhere-named', `${appUrl}/somewhere/else`, { contract: { spec: 'my-app', operation: 'POST /hooks/orders' } });
    expect((await send(elsewhere.id)).contract).toMatchObject({ spec: { name: 'my-app' }, operation: { key: 'POST /hooks/orders' }, level: null });

    // A spec without an operation: matched by the URL within that spec only.
    const specOnly = await template('spec-only', `${appUrl}/events`, { contract: { spec: 'admin' } });
    answers.set('/events', { status: 204, body: '' });
    expect((await send(specOnly.id)).contract).toMatchObject({ spec: { name: 'admin' }, operation: { key: 'POST /events' }, level: null });
    answers.delete('/events');
    const wrongPath = await template('spec-wrong-path', `${appUrl}/app/hooks/orders`, { contract: { spec: 'admin' } });
    expect((await send(wrongPath.id)).contract!.issues[0]).toMatchObject({ check: 'contract.unknown-operation' });

    // A spec that is not imported is reported, not silently skipped.
    const missing = await template('missing-spec', `${appUrl}/app/hooks/orders`, { contract: { spec: 'ghost' } });
    const ml = await send(missing.id);
    expect(ml.contract).toMatchObject({ spec: null, level: 'info' });
    expect(ml.contract!.issues[0]).toMatchObject({ check: 'contract.unchecked' });

    // Clearing the template's contract falls back to the auto-match (my-app).
    const cleared = await api('PATCH', `${PJ}/webhook-templates/${t.id}`, { contract: null });
    expect(cleared.status, cleared.text).toBe(200);
    expect(cleared.body.contract).toBeNull();
    expect((await send(t.id)).contract).toMatchObject({ spec: { name: 'my-app' }, operation: { key: 'POST /hooks/orders' }, level: null });

    // mode off on the named spec: no check at all.
    await api('PATCH', `${PJ}/contracts/specs/admin`, { mode: 'off' });
    const off = await template('to-admin-off', `${appUrl}/app/hooks/orders`, { contract: { spec: 'admin', operation: 'POST /events' } });
    expect((await send(off.id)).contract).toBeNull();
    await api('PATCH', `${PJ}/contracts/specs/admin`, { mode: 'report' });
  });

  it('a payment webhook is auto-matched to the role=app spec', async () => {
    const inst = await api('POST', `${PJ}/payment-instances`, { preset: 'stripe-checkout', config: { webhookUrl: `${appUrl}/app/hooks/stripe`, webhookDelayMs: 0 } });
    expect(inst.status, inst.text).toBe(201);
    const key = inst.body.config.secretKey as string;
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: `${appUrl}/ok`,
      cancel_url: `${appUrl}/cancel`,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': '2500',
      'line_items[0][price_data][product_data][name]': 'T-shirt',
      'line_items[0][quantity]': '1',
    }).toString();
    const cs = await api('POST', '/pay/shop/stripe/v1/checkout/sessions', form, { authorization: `Bearer ${key}` });
    expect(cs.status, cs.text).toBe(200);
    const payId = (await api('GET', `${PJ}/payments/${cs.body.id}`)).body.id as string;

    // The app answers the Stripe webhooks without the "received" flag its own spec requires.
    answers.set('/app/hooks/stripe', { status: 200, body: '{"ok":true}' });
    const done = await api('POST', `${PJ}/payments/${payId}/complete`, { outcome: 'success' });
    expect(done.status, done.text).toBe(200);

    const hooks = await waitFor(() => {
      const ls = hub.traffic.repo
        .list({ projectId: hub.projects.require('shop').id, direction: 'outbound', limit: 200 })
        .map((l) => hub.traffic.repo.get(l.id)!)
        .filter((l) => l.resolved?.kind === 'payment-webhook');
      return ls.length >= 1 && ls.every((l) => l.respondedAt) ? ls : null;
    });
    for (const l of hooks) {
      expect(l.contract).toMatchObject({ subject: 'app-response', spec: { name: 'my-app' }, operation: { key: 'POST /hooks/stripe', operationId: 'stripeHook' }, level: 'error' });
      expect(l.contract!.issues[0]).toMatchObject({ check: 'contract.response-body' });
    }
    answers.delete('/app/hooks/stripe');
  });

  it('an outbound call that matches no app operation is not checked', async () => {
    const other = await template('other', `${appUrl}/not/in/any/spec`);
    const l = await send(other.id);
    expect(l.resStatus).toBe(200);
    expect(l.contract).toBeNull();
    expect(l.contractLevel).toBeNull();
    expect(l.resolved.contract).toBeUndefined();
    // A GET to a POST-only path is not matched either (auto-match never reports, it only skips).
    const get = await template('get-orders', `${appUrl}/app/hooks/orders`, { method: 'GET', bodyTemplate: '' });
    expect((await send(get.id)).contract).toBeNull();
  });
});
