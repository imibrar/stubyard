/**
 * Phase 6.5: Twilio Verify v2, Vonage Verify v2, inbound email (SendGrid Inbound Parse, Mailgun routes, SES receipts,
 * JSON) and WhatsApp media / interactive messages / read receipts / button replies / 24-hour window.
 */
import { createHash, createHmac } from 'node:crypto';
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
const received: { path: string; headers: http.IncomingHttpHeaders; body: string; raw: Buffer }[] = [];
let appServer: http.Server;
let appUrl: string;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers; text: string }> {
  const raw = body instanceof FormData || body instanceof URLSearchParams || typeof body === 'string';
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined && !raw ? { 'content-type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
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
    await new Promise((r) => setTimeout(r, 40));
  }
}

const hooks = (prefix: string) => received.filter((r) => r.path.startsWith(prefix));
const user = async (ref: string) => (await api('GET', `/api/projects/hyper/users/${ref}`)).body;
const latest = async (ref: string, channel: string) => (await api('GET', `/api/projects/hyper/messages?user=${ref}&channel=${channel}&limit=1`)).body[0];
const form = (o: Record<string, string>) => new URLSearchParams(o);
const TW = '/mock/hyper/twilio';
const basic = { authorization: 'Basic ' + Buffer.from('AC' + 'a'.repeat(32) + ':token').toString('base64') };
const tw = (method: string, p: string, body?: Record<string, string>) => api(method, TW + p, body ? form(body) : undefined, basic);
const vg = (method: string, p: string, body?: unknown, slug = 'vonage') => api(method, `/mock/hyper/${slug}${p}`, body, { authorization: 'Bearer eyJ.stubyard.jwt' });
const wa = (body: unknown, slug = 'meta') => api('POST', `/mock/hyper/${slug}/v21.0/1234567/messages`, body);
const rule = (u: string, r: Record<string, unknown>) => api('POST', `/api/projects/hyper/users/${u}/rules`, r);
const clearRules = (u: string) => api('DELETE', `/api/projects/hyper/users/${u}/rules`);

