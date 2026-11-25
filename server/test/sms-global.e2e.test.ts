import { createHmac, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startHub, type RunningHub } from '../src/index.js';
import { telnyxPublicKey } from '../src/providers/adapters/telnyx.js';

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
const received: { path: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
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
const latest = async (u: string) => (await api('GET', `/api/projects/glob/messages?user=${users[u].id}&channel=sms&limit=1`)).body[0];
const hits = (p: string) => received.filter((r) => r.path.split('?')[0] === p);
const jsonHits = (p: string) => hits(p).map((r) => JSON.parse(r.body));
const addProvider = (preset: string, slug: string, config: Record<string, unknown> = {}) =>
  api('POST', '/api/projects/glob/providers', { preset, slug, config: { statusCallbackUrl: `${appUrl}/dlr/${slug}`, ...config } });
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const rule = (u: string, body: Record<string, unknown>) => api('POST', `/api/projects/glob/users/${users[u].id}/rules`, { channel: 'sms', count: 1, ...body });

describe.skipIf(!haveMailpit)('Global SMS presets', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-smsg-'));
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
        received.push({ path: req.url ?? '', body, headers: req.headers });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Glob' })).status).toBe(201);
    for (const [i, name] of ['ib', 'pl', 'si', 'te', 'sn'].entries()) {
      const r = await api('POST', '/api/projects/glob/users', { name, phone: `+1555000000${i + 1}` });
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
    const ids = ((await api('GET', '/api/system')).body.presets ?? []).map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['infobip', 'plivo', 'sinch', 'telnyx', 'sns']));
  });

  it('Infobip: v3 send, inbox, auth error, REJECTED sender / balance, 429, DLR; v2 send and DLR', async () => {
    expect((await addProvider('infobip', 'ib', { apiKey: 'KEY', approvedSenders: 'MyBrand' })).status).toBe(201);
    const auth = { authorization: 'App KEY' };
    const v3 = (to: string, text: string, sender = 'MyBrand', h = auth) =>
      api('POST', '/mock/glob/ib/sms/3/messages', { messages: [{ sender, destinations: [{ to }], content: { text }, webhooks: { callbackData: 'cb-1' } }] }, h);

    const ok = await v3('15550000001', 'Your code is 4821');
    expect(ok.status).toBe(200);
    expect(ok.body.bulkId).toBeTruthy();
    expect(ok.body.messages[0]).toMatchObject({ destination: '15550000001', status: { groupName: 'PENDING', name: 'PENDING_ACCEPTED' }, details: { messageCount: 1 } });
    const id = ok.body.messages[0].messageId;
    expect(await latest('ib')).toMatchObject({ status: 'delivered', otp: '4821', providerMessageId: id });
    const [dlr] = await waitFor(() => (jsonHits('/dlr/ib').length ? jsonHits('/dlr/ib') : null));
    expect(dlr.results[0]).toMatchObject({ messageId: id, to: '15550000001', status: { groupName: 'DELIVERED', name: 'DELIVERED_TO_HANDSET' }, error: { name: 'NO_ERROR' }, callbackData: 'cb-1' });
    await sleep(300);
    expect(jsonHits('/dlr/ib')).toHaveLength(1); // final status only

    const bad = await v3('15550000001', 'x', 'MyBrand', { authorization: 'App nope' });
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ errorCode: 'E401', violations: [], resources: [] });

    const sender = await v3('15550000001', 'x', 'Other');
    expect(sender.status).toBe(200);
    expect(sender.body.messages[0].status).toMatchObject({ groupName: 'REJECTED', name: 'REJECTED_SOURCE' });

    await rule('ib', { action: 'reject', errorCode: 'balance' });
    const broke = await v3('15550000001', 'x');
    expect(broke.body.messages[0].status).toMatchObject({ groupName: 'REJECTED', name: 'REJECTED_NOT_ENOUGH_CREDITS' });
    expect(await latest('ib')).toMatchObject({ status: 'rejected' });

    await rule('ib', { action: 'rate_limit' });
    const limited = await v3('15550000001', 'x');
    expect(limited.status).toBe(429);
    expect(limited.body.errorCode).toBe('E429');

    // v2 "advanced" with notifyUrl, and a failed delivery.
    await rule('ib', { action: 'fail' });
    const v2 = await api(
      'POST',
      '/mock/glob/ib/sms/2/text/advanced',
      { messages: [{ from: 'MyBrand', destinations: [{ to: '+15550000001' }], text: 'Code 1111', notifyUrl: `${appUrl}/dlr/ib-v2` }] },
      auth,
    );
    expect(v2.status).toBe(200);
    expect(v2.body.messages[0]).toMatchObject({ to: '15550000001', status: { name: 'PENDING_ACCEPTED' }, smsCount: 1 });
    const [fd] = await waitFor(() => (jsonHits('/dlr/ib-v2').length ? jsonHits('/dlr/ib-v2') : null));
    expect(fd.results[0]).toMatchObject({ messageId: v2.body.messages[0].messageId, smsCount: 1, status: { groupName: 'UNDELIVERABLE' }, error: { name: 'EC_ABSENT_SUBSCRIBER' } });

    const legacyAuth = await api('POST', '/mock/glob/ib/sms/2/text/advanced', { messages: [] }, {});
    expect(legacyAuth.status).toBe(401);
    expect(legacyAuth.body).toEqual({ requestError: { serviceException: { messageId: 'UNAUTHORIZED', text: 'Invalid login details' } } });

    expect((await api('GET', '/mock/glob/ib/account/1/balance', undefined, auth)).body).toEqual({ balance: 1000, currency: 'EUR' });
  });

  it('Plivo: Basic auth send, 202 response, signed form callbacks, fetch, errors', async () => {
    expect((await addProvider('plivo', 'pl', { authId: 'MAID', authToken: 'tok' })).status).toBe(201);
    const send = (b: Record<string, unknown>, authz = basic('MAID', 'tok'), id = 'MAID') => api('POST', `/mock/glob/pl/v1/Account/${id}/Message/`, b, { authorization: authz });

    const ok = await send({ src: '+15559990000', dst: '+15550000002', text: 'Your code is 7310' });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ message: 'message(s) queued' });
    const uuid = ok.body.message_uuid[0];
    expect(await latest('pl')).toMatchObject({ status: 'delivered', otp: '7310', providerMessageId: uuid });

    const reports = await waitFor(() => (hits('/dlr/pl').length >= 2 ? hits('/dlr/pl') : null));
    const params = reports.map((r) => Object.fromEntries(new URLSearchParams(r.body)));
    expect(params.map((p) => p.Status)).toEqual(['sent', 'delivered']);
    expect(params[1]).toMatchObject({ MessageUUID: uuid, To: '15550000002', From: '15559990000', ErrorCode: '' });
    const h = reports[1].headers;
    const expected = createHmac('sha256', 'tok').update(`${appUrl}/dlr/pl` + h['x-plivo-signature-v2-nonce']).digest('base64');
    expect(h['x-plivo-signature-v2']).toBe(expected);

    const fetched = await api('GET', `/mock/glob/pl/v1/Account/MAID/Message/${uuid}/`, undefined, { authorization: basic('MAID', 'tok') });
    expect(fetched.body).toMatchObject({ message_uuid: uuid, message_state: 'delivered', to_number: '15550000002' });

    const bad = await send({ src: '+15559990000', dst: '+15550000002', text: 'x' }, basic('MAID', 'wrong'));
    expect(bad.status).toBe(401);
    expect(bad.body).toMatchObject({ error: 'Authentication failed' });

    await rule('pl', { action: 'reject', errorCode: 'balance' });
    const broke = await send({ src: '+15559990000', dst: '+15550000002', text: 'x' });
    expect(broke.status).toBe(402);
    expect(broke.body.error).toBe('insufficient credit');

    const down = await api('POST', '/mock/glob/pl/v1/Account/MAID/Message/', { src: '+15559990000', dst: '+15550000002', text: 'x' }, { authorization: basic('MAID', 'tok'), 'x-hub-scenario': 'down' });
    expect(down.status).toBe(503);
  });

  it('Sinch: batch send, 201 batch, no DLR by default, per_recipient DLRs, errors', async () => {
    expect((await addProvider('sinch', 'si', { servicePlanId: 'PLAN', apiToken: 'tok' })).status).toBe(201);
    const send = (b: Record<string, unknown>, token = 'tok', plan = 'PLAN') => api('POST', `/mock/glob/si/xms/v1/${plan}/batches`, b, { authorization: `Bearer ${token}` });

    const ok = await send({ from: '+15559990000', to: ['+15550000003'], body: 'Your code is 9944', client_reference: 'ref-1' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ to: ['15550000003'], from: '+15559990000', canceled: false, type: 'mt_text', delivery_report: 'none', client_reference: 'ref-1' });
    expect(ok.body.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(await latest('si')).toMatchObject({ status: 'delivered', otp: '9944', providerMessageId: ok.body.id });
    await sleep(300);
    expect(hits('/dlr/si')).toHaveLength(0); // delivery_report "none"

    const per = await send({ from: '+15559990000', to: ['+15550000003'], body: 'Code 1212', delivery_report: 'per_recipient', callback_url: `${appUrl}/dlr/si-per` });
    const reports = await waitFor(() => (jsonHits('/dlr/si-per').length >= 2 ? jsonHits('/dlr/si-per') : null));
    expect(reports.map((r) => r.status)).toEqual(['Dispatched', 'Delivered']);
    expect(reports[1]).toMatchObject({ type: 'recipient_delivery_report_sms', batch_id: per.body.id, recipient: '15550000003', code: 0 });

    const sum = await send({ from: '+15559990000', to: ['+15550000003'], body: 'Code 3434', delivery_report: 'summary' });
    const [s] = await waitFor(() => (jsonHits('/dlr/si').length ? jsonHits('/dlr/si') : null));
    expect(s).toMatchObject({ type: 'delivery_report_sms', batch_id: sum.body.id, statuses: [{ status: 'Delivered', count: 1 }] });

    const bad = await send({ from: '+15559990000', to: ['+15550000003'], body: 'x' }, 'nope');
    expect(bad.status).toBe(401);
    const forced = await api('POST', '/mock/glob/si/xms/v1/PLAN/batches', { to: ['+15550000003'], body: 'x' }, { authorization: 'Bearer tok', 'x-hub-scenario': 'reject:number' });
    expect(forced.status).toBe(400);
    expect(forced.body).toMatchObject({ code: 'syntax_invalid_parameter_format' });

    const fetched = await api('GET', `/mock/glob/si/xms/v1/PLAN/batches/${ok.body.id}`, undefined, { authorization: 'Bearer tok' });
    expect(fetched.body).toMatchObject({ id: ok.body.id, to: ['15550000003'] });
  });

  it('Telnyx: send, record response, Ed25519-signed message.sent / message.finalized, errors', async () => {
    const created = await addProvider('telnyx', 'te', { apiKey: 'KEY' });
    expect(created.status).toBe(201);
    const send = (b: Record<string, unknown>, key = 'KEY', h: Record<string, string> = {}) => api('POST', '/mock/glob/te/v2/messages', b, { authorization: `Bearer ${key}`, ...h });

    const ok = await send({ from: '+15559990000', to: '+15550000004', text: 'Your code is 6070' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ record_type: 'message', direction: 'outbound', type: 'SMS', to: [{ phone_number: '+15550000004', status: 'queued' }], parts: 1, encoding: 'GSM-7', errors: [] });
    expect(await latest('te')).toMatchObject({ status: 'delivered', otp: '6070', providerMessageId: ok.body.data.id });

    const reports = await waitFor(() => (hits('/dlr/te').length >= 2 ? hits('/dlr/te') : null));
    const events = reports.map((r) => JSON.parse(r.body));
    expect(events.map((e) => e.data.event_type)).toEqual(['message.sent', 'message.finalized']);
    expect(events[1].data.payload).toMatchObject({ id: ok.body.data.id, to: [{ status: 'delivered' }] });
    // Verify the signature like the telnyx SDK does: Ed25519 over "<timestamp>|<body>" with the instance's public key.
    const raw = Buffer.from(telnyxPublicKey(created.body.id), 'base64');
    expect(raw).toHaveLength(32);
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    const h = reports[1].headers;
    expect(verify(null, Buffer.from(`${h['telnyx-timestamp']}|${reports[1].body}`), pub, Buffer.from(String(h['telnyx-signature-ed25519']), 'base64'))).toBe(true);

    const bad = await send({ from: '+15559990000', to: '+15550000004', text: 'x' }, 'nope');
    expect(bad.status).toBe(401);
    expect(bad.body.errors[0]).toMatchObject({ code: '10009', title: 'Authentication failed' });
    const forced = await send({ from: '+15559990000', to: '+15550000004', text: 'x' }, 'KEY', { 'x-hub-scenario': 'reject:balance' });
    expect(forced.body.errors[0]).toMatchObject({ code: '20100' });
    const limited = await send({ from: '+15559990000', to: '+15550000004', text: 'x' }, 'KEY', { 'x-hub-scenario': 'rate_limit' });
    expect(limited.status).toBe(429);
    expect(limited.body.errors[0].code).toBe('10011');

    // Failed delivery → message.finalized with delivery_failed and errors[].
    await rule('te', { action: 'fail' });
    const failed = await send({ from: '+15559990000', to: '+15550000004', text: 'Code 5555' });
    const fin = await waitFor(() => jsonHits('/dlr/te').find((e) => e.data.event_type === 'message.finalized' && e.data.payload.id === failed.body.data.id));
    expect(fin.data.payload).toMatchObject({ to: [{ status: 'delivery_failed' }], errors: [{ code: '40008' }] });

    const guide = await api('GET', '/api/projects/glob/setup');
    expect(JSON.stringify(guide.body)).toContain(`TELNYX_PUBLIC_KEY=${telnyxPublicKey(created.body.id)}`);
  });

  it('Amazon SNS: query-protocol Publish, XML answers, auth errors, no DLR', async () => {
    expect((await addProvider('sns', 'sn', { accessKeyId: 'AKIDSTUB' })).status).toBe(201);
    const sig = (key = 'AKIDSTUB') => `AWS4-HMAC-SHA256 Credential=${key}/20261125/us-east-1/sns/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc`;
    const publish = (fields: Record<string, string>, authz: string | null = sig(), extra: Record<string, string> = {}) =>
      api('POST', '/mock/glob/sn/', new URLSearchParams({ Action: 'Publish', Version: '2010-03-31', ...fields }).toString(), {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        ...(authz ? { authorization: authz } : {}),
        ...extra,
      });

    const ok = await publish({
      PhoneNumber: '+15550000005',
      Message: 'Your code is 5521',
      'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SenderID',
      'MessageAttributes.entry.1.Value.DataType': 'String',
      'MessageAttributes.entry.1.Value.StringValue': 'MyBrand',
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/xml/);
    const id = /<MessageId>([^<]+)<\/MessageId>/.exec(ok.body)?.[1];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(ok.body)).toContain('<PublishResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/">');
    expect(await latest('sn')).toMatchObject({ status: 'delivered', otp: '5521', from: 'MyBrand', providerMessageId: id });

    const missing = await publish({ PhoneNumber: '+15550000005', Message: 'x' }, null);
    expect(missing.status).toBe(403);
    expect(missing.body).toContain('<Code>MissingAuthenticationToken</Code>');
    const wrong = await publish({ PhoneNumber: '+15550000005', Message: 'x' }, sig('AKIDOTHER'));
    expect(wrong.status).toBe(403);
    expect(wrong.body).toContain('<Code>InvalidClientTokenId</Code>');
    const badNum = await publish({ PhoneNumber: '15550000005', Message: 'x' });
    expect(badNum.status).toBe(400);
    expect(badNum.body).toContain('<Code>InvalidParameter</Code>');

    const down = await publish({ PhoneNumber: '+15550000005', Message: 'x' }, sig(), { 'x-hub-scenario': 'down' });
    expect(down.status).toBe(503);
    expect(down.body).toContain('<Type>Receiver</Type>');

    const opted = await api('POST', '/mock/glob/sn/', 'Action=CheckIfPhoneNumberIsOptedOut&phoneNumber=%2B15550000005', { 'content-type': 'application/x-www-form-urlencoded', authorization: sig() });
    expect(opted.body).toContain('<isOptedOut>false</isOptedOut>');
    const unknown = await api('POST', '/mock/glob/sn/', 'Action=Subscribe', { 'content-type': 'application/x-www-form-urlencoded', authorization: sig() });
    expect(unknown.body).toContain('<Code>InvalidAction</Code>');

    await sleep(300);
    expect(hits('/dlr/sn')).toHaveLength(0);
  });
});
