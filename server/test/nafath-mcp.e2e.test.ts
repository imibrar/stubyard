import fs from 'node:fs';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostHttpBase, loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { mcpToolAccess, staleCompositeRoutes } from '../src/http/routes/mcp.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

// B5 slice S3: the Nafath MCP tools (nafath/mcp-tools.ts). In-memory hub, no Mailpit.

const NEW_TOOLS = ['list_nafath_requests', 'wait_for_nafath_request', 'approve_nafath', 'set_nafath_fault', 'reset_nafath', 'create_nafath_instance'];

describe('Nafath MCP tools', () => {
  let hub: Hub;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let dataDir: string;
  let base = '';
  let inst: any;

  async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: r.status, body: parsed as T };
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

  const B = '/nafath/ksa/main/api/v1/mfa';
  const creds = () => ({ 'APP-ID': inst.appId, 'APP-KEY': inst.appKey });
  /** The app starts a login over the fake MFA API. */
  const start = (nationalId: string) => api('POST', `${B}/request`, { nationalId, service: 'Login' }, creds());
  const status = (nationalId: string, r: { transId: string; random: string }) => api('POST', `${B}/request/status`, { nationalId, transId: r.transId, random: r.random }, creds());

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-nafath-mcp-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Mohammed', nationalId: '1000000008' })).status).toBe(201);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Resident', nationalId: '2000000006' })).status).toBe(201);
  });

  afterAll(async () => {
    await app?.close();
    hub?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('tools/list shows every Nafath tool with its annotations', async () => {
    const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = r.body.result.tools as { name: string; annotations?: Record<string, unknown> }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of NEW_TOOLS) expect(byName.has(n), n).toBe(true);
    for (const n of ['list_nafath_requests', 'wait_for_nafath_request']) expect(byName.get(n)!.annotations, n).toMatchObject({ readOnlyHint: true });
    expect(byName.get('reset_nafath')!.annotations).toMatchObject({ destructiveHint: true });
    expect(byName.get('approve_nafath')!.annotations).toBeUndefined();
  });

  it('creates an instance with its URLs and credentials', async () => {
    const c = await mcp('create_nafath_instance', { project: 'ksa', slug: 'main', callback_url: 'http://127.0.0.1:1/cb' });
    expect(c.isError, c.text).toBe(false);
    expect(c.data).toMatchObject({ slug: 'main', config: { callbackUrl: 'http://127.0.0.1:1/cb', autoDecision: 'none' }, strict: false });
    // MCP calls are internal (app.inject), so the origin is the hub's own, not this test's port.
    expect(c.data.urls.request).toMatch(new RegExp(`${B}/request$`));
    expect(c.data.appId).toBeTruthy();
    inst = c.data;
    // Callbacks are not under test here.
    expect((await api('PATCH', '/api/projects/ksa/nafath/instances/main', { config: { callbackUrl: null } })).status).toBe(200);
    expect((await mcp('create_nafath_instance', { project: 'ksa', slug: 'main' })).isError).toBe(true);
    expect((await mcp('create_nafath_instance', { project: 'ksa', slug: 'auto', auto_decision: 'nope' })).isError).toBe(true);
  });

  it('waits for the app\'s request, then approves it with the right number → COMPLETED', async () => {
    const waiting = mcp('wait_for_nafath_request', { project: 'ksa', user: 'Mohammed', timeout_seconds: 10 });
    await new Promise((r) => setTimeout(r, 100));
    const s = await start('1000000008');
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const w = await waiting;
    expect(w.isError, w.text).toBe(false);
    expect(w.data.timedOut).toBe(false);
    expect(w.data.request).toMatchObject({ transId: s.body.transId, random: s.body.random, status: 'WAITING', nationalId: '1000000008' });
    expect(w.data.cursor).toBe(w.data.request.id);
    const next = await mcp('wait_for_nafath_request', { project: 'ksa', after: w.data.cursor, timeout_seconds: 0 });
    expect(next.data).toMatchObject({ timedOut: true, request: null });

    const list = await mcp('list_nafath_requests', { project: 'ksa', user: 'Mohammed', status: 'WAITING' });
    expect(list.data.map((r: any) => r.id)).toEqual([w.data.request.id]);

    const a = await mcp('approve_nafath', { project: 'ksa', user: 'Mohammed' });
    expect(a.isError, a.text).toBe(false);
    expect(a.data).toMatchObject({ status: 'COMPLETED', chosen: s.body.random, decidedBy: 'person' });
    expect(a.data.token).toBeTruthy();
    expect((await status('1000000008', s.body)).body.status).toBe('COMPLETED');

    // Nothing WAITING any more: a short wait fails with a hint.
    const none = await mcp('approve_nafath', { project: 'ksa', user: 'Mohammed', wait_seconds: 0 });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('No WAITING Nafath request');
    // By id: already decided → 409.
    expect((await mcp('approve_nafath', { project: 'ksa', id: s.body.transId })).isError).toBe(true);
  });

  it('rejects, and taps a wrong number, by id or waiting for the request', async () => {
    const s = await start('2000000006');
    expect(s.status).toBe(200);
    const id = (await mcp('list_nafath_requests', { project: 'ksa', user: 'Resident', status: 'WAITING' })).data[0].id;
    const r = await mcp('approve_nafath', { project: 'ksa', id, decision: 'reject' });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ status: 'REJECTED', reason: 'rejected' });
    expect((await status('2000000006', s.body)).body.status).toBe('REJECTED');

    const s2 = await start('1000000008');
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    const wrong = await mcp('approve_nafath', { project: 'ksa', user: '1000000008', decision: 'wrong_number' });
    expect(wrong.isError, wrong.text).toBe(false);
    expect(wrong.data).toMatchObject({ status: 'REJECTED', reason: 'wrong_number' });
    expect(wrong.data.chosen).not.toBe(s2.body.random);

    expect((await mcp('approve_nafath', { project: 'ksa', decision: 'maybe' })).isError).toBe(true);
  });

  it('sets a fault the fake Nafath answers with, then clears it ("none"); reset deletes the requests', async () => {
    const f = await mcp('set_nafath_fault', { project: 'ksa', fault: 'down', national_id: '2000000006', times: 1 });
    expect(f.isError, f.text).toBe(false);
    expect(f.data).toMatchObject({ fault: 'down', remaining: 1, match: { nationalId: '2000000006' } });
    expect((await start('2000000006')).status).toBe(503);

    expect((await mcp('set_nafath_fault', { project: 'ksa', fault: 'nonsense' })).isError).toBe(true);
    await mcp('set_nafath_fault', { project: 'ksa', fault: 'rate_limit' });
    expect((await start('2000000006')).status).toBe(429);
    const cleared = await mcp('set_nafath_fault', { project: 'ksa', fault: 'none' });
    expect(cleared.data).toEqual({ cleared: true });
    expect((await api('GET', '/api/projects/ksa/nafath/faults')).body).toEqual([]);
    expect((await start('2000000006')).status).toBe(200);

    const reset = await mcp('reset_nafath', { project: 'ksa' });
    expect(reset.isError, reset.text).toBe(false);
    expect(reset.data.deleted).toBeGreaterThanOrEqual(4);
    expect((await mcp('list_nafath_requests', { project: 'ksa' })).data).toEqual([]);
  });

  it('upsert_test_user sets a national ID', async () => {
    const u = await mcp('upsert_test_user', { project: 'ksa', email: 'nafath@ksa.test', name: 'Nafath User', role: 'user', national_id: '1234567897' });
    expect(u.isError, u.text).toBe(false);
    expect(u.data).toMatchObject({ status: 'created', user: { nationalId: '1234567897' } });
    const again = await mcp('upsert_test_user', { project: 'ksa', email: 'nafath@ksa.test', name: 'Nafath User', role: 'user', national_id: '1234567897' });
    expect(again.data.status).toBe('unchanged');
  });

  it('access: every new tool is mapped; no stale composite lines', () => {
    const access = mcpToolAccess(app);
    const perm = (n: string) => (access.get(n) as { permission: string } | null)?.permission;
    for (const n of NEW_TOOLS) expect(perm(n), n).toBeTruthy();
    for (const n of ['list_nafath_requests', 'wait_for_nafath_request']) expect(perm(n), n).toBe('project.view');
    for (const n of ['approve_nafath', 'reset_nafath']) expect(perm(n), n).toBe('walkthroughs.run');
    for (const n of ['set_nafath_fault', 'create_nafath_instance']) expect(perm(n), n).toBe('project.providers');
    expect(staleCompositeRoutes()).toEqual([]);
  });

  it('MCP (injected) URLs use the hub base, not localhost:80; a real socket request keeps its own host', async () => {
    const c = await mcp('create_nafath_instance', { project: 'ksa', slug: 'origin' });
    expect(c.isError, c.text).toBe(false);
    expect(c.data.urls.request.startsWith(hostHttpBase(hub.config) + '/'), c.data.urls.request).toBe(true);
    expect(c.data.urls.request).not.toContain('localhost:80/');
    const r = await api('GET', '/api/projects/ksa/nafath/instances/origin');
    expect(r.body.urls.request.startsWith(base + '/'), r.body.urls.request).toBe(true);
  });
});
