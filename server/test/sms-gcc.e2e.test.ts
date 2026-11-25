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
const received: { path: string; body: string }[] = [];
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

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const users: Record<string, { id: string; phone: string }> = {};
const latest = async (u: string) => (await api('GET', `/api/projects/gcc/messages?user=${users[u].id}&channel=sms&limit=1`)).body[0];
const dlrs = (p: string) => received.filter((r) => r.path === p).map((r) => JSON.parse(r.body));
const addProvider = (preset: string, slug: string, config: Record<string, unknown> = {}) =>
  api('POST', '/api/projects/gcc/providers', { preset, slug, config: { statusCallbackUrl: `${appUrl}/dlr/${slug}`, ...config } });
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe.skipIf(!haveMailpit)('Saudi / GCC SMS presets', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-gcc-'));
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
      callbackDelayMs: 100,
      timeoutHoldMs: 300,
    });
    running = await startHub(config, { logger: pino({ level: 'silent' }) });
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'GCC' })).status).toBe(201);
    for (const [i, name] of ['uni', 'taq', 'mse', 'jaw', 'our'].entries()) {
      const r = await api('POST', '/api/projects/gcc/users', { name, phone: `+96650000000${i + 1}` });
      expect(r.status).toBe(201);
      users[name] = { id: r.body.id, phone: r.body.phone };
    }
  });

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the presets', async () => {
    const meta = (await api('GET', '/api/system')).body;
    const ids = (meta.presets ?? []).map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['unifonic', 'taqnyat', 'msegat', '4jawaly', 'oursms']));
  });

  it('Unifonic: form send, inbox + Arabic segments, auth errors, sender and balance failures, DLR', async () => {
    expect((await addProvider('unifonic', 'uni', { appSid: 'APP123', approvedSenders: 'MyBrand' })).status).toBe(201);
    const send = (fields: Record<string, string>) =>
      api('POST', '/mock/gcc/uni/rest/SMS/messages', new URLSearchParams(fields).toString(), { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' });

    const arabic = 'رمز التحقق الخاص بك هو 4821 '.repeat(3).trim(); // > 70 UCS-2 units → 2 parts
    const ok = await send({ AppSid: 'APP123', SenderID: 'MyBrand', Recipient: '966500000001', Body: arabic, CorrelationID: 'corr-1' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ success: true, errorCode: 'ER-00', data: { Status: 'Sent', Recipient: '966500000001', CorrelationID: 'corr-1', NumberOfUnits: 2 } });
    expect(String(ok.body.data.MessageID)).toMatch(/^\d{14}$/);
    const m = await latest('uni');
    expect(m).toMatchObject({ status: 'delivered', otp: '4821', providerMessageId: String(ok.body.data.MessageID) });
    expect(m.metadata).toMatchObject({ encoding: 'UCS-2', segments: 2 });

    // Only the final status is reported, in Unifonic's "dlr" event format.
    const [dlr] = await waitFor(() => (dlrs('/dlr/uni').length ? dlrs('/dlr/uni') : null));
    expect(dlr).toMatchObject({ eventName: 'dlr', body: { finalStatus: 'DELIVRD', destinationAddress: '966500000001', correlationId: 'corr-1', messageId: ok.body.data.MessageID } });
    await sleep(300);
    expect(dlrs('/dlr/uni')).toHaveLength(1);

    const noSid = await send({ SenderID: 'MyBrand', Recipient: '966500000001', Body: 'x' });
    expect(noSid.status).toBe(402);
    expect(noSid.body).toMatchObject({ success: false, errorCode: 'ER-2', message: 'No AppSid Parameter Specified' });
    const badSid = await send({ AppSid: 'nope', SenderID: 'MyBrand', Recipient: '966500000001', Body: 'x' });
    expect(badSid.status).toBe(401);
    expect(badSid.body).toMatchObject({ success: false, errorCode: 'ER-1' });

    const sender = await send({ AppSid: 'APP123', SenderID: 'Other', Recipient: '966500000001', Body: 'x' });
    expect(sender.status).toBe(480);
    expect(sender.body.message).toBe('This user cannot use the specified SenderID');

    // A rule asks for the vendor's balance error by name.
    await api('POST', `/api/projects/gcc/users/${users.uni.id}/rules`, { channel: 'sms', action: 'reject', count: 1, errorCode: 'balance' });
    const broke = await send({ AppSid: 'APP123', SenderID: 'MyBrand', Recipient: '966500000001', Body: 'x' });
    expect(broke.status).toBe(400);
    expect(broke.body).toMatchObject({ success: false, message: 'Insufficient balance' });

    // A delivery failure arrives as an UNDELIV DLR.
    await api('POST', `/api/projects/gcc/users/${users.uni.id}/rules`, { channel: 'sms', action: 'fail', count: 1 });
    const failed = await send({ AppSid: 'APP123', SenderID: 'MyBrand', Recipient: '966500000001', Body: 'Code 1111' });
    expect(failed.status).toBe(200);
    const fd = await waitFor(() => dlrs('/dlr/uni').find((d) => d.body.messageId === failed.body.data.MessageID));
    expect(fd.body).toMatchObject({ finalStatus: 'UNDELIV', errorCode: 'UNDELIV' });
  });

  it('Taqnyat: JSON send with bearer, balance and senders, auth and sender errors, DLR', async () => {
    expect((await addProvider('taqnyat', 'taq', { bearerToken: 'tok', approvedSenders: 'MyBrand', webhookPassPhrase: 'pp', balance: '55.5' })).status).toBe(201);
    const auth = { authorization: 'Bearer tok' };
    const send = (b: unknown, h: Record<string, string> = auth) => api('POST', '/mock/gcc/taq/v1/messages', b, h);

    const ok = await send({ recipients: ['0500000002'], body: 'Your code is 7310', sender: 'MyBrand' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ statusCode: 201, currency: 'SAR', totalCount: 1, msgLength: 1, accepted: '[966500000002,]', rejected: '[]' });
    expect(typeof ok.body.messageId).toBe('number');
    expect(await latest('taq')).toMatchObject({ status: 'delivered', otp: '7310', providerMessageId: String(ok.body.messageId) });
    const [dlr] = await waitFor(() => (dlrs('/dlr/taq').length ? dlrs('/dlr/taq') : null));
    expect(dlr).toMatchObject({ messageId: ok.body.messageId, mobile: '966500000002', status: 'delivered', passPhrase: 'pp' });

    const noAuth = await send({ recipients: ['966500000002'], body: 'x', sender: 'MyBrand' }, {});
    expect(noAuth.status).toBe(401);
    expect(noAuth.body).toEqual({ statusCode: 401, message: 'invalid credentials information' });
    const sender = await send({ recipients: ['966500000002'], body: 'x', sender: 'Nope' });
    expect(sender.body).toEqual({ statusCode: 400, message: 'Sender Name not active' });

    const bal = await api('GET', '/mock/gcc/taq/account/balance', undefined, auth);
    expect(bal.body).toMatchObject({ statusCode: 200, accountStatus: 'active', balance: '55.500', currency: 'SAR' });
    const senders = await api('GET', '/mock/gcc/taq/v1/messages/senders', undefined, auth);
    expect(senders.status).toBe(201);
    expect(senders.body.senders).toEqual([{ senderName: 'MyBrand', status: 'active', destination: 'KSA' }]);

    // X-Hub-Scenario maps a generic action to the vendor's sender error.
    const forced = await api('POST', '/mock/gcc/taq/v1/messages', { recipients: ['966500000002'], body: 'x', sender: 'MyBrand' }, { ...auth, 'x-hub-scenario': 'reject:sender' });
    expect(forced.body).toEqual({ statusCode: 400, message: 'Sender Name not active' });
    expect(await latest('taq')).toMatchObject({ status: 'rejected' });
  });

  it('Msegat: HTTP 200 envelopes, inbox, login / balance errors, Credits.php, no DLR', async () => {
    expect((await addProvider('msegat', 'mse', { userName: 'acme', apiKey: 'k1' })).status).toBe(201);
    const send = (b: Record<string, unknown>) => api('POST', '/mock/gcc/mse/gw/sendsms.php', { userName: 'acme', apiKey: 'k1', userSender: 'MyBrand', ...b });

    const ok = await send({ numbers: '966500000003', msg: 'Pin Code is: 9944' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ code: '1', message: 'Success' });
    expect(await latest('mse')).toMatchObject({ status: 'delivered', otp: '9944', to: '+966500000003' });

    const bad = await send({ apiKey: 'wrong', numbers: '966500000003', msg: 'x' });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ code: 'M0002', message: 'Invalid login info' });

    await api('POST', `/api/projects/gcc/users/${users.mse.id}/rules`, { channel: 'sms', action: 'reject', count: 1, errorCode: 'balance' });
    expect((await send({ numbers: '966500000003', msg: 'x' })).body).toEqual({ code: '1060', message: 'Balance is not enough' });

    const credits = await api('GET', '/mock/gcc/mse/gw/Credits.php?userName=acme&apiKey=k1');
    expect(credits.body).toBe(1000);
    await sleep(300);
    expect(dlrs('/dlr/mse')).toHaveLength(0);
  });

  it('4Jawaly: Basic auth, job_id response, token errors, balance via rule, packages, DLR', async () => {
    expect((await addProvider('4jawaly', 'jaw', { apiKey: 'key', apiSecret: 'sec' })).status).toBe(201);
    const send = (b: unknown, authz = basic('key', 'sec')) => api('POST', '/mock/gcc/jaw/api/v1/account/area/sms/send', b, authz ? { authorization: authz } : {});
    const msg = (text: string) => ({ messages: [{ text, numbers: ['0500000004'], sender: 'MyBrand' }] });

    const ok = await send(msg('Your code is 6070'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ code: 200, messages: [{ success_count: 1, error_count: 0, total_cost: 1 }] });
    expect(ok.body.job_id).toBe(ok.body.messages[0].job_id);
    expect(await latest('jaw')).toMatchObject({ status: 'delivered', otp: '6070', to: '+966500000004', providerMessageId: ok.body.job_id });
    const [dlr] = await waitFor(() => (dlrs('/dlr/jaw').length ? dlrs('/dlr/jaw') : null));
    expect(dlr).toMatchObject({ sms_message: { sender_name: 'MyBrand' }, numbers: [{ number: '966500000004', msg_id: ok.body.job_id, status: 3 }] });

    const missing = await send(msg('x'), '');
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ code: 400, message: 'التوكن مطلوب' });
    const wrong = await send(msg('x'), basic('key', 'nope'));
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: 400, is_token_expired: true });

    await api('POST', `/api/projects/gcc/users/${users.jaw.id}/rules`, { channel: 'sms', action: 'reject', count: 1, errorCode: 'balance' });
    const broke = await send(msg('x'));
    expect(broke.status).toBe(400);
    expect(broke.body.messages[0].err_text).toBe('الرصيد غير كافي');

    const pk = await api('GET', '/mock/gcc/jaw/api/v1/account/area/me/packages', undefined, { authorization: basic('key', 'sec') });
    expect(pk.body).toMatchObject({ code: 200, total_balance: 1000 });
  });

  it('OurSMS: bearer send, legacy query API, credentials error, sender gate, credits, no DLR', async () => {
    expect((await addProvider('oursms', 'our', { token: 'T1', approvedSenders: 'MyBrand' })).status).toBe(201);
    const auth = { authorization: 'Bearer T1' };

    const ok = await api('POST', '/mock/gcc/our/msgs/sms', { src: 'MyBrand', dests: ['966500000005'], body: 'Code: 5521', priority: 1, msgClass: 'transactional' }, auth);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accepted: 1, rejected: 0 });
    expect(await latest('our')).toMatchObject({ status: 'delivered', otp: '5521', providerMessageId: ok.body.jobId });

    const legacy = await api('GET', `/mock/gcc/our/api-a/msgs?username=u&token=T1&src=MyBrand&dests=966500000005&body=${encodeURIComponent('Code: 8080')}`);
    expect(legacy.status).toBe(200);
    expect(await latest('our')).toMatchObject({ otp: '8080' });

    const bad = await api('POST', '/mock/gcc/our/msgs/sms', { src: 'MyBrand', dests: ['966500000005'], body: 'x' }, { authorization: 'Bearer nope' });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ status: 401, errorCode: '2003', message: 'Invalid credentials', value: null });
    const sender = await api('POST', '/mock/gcc/our/msgs/sms', { src: 'Other', dests: ['966500000005'], body: 'x' }, auth);
    expect(sender.status).toBe(400);
    expect(sender.body).toMatchObject({ status: 400, message: 'Sender name is not active' });

    // Instance "down" rule → 503 in OurSMS's envelope.
    await api('POST', '/api/projects/gcc/providers/our/rules', { action: 'down', count: 1 });
    const down = await api('POST', '/mock/gcc/our/msgs/sms', { src: 'MyBrand', dests: ['966500000005'], body: 'x' }, auth);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ status: 503, value: null });

    expect((await api('GET', '/mock/gcc/our/billing/credits', undefined, auth)).body).toEqual({ credits: 1000 });
    await sleep(300);
    expect(dlrs('/dlr/our')).toHaveLength(0);
  });

  it('a zero balance fails every send with the vendor error', async () => {
    await api('PATCH', '/api/projects/gcc/providers/taq', { config: { bearerToken: 'tok', balance: '0' } });
    const r = await api('POST', '/mock/gcc/taq/v1/messages', { recipients: ['966500000002'], body: 'x', sender: 'MyBrand' }, { authorization: 'Bearer tok' });
    expect(r.body).toEqual({ statusCode: 400, message: 'Your balance is 0' });
  });
});
