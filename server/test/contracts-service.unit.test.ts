import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { blockedAddress, fetchSpec } from '../src/contracts/fetch.js';
import { contractSummary } from '../src/contracts/report.js';
import type { ContractResult } from '../src/contracts/types.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { newId } from '../src/util.js';

const YAML = (extra = '', usersResponse = 'OK') => `
openapi: 3.0.3
info: { title: CRM API, version: "1.0" }
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: ${usersResponse}
          content:
            application/json:
              example: [{ id: "u1" }]
    post:
      operationId: createUser
      responses:
        "201": { description: Created }
  /users/me:
    get:
      operationId: me
      responses:
        "200": { description: OK }
  /users/{id}:
    get:
      operationId: getUser
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { type: object, properties: { id: { type: string } } }
        "404": { description: Not found }
${extra}`;

let hub: Hub;
let dataDir: string;
let projectId: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-service-'));
});
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

beforeEach(() => {
  const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
  hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  projectId = hub.projects.create({ name: 'Hyper' }).id;
});
afterEach(() => hub.db.close());

const inline = (text: string) => ({ kind: 'inline' as const, text });

describe('ContractService.import', () => {
  it('creates the spec and one linked mock per operation, literal-first, after existing mocks', async () => {
    hub.mocks.create(projectId, { name: 'health', method: 'GET', path: '/health' });
    const events: string[] = [];
    hub.bus.subscribe((e) => events.push(e.type));
    const r = await hub.contracts.import(projectId, { source: inline(YAML()), prefix: '/crm' });
    expect(r.dryRun).toBe(false);
    expect(r.spec).toMatchObject({ name: 'crm-api', prefix: '/crm', role: 'mock', mode: 'report', title: 'CRM API', apiVersion: '1.0', operations: 4 });
    expect(r.created.map((m) => m.name)).toEqual(['listUsers', 'createUser', 'me', 'getUser']);
    const list = hub.mocks.list(projectId);
    expect(list.map((m) => m.path)).toEqual(['/health', '/crm/users', '/crm/users', '/crm/users/me', '/crm/users/:id']);
    const linked = hub.mocks.listBySpec(r.spec.id);
    expect(linked).toHaveLength(4);
    expect(linked.every((m) => m.specId === r.spec.id && m.specHash)).toBe(true);
    expect(linked.find((m) => m.name === 'getUser')).toMatchObject({ specOperation: 'GET /users/{id}', activeScenario: '200 OK' });
    expect(events).toContain('contracts.changed');
    expect(events).toContain('mocks.changed');
    expect(hub.contracts.list(projectId).map((s) => s.name)).toEqual(['crm-api']);
    expect(hub.contracts.get(projectId, 'crm-api').document.openapi).toBeTruthy();
  });

  it('a dry run returns the plan and writes nothing', async () => {
    const r = await hub.contracts.import(projectId, { name: 'crm', source: inline(YAML()), dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.created).toHaveLength(4);
    expect(r.created.every((m) => m.id === null)).toBe(true);
    expect(hub.contracts.list(projectId)).toEqual([]);
    expect(hub.mocks.list(projectId)).toEqual([]);
  });

  it('prefixes a taken mock name with the spec name', async () => {
    hub.mocks.create(projectId, { name: 'listUsers', method: 'GET', path: '/other' });
    hub.mocks.create(projectId, { name: 'crm · me', method: 'GET', path: '/other2' });
    hub.mocks.create(projectId, { name: 'me', method: 'GET', path: '/other3' });
    const r = await hub.contracts.import(projectId, { name: 'crm', source: inline(YAML()) });
    const names = r.created.map((m) => m.name);
    expect(names).toContain('crm · listUsers');
    expect(names).toContain('createUser');
    expect(names).toContain('me (2)');
  });

  it('role=app creates no mocks; a second mock spec with the same prefix is refused', async () => {
    const app = await hub.contracts.import(projectId, { name: 'app', role: 'app', source: inline(YAML()) });
    expect(app.created).toEqual([]);
    expect(hub.contracts.appSpecsFor(projectId).map((c) => c.spec.name)).toEqual(['app']);
    await hub.contracts.import(projectId, { name: 'a', source: inline(YAML()), prefix: '/x' });
    await expect(hub.contracts.import(projectId, { name: 'b', source: inline(YAML()), prefix: 'x/' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('ContractService.reimport', () => {
  const V2 = YAML(
    `  /teams:
    get:
      operationId: listTeams
      responses:
        "200": { description: OK }`,
    'Users list',
  ).replace(/  \/users\/me:\n    get:\n      operationId: me\n      responses:\n        "200": \{ description: OK \}\n/, '');

  it('creates new, updates unedited changed, keeps edited, disables removed', async () => {
    const r1 = await hub.contracts.import(projectId, { name: 'crm', source: inline(YAML()) });
    // Change listUsers in the spec (description → scenario text unchanged, so change the example instead).
    const v2 = V2.replace('[{ id: "u1" }]', '[{ id: "u2" }]').replace('getUser\n', 'getUser\n      summary: Get one\n');
    // Edit getUser by hand: the spec change must not overwrite it.
    hub.mocks.update(projectId, 'getUser', { activeScenario: '404 Not Found', scenarios: [{ name: '200 OK', body: '{"id":"mine"}' }, { name: '404 Not Found', status: 404 }] });

    const dry = await hub.contracts.reimport(projectId, 'crm', { source: inline(v2), dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.created.map((m) => m.name)).toEqual(['listTeams']);
    expect(dry.updated.map((m) => m.name)).toEqual(['listUsers']);
    expect(dry.kept.map((m) => m.name)).toEqual(['getUser']);
    expect(dry.removed).toMatchObject([{ name: 'me', action: 'disable' }]);
    expect(hub.mocks.listBySpec(r1.spec.id)).toHaveLength(4);

    const r = await hub.contracts.reimport(projectId, 'crm', { source: inline(v2) });
    expect(r.unchanged).toBe(false);
    const byName = Object.fromEntries(hub.mocks.list(projectId).map((m) => [m.name, m]));
    expect(byName.listUsers.scenarios[0].body).toContain('u2');
    expect(byName.getUser.scenarios[0].body).toBe('{"id":"mine"}');
    expect(byName.me).toMatchObject({ enabled: false });
    expect(byName.me.description).toMatch(/\(removed from spec\)$/);
    expect(byName.listTeams.specId).toBe(r1.spec.id);
    expect(hub.contracts.get(projectId, 'crm').hash).not.toBe(r1.spec.hash);

    const forced = await hub.contracts.reimport(projectId, 'crm', { source: inline(v2.replace('Get one', 'Get a user')), overwriteEdited: true });
    expect(forced.updated).toMatchObject([{ name: 'getUser', overwritten: true }]);
    expect(hub.mocks.require(projectId, 'getUser').description).toMatch(/^Get a user · from spec crm/);
  });

  it('import with an existing name upserts; the same document is unchanged', async () => {
    await hub.contracts.import(projectId, { name: 'crm', source: inline(YAML()) });
    const again = await hub.contracts.import(projectId, { name: 'crm', source: inline(YAML()) });
    expect(again.unchanged).toBe(true);
    expect(hub.mocks.list(projectId)).toHaveLength(4);
    const re = await hub.contracts.reimport(projectId, 'crm');
    expect(re.unchanged).toBe(true);
  });
});

describe('ContractService.update / delete', () => {
  it('updates metadata and deletes with or without the mocks', async () => {
    const a = await hub.contracts.import(projectId, { name: 'a', source: inline(YAML()), prefix: '/a' });
    await hub.contracts.import(projectId, { name: 'b', source: inline(YAML()), prefix: '/b' });
    expect(hub.contracts.update(projectId, 'a', { mode: 'strict' }).mode).toBe('strict');

    const keep = hub.contracts.delete(projectId, a.spec.id);
    expect(keep).toMatchObject({ mocksDeleted: 0, mocksKept: 4 });
    const kept = hub.mocks.list(projectId).filter((m) => m.path.startsWith('/a/'));
    expect(kept).toHaveLength(4);
    expect(kept.every((m) => m.specId === null && m.specOperation === null)).toBe(true);

    const del = hub.contracts.delete(projectId, 'b', { deleteMocks: true });
    expect(del).toMatchObject({ mocksDeleted: 4, mocksKept: 0 });
    expect(hub.mocks.list(projectId).filter((m) => m.path.startsWith('/b/'))).toEqual([]);
    expect(hub.contracts.list(projectId)).toEqual([]);
  });
});

describe('ContractService.specForMockPath', () => {
  it('picks the longest prefix, then the operation', async () => {
    await hub.contracts.import(projectId, { name: 'root', source: inline(YAML()), prefix: '' });
    await hub.contracts.import(projectId, { name: 'v2', source: inline(YAML()), prefix: '/v2' });

    const a = hub.contracts.specForMockPath(projectId, 'GET', '/v2/users/42?x=1');
    expect(a && 'op' in a && a.spec.name === 'v2' && a.op.key === 'GET /users/{id}' && a.params).toEqual({ id: '42' });
    const me = hub.contracts.specForMockPath(projectId, 'GET', '/v2/users/me');
    expect(me && 'op' in me && me.op.operationId).toBe('me');
    const root = hub.contracts.specForMockPath(projectId, 'GET', '/users');
    expect(root && root.spec.name).toBe('root');
    const mna = hub.contracts.specForMockPath(projectId, 'DELETE', '/v2/users');
    expect(mna && 'methodNotAllowed' in mna && mna.methodNotAllowed.sort()).toEqual(['GET', 'POST']);
    const unknown = hub.contracts.specForMockPath(projectId, 'GET', '/v2/nope');
    expect(unknown && 'unknownOperation' in unknown && unknown.spec.name).toBe('v2');
    // /v2x is not below /v2: the root spec covers it.
    expect(hub.contracts.specForMockPath(projectId, 'GET', '/v2x/users')?.spec.name).toBe('root');

    hub.contracts.update(projectId, 'root', { mode: 'off' });
    expect(hub.contracts.specForMockPath(projectId, 'GET', '/users')).toBeNull();
    // The cache follows the update.
    expect(hub.contracts.compiled(hub.contracts.get(projectId, 'v2'))).toBe(hub.contracts.compiled(hub.contracts.get(projectId, 'v2')));
  });
});

describe('fetchSpec', () => {
  const prev = process.env.STUBYARD_SPEC_FETCH;
  afterEach(() => {
    if (prev === undefined) delete process.env.STUBYARD_SPEC_FETCH;
    else process.env.STUBYARD_SPEC_FETCH = prev;
  });

  it('imports from a local URL, following redirects, and refuses too many', async () => {
    delete process.env.STUBYARD_SPEC_FETCH;
    const server = http.createServer((req, res) => {
      const n = Number(/^\/r(\d+)$/.exec(req.url ?? '')?.[1] ?? -1);
      if (n > 0) return res.writeHead(302, { location: `/r${n - 1}` }).end();
      if (n === 0 || req.url === '/openapi.yaml') return res.writeHead(200, { 'content-type': 'application/yaml' }).end(YAML());
      res.writeHead(500).end('secret stack trace');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r = await hub.contracts.import(projectId, { name: 'crm', source: { kind: 'url', url: `${base}/r3` } });
      expect(r.created).toHaveLength(4);
      expect(r.spec.source).toEqual({ kind: 'url', url: `${base}/r3` });
      expect((await hub.contracts.reimport(projectId, 'crm')).unchanged).toBe(true);
      await expect(fetchSpec(`${base}/r4`)).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('redirects') });
      const err = await fetchSpec(`${base}/boom`).catch((e: Error) => e);
      expect(err).toMatchObject({ statusCode: 502 });
      expect((err as Error).message).not.toContain('secret');
    } finally {
      server.close();
    }
  });

  it('is refused when STUBYARD_SPEC_FETCH=0', async () => {
    process.env.STUBYARD_SPEC_FETCH = '0';
    await expect(fetchSpec('http://127.0.0.1:1/openapi.json')).rejects.toMatchObject({ statusCode: 400 });
    await expect(hub.contracts.import(projectId, { source: { kind: 'url', url: 'http://127.0.0.1:1/x' } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses link-local / metadata always and 127.0.0.1 with STUBYARD_SPEC_FETCH=public', async () => {
    delete process.env.STUBYARD_SPEC_FETCH;
    await expect(fetchSpec('http://169.254.169.254/latest')).rejects.toMatchObject({ statusCode: 400 });
    await expect(fetchSpec('http://[::ffff:169.254.169.254]/latest')).rejects.toMatchObject({ statusCode: 400 });
    await expect(fetchSpec('http://metadata.google.internal/x')).rejects.toMatchObject({ statusCode: 400 });
    await expect(fetchSpec('file:///etc/passwd')).rejects.toMatchObject({ statusCode: 400 });
    expect(blockedAddress('127.0.0.1', 'default')).toBeNull();
    process.env.STUBYARD_SPEC_FETCH = 'public';
    await expect(fetchSpec('http://127.0.0.1:1/openapi.json')).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('127.0.0.1') });
    expect(blockedAddress('10.1.2.3')).toMatch(/private/);
    expect(blockedAddress('8.8.8.8')).toBeNull();
  });
});

describe('contractSummary', () => {
  const result = (level: 'error' | 'warn' | 'info' | null, checks: string[], spec = 'crm', subject: ContractResult['subject'] = 'mock-request'): ContractResult => ({
    v: 1, subject, source: 'spec', spec: { id: 's1', name: spec, version: '1' }, provider: null,
    operation: { key: 'GET /users', operationId: 'listUsers', deprecated: false }, mode: 'report', enforced: false, level,
    counts: { error: checks.filter((c) => c !== 'contract.unknown-param').length, warn: checks.filter((c) => c === 'contract.unknown-param').length, info: 0 },
    issues: checks.map((check) => ({ check: check as never, severity: check === 'contract.unknown-param' ? 'warn' : 'error', side: 'request', where: 'body', message: check })),
  });

  it('counts by level, check and source and lists violations newest first', () => {
    const runId = newId();
    hub.db
      .prepare("INSERT INTO runs (id, project_id, key, started_at, expires_at) VALUES (?, ?, 'r1', ?, ?)")
      .run(runId, projectId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
    const insert = (at: string, c: ContractResult | null, run: string | null = null) =>
      hub.db
        .prepare("INSERT INTO traffic_logs (id, project_id, direction, protocol, method, url, received_at, contract, contract_level, run_id) VALUES (?, ?, 'inbound', 'http', 'GET', '/mock/hyper/api/users', ?, ?, ?, ?)")
        .run(newId(), projectId, at, c ? JSON.stringify(c) : null, c?.level ?? null, run);
    insert('2026-01-01T00:00:01Z', result('error', ['contract.body', 'contract.param']), runId);
    insert('2026-01-01T00:00:02Z', result('warn', ['contract.unknown-param']), runId);
    insert('2026-01-01T00:00:03Z', result(null, []));
    insert('2026-01-01T00:00:04Z', result('error', ['contract.body'], 'pay', 'app-response'));
    insert('2026-01-01T00:00:05Z', null);

    const all = contractSummary(hub, projectId);
    expect(all).toMatchObject({ checked: 4, withIssues: 3, error: 2, warn: 1, info: 0 });
    expect(all.byCheck[0]).toEqual({ check: 'contract.body', label: 'Body does not match the schema', count: 2 });
    expect(all.bySource).toEqual([
      { spec: 'crm', provider: null, checked: 3, withIssues: 2 },
      { spec: 'pay', provider: null, checked: 1, withIssues: 1 },
    ]);
    expect(all.violations.map((v) => v.receivedAt)).toEqual(['2026-01-01T00:00:04Z', '2026-01-01T00:00:02Z', '2026-01-01T00:00:01Z']);
    expect(all.violations[0]).toMatchObject({ subject: 'app-response', spec: 'pay', operation: 'GET /users', level: 'error', method: 'GET' });

    expect(contractSummary(hub, projectId, { runId })).toMatchObject({ checked: 2, error: 1, warn: 1 });
    expect(contractSummary(hub, projectId, { since: '2026-01-01T00:00:02Z', until: '2026-01-01T00:00:03Z' })).toMatchObject({ checked: 2, withIssues: 1 });
    expect(contractSummary(hub, projectId, { spec: 'pay' }).checked).toBe(1);
    expect(contractSummary(hub, projectId, { subject: 'mock-request' }).checked).toBe(3);
    expect(contractSummary(hub, projectId, { minLevel: 'error', limit: 1 }).violations).toHaveLength(1);
  });
});
