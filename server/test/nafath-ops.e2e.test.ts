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

describe('fake Nafath ops: host mode, prefixes, export, retention, reset, Connect', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let hub: ReturnType<typeof createHub>;
  let dataDir: string;
  let base = '';
  let port = 0;
  const P = '/api/projects/ksa/nafath';
  let inst: any;
  let nid = '';

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

  /** A request with a Host header of our choice (fetch does not let you set it). */
  function onHost<T = any>(host: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, method, path: p, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}), ...headers } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* text */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          });
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }

  const used = new Set<string>();
  async function user(name: string): Promise<string> {
    let id = generateNationalId('citizen');
    while (used.has(id)) id = generateNationalId('citizen');
    used.add(id);
    expect((await call('POST', '/api/projects/ksa/users', { name, nationalId: id })).status).toBe(201);
    return id;
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-nafath-ops-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: null });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    ({ app } = await buildApp(hub, pino({ level: 'silent' })));
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as net.AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    expect((await call('POST', '/api/projects', { name: 'Ksa' })).status).toBe(201);
    const c = await call('POST', `${P}/instances`, { slug: 'main', name: 'Main' });
    expect(c.status).toBe(201);
    inst = c.body;
    nid = await user('Host User');
  });
  afterAll(async () => {
    await app.close();
    hub.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('host mode: the Elm hosts reach the instance found by APP-ID, with the /stg and /nafath-sandbox prefixes', async () => {
    const creds = { 'APP-ID': inst.appId, 'APP-KEY': inst.appKey };
    for (const host of ['nafath.api.elm.sa', 'rabet-nafath.api.elm.sa:443']) {
      const jwk = await onHost(host, 'GET', '/stg/api/v1/mfa/jwk', undefined, creds);
      expect(jwk.status).toBe(200);
      expect(jwk.body.keys[0].kid).toBe(inst.keys[0].kid);
    }
    const start = await onHost('nafath.api.elm.sa', 'POST', '/nafath-sandbox/api/v1/mfa/request?local=en&requestId=h1', { nationalId: nid, service: 'Login' }, creds);
    expect(start.status).toBe(200);
    expect(start.body.random).toMatch(/^\d{2}$/);
    const st = await onHost('nafath.api.elm.sa', 'POST', '/api/v1/mfa/request/status', { nationalId: nid, transId: start.body.transId, random: start.body.random }, creds);
    expect(st.body).toEqual({ status: 'WAITING' });
    const row = (await call('GET', `${P}/requests/${start.body.transId}`)).body;
    expect(row).toMatchObject({ instanceId: inst.id, nationalId: nid, requestId: 'h1' });

    // The only instance on the hub answers a JWK fetch without APP-ID; an unknown APP-ID is a 403.
    expect((await onHost('nafath.api.elm.sa', 'GET', '/api/v1/mfa/jwk')).status).toBe(200);
    const bad = await onHost('nafath.api.elm.sa', 'GET', '/api/v1/mfa/jwk', undefined, { 'APP-ID': 'nope' });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('403');
    // Unknown prefix → real Nafath's 404 body.
    const unk = await onHost('nafath.api.elm.sa', 'GET', '/uat/api/v1/mfa/jwk', undefined, creds);
    expect(unk.status).toBe(404);
    expect(unk.body).toEqual({ message: 'No Mapping Rule matched' });
    // stubyard's own /api/… is not rewritten into Nafath (the host guard answers it, as for any foreign host).
    const own = await onHost('nafath.api.elm.sa', 'GET', P);
    expect(own.body.message).not.toBe('No Mapping Rule matched');
    expect(own.body.code).toBeUndefined();
  });

  it('path prefixes on the instance URL; an unknown prefix answers 404 {"message":"No Mapping Rule matched"}', async () => {
    for (const p of ['', '/stg', '/nafath-sandbox']) {
      const r = await call('GET', `/nafath/ksa/main${p}/api/v1/mfa/jwk`);
      expect(r.status).toBe(200);
      expect(r.body.keys).toHaveLength(1);
    }
    const r = await call('GET', '/nafath/ksa/main/prod/api/v1/mfa/jwk');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ message: 'No Mapping Rule matched' });
  });

  it('Connect and the setup guide carry the base URL, APP-ID, APP-KEY and JWK URL', async () => {
    const c = await call('GET', `${P}/instances/main/connect`);
    expect(c.status).toBe(200);
    expect(c.body.env).toEqual({ NAFATH_BASE_URL: `${base}/nafath/ksa/main`, NAFATH_APP_ID: inst.appId, NAFATH_APP_KEY: inst.appKey, NAFATH_JWK_URL: `${base}/nafath/ksa/main/api/v1/mfa/jwk` });
    expect(c.body.hosts.map((h: any) => h.id)).toEqual(['host', 'docker', 'docker-host']);
    expect(c.body.hostMode.hosts).toEqual(['nafath.api.elm.sa', 'rabet-nafath.api.elm.sa']);
    expect(c.body.snippets.map((s: any) => s.title).join('|')).toMatch(/jose.*laravel-nafath.*nafath-php/);

    const g = await call('GET', '/api/projects/ksa/setup');
    expect(g.status).toBe(200);
    const sec = g.body.sections.find((s: any) => s.id === 'nafath-main');
    expect(sec).toBeTruthy();
    const text = JSON.stringify(sec);
    expect(text).toContain(`/nafath/ksa/main`);
    expect(text).toContain(`NAFATH_APP_ID=${inst.appId}`);
    expect(text).toContain('NAFATH_JWK_URL=');
  });

  it('export without secrets: no APP-KEY or keys; import generates new ones with a warning (and a new APP-ID when it is taken)', async () => {
    expect((await call('POST', `${P}/faults`, { fault: 'rejected', instance: 'main', nationalId: nid, times: 2 })).status).toBe(201);
    const ex = await call('GET', '/api/projects/ksa/export');
    expect(ex.status).toBe(200);
    const rows = ex.body.nafathInstances;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slug: 'main', appId: inst.appId });
    expect(rows[0].appKey).toBeUndefined();
    expect(rows[0].keys).toBeUndefined();
    expect(JSON.stringify(ex.body)).not.toContain('PRIVATE KEY');
    expect(ex.body.nafathRules).toHaveLength(1);

    const im = await call('POST', '/api/projects/import', { json: ex.body, slug: 'ksa-copy' });
    expect(im.status).toBe(201);
    expect(im.body.warnings.some((w: string) => w.includes('new APP-KEY and signing key'))).toBe(true);
    expect(im.body.warnings.some((w: string) => w.includes('already used'))).toBe(true);
    const copy = (await call('GET', '/api/projects/ksa-copy/nafath/instances/main')).body;
    expect((await call('GET', '/api/projects/ksa-copy/nafath/instances/main/connect')).body.appKey).not.toBe(inst.appKey);
    expect(copy.appId).not.toBe(inst.appId);
    expect(copy.keys[0].kid).not.toBe(inst.keys[0].kid);
    const rules = (await call('GET', '/api/projects/ksa-copy/nafath/faults')).body;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ instanceId: copy.id, fault: 'rejected', remaining: 2, match: { nationalId: nid } });
  });

  it('export with ?secrets=1 keeps the APP-KEY and the signing keys (same JWK kid)', async () => {
    const ex = await call('GET', '/api/projects/ksa/export?secrets=1');
    expect(ex.body.nafathInstances[0].appKey).toBe(inst.appKey);
    const im = await call('POST', '/api/projects/import', { json: ex.body, slug: 'ksa-secrets' });
    expect(im.status).toBe(201);
    expect(im.body.warnings.some((w: string) => w.includes('new APP-KEY'))).toBe(false);
    const copy = (await call('GET', '/api/projects/ksa-secrets/nafath/instances/main')).body;
    expect((await call('GET', '/api/projects/ksa-secrets/nafath/instances/main/connect')).body.appKey).toBe(inst.appKey);
    expect(copy.keys[0].privatePem).toBeUndefined();
    const jwk = (await call('GET', '/nafath/ksa-secrets/main/api/v1/mfa/jwk')).body;
    expect(jwk.keys.map((k: any) => k.kid)).toEqual([inst.keys[0].kid]);
    // The imported key signs: a decided request's token carries the same kid.
    const u = await call('POST', '/api/projects/ksa-secrets/users', { name: 'Signer', nationalId: generateNationalId('resident') });
    expect(u.status).toBe(201);
    const r = await call('POST', '/api/projects/ksa-secrets/nafath/requests', { user: u.body.id });
    expect(r.status).toBe(201);
    const done = await call('POST', `/api/projects/ksa-secrets/nafath/requests/${r.body.id}/approve`);
    expect(done.body.status).toBe('COMPLETED');
    const head = JSON.parse(Buffer.from(String(done.body.token).split('.')[0], 'base64url').toString());
    expect(head.kid).toBe(inst.keys[0].kid);
  });

  it('import with only one of the secrets: the warning names what was generated, the other is kept', async () => {
    const ex = (await call('GET', '/api/projects/ksa/export?secrets=1')).body;
    const row = ex.nafathInstances[0];

    // APP-KEY without signing keys: a new signing key, the APP-KEY stays.
    const noKeys = { ...ex, nafathInstances: [{ ...row, keys: undefined }] };
    const a = await call('POST', '/api/projects/import', { json: noKeys, slug: 'ksa-appkey' });
    expect(a.status).toBe(201);
    const wa = a.body.warnings.find((w: string) => w.includes('generated'));
    expect(wa).toContain('new signing key generated');
    expect(wa).not.toContain('APP-KEY');
    expect((await call('GET', '/api/projects/ksa-appkey/nafath/instances/main/connect')).body.appKey).toBe(inst.appKey);
    expect((await call('GET', '/api/projects/ksa-appkey/nafath/instances/main')).body.keys[0].kid).not.toBe(inst.keys[0].kid);

    // Signing keys without the APP-KEY: a new APP-KEY, the key (kid) stays.
    const noAppKey = { ...ex, nafathInstances: [{ ...row, appKey: undefined }] };
    const b = await call('POST', '/api/projects/import', { json: noAppKey, slug: 'ksa-keys' });
    expect(b.status).toBe(201);
    const wb = b.body.warnings.find((w: string) => w.includes('generated'));
    expect(wb).toContain('new APP-KEY generated');
    expect(wb).not.toContain('signing key');
    expect((await call('GET', '/api/projects/ksa-keys/nafath/instances/main/connect')).body.appKey).not.toBe(inst.appKey);
    expect((await call('GET', '/nafath/ksa-keys/main/api/v1/mfa/jwk')).body.keys.map((k: any) => k.kid)).toEqual([inst.keys[0].kid]);
  });

  it('retention purges old requests', async () => {
    const project = hub.projects.getBySlug('ksa')!;
    const before = hub.nafath.listRequests(project.id).length;
    expect(before).toBeGreaterThan(0);
    hub.db.prepare('UPDATE nafath_requests SET created_at = ? WHERE project_id = ?').run(new Date(Date.now() - 400 * 86_400_000).toISOString(), project.id);
    const report = await hub.maintenance.run();
    expect(report.nafathPurged).toBe(before);
    expect(hub.nafath.listRequests(project.id)).toHaveLength(0);
  });

  it('DELETE /requests and project reset cancel pending nafath.decide schedules', async () => {
    const project = hub.projects.getBySlug('ksa')!;
    expect((await call('PATCH', `${P}/instances/main`, { config: { autoDecision: 'approve', autoDelayMs: 600_000 } })).status).toBe(200);
    await call('DELETE', `${P}/faults`); // the rejected rule from the export test would decide at once
    const pending = () => hub.schedules.repo.active({ projectId: project.id }).filter((s) => s.path.startsWith('/nafath/requests/'));

    const other = await user('Other');
    await call('POST', `${P}/requests`, { user: other });
    const a = await call('POST', `${P}/requests`, { user: nid });
    expect(a.status).toBe(201);
    expect(pending()).toHaveLength(2);
    const del = await call('DELETE', `${P}/requests?user=${nid}`);
    expect(del.body).toEqual({ deleted: 1, schedulesCancelled: 1 });
    expect(pending()).toHaveLength(1);
    expect(hub.schedules.repo.get(hub.schedules.repo.list(project.id, { status: ['cancelled'] })[0].id)?.path).toBe(`/nafath/requests/${a.body.id}/decide`);

    expect((await call('POST', '/api/projects/ksa/reset')).status).toBe(200);
    expect(pending()).toHaveLength(0);
  });
});