describe.skipIf(!haveMailpit)('phase 6.5: Verify APIs, inbound email, WhatsApp media and buttons', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-verify-test-'));
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
        callbackDelayMs: 120,
        timeoutHoldMs: 300,
      }),
      { logger: pino({ level: 'silent' }) },
    );
    appServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        received.push({ path: req.url ?? '', headers: req.headers, body: raw.toString('utf8'), raw });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    base = `http://127.0.0.1:${httpPort}`;
    expect((await api('POST', '/api/projects', { name: 'Hyper', generateUsers: { admins: 1, customers: 9 } })).status).toBe(201);
    const prov = (preset: string, slug: string, config: Record<string, unknown>) => api('POST', '/api/projects/hyper/providers', { preset, slug, config });
    await prov('twilio', 'twilio', { statusCallbackUrl: `${appUrl}/twilio/status`, inboundUrl: `${appUrl}/twilio/inbound` });
    await prov('twilio', 'twshort', { verifyExpirySeconds: '1' });
    await prov('twilio-whatsapp', 'twwa', { statusCallbackUrl: `${appUrl}/twwa/status`, inboundUrl: `${appUrl}/twwa/inbound`, readReceipts: 'true' });
    await prov('vonage', 'vonage', { verifyCallbackUrl: `${appUrl}/vonage/verify` });
    await prov('vonage', 'vgshort', { verifyCallbackUrl: `${appUrl}/vgshort/verify`, verifyExpirySeconds: '1' });
    await prov('meta-whatsapp', 'meta', { statusCallbackUrl: `${appUrl}/meta/hook`, readReceipts: 'true' });
    await prov('meta-whatsapp', 'metawin', { statusCallbackUrl: `${appUrl}/metawin/hook`, enforce24hWindow: 'true' });
    await prov('sendgrid', 'sendgrid', { inboundUrl: `${appUrl}/sg/inbound` });
    await prov('sendgrid', 'sgraw', { inboundUrl: `${appUrl}/sgraw/inbound`, inboundFormat: 'raw' });
    await prov('mailgun', 'mailgun', { inboundUrl: `${appUrl}/mg/inbound`, webhookSigningKey: 'mg-key' });
    await prov('ses', 'ses', { inboundUrl: `${appUrl}/ses/inbound` });
    await prov('generic-email', 'genmail', { inboundUrl: `${appUrl}/gen/inbound`, inboundTemplate: '{"sender":"{{from}}","subj":"{{subject}}","body":"{{text}}"}' });
    await api('PATCH', '/api/projects/hyper/providers/mail', { config: { inboundUrl: `${appUrl}/smtp/inbound` } });
  }, 30_000);

  afterAll(async () => {
    appServer?.close();
    await running?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ Twilio Verify
  describe('Twilio Verify v2', () => {
    let va: string;

    it('creates and fetches a service; unknown services are 20404', async () => {
      const bad = await tw('POST', '/v2/Services', {});
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe(20001);
      const r = await tw('POST', '/v2/Services', { FriendlyName: 'Hyper', CodeLength: '6' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ friendly_name: 'Hyper', code_length: 6, account_sid: 'AC' + 'a'.repeat(32) });
      expect(r.body.sid).toMatch(/^VA[0-9a-f]{32}$/);
      expect(r.body.url).toBe(`https://verify.twilio.com/v2/Services/${r.body.sid}`);
      va = r.body.sid;
      expect((await tw('GET', `/v2/Services/${va}`)).body.sid).toBe(va);
      const nf = await tw('GET', '/v2/Services/VA' + '0'.repeat(32));
      expect(nf.status).toBe(404);
      expect(nf.body).toMatchObject({ code: 20404, status: 404 });
    });

    it('sends a generated code by SMS, checks wrong (pending) and right (approved), then 20404', async () => {
      const c = await user('customer1');
      const v = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'sms' });
      expect(v.status).toBe(201);
      expect(v.body).toMatchObject({ status: 'pending', valid: false, channel: 'sms', to: c.phone, service_sid: va });
      expect(v.body.sid).toMatch(/^VE[0-9a-f]{32}$/);
      expect(v.body.send_code_attempts).toHaveLength(1);
      const m = await latest('customer1', 'sms');
      expect(m.otp).toMatch(/^\d{6}$/);
      expect(m.bodyText).toBe(`Your Hyper verification code is: ${m.otp}`);
      expect(m.metadata.verify).toMatchObject({ api: 'twilio-verify', verificationSid: v.body.sid });

      const wrong = await tw('POST', `/v2/Services/${va}/VerificationCheck`, { To: c.phone, Code: m.otp === '111111' ? '222222' : '111111' });
      expect(wrong.status).toBe(200);
      expect(wrong.body).toMatchObject({ status: 'pending', valid: false });
      const ok = await tw('POST', `/v2/Services/${va}/VerificationCheck`, { VerificationSid: v.body.sid, Code: m.otp });
      expect(ok.body).toMatchObject({ status: 'approved', valid: true, sid: v.body.sid });
      const again = await tw('POST', `/v2/Services/${va}/VerificationCheck`, { To: c.phone, Code: m.otp });
      expect(again.status).toBe(404);
      expect(again.body.code).toBe(20404);
    });

    it('resends the same code; the 6th send is 60203; the 6th check is 60202', async () => {
      const c = await user('customer2');
      let sid = '';
      const codes = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const r = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'sms' });
        expect(r.status).toBe(201);
        sid ||= r.body.sid;
        expect(r.body.sid).toBe(sid);
        codes.add((await latest('customer2', 'sms')).otp);
      }
      expect(codes.size).toBe(1);
      const sixth = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'sms' });
      expect(sixth.status).toBe(429);
      expect(sixth.body).toMatchObject({ code: 60203, message: 'Max send attempts reached' });
      const [code] = [...codes];
      const wrongCode = code === '000000' ? '999999' : '000000';
      for (let i = 0; i < 5; i++) expect((await tw('POST', `/v2/Services/${va}/VerificationCheck`, { To: c.phone, Code: wrongCode })).body.status).toBe('pending');
      const blocked = await tw('POST', `/v2/Services/${va}/VerificationCheck`, { To: c.phone, Code: code });
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe(60202);
      expect((await tw('GET', `/v2/Services/${va}/Verifications/${sid}`)).body.status).toBe('max_attempts_reached');
    });

    it('validates parameters (60200), supports CustomCode, call / whatsapp / email channels and cancel', async () => {
      const c = await user('customer3');
      expect((await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'pigeon' })).body).toMatchObject({ code: 60200, status: 400 });
      expect((await tw('POST', `/v2/Services/${va}/Verifications`, { To: 'nope', Channel: 'sms' })).body.code).toBe(60200);
      expect((await tw('POST', `/v2/Services/${va}/Verifications`, { Channel: 'sms' })).body.code).toBe(20001);

      const call = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'call', CustomCode: '4321' });
      expect(call.status).toBe(201);
      expect(call.body.channel).toBe('call');
      const vm = await latest('customer3', 'sms');
      expect(vm.metadata.voice).toBe(true);
      expect(vm.otp).toBe('4321');
      expect(vm.bodyText).toContain('4 3 2 1');
      const cancel = await tw('POST', `/v2/Services/${va}/Verifications/${call.body.sid}`, { Status: 'canceled' });
      expect(cancel.body.status).toBe('canceled');
      expect((await tw('POST', `/v2/Services/${va}/VerificationCheck`, { To: c.phone, Code: '4321' })).status).toBe(404);

      const w = await tw('POST', `/v2/Services/${va}/Verifications`, { To: `whatsapp:${c.whatsapp ?? c.phone}`, Channel: 'whatsapp' });
      expect(w.status).toBe(201);
      const wm = await latest('customer3', 'whatsapp');
      expect(wm.bodyText).toContain(`*${wm.otp}*`);

      const e = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.email, Channel: 'email' });
      expect(e.status).toBe(201);
      const em = await latest('customer3', 'email');
      expect(em.subject).toBe('Hyper verification code');
      expect(em.otp).toMatch(/^\d{6}$/);
      expect(em.mailpitId).toBeTruthy();
      expect((await tw('POST', `/v2/Services/${va}/VerificationCheck`, { To: c.email, Code: em.otp })).body.status).toBe('approved');
    });

    it('applies scenario rules to the delivery and expires codes (20404)', async () => {
      const c = await user('customer4');
      await rule('customer4', { channel: 'sms', action: 'reject', count: 1 });
      const rej = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'sms' });
      expect(rej.status).toBe(400);
      expect(rej.body.code).toBe(60200);
      expect((await latest('customer4', 'sms')).status).toBe('rejected');
      await rule('customer4', { channel: 'sms', action: 'rate_limit', count: 1 });
      expect((await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'sms' })).status).toBe(429);
      await rule('customer4', { channel: 'sms', action: 'fail', count: 1 });
      const failed = await tw('POST', `/v2/Services/${va}/Verifications`, { To: c.phone, Channel: 'sms' });
      expect(failed.status).toBe(201);
      expect((await latest('customer4', 'sms')).status).toBe('failed');
      await clearRules('customer4');

      // Unknown VA sids are created on first use (hard-coded sid in the app's .env); the short instance expires after 1 s.
      const sid = 'VA' + 'b'.repeat(32);
      expect((await api('POST', `/mock/hyper/twshort/v2/Services/${sid}/Verifications`, form({ To: c.phone, Channel: 'sms' }), basic)).status).toBe(201);
      const code = (await latest('customer4', 'sms')).otp;
      await new Promise((r) => setTimeout(r, 1100));
      const exp = await api('POST', `/mock/hyper/twshort/v2/Services/${sid}/VerificationCheck`, form({ To: c.phone, Code: code }), basic);
      expect(exp.status).toBe(404);
      expect(exp.body.code).toBe(20404);
    });

    it('attributes verification messages to test runs (minted users)', async () => {
      const run = (await api('POST', '/api/projects/hyper/runs', { key: 'vr1', users: [{ role: 'customer' }] })).body;
      const u = run.users[0];
      expect((await tw('POST', `/v2/Services/${va}/Verifications`, { To: u.phone, Channel: 'sms' })).status).toBe(201);
      const msgs = (await api('GET', '/api/projects/hyper/messages?run=vr1')).body;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].runId).toBe(run.id);
      expect(msgs[0].otp).toMatch(/^\d{6}$/);
      await api('POST', '/api/projects/hyper/runs/vr1/stop?purge=1');
    });
  });

  // ------------------------------------------------------------------ Vonage Verify v2
  describe('Vonage Verify v2', () => {
    it('requires credentials and validates the request (422)', async () => {
      expect((await api('POST', '/mock/hyper/vonage/v2/verify', { brand: 'X' })).status).toBe(401);
      const r = await vg('POST', '/v2/verify', { brand: 'A brand name that is far too long', workflow: [{ channel: 'pigeon', to: '1' }], code_length: 12 });
      expect(r.status).toBe(422);
      expect(r.body.title).toBe('Invalid request params');
      expect(r.body.invalid_parameters.map((p: any) => p.name).sort()).toEqual(['brand', 'code_length', 'workflow[0].channel']);
    });

    it('sends a code, rejects a wrong one (400), completes (200) and calls back; concurrent requests are 409', async () => {
      const c = await user('customer5');
      const to = c.phone.replace(/^\+/, '');
      const r = await vg('POST', '/v2/verify', { brand: 'Hyper', workflow: [{ channel: 'sms', to }] });
      expect(r.status).toBe(202);
      expect(r.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
      const m = await latest('customer5', 'sms');
      expect(m.otp).toMatch(/^\d{4}$/);
      expect(m.bodyText).toBe(`Your Hyper verification code is: ${m.otp}`);
      const dup = await vg('POST', '/v2/verify', { brand: 'Hyper', workflow: [{ channel: 'sms', to }] });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ title: 'Conflict', request_id: r.body.request_id });
      const wrong = await vg('POST', `/v2/verify/${r.body.request_id}`, { code: m.otp === '1111' ? '2222' : '1111' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.title).toBe('Invalid Code');
      const ok = await vg('POST', `/v2/verify/${r.body.request_id}`, { code: m.otp });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ request_id: r.body.request_id, status: 'completed' });
      const cb = await waitFor(() => hooks('/vonage/verify').find((h) => JSON.parse(h.body).request_id === r.body.request_id));
      expect(JSON.parse(cb.body)).toMatchObject({ status: 'completed', type: 'summary', workflow: [{ channel: 'sms', status: 'completed' }] });
      expect((await vg('POST', `/v2/verify/${r.body.request_id}`, { code: m.otp })).status).toBe(404);
    });

    it('terminates after 3 wrong codes (410 + failed callback), cancels (204), expires (410 + expired callback)', async () => {
      const c = await user('customer6');
      const r = await vg('POST', '/v2/verify', { brand: 'Hyper', code_length: 6, workflow: [{ channel: 'email', to: c.email }, { channel: 'voice', to: c.phone.replace('+', '') }] });
      expect(r.status).toBe(202);
      const em = await latest('customer6', 'email');
      expect(em.otp).toMatch(/^\d{6}$/);
      const next = await vg('POST', `/v2/verify/${r.body.request_id}/next_workflow`);
      expect(next.status).toBe(200);
      expect((await latest('customer6', 'sms')).metadata.voice).toBe(true);
      const bad = em.otp === '000000' ? '999999' : '000000';
      expect((await vg('POST', `/v2/verify/${r.body.request_id}`, { code: bad })).status).toBe(400);
      expect((await vg('POST', `/v2/verify/${r.body.request_id}`, { code: bad })).status).toBe(400);
      const third = await vg('POST', `/v2/verify/${r.body.request_id}`, { code: bad });
      expect(third.status).toBe(410);
      expect((await vg('POST', `/v2/verify/${r.body.request_id}`, { code: em.otp })).status).toBe(410);
      const failed = await waitFor(() => hooks('/vonage/verify').find((h) => JSON.parse(h.body).request_id === r.body.request_id));
      expect(JSON.parse(failed.body).status).toBe('failed');

      const r2 = await vg('POST', '/v2/verify', { brand: 'Hyper', workflow: [{ channel: 'whatsapp', to: c.phone.replace('+', '') }] });
      expect(r2.status).toBe(202);
      expect((await vg('DELETE', `/v2/verify/${r2.body.request_id}`)).status).toBe(204);
      expect((await vg('DELETE', `/v2/verify/${r2.body.request_id}`)).status).toBe(404);

      const r3 = await vg('POST', '/v2/verify', { brand: 'Hyper', workflow: [{ channel: 'sms', to: c.phone.replace('+', '') }] }, 'vgshort');
      const code = (await latest('customer6', 'sms')).otp;
      const expired = await waitFor(() => hooks('/vgshort/verify').find((h) => JSON.parse(h.body).request_id === r3.body.request_id), 4000);
      expect(JSON.parse(expired.body).status).toBe('expired');
      expect((await vg('POST', `/v2/verify/${r3.body.request_id}`, { code }, 'vgshort')).status).toBe(410);
    });

    it('maps rules to Vonage errors', async () => {
      const c = await user('customer7');
      await rule('customer7', { channel: 'sms', action: 'rate_limit', count: 1 });
      const r = await vg('POST', '/v2/verify', { brand: 'Hyper', workflow: [{ channel: 'sms', to: c.phone.replace('+', '') }] });
      expect(r.status).toBe(429);
      expect(r.body.title).toBe('Rate Limit Hit');
      await clearRules('customer7');
    });
  });

  // ------------------------------------------------------------------ WhatsApp
  describe('WhatsApp media, interactive messages, read receipts, button replies, 24-hour window', () => {
    it('validates and stores media / location / contacts / reaction / interactive messages', async () => {
      const c = await user('customer1');
      const to = c.phone.replace('+', '');
      const ok = async (body: Record<string, unknown>) => {
        const r = await wa({ messaging_product: 'whatsapp', to, ...body });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return latest('customer1', 'whatsapp');
      };
      const err = async (body: Record<string, unknown>) => {
        const r = await wa({ messaging_product: 'whatsapp', to, ...body });
        expect(r.status).toBe(400);
        return r.body.error;
      };
      const img = await ok({ type: 'image', image: { link: 'https://example.test/a.png', caption: 'Your code is 554433' } });
      expect(img.metadata.wa).toMatchObject({ type: 'image', caption: 'Your code is 554433', media: { link: 'https://example.test/a.png' } });
      expect(img.otp).toBe('554433');
      expect((await err({ type: 'image', image: {} })).message).toContain("must contain either 'id' or 'link'");
      expect((await err({ type: 'audio', audio: { link: 'https://x.test/a.ogg', caption: 'no' } })).code).toBe(100);
      expect((await ok({ type: 'document', document: { link: 'https://x.test/i.pdf', filename: 'invoice.pdf' } })).metadata.wa.media.filename).toBe('invoice.pdf');
      expect((await ok({ type: 'location', location: { latitude: 24.86, longitude: 67.0, name: 'Office' } })).metadata.wa.location).toMatchObject({ latitude: 24.86, name: 'Office' });
      expect((await err({ type: 'location', location: { latitude: 100, longitude: 0 } })).message).toContain('latitude');
      expect((await ok({ type: 'contacts', contacts: [{ name: { formatted_name: 'Support' }, phones: [{ phone: '+15550001' }] }] })).metadata.wa.contacts[0].name).toBe('Support');
      expect((await ok({ type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } })).metadata.wa.reaction.emoji).toBe('👍');
      expect((await ok({ type: 'interactive', interactive: { type: 'cta_url', body: { text: 'Pay' }, action: { name: 'cta_url', parameters: { display_text: 'Open', url: 'https://pay.test/1' } } } })).links).toContain('https://pay.test/1');
      const four = { type: 'interactive', interactive: { type: 'button', body: { text: 'Pick' }, action: { buttons: [1, 2, 3, 4].map((i) => ({ type: 'reply', reply: { id: `b${i}`, title: `B${i}` } })) } } };
      expect((await err(four)).message).toContain('between 1 and 3');
      const longTitle = { type: 'interactive', interactive: { type: 'button', body: { text: 'Pick' }, action: { buttons: [{ type: 'reply', reply: { id: 'x', title: 'x'.repeat(21) } }] } } };
      expect((await err(longTitle)).message).toContain('at most 20');
      expect((await err({ type: 'carrier_pigeon', carrier_pigeon: {} })).message).toContain('Param type must be one of');
    });

    it('uploads media, describes and serves it, sends by id, deletes it', async () => {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const fd = new FormData();
      fd.append('messaging_product', 'whatsapp');
      fd.append('type', 'image/png');
      fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
      const up = await api('POST', '/mock/hyper/meta/v21.0/1234567/media', fd);
      expect(up.status).toBe(200);
      expect(up.body.id).toMatch(/^\d{16}$/);
      const info = await api('GET', `/mock/hyper/meta/v21.0/${up.body.id}`);
      expect(info.body).toMatchObject({ messaging_product: 'whatsapp', mime_type: 'image/png', file_size: png.length, id: up.body.id, sha256: createHash('sha256').update(png).digest('hex') });
      const dl = await fetch(info.body.url);
      expect(dl.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await dl.arrayBuffer()).equals(png)).toBe(true);

      const c = await user('customer2');
      const to = c.phone.replace('+', '');
      expect((await wa({ messaging_product: 'whatsapp', to, type: 'image', image: { id: up.body.id } })).status).toBe(200);
      expect((await latest('customer2', 'whatsapp')).metadata.wa.media).toMatchObject({ id: up.body.id, mimeType: 'image/png' });
      const wrongType = await wa({ messaging_product: 'whatsapp', to, type: 'video', video: { id: up.body.id } });
      expect(wrongType.body.error.code).toBe(131053);
      const bad = new FormData();
      bad.append('messaging_product', 'whatsapp');
      bad.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'x.exe');
      expect((await api('POST', '/mock/hyper/meta/v21.0/1234567/media', bad)).body.error.code).toBe(131053);
      expect((await api('DELETE', `/mock/hyper/meta/v21.0/${up.body.id}`)).body).toEqual({ success: true });
      const gone = await api('GET', `/mock/hyper/meta/v21.0/${up.body.id}`);
      expect(gone.status).toBe(400);
      expect(gone.body.error.code).toBe(100);
      expect((await wa({ messaging_product: 'whatsapp', to, type: 'image', image: { id: up.body.id } })).body.error.code).toBe(131053);
    });

    it('sends read receipts (instance option and "Mark as read") and accepts the app marking inbound messages read', async () => {
      const c = await user('customer3');
      const r = await wa({ messaging_product: 'whatsapp', to: c.phone.replace('+', ''), type: 'text', text: { body: 'hello' } });
      const wamid = r.body.messages[0].id;
      const statuses = () => hooks('/meta/hook').flatMap((h) => JSON.parse(h.body).entry[0].changes[0].value.statuses ?? []).filter((s: any) => s.id === wamid).map((s: any) => s.status);
      await waitFor(() => statuses().includes('read'));
      expect(statuses()).toEqual(['sent', 'delivered', 'read']);
      const m = await latest('customer3', 'whatsapp');
      await waitFor(async () => (await api('GET', `/api/messages/${m.id}`)).body.metadata.readReceiptAt);

      // Manual "Mark as read" on an instance without automatic receipts.
      const t = await api('POST', '/mock/hyper/twilio/2010-04-01/Accounts/ACx/Messages.json', form({ To: `whatsapp:${c.phone}`, From: 'whatsapp:+15550001111', Body: 'hi' }));
      await waitFor(() => hooks('/twilio/status').some((h) => h.body.includes(t.body.sid) && h.body.includes('MessageStatus=delivered')));
      const tm = await latest('customer3', 'whatsapp');
      expect((await api('POST', `/api/projects/hyper/messages/${tm.id}/read-receipt`, {})).status).toBe(202);
      await waitFor(() => hooks('/twilio/status').some((h) => h.body.includes(t.body.sid) && h.body.includes('MessageStatus=read')));
      expect((await api('POST', `/api/projects/hyper/messages/${(await latest('customer3', 'sms'))?.id ?? 'x'}/read-receipt`, {})).status).toBeGreaterThanOrEqual(400);

      const mark = await wa({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.inbound' });
      expect(mark.body).toEqual({ success: true });
    });

    it('replies with buttons / list rows / template quick replies (Meta) and ButtonPayload (Twilio)', async () => {
      const c = await user('customer4');
      const to = c.phone.replace('+', '');
      const sent = await wa({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: 'Confirm order?' }, action: { buttons: [{ type: 'reply', reply: { id: 'yes-1', title: 'Yes' } }, { type: 'reply', reply: { id: 'no-1', title: 'No' } }] } } });
      const wamid = sent.body.messages[0].id;
      const r = await api('POST', '/api/projects/hyper/users/customer4/reply', { channel: 'whatsapp', instance: 'meta', button: 'yes' });
      expect(r.status).toBe(201);
      expect(r.body.webhook.ok).toBe(true);
      const hook = hooks('/meta/hook').map((h) => JSON.parse(h.body).entry[0].changes[0].value).find((v: any) => v.messages?.[0]?.interactive);
      expect(hook.messages[0]).toMatchObject({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes-1', title: 'Yes' } }, context: { id: wamid } });
      expect(r.body.message.metadata.wa.reply).toMatchObject({ kind: 'button_reply', id: 'yes-1' });
      const unknown = await api('POST', '/api/projects/hyper/users/customer4/reply', { channel: 'whatsapp', instance: 'meta', button: 'maybe' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error ?? unknown.body.message).toContain('Yes (yes-1)');

      await wa({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'list', body: { text: 'Pick a slot' }, action: { button: 'Slots', sections: [{ title: 'Today', rows: [{ id: 's1', title: '10:00', description: 'Morning' }] }, { title: 'Tomorrow', rows: [{ id: 's2', title: '14:00' }] }] } } });
      await api('POST', '/api/projects/hyper/users/customer4/reply', { channel: 'whatsapp', instance: 'meta', button: 's2' });
      const list = hooks('/meta/hook').map((h) => JSON.parse(h.body).entry[0].changes[0].value).filter((v: any) => v.messages?.[0]?.interactive?.type === 'list_reply').pop();
      expect(list.messages[0].interactive.list_reply).toEqual({ id: 's2', title: '14:00' });

      await wa({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'order_update', language: { code: 'en' }, components: [{ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'TRACK' }] }] } });
      await api('POST', '/api/projects/hyper/users/customer4/reply', { channel: 'whatsapp', instance: 'meta', button: 'TRACK' });
      const btn = hooks('/meta/hook').map((h) => JSON.parse(h.body).entry[0].changes[0].value).filter((v: any) => v.messages?.[0]?.type === 'button').pop();
      expect(btn.messages[0].button).toEqual({ payload: 'TRACK', text: 'TRACK' });

      const tr = await api('POST', '/api/projects/hyper/users/customer4/reply', { channel: 'whatsapp', instance: 'twwa', buttonReply: { id: 'CONFIRM', title: 'Confirm' } });
      expect(tr.status).toBe(201);
      const tw = Object.fromEntries(new URLSearchParams(hooks('/twwa/inbound').pop()!.body));
      expect(tw).toMatchObject({ ButtonPayload: 'CONFIRM', ButtonText: 'Confirm', Body: 'Confirm', MessageType: 'button' });
    });

    it('enforces the 24-hour window when enabled (131047), templates pass, a reply opens it', async () => {
      const c = await user('customer5');
      const to = c.phone.replace('+', '');
      const r = await wa({ messaging_product: 'whatsapp', to, type: 'text', text: { body: 'Free-form' } }, 'metawin');
      expect(r.status).toBe(200);
      const m = await latest('customer5', 'whatsapp');
      expect(m.status).toBe('failed');
      expect(m.metadata.errorCode).toBe('131047');
      const fail = await waitFor(() => hooks('/metawin/hook').map((h) => JSON.parse(h.body).entry[0].changes[0].value.statuses?.[0]).find((s: any) => s?.status === 'failed'));
      expect(fail.errors[0].code).toBe(131047);
      await wa({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello', language: { code: 'en' } } }, 'metawin');
      expect((await latest('customer5', 'whatsapp')).status).toBe('delivered');
      await api('POST', '/api/projects/hyper/users/customer5/reply', { channel: 'whatsapp', instance: 'metawin', text: 'hi' });
      await wa({ messaging_product: 'whatsapp', to, type: 'text', text: { body: 'Now allowed' } }, 'metawin');
      expect((await latest('customer5', 'whatsapp')).status).toBe('delivered');
    });

    it('Twilio media: MediaUrl validation, num_media', async () => {
      const c = await user('customer6');
      const bad = await api('POST', '/mock/hyper/twilio/2010-04-01/Accounts/ACx/Messages.json', form({ To: `whatsapp:${c.phone}`, From: 'whatsapp:+1555', MediaUrl: 'ftp://x' }));
      expect(bad.body.code).toBe(21620);
      const ok = await api('POST', '/mock/hyper/twilio/2010-04-01/Accounts/ACx/Messages.json', form({ To: `whatsapp:${c.phone}`, From: 'whatsapp:+1555', MediaUrl: 'https://x.test/a.jpg', Body: 'Receipt' }));
      expect(ok.body.num_media).toBe('1');
      expect((await latest('customer6', 'whatsapp')).metadata.wa).toMatchObject({ type: 'media', mediaUrls: ['https://x.test/a.jpg'], caption: 'Receipt' });
    });
  });

  // ------------------------------------------------------------------ Inbound email
  describe('inbound email (reply by email)', () => {
    const parseMultipart = async (h: { headers: http.IncomingHttpHeaders; body: string }) =>
      Object.fromEntries((await new Response(h.body, { headers: { 'content-type': String(h.headers['content-type']) } }).formData()).entries()) as Record<string, string>;

    it('SendGrid Inbound Parse (parsed): threads with In-Reply-To, stores the reply, logs the call', async () => {
      const c = await user('customer7');
      const sent = await api('POST', '/mock/hyper/sendgrid/v3/mail/send', {
        personalizations: [{ to: [{ email: c.email }] }],
        from: { email: 'support@hyper.app' },
        subject: 'Ticket #42',
        content: [{ type: 'text/plain', value: 'How can we help?' }],
      });
      expect(sent.status).toBe(202);
      const orig = await latest('customer7', 'email');
      const r = await api('POST', '/api/projects/hyper/users/customer7/reply', { channel: 'email', instance: 'sendgrid', text: 'My order is late', inReplyTo: orig.id });
      expect(r.status).toBe(201);
      expect(r.body.webhook.ok).toBe(true);
      expect(r.body.message).toMatchObject({ direction: 'inbound', channel: 'email', subject: 'Re: Ticket #42', to: 'support@hyper.app', status: 'received' });
      expect(r.body.message.mailpitId).toBeTruthy();
      const f = await parseMultipart(hooks('/sg/inbound').pop()!);
      expect(f).toMatchObject({ to: 'support@hyper.app', subject: 'Re: Ticket #42', text: 'My order is late', SPF: 'pass', attachments: '0' });
      expect(JSON.parse(f.envelope)).toEqual({ to: ['support@hyper.app'], from: c.email });
      expect(f.headers).toContain(`In-Reply-To: ${orig.messageIdHeader}`);
      expect(f.headers).toContain(`References: ${orig.messageIdHeader}`);
      expect(f.from).toContain(c.email);
      const log = (await api('GET', `/api/logs/${r.body.webhook.logId}`)).body;
      expect(log.direction).toBe('outbound');
    });

    it('SendGrid raw, Mailgun route (signed), SES receipt, generic template, SMTP JSON', async () => {
      const c = await user('customer8');
      await api('POST', '/api/projects/hyper/users/customer8/reply', { channel: 'email', instance: 'sgraw', subject: 'Hello', text: 'Raw please', to: 'in@parse.hyper.app' });
      const raw = await parseMultipart(hooks('/sgraw/inbound').pop()!);
      expect(raw.email).toContain('Subject: Hello');
      expect(raw.email).toContain('Raw please');
      expect(raw.text).toBeUndefined();

      await api('POST', '/api/projects/hyper/users/customer8/reply', { channel: 'email', instance: 'mailgun', subject: 'Re: x', text: 'Yes please\n\nOn Mon, Support wrote:\n> old text', to: 'support@mg.hyper.app' });
      const mg = Object.fromEntries(new URLSearchParams(hooks('/mg/inbound').pop()!.body));
      expect(mg).toMatchObject({ recipient: 'support@mg.hyper.app', sender: c.email, subject: 'Re: x', 'stripped-text': 'Yes please' });
      expect(mg.signature).toBe(createHmac('sha256', 'mg-key').update(mg.timestamp + mg.token).digest('hex'));
      expect(JSON.parse(mg['message-headers']).some(([k]: [string]) => k === 'Message-ID')).toBe(true);

      await api('POST', '/api/projects/hyper/users/customer8/reply', { channel: 'email', instance: 'ses', text: 'Via SES', to: 'in@ses.hyper.app' });
      const sesHook = hooks('/ses/inbound').pop()!;
      expect(sesHook.headers['x-amz-sns-message-type']).toBe('Notification');
      const sns = JSON.parse(sesHook.body);
      const ev = JSON.parse(sns.Message);
      expect(ev).toMatchObject({ notificationType: 'Received', mail: { source: c.email, destination: ['in@ses.hyper.app'] }, receipt: { action: { type: 'SNS' } } });
      expect(ev.content).toContain('Via SES');

      await api('POST', '/api/projects/hyper/users/customer8/reply', { channel: 'email', instance: 'genmail', subject: 'Quote "test"', text: 'Line 1\nLine 2', to: 'x@y.test' });
      expect(JSON.parse(hooks('/gen/inbound').pop()!.body)).toEqual({ sender: c.email, subj: 'Quote "test"', body: 'Line 1\nLine 2' });

      const smtp = await api('POST', '/api/projects/hyper/users/customer8/reply', { channel: 'email', text: 'Default instance', to: 'app@hyper.app' });
      expect(smtp.status).toBe(201);
      const j = JSON.parse(hooks('/smtp/inbound').pop()!.body);
      expect(j).toMatchObject({ from: c.email, to: 'app@hyper.app', subject: '(no subject)', text: 'Default instance' });
      expect(j.messageId).toMatch(/^<.+@.+>$/);

      // SMTP instance with the SendGrid format.
      await api('PATCH', '/api/projects/hyper/providers/mail', { config: { inboundUrl: `${appUrl}/smtp-sg/inbound`, inboundFormat: 'sendgrid' } });
      await api('POST', '/api/projects/hyper/users/customer8/reply', { channel: 'email', text: 'As SendGrid', to: 'app@hyper.app' });
      expect((await parseMultipart(hooks('/smtp-sg/inbound').pop()!)).text).toBe('As SendGrid');
      const timeline = (await api('GET', '/api/projects/hyper/messages?user=customer8&channel=email')).body;
      expect(timeline.filter((m: any) => m.direction === 'inbound')).toHaveLength(6);
    });

    it('attachments: SendGrid files + attachment-info, Mailgun multipart, JSON base64, raw MIME; binary-safe; limits', async () => {
      const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i)); // every byte value
      const attachments = [
        { filename: 'bytes.bin', contentType: 'application/octet-stream', contentBase64: bin.toString('base64') },
        { filename: 'note.txt', contentType: 'text/plain', contentBase64: Buffer.from('héllo').toString('base64') },
      ];
      const form = async (h: { headers: http.IncomingHttpHeaders; raw: Buffer }) => new Response(new Uint8Array(h.raw), { headers: { 'content-type': String(h.headers['content-type']) } }).formData();

      const sg = await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', instance: 'sendgrid', subject: 'Files', text: 'See attached', to: 'in@hyper.app', attachments });
      expect(sg.status, JSON.stringify(sg.body)).toBe(201);
      expect(sg.body.message.attachments).toBe(2);
      expect(sg.body.message.metadata.attachments).toEqual([
        { filename: 'bytes.bin', contentType: 'application/octet-stream', size: 256 },
        { filename: 'note.txt', contentType: 'text/plain', size: 6 },
      ]);
      const f = await form(hooks('/sg/inbound').pop()!);
      expect(f.get('attachments')).toBe('2');
      expect(JSON.parse(String(f.get('attachment-info')))).toEqual({
        attachment1: { filename: 'bytes.bin', name: 'bytes.bin', type: 'application/octet-stream' },
        attachment2: { filename: 'note.txt', name: 'note.txt', type: 'text/plain' },
      });
      const a1 = f.get('attachment1') as File;
      expect(a1.name).toBe('bytes.bin');
      expect(Buffer.from(await a1.arrayBuffer()).equals(bin)).toBe(true);
      expect(await (f.get('attachment2') as File).text()).toBe('héllo');
      expect(f.get('text')).toBe('See attached');

      await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', instance: 'mailgun', text: 'Files via Mailgun', to: 'in@mg.hyper.app', attachments });
      const mgHook = hooks('/mg/inbound').pop()!;
      expect(String(mgHook.headers['content-type'])).toMatch(/^multipart\/form-data/);
      const mg = await form(mgHook);
      expect(mg.get('attachment-count')).toBe('2');
      expect(Buffer.from(await (mg.get('attachment-1') as File).arrayBuffer()).equals(bin)).toBe(true);
      expect(mg.get('signature')).toBe(createHmac('sha256', 'mg-key').update(String(mg.get('timestamp')) + String(mg.get('token'))).digest('hex'));

      await api('POST', '/api/projects/hyper/providers', { preset: 'generic-email', slug: 'genjson', config: { inboundUrl: `${appUrl}/genjson/inbound` } });
      await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', instance: 'genjson', text: 'JSON files', to: 'x@y.test', attachments });
      const j = JSON.parse(hooks('/genjson/inbound').pop()!.body);
      expect(j.attachments).toEqual([
        { filename: 'bytes.bin', contentType: 'application/octet-stream', size: 256, contentBase64: bin.toString('base64') },
        { filename: 'note.txt', contentType: 'text/plain', size: 6, contentBase64: Buffer.from('héllo').toString('base64') },
      ]);

      await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', instance: 'sgraw', text: 'Raw files', to: 'x@y.test', attachments: [attachments[1]] });
      const raw = await form(hooks('/sgraw/inbound').pop()!);
      expect(String(raw.get('email'))).toMatch(/Content-Disposition: attachment; filename=note\.txt/);

      // Text may be empty when files are attached; limits and validation.
      expect((await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', instance: 'genjson', text: '', to: 'x@y.test', attachments: [attachments[1]] })).status).toBe(201);
      expect((await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', text: 'x', attachments: 'nope' })).status).toBe(400);
      expect((await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', text: 'x', attachments: [{ filename: 'a', contentBase64: '!!!' }] })).status).toBe(400);
      expect((await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', text: 'x', attachments: [{ contentBase64: 'aGk=' }] })).status).toBe(400);
      expect((await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', text: 'x', attachments: Array.from({ length: 11 }, () => attachments[1]) })).status).toBe(413);
      const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
      expect((await api('POST', '/api/projects/hyper/users/customer6/reply', { channel: 'email', text: 'x', attachments: [{ filename: 'big.bin', contentBase64: big }] })).status).toBe(413);
    });

    it('reports a missing inbound URL and unknown inReplyTo', async () => {
      await api('POST', '/api/projects/hyper/providers', { preset: 'sendgrid', slug: 'sgnone', config: {} });
      const r = await api('POST', '/api/projects/hyper/users/customer9/reply', { channel: 'email', instance: 'sgnone', text: 'hi' });
      expect(r.status).toBe(201);
      expect(r.body.webhook).toBeNull();
      expect(r.body.message.statusDetail).toContain('No inbound URL');
      expect((await api('POST', '/api/projects/hyper/users/customer9/reply', { channel: 'email', text: 'hi', inReplyTo: 'nope' })).status).toBe(404);
    });
  });
});
