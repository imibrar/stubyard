/**
 * The @devhub/client run helpers (packages/client/src/runs.ts) against a real devhub: startRun, user(), mint,
 * waitForMessage, setTimeOffset, report / reportHtml, stop, withRun (stops on throw), getRunReport, stopRun.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const MAILPIT_BIN = process.env.DEVHUB_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const enabled = fs.existsSync(MAILPIT_BIN) && process.env.DEVHUB_SDK_TESTS !== '0';

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

let running: RunningHub;
let dataDir: string;
let apiUrl: string;
let mod: any;

async function j<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(apiUrl + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let parsed: unknown = t;
  try {
    parsed = JSON.parse(t);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T };
}

describe.skipIf(!enabled)('@devhub/client run helpers', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-runs-sdk-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    running = await startHub(
      loadConfig({
        host: '127.0.0.1',
        httpPort,
        httpsPort,
        smtpPort,
        dataDir,
        webDir: path.join(dataDir, 'no-web'),
        mailpitBin: MAILPIT_BIN,
        mailpitUrl: `http://127.0.0.1:${mpHttp}`,
        mailpitSmtpHost: '127.0.0.1',
        mailpitSmtpPort: mpSmtp,
        spawnMailpit: true,
        logLevel: 'silent',
        maintenanceIntervalMs: 0,
      }),
      { logger: pino({ level: 'silent' }) },
    );
    apiUrl = `http://127.0.0.1:${httpPort}`;
    expect((await j('POST', '/api/projects', { name: 'Sdk', generateUsers: { admins: 1 } })).status).toBe(201);
    expect((await j('POST', '/api/projects/sdk/providers', { preset: 'twilio', slug: 'sms' })).status).toBe(201);
    // Dynamic import: the helper lives in the packages/client workspace (outside this tsconfig's rootDir).
    mod = await import(new URL('../../packages/client/src/runs.ts', import.meta.url).pathname);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('startRun → user() / mint / waitForMessage / setTimeOffset / report / reportHtml / stop', async () => {
    const run = await mod.startRun({ apiUrl, project: 'sdk', key: 'w1', label: 'sdk worker', users: [{ role: 'customer', count: 2 }] });
    expect(run.key).toBe('w1');
    expect(run.headers).toEqual({ 'X-Hub-Run': 'w1' });
    expect(run.urls.mockPrefix).toBe('/run/w1/mock/sdk');
    expect(run.users).toHaveLength(2);
    expect(run.user('customer').email).toBe('customer1.w1@sdk.test');
    expect(run.user('customer', 1).email).toBe('customer2.w1@sdk.test');
    expect(() => run.user('admin')).toThrow(/no admin user/);
    const [admin] = await run.mint({ role: 'admin' });
    expect(run.user('admin').id).toBe(admin.id);
    expect(run.users).toHaveLength(3);

    const c = run.user('customer');
    const sent = await fetch(`${apiUrl}/mock/sdk/sms/2010-04-01/Accounts/ACtest/Messages.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...run.headers },
      body: new URLSearchParams({ To: c.phone, From: '+15550001111', Body: 'Your code is 123456' }).toString(),
    });
    expect(sent.status).toBeLessThan(300);
    const m = await run.waitForMessage({ user: c.phone, channel: 'sms', timeoutMs: 5000 });
    expect(m.otp).toBe('123456');
    await expect(run.waitForMessage({ user: c.phone, channel: 'email', timeoutMs: 1000 })).rejects.toThrow(/within 1000 ms/);

    const t = await run.setTimeOffset('auth', '+2h');
    expect(t.run.offsets).toEqual({ auth: 7_200_000 });

    const report = await run.report();
    expect(report.messages.total).toBe(1);
    expect(report.warnings.join('\n')).toContain('Clock offsets active: auth +2h');
    const html = await run.reportHtml();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('customer1.w1@sdk.test');

    const stopped = await run.stop();
    expect(stopped.run.status).toBe('stopped');
    expect(stopped.report.users).toHaveLength(3);
    expect(stopped.reportHtmlUrl).toContain('/report.html');
    expect(await mod.getRunReport({ apiUrl, project: 'sdk', run: run.id, format: 'html' })).toContain('>stopped<');
    expect((await mod.getRunReport({ apiUrl, project: 'sdk', run: run.id })).run.status).toBe('stopped');
  });

  it('withRun stops the run when the test throws (and returns the value otherwise); stopRun', async () => {
    let id = '';
    await expect(
      mod.withRun({ apiUrl, project: 'sdk', key: 'boom' }, async (run: any) => {
        id = run.id;
        throw new Error('test failed');
      }),
    ).rejects.toThrow('test failed');
    expect((await j('GET', `/api/projects/sdk/runs/${id}`)).body.status).toBe('stopped');

    const v = await mod.withRun({ apiUrl, project: 'sdk', key: 'ok', purge: true, users: [{ role: 'admin' }] }, async (run: any) => run.user('admin').email);
    expect(v).toBe('admin1.ok@sdk.test');
    expect((await j('GET', '/api/projects/sdk/runs/ok')).body.status).toBe('stopped');

    const other = await mod.startRun({ apiUrl, project: 'sdk', key: 'manual' });
    const out = await mod.stopRun({ apiUrl, project: 'sdk', run: 'manual', purge: true });
    expect(out.run.id).toBe(other.id);
    await expect(mod.startRun({ apiUrl, project: 'sdk', key: 'Bad Key' })).rejects.toThrow(/devhub answered 400/);
  });
});
