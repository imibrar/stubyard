import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { mcpToolAccess, staleCompositeRoutes } from '../src/http/routes/mcp.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

// C1 slice S7: the contract MCP tools (contracts/mcp-tools.ts) and the @stubyard/client contracts helpers
// (packages/client/src/contracts.ts). No Mailpit needed (an in-memory hub like contracts-routes.e2e.test.ts).

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
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let close: () => Promise<void>;
let base: string;
let dataDir: string;
let sdk: any;

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
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

/** Waits until the request's log has its contract result. */
const checked = (res: { headers: Headers }) => {
  const id = res.headers.get('x-hub-request-id')!;
  expect(id).toBeTruthy();
  return waitFor(() => {
    const l = hub.traffic.repo.get(id);
    return l && l.respondedAt && l.contract ? l : null;
  });
};

const CRM = `openapi: 3.0.3
info:
  title: CRM
  version: 1.0.0
paths:
  /users:
    post:
      operationId: createUser
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email]
              properties:
                email: { type: string }
                age: { type: integer }
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { type: object }
              example: { id: u_1 }
  /users/{id}:
    get:
      operationId: getUser
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
              example: { id: 1 }
`;

const NEW_TOOLS = ['import_openapi', 'list_api_specs', 'get_api_spec', 'set_contract_mode', 'reimport_openapi', 'delete_api_spec', 'check_contract', 'get_contract_issues'];

