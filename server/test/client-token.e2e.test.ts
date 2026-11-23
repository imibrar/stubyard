/**
 * @stubyard/client against a hub with sign-in on: the apiToken option and STUBYARD_TOKEN send Authorization: Bearer
 * to the hub's own origin only (packages/client/src/http.ts hubFetchFn).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createHub } from '../src/index.js';
import { adminPasswordHash } from '../src/access/password.js';

const EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let hub: ReturnType<typeof createHub>;
let dataDir: string;
let base = '';
let token = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let http: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runs: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stream: any;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-client-token-'));
  const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, admin: { email: EMAIL, passwordHash: adminPasswordHash(EMAIL, PASSWORD, '') } });
  hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  ({ app } = await buildApp(hub, pino({ level: 'silent' })));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const { csrf } = (await login.json()) as { csrf: string };
  const created = await fetch(base + '/api/auth/tokens', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-stubyard-csrf': csrf }, body: JSON.stringify({ name: 'client test' }) });
  token = ((await created.json()) as { secret: string }).secret;
  const p = await fetch(base + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Client' }) });
  expect(p.status).toBe(201);
  // Dynamic import: the helpers live in the packages/client workspace (outside this tsconfig's rootDir).
  http = await import(new URL('../../packages/client/src/http.ts', import.meta.url).pathname);
  runs = await import(new URL('../../packages/client/src/runs.ts', import.meta.url).pathname);
  stream = await import(new URL('../../packages/client/src/stream.ts', import.meta.url).pathname);
});

afterAll(async () => {
  delete process.env.STUBYARD_TOKEN;
  await app?.close();
  hub?.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('@stubyard/client with sign-in on', () => {
  it('is refused without a token, and works with apiToken', async () => {
    delete process.env.STUBYARD_TOKEN;
    await expect(http.hubJson({ apiUrl: base }, 'GET', '/api/projects')).rejects.toThrow(/401/);
    const list = await http.hubJson({ apiUrl: base, apiToken: token }, 'GET', '/api/projects');
    expect(list.map((x: { slug: string }) => x.slug)).toContain('client');
    const run = await runs.startRun({ apiUrl: base, project: 'client', apiToken: token, key: 'tok' });
    expect((await run.stop({ purge: true })).run.status).toBe('stopped');
  });

  it('reads STUBYARD_TOKEN in Node; apiToken "" sends none', async () => {
    process.env.STUBYARD_TOKEN = token;
    try {
      expect(await http.hubJson({ apiUrl: base }, 'GET', '/api/projects')).toBeInstanceOf(Array);
      await expect(http.hubJson({ apiUrl: base, apiToken: '' }, 'GET', '/api/projects')).rejects.toThrow(/401/);
    } finally {
      delete process.env.STUBYARD_TOKEN;
    }
  });

  it('streams events with the token', async () => {
    const ac = new AbortController();
    const got = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no event')), 5000);
      stream.subscribe({ apiUrl: base, project: 'client', apiToken: token }, { signal: ac.signal, types: ['ready'], onEvent: (e: { type: string }) => (clearTimeout(t), resolve(e.type)), onError: (e: unknown) => (clearTimeout(t), reject(e)) });
    });
    ac.abort();
    expect(got).toBe('ready');
  });

  it('sends the token only to the hub origin and keeps an explicit Authorization header', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fake = (async (input: string, init?: RequestInit) => {
      seen.push({ url: input, auth: new Headers(init?.headers).get('authorization') });
      return new Response('{}');
    }) as unknown as typeof fetch;
    const f = http.hubFetchFn({ apiUrl: 'http://hub.test:4000', apiToken: 'sy_x', fetch: fake });
    await f('http://hub.test:4000/api/projects', { headers: { accept: 'application/json' } });
    await f('http://other.test/api/projects');
    await f('http://hub.test:4000/api/projects', { headers: { Authorization: 'Bearer mine' } });
    expect(seen).toEqual([
      { url: 'http://hub.test:4000/api/projects', auth: 'Bearer sy_x' },
      { url: 'http://other.test/api/projects', auth: null },
      { url: 'http://hub.test:4000/api/projects', auth: 'Bearer mine' },
    ]);
    expect(http.hubFetchFn({ fetch: fake, apiToken: '' })).toBe(fake);
  });
});
