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

// C1 slice S13a: OpenAPI contracts end to end, as a user would go through them: YAML import (dry run first) → spec
// mocks → traffic checked → issues by run → strict mode and the X-Hub-Contract override → re-import with an edited
// mock and a removed operation → URL import (and the SSRF refusals) → export / import round trip → MCP → delete
// keeping the mocks. No Mailpit needed (an in-memory hub like contracts-routes.e2e.test.ts).

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
let specServer: http.Server;
let specUrl: string;
/** What the local spec server answers at /openapi.yaml. */
let served = '';

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

async function mcp(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; data: any }> {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  const res = r.body.result;
  const text = res.content[0].text as string;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!res.isError, text, data };
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

/** The finished log once its contract result is recorded. */
const checked = (res: { headers: Headers }) => {
  const id = res.headers.get('x-hub-request-id')!;
  expect(id).toBeTruthy();
  return waitFor(() => {
    const l = hub.traffic.repo.get(id);
    return l && l.respondedAt && l.contract ? l : null;
  });
};

/** The shop API. v2 changes both examples and drops DELETE /orders/{id}. */
const shopYaml = (v: 1 | 2) => `openapi: 3.0.3
info:
  title: Shop API
  version: ${v}.0.0
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [sku, qty]
              properties:
                sku: { type: string }
                qty: { type: integer, minimum: 1 }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { type: object }
              example: { id: o_${v} }
  /orders/{id}:
    get:
      operationId: getOrder
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id: { type: integer }
                  status: { type: string }
              example: { id: 1, status: v${v} }
${
  v === 1
    ? `    delete:
      operationId: cancelOrder
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '204':
          description: cancelled
`
    : ''
}`;

/** A small JSON spec for the URL and MCP imports. */
const billing = (title: string) =>
  JSON.stringify({
    openapi: '3.1.0',
    info: { title, version: '1.0.0' },
    paths: {
      '/invoices': {
        post: {
          operationId: 'createInvoice',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } } } },
          },
          responses: { '201': { description: 'created', content: { 'application/json': { schema: { type: 'object' }, example: { id: 'inv_1' } } } } },
        },
      },
    },
  });

const C = '/api/projects/shop/contracts';
const mocksOf = async (slug = 'shop') => (await api('GET', `/api/projects/${slug}/mocks`)).body as any[];
const byOp = (mocks: any[], op: string) => mocks.find((m) => m.specOperation === op);

