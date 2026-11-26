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

// A2 slice S7: a walkthrough finished with `run` stores the run's verdict as runCheck (REST and finish_walkthrough),
// the MCP default verdict becomes fail when the run fails, an explicit verdict wins, and finishing without a run is
// unchanged. No Mailpit needed: SMS only (an in-memory hub like runs-verdict-api.e2e.test.ts).

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
let projectId = '';

async function api<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const isForm = body instanceof URLSearchParams;
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' } : {},
    body: body === undefined ? undefined : isForm ? body.toString() : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, text };
}
const ok = async <T = any>(method: string, p: string, body?: unknown, status = 200): Promise<T> => {
  const r = await api<T>(method, p, body);
  expect(r.status, `${method} ${p}: ${r.text}`).toBe(status);
  return r.body;
};

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

let rpcId = 0;
const callTool = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.body.result as { content: { type: string; text: string }[]; isError?: boolean };
};
const mcp = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res = await callTool(name, args);
  expect(res.isError, `${name}: ${res.content[0].text}`).toBeFalsy();
  return JSON.parse(res.content[0].text);
};

const SLUG = 'checkout';
const P = `/api/projects/${SLUG}`;
const W = `${P}/walkthroughs`;
const ORIGIN = 'http://app.test:3184';

const sms = (key: string, to: string, body: string) =>
  api('POST', `/run/${key}/mock/${SLUG}/sms/2010-04-01/Accounts/ACtest/Messages.json`, new URLSearchParams({ To: to, From: '+15550001111', Body: body }));
