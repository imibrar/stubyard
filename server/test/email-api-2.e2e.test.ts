import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
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
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined && !('content-type' in headers) ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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
const provider = async (preset: string, config: Record<string, string>) => expect((await api('POST', '/api/projects/hyper/providers', { preset, slug: preset, config })).status).toBe(201);

describe.skipIf(!haveMailpit)('email API providers (Resend, Postmark, Brevo, Mailjet, Mandrill) end-to-end', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-email-api-2-test-'));
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
    const r = await api('POST', '/api/projects', { name: 'Hyper', generateUsers: { admins: 1, customers: 10 } });
    expect(r.status).toBe(201);
  });

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the new email presets with their config fields and setup snippets', async () => {
    for (const id of ['resend', 'postmark', 'brevo', 'mailjet', 'mandrill']) {
      const fields = (await api('GET', `/api/presets/${id}/fields`)).body;
      expect(fields.map((f: any) => f.key)).toEqual(expect.arrayContaining(['apiKey', 'eventWebhookUrl']));
    }
  });

  // ---------------- Resend ----------------
  const SECRET = 'whsec_' + Buffer.from('test-resend-secret').toString('base64');
  const rsSend = (p: string, body: unknown, key = 're_test') => api('POST', `/mock/hyper/resend${p}`, body, { authorization: `Bearer ${key}` });

  it('Resend: { id }, inbox with OTP and attachment, Svix-signed email.sent / email.delivered', async () => {
    await provider('resend', { apiKey: 're_test', eventWebhookUrl: `${appUrl}/resend`, webhookSecret: SECRET });
    const c1 = await user('customer1');
    const r = await rsSend('/emails', {
      from: 'Hyper <no-reply@hyper.app>',
      to: [c1.email],
      subject: 'Sign in to Hyper',
      html: '<p>Your verification code is <b>402913</b></p>',
      attachments: [{ filename: 'terms.txt', content: Buffer.from('terms').toString('base64') }],
      tags: [{ name: 'category', value: 'otp' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    const m = await latest('customer1');
    expect(m).toMatchObject({ status: 'delivered', otp: '402913', providerMessageId: r.body.id, attachments: 1, from: 'no-reply@hyper.app' });
    expect(m.mailpitId).toBeTruthy();

    await waitFor(() => hooks('/resend').filter((h) => h.body.includes(c1.email)).length >= 2);
    const evs = hooks('/resend').filter((h) => h.body.includes(c1.email));
    expect(evs.map((h) => JSON.parse(h.body).type)).toEqual(['email.sent', 'email.delivered']);
    const delivered = JSON.parse(evs[1].body);
    expect(delivered.data).toMatchObject({ email_id: r.body.id, to: [c1.email], subject: 'Sign in to Hyper', tags: { category: 'otp' } });
    // Svix verification, done by hand.
    const h = evs[1].headers;
    const expected = createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${h['svix-id']}.${h['svix-timestamp']}.${evs[1].body}`).digest('base64');
    expect(h['svix-signature']).toBe(`v1,${expected}`);
  });

  it('Resend: batch, validation and key errors, rate limit, hard bounce event', async () => {
    const c2 = await user('customer2');
    const batch = await rsSend('/emails/batch', [
      { from: 'no-reply@hyper.app', to: c2.email, subject: 'One', text: 'one' },
      { from: 'no-reply@hyper.app', to: c2.email, subject: 'Two', text: 'two' },
    ]);
    expect(batch.status).toBe(200);
    expect(batch.body.data).toHaveLength(2);
    expect(batch.body.data[0].id).not.toBe(batch.body.data[1].id);

    const unauth = await rsSend('/emails', { from: 'a@b.co', to: c2.email, subject: 's', text: 'x' }, 're_wrong');
    expect(unauth.status).toBe(401);
    expect(unauth.body).toEqual({ statusCode: 401, name: 'validation_error', message: 'API key is invalid' });
    const missing = await rsSend('/emails', { to: c2.email, subject: 's', text: 'x' });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ statusCode: 422, name: 'missing_required_field' });
    const invalid = await rsSend('/emails', { from: 'a@b.co', to: 'nope', subject: 's', text: 'x' });
    expect(invalid.body.name).toBe('validation_error');

    const limited = await api('POST', '/mock/hyper/resend/emails', { from: 'a@b.co', to: c2.email, subject: 'limited', text: 'x' }, { authorization: 'Bearer re_test', 'x-hub-scenario': 'rate_limit' });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ statusCode: 429, name: 'rate_limit_exceeded' });
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await latest('customer2')).toMatchObject({ status: 'rejected' });

    await api('POST', '/api/projects/hyper/users/customer2/rules', { channel: 'email', action: 'bounce_hard', count: 1 });
    const r = await rsSend('/emails', { from: 'a@b.co', to: c2.email, subject: 'will bounce', text: 'x' });
    expect(r.status).toBe(200);
    await waitFor(() => hooks('/resend').some((h) => JSON.parse(h.body).type === 'email.bounced'));
    const b = JSON.parse(hooks('/resend').find((h) => JSON.parse(h.body).type === 'email.bounced')!.body);
    expect(b.data.bounce).toMatchObject({ type: 'Permanent' });
    expect(b.data.email_id).toBe(r.body.id);
  });

  // ---------------- Postmark ----------------
  const pmSend = (p: string, body: unknown, headers: Record<string, string> = {}) => api('POST', `/mock/hyper/postmark${p}`, body, { 'x-postmark-server-token': 'pm-test', accept: 'application/json', ...headers });

  it('Postmark: ErrorCode 0 response, inbox, Basic-auth Delivery webhook; 401 ErrorCode 10; 406 inactive; batch', async () => {
    await provider('postmark', { apiKey: 'pm-test', eventWebhookUrl: `${appUrl.replace('://', '://hook:pw@')}/postmark` });
    const c3 = await user('customer3');
    const r = await pmSend('/email', {
      From: 'Hyper <no-reply@hyper.app>',
      To: c3.email,
      Subject: 'Reset your password',
      HtmlBody: '<p>Reset: <a href="https://hyper.app/reset?t=abc">link</a> code 778812</p>',
      Tag: 'reset',
      Metadata: { userId: '7' },
      Attachments: [{ Name: 'a.txt', Content: Buffer.from('hello').toString('base64'), ContentType: 'text/plain' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ To: c3.email, ErrorCode: 0, Message: 'OK' });
    expect(r.body.MessageID).toMatch(/^[0-9a-f-]{36}$/);
    expect(await latest('customer3')).toMatchObject({ status: 'delivered', otp: '778812', providerMessageId: r.body.MessageID, attachments: 1 });

    await waitFor(() => hooks('/postmark').some((h) => h.body.includes(c3.email)));
    const hook = hooks('/postmark').find((h) => h.body.includes(c3.email))!;
    expect(hook.headers.authorization).toBe('Basic ' + Buffer.from('hook:pw').toString('base64'));
    expect(JSON.parse(hook.body)).toMatchObject({ RecordType: 'Delivery', MessageID: r.body.MessageID, Recipient: c3.email, Tag: 'reset', Metadata: { userId: '7' }, MessageStream: 'outbound' });

    const unauth = await pmSend('/email', { From: 'a@b.co', To: c3.email, Subject: 's', TextBody: 'x' }, { 'x-postmark-server-token': 'nope' });
    expect(unauth.status).toBe(401);
    expect(unauth.body.ErrorCode).toBe(10);
    const invalid = await pmSend('/email', { From: 'a@b.co', To: c3.email, Subject: 's' });
    expect(invalid.status).toBe(422);
    expect(invalid.body).toEqual({ ErrorCode: 300, Message: 'Provide either email TextBody or HtmlBody or both.' });

    const inactive = await pmSend('/email', { From: 'a@b.co', To: c3.email, Subject: 'blocked', TextBody: 'x' }, { 'x-hub-scenario': 'blocked' });
    expect(inactive.status).toBe(422);
    expect(inactive.body.ErrorCode).toBe(406);
    expect(inactive.body.Message).toContain(c3.email);

    const batch = await pmSend('/email/batch', [
      { From: 'a@b.co', To: c3.email, Subject: 'b1', TextBody: 'x' },
      { From: 'a@b.co', To: c3.email, Subject: 'b2', TextBody: 'y' },
    ]);
    expect(batch.status).toBe(200);
    expect(batch.body).toHaveLength(2);
    expect(batch.body.every((x: any) => x.ErrorCode === 0)).toBe(true);

    const test = await pmSend('/email', { From: 'a@b.co', To: c3.email, Subject: 'test token', TextBody: 'x' }, { 'x-postmark-server-token': 'POSTMARK_API_TEST' });
    expect(test.status).toBe(200);
    expect((await latest('customer3')).subject).not.toBe('test token');
  });

  // ---------------- Brevo ----------------
  it('Brevo: 201 { messageId }, inbox, bearer-auth delivered webhook, 401 unauthorized, hard_bounce', async () => {
    await provider('brevo', { apiKey: 'xkeysib-test', eventWebhookUrl: `${appUrl}/brevo`, webhookBearerToken: 'brevo-hook' });
    const c4 = await user('customer4');
    const send = (body: unknown, headers: Record<string, string> = {}) => api('POST', '/mock/hyper/brevo/v3/smtp/email', body, { 'api-key': 'xkeysib-test', ...headers });
    const r = await send({
      sender: { email: 'no-reply@hyper.app', name: 'Hyper' },
      to: [{ email: c4.email, name: 'C4' }],
      subject: 'Your code',
      htmlContent: '<p>Hello {{params.name}}, your code is {{ params.code }}</p>',
      params: { name: 'Sara', code: '660021' },
      tags: ['otp'],
      headers: { 'X-Mailin-custom': 'order:42' },
      attachment: [{ name: 'x.txt', content: Buffer.from('x').toString('base64') }],
    });
    expect(r.status).toBe(201);
    expect(r.body.messageId).toMatch(/^<\d{12}\.\d+@smtp-relay\.mailin\.fr>$/);
    expect(await latest('customer4')).toMatchObject({ status: 'delivered', otp: '660021', providerMessageId: r.body.messageId, attachments: 1 });

    await waitFor(() => hooks('/brevo').filter((h) => h.body.includes(c4.email)).length >= 2);
    const evs = hooks('/brevo').filter((h) => h.body.includes(c4.email));
    expect(evs.map((h) => JSON.parse(h.body).event)).toEqual(['request', 'delivered']);
    expect(evs[1].headers.authorization).toBe('Bearer brevo-hook');
    expect(JSON.parse(evs[1].body)).toMatchObject({ email: c4.email, 'message-id': r.body.messageId.slice(1, -1), tags: ['otp'], 'X-Mailin-custom': 'order:42' });

    const unauth = await send({}, { 'api-key': 'wrong' });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toEqual({ code: 'unauthorized', message: 'Key not found' });
    const missing = await send({ to: [{ email: c4.email }], subject: 's', textContent: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ code: 'missing_parameter', message: 'sender is missing' });

    const down = await send({ sender: { email: 'a@b.co' }, to: [{ email: c4.email }], subject: 'down', textContent: 'x' }, { 'x-hub-scenario': 'down' });
    expect(down.status).toBe(503);
    expect(down.body.code).toBeTruthy();

    await api('POST', '/api/projects/hyper/users/customer4/rules', { channel: 'email', action: 'bounce_hard', count: 1 });
    await send({ sender: { email: 'a@b.co' }, to: [{ email: c4.email }], subject: 'bounce', textContent: 'x' });
    await waitFor(() => hooks('/brevo').some((h) => JSON.parse(h.body).event === 'hard_bounce'));
    expect(JSON.parse(hooks('/brevo').find((h) => JSON.parse(h.body).event === 'hard_bounce')!.body).reason).toMatch(/^550 5\.1\.1/);

    const versions = await send({ sender: { email: 'a@b.co' }, subject: 'v', textContent: 'x', messageVersions: [{ to: [{ email: c4.email }] }, { to: [{ email: (await user('customer5')).email }] }] });
    expect(versions.status).toBe(201);
    expect(versions.body.messageIds).toHaveLength(2);
  });

  // ---------------- Mailjet ----------------
  it('Mailjet: v3.1 Messages response, inbox, sent event, 401, per-message validation errors, forced reject', async () => {
    await provider('mailjet', { apiKey: 'mj-key', apiSecret: 'mj-secret', eventWebhookUrl: `${appUrl}/mailjet` });
    const c6 = await user('customer6');
    const auth = { authorization: 'Basic ' + Buffer.from('mj-key:mj-secret').toString('base64') };
    const send = (body: unknown, headers: Record<string, string> = auth) => api('POST', '/mock/hyper/mailjet/v3.1/send', body, headers);
    const r = await send({
      Messages: [
        {
          From: { Email: 'no-reply@hyper.app', Name: 'Hyper' },
          To: [{ Email: c6.email, Name: 'C6' }],
          Subject: 'Welcome',
          TextPart: 'Your code is 135790',
          CustomID: 'signup-6',
          EventPayload: 'p=1',
          Attachments: [{ ContentType: 'text/plain', Filename: 'w.txt', Base64Content: Buffer.from('w').toString('base64') }],
        },
      ],
    });
    expect(r.status).toBe(200);
    const msg = r.body.Messages[0];
    expect(msg).toMatchObject({ Status: 'success', CustomID: 'signup-6', Cc: [], Bcc: [] });
    expect(msg.To[0]).toMatchObject({ Email: c6.email });
    expect(Number.isSafeInteger(msg.To[0].MessageID)).toBe(true);
    expect(await latest('customer6')).toMatchObject({ status: 'delivered', otp: '135790', attachments: 1 });

    await waitFor(() => hooks('/mailjet').some((h) => h.body.includes(c6.email)));
    expect(JSON.parse(hooks('/mailjet').find((h) => h.body.includes(c6.email))!.body)).toMatchObject({
      event: 'sent',
      email: c6.email,
      MessageID: msg.To[0].MessageID,
      Message_GUID: msg.To[0].MessageUUID,
      CustomID: 'signup-6',
      Payload: 'p=1',
    });

    const unauth = await send({ Messages: [] }, { authorization: 'Basic ' + Buffer.from('x:y').toString('base64') });
    expect(unauth.status).toBe(401);
    expect(unauth.body.StatusCode).toBe(401);
    const invalid = await send({ Messages: [{ From: { Email: 'a@b.co' }, To: [{ Email: 'nope' }], Subject: 's', TextPart: 'x' }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.Messages[0]).toMatchObject({ Status: 'error', Errors: [expect.objectContaining({ ErrorCode: 'mj-0013', ErrorRelatedTo: ['To[0].Email'] })] });

    const rejected = await api('POST', '/mock/hyper/mailjet/v3.1/send', { Messages: [{ From: { Email: 'a@b.co' }, To: [{ Email: c6.email }], Subject: 'rej', TextPart: 'x' }] }, { ...auth, 'x-hub-scenario': 'reject' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.Messages[0].Status).toBe('error');
    expect(await latest('customer6')).toMatchObject({ status: 'rejected', subject: 'rej' });
  });

  // ---------------- Mailchimp Transactional (Mandrill) ----------------
  it('Mandrill: per-recipient results, merge vars, signed mandrill_events, Invalid_Key, rejected recipients', async () => {
    await provider('mandrill', { apiKey: 'md-test', eventWebhookUrl: `${appUrl}/mandrill`, webhookKey: 'md-hook-key' });
    const c7 = await user('customer7');
    const c8 = await user('customer8');
    const send = (body: Record<string, unknown>, headers: Record<string, string> = {}, p = '/api/1.3/messages/send.json') => api('POST', `/mock/hyper/mandrill${p}`, { key: 'md-test', ...body }, headers);
    const r = await send({
      message: {
        from_email: 'no-reply@hyper.app',
        from_name: 'Hyper',
        to: [
          { email: c7.email, type: 'to' },
          { email: c8.email, type: 'cc' },
        ],
        subject: 'Hi *|FNAME|*',
        text: 'Your code is *|CODE|*',
        global_merge_vars: [{ name: 'code', content: '246810' }],
        merge_vars: [{ rcpt: c7.email, vars: [{ name: 'fname', content: 'Seven' }] }],
        tags: ['otp'],
        metadata: { orderId: '9' },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(r.body[0]).toMatchObject({ email: c7.email, status: 'sent', reject_reason: null });
    expect(r.body[0]._id).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body[0]._id).not.toBe(r.body[1]._id);
    expect(await latest('customer7')).toMatchObject({ status: 'delivered', otp: '246810', subject: 'Hi Seven' });

    const url = `${appUrl}/mandrill`;
    await waitFor(() => hooks('/mandrill').filter((h) => h.body.includes(encodeURIComponent(c7.email)) || h.body.includes(c7.email)).length >= 2);
    const evs = hooks('/mandrill')
      .map((h) => ({ h, events: JSON.parse(new URLSearchParams(h.body).get('mandrill_events')!) as any[] }))
      .filter((x) => x.events[0].msg.email === c7.email);
    expect(evs.map((x) => x.events[0].event)).toEqual(['send', 'delivered']);
    const d = evs[1];
    expect(d.events[0]).toMatchObject({ _id: r.body[0]._id, msg: { _id: r.body[0]._id, tags: ['otp'], metadata: { orderId: '9' } } });
    const signed = createHmac('sha1', 'md-hook-key').update(url + 'mandrill_events' + new URLSearchParams(d.h.body).get('mandrill_events')).digest('base64');
    expect(d.h.headers['x-mandrill-signature']).toBe(signed);

    const unauth = await send({ key: 'wrong', message: {} });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toMatchObject({ status: 'error', name: 'Invalid_Key' });
    const invalid = await send({ message: { from_email: 'a@b.co', to: [{ email: 'nope' }], text: 'x' } });
    expect(invalid.body).toMatchObject({ status: 'error', name: 'ValidationError' });

    const rejected = await send({ message: { from_email: 'a@b.co', to: [{ email: c7.email }], subject: 'rej', text: 'x' } }, { 'x-hub-scenario': 'reject' });
    expect(rejected.status).toBe(200);
    expect(rejected.body[0]).toMatchObject({ email: c7.email, status: 'rejected', reject_reason: 'hard-bounce' });
    expect(await latest('customer7')).toMatchObject({ status: 'rejected', subject: 'rej' });

    const tpl = await send({ template_name: 'welcome', template_content: [], message: { from_email: 'a@b.co', to: [{ email: c8.email }], global_merge_vars: [{ name: 'code', content: '112233' }] } }, {}, '/api/1.0/messages/send-template');
    expect(tpl.status).toBe(200);
    expect(await latest('customer8')).toMatchObject({ otp: '112233' });
  });
});