describe('contract MCP tools and client helpers (C1 S7)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-mcp-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Shop' })).status).toBe(201);
    expect((await api('POST', '/api/projects', { name: 'Sdk' })).status).toBe(201);
    // Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
    sdk = await import(new URL('../../packages/client/src/contracts.ts', import.meta.url).pathname);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the tools with annotations', async () => {
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools as { name: string; annotations?: any }[];
    const by = new Map(tools.map((t) => [t.name, t]));
    for (const n of NEW_TOOLS) expect(by.has(n), n).toBe(true);
    for (const n of ['list_api_specs', 'get_api_spec', 'check_contract', 'get_contract_issues']) expect(by.get(n)!.annotations?.readOnlyHint, n).toBe(true);
    expect(by.get('delete_api_spec')!.annotations?.destructiveHint).toBe(true);
  });

  it('import_openapi: dry run writes nothing, then the import creates the mocks', async () => {
    const dry = await mcp('import_openapi', { project: 'shop', text: CRM, name: 'crm', prefix: '/crm', dry_run: true });
    expect(dry.isError).toBe(false);
    expect(dry.data.dryRun).toBe(true);
    expect(dry.data.created).toHaveLength(2);
    expect((await api('GET', '/api/projects/shop/mocks')).body).toEqual([]);

    const r = await mcp('import_openapi', { project: 'shop', text: CRM, name: 'crm', prefix: '/crm' });
    expect(r.isError).toBe(false);
    expect(r.data.spec).toMatchObject({ name: 'crm', prefix: '/crm', mode: 'report', operations: 2 });
    const mocks = (await api('GET', '/api/projects/shop/mocks')).body as any[];
    expect(mocks.map((m) => m.specOperation).sort()).toEqual(['GET /users/{id}', 'POST /users']);

    const bad = await mcp('import_openapi', { project: 'shop' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/stubyard answered 400/);
  });

  it('list_api_specs / get_api_spec', async () => {
    const list = await mcp('list_api_specs', { project: 'shop' });
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ name: 'crm', mocks: 2 });
    expect(list.data[0].mockBaseUrl).toMatch(/\/mock\/shop\/api\/crm$/);

    const one = await mcp('get_api_spec', { project: 'shop', spec: 'crm' });
    expect(one.data.operationList.map((o: any) => o.key).sort()).toEqual(['GET /users/{id}', 'POST /users']);
    expect(one.data.document).toBeUndefined();
    expect((await mcp('get_api_spec', { project: 'shop', spec: 'crm', document: true })).data.document.openapi).toMatch(/^3\./);
    expect((await mcp('get_api_spec', { project: 'shop', spec: 'nope' })).isError).toBe(true);
  });

  it('check_contract on a bad sample request answers the issues', async () => {
    const r = await mcp('check_contract', { project: 'shop', spec: 'crm', operation: 'POST /users', request: { body: { age: 'old' } }, response: { status: 500 } });
    expect(r.isError).toBe(false);
    expect(r.data.request.level).toBe('error');
    expect(r.data.request.issues.some((i: any) => i.check === 'contract.body')).toBe(true);
    expect(r.data.response.issues.some((i: any) => i.check === 'contract.response-status')).toBe(true);

    const byPath = await mcp('check_contract', { project: 'shop', spec: 'crm', method: 'GET', path: '/crm/users/7', request: {} });
    expect(byPath.data.operation.key).toBe('GET /users/{id}');
    expect(byPath.data.request.counts.error).toBe(0);
    // Nothing is logged by a check.
    expect((await api('GET', '/api/logs?project=shop&contract=checked')).body).toHaveLength(0);
  });

  it('set_contract_mode, then get_contract_issues and get_traffic contract after real traffic', async () => {
    const strict = await mcp('set_contract_mode', { project: 'shop', spec: 'crm', mode: 'strict' });
    expect(strict.data.mode).toBe('strict');
    const refused = await api('POST', '/mock/shop/api/crm/users', { age: 'old' });
    expect(refused.status).toBe(400);
    await checked(refused);
    expect((await mcp('set_contract_mode', { project: 'shop', spec: 'crm', mode: 'report' })).data.mode).toBe('report');

    const bad = await api('POST', '/mock/shop/api/crm/users', { age: 'old' });
    expect(bad.status).toBe(201);
    await checked(bad);
    const good = await api('GET', '/mock/shop/api/crm/users/7');
    expect(good.status).toBe(200);
    await checked(good);

    const issues = await mcp('get_contract_issues', { project: 'shop', spec: 'crm' });
    expect(issues.data).toMatchObject({ project: 'shop', checked: 3, withIssues: 2, error: 2 });
    expect(issues.data.violations[0].logId).toBe(bad.headers.get('x-hub-request-id'));
    expect(issues.data.byCheck.map((c: any) => c.check)).toContain('contract.body');
    expect((await mcp('get_contract_issues', { project: 'shop', limit: 1 })).data.violations).toHaveLength(1);

    const traffic = await mcp('get_traffic', { project: 'shop', contract: 'issues' });
    expect(traffic.data).toHaveLength(2);
    expect((await mcp('get_traffic', { project: 'shop', contract: 'checked' })).data).toHaveLength(3);
  });

  it('reimport_openapi keeps the spec; delete_api_spec keeps or deletes the mocks', async () => {
    const re = await mcp('reimport_openapi', { project: 'shop', spec: 'crm' });
    expect(re.isError).toBe(false);
    expect(re.data.unchanged).toBe(true);

    const del = await mcp('delete_api_spec', { project: 'shop', spec: 'crm' });
    expect(del.isError).toBe(false);
    expect((await mcp('list_api_specs', { project: 'shop' })).data).toEqual([]);
    const kept = (await api('GET', '/api/projects/shop/mocks')).body as any[];
    expect(kept).toHaveLength(2);
    expect(kept.every((m) => m.specId == null)).toBe(true);

    await mcp('import_openapi', { project: 'shop', text: CRM, name: 'crm2', prefix: '/crm2' });
    expect((await api('GET', '/api/projects/shop/mocks')).body).toHaveLength(4);
    expect((await mcp('delete_api_spec', { project: 'shop', spec: 'crm2', mocks: 'delete' })).isError).toBe(false);
    expect((await api('GET', '/api/projects/shop/mocks')).body).toHaveLength(2);
  });

  it('client helpers over HTTP: import, list, get, check, issues, expectNoContractIssues, delete', async () => {
    const t = { apiUrl: base, project: 'sdk', apiToken: '' };
    const imported = await sdk.importOpenApi(t, { spec: CRM, name: 'crm', prefix: '/crm' });
    expect(imported.spec).toMatchObject({ name: 'crm', operations: 2 });
    expect(imported.created).toHaveLength(2);
    expect((await sdk.listApiSpecs(t)).map((s: any) => s.name)).toEqual(['crm']);
    expect((await sdk.getApiSpec(t, 'crm')).operationList).toHaveLength(2);
    expect(await sdk.listSpecOperations(t, 'crm')).toHaveLength(2);
    expect((await sdk.listContractChecks(t)).map((c: any) => c.id)).toContain('contract.body');
    expect((await sdk.updateApiSpec(t, 'crm', { mode: 'report' })).mode).toBe('report');
    expect((await sdk.reimportOpenApi(t, 'crm', { dryRun: true })).dryRun).toBe(true);

    const check = await sdk.checkContract(t, { spec: 'crm', operation: 'createUser', request: { body: { age: 'old' } } });
    expect(check.request.level).toBe('error');

    // Clean traffic passes.
    await checked(await api('GET', '/mock/sdk/api/crm/users/3'));
    expect((await sdk.expectNoContractIssues(t)).checked).toBe(1);

    const bad = await api('POST', '/mock/sdk/api/crm/users', { age: 'old' });
    await checked(bad);
    const logId = bad.headers.get('x-hub-request-id')!;
    const issues = await sdk.contractIssues(t, { spec: 'crm' });
    expect(issues).toMatchObject({ checked: 2, withIssues: 1, error: 1 });
    await expect(sdk.expectNoContractIssues(t)).rejects.toThrow(new RegExp(`1 request\\(s\\) broke the API contract[\\s\\S]*\\[error\\] ${logId} POST [\\s\\S]*contract\\.`));
    const logs = await sdk.contractLogs(t);
    expect(logs.map((l: any) => l.id)).toEqual([logId]);

    await expect(sdk.getApiSpec(t, 'nope')).rejects.toMatchObject({ status: 404 });
    await sdk.deleteApiSpec(t, 'crm', { mocks: 'delete' });
    expect(await sdk.listApiSpecs(t)).toEqual([]);
    expect((await api('GET', '/api/projects/sdk/mocks')).body).toEqual([]);
  });

  it('access: every new tool is mapped from its route; no stale composite lines', () => {
    const access = mcpToolAccess(app);
    const perm = (n: string) => (access.get(n) as { permission: string } | null)?.permission;
    for (const n of NEW_TOOLS) expect(perm(n), n).toBeTruthy();
    for (const n of ['list_api_specs', 'get_api_spec', 'check_contract', 'get_contract_issues']) expect(perm(n), n).toBe('project.view');
    for (const n of ['import_openapi', 'set_contract_mode', 'reimport_openapi', 'delete_api_spec']) expect(perm(n), n).toBe('project.providers');
    expect(staleCompositeRoutes()).toEqual([]);
  });
});
