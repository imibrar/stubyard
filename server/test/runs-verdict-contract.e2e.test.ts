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
import type { RunVerdict } from '../src/runs/verdict.js';

// A2 × C1: the `contract` expectation kind and the contractErrors default check over a run's contract results.
// No Mailpit needed (an in-memory hub like runs-verdict-api.e2e.test.ts).

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
let projectId = '';

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
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

const CRM = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'CRM', version: '1.0.0' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/users': {
      post: {
        operationId: 'createUser',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' }, age: { type: 'integer' } } } } },
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

const item = (v: RunVerdict, id: string) => v.items.find((i) => i.id === id);

/** A mock call under the run key; waits until its log has a contract result. */
async function call(key: string, method: string, p: string, body?: unknown) {
  const r = await api(method, `/run/${key}/mock/shop/api/crm${p}`, body);
  const id = r.headers.get('x-hub-request-id')!;
  expect(id).toBeTruthy();
  const log = await waitFor(() => {
    const l = hub.traffic.repo.get(id);
    return l && l.respondedAt && l.contract ? l : null;
  });
  return { res: r, log };
}

async function startRun(key: string, slug = 'shop', extra: Record<string, unknown> = {}) {
  const r = await api('POST', `/api/projects/${slug}/runs`, { key, ...extra });
  expect(r.status, r.text).toBe(201);
}

async function verdict(key: string, doc?: unknown, slug = 'shop'): Promise<RunVerdict> {
  const r = doc === undefined ? await api<RunVerdict>('GET', `/api/projects/${slug}/runs/${key}/verdict`) : await api<RunVerdict>('POST', `/api/projects/${slug}/runs/${key}/verdict`, doc);
  expect(r.status, r.text).toBe(200);
  return r.body;
}

describe('run verdict: contract expectations (A2 × C1)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-verdict-contract-'));
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
    const project = await api('POST', '/api/projects', { name: 'Shop' });
    expect(project.status).toBe(201);
    projectId = project.body.id;
    await hub.contracts.import(projectId, { name: 'crm', source: { kind: 'inline', text: CRM }, prefix: '/crm', mode: 'report' });
    expect((await api('POST', '/api/projects', { name: 'Plain' })).status).toBe(201);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects unknown keys and bad selector values', async () => {
    await startRun('bad');
    for (const items of [[{ kind: 'contract', level: 'error' }], [{ kind: 'contract', check: 'contract.nope' }], [{ kind: 'contract', minLevel: 'info' }], [{ kind: 'contract', subject: 'mock' }]]) {
      const r = await api('POST', '/api/projects/shop/runs/bad/verdict', { items });
      expect(r.status, JSON.stringify(items)).toBe(400);
    }
  });

  it('a valid request passes; an invalid body fails with the log as evidence; the default check catches it too', async () => {
    await startRun('c1', 'shop', { expectations: [{ kind: 'contract' }] });

    // No traffic yet: count 0 passes, and the default check is listed (the project has a spec in report mode).
    const empty = await verdict('c1');
    expect(item(empty, 'e1')).toMatchObject({ kind: 'contract', status: 'pass', actual: 0, expected: 'none' });
    expect(item(empty, 'default:contractErrors')).toMatchObject({ status: 'pass', kind: 'contract', actual: 0 });

    const ok = await call('c1', 'POST', '/users', { email: 'a@b.co', age: 30 });
    expect(ok.res.status).toBe(201);
    expect(ok.log.contractLevel).toBeNull();
    const pass = await verdict('c1');
    expect(pass.verdict).toBe('pass');
    expect(item(pass, 'e1')).toMatchObject({ status: 'pass', actual: 0 });

    const bad = await call('c1', 'POST', '/users', { age: 'old' });
    expect(bad.res.status).toBe(201); // report mode still answers
    expect(bad.log.contractLevel).toBe('error');
    const fail = await verdict('c1');
    expect(fail.verdict).toBe('fail');
    expect(item(fail, 'e1')).toMatchObject({ status: 'fail', actual: 1, expected: 'none' });
    expect(item(fail, 'e1')!.evidence).toEqual([{ type: 'log', id: bad.log.id, url: `/api/logs/${bad.log.id}`, summary: expect.stringMatching(/^contract\.body: /) }]);
    expect(item(fail, 'default:contractErrors')).toMatchObject({ status: 'fail', actual: 1, evidence: [expect.objectContaining({ type: 'log', id: bad.log.id })] });
  });

  it('selectors: check, spec, subject and minLevel warn; count forms and expected-violation exemption', async () => {
    await startRun('c2');
    const bad = await call('c2', 'POST', '/users', { age: 'old' }); // contract.body errors
    const warn = await call('c2', 'GET', '/users/7'); // no credentials: contract.auth-missing (warn)
    expect(warn.log.contractLevel).toBe('warn');

    const v = await verdict('c2', {
      items: [
        { kind: 'contract', check: 'contract.body' },
        { kind: 'contract', check: 'contract.param' },
        { kind: 'contract', spec: 'other' },
        { kind: 'contract', subject: 'app-response' },
        { kind: 'contract', minLevel: 'warn' },
        { kind: 'contract', check: 'contract.auth-missing' },
        { kind: 'contract', check: 'contract.auth-missing', minLevel: 'warn', count: 1 },
        { kind: 'contract', spec: 'crm', subject: 'mock-request', count: { min: 1 } },
      ],
    });
    expect(item(v, 'e1')).toMatchObject({ status: 'fail', actual: 1, evidence: [expect.objectContaining({ id: bad.log.id })] });
    expect(item(v, 'e2')).toMatchObject({ status: 'pass', actual: 0 });
    expect(item(v, 'e3')).toMatchObject({ status: 'pass', actual: 0 });
    expect(item(v, 'e4')).toMatchObject({ status: 'pass', actual: 0 });
    expect(item(v, 'e5')).toMatchObject({ status: 'fail', actual: 2 });
    expect(item(v, 'e5')!.evidence.map((e) => e.id).sort()).toEqual([bad.log.id, warn.log.id].sort());
    expect(item(v, 'e5')!.evidence.find((e) => e.id === warn.log.id)!.summary).toMatch(/^contract\.auth-missing: /);
    // auth-missing is a warn: with the default minLevel error it is not counted.
    expect(item(v, 'e6')).toMatchObject({ status: 'pass', actual: 0 });
    expect(item(v, 'e7')).toMatchObject({ status: 'pass', actual: 1 });
    // e8 expects the error: its log is exempt from the default check, which then passes.
    expect(item(v, 'e8')).toMatchObject({ status: 'pass', actual: 1 });
    expect(item(v, 'default:contractErrors')).toMatchObject({ status: 'pass', actual: 0 });

    // severity: warn on the item turns its failure into a warning.
    const soft = await verdict('c2', { items: [{ kind: 'contract', severity: 'warn' }], defaults: { contractErrors: false } });
    expect(item(soft, 'e1')!.status).toBe('warn');
    expect(item(soft, 'default:contractErrors')).toBeUndefined();
    expect(soft.verdict).toBe('pass');
  });

  it('the verdict is frozen at stop', async () => {
    await startRun('c3', 'shop', { expectations: [{ kind: 'contract' }] });
    const bad = await call('c3', 'POST', '/users', { age: 'old' });
    const { report } = await hub.runs.stop(hub.runs.require(projectId, 'c3'));
    expect(report.verdict).toMatchObject({ verdict: 'fail', frozen: true });
    expect(item(report.verdict!, 'e1')).toMatchObject({ status: 'fail', actual: 1, evidence: [expect.objectContaining({ id: bad.log.id })] });
    const later = await verdict('c3');
    expect(later).toMatchObject({ verdict: 'fail', frozen: true });
  });

  it('a project without specs gets no contractErrors item; a contract item there passes with 0', async () => {
    await startRun('p1', 'plain');
    const v = await verdict('p1', undefined, 'plain');
    expect(v.verdict).toBe('pass');
    expect(v.items.some((i) => i.id === 'default:contractErrors')).toBe(false);
    expect(v.items).toHaveLength(7);
    const declared = await verdict('p1', { items: [{ kind: 'contract' }] }, 'plain');
    expect(item(declared, 'e1')).toMatchObject({ status: 'pass', actual: 0 });
    expect(declared.verdict).toBe('pass');
  });
});
