import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { totp } from '../src/totp/totp.js';

/**
 * Setup through MCP only (docs/plans/agent-e2e-kit.md §2 gaps 5–7): add_authenticator, list_payment_gateways,
 * create_payment_instance and create_webhook_endpoint, plus the @stubyard/client tarball at GET /api/client.tgz.
 */

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

interface Running {
  hub: Hub;
  base: string;
  close: () => Promise<void>;
}

async function start(dataDir: string, extra: Record<string, unknown> = {}): Promise<Running> {
  const httpPort = await freePort();
  const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, ...extra });
  const hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  const { app } = await buildApp(hub, pino({ level: 'silent' }));
  await app.listen({ port: httpPort, host: '127.0.0.1' });
  return {
    hub,
    base: `http://127.0.0.1:${httpPort}`,
    close: async () => {
      await app.close();
      hub.db.close();
    },
  };
}

const SECRET = 'JBSWY3DPEHPK3PXP';

describe('agent setup over MCP', () => {
  let r: Running;
  let dataDir: string;
  let rpcId = 0;

  const api = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(r.base + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, body: parsed };
  };
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
    expect(res.status).toBe(200);
    return res.body.result as { content: { text: string }[]; isError?: boolean };
  };
  const mcp = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await callTool(name, args);
    expect(res.isError, `${name}: ${res.content[0].text}`).toBeFalsy();
    return JSON.parse(res.content[0].text);
  };
  const mcpError = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await callTool(name, args);
    expect(res.isError, `${name} should fail`).toBe(true);
    return res.content[0].text;
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-agent-setup-'));
    r = await start(dataDir);
    await mcp('create_project', { name: 'Shop', slug: 'shop', admins: 1, customers: 2 });
  });

  afterAll(async () => {
    await r?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the setup tools', async () => {
    const res = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} });
    const names = (res.body.result.tools as { name: string }[]).map((t) => t.name);
    for (const n of ['add_authenticator', 'list_payment_gateways', 'create_payment_instance', 'create_webhook_endpoint']) expect(names).toContain(n);
  });

  it('add_authenticator registers a base32 key for a test user and returns the current code', async () => {
    const out = await mcp('add_authenticator', { project: 'shop', user: 'admin', label: 'Admin 2FA', secret: SECRET });
    expect(out.status).toBe('created');
    expect(out.authenticator).toMatchObject({ label: 'Admin 2FA', testUserId: out.user.id, digits: 6, period: 30, algorithm: 'SHA1' });
    expect(out.authenticator.secret).toBeUndefined();
    expect(out.user.role).toBe('admin');
    const expected = totp({ secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 }, Date.now());
    expect([expected.code, totp({ secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 }, Date.now() - 30_000).code]).toContain(out.code.code);
    expect(out.code.remaining).toBeGreaterThan(0);
    // The key is linked: get_2fa_code by user finds it.
    const byUser = await mcp('get_2fa_code', { project: 'shop', user: 'admin' });
    expect(byUser.label).toBe('Admin 2FA');
  });

  it('add_authenticator reads an otpauth:// link and replaces a key with the same label for that user', async () => {
    const link = `otpauth://totp/Shop:customer1%40shop.test?secret=${SECRET}&issuer=Shop&digits=8&period=60&algorithm=SHA256`;
    const first = await mcp('add_authenticator', { project: 'shop', user: 'customer1@shop.test', otpauth: link });
    expect(first.status).toBe('created');
    expect(first.authenticator).toMatchObject({ issuer: 'Shop', account: 'customer1@shop.test', digits: 8, period: 60, algorithm: 'SHA256' });
    expect(first.code.code).toMatch(/^\d{8}$/);

    const again = await mcp('add_authenticator', { project: 'shop', user: 'customer1@shop.test', label: first.authenticator.label, secret: SECRET });
    expect(again.status).toBe('updated');
    expect(again.authenticator.id).toBe(first.authenticator.id);
    expect(again.authenticator).toMatchObject({ digits: 6, period: 30 });
    const list = (await api('GET', '/api/projects/shop/authenticators')).body.items as { testUserId: string }[];
    expect(list.filter((a) => a.testUserId === first.user.id)).toHaveLength(1);
  });

  it('add_authenticator rejects bad input with the REST message', async () => {
    expect(await mcpError('add_authenticator', { project: 'shop', user: 'admin' })).toContain('secret');
    expect(await mcpError('add_authenticator', { project: 'shop', user: 'admin', secret: SECRET, otpauth: `otpauth://totp/x?secret=${SECRET}` })).toContain('not both');
    expect(await mcpError('add_authenticator', { project: 'shop', user: 'nobody@nowhere.test', secret: SECRET })).toContain('404');
    expect(await mcpError('add_authenticator', { project: 'shop', user: 'admin', otpauth: 'otpauth://hotp/x?secret=ABC' })).toContain('400');
  });

  it('list_payment_gateways and create_payment_instance return the instance with connect.env', async () => {
    const before = await mcp('list_payment_gateways', { project: 'shop' });
    expect(before.gateways.map((g: { id: string }) => g.id)).toEqual(expect.arrayContaining(['stripe-checkout', 'paytabs', 'paypal']));
    expect(before.instances).toEqual([]);

    const out = await mcp('create_payment_instance', { project: 'shop', gateway: 'stripe-checkout', webhook_url: 'http://host.docker.internal:3000/stripe', default_outcome: 'success' });
    expect(out.instance).toMatchObject({ slug: 'stripe', gateway: 'stripe-checkout', enabled: true });
    expect(out.config.webhookUrl).toBe('http://host.docker.internal:3000/stripe');
    expect(out.connect.env.STRIPE_API_BASE_LOCAL).toMatch(/\/pay\/shop\/stripe$/);
    expect(Object.keys(out.connect.env).length).toBeGreaterThan(1);
    expect(out.problems).toEqual([]);

    const after = await mcp('list_payment_gateways', { project: 'shop' });
    expect(after.instances).toHaveLength(1);
    expect(after.instances[0]).toMatchObject({ slug: 'stripe', gateway: 'stripe-checkout' });
    expect(after.instances[0].env.STRIPE_API_BASE_LOCAL).toBe(out.connect.env.STRIPE_API_BASE_LOCAL);

    // Same REST validation.
    expect(await mcpError('create_payment_instance', { project: 'shop', gateway: 'nope' })).toContain('400');
  });

  it('create_webhook_endpoint creates a receiving endpoint and returns its URL', async () => {
    const out = await mcp('create_webhook_endpoint', {
      project: 'shop',
      path: 'orders/created',
      method: 'POST',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { status: 202, rejectInvalid: true },
    });
    expect(out.endpoint).toMatchObject({ path: 'orders/created', method: 'POST', name: 'orders/created' });
    expect(out.url).toMatch(/^http:\/\/[^/]+\/hook\/shop\/orders\/created$/);
    expect(out.url).toBe(out.endpoint.urls.http);
    expect(out.urls.fromContainers).toBe(`http://stubyard:${r.hub.config.httpPort}/hook/shop/orders/created`);

    const okHit = await fetch(`${r.base}/hook/shop/orders/created`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'o1' }) });
    expect(okHit.status).toBe(202);
    const bad = await fetch(`${r.base}/hook/shop/orders/created`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nope: 1 }) });
    expect(bad.status).toBe(400);

    expect(await mcpError('create_webhook_endpoint', { project: 'shop', path: 'orders/created', method: 'POST' })).toContain('already exists');
  });

  it('GET /api/client.tgz answers a clear 404 when this stubyard has no tarball', async () => {
    const res = await api('GET', '/api/client.tgz');
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain('npm pack -w packages/client');
  });
});

describe('GET /api/client.tgz with a tarball', () => {
  let r: Running;
  let dataDir: string;
  const bytes = gzipSync(Buffer.from('package/package.json stand-in'));

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-client-tgz-'));
    const file = path.join(dataDir, 'stubyard-client.tgz');
    fs.writeFileSync(file, bytes);
    r = await start(dataDir, { clientTarballFile: file });
  });

  afterAll(async () => {
    await r?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the file as application/gzip', async () => {
    const res = await fetch(`${r.base}/api/client.tgz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toContain('stubyard-client.tgz');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
    expect(gunzipSync(body).toString()).toBe('package/package.json stand-in');
  });
});
