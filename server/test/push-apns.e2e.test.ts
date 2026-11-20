import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { APNS_LIMITS, startApnsServer, type ApnsListener } from '../src/push/apns-server.js';

/** Push notifications, APNs provider API: HTTP/2 over TLS (stubyard CA), h2c, ES256 provider tokens, reasons, HTTP/1.1 route. */

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
let tlsApns: ApnsListener;
let h2cApns: ApnsListener;
let session: http2.ClientHttp2Session;
const P = 'iosapp';
const API = `/api/projects/${P}/push`;
const BUNDLE = 'com.example.chat';

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text as T };
  }
}

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function providerToken(o: { key: string; kid: string; iss: string; iat?: number }) {
  const input = `${b64u({ alg: 'ES256', kid: o.kid })}.${b64u({ iss: o.iss, iat: o.iat ?? Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('SHA256', Buffer.from(input), { key: o.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${sig}`;
}

function h2request(s: http2.ClientHttp2Session, p: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: http2.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = s.request({ ':method': 'POST', ':path': p, ...headers });
    let data = '';
    let h: http2.IncomingHttpHeaders = {};
    req.on('response', (x) => (h = x));
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let parsed: unknown = data;
      try {
        parsed = data ? JSON.parse(data) : null;
      } catch {
        /* text */
      }
      resolve({ status: Number(h[':status']), headers: h, body: parsed });
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('push: APNs provider API', () => {
  let key: string;
  let kid: string;
  let team: string;
  let device: any;
  let jwt: string;
  const push = (token: string, payload: unknown, headers: Record<string, string> = {}, s = session) =>
    h2request(s, `/3/device/${token}`, { authorization: `bearer ${jwt}`, 'apns-topic': BUNDLE, 'apns-push-type': 'alert', ...headers }, typeof payload === 'string' ? payload : JSON.stringify(payload));

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-push-apns-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', timeoutHoldMs: 300, maintenanceIntervalMs: 0, apnsPort: 0 });
    const logger = pino({ level: 'silent' });
    hub = createHub(config, { mailpit: null, dbFile: ':memory:', logger }); // TLS on: the stubyard CA signs the APNs cert
    const { app } = await buildApp(hub, logger);
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    tlsApns = await startApnsServer(hub, { port: 0, host: '127.0.0.1' });
    h2cApns = await startApnsServer({ ...hub, tls: null } as Hub, { port: 0, host: '127.0.0.1' });
    close = async () => {
      session?.close();
      await tlsApns.close();
      await h2cApns.close();
      await hub.mcpTester.closeAll();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'iOS app', slug: P })).status).toBe(201);
    await api('POST', `/api/projects/${P}/users`, { name: 'Alice', email: 'alice@ios.test' });
    const inst = await api('POST', `${API}/instances`, { preset: 'apns', config: { bundleIds: [BUNDLE] } });
    expect(inst.status).toBe(201);
    expect(inst.body.config.teamId).toMatch(/^[A-Z0-9]{10}$/);
    kid = inst.body.config.keyId;
    team = inst.body.config.teamId;
    key = (await api('GET', `${API}/instances/apns/apns-key.p8`)).body;
    expect(key).toContain('BEGIN PRIVATE KEY');
    device = (await api('POST', `${API}/devices`, { user: 'alice@ios.test', platform: 'ios' })).body;
    expect(device.token).toMatch(/^[0-9a-f]{64}$/);
    jwt = providerToken({ key, kid, iss: team });
    session = http2.connect(`https://localhost:${tlsApns.port}`, { ca: hub.tls!.caCertPem });
  });
  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('HTTP/2 + TLS: 200 with apns-id and apns-unique-id (sandbox); the push is in the inbox; bearer is redacted in traffic', async () => {
    const id = crypto.randomUUID();
    const r = await push(device.token, { aps: { alert: { title: 'Hello', body: 'From APNs' }, badge: 4, sound: 'default' }, chatId: '7' }, { 'apns-id': id });
    expect(r.status).toBe(200);
    expect(r.headers['apns-id']).toBe(id);
    expect(r.headers['apns-unique-id']).toBeTruthy();
    const [n] = (await api('GET', `${API}/notifications?user=alice@ios.test`)).body;
    expect(n).toMatchObject({ provider: 'apns', status: 'delivered', title: 'Hello', body: 'From APNs', badge: 4, sound: 'default', data: { chatId: '7' }, pushType: 'alert' });
    const rows = hub.db.prepare("SELECT url, req_headers, resolved FROM traffic_logs WHERE url LIKE '%/3/device/%'").all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].req_headers).not.toContain(jwt);
    expect(JSON.parse(rows[0].resolved)).toMatchObject({ kind: 'push', provider: 'apns', transport: 'h2', status: 'delivered' });
  });

  it('reasons: BadDeviceToken, TopicDisallowed, MissingTopic, BadPriority header, PayloadTooLarge, InvalidPushType, BadMessageId', async () => {
    expect((await push('zz-not-hex', { aps: { alert: 'x' } })).body).toEqual({ reason: 'BadDeviceToken' });
    expect((await push(device.token, { aps: { alert: 'x' } }, { 'apns-topic': 'com.other.app' })).body.reason).toBe('TopicDisallowed');
    const noTopic = await h2request(session, `/3/device/${device.token}`, { authorization: `bearer ${jwt}` }, '{"aps":{"alert":"x"}}');
    expect(noTopic).toMatchObject({ status: 400, body: { reason: 'MissingTopic' } });
    expect((await push(device.token, { aps: { alert: 'x' } }, { 'apns-priority': '7' })).body.reason).toBe('BadPriority');
    const big = await push(device.token, { aps: { alert: 'x'.repeat(4200) } });
    expect(big).toMatchObject({ status: 413, body: { reason: 'PayloadTooLarge' } });
    expect((await push(device.token, { aps: { alert: 'x' } }, { 'apns-push-type': 'nope' })).body.reason).toBe('InvalidPushType');
    expect((await push(device.token, { aps: { alert: 'x' } }, { 'apns-id': 'not-a-uuid' })).body.reason).toBe('BadMessageId');
    expect((await push(device.token, '')).body.reason).toBe('PayloadEmpty');
  });

  it('provider token: wrong key is a warning in lax and 403 InvalidProviderToken in strict; expired token is always 403', async () => {
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const badJwt = providerToken({ key: other, kid, iss: team });
    const fresh = http2.connect(`https://localhost:${tlsApns.port}`, { ca: hub.tls!.caCertPem });
    const lax = await h2request(fresh, `/3/device/${device.token}`, { authorization: `bearer ${badJwt}`, 'apns-topic': BUNDLE }, '{"aps":{"alert":"lax"}}');
    expect(lax.status).toBe(200);
    await api('PATCH', `${API}/instances/apns`, { strict: true });
    const strict = await h2request(fresh, `/3/device/${device.token}`, { authorization: `bearer ${badJwt}`, 'apns-topic': BUNDLE }, '{"aps":{"alert":"x"}}');
    expect(strict).toMatchObject({ status: 403, body: { reason: 'InvalidProviderToken' } });
    const noAuth = await h2request(fresh, `/3/device/${device.token}`, { 'apns-topic': BUNDLE }, '{"aps":{"alert":"x"}}');
    expect(noAuth).toMatchObject({ status: 403, body: { reason: 'MissingProviderToken' } });
    // Background push with priority 10: lint in lax, BadPriority in strict.
    const bg = await push(device.token, { aps: { 'content-available': 1 } }, { 'apns-push-type': 'background', 'apns-priority': '10' });
    expect(bg.body.reason).toBe('BadPriority');
    await api('PATCH', `${API}/instances/apns`, { strict: false });
    const old = providerToken({ key, kid, iss: team, iat: Math.floor(Date.now() / 1000) - 3700 });
    const exp = await h2request(fresh, `/3/device/${device.token}`, { authorization: `bearer ${old}`, 'apns-topic': BUNDLE }, '{"aps":{"alert":"x"}}');
    expect(exp).toMatchObject({ status: 403, body: { reason: 'ExpiredProviderToken' } });
    fresh.close();
    const bgLax = await push(device.token, { aps: { 'content-available': 1 } }, { 'apns-push-type': 'background', 'apns-priority': '10' });
    expect(bgLax.status).toBe(200);
    const [n] = (await api('GET', `${API}/notifications?device=${device.id}&limit=1`)).body;
    expect(n.silent).toBe(true);
    expect(n.lint.map((l: any) => l.check)).toContain('push.apns-background-priority');
  });

  it('unregistered device: 410 Unregistered with timestamp; voip topic suffix lint', async () => {
    const d = (await api('POST', `${API}/devices`, { user: 'alice@ios.test', platform: 'ios' })).body;
    await api('POST', `${API}/devices/${d.id}/unregister`);
    const r = await push(d.token, { aps: { alert: 'x' } });
    expect(r.status).toBe(410);
    expect(r.body.reason).toBe('Unregistered');
    expect(typeof r.body.timestamp).toBe('number');
    const v = await push(device.token, { aps: {} , call: '1' }, { 'apns-push-type': 'voip' });
    expect(v.status).toBe(200);
    const [n] = (await api('GET', `${API}/notifications?device=${device.id}&limit=1`)).body;
    expect(n.lint.map((l: any) => l.check)).toContain('push.apns-topic-mismatch');
  });

  it('faults: TooManyRequests via rule, InternalServerError via X-Hub-Scenario, collapse id', async () => {
    expect((await api('POST', `${API}/faults`, { fault: 'quota', token: device.token, times: 1 })).status).toBe(201);
    expect(await push(device.token, { aps: { alert: 'x' } })).toMatchObject({ status: 429, body: { reason: 'TooManyRequests' } });
    expect((await push(device.token, { aps: { alert: 'x' } }, { 'x-hub-scenario': 'internal' })).status).toBe(500);
    await push(device.token, { aps: { alert: 'Score 1-0' } }, { 'apns-collapse-id': 'score' });
    await push(device.token, { aps: { alert: 'Score 2-0' } }, { 'apns-collapse-id': 'score' });
    const rows = (await api('GET', `${API}/notifications?device=${device.id}&limit=2`)).body;
    expect(rows.map((n: any) => [n.body, n.status])).toEqual([
      ['Score 2-0', 'delivered'],
      ['Score 1-0', 'collapsed'],
    ]);
  });

  it('h2c listener works when TLS is off; HTTP/1.1 clients are refused', async () => {
    const s = http2.connect(`http://127.0.0.1:${h2cApns.port}`);
    const r = await push(device.token, { aps: { alert: { title: 'h2c', body: 'plain' } } }, {}, s);
    s.close();
    expect(r.status).toBe(200);
    const rows = hub.db.prepare("SELECT resolved FROM traffic_logs WHERE resolved LIKE '%h2c%'").all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    const h1 = await fetch(`http://127.0.0.1:${h2cApns.port}/3/device/${device.token}`, { method: 'POST', body: '{}' });
    expect(h1.status).toBe(505);
    expect((await h1.json()).message).toContain('HTTP/2');
  });

  it('the HTTP/1.1 route on the normal port (curl) and /push/<p>/<i> prefix on the h2 listener', async () => {
    const r = await fetch(`${base}/push/${P}/apns/3/device/${device.token}`, { method: 'POST', headers: { 'apns-topic': BUNDLE, authorization: `bearer ${jwt}` }, body: JSON.stringify({ aps: { alert: 'via http1' } }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('apns-id')).toMatch(/^[0-9a-f-]{36}$/);
    const p = await h2request(session, `/push/${P}/apns/3/device/${device.token}`, { authorization: `bearer ${jwt}`, 'apns-topic': BUNDLE }, '{"aps":{"alert":"prefixed"}}');
    expect(p.status).toBe(200);
    expect((await h2request(session, `/push/nope/apns/3/device/${device.token}`, {}, '{}')).body.reason).toBe('BadPath');
    expect((await api('GET', `${API}/notifications?contains=prefixed`)).body).toHaveLength(1);
  });

  it('/run/<key> without a project prefix is resolved in the project the token points at (keys are unique per project only)', async () => {
    expect((await api('POST', '/api/projects', { name: 'Another', slug: 'another' })).status).toBe(201);
    expect((await api('POST', '/api/projects/another/runs', { key: 'shared' })).status).toBe(201);
    expect((await api('POST', '/api/projects/another/runs', { key: 'elsewhere' })).status).toBe(201);
    expect((await api('POST', `/api/projects/${P}/runs`, { key: 'shared' })).status).toBe(201);
    const r = await h2request(session, `/run/shared/3/device/${device.token}`, { authorization: `bearer ${jwt}`, 'apns-topic': BUNDLE }, '{"aps":{"alert":"run scoped"}}');
    expect(r.status).toBe(200);
    expect((await api('GET', `${API}/notifications?run=shared`)).body.map((n: any) => n.body)).toEqual(['run scoped']);
    const mine = hub.runs.resolver.explicit(hub.projects.getBySlug(P)!.id, 'shared')!;
    expect(hub.db.prepare("SELECT run_id FROM push_notifications WHERE body = 'run scoped'").get()).toEqual({ run_id: mine.id });
    // A run that exists only in another project is unknown here.
    const other = await h2request(session, `/push/${P}/apns/run/elsewhere/3/device/${device.token}`, { authorization: `bearer ${jwt}`, 'apns-topic': BUNDLE }, '{"aps":{"alert":"x"}}');
    expect(other.status).toBe(404);
    const hdr = await h2request(session, `/3/device/${device.token}`, { authorization: `bearer ${jwt}`, 'apns-topic': BUNDLE, 'x-hub-run': 'elsewhere' }, '{"aps":{"alert":"x"}}');
    expect(hdr).toMatchObject({ status: 404, body: { reason: 'BadPath' } });
    expect(hdr.headers['x-stubyard-reason']).toMatch(/Unknown run "elsewhere" in project iosapp/);
  });

  it('bad values answer 400, not 500: huge apns-expiration, bad % escape in the device token', async () => {
    expect(await push(device.token, { aps: { alert: 'x' } }, { 'apns-expiration': '99999999999999999' })).toMatchObject({ status: 400, body: { reason: 'BadExpirationDate' } });
    expect((await push('%E0%A4%A', { aps: { alert: 'x' } })).body.reason).toBe('BadDeviceToken');
    const r = await fetch(`${base}/push/${P}/apns/3/device/${device.token}`, { method: 'POST', headers: { 'apns-topic': BUNDLE, authorization: `bearer ${jwt}`, 'apns-expiration': '99999999999999999' }, body: '{"aps":{"alert":"x"}}' });
    expect(r.status).toBe(400);
  });

  it('listener limits: max concurrent streams advertised; a request that never ends is cancelled', async () => {
    const s = http2.connect(`https://localhost:${tlsApns.port}`, { ca: hub.tls!.caCertPem });
    await new Promise<void>((r) => s.once('remoteSettings', () => r()));
    expect(s.remoteSettings.maxConcurrentStreams).toBe(APNS_LIMITS.maxConcurrentStreams);
    const prev = APNS_LIMITS.streamMs;
    APNS_LIMITS.streamMs = 200;
    try {
      const req = s.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${jwt}`, 'apns-topic': BUNDLE });
      req.on('error', () => undefined);
      req.write('{"aps":');
      const t0 = Date.now();
      const code = await new Promise<number>((r) => req.on('close', () => r(req.rstCode)));
      expect(code).toBe(http2.constants.NGHTTP2_CANCEL);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      APNS_LIMITS.streamMs = prev;
      s.close();
    }
  });

  it('connect gives the APNs port, key id, team id and snippets', async () => {
    const c = (await api('GET', `${API}/instances/apns/connect`)).body;
    expect(c).toMatchObject({ preset: 'apns', keyId: kid, teamId: team, bundleIds: [BUNDLE] });
    expect(c.snippets.map((s: any) => s.title)).toContain('@parse/node-apn');
  });
});