const messagesIn = (key: string) => (hub.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id = ?').get(hub.runs.require(projectId, key).id) as { n: number }).n;

const STORYBOARD = {
  slug: 'pay',
  name: 'Pay with an OTP',
  actors: [{ key: 'buyer', role: 'customer', fresh: true }],
  steps: [
    { id: 'open', kind: 'open', title: 'Open the shop', intent: 'Start the checkout', url: '/shop' },
    { id: 'pay', kind: 'instruction', title: 'Pay', intent: 'Pay with the SMS code' },
  ],
};

/** An agent walkthrough with every step reported done. */
async function doneWalkthrough(label: string): Promise<string> {
  const w = await ok('POST', W, { storyboard: 'pay', executor: 'agent', runner: { name: 'test' }, label }, 201);
  for (const step of ['open', 'pay']) await ok('PATCH', `${W}/${w.key}/steps/${step}`, { status: 'done' });
  return w.key as string;
}

/** A run whose customer got exactly one OTP SMS (pass); `stranger` adds an unassigned SMS (default check fails). */
async function runWithTraffic(key: string, stranger = false): Promise<{ id: string; key: string }> {
  const r = await ok('POST', `${P}/runs`, { key, users: [{ role: 'customer' }], expectations: [{ name: 'one OTP to the customer', kind: 'message', channel: 'sms', to: 'customer', otp: true, count: 1 }] }, 201);
  expect((await sms(key, r.users[0].phone, 'Your code is 482913')).status).toBe(201);
  if (stranger) expect((await sms(key, '+15550009999', 'Hello stranger')).status).toBe(201);
  await waitFor(() => messagesIn(key) >= (stranger ? 2 : 1));
  return { id: r.id, key };
}

describe('walkthrough run check (A2 S7)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-wt-runcheck-'));
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
    base = `http://127.0.0.1:${httpPort}`;
    projectId = (await ok('POST', '/api/projects', { name: 'Checkout', slug: SLUG }, 201)).id;
    await ok('PATCH', P, { settings: { appOrigins: [ORIGIN] } });
    await ok('POST', `${P}/providers`, { preset: 'twilio', slug: 'sms' }, 201);
    await ok('PUT', `${P}/storyboards/pay`, STORYBOARD, 201);
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('finish_walkthrough lists the run input', async () => {
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} })).body.result.tools as { name: string; inputSchema: any }[];
    expect(tools.find((t) => t.name === 'finish_walkthrough')!.inputSchema.properties.run).toMatchObject({ type: 'string' });
  });

  it('REST finish with run: the passing verdict is stored as runCheck and shown by get, summary and the HTML report', async () => {
    const run = await runWithTraffic('rc1');
    const wt = await doneWalkthrough('rest pass');
    const w = await ok('POST', `${W}/${wt}/finish`, { verdict: 'pass', run: 'rc1' });
    expect(w).toMatchObject({ status: 'finished', signoff: { verdict: 'pass', verdictBy: 'agent' }, runCheck: { runId: run.id, key: 'rc1', verdict: 'pass', failed: [] } });
    expect(typeof w.runCheck.summary).toBe('string');
    expect(Object.keys(w.runCheck).sort()).toEqual(['failed', 'key', 'runId', 'summary', 'verdict']);

    // Stored: get and summary read it back; the run id works as well as the key.
    expect((await ok('GET', `${W}/${wt}`)).runCheck).toEqual(w.runCheck);
    expect((await ok('GET', `${W}/${wt}/summary`)).runCheck).toEqual(w.runCheck);
    const row = hub.db.prepare('SELECT run_check FROM walkthroughs WHERE key = ?').get(wt) as { run_check: string };
    expect(JSON.parse(row.run_check)).toEqual(w.runCheck);
    const html = await api('GET', `${W}/${wt}/summary.html`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('Test run');
    expect(html.text).toContain('rc1');

    // Reopen clears it; finishing again by run id stores it again.
    expect((await ok('POST', `${W}/${wt}/reopen`, {})).runCheck).toBeNull();
    const again = await ok('POST', `${W}/${wt}/finish`, { verdict: 'pass', run: run.id });
    expect(again.runCheck).toMatchObject({ runId: run.id, key: 'rc1', verdict: 'pass' });
  });

  it('MCP finish without a verdict: fail when the run verdict fails, with the failed items', async () => {
    await runWithTraffic('rc2', true);
    const wt = await doneWalkthrough('mcp default');
    const res = await mcp('finish_walkthrough', { project: SLUG, walkthrough: wt, run: 'rc2' });
    expect(res).toMatchObject({ status: 'finished', signoff: { verdict: 'fail', verdictBy: 'agent' }, runCheck: { key: 'rc2', verdict: 'fail' } });
    expect(res.runCheck.failed.map((f: any) => f.id)).toContain('default:unassignedMessages');
    for (const f of res.runCheck.failed) expect(typeof f.message).toBe('string');
    expect((await ok('GET', `${W}/${wt}`)).runCheck).toEqual(res.runCheck);
  });

  it('MCP finish: the default stays pass when the run passes, and an explicit verdict wins over a failing run', async () => {
    await runWithTraffic('rc3');
    const passing = await mcp('finish_walkthrough', { project: SLUG, walkthrough: await doneWalkthrough('mcp pass'), run: 'rc3' });
    expect(passing).toMatchObject({ signoff: { verdict: 'pass' }, runCheck: { verdict: 'pass' } });

    await runWithTraffic('rc4', true);
    const explicit = await mcp('finish_walkthrough', { project: SLUG, walkthrough: await doneWalkthrough('mcp explicit'), run: 'rc4', verdict: 'pass' });
    expect(explicit).toMatchObject({ signoff: { verdict: 'pass' }, runCheck: { verdict: 'fail' } });
  });

  it('a stopped and purged run gives its frozen verdict', async () => {
    await runWithTraffic('rc5', true);
    await ok('POST', `${P}/runs/rc5/stop?purge=1`, {});
    const w = await ok('POST', `${W}/${await doneWalkthrough('stopped run')}/finish`, { verdict: 'partial', run: 'rc5' });
    expect(w).toMatchObject({ signoff: { verdict: 'partial' }, runCheck: { key: 'rc5', verdict: 'fail' } });
  });

  it('a bad or unknown run is rejected and leaves the walkthrough active', async () => {
    const wt = await doneWalkthrough('bad run');
    const bad = await api('POST', `${W}/${wt}/finish`, { verdict: 'pass', run: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/run/);
    expect((await api('POST', `${W}/${wt}/finish`, { verdict: 'pass', run: '' })).status).toBe(400);
    const unknown = await api('POST', `${W}/${wt}/finish`, { verdict: 'pass', run: 'nope' });
    expect(unknown.status).toBe(404);
    expect((await ok('GET', `${W}/${wt}`)).status).toBe('active');
  });

  it('finish without a run is unchanged: runCheck null', async () => {
    const wt = await doneWalkthrough('no run');
    const w = await ok('POST', `${W}/${wt}/finish`, { verdict: 'pass' });
    expect(w).toMatchObject({ status: 'finished', signoff: { verdict: 'pass' }, runCheck: null });
    const res = await mcp('finish_walkthrough', { project: SLUG, walkthrough: await doneWalkthrough('no run mcp') });
    expect(res).toMatchObject({ signoff: { verdict: 'pass' }, runCheck: null });
    expect((await ok('GET', `${W}/${wt}/summary`)).runCheck).toBeNull();
  });
});
