import crypto from 'node:crypto';
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

/** @stubyard/client/push against a running stubyard: device, cursor, waitForPush, faults, open, service account. */

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
let apiUrl: string;
let dataDir: string;
// Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
let c: any;

describe('@stubyard/client/push', () => {
  beforeAll(async () => {
    c = await import(new URL('../../packages/client/src/push.ts', import.meta.url).pathname);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-push-sdk-'));
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
    apiUrl = `http://127.0.0.1:${httpPort}`;
    const post = (p: string, b: unknown) => fetch(apiUrl + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/projects', { name: 'SDK', slug: 'sdk' });
    await post('/api/projects/sdk/users', { name: 'Alice', email: 'alice@sdk.test' });
    await post('/api/projects/sdk/push/instances', { preset: 'fcm' });
    await post('/api/projects/sdk/push/instances', { preset: 'apns', config: { bundleIds: ['com.sdk.app'] } });
  });
  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('registerDevice → send through FCM → waitForPush → openPush', async () => {
    const o = { apiUrl, project: 'sdk' };
    const phone = await c.registerDevice({ ...o, user: 'alice@sdk.test', platform: 'android', topics: ['a'] });
    expect(phone.instance.slug).toBe('fcm');
    const sa = await c.fcmServiceAccount(o);
    expect(sa.token_uri).toBe(`${apiUrl}/push/sdk/fcm/token`);
    const cursor = await c.pushCursor({ ...o, user: 'alice@sdk.test' });
    // The app's side: a signed JWT grant for the access token, as every Google SDK does.
    const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri, iat: now, exp: now + 3600 })}`;
    const assertion = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key).toString('base64url')}`;
    const tok = await fetch(sa.token_uri, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) }).then((r) => r.json());
    const access = tok.access_token;
    const waiting = c.waitForPush({ ...o, user: 'alice@sdk.test', after: cursor, title: 'Hi', timeoutMs: 5000 });
    await fetch(sa.token_uri.replace('/token', `/v1/projects/${sa.project_id}/messages:send`), {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: phone.token, notification: { title: 'Hi', body: 'there' }, webpush: { fcm_options: { link: 'https://app.test/chat/1' } } } }),
    });
    const [n] = await waiting;
    expect(n).toMatchObject({ title: 'Hi', body: 'there', user: { name: 'Alice' } });
    const tap = await c.openPush({ ...o, id: n.id });
    expect(tap.tap).toEqual({ kind: 'link', value: 'https://app.test/chat/1' });
    expect((await c.listPushes({ ...o, device: phone.id })).length).toBe(1);
    await expect(c.waitForPush({ ...o, user: 'alice@sdk.test', after: n.id, timeoutMs: 300 })).rejects.toThrow(/No matching push/);
    expect((await c.subscribeTopic({ ...o, device: phone.id, add: ['b'], remove: ['a'] })).topics).toEqual(['b']);
    expect((await c.unregisterDevice({ ...o, device: phone.id })).state).toBe('unregistered');
    expect((await c.unregisterDevice({ ...o, device: phone.id, reRegister: true })).state).toBe('active');
    const f = await c.setPushFault({ ...o, fault: 'unavailable', times: 1 });
    expect(f.remaining).toBe(1);
    expect(await c.resetPushFaults(o)).toBe(1);
    const apns = await c.apnsConfig(o);
    expect(apns.key).toContain('BEGIN PRIVATE KEY');
    expect(apns.keyId).toMatch(/^[A-Z0-9]{10}$/);
    expect(apns.bundleIds).toEqual(['com.sdk.app']);
  });
});
