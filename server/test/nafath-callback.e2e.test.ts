import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';
import { generateNationalId } from '../src/nafath/national-id.js';

interface Received {
  path: string;
  body: any;
}

describe('fake Nafath callbacks and auto-decisions', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';
  let cbBase = '';
  let cbServer: http.Server;
  const received: Received[] = [];
  const used = new Set<string>();

  async function call<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed as T };
  }
  const api = call;
  const P = '/api/projects/ksa/nafath';

  async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 6000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const at = (p: string) => received.filter((x) => x.path === p);

  /** A test user with a fresh national ID (one active transaction per ID and instance). */
  async function user(name: string, identity?: Record<string, unknown>): Promise<string> {
    let id = generateNationalId('citizen');
    while (used.has(id)) id = generateNationalId('citizen');
    used.add(id);
    expect((await api('POST', '/api/projects/ksa/users', { name, nationalId: id, ...(identity ? { identity } : {}) })).status).toBe(201);
    return id;
  }

  /** An instance whose callbacks go to <callback server>/<slug> (or /fail/<slug>: the server answers 500). */
  async function instance(slug: string, config: Record<string, unknown> = {}, fail = false): Promise<any> {
    const c = await api('POST', `${P}/instances`, { slug, config: { callbackUrl: `${cbBase}${fail ? '/fail' : ''}/${slug}`, ...config } });
    expect(c.status).toBe(201);
    return c.body;
  }

  async function start(inst: any, nationalId: string): Promise<any> {
    const r = await call('POST', `/nafath/ksa/${inst.slug}/api/v1/mfa/request?requestId=rq-${inst.slug}`, { nationalId, service: 'Login' }, { 'APP-ID': inst.appId, 'APP-KEY': inst.appKey });
    expect(r.status).toBe(200);
    return (await api('GET', `${P}/requests/${r.body.transId}`)).body;
  }
  const getReq = async (id: string) => (await api('GET', `${P}/requests/${id}`)).body;

  async function verify(inst: any, token: string): Promise<{ ok: boolean; payload: any }> {
    const [h, p, s] = token.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    const set = await call('GET', `/nafath/ksa/${inst.slug}/api/v1/mfa/jwk`);
    const jwk = set.body.keys.find((k: any) => k.kid === head.kid);
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!jwk) return { ok: false, payload };
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return { ok: crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')), payload };
  }

  beforeAll(async () => {
    cbServer = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        let body: unknown = data;
        try {
          body = JSON.parse(data);
        } catch {
          /* text */
        }
        received.push({ path: req.url ?? '', body });
        res.statusCode = req.url?.startsWith('/fail/') ? 500 : 200;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => cbServer.listen(0, '127.0.0.1', r));
    cbBase = `http://127.0.0.1:${(cbServer.address() as net.AddressInfo).port}`;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-nafath-cb-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    hub.scheduler.start(30);
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
  });
  afterAll(async () => {
    await hub.scheduler.stop();
    await app.close();
    hub.db.close();
    await new Promise((r) => cbServer.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('approve → callback {transId, requestId, status: COMPLETED, token}; the token verifies against /jwk and is logged as outbound traffic', async () => {
    const inst = await instance('appr');
    const nid = await user('Approver', { englishFirstName: 'Mohammed', englishLastName: 'Saud', gender: 'M' });
    const r = await start(inst, nid);
    const done = await api('POST', `${P}/requests/${r.id}/choose`, { number: r.random });
    expect(done.body.status).toBe('COMPLETED');
    const [cb] = await waitFor(() => (at('/appr').length ? at('/appr') : null));
    expect(Object.keys(cb.body).sort()).toEqual(['requestId', 'status', 'token', 'transId']);
    expect(cb.body).toMatchObject({ transId: r.transId, requestId: 'rq-appr', status: 'COMPLETED' });
    const v = await verify(inst, cb.body.token);
    expect(v.ok).toBe(true);
    expect(v.payload).toMatchObject({ status: 'COMPLETED', transId: r.transId, nin: nid, englishFirstName: 'Mohammed' });
    const after = await waitFor(async () => {
      const x = await getReq(r.id);
      return x.callback.length ? x : null;
    });
    expect(after.callback[0]).toMatchObject({ url: `${cbBase}/appr`, status: 200, error: null, attempt: 1 });
    const log = hub.logs.get(after.callback[0].logId);
    expect(log).toBeTruthy();
    expect(JSON.stringify(log)).toContain('Nafath callback');
  });

  it('reject → REJECTED callback whose token carries the status and no person claims', async () => {
    const inst = await instance('rej');
    const nid = await user('Rejecter', { englishFirstName: 'Ali' });
    const r = await start(inst, nid);
    expect((await api('POST', `${P}/requests/${r.id}/reject`)).body.status).toBe('REJECTED');
    const [cb] = await waitFor(() => (at('/rej').length ? at('/rej') : null));
    expect(cb.body.status).toBe('REJECTED');
    const v = await verify(inst, cb.body.token);
    expect(v.ok).toBe(true);
    expect(v.payload.status).toBe('REJECTED');
    for (const k of ['nin', 'iqamaNumber', 'firstName', 'englishFirstName', 'familyName', 'dateOfBirthG']) expect(v.payload[k]).toBeUndefined();
  });

  it('EXPIRED: no callback by default; callbackOnExpired sends one (signed, no person claims)', async () => {
    const off = await instance('exp-off', { autoDecision: 'expire', autoDelayMs: 0 });
    const on = await instance('exp-on', { autoDecision: 'expire', autoDelayMs: 0, callbackOnExpired: true });
    const nid = await user('Expirer');
    const a = await start(off, nid);
    const b = await start(on, nid);
    expect(a.status).toBe('EXPIRED');
    expect(b.status).toBe('EXPIRED');
    const [cb] = await waitFor(() => (at('/exp-on').length ? at('/exp-on') : null));
    expect(cb.body).toMatchObject({ transId: b.transId, status: 'EXPIRED' });
    const v = await verify(on, cb.body.token);
    expect(v.ok).toBe(true);
    expect(v.payload).toMatchObject({ status: 'EXPIRED' });
    expect(v.payload.nin).toBeUndefined();
    await sleep(200);
    expect(at('/exp-off')).toHaveLength(0);
    expect((await getReq(a.id)).callback).toEqual([]);
  });

  it('callbackFields compat adds transactionId', async () => {
    const inst = await instance('compat', { callbackFields: 'compat' });
    const nid = await user('Compat');
    const r = await start(inst, nid);
    await api('POST', `${P}/requests/${r.id}/approve`);
    const [cb] = await waitFor(() => (at('/compat').length ? at('/compat') : null));
    expect(cb.body).toMatchObject({ transId: r.transId, transactionId: r.transId, status: 'COMPLETED' });
  });

  it('the app answering 500: the attempt is recorded and a retry is scheduled (nafath.callback), which records attempt 2', async () => {
    const inst = await instance('flaky', {}, true);
    const nid = await user('Flaky');
    const r = await start(inst, nid);
    await api('POST', `${P}/requests/${r.id}/approve`);
    const first = await waitFor(async () => {
      const x = await getReq(r.id);
      return x.callback.length ? x : null;
    });
    expect(first.callback[0]).toMatchObject({ status: 500, attempt: 1, error: 'Your app answered 500' });
    const list = (await api('GET', '/api/projects/ksa/schedules')).body;
    const sch = (Array.isArray(list) ? list : list.schedules).find((s: any) => s.path === `/nafath/requests/${r.id}/callback/deliver`);
    expect(sch).toMatchObject({ action: 'nafath.callback', status: 'pending' });
    expect((await api('POST', `/api/projects/ksa/schedules/${sch.id}/run-now`)).status).toBe(200);
    const second = await waitFor(async () => {
      const x = await getReq(r.id);
      return x.callback.length >= 2 ? x : null;
    });
    expect(second.callback[1]).toMatchObject({ status: 500, attempt: 2 });
    expect(at('/fail/flaky').length).toBeGreaterThanOrEqual(2);
  });

  it('faults no_callback (nothing sent) and duplicate_callback (sent twice)', async () => {
    const inst = await instance('faults');
    const n1 = await user('NoCb');
    const n2 = await user('DupCb');
    expect((await api('POST', `${P}/faults`, { fault: 'no_callback', instance: 'faults', nationalId: n1, times: 1 })).status).toBe(201);
    expect((await api('POST', `${P}/faults`, { fault: 'duplicate_callback', instance: 'faults', nationalId: n2, times: 1 })).status).toBe(201);
    const a = await start(inst, n1);
    await api('POST', `${P}/requests/${a.id}/approve`);
    const b = await start(inst, n2);
    await api('POST', `${P}/requests/${b.id}/approve`);
    await waitFor(() => at('/faults').filter((x) => x.body.transId === b.transId).length >= 2);
    await sleep(150);
    expect(at('/faults').filter((x) => x.body.transId === a.transId)).toHaveLength(0);
    expect(at('/faults').filter((x) => x.body.transId === b.transId)).toHaveLength(2);
    const ra = await getReq(a.id);
    expect(ra.callback).toHaveLength(1);
    expect(ra.callback[0]).toMatchObject({ status: null, skipped: 'no_callback' });
    const rb = await getReq(b.id);
    expect(rb.callback.map((c: any) => !!c.duplicate)).toEqual([false, true]);
  });

  it('autoDecision approve with a small autoDelayMs: COMPLETED (right number) and a callback without manual action', async () => {
    const inst = await instance('auto', { autoDecision: 'approve', autoDelayMs: 150 });
    const nid = await user('Auto');
    const r = await start(inst, nid);
    expect(r.status).toBe('WAITING');
    const done = await waitFor(async () => {
      const x = await getReq(r.id);
      return x.status === 'COMPLETED' ? x : null;
    });
    expect(done).toMatchObject({ decidedBy: 'auto', chosen: r.random });
    await waitFor(() => at('/auto').length > 0);
    expect(at('/auto')[0].body.status).toBe('COMPLETED');
  });

  it('autoDecision reject / wrong_number with a delay', async () => {
    const rej = await instance('auto-rej', { autoDecision: 'reject', autoDelayMs: 100 });
    const wn = await instance('auto-wn', { autoDecision: 'wrong_number', autoDelayMs: 100 });
    const nid = await user('AutoRej');
    const a = await start(rej, nid);
    const b = await start(wn, nid);
    const da = await waitFor(async () => ((await getReq(a.id)).status !== 'WAITING' ? getReq(a.id) : null));
    const db = await waitFor(async () => ((await getReq(b.id)).status !== 'WAITING' ? getReq(b.id) : null));
    expect(da).toMatchObject({ status: 'REJECTED', reason: 'rejected', decidedBy: 'auto' });
    expect(db).toMatchObject({ status: 'REJECTED', reason: 'wrong_number' });
    expect(db.chosen).not.toBe(b.random);
  });

  it('a delayed decision on a request decided meanwhile is skipped', async () => {
    const inst = await instance('auto-late', { autoDecision: 'reject', autoDelayMs: 200 });
    const nid = await user('Late');
    const r = await start(inst, nid);
    expect((await api('POST', `${P}/requests/${r.id}/approve`)).body.status).toBe('COMPLETED');
    await sleep(400);
    expect((await getReq(r.id)).status).toBe('COMPLETED');
    expect((await api('POST', `${P}/requests/${r.id}/decide`, { decision: 'reject' })).body).toMatchObject({ skipped: true });
    expect((await api('POST', `${P}/requests/${r.id}/decide`, { decision: 'nope' })).status).toBe(400);
  });

  it('GET /requests/wait returns when a request appears; times out otherwise', async () => {
    const inst = await instance('wait');
    const nid = await user('Waiter');
    const t0 = Date.now();
    const none = await api('GET', `${P}/requests/wait?user=Waiter&status=WAITING&timeout=1`);
    expect(none.body).toMatchObject({ timedOut: true, request: null });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    const pending = api('GET', `${P}/requests/wait?user=Waiter&status=WAITING&timeout=10`);
    await sleep(200);
    const r = await start(inst, nid);
    const got = await pending;
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ timedOut: false, request: { id: r.id, transId: r.transId, status: 'WAITING' }, cursor: r.id });
    // after: only newer requests count.
    const later = await api('GET', `${P}/requests/wait?user=Waiter&after=${r.id}&timeout=1`);
    expect(later.body.timedOut).toBe(true);
  });

  it('POST /requests/:id/callback/resend delivers again (409 while WAITING)', async () => {
    const inst = await instance('resend');
    const nid = await user('Resender');
    const r = await start(inst, nid);
    expect((await api('POST', `${P}/requests/${r.id}/callback/resend`)).status).toBe(409);
    await api('POST', `${P}/requests/${r.id}/approve`);
    await waitFor(() => at('/resend').length === 1);
    const re = await api('POST', `${P}/requests/${r.id}/callback/resend`);
    expect(re.status).toBe(200);
    expect(re.body).toMatchObject({ ok: true, status: 200, attempt: 1 });
    expect(at('/resend')).toHaveLength(2);
    expect(at('/resend')[1].body.token).toBe(at('/resend')[0].body.token);
    expect((await getReq(r.id)).callback).toHaveLength(2);
  });
});
