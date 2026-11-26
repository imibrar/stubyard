/**
 * The @stubyard/client verdict helpers (packages/client/src/runs.ts, A2 S4) against a real stubyard: startRun with
 * expectations, expectations / setExpectations, verdict (saved and ad-hoc), assertPass, junit, stop with settle.
 * No Mailpit needed: SMS only (an in-memory hub like runs-verdict-api.e2e.test.ts).
 */
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
let mod: any;

async function j(method: string, p: string, body?: unknown): Promise<number> {
  const r = await fetch(apiUrl + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  await r.text();
  return r.status;
}

const sms = async (key: string, to: string, body: string) => {
  const r = await fetch(`${apiUrl}/run/${key}/mock/sdk/sms/2010-04-01/Accounts/ACtest/Messages.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: '+15550001111', Body: body }).toString(),
  });
  await r.text();
  return r.status;
};

describe('@stubyard/client verdict helpers (A2 S4)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-verdict-sdk-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0, callbackDelayMs: 100 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    hub.scheduler.start(30);
    close = async () => {
      await hub.scheduler.stop();
      await app.close();
      hub.db.close();
    };
    apiUrl = `http://127.0.0.1:${httpPort}`;
    expect(await j('POST', '/api/projects', { name: 'Sdk' })).toBe(201);
    expect(await j('POST', '/api/projects/sdk/providers', { preset: 'twilio', slug: 'sms' })).toBe(201);
    // Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
    mod = await import(new URL('../../packages/client/src/runs.ts', import.meta.url).pathname);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('start with expectations → verdict pass, assertPass, ad-hoc verdict, junit, stop with settle → frozen verdict', async () => {
    const run = await mod.startRun({ apiUrl, project: 'sdk', key: 'v1', users: [{ role: 'customer' }], expectations: [{ kind: 'message', channel: 'sms', to: 'customer', otp: true, count: 1 }] });
    const saved = await run.expectations();
    expect(saved).toMatchObject({ items: [{ kind: 'message', channel: 'sms', count: 1 }], defaults: true });

    expect(await sms('v1', run.user('customer').phone, 'Your code is 482913')).toBe(201);
    const v = await run.verdict({ settleSeconds: 2 });
    expect(v).toMatchObject({ verdict: 'pass', frozen: false, run: { key: 'v1', status: 'active' } });
    expect(v.items.find((i: any) => i.id === 'e1').status).toBe('pass');
    expect((await run.assertPass()).verdict).toBe('pass');

    // Ad-hoc expectations: POSTed, evaluated, not saved; assertPass names the failed item.
    const adhoc = await run.verdict({ expectations: [{ kind: 'message', channel: 'sms', count: 3, name: 'three texts' }] });
    expect(adhoc.verdict).toBe('fail');
    await expect(run.assertPass({ expectations: { items: [{ kind: 'message', channel: 'sms', count: 3, name: 'three texts' }], defaults: false } })).rejects.toThrow(
      /verdict is fail[\s\S]*\[fail\] three texts \(e1\): expected/,
    );
    expect(await run.expectations()).toEqual(saved);

    // setExpectations: append adds an item; the saved doc now fails until replaced.
    const appended = await run.setExpectations([{ kind: 'message', channel: 'sms', count: 2, name: 'two texts' }], { append: true });
    expect(appended.items).toHaveLength(2);
    await expect(run.assertPass()).rejects.toThrow(/two texts/);
    expect((await run.setExpectations({ items: saved.items })).items).toHaveLength(1);
    expect((await run.assertPass()).verdict).toBe('pass');

    const xml = await run.junit({ settleSeconds: 0 });
    expect(xml).toMatch(/^<\?xml/);
    expect(xml).toContain('<testcase');

    const stopped = await run.stop({ settleSeconds: 2 });
    expect(stopped.report.verdict).toMatchObject({ verdict: 'pass', frozen: true });
    expect(stopped.verdictUrl).toMatch(new RegExp(`/runs/${run.id}/verdict$`));
    const frozen = await run.verdict();
    expect(frozen).toEqual(stopped.report.verdict);
    await expect(run.setExpectations([])).rejects.toThrow(/409/);
  });

  it('stopRun / getRunVerdict / assertRunPass by key', async () => {
    const run = await mod.startRun({ apiUrl, project: 'sdk', key: 'v2', expectations: { items: [{ kind: 'message', count: 1 }], defaults: false } });
    await expect(mod.assertRunPass({ apiUrl, project: 'sdk', run: 'v2' })).rejects.toThrow(/Run "v2" verdict is fail/);
    expect((await mod.getRunVerdict({ apiUrl, project: 'sdk', run: 'v2', expectations: [{ kind: 'message', count: 0 }] })).verdict).toBe('pass');
    const stopped = await mod.stopRun({ apiUrl, project: 'sdk', run: run.key, settleSeconds: 0, purge: true });
    expect(stopped.report.verdict).toMatchObject({ verdict: 'fail', frozen: true });
  });
});
