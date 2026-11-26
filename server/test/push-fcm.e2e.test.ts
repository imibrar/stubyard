import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { JWT } from 'google-auth-library';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostHttpBase, loadConfig } from '../src/config.js';
import { migrate } from '../src/db/index.js';
import { DB } from '../src/db/index.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { parseCondition } from '../src/push/fcm.js';

/** Push notifications, FCM HTTP v1: service account → OAuth token (real google-auth-library) → messages:send, topics, faults, runs, wait. */

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
const P = 'pushy';
const API = `/api/projects/${P}/push`;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function assertion(sa: any, o: { key?: string; aud?: string; iat?: number; exp?: number; scope?: string } = {}) {
  const iat = o.iat ?? Math.floor(Date.now() / 1000);
  const input = `${b64u({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })}.${b64u({ iss: sa.client_email, scope: o.scope ?? 'https://www.googleapis.com/auth/firebase.messaging', aud: o.aud ?? sa.token_uri, iat, exp: o.exp ?? iat + 3600 })}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), o.key ?? sa.private_key).toString('base64url')}`;
}
async function token(sa: any, o: Parameters<typeof assertion>[1] = {}) {
  const r = await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(sa, o) }) });
  return { status: r.status, body: (await r.json()) as any };
}

describe('push: FCM HTTP v1', () => {
  let sa: any;
  let access: string;
  let send: string;
  let alice: any;
  let bob: any;
  const fcm = (message: unknown, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    api('POST', send.replace(base, ''), { message, ...extra }, { authorization: `Bearer ${access}`, ...headers });

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-push-fcm-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', timeoutHoldMs: 300, maintenanceIntervalMs: 0, apnsPort: 0 });
    const logger = pino({ level: 'silent' });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger });
    const { app } = await buildApp(hub, logger);
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await hub.mcpTester.closeAll();
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Pushy', slug: P })).status).toBe(201);
    alice = (await api('POST', `/api/projects/${P}/users`, { name: 'Alice', email: 'alice@push.test' })).body;
    bob = (await api('POST', `/api/projects/${P}/users`, { name: 'Bob', email: 'bob@push.test' })).body;
    const inst = await api('POST', `${API}/instances`, { preset: 'fcm', config: { fcmProjectId: 'pushy-app' } });
    expect(inst.status).toBe(201);
    expect(inst.body.slug).toBe('fcm');
    expect(JSON.stringify(inst.body)).not.toContain('PRIVATE KEY');
    sa = (await api('GET', `${API}/instances/fcm/service-account.json`)).body;
    expect(sa).toMatchObject({ type: 'service_account', project_id: 'pushy-app', token_uri: `${base}/push/${P}/fcm/token`, universe_domain: 'googleapis.com' });
    expect(sa.private_key).toContain('BEGIN PRIVATE KEY');
    send = `${base}/push/${P}/fcm/v1/projects/pushy-app/messages:send`;
  });
  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('real google-auth-library gets a token from token_uri; messages:send delivers to a registered device', async () => {
    const jwt = new JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
      // google-auth-library always posts to oauth2.googleapis.com: send that request to stubyard's token_uri.
      transporterOptions: { fetchImplementation: ((url: string | URL, init: RequestInit) => fetch(String(url).replace('https://oauth2.googleapis.com/token', sa.token_uri), init)) as never },
    });
    const t = await jwt.getAccessToken();
    expect(t.token).toMatch(/^ya29\.stubyard\./);
    access = t.token!;
    const dev = await api('POST', `${API}/devices`, { user: 'alice@push.test', platform: 'android', topics: ['news'] });
    expect(dev.status).toBe(201);
    expect(dev.body.token).toMatch(/^[A-Za-z0-9_-]{22}:APA91b[A-Za-z0-9_-]+$/);
    const r = await fcm({ token: dev.body.token, notification: { title: 'New message', body: 'Bob: hi!' }, data: { chatId: '42' }, android: { priority: 'HIGH', notification: { click_action: 'OPEN_CHAT' } } });
    expect(r.status).toBe(200);
    expect(r.body.name).toMatch(/^projects\/pushy-app\/messages\/0:/);
    const list = await api('GET', `${API}/notifications?user=alice@push.test`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ provider: 'fcm', status: 'delivered', title: 'New message', body: 'Bob: hi!', data: { chatId: '42' }, priority: 'HIGH', user: { name: 'Alice' } });
    const open = await api('POST', `${API}/notifications/${list.body[0].id}/open`);
    expect(open.body.tap).toEqual({ kind: 'click_action', value: 'OPEN_CHAT' });
    // Traffic: the bearer token is redacted, the assertion form field too.
    const logs = hub.logs.list?.({ projectId: hub.projects.getBySlug(P)!.id } as never) as any[] | undefined;
    const rows = (hub.db.prepare("SELECT url, req_headers, req_body, resolved FROM traffic_logs WHERE url LIKE '/push/%'").all() as any[]) ?? logs;
    const sendRow = rows.find((x) => x.url.includes('messages:send'));
    expect(sendRow.req_headers).not.toContain(access);
    expect(JSON.parse(sendRow.resolved)).toMatchObject({ kind: 'push', provider: 'fcm', instance: 'fcm', status: 'delivered' });
    const tokenRow = rows.find((x) => x.url.endsWith('/token'));
    expect(tokenRow.req_body).toContain('assertion=[redacted]');
  });

  it('bad values answer 400, not 500; the lax token store stays bounded', async () => {
    const dev = (await api('POST', `${API}/devices`, { user: 'bob@push.test', platform: 'android' })).body;
    const ttl = await fcm({ token: dev.token, notification: { title: 'x' }, android: { ttl: '99999999999999999999s' } });
    expect(ttl.status).toBe(400);
    expect(ttl.body.error.status).toBe('INVALID_ARGUMENT');
    const exp = await fcm({ token: dev.token, notification: { title: 'x' }, apns: { headers: { 'apns-expiration': '99999999999999999' } } });
    expect(exp.status).toBe(400);
    expect(exp.body.error.status).toBe('INVALID_ARGUMENT');
    const esc = await api('POST', `/push/${P}/fcm/v1/projects/%E0%A4%A/messages:send`, { message: { token: dev.token } }, { authorization: `Bearer ${access}` });
    expect(esc.status).toBe(400);
    // Scopes stored per token are capped, and so is the number of tokens.
    const many = await token(sa, { scope: Array.from({ length: 100 }, (_, i) => `https://example.test/scope/${i}`).join(' ') });
    expect(many.status).toBe(200);
    expect(hub.push.fcmToken(many.body.access_token)!.scopes).toHaveLength(20);
    const inst = hub.push.repo.instanceBySlug(hub.projects.getBySlug(P)!.id, 'fcm')!;
    for (let i = 0; i < 1100; i++) hub.push.issueFcmToken(inst.id, ['s'], []);
    expect(hub.push.fcmTokens.size).toBeLessThanOrEqual(1000);
    // The oldest tokens went (the one from the first test too): a fresh one works.
    expect((await fcm({ token: dev.token, data: { a: 'b' } })).status).toBe(401);
    access = (await token(sa)).body.access_token;
    expect((await fcm({ token: dev.token, data: { a: 'b' } })).status).toBe(200);
  });

  it('data-only message is silent; non-string data is 400 INVALID_ARGUMENT', async () => {
    const dev = (await api('POST', `${API}/devices`, { user: 'bob@push.test', platform: 'android' })).body;
    const r = await fcm({ token: dev.token, data: { sync: 'inbox' } });
    expect(r.status).toBe(200);
    const [n] = (await api('GET', `${API}/notifications?device=${dev.id}`)).body;
    expect(n).toMatchObject({ silent: true, title: null, data: { sync: 'inbox' }, pushType: 'data' });
    const bad = await fcm({ token: dev.token, data: { count: 3 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 400, status: 'INVALID_ARGUMENT' });
    expect(bad.body.error.message).toContain("message.data[0].value");
  });

  it('error shapes: invalid token, two targets, unknown field, too big, unregistered, sender mismatch, no bearer', async () => {
    const bad = await fcm({ token: 'short' , notification: { title: 'x' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toContainEqual({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'INVALID_ARGUMENT' });
    expect((await fcm({ token: 'a'.repeat(40), topic: 'news' })).status).toBe(400);
    const unk = await fcm({ token: 'a'.repeat(40), notifcation: { title: 'typo' } });
    expect(unk.status).toBe(400);
    expect(unk.body.error.message).toContain('Unknown name "notifcation"');
    const dev = (await api('POST', `${API}/devices`, { user: 'bob@push.test', platform: 'android' })).body;
    const big = await fcm({ token: dev.token, data: { blob: 'x'.repeat(4100) } });
    expect(big.status).toBe(400);
    expect(big.body.error.message).toContain('too big');
    expect((await api('POST', `${API}/devices/${dev.id}/unregister`)).body.state).toBe('unregistered');
    const gone = await fcm({ token: dev.token, notification: { title: 'x' } });
    expect(gone.status).toBe(404);
    expect(gone.body.error).toMatchObject({ code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] });
    expect((await api('POST', `${API}/devices/${dev.id}/register`)).body.state).toBe('active');
    // lax: wrong project id in the URL is a warning + lint; strict: 403 SENDER_ID_MISMATCH.
    const other = await api('POST', `/push/${P}/fcm/v1/projects/someone-else/messages:send`, { message: { token: dev.token, notification: { title: 'x' } } }, { authorization: `Bearer ${access}` });
    expect(other.status).toBe(200);
    const [last] = (await api('GET', `${API}/notifications?device=${dev.id}&limit=1`)).body;
    expect(last.lint.map((l: any) => l.check)).toContain('push.fcm-sender-mismatch');
    await api('PATCH', `${API}/instances/fcm`, { strict: true });
    const strict = await api('POST', `/push/${P}/fcm/v1/projects/someone-else/messages:send`, { message: { token: dev.token, notification: { title: 'x' } } }, { authorization: `Bearer ${access}` });
    expect(strict.status).toBe(403);
    expect(strict.body.error).toMatchObject({ status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] });
    await api('PATCH', `${API}/instances/fcm`, { strict: false });
    const noAuth = await api('POST', send.replace(base, ''), { message: { token: dev.token } });
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error.status).toBe('UNAUTHENTICATED');
    // Legacy APIs are gone.
    const legacy = await api('POST', `/push/${P}/fcm/fcm/send`, { to: dev.token });
    expect(legacy.status).toBe(404);
    expect(legacy.body.hint).toMatch(/HTTP v1/);
    expect((await api('POST', `/push/${P}/fcm/batch`, {})).status).toBe(404);
  });

  it('bad JWT signature: lax issues a token with a warning, strict answers invalid_grant', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const lax = await token(sa, { key: other });
    expect(lax.status).toBe(200);
    expect(lax.body.token_type).toBe('Bearer');
    await api('PATCH', `${API}/instances/fcm`, { strict: true });
    const strict = await token(sa, { key: other });
    expect(strict.status).toBe(400);
    expect(strict.body).toEqual({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    const old = await token(sa, { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(old.status).toBe(400);
    expect(old.body.error_description).toContain('short-lived token');
    const okGoogleAud = await token(sa, { aud: 'https://oauth2.googleapis.com/token' });
    expect(okGoogleAud.status).toBe(200);
    await api('PATCH', `${API}/instances/fcm`, { strict: false });
    const wrongGrant = await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=password' });
    expect(wrongGrant.status).toBe(400);
  });

  it('topic fan-out, condition, no subscribers, validate_only', async () => {
    const d1 = (await api('POST', `${API}/devices`, { user: 'alice@push.test', platform: 'android', topics: ['sports', 'weather'] })).body;
    const d2 = (await api('POST', `${API}/devices`, { user: 'bob@push.test', platform: 'web', topics: ['sports'] })).body;
    const r = await fcm({ topic: 'sports', notification: { title: 'Goal!' } });
    expect(r.status).toBe(200);
    const rows = (await api('GET', `${API}/notifications?topic=sports`)).body;
    expect(rows.map((n: any) => n.device.id).sort()).toEqual([d1.id, d2.id].sort());
    expect(new Set(rows.map((n: any) => n.groupId)).size).toBe(1);
    const c = await fcm({ condition: "'sports' in topics && ('weather' in topics || 'tv' in topics)", notification: { title: 'Rain delay' } });
    expect(c.status).toBe(200);
    const cond = (await api('GET', `${API}/notifications?contains=rain%20delay`)).body;
    expect(cond).toHaveLength(1);
    expect(cond[0].device.id).toBe(d1.id);
    expect((await fcm({ condition: "'a' in topics && 'b' in topics && 'c' in topics && 'd' in topics && 'e' in topics && 'f' in topics" })).status).toBe(400);
    expect((await fcm({ condition: "'a' in topics &&" })).status).toBe(400);
    await fcm({ topic: 'nobody-here', notification: { title: 'Echo' } });
    const none = (await api('GET', `${API}/notifications?topic=nobody-here`)).body;
    expect(none).toHaveLength(1);
    expect(none[0].status).toBe('no_subscribers');
    const v = await fcm({ token: d1.token, notification: { title: 'dry run' } }, {}, { validate_only: true });
    expect(v.body.name).toBe('projects/pushy-app/messages/fake_message_id');
    const [dry] = (await api('GET', `${API}/notifications?contains=dry%20run`)).body;
    expect(dry.status).toBe('validated');
    expect(parseCondition("!('x' in topics)")!.test(new Set(['y']))).toBe(true);
  });

  it('Instance ID batchAdd / batchRemove', async () => {
    const d = (await api('POST', `${API}/devices`, { user: 'alice@push.test', platform: 'android' })).body;
    const add = await api('POST', `/push/${P}/fcm/iid/v1:batchAdd`, { to: '/topics/deals', registration_tokens: [d.token, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'] }, { authorization: `Bearer ${access}`, access_token_auth: 'true' });
    expect(add.status).toBe(200);
    expect(add.body.results[0]).toEqual({});
    expect((await api('GET', `${API}/devices/${d.id}`)).body.topics).toContain('deals');
    const rm = await api('POST', `/push/${P}/fcm/iid/v1:batchRemove`, { to: '/topics/deals', registration_tokens: [d.token] }, { authorization: `Bearer ${access}`, access_token_auth: 'true' });
    expect(rm.body.results).toEqual([{}]);
    expect((await api('GET', `${API}/devices/${d.id}`)).body.topics).not.toContain('deals');
    expect((await api('POST', `/push/${P}/fcm/iid/v1:batchAdd`, { to: '/topics/deals', registration_tokens: [d.token] })).status).toBe(401);
  });

  it('unknown tokens: accept auto-creates an unassigned device, reject answers UNREGISTERED', async () => {
    const tok = `unknownDevice123456789:APA91b${'q'.repeat(60)}`;
    expect((await fcm({ token: tok, notification: { title: 'who?' } })).status).toBe(200);
    const devs = (await api('GET', `${API}/devices?user=unassigned`)).body;
    expect(devs.find((d: any) => d.token === tok)).toBeTruthy();
    const [n] = (await api('GET', `${API}/notifications?contains=who`)).body;
    expect(n.lint.map((l: any) => l.check)).toContain('push.unknown-token');
    await api('PATCH', `${API}/instances/fcm`, { config: { unknownTokens: 'reject' } });
    const r = await fcm({ token: `another123456789012345:APA91b${'r'.repeat(60)}`, notification: { title: 'x' } });
    expect(r.status).toBe(404);
    expect(r.body.error.details[0].errorCode).toBe('UNREGISTERED');
    await api('PATCH', `${API}/instances/fcm`, { config: { unknownTokens: 'accept' } });
  });

  it('fault rules count down; X-Hub-Scenario for one request; quota has Retry-After', async () => {
    const d = (await api('POST', `${API}/devices`, { user: 'bob@push.test', platform: 'android' })).body;
    const rule = await api('POST', `${API}/faults`, { fault: 'quota:7', user: 'bob@push.test', times: 2 });
    expect(rule.status).toBe(201);
    for (let i = 0; i < 2; i++) {
      const r = await fcm({ token: d.token, notification: { title: 'q' } });
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('7');
      expect(r.body.error).toMatchObject({ status: 'RESOURCE_EXHAUSTED', details: expect.arrayContaining([{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'QUOTA_EXCEEDED' }]) });
    }
    expect((await fcm({ token: d.token, notification: { title: 'q' } })).status).toBe(200);
    const faults = (await api('GET', `${API}/faults`)).body;
    expect(faults[0]).toMatchObject({ remaining: 0, hits: 2 });
    const one = await fcm({ token: d.token, notification: { title: 'x' } }, { 'x-hub-scenario': 'unavailable' });
    expect(one.status).toBe(503);
    expect(one.body.error.details[0].errorCode).toBe('UNAVAILABLE');
    const drop = await fcm({ token: d.token, notification: { title: 'dropped one' } }, { 'x-hub-scenario': 'drop' });
    expect(drop.status).toBe(200);
    expect((await api('GET', `${API}/notifications?contains=dropped%20one`)).body[0].status).toBe('dropped');
    const t0 = Date.now();
    const timeout = await fetch(send, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', 'x-hub-scenario': 'timeout' }, body: JSON.stringify({ message: { token: d.token } }) }).catch((e) => e);
    expect(timeout).toBeInstanceOf(Error);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect((await api('DELETE', `${API}/faults`)).body.deleted).toBeGreaterThan(0);
  });

  it('collapse key marks the older notification collapsed; badge stored on the device', async () => {
    const d = (await api('POST', `${API}/devices`, { user: 'alice@push.test', platform: 'android' })).body;
    await fcm({ token: d.token, notification: { title: 'Score 1-0' }, android: { collapse_key: 'score', notification: { notification_count: 3 } } });
    await fcm({ token: d.token, notification: { title: 'Score 2-0' }, android: { collapse_key: 'score' } });
    const rows = (await api('GET', `${API}/notifications?device=${d.id}`)).body;
    expect(rows.map((n: any) => [n.title, n.status])).toEqual([
      ['Score 2-0', 'delivered'],
      ['Score 1-0', 'collapsed'],
    ]);
    expect((await api('GET', `${API}/devices/${d.id}`)).body.badge).toBe(3);
  });

  it('run isolation: run devices only get run sends; purge removes them', async () => {
    const run = await api('POST', `/api/projects/${P}/runs`, { key: 'r1' });
    expect(run.status).toBe(201);
    const rd = (await api('POST', `${API}/devices?run=r1`, { platform: 'android', topics: ['runtopic'], name: 'run phone' })).body;
    const pd = (await api('POST', `${API}/devices`, { platform: 'android', topics: ['runtopic'], name: 'project phone' })).body;
    expect(rd.run).toBe('r1');
    // Another run's send to the topic does not reach the r1 device.
    await api('POST', `/api/projects/${P}/runs`, { key: 'r2' });
    await api('POST', `/run/r2/push/${P}/fcm/v1/projects/pushy-app/messages:send`, { message: { topic: 'runtopic', notification: { title: 'from r2' } } }, { authorization: `Bearer ${access}` });
    const r2rows = (await api('GET', `${API}/notifications?contains=from%20r2`)).body;
    expect(r2rows.map((n: any) => n.device.id)).toEqual([pd.id]);
    expect(r2rows[0].run).toBe('r2');
    await fcm({ token: rd.token, notification: { title: 'run push' } });
    expect((await api('GET', `${API}/notifications?run=r1`)).body.map((n: any) => n.title)).toEqual(['run push']);
    await api('POST', `/api/projects/${P}/runs/r1/stop`);
    await api('DELETE', `/api/projects/${P}/runs/r1`);
    expect((await api('GET', `${API}/devices/${rd.id}`)).status).toBe(404);
  });

  it('wait long-poll returns the push sent after the cursor', async () => {
    const d = (await api('POST', `${API}/devices`, { user: 'alice@push.test', platform: 'ios' })).body;
    const { body: c } = await api('GET', `${API}/notifications/cursor?user=alice@push.test`);
    const waiting = api('GET', `${API}/notifications/wait?user=alice@push.test&after=${c.cursor}&timeout=5`);
    await new Promise((r) => setTimeout(r, 150));
    await fcm({ token: d.token, apns: { payload: { aps: { alert: { title: 'Ping', body: 'from iOS' }, badge: 1 } } } });
    const w = await waiting;
    expect(w.status).toBe(200);
    expect(w.body.timedOut).toBe(false);
    expect(w.body.notifications[0]).toMatchObject({ title: 'Ping', body: 'from iOS', badge: 1 });
    expect(w.headers.get('x-stubyard-cursor')).toBe(w.body.cursor);
    const none = await api('GET', `${API}/notifications/wait?user=alice@push.test&after=${w.body.cursor}&timeout=0.3`);
    expect(none.body).toMatchObject({ timedOut: true, notifications: [] });
    const two = api('GET', `${API}/notifications/wait?device=${d.id}&after=${w.body.cursor}&count=2&timeout=5`);
    await fcm({ token: d.token, notification: { title: 'one' } });
    await fcm({ token: d.token, notification: { title: 'two' } });
    expect((await two).body.notifications.map((n: any) => n.title)).toEqual(['one', 'two']);
  });

  it('host mode: requests for fcm.googleapis.com / oauth2.googleapis.com reach the right instance', async () => {
    const raw = (p: string, host: string, body: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const u = new URL(base);
        const r = http.request({ host: u.hostname, port: u.port, path: p, method: 'POST', headers: { host, 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(t) }));
        });
        r.on('error', reject);
        r.end(body);
      });
    const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(sa, { aud: 'https://oauth2.googleapis.com/token' }) }).toString();
    const t = await raw('/token', 'oauth2.googleapis.com', form, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(t.status).toBe(200);
    const d = (await api('POST', `${API}/devices`, { user: 'alice@push.test', platform: 'android' })).body;
    const s = await raw('/v1/projects/pushy-app/messages:send', 'fcm.googleapis.com', JSON.stringify({ message: { token: d.token, notification: { title: 'host mode' } } }), { authorization: `Bearer ${t.body.access_token}`, 'content-type': 'application/json' });
    expect(s.status).toBe(200);
    expect(s.body.name).toMatch(/^projects\/pushy-app\/messages\//);
    expect((await api('GET', `${API}/notifications?contains=host%20mode`)).body).toHaveLength(1);
  });

  it('MCP tools: register a device, wait for a push', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { accept: 'application/json, text/event-stream' });
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      const json = typeof r.body === 'string' ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) : r.body;
      return JSON.parse(json.result.content[0].text);
    };
    const dev = await call('register_push_device', { project: P, user: 'bob@push.test', platform: 'android', topics: ['mcp'] });
    expect(dev.token).toBeTruthy();
    await fcm({ token: dev.token, notification: { title: 'via MCP' } });
    const w = await call('wait_for_push', { project: P, device: dev.token, contains: 'via MCP', timeout_seconds: 3 });
    expect(w.timedOut).toBe(false);
    expect(w.notifications[0].title).toBe('via MCP');
    const f = await call('set_push_fault', { project: P, fault: 'internal', token: dev.token, times: 1 });
    expect(f.fault).toBe('internal');
    expect((await fcm({ token: dev.token, notification: { title: 'x' } })).status).toBe(500);
    expect((await call('set_push_fault', { project: P, fault: 'none' })).deleted).toBeGreaterThanOrEqual(0);
  });

  it('reset keeps instances and registered devices; export / import round trip regenerates keys', async () => {
    const before = (await api('GET', `${API}/devices`)).body.filter((d: any) => !d.auto).length;
    await api('POST', `${API}/faults`, { fault: 'drop', topic: 'sports' });
    expect((await api('POST', `/api/projects/${P}/reset`)).status).toBe(200);
    expect((await api('GET', `${API}/notifications`)).body).toHaveLength(0);
    const after = (await api('GET', `${API}/devices`)).body;
    expect(after.every((d: any) => !d.auto)).toBe(true);
    expect(after.length).toBe(before);
    const exp = (await api('GET', `/api/projects/${P}/export`)).body;
    expect(JSON.stringify(exp)).not.toContain('PRIVATE KEY');
    expect(exp.sections?.pushInstances ?? exp.pushInstances).toBeTruthy();
    const imp = await api('POST', '/api/projects/import', { json: exp, slug: 'pushy-copy' });
    expect(imp.status).toBe(201);
    expect((imp.body.warnings as string[]).join(' ')).toContain('Push instance "fcm"');
    const insts = (await api('GET', '/api/projects/pushy-copy/push/instances')).body;
    expect(insts[0].config).toMatchObject({ fcmProjectId: 'pushy-app', hasPrivateKey: true });
    const sa2 = (await api('GET', '/api/projects/pushy-copy/push/instances/fcm/service-account.json')).body;
    expect(sa2.private_key).not.toBe(sa.private_key);
    const devs2 = (await api('GET', '/api/projects/pushy-copy/push/devices')).body;
    expect(devs2.length).toBeGreaterThan(0);
    expect(devs2.every((d: any) => d.user)).toBe(true);
    expect((await api('GET', '/api/projects/pushy-copy/push/faults')).body.map((f: any) => f.fault)).toContain('drop');
  });
});

