import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import type { Run } from '../src/repos/runs.js';
import { parseExpectations } from '../src/runs/expectations.js';
import type { RunReport } from '../src/runs/report.js';
import type { RunVerdict } from '../src/runs/verdict.js';

// No Mailpit needed: SMS, WhatsApp, payments and webhooks only (an in-memory hub like payments.e2e.test.ts).

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
let appServer: http.Server;
let appUrl: string;
let failNext = 0;
let stripeKey = '';
const received: { path: string; body: string }[] = [];

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const isForm = body instanceof URLSearchParams;
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isForm ? body.toString() : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const P = '/api/projects/hyper';
const sms = (key: string, to: string, body: string, headers: Record<string, string> = {}) =>
  api('POST', `/run/${key}/mock/hyper/sms/2010-04-01/Accounts/ACtest/Messages.json`, new URLSearchParams({ To: to, From: '+15550001111', Body: body }), headers);
const waTemplate = (key: string, to: string, name: string) =>
  api('POST', `/run/${key}/mock/hyper/wa/v21.0/123456/messages`, { messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template', template: { name, language: { code: 'en_US' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'A-17' }] }] } });

async function startRun(key: string, extra: Record<string, unknown> = {}): Promise<{ run: Run; users: any[] }> {
  const r = await api('POST', `${P}/runs`, { key, users: [{ role: 'customer' }], ...extra });
  expect(r.status, r.text).toBe(201);
  return { run: hub.runs.require(r.body.projectId, key), users: r.body.users };
}
let projectId = '';
const runOf = (key: string) => hub.runs.require(projectId, key);
const messagesIn = (run: Run) => (hub.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id = ?').get(run.id) as { n: number }).n;
const verdict = (key: string, items: unknown, opts: { settleMs?: number } = {}) => hub.runs.verdict(runOf(key), { ...opts, expectations: parseExpectations(items) });
const item = (v: RunVerdict, id: string) => v.items.find((i) => i.id === id)!;

/** A Stripe Checkout session in the run, paid on the hosted page (webhooks delivered inline). */
async function stripePaid(key: string, unitAmount: number, currency = 'sar') {
  const form = new URLSearchParams({
    mode: 'payment',
    success_url: `${appUrl}/ok`,
    cancel_url: `${appUrl}/cancel`,
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(unitAmount),
    'line_items[0][price_data][product_data][name]': 'Order',
    'line_items[0][quantity]': '1',
    client_reference_id: `order-${key}`,
  });
  const cs = await api('POST', `/run/${key}/pay/hyper/stripe/v1/checkout/sessions`, form, { authorization: `Bearer ${stripeKey}`, 'idempotency-key': `k-${Math.random()}` });
  expect(cs.status, cs.text).toBe(200);
  const entryPath = new URL(cs.body.url).pathname;
  const entry = await api('GET', entryPath);
  expect(entry.status).toBe(302);
  const pagePath = new URL(entry.headers.get('location')!, base + entryPath).pathname;
  const done = await api('POST', `${pagePath}/complete`, new URLSearchParams({ outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' }));
  expect(done.status).toBe(303);
  return cs.body;
}

describe('run verdicts (A2 engine)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-verdict-'));
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
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        if (failNext > 0) {
          failNext--;
          return res.writeHead(500).end('nope');
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    const project = await api('POST', '/api/projects', { name: 'Hyper' });
    expect(project.status).toBe(201);
    projectId = project.body.id;
    expect((await api('POST', `${P}/providers`, { preset: 'twilio', slug: 'sms' })).status).toBe(201);
    expect((await api('POST', `${P}/providers`, { preset: 'meta-whatsapp', slug: 'wa', config: { appSecret: 's3cret', wabaId: '555000111' } })).status).toBe(201);
    expect((await api('POST', `${P}/providers`, { preset: 'sendgrid', slug: 'sendgrid', config: { apiKey: 'SG.test' } })).status).toBe(201);
    const s = await api('POST', `${P}/payment-instances`, { preset: 'stripe-checkout', config: { webhookUrl: `${appUrl}/stripe`, webhookDelayMs: 0 } });
    expect(s.status, s.text).toBe(201);
    stripeKey = s.body.config.secretKey;
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('messages: count, "to" role ref, otp, contains, WhatsApp template, unassigned; defaults: false', async () => {
    const { users } = await startRun('m1');
    const phone = users[0].phone as string;
    expect((await sms('m1', phone, 'Your code is 482913')).status).toBe(201);
    expect((await waTemplate('m1', phone, 'order_update')).status).toBe(200);
    expect((await sms('m1', '+15550009999', 'Hello stranger')).status).toBe(201);
    const run = runOf('m1');
    await waitFor(() => messagesIn(run) >= 3);

    const items = [
      { kind: 'message', channel: 'sms', to: 'customer', otp: true, count: 1 },
      { kind: 'message', channel: 'sms', to: 'customer', contains: ['YOUR CODE', '4829'], count: 1 },
      { kind: 'message', channel: 'whatsapp', to: 'customer', template: 'order_update', count: 1 },
      { kind: 'message', unassigned: true, count: 1 },
      { kind: 'message', channel: 'sms', to: 'customer', count: 2 },
      { kind: 'message', channel: 'sms', to: phone, otp: '482913' },
      { kind: 'message', channel: 'email', count: 0 },
      { kind: 'message', channel: 'sms', otp: false, contains: 'nothing like this', count: 0 },
    ];
    const v = await verdict('m1', { items });
    expect(v.items.slice(0, items.length).map((i) => [i.id, i.status])).toEqual([
      ['e1', 'pass'],
      ['e2', 'pass'],
      ['e3', 'pass'],
      ['e4', 'pass'],
      ['e5', 'fail'],
      ['e6', 'pass'],
      ['e7', 'pass'],
      ['e8', 'pass'],
    ]);
    expect(item(v, 'e1').name).toBe('exactly 1 SMS to customer with an OTP');
    expect(item(v, 'e5').message).toBe(`1 SMS to ${users[0].name} (expected exactly 2)`);
    expect(item(v, 'e5').evidence).toEqual([expect.objectContaining({ type: 'message', url: expect.stringMatching(/^\/api\/messages\//), summary: expect.stringContaining(phone) })]);
    expect(item(v, 'e3').evidence[0].summary).toMatch(/^WhatsApp to/);
    // The unassigned SMS is a default failure too; the rest of the defaults pass.
    expect(item(v, 'default:unassignedMessages')).toMatchObject({ status: 'fail', actual: 1, source: 'default' });
    expect(item(v, 'default:unassignedMessages').evidence[0].summary).toContain('+15550009999');
    expect(v.items.filter((i) => i.source === 'default').map((i) => i.id)).toEqual([
      'default:providerCalls',
      'default:appCallbacks',
      'default:lintErrors',
      'default:duplicateMessages',
      'default:unassignedMessages',
      'default:failedMessages',
      'default:pendingWork',
    ]);
    expect(v).toMatchObject({ verdict: 'fail', counts: { fail: 2 }, frozen: false, run: { key: 'm1', status: 'active' } });
    expect(v.summary).toMatch(/^2 of 15 checks failed/);

    // defaults: false → declared items only; one default off with {name: false}.
    const only = await verdict('m1', { items: items.filter((_, i) => i !== 4), defaults: false });
    expect(only).toMatchObject({ verdict: 'pass', counts: { pass: 7, fail: 0 } });
    expect(only.items.every((i) => i.source === 'declared')).toBe(true);
    const oneOff = await verdict('m1', { items: [], defaults: { unassignedMessages: false } });
    expect(oneOff.verdict).toBe('pass');
    expect(oneOff.items.map((i) => i.id)).not.toContain('default:unassignedMessages');
    // Saved expectations are used without the ad-hoc document.
    hub.runs.setExpectations(run, { items: [{ kind: 'message', channel: 'sms', count: 2 }], defaults: false });
    expect((await hub.runs.verdict(runOf('m1'))).items).toEqual([expect.objectContaining({ id: 'e1', status: 'pass', actual: 2 })]);
    await hub.runs.stop(runOf('m1'), { purge: true });
  });

  it('defaults: duplicates, failed messages (with and without a rule), lint errors, provider calls; forced errors and expected failures do not count', async () => {
    const { run, users } = await startRun('d1');
    const phone = users[0].phone as string;
    const dupA = await sms('d1', phone, 'Hi there');
    const dupB = await sms('d1', phone, 'Hi there');
    expect(dupA.status).toBe(201);
    expect(dupB.status).toBe(201);
    expect((await sms('d1', phone, 'Hello {{name}}, welcome')).status).toBe(201); // placeholder: lint error
    expect((await sms('d1', phone, 'This one fails on purpose', { 'X-Hub-Scenario': 'fail' })).status).toBe(201); // failed, with a rule
    expect((await sms('d1', phone, 'Provider is down', { 'X-Hub-Scenario': 'down' })).status).toBeGreaterThanOrEqual(400); // forced_error
    // App → stubyard calls that failed: an unknown mock path (unmatched) and a wrong API key (rejected).
    expect((await api('POST', '/run/d1/mock/hyper/api/nothing-here', {})).status).toBeGreaterThanOrEqual(400);
    const denied = await api('POST', '/run/d1/mock/hyper/sendgrid/v3/mail/send', { personalizations: [{ to: [{ email: 'x@y.co' }] }], from: { email: 'a@b.co' }, subject: 's', content: [{ type: 'text/plain', value: 'x' }] }, { authorization: 'Bearer wrong' });
    expect(denied.status).toBe(401);
    await waitFor(() => (hub.db.prepare("SELECT COUNT(*) AS n FROM traffic_logs WHERE run_id = ? AND outcome != 'pending'").get(run.id) as { n: number }).n >= 7);
    await waitFor(() => messagesIn(run) >= 5);
    // A failed message no rule caused (e.g. a provider failure reported later).
    const user = hub.users.get(run.projectId, users[0].id)!;
    const failed = hub.messages.insert({
      projectId: run.projectId,
      testUserId: user.id,
      providerInstanceId: null,
      channel: 'sms',
      direction: 'outbound',
      from: '+15550001111',
      to: phone,
      subject: null,
      bodyText: 'Lost in transit',
      hasHtml: false,
      attachments: 0,
      mailpitId: null,
      messageIdHeader: null,
      status: 'failed',
      otp: null,
      links: [],
      logId: null,
      runId: run.id,
    });

    const v = await verdict('d1', []);
    const dup = item(v, 'default:duplicateMessages');
    expect(dup.status).toBe('fail');
    expect(dup.evidence.map((e) => e.id).sort()).toEqual(
      (hub.db.prepare("SELECT id FROM messages WHERE run_id = ? AND body_text = 'Hi there'").all(run.id) as { id: string }[]).map((r) => r.id).sort(),
    );
    expect(dup.evidence).toHaveLength(2);
    const fm = item(v, 'default:failedMessages');
    expect(fm).toMatchObject({ status: 'fail', actual: 1 });
    expect(fm.evidence.map((e) => e.id)).toEqual([failed.id]);
    const lint = item(v, 'default:lintErrors');
    expect(lint).toMatchObject({ status: 'fail', actual: 1 });
    expect(lint.evidence[0].summary).toContain('{{name}}');
    const pc = item(v, 'default:providerCalls');
    expect(pc).toMatchObject({ status: 'fail', actual: 2 });
    expect(pc.evidence.map((e) => e.summary).join('\n')).toMatch(/nothing-here[\s\S]*unmatched|unmatched[\s\S]*nothing-here/);
    expect(pc.evidence.some((e) => e.summary.includes('(rejected)'))).toBe(true);
    expect(pc.evidence.some((e) => e.summary.includes('forced_error'))).toBe(false);
    expect(pc.evidence.every((e) => e.url === `/api/logs/${e.id}`)).toBe(true);
    expect(v.verdict).toBe('fail');

    // Declared expected failures: their entries are not counted by the defaults.
    const exp = await verdict('d1', [
      { kind: 'provider_call', status: '4xx', count: 2 },
      { kind: 'message', status: 'failed', count: { min: 1 } },
      { kind: 'lint', source: 'messages', check: 'placeholder', count: 1 },
      { kind: 'lint', source: 'payments', count: 0 },
      { kind: 'provider_call', instance: 'sendgrid', outcome: 'rejected', count: 1 },
      { kind: 'traffic', outcome: 'forced_error', count: 1 },
    ]);
    expect(exp.items.slice(0, 6).map((i) => i.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(item(exp, 'default:providerCalls').status).toBe('pass');
    expect(item(exp, 'default:failedMessages').status).toBe('pass');
    expect(item(exp, 'default:lintErrors').status).toBe('pass');
    expect(item(exp, 'default:duplicateMessages').status).toBe('fail'); // not a failure selector
    // An item with severity "warn" never fails the run.
    const warned = await verdict('d1', { items: [{ kind: 'message', channel: 'whatsapp', severity: 'warn' }], defaults: false });
    expect(warned).toMatchObject({ verdict: 'pass', counts: { warn: 1 } });
    await hub.runs.stop(runOf('d1'), { purge: true });
  });

  it('payments: Stripe paid 150.00 SAR passes, a wrong amount fails; payment webhooks with each', async () => {
    await startRun('p1');
    await stripePaid('p1', 15000);
    const v = await verdict('p1', [
      { kind: 'payment', gateway: 'stripe', status: 'paid', amount: '150.00', currency: 'SAR', count: 1 },
      { kind: 'payment', status: 'paid', amount: 150, count: 1 },
      { kind: 'payment', status: 'paid', amount: '150.01', count: 1 },
      { kind: 'payment', reference: 'order-p1', status: ['paid', 'authorized'] },
      { kind: 'webhook', source: 'payment', url: '/stripe', count: { min: 1 }, each: { status: '2xx' } },
      { kind: 'webhook', source: 'payment', event: 'checkout.session.completed', count: 1 },
    ]);
    expect(v.items.slice(0, 6).map((i) => i.status)).toEqual(['pass', 'pass', 'fail', 'pass', 'pass', 'pass']);
    expect(item(v, 'e1').evidence[0]).toMatchObject({ type: 'payment', summary: expect.stringContaining('150.00 SAR'), url: expect.stringMatching(/^\/api\/projects\/hyper\/payments\//) });
    expect(item(v, 'e3').message).toBe('0 payments of 150.01 (paid) (expected exactly 1)');
    expect(item(v, 'e5').actual).toBe(2);
    expect(item(v, 'default:appCallbacks').status).toBe('pass');
    expect(item(v, 'default:lintErrors').status).toBe('pass');
    expect(v.verdict).toBe('fail');
    await hub.runs.stop(runOf('p1'), { purge: true });
  });

  it('webhooks against the app: 500 fails; 500 then 200 on the retry is a warn; each reports the failed attempt', async () => {
    const { run } = await startRun('w1');
    failNext = 1;
    await stripePaid('w1', 2000);
    await waitFor(() => (hub.db.prepare("SELECT COUNT(*) AS n FROM traffic_logs WHERE run_id = ? AND direction = 'outbound' AND outcome != 'pending'").get(run.id) as { n: number }).n >= 2);
    const items = [{ kind: 'webhook', source: 'payment', each: { status: '2xx' } }];
    const v1 = await verdict('w1', items);
    const cb = item(v1, 'default:appCallbacks');
    expect(cb).toMatchObject({ status: 'fail', actual: 1 });
    expect(cb.evidence[0].summary).toContain('500');
    expect(item(v1, 'e1').status).toBe('pending'); // the retry is queued: "each" may still be met
    expect(item(v1, 'default:pendingWork')).toMatchObject({ status: 'pending', actual: 1 });
    expect(item(v1, 'default:pendingWork').evidence[0]).toMatchObject({ type: 'schedule', url: expect.stringMatching(/^\/api\/projects\/hyper\/schedules\//) });
    expect(v1.verdict).toBe('fail');

    // Fire the queued retry now: the app answers 200.
    const scheduleId = item(v1, 'default:pendingWork').evidence[0].id;
    expect((await api('POST', `${P}/schedules/${scheduleId}/run-now`)).status).toBe(200);
    await waitFor(() => (hub.db.prepare("SELECT COUNT(*) AS n FROM traffic_logs WHERE run_id = ? AND direction = 'outbound' AND outcome = 'ok'").get(run.id) as { n: number }).n >= 2);
    const v2 = await verdict('w1', items);
    expect(item(v2, 'default:appCallbacks')).toMatchObject({ status: 'warn', actual: 1 });
    expect(item(v2, 'default:appCallbacks').message).toMatch(/succeeded on a retry/);
    expect(item(v2, 'default:pendingWork').status).toBe('pass');
    const each = item(v2, 'e1');
    expect(each.status).toBe('fail');
    expect(each.actual).toBe(3);
    expect(each.evidence).toHaveLength(1);
    expect(each.evidence[0].summary).toContain('500');
    expect(each.message).toMatch(/1 of them does not meet "each"/);
    // Without the strict item: warns never fail the run.
    const v3 = await verdict('w1', [{ kind: 'webhook', source: 'payment', count: { min: 1 } }]);
    expect(v3.verdict).toBe('pass');
    expect(v3.counts.warn).toBe(1);
    await hub.runs.stop(runOf('w1'), { purge: true });
  });

  it('pending while a delivery is queued, then settle → pass', async () => {
    const { users } = await startRun('s1');
    expect((await api('POST', `${P}/users/customer/rules?run=s1`, { channel: 'sms', action: 'delay', delayMs: 700, count: 1 })).status).toBe(201);
    expect((await sms('s1', users[0].phone, 'Delayed hello')).status).toBe(201);
    const run = runOf('s1');
    await waitFor(() => messagesIn(run) >= 1);
    const items = [{ kind: 'message', channel: 'sms', status: 'delivered', count: 1 }];
    const now = await verdict('s1', items);
    expect(now.verdict).toBe('pending');
    expect(item(now, 'e1').status).toBe('pending');
    expect(item(now, 'default:pendingWork')).toMatchObject({ status: 'pending', actual: 1, evidence: [expect.objectContaining({ type: 'message' })] });
    expect(now.summary).toMatch(/pending/);
    const settled = await verdict('s1', items, { settleMs: 5000 });
    expect(settled.verdict).toBe('pass');
    expect(item(settled, 'e1').status).toBe('pass');
    await hub.runs.stop(runOf('s1'), { purge: true });
  });

  it('stop freezes the verdict (pending becomes a warn) and it survives purge; stop waits with settleMs', async () => {
    const { users } = await startRun('f1', { expectations: [{ kind: 'message', channel: 'sms', count: 2 }] });
    const phone = users[0].phone as string;
    expect((await api('POST', `${P}/users/customer/rules?run=f1`, { channel: 'sms', action: 'delay', delayMs: 60_000, count: 1 })).status).toBe(201);
    expect((await sms('f1', phone, 'Queued for a minute')).status).toBe(201);
    expect((await sms('f1', phone, 'Delivered now')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('f1')) >= 2);
    expect((await hub.runs.verdict(runOf('f1'))).verdict).toBe('pending');

    const { run, report } = await hub.runs.stop(runOf('f1'), { purge: true });
    const frozen = report.verdict!;
    expect(frozen).toMatchObject({ verdict: 'pass', frozen: true, run: { key: 'f1', status: 'stopped', stoppedAt: report.run.stoppedAt } });
    expect(item(frozen, 'e1').status).toBe('pass');
    expect(item(frozen, 'default:pendingWork')).toMatchObject({ status: 'warn', message: 'cancelled at stop: 1 queued delivery' });
    expect(messagesIn(run)).toBe(0); // purged
    const again = await hub.runs.verdict(hub.runs.require(run.projectId, run.id));
    expect(again).toEqual(frozen);
    expect(hub.runs.view(hub.runs.require(run.projectId, run.id)).verdict).toBe('pass');
    expect((hub.runs.view(runOf('f1')) as { verdict: unknown }).verdict).toBe('pass');

    // settleMs: stop waits for the queued delivery, so nothing is left at stop.
    const f2 = await startRun('f2');
    expect((await api('POST', `${P}/users/customer/rules?run=f2`, { channel: 'sms', action: 'delay', delayMs: 600, count: 1 })).status).toBe(201);
    expect((await sms('f2', f2.users[0].phone, 'Soon')).status).toBe(201);
    await waitFor(() => messagesIn(f2.run) >= 1);
    const active = hub.runs.view(runOf('f2'));
    expect(active.verdict).toBeNull();
    const t0 = Date.now();
    const s2 = await hub.runs.stop(runOf('f2'), { settleMs: 5000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(item(s2.report.verdict!, 'default:pendingWork').status).toBe('pass');
    expect(s2.report.verdict!.verdict).toBe('pass');
    await hub.runs.purge(s2.run);
  });

  it('a run stopped before verdicts existed: evaluated live while its data is there, 409 once purged', async () => {
    const { users } = await startRun('o1');
    expect((await sms('o1', users[0].phone, 'Old times')).status).toBe(201);
    await waitFor(() => messagesIn(runOf('o1')) >= 1);
    const { run } = await hub.runs.stop(runOf('o1'));
    // Simulate a report frozen before A2.
    hub.db.prepare("UPDATE runs SET report = json_remove(report, '$.verdict') WHERE id = ?").run(run.id);
    const old = hub.runs.require(run.projectId, run.id);
    expect((old.report as RunReport).verdict).toBeUndefined();
    expect(hub.runs.view(old).verdict).toBeNull();
    const live = await hub.runs.verdict(old);
    expect(live).toMatchObject({ verdict: 'pass', frozen: false, run: { status: 'stopped' } });
    expect(live.notes.join(' ')).toMatch(/stopped before verdicts/);
    await hub.runs.purge(old);
    await expect(hub.runs.verdict(hub.runs.require(run.projectId, run.id))).rejects.toMatchObject({ statusCode: 409, message: 'Run was stopped and purged before verdicts existed' });
  });
});