describe('OpenAPI contracts end to end (C1 S13a)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-e2e-'));
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
    // Serves the spec for URL imports; /to-metadata redirects to the cloud metadata address.
    specServer = http.createServer((req, res) => {
      if (req.url === '/openapi.yaml') return res.writeHead(200, { 'content-type': 'application/yaml' }).end(served);
      if (req.url === '/to-metadata') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => specServer.listen(0, '127.0.0.1', () => r()));
    specUrl = `http://127.0.0.1:${(specServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Shop' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    await new Promise<void>((r) => (specServer ? specServer.close(() => r()) : r()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('YAML import: the dry run writes nothing, then the import creates mocks that answer under the prefix', async () => {
    const dry = await api('POST', `${C}/specs`, { spec: shopYaml(1), name: 'shop-api', prefix: '/shop', dryRun: true });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.created.map((m: any) => m.specOperation).sort()).toEqual(['DELETE /orders/{id}', 'GET /orders/{id}', 'POST /orders']);
    expect((await api('GET', `${C}/specs`)).body).toEqual([]);
    expect(await mocksOf()).toEqual([]);

    const r = await api('POST', `${C}/specs`, { spec: shopYaml(1), name: 'shop-api', prefix: '/shop' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.spec).toMatchObject({ name: 'shop-api', prefix: '/shop', mode: 'report', role: 'mock', operations: 3, openapiVersion: '3.0.3', title: 'Shop API' });
    const mocks = await mocksOf();
    expect(mocks).toHaveLength(3);
    for (const m of mocks) expect(m).toMatchObject({ specId: r.body.spec.id, specEdited: false, enabled: true });

    const [listed] = (await api('GET', `${C}/specs`)).body;
    expect(listed.mockBaseUrl).toMatch(/\/mock\/shop\/api\/shop$/);
    const got = await api('GET', '/mock/shop/api/shop/orders/7');
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'v1' });
    const log = await checked(got);
    expect(log.contract).toMatchObject({ subject: 'mock-request', spec: { name: 'shop-api', version: '1.0.0' }, operation: { key: 'GET /orders/{id}' }, level: null });
  });

  it('report mode: a bad body still gets the mock answer, logged at error level and listed in /contracts/issues', async () => {
    const bad = await api('POST', '/mock/shop/api/shop/orders', { sku: 42, qty: 0 });
    expect(bad.status).toBe(201);
    expect(bad.body).toEqual({ id: 'o_1' });
    const log = await checked(bad);
    expect(log.contractLevel).toBe('error');
    expect(log.outcome).toBe('ok');
    expect(log.contract!.enforced).toBe(false);
    const pointers = log.contract!.issues.map((i) => i.pointer);
    expect(pointers).toEqual(expect.arrayContaining(['/sku', '/qty']));
    expect(log.contract!.issues.every((i) => i.check === 'contract.body')).toBe(true);

    const sum = await api('GET', `${C}/issues?spec=shop-api`);
    expect(sum.status).toBe(200);
    expect(sum.body).toMatchObject({ project: 'shop', checked: 2, withIssues: 1, error: 1 });
    expect(sum.body.violations.map((v: any) => v.logId)).toEqual([log.id]);
    expect(sum.body.byCheck[0]).toMatchObject({ check: 'contract.body' });
  });

  it('issues by run: X-Hub-Run attributes the traffic and /contracts/issues?run= sees only that run', async () => {
    const run = await api('POST', '/api/projects/shop/runs', { key: 'ci41' });
    expect(run.status, run.text).toBe(201);
    const bad = await api('POST', '/mock/shop/api/shop/orders', { qty: 'two' }, { 'x-hub-run': 'ci41' });
    expect(bad.status).toBe(201);
    const badLog = await checked(bad);
    expect(badLog.runId).toBe(run.body.id);
    const good = await api('GET', '/mock/shop/api/shop/orders/3', undefined, { 'x-hub-run': 'ci41' });
    expect(good.status).toBe(200);
    await checked(good);

    const inRun = await api('GET', `${C}/issues?run=ci41`);
    expect(inRun.status, inRun.text).toBe(200);
    expect(inRun.body).toMatchObject({ run: 'ci41', checked: 2, withIssues: 1, error: 1 });
    expect(inRun.body.violations.map((v: any) => v.logId)).toEqual([badLog.id]);
    // The whole project still counts the earlier traffic too.
    expect((await api('GET', `${C}/issues`)).body).toMatchObject({ checked: 4, withIssues: 2 });
    expect((await api('GET', `${C}/issues?run=nope`)).status).toBe(404);
  });

  it('strict mode answers 400 (outcome invalid); X-Hub-Contract: report lets one request through', async () => {
    expect((await api('PATCH', `${C}/specs/shop-api`, { mode: 'strict' })).body.mode).toBe('strict');

    const bad = await api('POST', '/mock/shop/api/shop/orders', { sku: 'A1' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'Request does not match the OpenAPI contract', spec: 'shop-api', operation: 'POST /orders', requestId: bad.headers.get('x-hub-request-id') });
    expect(bad.body.issues.some((i: any) => i.check === 'contract.body')).toBe(true);
    expect(bad.body.hint).toMatch(/X-Hub-Contract: report/);
    const log = await checked(bad);
    expect(log.outcome).toBe('invalid');
    expect(log.contract).toMatchObject({ mode: 'strict', enforced: true, level: 'error' });

    const ok = await api('POST', '/mock/shop/api/shop/orders', { sku: 'A1', qty: 2 });
    expect(ok.status).toBe(201);
    expect((await checked(ok)).contract).toMatchObject({ mode: 'strict', enforced: false, level: null });

    const through = await api('POST', '/mock/shop/api/shop/orders', { sku: 'A1' }, { 'x-hub-contract': 'report' });
    expect(through.status).toBe(201);
    expect((await checked(through)).contract).toMatchObject({ mode: 'report', enforced: false, level: 'error' });

    expect((await api('PATCH', `${C}/specs/shop-api`, { mode: 'report' })).body.mode).toBe('report');
    expect((await api('POST', '/mock/shop/api/shop/orders', { sku: 'A1' })).status).toBe(201);
  });

  it('an unknown path under the prefix answers 404 with an unknown-operation issue; a wrong method is method-not-allowed', async () => {
    const miss = await api('GET', '/mock/shop/api/shop/customers');
    expect(miss.status).toBe(404);
    const log = await checked(miss);
    expect(log.contractLevel).toBe('error');
    expect(log.contract!.operation).toBeNull();
    expect(log.contract!.issues[0]).toMatchObject({ check: 'contract.unknown-operation', where: 'operation' });

    const put = await api('PUT', '/mock/shop/api/shop/orders', { sku: 'A1', qty: 1 });
    expect(put.status).toBe(404);
    expect((await checked(put)).contract!.issues[0]).toMatchObject({ check: 'contract.method-not-allowed' });
  });

  it('/api/logs?contract= filters on the recorded results', async () => {
    const issues = (await api('GET', '/api/logs?project=shop&contract=issues')).body as any[];
    const all = (await api('GET', '/api/logs?project=shop&contract=checked')).body as any[];
    expect(issues.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(issues.length);
    for (const l of issues) expect(['error', 'warn']).toContain(l.contractLevel);
    expect(all.some((l) => l.contractLevel === null)).toBe(true);
    // The summary and the log filter agree on what has issues.
    expect((await api('GET', `${C}/issues`)).body.withIssues).toBe(issues.length);
  });

  it('re-import: the dry run previews, then the edited mock is kept and the removed operation disabled', async () => {
    const before = await mocksOf();
    const getOrder = byOp(before, 'GET /orders/{id}');
    const createOrder = byOp(before, 'POST /orders');
    const cancel = byOp(before, 'DELETE /orders/{id}');
    const edited = await api('PATCH', `/api/projects/shop/mocks/${getOrder.id}`, { description: 'answers status=packed' });
    expect(edited.status).toBe(200);
    expect(edited.body.specEdited).toBe(true);

    const dry = await api('POST', `${C}/specs/shop-api/reimport`, { spec: shopYaml(2), dryRun: true });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, unchanged: false });
    expect(dry.body.kept.map((k: any) => k.id)).toEqual([getOrder.id]);
    expect(dry.body.removed).toEqual([expect.objectContaining({ id: cancel.id, specOperation: 'DELETE /orders/{id}', action: 'disable' })]);
    expect(dry.body.updated.map((u: any) => u.specOperation)).toEqual(['POST /orders']);
    // Nothing changed yet.
    expect(((await api('POST', '/mock/shop/api/shop/orders', { sku: 'A', qty: 1 })).body as any).id).toBe('o_1');
    expect(byOp(await mocksOf(), 'DELETE /orders/{id}').enabled).toBe(true);

    const r = await api('POST', `${C}/specs/shop-api/reimport`, { spec: shopYaml(2) });
    expect(r.status, r.text).toBe(200);
    expect(r.body.spec).toMatchObject({ apiVersion: '2.0.0', operations: 2 });
    expect(r.body.kept).toEqual([expect.objectContaining({ id: getOrder.id, reason: 'edited' })]);
    expect(r.body.removed).toEqual([expect.objectContaining({ id: cancel.id, action: 'disable' })]);

    const after = await mocksOf();
    expect(after).toHaveLength(3);
    const keptMock = after.find((m) => m.id === getOrder.id);
    expect(keptMock).toMatchObject({ description: 'answers status=packed', specEdited: true });
    const removed = after.find((m) => m.id === cancel.id);
    expect(removed.enabled).toBe(false);
    expect(removed.description).toContain('(removed from spec)');
    expect(after.find((m) => m.id === createOrder.id)).toMatchObject({ specEdited: false });

    // The updated mock answers the v2 example; the kept one still answers the v1 example.
    expect((await api('POST', '/mock/shop/api/shop/orders', { sku: 'A', qty: 1 })).body).toEqual({ id: 'o_2' });
    expect((await api('GET', '/mock/shop/api/shop/orders/5')).body).toMatchObject({ status: 'v1' });
    // The removed operation is now unknown to the contract too.
    const gone = await api('DELETE', '/mock/shop/api/shop/orders/5');
    expect(gone.status).toBe(404);
    expect((await checked(gone)).contract!.issues[0].check).toBe('contract.method-not-allowed');

    // The same document again: unchanged.
    expect((await api('POST', `${C}/specs/shop-api/reimport`, { spec: shopYaml(2) })).body.unchanged).toBe(true);
  });

  it('URL import from a local server, re-import fetches it again; link-local / metadata URLs are refused', async () => {
    served = billing('Billing');
    const r = await api('POST', `${C}/specs`, { url: `${specUrl}/openapi.yaml`, name: 'billing', prefix: '/billing' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.spec).toMatchObject({ name: 'billing', source: { kind: 'url', url: `${specUrl}/openapi.yaml` }, title: 'Billing', operations: 1 });
    const hit = await api('POST', '/mock/shop/api/billing/invoices', { amount: 'ten' });
    expect(hit.status).toBe(201);
    expect((await checked(hit)).contractLevel).toBe('error');

    served = billing('Billing v2');
    const re = await api('POST', `${C}/specs/billing/reimport`, {});
    expect(re.status, re.text).toBe(200);
    expect(re.body.spec.title).toBe('Billing v2');

    // The default policy allows loopback but always refuses link-local (169.254.x, cloud metadata).
    const meta = await api('POST', `${C}/specs`, { url: 'http://169.254.169.254/latest/meta-data', name: 'meta' });
    expect(meta.status).toBe(400);
    expect(meta.text).toMatch(/link-local/);
    expect((await api('POST', `${C}/specs`, { url: 'http://metadata.google.internal/x', name: 'meta' })).text).toMatch(/cloud metadata/);
    // Checked again on a redirect.
    const hop = await api('POST', `${C}/specs`, { url: `${specUrl}/to-metadata`, name: 'meta' });
    expect(hop.status).toBe(400);
    expect(hop.text).toMatch(/169\.254\.169\.254.*link-local/);
    expect((await api('POST', `${C}/specs`, { url: 'file:///etc/passwd', name: 'meta' })).text).toMatch(/Only http\(s\)/);
    // A missing document is a 502 that never echoes the body.
    expect((await api('POST', `${C}/specs`, { url: `${specUrl}/missing.yaml`, name: 'meta' })).status).toBe(502);

    // STUBYARD_SPEC_FETCH=public refuses loopback as well.
    const prev = process.env.STUBYARD_SPEC_FETCH;
    process.env.STUBYARD_SPEC_FETCH = 'public';
    try {
      const pub = await api('POST', `${C}/specs`, { url: `${specUrl}/openapi.yaml`, name: 'pub' });
      expect(pub.status).toBe(400);
      expect(pub.text).toMatch(/STUBYARD_SPEC_FETCH=public/);
    } finally {
      if (prev === undefined) delete process.env.STUBYARD_SPEC_FETCH;
      else process.env.STUBYARD_SPEC_FETCH = prev;
    }
    expect((await api('GET', `${C}/specs`)).body.map((s: any) => s.name).sort()).toEqual(['billing', 'shop-api']);
  });

  it('export → import round trip: specs, mock links and checks work in the copy', async () => {
    const exp = await api('GET', '/api/projects/shop/export');
    expect(exp.status).toBe(200);
    expect(exp.body.apiSpecs.map((s: any) => s.name).sort()).toEqual(['billing', 'shop-api']);

    const imp = await api('POST', '/api/projects/import', { json: exp.body, slug: 'shop-copy', name: 'Shop copy' });
    expect(imp.status, imp.text).toBe(201);
    expect(imp.body.imported.apiSpecs).toBe(2);

    const specs = (await api('GET', '/api/projects/shop-copy/contracts/specs')).body as any[];
    const original = (await api('GET', `${C}/specs`)).body as any[];
    expect(specs.map((s) => s.name).sort()).toEqual(['billing', 'shop-api']);
    const copyShop = specs.find((s) => s.name === 'shop-api');
    const origShop = original.find((s) => s.name === 'shop-api');
    expect(copyShop.id).not.toBe(origShop.id);
    expect(copyShop).toMatchObject({ prefix: '/shop', mode: 'report', apiVersion: '2.0.0', operations: 2, mocks: 3 });
    expect(copyShop.mockBaseUrl).toMatch(/\/mock\/shop-copy\/api\/shop$/);

    const copyMocks = await mocksOf('shop-copy');
    expect(copyMocks).toHaveLength(4);
    expect(byOp(copyMocks, 'GET /orders/{id}')).toMatchObject({ specId: copyShop.id, specEdited: true });
    expect(byOp(copyMocks, 'POST /orders')).toMatchObject({ specId: copyShop.id, specEdited: false });

    // Traffic to the copy is checked against the copy's spec.
    const bad = await api('POST', '/mock/shop-copy/api/shop/orders', { qty: 1 });
    expect(bad.status).toBe(201);
    expect((await checked(bad)).contract).toMatchObject({ spec: { id: copyShop.id, name: 'shop-api' }, level: 'error' });
    expect((await api('GET', '/api/projects/shop-copy/contracts/issues')).body).toMatchObject({ checked: 1, withIssues: 1 });
  });

  it('MCP: import_openapi, check_contract and get_contract_issues by run', async () => {
    expect((await api('POST', '/api/projects', { name: 'Agent' })).status).toBe(201);
    const dry = await mcp('import_openapi', { project: 'agent', text: shopYaml(1), name: 'shop-api', prefix: '/shop', dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.data.dryRun).toBe(true);
    expect(await mocksOf('agent')).toEqual([]);
    const imp = await mcp('import_openapi', { project: 'agent', text: shopYaml(1), name: 'shop-api', prefix: '/shop' });
    expect(imp.isError, imp.text).toBe(false);
    expect(imp.data.created).toHaveLength(3);

    const check = await mcp('check_contract', { project: 'agent', spec: 'shop-api', operation: 'createOrder', request: { body: { sku: 1 } }, response: { status: 201, body: { id: 'o_1' } } });
    expect(check.isError, check.text).toBe(false);
    expect(check.data.operation.key).toBe('POST /orders');
    expect(check.data.request.level).toBe('error');
    expect(check.data.response.level).toBeNull();

    expect((await api('POST', '/api/projects/agent/runs', { key: 'agentrun' })).status).toBe(201);
    const bad = await api('POST', '/mock/agent/api/shop/orders', { sku: 'A' }, { 'x-hub-run': 'agentrun' });
    expect(bad.status).toBe(201);
    await checked(bad);
    await checked(await api('POST', '/mock/agent/api/shop/orders', { sku: 'B' }));

    const inRun = await mcp('get_contract_issues', { project: 'agent', run: 'agentrun' });
    expect(inRun.isError, inRun.text).toBe(false);
    expect(inRun.data).toMatchObject({ run: 'agentrun', checked: 1, withIssues: 1, error: 1 });
    expect(inRun.data.violations[0].logId).toBe(bad.headers.get('x-hub-request-id'));
    expect((await mcp('get_contract_issues', { project: 'agent' })).data).toMatchObject({ checked: 2, withIssues: 2 });
  });

  it('delete with mocks=keep: the mocks stay as hand-made mocks and their traffic is no longer checked', async () => {
    const del = await api('DELETE', `${C}/specs/shop-api?mocks=keep`);
    expect(del.status, del.text).toBe(200);
    expect(del.body).toMatchObject({ mocksDeleted: 0, mocksKept: 3 });
    expect((await api('GET', `${C}/specs`)).body.map((s: any) => s.name)).toEqual(['billing']);

    const left = await mocksOf();
    expect(left).toHaveLength(4);
    const unlinked = left.filter((m) => m.path.startsWith('/shop/'));
    expect(unlinked).toHaveLength(3);
    for (const m of unlinked) expect(m).toMatchObject({ specId: null, specEdited: false });

    // The mock still answers; with no spec over /shop nothing is checked (billing still is).
    const r = await api('POST', '/mock/shop/api/shop/orders', { sku: 42 });
    expect(r.status).toBe(201);
    expect((await logOf(r)).contract).toBeNull();
    expect((await checked(await api('POST', '/mock/shop/api/billing/invoices', { amount: 5 }))).contractLevel).toBeNull();
    expect((await api('DELETE', `${C}/specs/shop-api`)).status).toBe(404);
  });
});
