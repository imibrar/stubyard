import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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
let smtpPort: number;
let dataDir: string;

/** A fake "app" that receives status callbacks and inbound webhooks. */
const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let appServer: http.Server;
let appUrl: string;

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

function mailer(user?: string) {
  return nodemailer.createTransport({
    host: '127.0.0.1',
    port: smtpPort,
    secure: false,
    ignoreTLS: true,
    auth: user ? { user, pass: 'x' } : undefined,
  });
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

describe.skipIf(!haveMailpit)('devhub end-to-end', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-test-'));
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
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', headers: req.headers, body });
        res.writeHead(req.url?.startsWith('/fail') ? 500 : 200).end('ok');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    base = `http://127.0.0.1:${httpPort}`;
  });

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates projects with a default SMTP instance and generated users', async () => {
    const r = await api('POST', '/api/projects', { name: 'Hyper', generateUsers: { admins: 1, customers: 9 } });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBe('hyper');
    const ov = await api('GET', '/api/projects/hyper/overview');
    expect(ov.body.users).toHaveLength(10);
    expect(ov.body.providers).toMatchObject([{ slug: 'mail', preset: 'smtp', isDefault: true, channel: 'email' }]);

    await api('POST', '/api/projects', { name: 'Fleet', generateUsers: { admins: 1, customers: 2 } });
    const dup = await api('POST', '/api/projects', { name: 'Hyper' });
    expect(dup.status).toBe(409);
  });

  it('routes an SMTP email to the right test user with OTP and logs the transaction', async () => {
    const info = await mailer('hyper').sendMail({
      from: 'no-reply@hyper.app',
      to: 'admin@hyper.test',
      subject: 'Sign in',
      text: 'Your verification code is 482913. Or open https://hyper.app/verify?t=abc',
      html: '<p>Your verification code is <b>482913</b></p>',
    });
    expect(info.response).toMatch(/^250 .*queued as/);

    const ov = await api('GET', '/api/projects/hyper/overview');
    const admin = ov.body.users.find((u: any) => u.role === 'admin');
    expect(admin.inbox.email).toEqual({ unread: 1, total: 1 });

    const msgs = await api('GET', `/api/projects/hyper/messages?user=${admin.id}`);
    expect(msgs.body).toHaveLength(1);
    const m = msgs.body[0];
    expect(m).toMatchObject({ channel: 'email', to: 'admin@hyper.test', subject: 'Sign in', otp: '482913', hasHtml: true, status: 'delivered' });
    expect(m.links).toContain('https://hyper.app/verify?t=abc');
    expect(m.mailpitId).toBeTruthy();

    // Mailpit renders the HTML through the proxy.
    const detail = await api('GET', `/api/messages/${m.id}`);
    const html = await fetch(base + detail.body.mailpit.html).then((r) => r.text());
    expect(html).toContain('482913');

    // The SMTP transaction is in the traffic log, with transcript.
    const log = await api('GET', `/api/logs/${m.logId}`);
    expect(log.body).toMatchObject({ protocol: 'smtp', outcome: 'ok', resStatus: 250, projectId: ov.body.project.id });
    expect(log.body.transcript.map((t: any) => t.command)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^AUTH /), 'MAIL FROM:<no-reply@hyper.app>', 'RCPT TO:<admin@hyper.test>']),
    );
    expect(log.body.reqBody).toContain('Subject: Sign in');
  });

  it('finds users by role/email, returns the latest code and waits for new messages', async () => {
    const admin = await api('GET', '/api/projects/hyper/users/admin');
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ email: 'admin@hyper.test', password: 'Password123!', pinned: 1 });
    expect(admin.body.latest.otp).toBe('482913');

    const latest = await api('GET', '/api/projects/hyper/users/admin@hyper.test/latest?otp=1');
    expect(latest.body).toMatchObject({ otp: '482913' });
    expect((await api('GET', '/api/projects/hyper/users/nobody/latest')).status).toBe(404);

    const byRole = await api('GET', '/api/projects/hyper/messages?user=admin&otp=1&limit=1');
    expect(byRole.body[0].otp).toBe('482913');

    // Without since/after the wait API looks back 10s, so the code above counts immediately.
    const quick = await api('GET', '/api/projects/hyper/messages/wait?user=admin&otp=1&timeout=1');
    expect(quick.status).toBe(200);

    // Wait for a message that arrives after the call.
    const after = byRole.body[0].id;
    const pending = api('GET', `/api/projects/hyper/messages/wait?user=customer2&after=${after}&timeout=5`);
    await new Promise((r) => setTimeout(r, 150));
    await mailer('hyper').sendMail({ from: 'a@hyper.app', to: 'customer2@hyper.test', subject: 'Later', text: 'Code 5566' });
    const got = await pending;
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ subject: 'Later', otp: '5566' });

    const timeout = await api('GET', `/api/projects/hyper/messages/wait?user=customer5&after=${got.body.id}&timeout=0.3`);
    expect(timeout.status).toBe(408);
  });

  it('puts unknown recipients in Unassigned and creates one message per envelope recipient', async () => {
    await mailer('hyper').sendMail({
      from: 'a@hyper.app',
      to: 'stranger@example.com',
      bcc: 'customer1@hyper.test',
      subject: 'Hello',
      text: 'hi',
    });
    const unassigned = await api('GET', '/api/projects/hyper/messages?user=unassigned');
    expect(unassigned.body.map((m: any) => m.to)).toContain('stranger@example.com');
    const all = await api('GET', '/api/projects/hyper/messages?q=Hello');
    const bccMsg = all.body.find((m: any) => m.to === 'customer1@hyper.test');
    expect(bccMsg.testUserId).toBeTruthy();
    expect(bccMsg.metadata.bcc).toBe(true);
  });

  it('selects a provider instance with "project.instance" and rejects unknown usernames (logged)', async () => {
    await api('POST', '/api/projects/hyper/providers', { preset: 'smtp', slug: 'marketing', name: 'Marketing SMTP', labels: ['marketing'] });
    await mailer('hyper.marketing').sendMail({ from: 'promo@hyper.app', to: 'customer2@hyper.test', subject: 'Sale', text: '50% off' });
    const inst = (await api('GET', '/api/projects/hyper/providers')).body.find((p: any) => p.slug === 'marketing');
    const viaMarketing = await api('GET', '/api/projects/hyper/messages?provider=marketing');
    expect(viaMarketing.body).toHaveLength(1);
    expect(viaMarketing.body[0].providerInstanceId).toBe(inst.id);

    await expect(mailer('nope').sendMail({ from: 'a@b.c', to: 'x@y.z', text: 'x' })).rejects.toThrow(/Unknown project/);
    const logs = await api('GET', '/api/logs?project=none&protocol=smtp');
    expect(logs.body[0]).toMatchObject({ method: 'AUTH', outcome: 'rejected', errorType: 'auth_failed', resStatus: 535 });
  });

  it('resolves the project from the recipient when the client does not authenticate', async () => {
    await mailer().sendMail({ from: 'a@fleet.app', to: 'customer1@fleet.test', subject: 'No auth', text: 'pin 1234' });
    const msgs = await api('GET', '/api/projects/fleet/messages');
    expect(msgs.body[0]).toMatchObject({ to: 'customer1@fleet.test', otp: '1234' });

    // Ambiguous: no test user anywhere and several projects → rejected at RCPT, and logged.
    await expect(mailer().sendMail({ from: 'a@x.app', to: 'nobody@nowhere.test', text: 'x' })).rejects.toThrow(/cannot tell which project/);
    const log = await waitFor(async () => (await api('GET', '/api/logs?project=none&protocol=smtp')).body.find((l: any) => l.method === 'SMTP' && l.outcome !== 'pending'));
    expect(log).toMatchObject({ outcome: 'rejected', resStatus: 550 });
  });

  it('logs every unmatched HTTP request with its body and returns a request id', async () => {
    const r = await api('POST', '/mock/hyper/sms-primary/2010-04-01/Messages.json', 'To=%2B923000000002&Body=hi', {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(r.status).toBe(404);
    const id = r.headers.get('x-hub-request-id');
    expect(id).toBeTruthy();
    expect(r.body.hint).toMatch(/Mock URLs/);
    const log = await api('GET', `/api/logs/${id}`);
    expect(log.body).toMatchObject({ outcome: 'unmatched', resStatus: 404, method: 'POST', reqBody: 'To=%2B923000000002&Body=hi' });
    expect(log.body.resBody).toContain('no route');
    // Attached to the project named in the URL, so it shows in that project's traffic log.
    const hyper = await api('GET', '/api/projects/hyper');
    expect(log.body.projectId).toBe(hyper.body.id);
    const unknown = await api('POST', '/mock/no-such-project/sms/x', '{}', { 'content-type': 'application/json' });
    const unknownLog = await api('GET', `/api/logs/${unknown.headers.get('x-hub-request-id')}`);
    expect(unknownLog.body).toMatchObject({ projectId: null, outcome: 'unmatched', resolved: { unknownProject: 'no-such-project' } });
    expect(log.body.durationMs).toBeGreaterThanOrEqual(0);

    // Invalid JSON to an unknown path is still logged (as unmatched, with the raw body).
    const bad = await api('POST', '/hook/hyper/payments', '{not json', { 'content-type': 'application/json' });
    const badLog = await api('GET', `/api/logs/${bad.headers.get('x-hub-request-id')}`);
    expect(badLog.body.reqBody).toBe('{not json');
    expect(badLog.body.resolved.bodyError).toMatch(/Invalid JSON/);

    // Dashboard API calls are not logged; invalid JSON there is a 400.
    const apiBad = await api('POST', '/api/projects', '{oops', { 'content-type': 'application/json' });
    expect(apiBad.status).toBe(400);
    expect(apiBad.headers.get('x-hub-request-id')).toBeNull();
  });

  it('serves the same API over HTTPS with a certificate signed by the local CA', async () => {
    const ca = await fetch(base + '/api/ca.crt').then((r) => r.text());
    expect(ca).toContain('BEGIN CERTIFICATE');
    const port = running.hub.config.httpsPort;
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path: '/api/system', ca, servername: 'localhost' }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(d));
        })
        .on('error', reject);
    });
    expect(JSON.parse(body).ports.https).toBe(port);
  });

  it('streams live events over SSE', async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/stream?project=hyper', { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const chunks: string[] = [];
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        chunks.push(new TextDecoder().decode(value));
        if (chunks.join('').includes('event: message.created')) return;
      }
    })();
    await waitFor(async () => chunks.join('').includes('event: ready'));
    await mailer('hyper').sendMail({ from: 'a@hyper.app', to: 'customer3@hyper.test', subject: 'Live', text: 'x' });
    await reading;
    ctrl.abort();
    expect(chunks.join('')).toContain('customer3@hyper.test');
  });

  it('manages authenticator keys and returns the same codes an authenticator app would', async () => {
    const { totp } = await import('../src/totp/totp.js');
    const ov = await api('GET', '/api/projects/hyper/overview');
    const admin = ov.body.users.find((u: any) => u.role === 'admin');

    // From an otpauth:// link (what the QR code contains), linked to the admin test user.
    const created = await api('POST', '/api/projects/hyper/authenticators', {
      label: 'Admin 2FA',
      secret: 'otpauth://totp/Hyper:admin%40hyper.test?secret=JBSWY3DPEHPK3PXP&issuer=Hyper',
      testUserId: admin.id,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ label: 'Admin 2FA', issuer: 'Hyper', account: 'admin@hyper.test', digits: 6, period: 30, secretHint: '…3PXP' });
    expect(created.body.secret).toBeUndefined();

    // From a raw key with spaces, as many apps display it.
    await api('POST', '/api/projects/hyper/authenticators', { label: 'Driver', secret: 'gezd gnbv gy3t qojq' });

    const list = await api('GET', '/api/projects/hyper/authenticators');
    expect(list.body.items).toHaveLength(2);
    const byLabel = await api('GET', '/api/projects/hyper/authenticators/code?label=admin%202fa');
    const expected = totp({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 });
    // Allow for a period boundary between the two computations.
    expect([expected.code, expected.nextCode]).toContain(byLabel.body.code);
    expect(byLabel.body.remaining).toBeGreaterThan(0);

    const secret = await api('GET', `/api/projects/hyper/authenticators/${created.body.id}/secret`);
    expect(secret.body.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(secret.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Hyper%3Aadmin%40hyper\.test\?secret=JBSWY3DPEHPK3PXP/);

    const bad = await api('POST', '/api/projects/hyper/authenticators', { label: 'x', secret: 'not base32!' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/base32/);

    // Keys can be deleted.
    const del = await api('DELETE', `/api/projects/hyper/authenticators/${list.body.items.find((a: any) => a.label === 'Driver').id}`);
    expect(del.status).toBe(200);
  });

  // ---------------- phase 2: SMS / WhatsApp simulators and rules ----------------

  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  const twilioSend = (to: string, body: string, headers: Record<string, string> = {}, instance = 'sms') =>
    api('POST', `/mock/hyper/${instance}/2010-04-01/Accounts/ACtest/Messages.json`, form({ To: to, From: '+15550001111', Body: body }), {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    });
  const user = async (ref: string) => (await api('GET', `/api/projects/hyper/users/${ref}`)).body;
  const callbacks = (sid: string) => received.filter((r) => r.path.startsWith('/sms/status') && new URLSearchParams(r.body).get('MessageSid') === sid);

  it('simulates Twilio SMS: 201 queued, message in the inbox, sent + delivered callbacks, fetch', async () => {
    const created = await api('POST', '/api/projects/hyper/providers', {
      preset: 'twilio',
      slug: 'sms',
      labels: ['primary'],
      config: { statusCallbackUrl: `${appUrl}/sms/status`, inboundUrl: `${appUrl}/sms/inbound`, authToken: 'secret' },
    });
    expect(created.status).toBe(201);
    const c1 = await user('customer1');
    const r = await twilioSend(c1.phone, 'Your Hyper code is 7781');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'queued', to: c1.phone, body: 'Your Hyper code is 7781' });
    expect(r.body.sid).toMatch(/^SM[0-9a-f]{32}$/);

    const [m] = (await api('GET', '/api/projects/hyper/messages?user=customer1&channel=sms')).body;
    expect(m).toMatchObject({ channel: 'sms', status: 'delivered', otp: '7781', providerMessageId: r.body.sid });

    await waitFor(async () => callbacks(r.body.sid).length >= 2);
    const statuses = callbacks(r.body.sid).map((c) => new URLSearchParams(c.body).get('MessageStatus'));
    expect(statuses).toEqual(['sent', 'delivered']);
    expect(callbacks(r.body.sid)[0].headers['x-twilio-signature']).toBeTruthy();

    const fetched = await api('GET', `/mock/hyper/sms/2010-04-01/Accounts/ACtest/Messages/${r.body.sid}.json`);
    expect(fetched.body).toMatchObject({ sid: r.body.sid, status: 'delivered' });

    // Validation errors look like Twilio's.
    const bad = await api('POST', '/mock/hyper/sms/2010-04-01/Accounts/ACtest/Messages.json', form({ From: '+1555' }), { 'content-type': 'application/x-www-form-urlencoded' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 21604 });
  });

  it('applies user rules: "fail next 1" then deliver, with an undelivered callback', async () => {
    const add = await api('POST', '/api/projects/hyper/users/customer1/rules', { channel: 'sms', action: 'fail', count: 1, errorCode: '30003', errorMessage: 'Unreachable' });
    expect(add.status).toBe(201);
    const c1 = await user('customer1');
    const first = await twilioSend(c1.phone, 'try 1');
    expect(first.status).toBe(201); // accepted; the failure comes as a delivery report
    await waitFor(async () => callbacks(first.body.sid).length >= 2);
    const last = new URLSearchParams(callbacks(first.body.sid).at(-1)!.body);
    expect(last.get('MessageStatus')).toBe('undelivered');
    expect(last.get('ErrorCode')).toBe('30003');
    const [failed] = (await api('GET', '/api/projects/hyper/messages?user=customer1&channel=sms&limit=1')).body;
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.appliedRule).toMatchObject({ level: 'user', action: 'fail' });

    const second = await twilioSend(c1.phone, 'try 2');
    const [ok] = (await api('GET', '/api/projects/hyper/messages?user=customer1&channel=sms&limit=1')).body;
    expect(second.status).toBe(201);
    expect(ok.status).toBe('delivered');
    const rules = (await api('GET', '/api/projects/hyper/users/customer1/rules')).body;
    expect(rules[0]).toMatchObject({ active: false, hits: 1, remainingCount: 0 });
  });

  it('applies instance rules (down → 503), the X-Hub-Scenario header and rule presets', async () => {
    await api('POST', '/api/projects/hyper/providers/sms/rules/preset/down-10m');
    const c2 = await user('customer2');
    const down = await twilioSend(c2.phone, 'otp 1111');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: 20503 });
    const [rejected] = (await api('GET', '/api/projects/hyper/messages?user=customer2&channel=sms&limit=1')).body;
    expect(rejected.status).toBe('rejected');
    // A rejected message's code is not "received": the latest-code API ignores it.
    expect((await api('GET', '/api/projects/hyper/users/customer2/latest?otp=1&channel=sms')).status).toBe(404);
    expect((await api('DELETE', '/api/projects/hyper/providers/sms/rules')).body).toEqual({ deleted: 1 });

    const limited = await twilioSend(c2.phone, 'x', { 'x-hub-scenario': 'rate_limit' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe(20429);

    // Timeout: no answer; when the app gives up, the log still says "simulated timeout".
    const ac = new AbortController();
    const pending = fetch(base + '/mock/hyper/sms/2010-04-01/Accounts/ACtest/Messages.json', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-hub-scenario': 'timeout' },
      body: form({ To: c2.phone, From: '+1555', Body: 'x' }),
      signal: ac.signal,
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    expect(await pending).toBeInstanceOf(Error);
    const tlog = await waitFor(async () => {
      const [l] = (await api('GET', '/api/logs?project=hyper&outcome=forced_error&limit=1')).body;
      return l?.errorType === 'simulated_timeout' ? l : null;
    });
    expect(tlog.outcome).toBe('forced_error');

    const presets = (await api('GET', '/api/rule-presets')).body;
    expect(presets.map((p: any) => p.id)).toContain('first-ok-then-fail');
  });

  it('simulates Meta WhatsApp Cloud API with signed status webhooks, and duplicate detection', async () => {
    await api('POST', '/api/projects/hyper/providers', { preset: 'meta-whatsapp', slug: 'wa', config: { statusCallbackUrl: `${appUrl}/wa/hook`, appSecret: 's3cret' } });
    const c3 = await user('customer3');
    const r = await api('POST', '/mock/hyper/wa/v21.0/123456/messages', {
      messaging_product: 'whatsapp',
      to: c3.whatsapp.replace('+', ''),
      type: 'template',
      template: { name: 'otp_code', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '424242' }] }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.messages[0].id).toMatch(/^wamid\./);
    const [m] = (await api('GET', '/api/projects/hyper/messages?user=customer3&channel=whatsapp')).body;
    expect(m).toMatchObject({ status: 'delivered', otp: '424242' });
    await waitFor(async () => received.filter((x) => x.path === '/wa/hook').length >= 2);
    const hook = received.filter((x) => x.path === '/wa/hook').at(-1)!;
    expect(JSON.parse(hook.body).entry[0].changes[0].value.statuses[0]).toMatchObject({ id: r.body.messages[0].id, status: 'delivered' });
    expect(hook.headers['x-hub-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Missing messaging_product → Graph-style error.
    const bad = await api('POST', '/mock/hyper/wa/v21.0/123456/messages', { to: '1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(100);

    // Same SMS via two instances within 60 s → flagged as a duplicate.
    await api('POST', '/api/projects/hyper/providers', { preset: 'generic-sms', slug: 'sms-fallback', labels: ['fallback'] });
    await twilioSend(c3.phone, 'Your code is 9090');
    const g = await api('POST', '/mock/hyper/sms-fallback/send', { to: c3.phone, message: 'Your code is 9090' });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ status: 'queued' });
    const [dup] = (await api('GET', '/api/projects/hyper/messages?user=customer3&channel=sms&limit=1')).body;
    expect(dup.duplicateOfId).toBeTruthy();
    expect(dup.metadata.duplicateWarning).toMatch(/earlier via another provider instance/);

    // A fallback after a rejected primary is fine: no warning.
    await api('POST', '/api/projects/hyper/providers/sms/rules', { action: 'down', count: 1 });
    expect((await twilioSend(c3.phone, 'Fallback code 5150')).status).toBe(503);
    await api('POST', '/mock/hyper/sms-fallback/send', { to: c3.phone, message: 'Fallback code 5150' });
    const [fallback] = (await api('GET', '/api/projects/hyper/messages?user=customer3&channel=sms&limit=1')).body;
    expect(fallback).toMatchObject({ status: 'delivered', duplicateOfId: null, otp: '5150' });
  });

  it('sends inbound replies to the app and rejects marketing to opted-out users', async () => {
    const r = await api('POST', '/api/projects/hyper/users/customer1/reply', { channel: 'sms', text: 'STOP' });
    expect(r.status).toBe(201);
    expect(r.body.webhook).toMatchObject({ ok: true, status: 200 });
    const inbound = received.find((x) => x.path === '/sms/inbound')!;
    const params = new URLSearchParams(inbound.body);
    expect(params.get('Body')).toBe('STOP');
    expect(params.get('From')).toBe((await user('customer1')).phone);
    expect(r.body.message).toMatchObject({ direction: 'inbound', status: 'received' });

    await api('POST', '/api/projects/hyper/providers', { preset: 'vonage', slug: 'promo', labels: ['marketing'] });
    const c4 = await user('customer4');
    await api('PATCH', `/api/projects/hyper/users/${c4.id}`, { marketingOptOut: true });
    const v = await api('POST', '/mock/hyper/promo/sms/json', { api_key: 'k', api_secret: 's', from: 'HYPER', to: c4.phone.replace('+', ''), text: 'Sale!' });
    expect(v.status).toBe(200);
    expect(v.body.messages[0]).toMatchObject({ status: '7' });
  });

  it('applies email rules: hard bounce at RCPT, delayed bounce with a DSN to the sender, delayed delivery + wait', async () => {
    await api('POST', '/api/projects/hyper/users/customer5/rules', { channel: 'email', action: 'bounce_hard', count: 1 });
    await expect(mailer('hyper').sendMail({ from: 'app@hyper.app', to: 'customer5@hyper.test', subject: 'x', text: 'x' })).rejects.toThrow(/550/);

    await api('POST', '/api/projects/hyper/users/customer5/rules', { channel: 'email', action: 'bounce_delayed', delayMs: 200, count: 1 });
    await mailer('hyper').sendMail({ from: 'bounces@hyper.app', to: 'customer5@hyper.test', subject: 'Receipt', text: 'thanks' });
    const bounced = await waitFor(async () => {
      const [m] = (await api('GET', '/api/projects/hyper/messages?user=customer5&limit=1')).body;
      return m?.status === 'bounced' ? m : null;
    });
    expect(bounced.subject).toBe('Receipt');
    const dsn = await waitFor(async () => (await api('GET', '/api/projects/hyper/messages?to=bounces@hyper.app')).body[0]);
    expect(dsn).toMatchObject({ from: 'MAILER-DAEMON@devhub.local', subject: 'Undelivered Mail Returned to Sender' });

    // A delayed message counts for the wait API only once it is delivered.
    await api('POST', '/api/projects/hyper/users/customer6/rules', { channel: 'email', action: 'delay', delayMs: 300, count: 1 });
    const t0 = Date.now();
    const waiting = api('GET', '/api/projects/hyper/messages/wait?user=customer6&otp=1&timeout=5');
    await mailer('hyper').sendMail({ from: 'a@hyper.app', to: 'customer6@hyper.test', subject: 'Code', text: 'Code 3141' });
    const got = await waiting;
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ otp: '3141', status: 'delivered' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('blocks other web pages from the dashboard API (DNS rebinding, cross-site forms) but not provider mocks', async () => {
    // Unknown Host (DNS rebinding)
    // (fetch() drops a custom Host header, so use a raw request)
    const rawStatus = (hostHeader: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(base);
        http.get({ host: u.hostname, port: u.port, path: '/api/system', headers: { host: hostHeader } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
      });
    expect(await rawStatus('evil.example')).toBe(403);
    expect(await rawStatus('evil.example:4000')).toBe(403);
    expect(await rawStatus('localhost:4000')).toBe(200);
    expect(await rawStatus('host.docker.internal:4000')).toBe(200);
    // A form on another website posting to factory reset / project reset
    const form = await api('POST', '/api/factory-reset', 'confirm=DELETE+EVERYTHING', { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' });
    expect(form.status).toBe(403);
    expect((await api('POST', '/api/projects/hyper/reset', '', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await api('POST', '/api/projects/hyper/reset', '', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // Non-JSON bodies are refused even without an Origin
    expect((await api('POST', '/api/factory-reset', 'confirm=DELETE+EVERYTHING', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    // The dashboard itself (same-origin) and curl (no Origin) still work
    expect((await api('GET', '/api/projects', undefined, { origin: base, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // Mocks stay open to any caller
    expect((await api('POST', '/mock/hyper/nope/x', '{}', { 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(404);
    expect((await api('GET', '/api/projects/hyper')).status).toBe(200);
  });

  it('serves an MCP endpoint whose tools wrap the API', async () => {
    const rpc = (method: string, params: unknown = {}, id: number | null = 1) =>
      api('POST', '/mcp', { jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params }, { accept: 'application/json, text/event-stream' });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'devhub' }, capabilities: { tools: {} } });
    expect((await rpc('notifications/initialized', {}, null)).status).toBe(202);

    const list = await rpc('tools/list');
    const names = list.body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['wait_for_message', 'get_latest_code', 'set_user_scenario', 'get_2fa_code']));

    const code = await rpc('tools/call', { name: 'get_latest_code', arguments: { project: 'hyper', user: 'admin' } });
    expect(code.body.result.isError).toBeUndefined();
    expect(code.body.result.structuredContent).toMatchObject({ otp: '482913' });

    const scenario = await rpc('tools/call', { name: 'set_user_scenario', arguments: { project: 'hyper', user: 'admin', action: 'nope' } });
    expect(scenario.body.result.isError).toBe(true);
    expect(scenario.body.result.content[0].text).toMatch(/Unknown action/);

    expect((await rpc('does/not/exist')).body.error.code).toBe(-32601);
    expect((await api('GET', '/mcp')).status).toBe(405);
  });

  it('clears an inbox, resets a project and deletes it (removing emails from Mailpit)', async () => {
    const ov = await api('GET', '/api/projects/hyper/overview');
    const admin = ov.body.users.find((u: any) => u.role === 'admin');
    const cleared = await api('POST', `/api/projects/hyper/users/${admin.id}/clear`);
    expect(cleared.body.messages).toBe(1);

    const reset = await api('POST', '/api/projects/hyper/reset');
    expect(reset.body.messages).toBeGreaterThan(0);
    expect(reset.body.logs).toBeGreaterThan(0);
    const after = await api('GET', '/api/projects/hyper/overview');
    expect(after.body.users).toHaveLength(10); // config kept
    expect(after.body.stats.messages).toBe(0);

    const del = await api('DELETE', '/api/projects/fleet');
    expect(del.body.deleted).toBe('fleet');
    const mp = await fetch(`${running.hub.mailpit!.baseUrl}/api/v1/messages`).then((r) => r.json());
    expect(mp.total).toBe(0);
  });
});
