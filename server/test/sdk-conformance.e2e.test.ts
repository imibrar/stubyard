/**
 * SDK conformance: the real provider SDKs (twilio, @vonage/server-sdk, @sendgrid/mail, mailgun.js, AWS SDK v3 SESv2),
 * configured exactly as the agent guide / "Connect your app" snippets say, against an in-process devhub over HTTPS
 * (devhub's CA added to Node's default trust store for the duration of the suite).
 * Per SDK: a send (message lands at the test user, with the OTP), one error path (scenario rule → SDK error) and the
 * delivery callbacks / event webhooks the app would receive.
 *
 * Runs with the normal test command. Skip it with DEVHUB_SDK_TESTS=0; `npm run test:sdk -w server` runs only this file.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';

const require = createRequire(import.meta.url);
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
let api: string;
let https: string;
let appUrl: string;
let appServer: http.Server;
let restoreCa: (() => void) | null = null;
const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

async function j<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(api + p, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const hooks = (prefix: string) => received.filter((r) => r.path.startsWith(prefix));
const latest = async (user: string, channel: string) => (await j<any[]>('GET', `/api/projects/qa/messages?user=${encodeURIComponent(user)}&channel=${channel}&limit=1`))[0];
const rule = (user: string, r: Record<string, unknown>) => j('POST', `/api/projects/qa/users/${encodeURIComponent(user)}/rules`, r);
const clearRules = (user: string) => j('DELETE', `/api/projects/qa/users/${encodeURIComponent(user)}/rules`);
const provider = (preset: string, slug: string, config: Record<string, unknown>) => j('POST', '/api/projects/qa/providers', { preset, slug, config });

describe.skipIf(!enabled)('SDK conformance (real provider SDKs against devhub)', () => {
  let c1: { email: string; phone: string };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-sdk-test-'));
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
        callbackDelayMs: 150,
        timeoutHoldMs: 400,
      }),
      { logger: pino({ level: 'silent' }) },
    );
    // Trust devhub's CA like an app with NODE_EXTRA_CA_CERTS would (Node ≥ 22.15 / 24: fetch, https, axios).
    const setCa = (tls as unknown as { setDefaultCACertificates?: (c: string[]) => void }).setDefaultCACertificates;
    if (setCa && running.hub.tls) {
      const before = tls.getCACertificates('default');
      setCa([...before, running.hub.tls.caCertPem]);
      restoreCa = () => setCa(before);
      https = `https://localhost:${httpsPort}`;
    } else {
      https = `http://localhost:${httpPort}`; // older Node: same routes over plain HTTP
    }
    api = `http://127.0.0.1:${httpPort}`;
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

    await j('POST', '/api/projects', { name: 'QA', slug: 'qa', generateUsers: { admins: 1, customers: 3 } });
    c1 = await j('GET', '/api/projects/qa/users/customer1');
    await provider('twilio', 'twilio', { statusCallbackUrl: `${appUrl}/twilio/status`, authToken: 'token' });
    await provider('vonage', 'vonage', { statusCallbackUrl: `${appUrl}/vonage/status` });
    await provider('sendgrid', 'sendgrid', { apiKey: 'SG.devhub', eventWebhookUrl: `${appUrl}/sendgrid/events` });
    await provider('mailgun', 'mailgun', { domain: 'mg.example.com', eventWebhookUrl: `${appUrl}/mailgun/events` });
    await provider('ses', 'ses', { eventWebhookUrl: `${appUrl}/ses/events` });
  }, 30_000);

  afterAll(async () => {
    restoreCa?.();
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('twilio: messages.create + fetch, status callbacks, RestException on reject', async () => {
    const twilio = require('twilio');
    const base = `${https}/mock/qa/twilio`;
    // Snippet from the guide: rewrite api.twilio.com to devhub in a custom RequestClient.
    class DevhubClient extends twilio.RequestClient {
      request(opts: { uri: string }) {
        opts.uri = opts.uri.replace('https://api.twilio.com', base);
        return super.request(opts);
      }
    }
    const client = twilio('AC' + 'a'.repeat(32), 'token', { httpClient: new DevhubClient() });
    const m = await client.messages.create({ to: c1.phone, from: '+15550001111', body: 'Your code is 482913' });
    expect(m.sid).toMatch(/^SM/);
    expect(['queued', 'accepted', 'sent']).toContain(m.status);
    expect((await latest('customer1', 'sms')).otp).toBe('482913');

    const cb = await waitFor(() => hooks('/twilio/status').find((h) => /MessageStatus=delivered/.test(h.body) && h.body.includes(m.sid)), 'twilio delivered callback');
    expect(String(cb.headers['content-type'])).toContain('application/x-www-form-urlencoded');
    // The SDK's own validator accepts devhub's X-Twilio-Signature.
    const params = Object.fromEntries(new URLSearchParams(cb.body));
    expect(twilio.validateRequest('token', String(cb.headers['x-twilio-signature']), `${appUrl}${cb.path}`, params)).toBe(true);
    const f = await client.messages(m.sid).fetch();
    expect(f.status).toBe('delivered');

    await rule('customer1', { channel: 'sms', action: 'reject', count: 1 });
    const err = await client.messages.create({ to: c1.phone, from: '+15550001111', body: 'Your code is 111111' }).then(
      () => null,
      (e: any) => e,
    );
    expect(err).toBeTruthy();
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(typeof err.code).toBe('number');
    await clearRules('customer1');
  });

  it('@vonage/server-sdk: sms.send, delivery receipt, error on reject', async () => {
    const { Vonage } = require('@vonage/server-sdk');
    const vonage = new Vonage({ apiKey: 'abcd1234', apiSecret: 'secret' }, { restHost: `${https}/mock/qa/vonage` });
    const to = c1.phone.replace(/^\+/, '');
    const r = await vonage.sms.send({ to, from: 'HYPER', text: 'Your code is 482914' });
    expect(r.messages[0].status).toBe('0');
    const id = r.messages[0]['message-id'] ?? r.messages[0].messageId;
    expect(id).toBeTruthy();
    expect((await latest('customer1', 'sms')).otp).toBe('482914');
    await waitFor(() => hooks('/vonage/status').find((h) => h.body.includes(String(id)) && /delivered/i.test(h.body)), 'vonage delivery receipt');

    await rule('customer1', { channel: 'sms', action: 'reject', count: 1 });
    const err = await vonage.sms.send({ to, from: 'HYPER', text: 'Your code is 111112' }).then(
      () => null,
      (e: any) => e,
    );
    expect(err).toBeTruthy();
    const status = err.response?.messages?.[0]?.status;
    expect(status && status !== '0').toBeTruthy();
    await clearRules('customer1');
  });

  it('@sendgrid/mail: send (base URL set after setApiKey), events, ResponseError on reject', async () => {
    const sgMail = require('@sendgrid/mail');
    const client = require('@sendgrid/client');
    sgMail.setClient(client);
    sgMail.setApiKey('SG.devhub');
    client.setDefaultRequest('baseUrl', `${https}/mock/qa/sendgrid`); // after setApiKey(), which resets it
    const [res] = await sgMail.send({ to: c1.email, from: 'no-reply@hyper.app', subject: 'Sign in', text: 'Your code is 482915' });
    expect(res.statusCode).toBe(202);
    const xid = res.headers['x-message-id'];
    expect(xid).toBeTruthy();
    expect((await latest('customer1', 'email')).otp).toBe('482915');
    await waitFor(
      () => hooks('/sendgrid/events').find((h) => (JSON.parse(h.body) as any[]).some((e) => e.event === 'delivered' && e.email === c1.email)),
      'sendgrid delivered event',
    );

    await rule('customer1', { channel: 'email', action: 'reject', count: 1 });
    const err = await sgMail.send({ to: c1.email, from: 'no-reply@hyper.app', subject: 'x', text: 'Your code is 111113' }).then(
      () => null,
      (e: any) => e,
    );
    expect(err).toBeTruthy();
    expect(err.code).toBeGreaterThanOrEqual(400);
    expect(err.response?.body?.errors?.length).toBeGreaterThan(0);
    await clearRules('customer1');
  });

  it('mailgun.js + form-data: messages.create, events, error on reject', async () => {
    const FormData = require('form-data');
    const Mailgun = require('mailgun.js');
    const mg = new (Mailgun.default ?? Mailgun)(FormData).client({ username: 'api', key: 'key-devhub', url: `${https}/mock/qa/mailgun` });
    const r = await mg.messages.create('mg.example.com', { from: 'no-reply@mg.example.com', to: [c1.email], subject: 'Sign in', text: 'Your code is 482916' });
    expect(r.id).toMatch(/@/);
    expect(r.status ?? 200).toBe(200);
    expect((await latest('customer1', 'email')).otp).toBe('482916');
    const ev = await waitFor(
      () => hooks('/mailgun/events').find((h) => { const b = JSON.parse(h.body); return b['event-data']?.event === 'delivered' && b['event-data']?.recipient === c1.email; }),
      'mailgun delivered event',
    );
    expect(JSON.parse(ev.body).signature?.signature).toMatch(/^[0-9a-f]{64}$/);

    await rule('customer1', { channel: 'email', action: 'reject', count: 1 });
    const err = await mg.messages.create('mg.example.com', { from: 'no-reply@mg.example.com', to: [c1.email], subject: 'x', text: 'Your code is 111114' }).then(
      () => null,
      (e: any) => e,
    );
    expect(err).toBeTruthy();
    expect(err.status).toBeGreaterThanOrEqual(400);
    await clearRules('customer1');
  });

  it('@aws-sdk/client-sesv2: SendEmailCommand, SNS delivery notification, service exception on reject', async () => {
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const ses = new SESv2Client({ region: 'us-east-1', endpoint: `${https}/mock/qa/ses`, credentials: { accessKeyId: 'devhub', secretAccessKey: 'devhub' }, maxAttempts: 1 });
    const cmd = (text: string) =>
      new SendEmailCommand({ FromEmailAddress: 'no-reply@hyper.app', Destination: { ToAddresses: [c1.email] }, Content: { Simple: { Subject: { Data: 'Sign in' }, Body: { Text: { Data: text } } } } });
    const r = await ses.send(cmd('Your code is 482917'));
    expect(r.MessageId).toBeTruthy();
    expect(r.$metadata.httpStatusCode).toBe(200);
    expect((await latest('customer1', 'email')).otp).toBe('482917');
    const n = await waitFor(
      () => hooks('/ses/events').find((h) => { const b = JSON.parse(h.body); return b.Type === 'Notification' && /Delivery/.test(String(b.Message)) && String(b.Message).includes(r.MessageId); }),
      'ses delivery notification',
    );
    expect(n.headers['x-amz-sns-message-type']).toBe('Notification');

    await rule('customer1', { channel: 'email', action: 'reject', count: 1 });
    const err = await ses.send(cmd('Your code is 111115')).then(
      () => null,
      (e: any) => e,
    );
    expect(err).toBeTruthy();
    expect(err.$metadata?.httpStatusCode).toBeGreaterThanOrEqual(400);
    expect(err.name).toBeTruthy();
    await clearRules('customer1');
  });
});
