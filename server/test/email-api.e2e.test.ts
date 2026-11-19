import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer';
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

/** A fake "app" that receives event webhooks. */
const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let appServer: http.Server;
let appUrl: string;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers; text: string }> {
  const isForm = body instanceof FormData;
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined && !isForm && !('content-type' in headers) ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isForm || typeof body === 'string' ? (body as BodyInit) : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers, text };
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

const user = async (ref: string) => (await api('GET', `/api/projects/hyper/users/${ref}`)).body;
const latest = async (ref: string) => (await api('GET', `/api/projects/hyper/messages?user=${ref}&channel=email&limit=1`)).body[0];
const hooks = (prefix: string) => received.filter((r) => r.path.startsWith(prefix));

describe.skipIf(!haveMailpit)('email API providers end-to-end', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-email-api-test-'));
    const [httpPort, httpsPort, smtpPort, mpHttp, mpSmtp] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
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
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    base = `http://127.0.0.1:${httpPort}`;
    const r = await api('POST', '/api/projects', { name: 'Hyper', generateUsers: { admins: 1, customers: 9 } });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ---------------- SendGrid ----------------
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sgSend = (body: unknown, headers: Record<string, string> = {}) => api('POST', '/mock/hyper/sendgrid/v3/mail/send', body, { authorization: 'Bearer SG.test', 'content-type': 'application/json', ...headers });
  const sgEvents = (to: string) => hooks('/sg').flatMap((h) => JSON.parse(h.body) as any[]).filter((e) => e.email === to);

  it('lists email presets as available with their config fields', async () => {
    const presets = (await api('GET', '/api/presets')).body;
    if (Array.isArray(presets)) expect(presets.filter((p: any) => p.channel === 'email').every((p: any) => p.available)).toBe(true);
    const fields = (await api('GET', '/api/presets/sendgrid/fields')).body;
    expect(fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['apiKey', 'eventWebhookUrl', 'eventWebhookPrivateKey']));
    expect((await api('GET', '/api/presets/mailgun/fields')).body.map((f: any) => f.key)).toEqual(expect.arrayContaining(['domain', 'webhookSigningKey']));
    expect((await api('GET', '/api/presets/ses/fields')).body.length).toBeGreaterThan(0);
    expect((await api('GET', '/api/presets/generic-email/fields')).body.length).toBeGreaterThan(0);
  });

  it('SendGrid: 202 + X-Message-Id, email in the inbox with OTP, signed processed/delivered events', async () => {
    const created = await api('POST', '/api/projects/hyper/providers', {
      preset: 'sendgrid',
      slug: 'sendgrid',
      config: { apiKey: 'SG.test', eventWebhookUrl: `${appUrl}/sg`, eventWebhookPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    });
    expect(created.status).toBe(201);
    const c1 = await user('customer1');
    const c2 = await user('customer2');
    const r = await sgSend({
      personalizations: [{ to: [{ email: c1.email, name: 'C1' }], cc: [{ email: c2.email }], custom_args: { orderId: '42' } }],
      from: { email: 'no-reply@hyper.app', name: 'Hyper' },
      subject: 'Sign in to Hyper',
      content: [
        { type: 'text/plain', value: 'Your verification code is 551234' },
        { type: 'text/html', value: '<p>Your verification code is <b>551234</b></p>' },
      ],
      categories: ['otp'],
    });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
    const xid = r.headers.get('x-message-id');
    expect(xid).toMatch(/^[\w-]{22}$/);

    const m = await latest('customer1');
    expect(m).toMatchObject({ channel: 'email', status: 'delivered', otp: '551234', providerMessageId: xid, subject: 'Sign in to Hyper', from: 'no-reply@hyper.app' });
    expect(m.mailpitId).toBeTruthy();
    expect((await latest('customer2')).providerMessageId).toBe(xid);

    // The email really is in Mailpit, tagged with project and instance.
    const mp = (await api('GET', `/mailpit/api/v1/message/${m.mailpitId}`)).body;
    expect(mp.Subject).toBe('Sign in to Hyper');
    expect(mp.Tags).toEqual(expect.arrayContaining(['project-hyper', 'instance-sendgrid']));
    expect(mp.Cc.map((a: any) => a.Address)).toContain(c2.email);

    await waitFor(() => sgEvents(c1.email).length >= 2);
    const evs = sgEvents(c1.email);
    expect(evs.map((e) => e.event)).toEqual(['processed', 'delivered']);
    expect(evs[1]).toMatchObject({ email: c1.email, orderId: '42', category: ['otp'] });
    expect(evs[1].sg_message_id.startsWith(xid!)).toBe(true);
    const hook = hooks('/sg').find((h) => h.body.includes('"delivered"') && h.body.includes(c1.email))!;
    const ts = String(hook.headers['x-twilio-email-event-webhook-timestamp']);
    const sig = String(hook.headers['x-twilio-email-event-webhook-signature']);
    expect(verify('sha256', Buffer.from(ts + hook.body), publicKey, Buffer.from(sig, 'base64'))).toBe(true);

    const after = (await api('GET', `/api/projects/hyper/messages?user=customer1&channel=email&limit=1`)).body[0];
    expect(after.metadata.reports.map((x: any) => x.status)).toEqual(['processed', 'delivered']);
  });

  it('SendGrid: validation errors, 401, rate limit at send time, hard bounce via events, opt-out dropped', async () => {
    const bad = await sgSend({ subject: 'x', content: [{ type: 'text/plain', value: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: any) => e.field)).toEqual(expect.arrayContaining(['from.email', 'personalizations']));
    expect(bad.body.errors[0]).toHaveProperty('help');
    const invalid = await sgSend({ personalizations: [{ to: [{ email: 'nope' }] }], from: { email: 'a@b.co' }, subject: 's', content: [{ type: 'text/plain', value: 'x' }] });
    expect(invalid.body.errors).toEqual([expect.objectContaining({ field: 'personalizations.0.to.0.email', message: 'Does not contain a valid address.' })]);
    const unauth = await sgSend({}, { authorization: 'Bearer wrong' });
    expect(unauth.status).toBe(401);
    expect(unauth.body.errors[0].message).toMatch(/authorization grant is invalid/);

    const c3 = await user('customer3');
    const mail = (subject: string) => ({ personalizations: [{ to: [{ email: c3.email }] }], from: { email: 'no-reply@hyper.app' }, subject, content: [{ type: 'text/plain', value: subject }] });
    const limited = await sgSend(mail('limited'), { 'x-hub-scenario': 'rate_limit' });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ errors: [{ field: null, message: 'too many requests', help: null }] });
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(await latest('customer3')).toMatchObject({ status: 'rejected' });

    await api('POST', '/api/projects/hyper/users/customer3/rules', { channel: 'email', action: 'bounce_hard', count: 1 });
    const bounced = await sgSend(mail('will bounce'));
    expect(bounced.status).toBe(202); // accepted; the bounce comes as an event
    expect(await latest('customer3')).toMatchObject({ status: 'bounced', subject: 'will bounce' });
    await waitFor(() => sgEvents(c3.email).some((e) => e.event === 'bounce'));
    const b = sgEvents(c3.email).find((e) => e.event === 'bounce');
    expect(b).toMatchObject({ type: 'bounce', status: '5.1.1' });
    expect(b.reason).toMatch(/^550 5\.1\.1/);

    // Marketing opt-out: SendGrid accepts and reports "dropped".
    await api('PATCH', '/api/projects/hyper/providers/sendgrid', { labels: ['marketing'] });
    const c4 = await user('customer4');
    expect((await api('PATCH', `/api/projects/hyper/users/${c4.id}`, { marketingOptOut: true })).body.marketingOptOut).toBe(true);
    const dropped = await sgSend({ ...mail('promo'), personalizations: [{ to: [{ email: c4.email }] }] });
    expect(dropped.status).toBe(202);
    expect(await latest('customer4')).toMatchObject({ status: 'dropped' });
    await waitFor(() => sgEvents(c4.email).some((e) => e.event === 'dropped'));
    expect(sgEvents(c4.email).find((e) => e.event === 'dropped').reason).toBe('Unsubscribed Address');
    await api('PATCH', '/api/projects/hyper/providers/sendgrid', { labels: [] });
  });

  it('SendGrid: dynamic templates render their data so codes are extracted; sandbox mode is not delivered', async () => {
    const c5 = await user('customer5');
    const r = await sgSend({ personalizations: [{ to: [{ email: c5.email }], dynamic_template_data: { code: '908172', name: 'C5' } }], from: { email: 'no-reply@hyper.app' }, template_id: 'd-123' });
    expect(r.status).toBe(202);
    const m = await latest('customer5');
    expect(m).toMatchObject({ otp: '908172', subject: 'Template d-123' });
    const sandbox = await sgSend({ ...{ personalizations: [{ to: [{ email: c5.email }] }], from: { email: 'a@hyper.app' }, subject: 'sbx', content: [{ type: 'text/plain', value: 'x' }] }, mail_settings: { sandbox_mode: { enable: true } } });
    expect(sandbox.status).toBe(200);
    expect((await latest('customer5')).subject).toBe('Template d-123');
  });

  // ---------------- Mailgun ----------------
  const mgAuth = { authorization: 'Basic ' + Buffer.from('api:key-test').toString('base64') };
  const mgEvents = (to: string) => hooks('/mg').map((h) => JSON.parse(h.body)).filter((e) => e['event-data'].recipient === to);

  it('Mailgun: multipart send → Queued id, inbox OTP, HMAC-signed webhooks with user variables', async () => {
    await api('POST', '/api/projects/hyper/providers', {
      preset: 'mailgun',
      slug: 'mailgun',
      config: { domain: 'mg.hyper.app', apiKey: 'key-test', webhookSigningKey: 'whsec-test', eventWebhookUrl: `${appUrl}/mg` },
    });
    const c6 = await user('customer6');
    const fd = new FormData();
    fd.append('from', 'Hyper <no-reply@mg.hyper.app>');
    fd.append('to', c6.email);
    fd.append('subject', 'Your login code');
    fd.append('text', 'Use 734512 to sign in');
    fd.append('o:tag', 'login');
    fd.append('v:order', 'A-1');
    fd.append('attachment', new Blob(['hello']), 'note.txt');
    const r = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', fd, mgAuth);
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Queued. Thank you.');
    expect(r.body.id).toMatch(/^<\d{14}\.[0-9A-F]{16}@mg\.hyper\.app>$/);
    const m = await latest('customer6');
    expect(m).toMatchObject({ status: 'delivered', otp: '734512', providerMessageId: r.body.id, attachments: 1 });

    await waitFor(() => mgEvents(c6.email).length >= 2);
    const evs = mgEvents(c6.email);
    expect(evs.map((e) => e['event-data'].event)).toEqual(['accepted', 'delivered']);
    const d = evs[1];
    expect(d['event-data']).toMatchObject({ tags: ['login'], 'user-variables': { order: 'A-1' }, 'delivery-status': { code: 250 } });
    expect(d['event-data'].message.headers['message-id']).toBe(r.body.id.slice(1, -1));
    const expected = createHmac('sha256', 'whsec-test').update(d.signature.timestamp + d.signature.token).digest('hex');
    expect(d.signature.signature).toBe(expected);
  });

  it('Mailgun: errors (validation, auth, domain, provider down) and a complaint', async () => {
    const c7 = await user('customer7');
    const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const urlenc = { 'content-type': 'application/x-www-form-urlencoded', ...mgAuth };
    const noTo = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', form({ from: 'a@mg.hyper.app', subject: 's', text: 't' }), urlenc);
    expect(noTo).toMatchObject({ status: 400, body: { message: 'to parameter is missing' } });
    const noBody = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', form({ from: 'a@mg.hyper.app', to: c7.email, subject: 's' }), urlenc);
    expect(noBody.body.message).toBe("Need at least one of 'text', 'html' or 'template' parameters specified");
    const unauth = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', form({ to: c7.email }), { 'content-type': 'application/x-www-form-urlencoded' });
    expect(unauth.status).toBe(401);
    expect(unauth.text).toBe('Forbidden');
    const domain = await api('POST', '/mock/hyper/mailgun/v3/other.com/messages', form({ to: c7.email }), urlenc);
    expect(domain).toMatchObject({ status: 404, body: { message: 'Domain not found: other.com' } });

    await api('POST', '/api/projects/hyper/providers/mailgun/rules', { action: 'down', count: 1 });
    const down = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', form({ from: 'a@mg.hyper.app', to: c7.email, subject: 's', text: 'down' }), urlenc);
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ message: 'Service Unavailable' });

    await api('POST', '/api/projects/hyper/users/customer7/rules', { channel: 'email', action: 'complaint', count: 1 });
    const ok = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', form({ from: 'a@mg.hyper.app', to: c7.email, subject: 'promo', text: 'Big sale' }), urlenc);
    expect(ok.status).toBe(200);
    expect(await latest('customer7')).toMatchObject({ status: 'delivered', subject: 'promo' });
    await waitFor(() => mgEvents(c7.email).some((e) => e['event-data'].event === 'complained'));
    expect(mgEvents(c7.email).map((e) => e['event-data'].event)).toEqual(['accepted', 'delivered', 'complained']);
    await waitFor(async () => (await latest('customer7')).status === 'complained');
  });

  // ---------------- Amazon SES ----------------
  const sesSend = (body: unknown, headers: Record<string, string> = {}) => api('POST', '/mock/hyper/ses/v2/email/outbound-emails', body, headers);
  const sesNotes = (to: string) =>
    hooks('/ses')
      .map((h) => ({ h, env: JSON.parse(h.body) }))
      .map((x) => ({ ...x, msg: JSON.parse(x.env.Message) }))
      .filter((x) => x.msg.mail.destination.includes(to) || x.msg.mail.commonHeaders.to.includes(to));

  it('Amazon SES v2: Simple + Raw sends, MessageId, SNS Delivery notification', async () => {
    await api('POST', '/api/projects/hyper/providers', { preset: 'ses', slug: 'ses', config: { eventWebhookUrl: `${appUrl}/ses`, region: 'eu-west-1' } });
    const c8 = await user('customer8');
    const r = await sesSend({
      FromEmailAddress: 'no-reply@hyper.app',
      Destination: { ToAddresses: [c8.email] },
      Content: { Simple: { Subject: { Data: 'Reset your password' }, Body: { Html: { Data: '<p>Code: <b>660021</b></p>' } } } },
      EmailTags: [{ Name: 'flow', Value: 'reset' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.MessageId).toMatch(/^0100019[0-9a-f]{9}-[0-9a-f-]{36}-000000$/);
    expect(await latest('customer8')).toMatchObject({ status: 'delivered', otp: '660021', providerMessageId: r.body.MessageId });

    await waitFor(() => sesNotes(c8.email).length >= 1);
    const n = sesNotes(c8.email)[0];
    expect(n.h.headers['x-amz-sns-message-type']).toBe('Notification');
    expect(n.env).toMatchObject({ Type: 'Notification', SignatureVersion: '1' });
    expect(n.msg).toMatchObject({ notificationType: 'Delivery', mail: { messageId: r.body.MessageId, source: 'no-reply@hyper.app' }, delivery: { recipients: [c8.email] } });

    const raw = await new MailComposer({ from: 'no-reply@hyper.app', to: c8.email, subject: 'Raw one', text: 'Raw code 445566' }).compile().build();
    const rr = await sesSend({ Content: { Raw: { Data: raw.toString('base64') } } });
    expect(rr.status).toBe(200);
    expect(await latest('customer8')).toMatchObject({ subject: 'Raw one', otp: '445566', providerMessageId: rr.body.MessageId });
  });

  it('Amazon SES v2: validation and send-time errors, a bounce that arrives later', async () => {
    const c9 = await user('customer9');
    const bad = await sesSend({ FromEmailAddress: 'a@hyper.app', Destination: { ToAddresses: [c9.email] } });
    expect(bad.status).toBe(400);
    expect(bad.headers.get('x-amzn-errortype')).toBe('BadRequestException');
    expect(bad.body.message).toMatch(/Content is required/);
    const simple = { FromEmailAddress: 'a@hyper.app', Destination: { ToAddresses: [c9.email] }, Content: { Simple: { Subject: { Data: 's' }, Body: { Text: { Data: 'later bounce' } } } } };
    const rejected = await sesSend(simple, { 'x-hub-scenario': 'reject' });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get('x-amzn-errortype')).toBe('MessageRejected');

    await api('POST', '/api/projects/hyper/users/customer9/rules', { channel: 'email', action: 'bounce_delayed', delayMs: 400, count: 1 });
    const r = await sesSend(simple);
    expect(r.status).toBe(200);
    expect(await latest('customer9')).toMatchObject({ status: 'delivered' });
    await waitFor(() => sesNotes(c9.email).some((x) => x.msg.notificationType === 'Bounce'));
    expect(sesNotes(c9.email).map((x) => x.msg.notificationType)).toEqual(['Delivery', 'Bounce']);
    const b = sesNotes(c9.email)[1].msg.bounce;
    expect(b).toMatchObject({ bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: c9.email, status: '5.1.1' }] });
    await waitFor(async () => (await latest('customer9')).status === 'bounced');
  });

  // ---------------- Generic email API ----------------
  it('Generic email API: configurable fields, templated response and events, opt-out at send time', async () => {
    await api('POST', '/api/projects/hyper/providers', {
      preset: 'generic-email',
      slug: 'mailer',
      labels: ['marketing'],
      config: { path: '/v1/email', toField: 'recipient.address', eventWebhookUrl: `${appUrl}/gen` },
    });
    const admin = await user('admin');
    const r = await api('POST', '/mock/hyper/mailer/v1/email', { recipient: { address: admin.email }, from: 'ops@hyper.app', subject: 'Admin code', html: '<p>Code 112233</p>' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'queued', to: admin.email });
    expect(r.body.id).toMatch(/^msg_/);
    expect(await latest('admin')).toMatchObject({ status: 'delivered', otp: '112233', providerMessageId: r.body.id });
    await waitFor(() => hooks('/gen').length >= 2);
    expect(hooks('/gen').map((h) => JSON.parse(h.body).event)).toEqual(['processed', 'delivered']);
    expect(JSON.parse(hooks('/gen')[1].body)).toMatchObject({ id: r.body.id, email: admin.email, subject: 'Admin code' });

    const missing = await api('POST', '/mock/hyper/mailer/v1/email', { subject: 'x', text: 'y' });
    expect(missing).toMatchObject({ status: 400, body: { error: { code: 'missing_to' } } });
    const wrongPath = await api('POST', '/mock/hyper/mailer/other', { to: admin.email, text: 'x' });
    expect(wrongPath.status).toBe(404);

    // customer4 opted out of marketing (earlier test); generic APIs reject at send time.
    const c4 = await user('customer4');
    const optOut = await api('POST', '/mock/hyper/mailer/v1/email', { recipient: { address: c4.email }, subject: 'promo', text: 'sale' });
    expect(optOut).toMatchObject({ status: 400, body: { error: { code: 'unsubscribed' } } });
  });

  it('flags a duplicate send through two email API instances and shows setup snippets', async () => {
    const c2 = await user('customer2');
    const text = 'Duplicate check 300400';
    const a = await sgSend({ personalizations: [{ to: [{ email: c2.email }] }], from: { email: 'a@hyper.app' }, subject: 'dup', content: [{ type: 'text/plain', value: text }] });
    expect(a.status).toBe(202);
    const b = await api('POST', '/mock/hyper/mailgun/v3/mg.hyper.app/messages', new URLSearchParams({ from: 'a@mg.hyper.app', to: c2.email, subject: 'dup', text }).toString(), {
      'content-type': 'application/x-www-form-urlencoded',
      ...mgAuth,
    });
    expect(b.status).toBe(200);
    const m = await latest('customer2');
    expect(m.duplicateOfId).toBeTruthy();

    const guide = (await api('GET', '/api/projects/hyper/setup')).body;
    const titles = guide.sections.flatMap((s: any) => s.snippets.map((x: any) => x.title));
    expect(titles).toEqual(expect.arrayContaining(['Node.js (@sendgrid/mail)', 'Node.js (mailgun.js)', 'Node.js (@aws-sdk/client-sesv2)']));
  });

  it('answers SMTP instances on /mock with a hint instead of a crash', async () => {
    const r = await api('POST', '/mock/hyper/mail/v3/mail/send', {});
    expect(r.status).toBe(404);
    expect(r.body.message).toMatch(/SMTP provider instance/);
  });
});
