import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

// C1 slice S6: the REST routes under /api/projects/:slug/contracts, /api/logs?contract= and specEdited on mocks.
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

const finished = (res: { headers: Headers }) => {
  const id = res.headers.get('x-hub-request-id')!;
  expect(id).toBeTruthy();
  return waitFor(() => {
    const l = hub.traffic.repo.get(id);
    return l && l.respondedAt && l.contract ? l : null;
  });
};

const crm = (userExample: number) => `openapi: 3.0.3
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
              example: { id: u_${userExample} }
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
              example: { id: ${userExample} }
`;

const S = '/api/projects/shop/contracts';

describe('contract REST routes (C1 S6)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-routes-'));
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
    expect((await api('POST', '/api/projects', { name: 'Shop' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the check catalog', async () => {
    const r = await api('GET', `${S}/checks`);
    expect(r.status).toBe(200);
    expect(r.body.map((c: any) => c.id)).toContain('contract.body');
  });

  it('dry run previews the mocks without writing', async () => {
    const r = await api('POST', `${S}/specs`, { spec: crm(1), name: 'crm', prefix: '/crm', dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.created.map((m: any) => m.specOperation).sort()).toEqual(['GET /users/{id}', 'POST /users']);
    expect(r.body.created.every((m: any) => m.id === null)).toBe(true);
    expect((await api('GET', `${S}/specs`)).body).toEqual([]);
    expect((await api('GET', '/api/projects/shop/mocks')).body).toEqual([]);
  });

  it('imports inline YAML: 201, mocks created and linked', async () => {
    const r = await api('POST', `${S}/specs`, { spec: crm(1), name: 'crm', prefix: '/crm' });
    expect(r.status).toBe(201);
    expect(r.body.spec).toMatchObject({ name: 'crm', prefix: '/crm', mode: 'report', role: 'mock', operations: 2 });
    expect(r.body.created).toHaveLength(2);
    const mocks = (await api('GET', '/api/projects/shop/mocks')).body as any[];
    expect(mocks).toHaveLength(2);
    for (const m of mocks) expect(m).toMatchObject({ specId: r.body.spec.id, specEdited: false });
    expect(mocks.map((m) => m.specOperation).sort()).toEqual(['GET /users/{id}', 'POST /users']);
  });

  it('records an upload filename', async () => {
    const r = await api('POST', `${S}/specs`, { spec: crm(1), name: 'crm2', prefix: '/crm2', filename: 'crm.yaml', dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, spec: { name: 'crm2', prefix: '/crm2', source: { kind: 'upload', filename: 'crm.yaml' } } });
  });

  it('lists and gets specs (with operations, document on request, download)', async () => {
    const list = await api('GET', `${S}/specs`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'crm', mocks: 2, issues24h: { checked: 0, withIssues: 0 } });
    expect(list.body[0].mockBaseUrl).toMatch(/\/mock\/shop\/api\/crm$/);
    expect(list.body[0].document).toBeUndefined();

    const one = await api('GET', `${S}/specs/crm`);
    expect(one.status).toBe(200);
    expect(one.body.document).toBeUndefined();
    expect(one.body.operationList.map((o: any) => o.key)).toEqual(expect.arrayContaining(['POST /users', 'GET /users/{id}']));
    expect(one.body.operationList.every((o: any) => o.mock && o.mock.edited === false)).toBe(true);

    const withDoc = await api('GET', `${S}/specs/crm?document=1`);
    expect(withDoc.body.document.info.title).toBe('CRM');

    const dl = await api('GET', `${S}/specs/crm?download=1`);
    expect(dl.headers.get('content-disposition')).toContain('crm.openapi.json');
    expect(dl.body.paths['/users']).toBeTruthy();

    const ops = await api('GET', `${S}/specs/crm/operations`);
    expect(ops.body).toHaveLength(2);
    expect((await api('GET', `${S}/specs/nope`)).status).toBe(404);
  });

  it('checks a sample request and response against an operation', async () => {
    const r = await api('POST', `${S}/check`, {
      spec: 'crm',
      operation: 'POST /users',
      request: { body: { age: 'old' } },
      response: { status: 418, body: {} },
    });
    expect(r.status).toBe(200);
    expect(r.body.operation.key).toBe('POST /users');
    expect(r.body.request.level).toBe('error');
    expect(r.body.request.issues.some((i: any) => i.check === 'contract.body')).toBe(true);
    expect(r.body.response.issues.some((i: any) => i.check === 'contract.response-status')).toBe(true);

    const byPath = await api('POST', `${S}/check`, { spec: 'crm', method: 'GET', path: '/crm/users/7', response: { status: 200, body: { id: 7 } } });
    expect(byPath.status).toBe(200);
    expect(byPath.body.operation.key).toBe('GET /users/{id}');
    expect(byPath.body.response.level).toBeNull();
    expect((await api('POST', `${S}/check`, { spec: 'crm', operation: 'DELETE /x', request: {} })).status).toBe(404);
    // Nothing logged.
    expect((await api('GET', `/api/logs?project=shop&contract=checked`)).body).toHaveLength(0);
  });

  it('patches the mode', async () => {
    const r = await api('PATCH', `${S}/specs/crm`, { mode: 'strict' });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('strict');
    expect((await api('PATCH', `${S}/specs/crm`, { mode: 'loud' })).status).toBe(400);
  });

  it('summarizes issues after bad requests and filters /api/logs by contract', async () => {
    const bad = await api('POST', '/mock/shop/api/crm/users', { age: 'old' });
    expect(bad.status).toBe(400);
    await finished(bad);
    await api('PATCH', `${S}/specs/crm`, { mode: 'report' });
    const reported = await api('POST', '/mock/shop/api/crm/users', { age: 'old' });
    expect(reported.status).toBe(201);
    await finished(reported);
    const good = await api('GET', '/mock/shop/api/crm/users/7');
    expect(good.status).toBe(200);
    await finished(good);

    const sum = await api('GET', `${S}/issues?spec=crm`);
    expect(sum.status).toBe(200);
    expect(sum.body).toMatchObject({ project: 'shop', checked: 3, withIssues: 2, error: 2 });
    expect(sum.body.violations).toHaveLength(2);
    expect(sum.body.byCheck[0].check).toBe('contract.body');
    expect((await api('GET', `${S}/issues?limit=1`)).body.violations).toHaveLength(1);
    expect((await api('GET', `${S}/issues?level=nope`)).status).toBe(400);

    const issues = await api('GET', '/api/logs?project=shop&contract=issues');
    expect(issues.status).toBe(200);
    expect(issues.body).toHaveLength(2);
    for (const l of issues.body) expect(l).toMatchObject({ contractLevel: 'error' });
    expect(issues.body[0].contractIssues).toBeGreaterThan(0);
    expect((await api('GET', '/api/logs?project=shop&contract=checked')).body).toHaveLength(3);
    expect((await api('GET', '/api/logs?project=shop&contract=bogus')).status).toBe(400);

    expect((await api('GET', `${S}/specs`)).body[0].issues24h).toMatchObject({ checked: 3, withIssues: 2, error: 2 });
  });

  it('marks a hand-edited mock and keeps it on re-import', async () => {
    const mocks = (await api('GET', '/api/projects/shop/mocks')).body as any[];
    const getUser = mocks.find((m) => m.specOperation === 'GET /users/{id}');
    const edited = await api('PATCH', `/api/projects/shop/mocks/${getUser.id}`, { description: 'tweaked by hand' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ specEdited: true, specId: getUser.specId, specOperation: 'GET /users/{id}' });
    expect((await api('GET', `/api/projects/shop/mocks/${getUser.id}`)).body.specEdited).toBe(true);

    const dry = await api('POST', `${S}/specs/crm/reimport`, { spec: crm(2), dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.kept.map((k: any) => k.id)).toEqual([getUser.id]);

    const r = await api('POST', `${S}/specs/crm/reimport`, { spec: crm(2) });
    expect(r.status).toBe(200);
    expect(r.body.kept).toEqual([expect.objectContaining({ id: getUser.id, reason: 'edited' })]);
    expect(r.body.updated.map((u: any) => u.specOperation)).toEqual(['POST /users']);
    const after = (await api('GET', `/api/projects/shop/mocks/${getUser.id}`)).body;
    expect(after.description).toBe('tweaked by hand');
    expect(after.specEdited).toBe(true);
  });

  it('rejects a Swagger 2 document with 400', async () => {
    const r = await api('POST', `${S}/specs`, { spec: JSON.stringify({ swagger: '2.0', info: { title: 'Old', version: '1' }, paths: {} }) });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/Swagger 2/);
    expect((await api('POST', `${S}/specs`, {})).status).toBe(400);
  });

  it('refuses a URL import when STUBYARD_SPEC_FETCH=0', async () => {
    const prev = process.env.STUBYARD_SPEC_FETCH;
    process.env.STUBYARD_SPEC_FETCH = '0';
    try {
      const r = await api('POST', `${S}/specs`, { url: 'http://127.0.0.1:1/openapi.yaml', name: 'remote' });
      expect(r.status).toBe(400);
      expect(r.text).toMatch(/STUBYARD_SPEC_FETCH=0/);
    } finally {
      if (prev === undefined) delete process.env.STUBYARD_SPEC_FETCH;
      else process.env.STUBYARD_SPEC_FETCH = prev;
    }
  });

  it('deletes a spec with its mocks (?deleteMocks=1) or keeps them unlinked (default)', async () => {
    const other = await api('POST', `${S}/specs`, { spec: crm(1), name: 'other', prefix: '/other' });
    expect(other.status).toBe(201);
    const kept = await api('DELETE', `${S}/specs/other`);
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ mocksDeleted: 0, mocksKept: 2 });

    const r = await api('DELETE', `${S}/specs/crm?deleteMocks=1`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mocksDeleted: 2, mocksKept: 0 });
    expect((await api('GET', `${S}/specs`)).body).toEqual([]);
    const left = (await api('GET', '/api/projects/shop/mocks')).body as any[];
    expect(left).toHaveLength(2);
    for (const m of left) expect(m).toMatchObject({ specId: null, specEdited: false });
  });
});