describe('push: migration 22 on a v19 database', () => {
  it('adds the push tables to an existing database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-push-mig-'));
    const db = new DB(path.join(dir, 'old.db'));
    db.exec('PRAGMA foreign_keys = ON');
    const { migrations } = await import('../src/db/migrations.js');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version <= 19)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    }
    db.prepare("INSERT INTO projects (id, slug, name, settings, created_at, updated_at) VALUES ('p1', 'old', 'Old', '{}', 'x', 'x')").run();
    migrate(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'push_%'").all() as { name: string }[]).map((t) => t.name).sort();
    expect(tables).toEqual(['push_devices', 'push_instances', 'push_notifications', 'push_rules']);
    db.prepare("INSERT INTO push_instances (id, project_id, slug, name, preset, created_at) VALUES ('i1', 'p1', 'fcm', 'F', 'fcm', 'x')").run();
    db.exec("DELETE FROM projects WHERE id = 'p1'");
    expect((db.prepare('SELECT COUNT(*) AS n FROM push_instances').get() as { n: number }).n).toBe(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('push: instance URL origin', () => {
  it('injected (MCP) requests use the hub base, not localhost:80; a real socket request keeps its own host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-push-origin-'));
    const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir: dir, webDir: path.join(dir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, apnsPort: 0 });
    const logger = pino({ level: 'silent' });
    const h = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger });
    const { app } = await buildApp(h, logger);
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const own = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
      expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Orig', slug: 'orig' } })).statusCode).toBe(201);
      const created = await app.inject({ method: 'POST', url: '/api/projects/orig/push/instances', payload: { preset: 'fcm', config: { fcmProjectId: 'orig-app' } } });
      expect(created.statusCode).toBe(201);
      const injected = JSON.stringify(created.json());
      expect(injected).toContain(hostHttpBase(h.config) + '/push/orig/');
      expect(injected).not.toContain('localhost:80/');
      const real = await fetch(`${own}/api/projects/orig/push/instances/fcm`);
      expect(JSON.stringify(await real.json())).toContain(own + '/push/orig/');
    } finally {
      await h.mcpTester.closeAll();
      await app.close();
      h.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
