import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const MAILPIT_BIN = process.env.DEVHUB_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const haveMailpit = fs.existsSync(MAILPIT_BIN);

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
let base: string;
let dataDir: string;
let smtpPort: number;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const sms = (to: string, body: string, headers: Record<string, string> = {}, prefix = '') =>
  api('POST', `${prefix}/mock/hyper/sms/2010-04-01/Accounts/ACtest/Messages.json`, form({ To: to, From: '+15550001111', Body: body }), { ...FORM, ...headers });

function mailer(user?: string) {
  return nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true, auth: user ? { user, pass: 'x' } : undefined });
}

/** A finished (non-pending) log entry. */
const logOf = (id: string) => waitFor(async () => {
  const l = (await api('GET', `/api/logs/${id}`)).body;
  return l && l.outcome !== 'pending' ? l : null;
});

describe.skipIf(!haveMailpit)('test runs / isolation', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-runs-test-'));
    const [httpPort, httpsPort, smtp, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    smtpPort = smtp;
    const config = loadConfig({
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
      callbackDelayMs: 150,
      timeoutHoldMs: 400,
      maintenanceIntervalMs: 0,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Hyper', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);
    expect((await api('POST', '/api/projects/hyper/providers', { preset: 'twilio', slug: 'sms' })).status).toBe(201);
  });

  afterAll(async () => {
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts a run with minted users, urls and header; 409 on a duplicate key and a second default run', async () => {
    const r = await api('POST', '/api/projects/hyper/runs', { key: 'w1', label: 'worker 1', users: [{ role: 'customer', count: 2 }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      key: 'w1',
      label: 'worker 1',
      status: 'active',
      urls: { mockPrefix: '/run/w1/mock/hyper', hookPrefix: '/run/w1/hook/hyper', smtpUsername: 'hyper+w1' },
      header: { 'X-Hub-Run': 'w1' },
    });
    expect(r.body.users).toHaveLength(2);
    expect(r.body.users[0]).toMatchObject({ role: 'customer', email: 'customer1.w1@hyper.test', pinned: 0, runId: r.body.id });
    expect(r.body.users[0].phone).toMatch(/^\+923009\d{6}$/);
    expect(r.body.users[0].password).toBeTruthy();
    // Minted addresses become claims.
    expect(r.body.claims).toEqual(expect.arrayContaining(['customer1.w1@hyper.test', r.body.users[0].phone]));

    expect((await api('POST', '/api/projects/hyper/runs', { key: 'w1' })).status).toBe(409);
    expect((await api('POST', '/api/projects/hyper/runs', { key: 'Bad Key!' })).status).toBe(400);

    // Minted users are hidden unless ?run= is given.
    const plain = (await api('GET', '/api/projects/hyper/users')).body as any[];
    expect(plain.some((u) => u.runId)).toBe(false);
    const scoped = (await api('GET', '/api/projects/hyper/users?run=w1')).body as any[];
    expect(scoped.slice(0, 2).map((u) => u.email)).toEqual(['customer1.w1@hyper.test', 'customer2.w1@hyper.test']);
    expect((await api('GET', '/api/projects/hyper/overview')).body.users.some((u: any) => u.runId)).toBe(false);

    // Mint more; numbering continues.
    const m = await api('POST', '/api/projects/hyper/runs/w1/users', { role: 'admin' });
    expect(m.status).toBe(201);
    expect(m.body[0].email).toBe('admin1.w1@hyper.test');

    // user=customer inside the run means the run's customer; without a run the project's.
    expect((await api('GET', '/api/projects/hyper/users/customer?run=w1')).body.email).toBe('customer1.w1@hyper.test');
    expect((await api('GET', '/api/projects/hyper/users/customer')).body.runId).toBeNull();

    const d1 = await api('POST', '/api/projects/hyper/runs', { key: 'd1', captureUnattributed: true });
    expect(d1.status).toBe(201);
    expect((await api('POST', '/api/projects/hyper/runs', { key: 'd2', captureUnattributed: true })).status).toBe(409);
    await api('DELETE', '/api/projects/hyper/runs/d1');

    const list = await api('GET', '/api/projects/hyper/runs?status=active');
    expect(list.body.map((x: any) => x.key)).toEqual(['w1']);
    expect(list.body[0].counts).toMatchObject({ users: 3, messages: 0 });
  });

  it('keeps "fail once" rules and counters per run', async () => {
    const a = (await api('POST', '/api/projects/hyper/runs', { key: 'ra', users: [{ role: 'customer' }] })).body;
    const b = (await api('POST', '/api/projects/hyper/runs', { key: 'rb', users: [{ role: 'customer' }] })).body;
    for (const k of ['ra', 'rb']) {
      const r = await api('POST', `/api/projects/hyper/users/customer/rules?run=${k}`, { channel: 'sms', action: 'fail', count: 1 });
      expect(r.status).toBe(201);
      expect(r.body.runId).toBe(k === 'ra' ? a.id : b.id);
    }
    const phoneA = a.users[0].phone;
    const phoneB = b.users[0].phone;
    const results = await Promise.all([sms(phoneA, 'a1'), sms(phoneB, 'b1')]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    await Promise.all([sms(phoneA, 'a2'), sms(phoneB, 'b2')]);

    for (const [k, phone] of [['ra', phoneA], ['rb', phoneB]] as const) {
      const msgs = (await api('GET', `/api/projects/hyper/messages?run=${k}`)).body as any[];
      expect(msgs).toHaveLength(2);
      expect(msgs.every((m) => m.to === phone)).toBe(true);
      expect(msgs.filter((m) => m.status === 'failed')).toHaveLength(1);
      const rules = (await api('GET', `/api/projects/hyper/users/customer/rules?run=${k}`)).body as any[];
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ hits: 1, active: false });
    }
    // Project rules of the project's customer are untouched / absent.
    expect((await api('GET', '/api/projects/hyper/users/customer/rules')).body).toEqual([]);
  });

  it('applies run-scoped instance rules only to that run; project instance rules still apply otherwise', async () => {
    const r = (await api('POST', '/api/projects/hyper/runs', { key: 'ia', users: [{ role: 'customer' }] })).body;
    const other = (await api('POST', '/api/projects/hyper/runs', { key: 'ib', users: [{ role: 'customer' }] })).body;
    expect((await api('POST', '/api/projects/hyper/providers/sms/rules?run=ia', { action: 'down' })).status).toBe(201);
    expect((await sms(r.users[0].phone, 'x')).status).toBe(503);
    expect((await sms(other.users[0].phone, 'x')).status).toBe(201);
    const projectUser = (await api('GET', '/api/projects/hyper/users/customer')).body;
    expect((await sms(projectUser.phone, 'x')).status).toBe(201);

    // A project rule applies to a run that has no instance rule of its own.
    expect((await api('POST', '/api/projects/hyper/providers/sms/rules', { action: 'rate_limit', count: 1 })).status).toBe(201);
    expect((await sms(other.users[0].phone, 'y')).status).toBe(429);
    // The run's own rule wins over the project's.
    await api('POST', '/api/projects/hyper/providers/sms/rules', { action: 'rate_limit', count: 1 });
    expect((await sms(r.users[0].phone, 'y')).status).toBe(503);
    await api('DELETE', '/api/projects/hyper/providers/sms/rules');
    expect((await api('GET', '/api/projects/hyper/providers/sms/rules?run=ia')).body).toHaveLength(1);
    await api('DELETE', '/api/projects/hyper/providers/sms/rules?run=ia');
  });

  it('separates API mock overrides per run (header, /run/ prefix, content claim); no-run requests get the global scenario', async () => {
    await api('POST', '/api/projects/hyper/mocks', {
      name: 'Charge',
      method: 'POST',
      path: '/charge',
      scenarios: [
        { name: 'OK', status: 200, body: '{"ok":true}' },
        { name: 'Declined', status: 402, body: '{"ok":false}' },
        { name: 'Error', status: 500, body: '{"error":true}' },
      ],
    });
    const ma = (await api('POST', '/api/projects/hyper/runs', { key: 'ma', users: [{ role: 'customer' }] })).body;
    await api('POST', '/api/projects/hyper/runs', { key: 'mb' });
    expect((await api('PATCH', '/api/projects/hyper/mocks/Charge/active-scenario?run=ma', { scenario: 'Declined' })).body).toMatchObject({ runScenario: 'Declined' });
    expect((await api('PATCH', '/api/projects/hyper/mocks/Charge/active-scenario', { scenario: 'OK' }, { 'x-hub-run': 'mb' })).status).toBe(200);
    await api('PATCH', '/api/projects/hyper/mocks/Charge/active-scenario?run=mb', { scenario: 'Error' });

    const [viaHeader, viaPrefix, viaClaim, none] = await Promise.all([
      api('POST', '/mock/hyper/api/charge', { amount: 1 }, { 'x-hub-run': 'ma' }),
      api('POST', '/run/mb/mock/hyper/api/charge', { amount: 1 }),
      api('POST', '/mock/hyper/api/charge', { amount: 1, email: ma.users[0].email }),
      api('POST', '/mock/hyper/api/charge', { amount: 1 }),
    ]);
    expect(viaHeader.status).toBe(402);
    expect(viaPrefix.status).toBe(500);
    expect(viaClaim.status).toBe(402);
    expect(none.status).toBe(200);

    const prefixLog = await logOf(viaPrefix.headers.get('x-hub-request-id')!);
    expect(prefixLog.url).toBe('/run/mb/mock/hyper/api/charge');
    expect(prefixLog.resolved).toMatchObject({ run: 'mb', runVia: 'prefix', scenarioSource: 'run' });
    expect((await logOf(viaClaim.headers.get('x-hub-request-id')!)).resolved).toMatchObject({ run: 'ma', runVia: 'claim' });
    expect((await logOf(none.headers.get('x-hub-request-id')!)).runId).toBeNull();
    expect((await api('GET', '/api/logs?project=hyper&run=ma')).body.length).toBe(2);

    const report = (await api('GET', '/api/projects/hyper/runs/ma/report')).body;
    expect(report.mocks).toEqual([{ mock: 'Charge', scenario: 'Declined', hits: 2 }]);

    // Unknown / stopped explicit run: loud 404, outcome unmatched.
    const unknown = await api('POST', '/run/zz/mock/hyper/api/charge', {});
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: 'Unknown run', run: 'zz' });
    const ul = await logOf(unknown.headers.get('x-hub-request-id')!);
    expect(ul).toMatchObject({ outcome: 'unmatched' });
    expect(ul.resolved.unknownRun).toBe('zz');
    expect((await api('POST', '/mock/hyper/api/charge', {}, { 'x-hub-run': 'nope' })).status).toBe(404);
  });

  it('attributes SMTP mail by username suffix, minted recipient, plus-tag; unknown run key → 535', async () => {
    const run = (await api('POST', '/api/projects/hyper/runs', { key: 'sm', users: [{ role: 'customer' }] })).body;
    await mailer('hyper+sm').sendMail({ from: 'app@hyper.test', to: 'customer1@hyper.test', subject: 'via username', text: 'code 111222' });
    await mailer().sendMail({ from: 'app@hyper.test', to: run.users[0].email, subject: 'to minted', text: 'code 333444' });
    await mailer('hyper').sendMail({ from: 'app@hyper.test', to: 'admin+sm@hyper.test', subject: 'plus tag', text: 'code 555666' });

    const msgs = (await waitFor(async () => {
      const r = (await api('GET', '/api/projects/hyper/messages?run=sm&channel=email')).body as any[];
      return r.length >= 3 ? r : null;
    })) as any[];
    const bySubject = Object.fromEntries(msgs.map((m) => [m.subject, m]));
    const admin = (await api('GET', '/api/projects/hyper/users/admin')).body;
    const customer1 = (await api('GET', '/api/projects/hyper/users/customer1@hyper.test')).body;
    expect(bySubject['via username'].testUserId).toBe(customer1.id);
    expect(bySubject['to minted'].testUserId).toBe(run.users[0].id);
    expect(bySubject['plus tag']).toMatchObject({ testUserId: admin.id, to: 'admin+sm@hyper.test' });
    expect(msgs.every((m) => m.runId === run.id)).toBe(true);

    const smtpLogs = (await api('GET', '/api/logs?project=hyper&run=sm&protocol=smtp')).body as any[];
    expect(smtpLogs.length).toBe(3);

    await expect(mailer('hyper+nope').sendMail({ from: 'a@hyper.test', to: 'admin@hyper.test', subject: 'x', text: 'x' })).rejects.toMatchObject({ responseCode: 535 });
    // wait with a run and no since/after: from the run start (not the 10 s lookback), so all 3 count.
    const w = await api('GET', '/api/projects/hyper/messages/wait?run=sm&channel=email&count=3&timeout=2');
    expect(w.status).toBe(200);
    expect(w.body.count).toBe(3);
  });

  it('wait?run=a never returns run b’s message; expect-none in a stays green while b receives', async () => {
    const a = (await api('POST', '/api/projects/hyper/runs', { key: 'wa', users: [{ role: 'customer' }] })).body;
    const b = (await api('POST', '/api/projects/hyper/runs', { key: 'wb', users: [{ role: 'customer' }] })).body;
    const none = api('GET', '/api/projects/hyper/messages/expect-none?run=wa&within=1');
    const waitA = api('GET', '/api/projects/hyper/messages/wait?run=wa&user=customer&timeout=1');
    await new Promise((r) => setTimeout(r, 100));
    expect((await sms(b.users[0].phone, 'your code 123456')).status).toBe(201);
    const [n, w] = await Promise.all([none, waitA]);
    expect(n.status).toBe(200);
    expect(w.status).toBe(408);
    // b's own wait sees it.
    const wb = await api('GET', '/api/projects/hyper/messages/wait?run=wb&user=customer&timeout=2');
    expect(wb.status).toBe(200);
    expect(wb.body).toMatchObject({ to: b.users[0].phone, otp: '123456', runId: b.id });
    expect(a.id).not.toBe(b.id);
  });

  it('replace:true stops and purges the old run (incl. Mailpit orphans); report frozen after stop', async () => {
    const first = (await api('POST', '/api/projects/hyper/runs', { key: 'lc', users: [{ role: 'customer' }] })).body;
    await mailer().sendMail({ from: 'app@hyper.test', to: first.users[0].email, subject: 'to purge', text: 'hello' });
    const msg = (await waitFor(async () => (await api('GET', '/api/projects/hyper/messages?run=lc')).body[0])) as any;
    expect(msg.mailpitId).toBeTruthy();
    expect((await api('GET', `/mailpit/api/v1/message/${msg.mailpitId}`)).status).toBe(200);

    const second = await api('POST', '/api/projects/hyper/runs', { key: 'lc', replace: true, users: [{ role: 'customer' }] });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.id);
    // Old run stopped, its data purged; minted address reused.
    expect(second.body.users[0].email).toBe(first.users[0].email);
    const old = (await api('GET', `/api/projects/hyper/runs/${first.id}`)).body;
    expect(old).toMatchObject({ status: 'stopped', counts: { users: 0, messages: 0, logs: 0 } });
    expect((await api('GET', `/api/messages/${msg.id}`)).status).toBe(404);
    await waitFor(async () => (await api('GET', `/mailpit/api/v1/message/${msg.mailpitId}`)).status === 404);

    // Stop: report frozen; later traffic to the (now stopped) run's users is not attributed.
    await sms(second.body.users[0].phone, 'one');
    const stop = await api('POST', '/api/projects/hyper/runs/lc/stop');
    expect(stop.status).toBe(200);
    expect(stop.body.run.status).toBe('stopped');
    expect(stop.body.report).toMatchObject({ run: { key: 'lc', status: 'stopped' }, messages: { total: 1, byChannel: { sms: 1 } } });
    await sms(second.body.users[0].phone, 'two');
    const report = (await api('GET', `/api/projects/hyper/runs/${second.body.id}/report`)).body;
    expect(report.messages.total).toBe(1);
    expect(report.run.stoppedAt).toBe(stop.body.report.run.stoppedAt);
    // Explicit use of a stopped run fails loudly.
    expect((await sms(second.body.users[0].phone, 'three', { 'x-hub-run': 'lc' })).status).toBe(404);
    // Users stay readable after a plain stop.
    expect((await api('GET', `/api/projects/hyper/runs/${second.body.id}`)).body.users).toHaveLength(1);
    expect((await api('POST', `/api/projects/hyper/runs/${second.body.id}/users`, {})).status).toBe(409);
  });

  it('stops runs past their TTL and purges stopped runs after the retention period', async () => {
    const r = (await api('POST', '/api/projects/hyper/runs', { key: 'ttl', ttlMinutes: 1, users: [{ role: 'customer' }] })).body;
    await api('POST', `/api/projects/hyper/users/customer/rules?run=ttl`, { action: 'fail' });
    const pass1 = await running.hub.maintenance.run(Date.now() + 2 * 60_000);
    expect(pass1.runs?.stopped).toBeGreaterThanOrEqual(1);
    const after = (await api('GET', `/api/projects/hyper/runs/${r.id}`)).body;
    expect(after.status).toBe('stopped');
    expect((await api('GET', `/api/projects/hyper/runs/${r.id}/report`)).body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/TTL/)]));
    // Rules gone with the stop.
    expect(running.hub.rules.listForRun(r.id)).toHaveLength(0);
    await running.hub.maintenance.run(Date.now() + 30 * 3_600_000);
    expect((await api('GET', `/api/projects/hyper/runs/${r.id}`)).status).toBe(404);
  });

  it('DELETE removes a run and reports what went; export skips run rows; reset removes runs', async () => {
    const r = (await api('POST', '/api/projects/hyper/runs', { key: 'del', users: [{ role: 'customer' }] })).body;
    await api('POST', '/api/projects/hyper/users/customer/rules?run=del', { action: 'fail' });
    await api('POST', '/api/projects/hyper/authenticators?run=del', { label: 'Run 2FA', secret: 'JBSWY3DPEHPK3PXP' });
    await sms(r.users[0].phone, 'hi');
    const exp = (await api('GET', '/api/projects/hyper/export')).body;
    const text = JSON.stringify(exp);
    expect(text).not.toContain('.del@hyper.test');
    expect(text).not.toContain('Run 2FA');
    // The label resolves inside the run only.
    expect((await api('GET', '/api/projects/hyper/authenticators/code?label=Run%202FA&run=del')).status).toBe(200);
    expect((await api('GET', '/api/projects/hyper/authenticators/code?label=Run%202FA')).status).toBe(404);

    const d = await api('DELETE', '/api/projects/hyper/runs/del');
    expect(d.body.deleted).toMatchObject({ users: 1, messages: 1, rules: 1 });
    expect(d.body.deleted.logs).toBeGreaterThanOrEqual(1);
    expect((await api('GET', '/api/projects/hyper/runs/del')).status).toBe(404);

    await api('POST', '/api/projects/hyper/runs', { key: 'rs', users: [{ role: 'customer' }] });
    await api('POST', '/api/projects/hyper/reset');
    expect((await api('GET', '/api/projects/hyper/runs')).body).toEqual([]);
    expect(running.hub.users.list(running.hub.projects.getBySlug('hyper')!.id, { all: true }).some((u) => u.runId)).toBe(false);
  });

  it('exposes the run tools over MCP', async () => {
    const call = async (name: string, args: Record<string, unknown>) =>
      (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body.result;
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t: any) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['start_run', 'mint_test_user', 'stop_run', 'get_run_report']));
    const started = await call('start_run', { project: 'hyper', key: 'mcp', users: [{ role: 'customer' }] });
    expect(started.isError).toBeUndefined();
    expect(started.structuredContent.key).toBe('mcp');
    const minted = await call('mint_test_user', { project: 'hyper', run: 'mcp', role: 'admin' });
    expect(JSON.parse(minted.content[0].text)[0].email).toBe('admin1.mcp@hyper.test');
    await sms(started.structuredContent.users[0].phone, 'code 987654');
    const got = await call('wait_for_message', { project: 'hyper', run: 'mcp', user: 'customer', timeout_seconds: 2 });
    expect(got.structuredContent.otp).toBe('987654');
    const report = await call('get_run_report', { project: 'hyper', run: 'mcp' });
    expect(report.structuredContent.messages.total).toBe(1);
    const stopped = await call('stop_run', { project: 'hyper', run: 'mcp', purge: true });
    expect(stopped.structuredContent.run.status).toBe('stopped');
  });
});
