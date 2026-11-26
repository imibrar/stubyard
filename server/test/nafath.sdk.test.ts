/**
 * The @stubyard/client Nafath helpers (packages/client/src/nafath.ts, B5 S4) against a real stubyard: the app starts
 * a request over the fake MFA API, the SDK waits for it and decides (choose, approve, reject), faults and callback
 * resend. In-memory hub like nafath.e2e.test.ts.
 */
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

describe('@stubyard/client Nafath helpers (B5 S4)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let apiUrl = '';
  let mod: any;
  let t: { apiUrl: string; project: string };
  let inst: any;
  let cbServer: http.Server;
  const callbacks: { url: string; body: any }[] = [];

  async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const r = await fetch(apiUrl + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: text };
    }
  }
  const creds = () => ({ 'APP-ID': inst.appId, 'APP-KEY': inst.appKey, 'X-Forwarded-For': '203.0.113.7' });
  const B = '/nafath/ksa/main/api/v1/mfa';
  /** The app: POST /mfa/request. */
  const appRequest = (nationalId: string) => call('POST', `${B}/request`, { nationalId, service: 'Login' }, creds());
  /** The app: POST /mfa/request/status. */
  const appStatus = async (nationalId: string, transId: string, random: string) => (await call('POST', `${B}/request/status`, { nationalId, transId, random }, creds())).body.status;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-nafath-sdk-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    apiUrl = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    cbServer = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        callbacks.push({ url: req.url ?? '', body: data ? JSON.parse(data) : null });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => cbServer.listen(0, '127.0.0.1', () => r()));
    const cbBase = `http://127.0.0.1:${(cbServer.address() as net.AddressInfo).port}`;

    expect((await call('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
    for (const [name, nationalId] of [
      ['Mohammed', '1000000008'],
      ['Resident', '2000000006'],
      ['Runner', '1234567897'],
    ])
      expect((await call('POST', '/api/projects/ksa/users', { name, nationalId })).status).toBe(201);
    // Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
    mod = await import(new URL('../../packages/client/src/nafath.ts', import.meta.url).pathname);
    t = { apiUrl, project: 'ksa' };
    inst = await mod.createNafathInstance(t, { slug: 'main', name: 'Main', config: { callbackUrl: `${cbBase}/cb` } });
  });
  afterAll(async () => {
    await app.close();
    await new Promise((r) => cbServer.close(r));
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('instances: create and list', async () => {
    expect(inst).toMatchObject({ slug: 'main', name: 'Main', enabled: true });
    expect(inst.urls.request).toBe(`${apiUrl}${B}/request`);
    expect((await mod.listNafathInstances(t)).map((i: any) => i.slug)).toEqual(['main']);
  });

  it('wait → choose the right number → the app sees COMPLETED; callback resend', async () => {
    // The wait starts before the app's request and is woken by it.
    const waiting = mod.waitForNafathRequest(t, { user: 'Mohammed', status: 'WAITING', timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    const a = await appRequest('1000000008');
    expect(a.status).toBe(200);
    const r = await waiting;
    expect(r).toMatchObject({ transId: a.body.transId, random: a.body.random, status: 'WAITING', nationalId: '1000000008' });
    expect(r.choices).toHaveLength(3);
    expect(r.choices).toContain(r.random);
    expect(await appStatus('1000000008', r.transId, r.random)).toBe('WAITING');

    const done = await mod.chooseNafathNumber(t, r.id, r.random);
    expect(done).toMatchObject({ status: 'COMPLETED', chosen: r.random });
    expect(done.token).toBeTruthy();
    expect(await appStatus('1000000008', r.transId, r.random)).toBe('COMPLETED');
    expect((await mod.getNafathRequest(t, r.id)).status).toBe('COMPLETED');

    // Deciding again is a 409 (StubyardError).
    await expect(mod.approveNafathRequest(t, r.id)).rejects.toMatchObject({ status: 409 });

    const before = callbacks.length;
    const res = await mod.resendNafathCallback(t, r.id);
    expect(res).toMatchObject({ ok: true, status: 200, attempt: 1 });
    expect(callbacks.length).toBeGreaterThan(before);
    expect(callbacks.at(-1)!.body).toMatchObject({ transId: r.transId, status: 'COMPLETED' });
  });

  it('approve, wrong number and reject; list with filters', async () => {
    const a = await appRequest('2000000006');
    const r = await mod.waitForNafathRequest(t, { nationalId: '2000000006', status: 'WAITING', timeoutMs: 2000 });
    expect(r.transId).toBe(a.body.transId);
    expect((await mod.approveNafathRequest(t, r.id)).status).toBe('COMPLETED');
    expect(await appStatus('2000000006', r.transId, r.random)).toBe('COMPLETED');

    // A wrong number: REJECTED (wrong_number).
    const b = await appRequest('2000000006');
    const r2 = await mod.waitForNafathRequest(t, { user: 'Resident', after: r.id, timeoutMs: 2000 });
    expect(r2.transId).toBe(b.body.transId);
    const wrong = r2.choices.find((c: string) => c !== r2.random);
    expect(await mod.chooseNafathNumber(t, r2.id, wrong)).toMatchObject({ status: 'REJECTED', reason: 'wrong_number' });

    const c = await appRequest('1234567897');
    const r3 = await mod.waitForNafathRequest(t, { user: 'Runner', status: 'WAITING', timeoutMs: 2000 });
    expect(r3.transId).toBe(c.body.transId);
    expect(await mod.rejectNafathRequest(t, r3.id)).toMatchObject({ status: 'REJECTED', reason: 'rejected' });
    expect(await appStatus('1234567897', r3.transId, r3.random)).toBe('REJECTED');

    const resident = await mod.listNafathRequests(t, { user: 'Resident' });
    expect(resident.map((x: any) => x.id)).toEqual([r2.id, r.id]);
    expect((await mod.listNafathRequests(t, { status: ['REJECTED'] })).map((x: any) => x.id).sort()).toEqual([r2.id, r3.id].sort());
    expect(await mod.listNafathRequests(t, { status: 'WAITING' })).toEqual([]);
    expect(await mod.listNafathRequests(t, { limit: 1 })).toHaveLength(1);
  });

  it('wait times out with an error naming the filter', async () => {
    const t0 = Date.now();
    await expect(mod.waitForNafathRequest(t, { user: 'Runner', status: 'WAITING', timeoutMs: 1000 })).rejects.toThrow(/No Nafath request \(user=Runner status=WAITING\) in project "ksa" within 1000 ms/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('faults: add (rejected once), list, hit, clear and delete', async () => {
    const rule = await mod.addNafathFault(t, { fault: 'rejected', user: 'Mohammed', times: 1 });
    expect(rule).toMatchObject({ fault: 'rejected', remaining: 1 });
    expect((await mod.listNafathFaults(t)).map((x: any) => x.id)).toContain(rule.id);

    const a = await appRequest('1000000008');
    expect(a.status).toBe(200);
    expect(await appStatus('1000000008', a.body.transId, a.body.random)).toBe('REJECTED');
    // Spent: the next request waits for a person.
    const b = await appRequest('1000000008');
    expect(await appStatus('1000000008', b.body.transId, b.body.random)).toBe('WAITING');
    const r = await mod.waitForNafathRequest(t, { user: 'Mohammed', status: 'WAITING', timeoutMs: 1000 });
    await mod.rejectNafathRequest(t, r.id);

    const down = await mod.addNafathFault(t, { fault: 'down' });
    expect((await appRequest('1000000008')).status).toBe(503);
    await mod.deleteNafathFault(t, down.id);
    expect((await mod.listNafathFaults(t)).map((x: any) => x.id)).not.toContain(down.id);

    await mod.addNafathFault(t, { fault: 'rate_limit', user: 'Resident' });
    expect(await mod.clearNafathFaults(t)).toBeGreaterThanOrEqual(1);
    expect((await mod.listNafathFaults(t)).filter((x: any) => x.remaining !== 0)).toEqual([]);
    expect(await mod.addNafathFault(t, { fault: 'none' })).toEqual({ cleared: true });
  });
});
