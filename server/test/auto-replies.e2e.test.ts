import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
let base: string;
let dataDir: string;
let appServer: http.Server;
let appUrl: string;
const received: { path: string; body: string; headers: http.IncomingHttpHeaders }[] = [];

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const isStr = typeof body === 'string';
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': isStr ? 'application/x-www-form-urlencoded' : 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isStr ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const P = 'ar';
const AR = `/api/projects/${P}/auto-replies`;
const hits = (p: string) => received.filter((r) => r.path === p);
const users: Record<string, any> = {};
const user = async (ref: string) => (users[ref] ??= (await api('GET', `/api/projects/${P}/users/${ref}`)).body);
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const sms = (to: string, body: string, extraHeaders: Record<string, string> = {}, prefix = '') =>
  api('POST', `${prefix}/mock/${P}/tw/2010-04-01/Accounts/ACtest/Messages.json`, form({ To: to, From: '+15550001111', Body: body }), extraHeaders);
const rule = async (b: Record<string, unknown>, q = '') => {
  const r = await api('POST', AR + q, b);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const fires = async (q = '') => (await api('GET', `${AR}/fires${q}`)).body as any[];
const cursor = async () => (await fires('?limit=1'))[0]?.id ?? '';
const waitFire = async (b: Record<string, unknown>) => (await api('POST', `${AR}/fires/wait`, { timeoutMs: 5000, ...b })).body;

describe('scripted auto-replies', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-ar-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
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
        received.push({ path: req.url ?? '', body, headers: req.headers });
        res.writeHead(req.url === '/broken' ? 500 : 200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'AR', slug: P, generateUsers: { admins: 1, customers: 9 } })).status).toBe(201);
    for (const p of [
      { preset: 'twilio', slug: 'tw', config: { inboundUrl: `${appUrl}/sms/in`, authToken: 'secret' } },
      { preset: 'sendgrid', slug: 'sg', config: { inboundUrl: `${appUrl}/mail/in` } },
      { preset: 'meta-whatsapp', slug: 'wa', config: { statusCallbackUrl: `${appUrl}/wa/hook`, appSecret: 's3cret' } },
    ]) {
      const r = await api('POST', `/api/projects/${P}/providers`, p);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  afterEach(async () => {
    await api('DELETE', AR);
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('SMS: echoes the OTP back through the inbound webhook', async () => {
    const r = await rule({ name: 'echo code', channel: 'sms', match: { hasOtp: true }, reply: { text: 'Code: {{otp}}' } });
    expect(r).toMatchObject({ enabled: true, uses: 0, maxUses: null, stop: true, delayMs: 0, run: null, usedUp: false, pendingFires: 0 });
    const c1 = await user('customer1');
    const after = await cursor();
    const sent = await sms(c1.phone, 'Your Hyper code is 482913');
    expect(sent.status).toBe(201);
    const w = await waitFire({ after });
    expect(w.timedOut).toBe(false);
    expect(w.fire).toMatchObject({ status: 'sent', ruleId: r.id, webhookOk: true, webhookStatus: 200, user: { name: c1.name } });
    expect(w.fire.plan.rendered).toMatchObject({ channel: 'sms', text: 'Code: 482913', instance: 'tw' });
    const hook = await waitFor(() => hits('/sms/in').find((h) => h.body.includes('482913')));
    expect(new URLSearchParams(hook.body).get('Body')).toBe('Code: 482913');
    // The reply message carries metadata.autoReply.
    const msgs = (await api('GET', `/api/projects/${P}/messages?user=customer1&channel=sms`)).body as any[];
    const inbound = msgs.find((m) => m.direction === 'inbound');
    expect(inbound.id).toBe(w.fire.replyMessageId);
    expect(inbound.metadata.autoReply).toMatchObject({ ruleId: r.id, ruleName: 'echo code', fireId: w.fire.id, triggerMessageId: w.fire.triggerMessageId });
    const again = (await api('GET', `${AR}/${r.id}`)).body;
    expect(again).toMatchObject({ uses: 1, lastFire: { status: 'sent' } });
  });

  it('email: threaded reply with Re: subject and body capture groups', async () => {
    await rule({ channel: 'email', match: { subject: 'order', body: { regex: '/order #(?<num>\\d+)/i' } }, reply: { text: 'Got order {{body.num}} / {{$1}} for {{user.name}} {{nope}}' } });
    const c2 = await user('customer2');
    const after = await cursor();
    const sg = await api(
      'POST',
      `/mock/${P}/sg/v3/mail/send`,
      { personalizations: [{ to: [{ email: c2.email }] }], from: { email: 'orders@hyper.app' }, subject: 'Your order', content: [{ type: 'text/plain', value: 'Thanks for order #7781' }] },
      { authorization: 'Bearer SG.test' },
    );
    expect(sg.status).toBe(202);
    const w = await waitFire({ after });
    expect(w.fire.status, JSON.stringify(w.fire)).toBe('sent');
    expect(w.fire.plan.captures).toMatchObject({ 'body.1': '7781', 'body.num': '7781' });
    expect(w.fire.plan.rendered).toMatchObject({ channel: 'email', inReplyTo: w.fire.triggerMessageId, text: `Got order 7781 / 7781 for ${c2.name} ` });
    expect(w.fire.plan.warnings.join(' ')).toMatch(/\{\{nope\}\} is not a known variable/);
    const reply = hub.messages.get(w.fire.replyMessageId)! as any;
    expect(reply).toMatchObject({ direction: 'inbound', channel: 'email', subject: 'Re: Your order', to: 'orders@hyper.app' });
    const trigger = hub.messages.get(w.fire.triggerMessageId)! as any;
    expect(reply.metadata.inbound.inReplyTo).toBe(trigger.id);
    const hook = await waitFor(() => hits('/mail/in').find((h) => h.body.includes('Got order 7781')));
    expect(hook.body).toContain('Re: Your order');
    if (trigger.messageIdHeader) expect(hook.body).toContain(`In-Reply-To: ${trigger.messageIdHeader}`);
  });

  it('WhatsApp: taps a button of the interactive message', async () => {
    await rule({ channel: 'whatsapp', reply: { button: '#1' } });
    const c3 = await user('customer3');
    const after = await cursor();
    const r = await api('POST', `/mock/${P}/wa/v21.0/123456/messages`, {
      messaging_product: 'whatsapp',
      to: c3.whatsapp.replace('+', ''),
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'Confirm your booking?' }, action: { buttons: [{ type: 'reply', reply: { id: 'yes-1', title: 'Yes please' } }, { type: 'reply', reply: { id: 'no-1', title: 'No' } }] } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const w = await waitFire({ after });
    expect(w.fire.status, JSON.stringify(w.fire)).toBe('sent');
    expect(w.fire.plan.rendered).toMatchObject({ button: 'yes-1', contextMessageId: w.fire.triggerMessageId });
    const hook = await waitFor(() => hits('/wa/hook').find((h) => h.body.includes('button_reply')));
    const msg = JSON.parse(hook.body).entry[0].changes[0].value.messages[0];
    expect(msg.interactive.button_reply).toMatchObject({ id: 'yes-1', title: 'Yes please' });
    expect(msg.context.id).toBe(r.body.messages[0].id);
  });

  it('delays go through scheduled_jobs and /flush fires them now', async () => {
    const r = await rule({ channel: 'sms', reply: { text: 'later' }, delaySeconds: 600, jitterSeconds: 5 });
    expect(r.delayMs).toBe(600_000);
    const c4 = await user('customer4');
    await sms(c4.phone, 'hello');
    const [f] = await waitFor(async () => {
      const l = await fires(`?rule=${r.id}`);
      return l.length ? l : null;
    });
    expect(f.status).toBe('pending');
    expect(Date.parse(f.dueAt) - Date.now()).toBeGreaterThan(590_000);
    const project = hub.projects.getBySlug(P)!;
    expect(hub.scheduler.pending(project.id).find((j) => j.id === f.jobId)).toMatchObject({ type: 'autoreply.fire', payload: { fireId: f.id } });
    expect((await api('GET', `${AR}/${r.id}`)).body.pendingFires).toBe(1);
    const fl = await api('POST', `${AR}/flush`, {});
    expect(fl.body.fired).toHaveLength(1);
    expect(fl.body.fired[0]).toMatchObject({ id: f.id, status: 'sent' });
    expect(hub.scheduler.pending(project.id).find((j) => j.id === f.jobId)).toBeUndefined();
    // Cancel a pending one.
    await sms(c4.phone, 'hello again');
    const p2 = await waitFor(async () => (await fires(`?rule=${r.id}&status=pending`))[0]);
    expect((await api('DELETE', `${AR}/fires/${p2.id}`)).body.status).toBe('cancelled');
    expect((await api('DELETE', `${AR}/fires/${p2.id}`)).status).toBe(409);
  });

  it('max uses: the rule is used up, PATCH uses re-arms it', async () => {
    const r = await rule({ channel: 'sms', reply: { text: 'once' }, maxUses: 1, delaySeconds: 600 });
    const c5 = await user('customer5');
    await sms(c5.phone, 'one');
    await sms(c5.phone, 'two');
    await waitFor(async () => (await fires(`?rule=${r.id}`)).length === 1);
    await sleep(100);
    expect(await fires(`?rule=${r.id}`)).toHaveLength(1);
    expect((await api('GET', `${AR}/${r.id}`)).body).toMatchObject({ uses: 1, usedUp: true });
    expect((await api('PATCH', `${AR}/${r.id}`, { uses: 0 })).body.usedUp).toBe(false);
    await sms(c5.phone, 'three');
    await waitFor(async () => (await fires(`?rule=${r.id}`)).length === 2);
  });

  it('stop: false lets later rules fire too; stop: true (default) ends evaluation', async () => {
    const a = await rule({ name: 'a', channel: 'sms', reply: { text: 'A' }, stop: false, delaySeconds: 600 });
    const b = await rule({ name: 'b', channel: 'sms', reply: { text: 'B' }, delaySeconds: 600 });
    const c = await rule({ name: 'c', channel: 'sms', reply: { text: 'C' }, delaySeconds: 600 });
    const c6 = await user('customer6');
    await sms(c6.phone, 'hi');
    await waitFor(async () => (await fires(`?rule=${b.id}`)).length === 1);
    expect(await fires(`?rule=${a.id}`)).toHaveLength(1);
    expect(await fires(`?rule=${c.id}`)).toHaveLength(0);
    // Reorder: c first → only c fires (stop).
    const list = (await api('POST', `${AR}/reorder`, { ids: [c.id, a.id, b.id] })).body as any[];
    expect(list.map((x) => x.name)).toEqual(['c', 'a', 'b']);
    await sms(c6.phone, 'hi 2');
    await waitFor(async () => (await fires(`?rule=${c.id}`)).length === 1);
    expect(await fires(`?rule=${a.id}`)).toHaveLength(1);
  });

  it('run rules only see their run; stopping the run cancels its pending fires', async () => {
    const run = await api('POST', `/api/projects/${P}/runs`, { key: 'w1', users: [{ role: 'customer', count: 1 }] });
    expect(run.status).toBe(201);
    const ru = run.body.users[0];
    const runRule = await rule({ name: 'run rule', channel: 'sms', reply: { text: 'from run rule' }, delaySeconds: 600 }, '?run=w1');
    expect(runRule.run).toBe('w1');
    const projRule = await rule({ name: 'project rule', channel: 'sms', reply: { text: 'from project rule' }, delaySeconds: 600 });
    // Run-scoped list shows only the run's rules.
    expect(((await api('GET', `${AR}?run=w1`)).body as any[]).map((x) => x.name)).toEqual(['run rule']);
    // A run user's message: the run rule comes first and stops.
    await sms(ru.phone, 'run msg', { 'x-hub-run': 'w1' });
    const rf = await waitFor(async () => (await fires(`?rule=${runRule.id}`))[0]);
    expect(rf.run).toBe('w1');
    expect(await fires(`?rule=${projRule.id}`)).toHaveLength(0);
    // A project user's message: the run rule does not see it.
    const c7 = await user('customer7');
    await sms(c7.phone, 'plain msg');
    await waitFor(async () => (await fires(`?rule=${projRule.id}`)).length === 1);
    expect(await fires(`?rule=${runRule.id}`)).toHaveLength(1);
    // Stop the run → its pending fire is cancelled.
    expect((await api('POST', `/api/projects/${P}/runs/w1/stop`, {})).status).toBe(200);
    expect((await api('GET', `${AR}/fires/${rf.id}`)).body).toMatchObject({ status: 'cancelled', error: 'The test run was stopped' });
    expect((await fires(`?rule=${projRule.id}`))[0].status).toBe('pending');
  });

  it('failed, dropped and unassigned messages never trigger', async () => {
    const r = await rule({ channel: 'sms', reply: { text: 'x' }, delaySeconds: 600 });
    const c8 = await user('customer8');
    expect((await api('POST', `/api/projects/${P}/users/customer8/rules`, { channel: 'sms', action: 'fail', count: 1 })).status).toBe(201);
    expect((await api('POST', `/api/projects/${P}/users/customer8/rules`, { channel: 'sms', action: 'drop', count: 1 })).status).toBe(201);
    await sms(c8.phone, 'will fail');
    await sms(c8.phone, 'will drop');
    await sms('+19995550123', 'nobody');
    const statuses = ((await api('GET', `/api/projects/${P}/messages?user=customer8&channel=sms&limit=5`)).body as any[]).map((m) => m.status);
    expect(statuses).toEqual(expect.arrayContaining(['failed', 'dropped']));
    await sleep(150);
    expect(await fires(`?rule=${r.id}`)).toHaveLength(0);
    // The next one is delivered and does trigger.
    await sms(c8.phone, 'ok now');
    await waitFor(async () => (await fires(`?rule=${r.id}`)).length === 1);
  });

  it('message.created + message.updated fire only once', async () => {
    const r = await rule({ channel: 'sms', reply: { text: 'once' }, delaySeconds: 600 });
    const c9 = await user('customer9');
    await sms(c9.phone, 'dup check');
    const [f] = await waitFor(async () => {
      const l = await fires(`?rule=${r.id}`);
      return l.length ? l : null;
    });
    const m = hub.messages.get(f.triggerMessageId)!;
    hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: m });
    hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: { ...m, status: 'delivered' } });
    await sleep(50);
    expect(await fires(`?rule=${r.id}`)).toHaveLength(1);
    expect((await api('GET', `${AR}/${r.id}`)).body.uses).toBe(1);
  });

  it('loop guard: more than 20 fires for one user in 60 s disables the rule', async () => {
    const r = await rule({ name: 'chatty', channel: 'sms', reply: { text: 'ping' }, delaySeconds: 600 });
    const c1 = await user('customer1');
    for (let i = 0; i < 21; i++) await sms(c1.phone, `msg ${i}`);
    const v = await waitFor(async () => {
      const x = (await api('GET', `${AR}/${r.id}`)).body;
      return x.disabledReason === 'loop' ? x : null;
    });
    expect(v.enabled).toBe(false);
    expect(v.warnings[0]).toMatch(/loop guard/);
    expect(await fires(`?rule=${r.id}&limit=100`)).toHaveLength(20);
    // Enabling again clears the reason.
    expect((await api('PATCH', `${AR}/${r.id}`, { enabled: true })).body).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('loop guard: an hourly cap catches slow loops; project reset re-arms loop-disabled rules only', async () => {
    const r = await rule({ name: 'slow loop', channel: 'sms', reply: { text: 'pong' }, delaySeconds: 600 });
    const off = await rule({ name: 'switched off', channel: 'sms', enabled: false, reply: { text: 'x' } });
    const c2 = await user('customer2');
    const pid = hub.projects.require(P).id;
    // 200 fires spread over the last hour (none in the last minute, so the 60 s guard does not trip).
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const ins = hub.db.prepare("INSERT INTO auto_reply_fires (id, project_id, rule_id, trigger_message_id, test_user_id, status, due_at, created_at) VALUES (?, ?, ?, ?, ?, 'sent', ?, ?)");
    for (let i = 0; i < 200; i++) ins.run(`old-${r.id}-${i}`, pid, r.id, `old-msg-${i}`, c2.id, at, at);
    await sms(c2.phone, 'one more');
    const v = await waitFor(async () => {
      const x = (await api('GET', `${AR}/${r.id}`)).body;
      return x.disabledReason === 'loop-hourly' ? x : null;
    });
    expect(v.enabled).toBe(false);
    expect(v.warnings[0]).toMatch(/200 replies to one user within an hour/);
    hub.autoReplies.resetProject(pid);
    expect((await api('GET', `${AR}/${r.id}`)).body).toMatchObject({ enabled: true, disabledReason: null, uses: 0 });
    expect((await api('GET', `${AR}/${off.id}`)).body.enabled).toBe(false);
  });

  it('boot: a fire left "sending" by a crash is failed, not kept forever', async () => {
    const r = await rule({ name: 'crashy', channel: 'sms', reply: { text: 'x' } });
    const pid = hub.projects.require(P).id;
    const now = new Date().toISOString();
    hub.db
      .prepare("INSERT INTO auto_reply_fires (id, project_id, rule_id, trigger_message_id, status, due_at, job_id, created_at) VALUES ('stuck-sending', ?, ?, 'm-stuck', 'sending', ?, 'job-gone', ?)")
      .run(pid, r.id, now, now);
    expect(hub.autoReplies.failInterrupted()).toBe(1);
    const f = (await fires(`?rule=${r.id}`))[0];
    expect(f).toMatchObject({ id: 'stuck-sending', status: 'failed' });
    expect(f.error).toMatch(/interrupted/);
    expect(hub.autoReplies.failInterrupted()).toBe(0);
  });

  it('validates rules: bad regex, unknown fields, missing reply', async () => {
    const bad = async (b: unknown) => (await api('POST', AR, b)).status;
    expect(await bad({ match: { body: { regex: '/(/' } }, reply: { text: 'x' } })).toBe(400);
    expect(await bad({ match: { body: { regex: 'a'.repeat(501) } }, reply: { text: 'x' } })).toBe(400);
    expect(await bad({ match: { nope: 1 }, reply: { text: 'x' } })).toBe(400);
    expect(await bad({ reply: { text: '' } })).toBe(400);
    expect(await bad({ channel: 'fax', reply: { text: 'x' } })).toBe(400);
    expect(await bad({ channel: 'sms', reply: { text: 'x', button: 'Yes' } })).toBe(400);
    expect(await bad({ reply: { text: 'x' }, delaySeconds: -1 })).toBe(400);
    expect(await bad({ match: { hasOtp: 'yes' }, reply: { text: 'x' } })).toBe(400);
    const r = await api('POST', AR, { match: { body: { regex: '/(/' } }, reply: { text: 'x' } });
    expect(r.body.error ?? r.body.message).toMatch(/match\.body\.regex is not a valid regular expression/);
    // ReDoS: nested quantifiers / repeated alternation are refused on save and in /test inline rules.
    const evil = await api('POST', AR, { match: { body: { regex: '(a+)+$' } }, reply: { text: 'x' } });
    expect(evil.status).toBe(400);
    expect(evil.body.error ?? evil.body.message).toMatch(/nested quantifiers/);
    expect((await api('POST', `${AR}/test`, { rule: { match: { body: { regex: '(a|aa)+$' } } }, message: { channel: 'sms', to: '+1', body: 'aaaa' } })).status).toBe(400);
    expect((await api('POST', AR, { match: { subject: { regex: '(\\w)\\1' } }, reply: { text: 'x' } })).status).toBe(400);
    // Static template warnings show on the rule.
    const w = await rule({ reply: { text: '{{body.1}} {{whatever}}' } });
    expect(w.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/whatever/), expect.stringMatching(/needs a regex on match.body/)]));
    // Presets
    const presets = (await api('GET', '/api/auto-reply-presets')).body;
    expect(presets.presets.map((p: any) => p.name)).toEqual(['Reply with the code', 'Reply STOP', 'Confirm YES', 'Out of office', 'Tap first button']);
    for (const p of presets.presets) expect((await api('POST', `${AR}/test`, { rule: p.rule, message: { channel: p.rule.channel === 'any' ? 'sms' : p.rule.channel, to: '+1', body: 'x' } })).status).toBe(200);
  });

  it('/test is a dry run: matched, reasons, captures, plan; nothing sent', async () => {
    const countMsgs = () => (hub.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const n0 = countMsgs();
    const c2 = await user('customer2');
    const t = await api('POST', `${AR}/test`, {
      rule: { channel: 'sms', match: { body: { regex: 'code (\\d{4,8})' } }, reply: { text: 'It is {{$1}} / {{otp}} / {{user.role}}' } },
      message: { channel: 'sms', to: c2.phone, from: '+15550001111', body: 'Your code 123456' },
    });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ matched: true, reasons: [], captures: { 'body.1': '123456' }, plan: { channel: 'sms', text: 'It is 123456 / 123456 / customer' } });
    const miss = await api('POST', `${AR}/test`, { rule: { channel: 'email', match: { subject: { equals: 'Hi' }, hasLink: true }, reply: { text: 'x' } }, message: { channel: 'sms', to: c2.phone, body: 'no' } });
    expect(miss.body.matched).toBe(false);
    expect(miss.body.reasons.join(' | ')).toMatch(/channel is sms.*subject is not "Hi".*no link/);
    // Against a stored message id.
    const stored = (await api('GET', `/api/projects/${P}/messages?user=customer2&limit=1`)).body[0];
    const sr = await api('POST', `${AR}/test`, { rule: { channel: 'any', reply: { text: '{{subject}}' } }, message: stored.id });
    expect(sr.body.matched).toBe(true);
    expect(countMsgs()).toBe(n0);
    await sleep(50);
    expect(received.some((h) => h.body.includes('It is'))).toBe(false);
  });

  it('a lost fire (job gone) is marked failed on boot', async () => {
    const r = await rule({ channel: 'sms', reply: { text: 'x' }, delaySeconds: 600 });
    await sms((await user('customer3')).phone, 'lost');
    const f = await waitFor(async () => (await fires(`?rule=${r.id}`))[0]);
    hub.db.prepare('DELETE FROM scheduled_jobs WHERE id = ?').run(f.jobId);
    expect(hub.autoReplies.markLost()).toBe(1);
    expect((await api('GET', `${AR}/fires/${f.id}`)).body).toMatchObject({ status: 'failed', error: 'lost' });
  });

  it('reset keeps rules (uses 0, fires gone); export / import round trip', async () => {
    const r = await rule({ name: 'keep me', channel: 'sms', match: { body: 'hello' }, reply: { text: 'hey {{user.name}}' }, maxUses: 3, delaySeconds: 600 });
    await sms((await user('customer4')).phone, 'hello there');
    await waitFor(async () => (await fires(`?rule=${r.id}`)).length === 1);
    expect((await api('POST', `/api/projects/${P}/reset`, {})).status).toBe(200);
    expect(await fires(`?rule=${r.id}`)).toHaveLength(0);
    expect((await api('GET', `${AR}/${r.id}`)).body).toMatchObject({ uses: 0, name: 'keep me' });
    const ex = (await api('GET', `/api/projects/${P}/export`)).body;
    expect(ex.autoReplies).toEqual([expect.objectContaining({ name: 'keep me', channel: 'sms', match: { body: { contains: 'hello' } }, reply: { text: 'hey {{user.name}}' }, maxUses: 3, delayMs: 600_000 })]);
    const im = await api('POST', '/api/projects/import', { json: ex, slug: 'ar-copy' });
    expect(im.status, JSON.stringify(im.body)).toBe(201);
    const copied = (await api('GET', '/api/projects/ar-copy/auto-replies')).body as any[];
    expect(copied).toEqual([expect.objectContaining({ name: 'keep me', uses: 0, maxUses: 3 })]);
  });

  it('MCP: set_auto_reply + wait_for_auto_reply + list tools', async () => {
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
      return JSON.parse(r.body.result.content[0].text);
    };
    const set = await mcp('set_auto_reply', { project: P, name: 'mcp rule', channel: 'sms', match: { hasOtp: true }, reply: { text: '{{otp}}' } });
    expect(set).toMatchObject({ name: 'mcp rule', channel: 'sms', enabled: true });
    const after = await cursor();
    const waiting = mcp('wait_for_auto_reply', { project: P, rule: set.id, after, timeout_seconds: 5 });
    await sms((await user('customer5')).phone, 'code 774411');
    const w = await waiting;
    expect(w).toMatchObject({ timedOut: false, fire: { status: 'sent', rule: 'mcp rule', rendered: { text: '774411' } } });
    expect((await mcp('list_auto_replies', { project: P })).map((x: any) => x.name)).toContain('mcp rule');
    expect((await mcp('list_auto_reply_fires', { project: P, rule: set.id }))[0].status).toBe('sent');
    const dry = await mcp('test_auto_reply', { project: P, rule: set.id, message: { channel: 'sms', to: '+1', body: 'no code here' } });
    expect(dry.matched).toBe(false);
    const upd = await mcp('set_auto_reply', { project: P, id: set.id, delay_seconds: 300 });
    expect(upd.delayMs).toBe(300_000);
    await sms((await user('customer5')).phone, 'code 112233');
    await waitFor(async () => (await fires(`?rule=${set.id}&status=pending`)).length === 1);
    const fl = await mcp('flush_auto_replies', { project: P });
    expect(fl.fired[0]).toMatchObject({ status: 'sent', rendered: { text: '112233' } });
    expect(await mcp('delete_auto_reply', { project: P, id: set.id })).toEqual({ deleted: 1 });
    const tools = (await api('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).body.result.tools.map((t: any) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['list_auto_replies', 'list_auto_reply_fires', 'test_auto_reply', 'wait_for_auto_reply', 'set_auto_reply', 'delete_auto_reply', 'flush_auto_replies']));
  });
});
