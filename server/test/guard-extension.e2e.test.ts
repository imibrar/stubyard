import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/** The API guard lets the walkthrough extension (Origin chrome-extension://<id>) write, and nothing else new. */

type Started = { hub: Hub; app: Awaited<ReturnType<typeof buildApp>>['app']; dataDir: string };

async function start(overrides: Partial<Config> = {}): Promise<Started> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-guard-ext-'));
  const config = loadConfig({ host: '127.0.0.1', httpPort: 0, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, allowedHosts: [], ...overrides });
  const hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
  const { app } = await buildApp(hub, pino({ level: 'silent' }));
  await app.ready();
  return { hub, app, dataDir };
}

async function stop(s: Started) {
  await s.app.close();
  s.hub.db.close();
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

let n = 0;
const createProject = (s: Started, headers: Record<string, string>) =>
  s.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { host: 'localhost:4000', 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ name: `Guard ${++n}` }),
  });

describe('API guard: browser-extension origins', () => {
  describe('default (chrome-extension://*)', () => {
    let s: Started;
    beforeAll(async () => {
      s = await start({ extensionOrigins: ['chrome-extension://*'] });
    });
    afterAll(() => stop(s));

    it('lets a chrome-extension origin write, even with Sec-Fetch-Site: cross-site', async () => {
      expect((await createProject(s, { origin: 'chrome-extension://x' })).statusCode).toBe(201);
      expect((await createProject(s, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'sec-fetch-site': 'cross-site' })).statusCode).toBe(201);
    });

    it('still blocks web pages, null origins, unknown hosts and non-JSON bodies', async () => {
      expect((await createProject(s, { origin: 'http://evil.test' })).statusCode).toBe(403);
      expect((await createProject(s, { origin: 'null' })).statusCode).toBe(403);
      expect((await createProject(s, { origin: 'chrome-extension://x/../evil' })).statusCode).toBe(403);
      expect((await createProject(s, { origin: 'moz-extension://x' })).statusCode).toBe(403);
      expect((await createProject(s, { origin: 'chrome-extension://x', host: 'evil.test' })).statusCode).toBe(403);
      const form = await s.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { host: 'localhost:4000', origin: 'chrome-extension://x', 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'name=x',
      });
      expect(form.statusCode).toBe(415);
    });

    it('adds no CORS headers', async () => {
      const r = await createProject(s, { origin: 'chrome-extension://x' });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('pinned to one extension id', () => {
    let s: Started;
    beforeAll(async () => {
      s = await start({ extensionOrigins: ['chrome-extension://goodid'] });
    });
    afterAll(() => stop(s));

    it('allows only that id', async () => {
      expect((await createProject(s, { origin: 'chrome-extension://goodid' })).statusCode).toBe(201);
      expect((await createProject(s, { origin: 'chrome-extension://otherid' })).statusCode).toBe(403);
    });
  });

  describe("STUBYARD_EXTENSION_ORIGINS=''", () => {
    let s: Started;
    const saved = process.env.STUBYARD_EXTENSION_ORIGINS;
    beforeAll(async () => {
      process.env.STUBYARD_EXTENSION_ORIGINS = '';
      try {
        s = await start();
      } finally {
        if (saved === undefined) delete process.env.STUBYARD_EXTENSION_ORIGINS;
        else process.env.STUBYARD_EXTENSION_ORIGINS = saved;
      }
    });
    afterAll(() => stop(s));

    it('turns the exception off', async () => {
      expect(s.hub.config.extensionOrigins).toEqual([]);
      expect((await createProject(s, { origin: 'chrome-extension://x' })).statusCode).toBe(403);
      expect((await createProject(s, {})).statusCode).toBe(201); // curl-style calls (no Origin) still work
    });
  });

  it('reads the env list (lower-cased, trailing slash dropped) and defaults to chrome-extension://*', () => {
    const saved = process.env.STUBYARD_EXTENSION_ORIGINS;
    try {
      delete process.env.STUBYARD_EXTENSION_ORIGINS;
      expect(loadConfig().extensionOrigins).toEqual(['chrome-extension://*']);
      process.env.STUBYARD_EXTENSION_ORIGINS = ' chrome-extension://ABC/ , chrome-extension://def';
      expect(loadConfig().extensionOrigins).toEqual(['chrome-extension://abc', 'chrome-extension://def']);
    } finally {
      if (saved === undefined) delete process.env.STUBYARD_EXTENSION_ORIGINS;
      else process.env.STUBYARD_EXTENSION_ORIGINS = saved;
    }
  });
});
