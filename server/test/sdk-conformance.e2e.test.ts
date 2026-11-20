/**
 * SDK conformance: the real provider SDKs (twilio, @vonage/server-sdk, @sendgrid/mail, mailgun.js, AWS SDK v3 SESv2),
 * configured exactly as the agent guide / "Connect your app" snippets say, against an in-process stubyard over HTTPS
 * (stubyard's CA added to Node's default trust store for the duration of the suite).
 * Per SDK: a send (message lands at the test user, with the OTP), one error path (scenario rule → SDK error) and the
 * delivery callbacks / event webhooks the app would receive.
 *
 * Phase 6.5: Twilio Verify v2 (client.verify.v2…) and Vonage Verify v2 (vonage.verify2…) with the same setup.
 *
 * Runs with the normal test command. Skip it with STUBYARD_SDK_TESTS=0; `npm run test:sdk -w server` runs only this file.
 */
import { generateKeyPairSync } from 'node:crypto';
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
const MAILPIT_BIN = process.env.STUBYARD_MAILPIT_BIN ?? '/usr/local/bin/mailpit';
const enabled = fs.existsSync(MAILPIT_BIN) && process.env.STUBYARD_SDK_TESTS !== '0';

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

describe.skipIf(!enabled)('SDK conformance (real provider SDKs against stubyard)', () => {
  let c1: { email: string; phone: string };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-sdk-test-'));
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
    // Trust stubyard's CA like an app with NODE_EXTRA_CA_CERTS would (Node ≥ 22.15 / 24: fetch, https, axios).
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
    await provider('sendgrid', 'sendgrid', { apiKey: 'SG.stubyard', eventWebhookUrl: `${appUrl}/sendgrid/events` });
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
    // Snippet from the guide: rewrite api.twilio.com to stubyard in a custom RequestClient.
    class StubyardClient extends twilio.RequestClient {
      request(opts: { uri: string }) {
        opts.uri = opts.uri.replace('https://api.twilio.com', base);
        return super.request(opts);
      }
    }
    const client = twilio('AC' + 'a'.repeat(32), 'token', { httpClient: new StubyardClient() });
    const m = await client.messages.create({ to: c1.phone, from: '+15550001111', body: 'Your code is 482913' });
    expect(m.sid).toMatch(/^SM/);
    expect(['queued', 'accepted', 'sent']).toContain(m.status);
    expect((await latest('customer1', 'sms')).otp).toBe('482913');

    const cb = await waitFor(() => hooks('/twilio/status').find((h) => /MessageStatus=delivered/.test(h.body) && h.body.includes(m.sid)), 'twilio delivered callback');
    expect(String(cb.headers['content-type'])).toContain('application/x-www-form-urlencoded');
    // The SDK's own validator accepts stubyard's X-Twilio-Signature.
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
    sgMail.setApiKey('SG.stubyard');
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
    const mg = new (Mailgun.default ?? Mailgun)(FormData).client({ username: 'api', key: 'key-stubyard', url: `${https}/mock/qa/mailgun` });
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
    const ses = new SESv2Client({ region: 'us-east-1', endpoint: `${https}/mock/qa/ses`, credentials: { accessKeyId: 'stubyard', secretAccessKey: 'stubyard' }, maxAttempts: 1 });
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

  it('twilio Verify v2: services, verifications.create, verificationChecks.create, RestException codes', async () => {
    const twilio = require('twilio');
    const base = `${https}/mock/qa/twilio`;
    // Verify lives on verify.twilio.com: the RequestClient must rewrite both hosts to the same stubyard base URL.
    class StubyardClient extends twilio.RequestClient {
      request(opts: { uri: string }) {
        opts.uri = opts.uri.replace('https://api.twilio.com', base).replace('https://verify.twilio.com', base);
        return super.request(opts);
      }
    }
    const client = twilio('AC' + 'a'.repeat(32), 'token', { httpClient: new StubyardClient() });
    const service = await client.verify.v2.services.create({ friendlyName: 'QA', codeLength: 6 });
    expect(service.sid).toMatch(/^VA/);
    expect(service.codeLength).toBe(6);
    expect((await client.verify.v2.services(service.sid).fetch()).friendlyName).toBe('QA');

    const v = await client.verify.v2.services(service.sid).verifications.create({ to: c1.phone, channel: 'sms' });
    expect(v.sid).toMatch(/^VE/);
    expect(v.status).toBe('pending');
    expect(v.sendCodeAttempts).toHaveLength(1);
    const msg = await latest('customer1', 'sms');
    expect(msg.otp).toMatch(/^\d{6}$/);

    const wrong = await client.verify.v2.services(service.sid).verificationChecks.create({ to: c1.phone, code: msg.otp === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe('pending');
    expect(wrong.valid).toBe(false);
    const ok = await client.verify.v2.services(service.sid).verificationChecks.create({ verificationSid: v.sid, code: msg.otp });
    expect(ok.status).toBe('approved');
    expect(ok.valid).toBe(true);

    const gone = await client.verify.v2.services(service.sid).verificationChecks.create({ to: c1.phone, code: msg.otp }).then(() => null, (e: any) => e);
    expect(gone?.status).toBe(404);
    expect(gone?.code).toBe(20404);
    const invalid = await client.verify.v2.services(service.sid).verifications.create({ to: c1.phone, channel: 'fax' }).then(() => null, (e: any) => e);
    expect(invalid?.status).toBe(400);
    expect(invalid?.code).toBe(60200);

    const call = await client.verify.v2.services(service.sid).verifications.create({ to: c1.phone, channel: 'call' });
    const canceled = await client.verify.v2.services(service.sid).verifications(call.sid).update({ status: 'canceled' });
    expect(canceled.status).toBe('canceled');
  });

  it('@vonage/server-sdk Verify v2: verify2.newRequest, checkCode, cancel, summary callback', async () => {
    const { Vonage } = require('@vonage/server-sdk');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    // Verify v2 uses apiHost (api.nexmo.com), SMS uses restHost (rest.nexmo.com): point both at stubyard.
    const base = `${https}/mock/qa/vonage`;
    const vonage = new Vonage({ applicationId: '00000000-0000-4000-8000-000000000000', privateKey }, { apiHost: base, restHost: base });
    const to = c1.phone.replace(/^\+/, '');
    const { requestId } = await vonage.verify2.newRequest({ brand: 'QA', workflow: [{ channel: 'sms', to }] });
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const msg = await latest('customer1', 'sms');
    expect(msg.otp).toMatch(/^\d{4}$/);

    const wrong = await vonage.verify2.checkCode(requestId, msg.otp === '0000' ? '1111' : '0000').then(() => null, (e: any) => e);
    expect(wrong).toBeTruthy();
    expect(wrong.response?.status ?? wrong.status).toBe(400);
    expect(await vonage.verify2.checkCode(requestId, msg.otp)).toBe('completed');
    const cb = await waitFor(() => hooks('/vonage/status').find((h) => h.body.includes(requestId) && h.body.includes('"completed"')), 'vonage verify summary callback');
    expect(JSON.parse(cb.body)).toMatchObject({ request_id: requestId, type: 'summary', status: 'completed' });

    const second = await vonage.verify2.newRequest({ brand: 'QA', workflow: [{ channel: 'email', to: c1.email }] });
    expect((await latest('customer1', 'email')).otp).toMatch(/^\d{4}$/);
    expect(await vonage.verify2.cancel(second.requestId)).toBe(true);
    expect(await vonage.verify2.cancel(second.requestId)).toBe(false);
  });
});
