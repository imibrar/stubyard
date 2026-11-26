import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';

describe('fake Nafath (HTTP)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';
  let inst: any;

  async function call<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; logId: string | null }> {
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
    return { status: r.status, body: parsed as T, logId: r.headers.get('x-hub-request-id') };
  }
  const api = call;
  const creds = (i: any) => ({ 'APP-ID': i.appId, 'APP-KEY': i.appKey, 'X-Forwarded-For': '203.0.113.7' });
  const B = '/nafath/ksa/main/api/v1/mfa';

  /** The traffic row once onResponse has finished it. */
  async function logOf(id: string | null) {
    expect(id).toBeTruthy();
    for (let i = 0; i < 50; i++) {
      const l = hub.logs.get(id!);
      if (l && l.outcome && l.resolved && Object.keys(l.resolved).length) return l;
      await new Promise((r) => setTimeout(r, 20));
    }
    return hub.logs.get(id!)!;
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-nafath-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
    const identity = { firstNameAr: 'محمد', englishFirstName: 'Mohammed', englishLastName: 'Saud', gender: 'M', dateOfBirthG: '1990-01-01' };
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Mohammed', nationalId: '1000000008', identity })).status).toBe(201);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Resident', nationalId: '2000000006' })).status).toBe(201);
    expect((await api('POST', '/api/projects/ksa/users', { name: 'Runner', nationalId: '1234567897' })).status).toBe(201);
    const c = await api('POST', '/api/projects/ksa/nafath/instances', { slug: 'main', name: 'Main' });
    expect(c.status).toBe(201);
    inst = c.body;
  });
  afterAll(async () => {
    await app.close();
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('manages instances over the control API (no private keys, URLs, rotation)', async () => {
    expect(inst).toMatchObject({ slug: 'main', name: 'Main', strict: false, enabled: true });
    expect(inst.appId).toBeTruthy();
    expect(inst.appKey).toBeTruthy();
    expect(inst.keys).toHaveLength(1);
    expect(inst.keys[0].privatePem).toBeUndefined();
    expect(inst.urls.request).toBe(`${base}/nafath/ksa/main/api/v1/mfa/request`);
    const o = await api('GET', '/api/projects/ksa/nafath');
    expect(o.body.instances.map((i: any) => i.slug)).toEqual(['main']);
    expect(o.body.reference.errors.alreadyActive.code).toBe('400-034-050');
    expect((await api('GET', '/api/projects/ksa/nafath/instances/main')).body.id).toBe(inst.id);
    expect((await api('POST', '/api/projects/ksa/nafath/instances', { slug: 'main' })).status).toBe(409);
    const tmp = await api('POST', '/api/projects/ksa/nafath/instances', { slug: 'tmp' });
    const rot = await api('POST', '/api/projects/ksa/nafath/instances/tmp/keys/rotate', {});
    expect(rot.body.keys.map((k: any) => k.status)).toEqual(['retired', 'active']);
    expect((await call('GET', '/nafath/ksa/tmp/api/v1/mfa/jwk')).body.keys).toHaveLength(2);
    const drop = await api('POST', '/api/projects/ksa/nafath/instances/tmp/keys/rotate', { dropOld: true });
    expect(drop.body.keys).toHaveLength(1);
    const p = await api('PATCH', '/api/projects/ksa/nafath/instances/tmp', { name: 'Temp', config: { ttlSeconds: 60 } });
    expect(p.body).toMatchObject({ name: 'Temp', config: { ttlSeconds: 60 } });
    expect((await api('DELETE', `/api/projects/ksa/nafath/instances/${tmp.body.slug}`)).status).toBe(204);
    expect((await api('GET', '/api/projects/ksa/nafath/instances/tmp')).status).toBe(404);
  });

  it('request → WAITING → choose the right number → COMPLETED; info and a token that verifies against the JWK set', async () => {
    const r = await call('POST', `${B}/request?local=ar&requestId=req-1`, { nationalId: '1000000008', service: 'Login' }, creds(inst));
    expect(r.status).toBe(200);
    expect(r.body.transId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.random).toMatch(/^\d{2}$/);
    const { transId, random } = r.body;

    // One active transaction per ID.
    const again = await call('POST', `${B}/request`, { nationalId: '1000000008', service: 'Login' }, creds(inst));
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ code: '400-034-050' });
    expect(again.body.reference).toBeTruthy();

    const st = await call('POST', `${B}/request/status`, { nationalId: '1000000008', transId, random }, creds(inst));
    expect(st).toMatchObject({ status: 200, body: { status: 'WAITING' } });
    // Not approved yet.
    expect((await call('GET', `${B}/request/info?transId=${transId}&random=${random}&nationalId=1000000008`, undefined, creds(inst))).body.code).toBe('401-033-024');

    const list = await api('GET', '/api/projects/ksa/nafath/requests?user=Mohammed&status=WAITING');
    expect(list.body).toHaveLength(1);
    const req = list.body[0];
    expect(req).toMatchObject({ transId, random, service: 'Login', locale: 'ar', requestId: 'req-1', status: 'WAITING' });
    expect(req.choices).toContain(random);
    expect(req.choices).toHaveLength(3);

    const done = await api('POST', `/api/projects/ksa/nafath/requests/${req.id}/choose`, { number: random });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', chosen: random });
    expect((await api('POST', `/api/projects/ksa/nafath/requests/${req.id}/approve`)).status).toBe(409);

    expect((await call('POST', `${B}/request/status`, { nationalId: '1000000008', transId, random }, creds(inst))).body.status).toBe('COMPLETED');
    const info = await call('GET', `${B}/request/info?transId=${transId}&random=${random}&nationalId=1000000008`, undefined, creds(inst));
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ status: 'COMPLETED', transId, person: { nin: '1000000008', englishFirstName: 'Mohammed' } });

    // The token (sent in the callback in S2c) verifies against GET …/jwk.
    const token: string = (await api('GET', `/api/projects/ksa/nafath/requests/${transId}`)).body.token;
    const [h, p, s] = token.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url').toString());
    expect(head).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    const set = await call('GET', `${B}/jwk`);
    expect(set.status).toBe(200);
    const jwk = set.body.keys.find((k: any) => k.kid === head.kid);
    expect(jwk).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ status: 'COMPLETED', transId, aud: inst.appId, nin: '1000000008', iss: expect.stringContaining('/nafath/ksa/main') });

    // Sandbox and staging prefixes reach the same API.
    expect((await call('GET', '/nafath/ksa/main/nafath-sandbox/api/v1/mfa/jwk')).body.keys[0].kid).toBe(jwk.kid);
    expect((await call('GET', '/nafath/ksa/main/stg/api/v1/mfa/jwk')).body.keys[0].kid).toBe(jwk.kid);
  });

  it('a wrong number rejects; reject works from the control API', async () => {
    const r = await call('POST', `${B}/request`, { nationalId: '1000000008', service: 'Login' }, creds(inst));
    const req = (await api('GET', `/api/projects/ksa/nafath/requests/${r.body.transId}`)).body;
    const wrong = req.choices.find((c: string) => c !== req.random);
    expect((await api('POST', `/api/projects/ksa/nafath/requests/${req.id}/choose`, { number: wrong })).body).toMatchObject({ status: 'REJECTED', reason: 'wrong_number' });
    const r2 = await call('POST', `${B}/request`, { nationalId: '1000000008', service: 'Login' }, creds(inst));
    expect((await api('POST', `/api/projects/ksa/nafath/requests/${r2.body.transId}/reject`)).body).toMatchObject({ status: 'REJECTED', reason: 'rejected' });
    expect((await call('POST', `${B}/request/status`, { nationalId: '1000000008', transId: r2.body.transId, random: r2.body.random }, creds(inst))).body.status).toBe('REJECTED');
  });

  it('strict mode: a wrong APP-KEY is 403; lax mode only warns', async () => {
    const s = (await api('POST', '/api/projects/ksa/nafath/instances', { slug: 'strict', strict: true })).body;
    const bad = await call('POST', '/nafath/ksa/strict/api/v1/mfa/request', { nationalId: '2000000006', service: 'Login' }, { ...creds(s), 'APP-KEY': 'wrong' });
    expect(bad.status).toBe(403);
    expect(bad.body).toMatchObject({ code: '403' });
    const good = await call('POST', '/nafath/ksa/strict/api/v1/mfa/request', { nationalId: '2000000006', service: 'Login' }, creds(s));
    expect(good.status).toBe(200);
    // Unknown ID in strict mode.
    expect((await call('POST', '/nafath/ksa/strict/api/v1/mfa/request', { nationalId: '1000000016', service: 'Login' }, creds(s))).body.code).toBe('400-034-053');
    expect((await api('DELETE', '/api/projects/ksa/nafath/requests?user=Resident')).body.deleted).toBeGreaterThanOrEqual(1);

    // Lax: a wrong key is accepted and noted in the traffic log.
    const lax = await call('POST', `${B}/request`, { nationalId: '1234567897', service: 'Login' }, { ...creds(inst), 'APP-KEY': 'nope' });
    expect(lax.status).toBe(200);
    const log = await logOf(lax.logId);
    expect(log.resolved.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/APP-KEY/)]));
    await api('DELETE', '/api/projects/ksa/nafath/requests?user=Runner');
  });

  it('expires on the auth clock (project time offset)', async () => {
    const r = await call('POST', `${B}/request`, { nationalId: '2000000006', service: 'Login' }, creds(inst));
    expect(r.status).toBe(200);
    const body = { nationalId: '2000000006', transId: r.body.transId, random: r.body.random };
    expect((await call('POST', `${B}/request/status`, body, creds(inst))).body.status).toBe('WAITING');
    expect((await api('PUT', '/api/projects/ksa/time', { offsets: { auth: '+10m' } })).status).toBe(200);
    try {
      expect((await call('POST', `${B}/request/status`, body, creds(inst))).body.status).toBe('EXPIRED');
      expect((await call('GET', `${B}/request/info?transId=${r.body.transId}&random=${r.body.random}&nationalId=2000000006`, undefined, creds(inst))).body.code).toBe('400-034-051');
      // A new request is possible again.
      expect((await call('POST', `${B}/request`, { nationalId: '2000000006', service: 'Login' }, creds(inst))).status).toBe(200);
    } finally {
      await api('DELETE', '/api/projects/ksa/time');
      await api('DELETE', '/api/projects/ksa/nafath/requests?user=Resident');
    }
  });

  it('faults: add, list, hit and delete', async () => {
    const f = await api('POST', '/api/projects/ksa/nafath/faults', { fault: 'rate_limit', user: 'Resident', times: 1 });
    expect(f.status).toBe(201);
    expect((await api('GET', '/api/projects/ksa/nafath/faults')).body.map((x: any) => x.id)).toContain(f.body.id);
    const hit = await call('POST', `${B}/request`, { nationalId: '2000000006', service: 'Login' }, creds(inst));
    expect(hit.status).toBe(429);
    expect((await logOf(hit.logId)).outcome).toBe('forced_error');
    expect((await call('POST', `${B}/request`, { nationalId: '2000000006', service: 'Login' }, creds(inst))).status).toBe(200);
    expect((await api('DELETE', `/api/projects/ksa/nafath/faults/${f.body.id}`)).status).toBe(204);
    await api('POST', '/api/projects/ksa/nafath/faults', { fault: 'down' });
    expect((await api('POST', '/api/projects/ksa/nafath/faults', { fault: 'none' })).body).toEqual({ cleared: true });
    expect((await api('GET', '/api/projects/ksa/nafath/faults')).body).toEqual([]);
    expect((await api('POST', '/api/projects/ksa/nafath/faults', { fault: 'bogus' })).status).toBe(400);
    await api('DELETE', '/api/projects/ksa/nafath/requests?user=Resident');
  });

  it('answers 404 "No Mapping Rule matched" for an unknown path, prefix, instance or project', async () => {
    for (const p of ['/nafath/ksa/main/api/v9/nothing', '/nafath/ksa/main/prod/api/v1/mfa/jwk', '/nafath/ksa/nope/api/v1/mfa/jwk', '/nafath/nope/main/api/v1/mfa/jwk']) {
      const r = await call('GET', p);
      expect(r.status, p).toBe(404);
      expect(r.body.message, p).toBe('No Mapping Rule matched');
    }
    const r = await call('GET', '/nafath/ksa/main/api/v9/nothing');
    expect(r.body).toEqual({ message: 'No Mapping Rule matched' });
    const log = await logOf(r.logId);
    expect(log.outcome).toBe('unmatched');
    expect(log.resolved).toMatchObject({ kind: 'nafath', instance: 'main' });
  });

  it('logs traffic with resolved.kind nafath and a redacted APP-KEY', async () => {
    const r = await call('POST', `${B}/request`, { nationalId: '1000000008', service: 'Login' }, creds(inst));
    expect(r.status).toBe(200);
    const log = await logOf(r.logId);
    expect(log.projectId).toBe(hub.projects.require('ksa').id);
    expect(log.resolved).toMatchObject({ kind: 'nafath', project: 'ksa', instance: 'main', op: 'request', transId: r.body.transId, status: 'WAITING' });
    expect(log.reqHeaders?.['app-id']).toBe(inst.appId);
    expect(log.reqHeaders?.['app-key']).not.toBe(inst.appKey);
    expect(String(log.reqHeaders?.['app-key'])).toContain(inst.appKey.slice(-4));
    expect(String(log.reqHeaders?.['app-key'])).toContain('•');
    await api('DELETE', '/api/projects/ksa/nafath/requests?user=Mohammed');
  });

  it('attributes requests to a run from /run/<key>/nafath/… and fails loudly for an unknown run', async () => {
    expect((await api('POST', '/api/projects/ksa/runs', { key: 'n1' })).status).toBe(201);
    const r = await call('POST', `/run/n1${B}/request`, { nationalId: '1234567897', service: 'Login' }, creds(inst));
    expect(r.status).toBe(200);
    const runId = hub.runs.resolver.explicit(hub.projects.require('ksa').id, 'n1')!.id;
    const log = await logOf(r.logId);
    expect(log.runId).toBe(runId);
    expect(log.resolved).toMatchObject({ run: 'n1', runVia: 'prefix', kind: 'nafath' });
    expect((await api('GET', `/api/projects/ksa/nafath/requests/${r.body.transId}`)).body.runId).toBe(runId);
    expect((await api('GET', '/api/projects/ksa/nafath/requests?run=n1')).body.map((x: any) => x.transId)).toEqual([r.body.transId]);
    const unknown = await call('POST', `/run/zz9${B}/request`, { nationalId: '1234567897', service: 'Login' }, creds(inst));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('Unknown run');
  });
});
