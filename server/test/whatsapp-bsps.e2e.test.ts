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
const received: { path: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
let appServer: http.Server;
let appUrl: string;

async function api<T = any>(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const isForm = typeof body === 'string';
  const r = await fetch(base + p, {
    method,
    headers: body !== undefined ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T };
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

const users: Record<string, { id: string; phone: string }> = {};
const latest = async (u: string) => (await api('GET', `/api/projects/wa/messages?user=${users[u].id}&channel=whatsapp&limit=1`)).body[0];
const hooks = (p: string) => received.filter((r) => r.path === p).map((r) => JSON.parse(r.body));
const addProvider = (preset: string, slug: string, config: Record<string, unknown> = {}) =>
  api('POST', '/api/projects/wa/providers', { preset, slug, config: { statusCallbackUrl: `${appUrl}/hook/${slug}`, ...config } });
const digits = (u: string) => users[u].phone.replace('+', '');
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe.skipIf(!haveMailpit)('WhatsApp BSP presets and template lifecycle', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-wa-'));
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
    expect((await api('POST', '/api/projects', { name: 'WA' })).status).toBe(201);
    for (const [i, name] of ['meta', 'd360', 'ib', 'gs', 'uni'].entries()) {
      const r = await api('POST', '/api/projects/wa/users', { name, phone: `+96650000001${i}` });
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
    expect(ids).toEqual(expect.arrayContaining(['meta-whatsapp', '360dialog', 'infobip-whatsapp', 'gupshup', 'unifonic-whatsapp']));
  });

  it('Meta: template lifecycle (create → pending → send fails → approve → webhook → send works; reject, pause, quality, auto review)', async () => {
    expect((await addProvider('meta-whatsapp', 'meta', { appSecret: 's3cret', wabaId: '555000111' })).status).toBe(201);
    const tplUrl = '/mock/wa/meta/v21.0/555000111/message_templates';
    const sendTpl = (name: string, lang = 'en_US') =>
      api('POST', '/mock/wa/meta/v21.0/123456/messages', {
        messaging_product: 'whatsapp',
        to: digits('meta'),
        type: 'template',
        template: { name, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'A-17' }] }] },
      });

    // Create: PENDING, Graph-style response.
    const c = await api('POST', tplUrl, { name: 'order_update', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'Order {{1}} shipped' }] });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'PENDING', category: 'UTILITY' });
    const id = c.body.id;
    expect(id).toMatch(/^\d{16}$/);
    // Validation: bad name, duplicate.
    expect((await api('POST', tplUrl, { name: 'Bad Name', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] })).body.error.code).toBe(100);
    const dup = await api('POST', tplUrl, { name: 'order_update', language: 'en_US', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error.error_subcode).toBe(2388024);

    // List and get by id.
    const list = await api('GET', `${tplUrl}?name=order_update`);
    expect(list.body.data).toEqual([expect.objectContaining({ id, name: 'order_update', status: 'PENDING', language: 'en_US' })]);
    expect((await api('GET', `/mock/wa/meta/v21.0/${id}`)).body).toMatchObject({ id, status: 'PENDING' });

    // Sending a PENDING template fails with 132001.
    const pending = await sendTpl('order_update');
    expect(pending.status).toBe(404);
    expect(pending.body.error.code).toBe(132001);
    expect(pending.body.error.error_data.details).toMatch(/order_update.*en_US/);
    expect(await latest('meta')).toMatchObject({ status: 'rejected' });
    // Wrong language of an existing template: also 132001.
    expect((await sendTpl('order_update', 'ar')).body.error.code).toBe(132001);

    // Approve over REST → message_template_status_update webhook (signed).
    const ok = await api('PATCH', `/api/projects/wa/providers/meta/templates/${id}`, { status: 'APPROVED' });
    expect(ok.status).toBe(200);
    expect(ok.body.template.status).toBe('APPROVED');
    expect(ok.body.webhooks[0]).toMatchObject({ ok: true, status: 200 });
    const approved = received.filter((r) => r.path === '/hook/meta').at(-1)!;
    const change = JSON.parse(approved.body).entry[0].changes[0];
    expect(change.field).toBe('message_template_status_update');
    expect(change.value).toMatchObject({ event: 'APPROVED', message_template_name: 'order_update', message_template_language: 'en_US', reason: 'NONE', message_template_category: 'UTILITY' });
    expect(String(change.value.message_template_id)).toBe(id);
    expect(approved.headers['x-hub-signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/);

    const sent = await sendTpl('order_update');
    expect(sent.status).toBe(200);
    expect(sent.body.messages[0]).toMatchObject({ message_status: 'accepted' });
    expect(await latest('meta')).toMatchObject({ status: 'delivered' });

    // Quality drops → quality webhook; paused → 132015.
    await api('PATCH', `/api/projects/wa/providers/meta/templates/${id}`, { quality: 'RED' });
    const q = JSON.parse(received.filter((r) => r.path === '/hook/meta').at(-1)!.body).entry[0].changes[0];
    expect(q).toMatchObject({ field: 'message_template_quality_update', value: { previous_quality_score: 'UNKNOWN', new_quality_score: 'RED', message_template_name: 'order_update' } });
    await api('PATCH', `/api/projects/wa/providers/meta/templates/${id}`, { status: 'PAUSED' });
    expect((await sendTpl('order_update')).body.error.code).toBe(132015);

    // Reject path.
    const promo = await api('POST', tplUrl, { name: 'spring_sale', language: 'en', category: 'MARKETING', components: [{ type: 'BODY', text: 'Sale!' }] });
    const rej = await api('PATCH', `/api/projects/wa/providers/meta/templates/${promo.body.id}`, { status: 'REJECTED', reason: 'PROMOTIONAL' });
    expect(rej.body.template).toMatchObject({ status: 'REJECTED', reason: 'PROMOTIONAL' });
    const rejected = JSON.parse(received.filter((r) => r.path === '/hook/meta').at(-1)!.body).entry[0].changes[0].value;
    expect(rejected).toMatchObject({ event: 'REJECTED', reason: 'PROMOTIONAL', message_template_name: 'spring_sale' });
    expect((await sendTpl('spring_sale', 'en')).body.error.code).toBe(132001);

    // Unknown templates are sent unless enforceTemplates is on.
    expect((await sendTpl('never_created')).status).toBe(200);
    await api('PATCH', '/api/projects/wa/providers/meta', { config: { statusCallbackUrl: `${appUrl}/hook/meta`, enforceTemplates: 'true', templateReview: 'approve', templateRejectPattern: '^promo_' } });
    expect((await sendTpl('never_created')).body.error.code).toBe(132001);

    // Automatic review: approve by default, reject names matching the pattern.
    const auto = await api('POST', tplUrl, { name: 'welcome', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi' }] });
    expect(auto.body.status).toBe('PENDING');
    await waitFor(() => hooks('/hook/meta').find((h) => h.entry[0].changes[0].value.message_template_name === 'welcome'));
    expect((await sendTpl('welcome', 'en')).status).toBe(200);
    await api('POST', tplUrl, { name: 'promo_x', language: 'en', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] });
    const auto2 = await waitFor(() => hooks('/hook/meta').find((h) => h.entry[0].changes[0].value.message_template_name === 'promo_x'));
    expect(auto2.entry[0].changes[0].value).toMatchObject({ event: 'REJECTED', reason: 'INVALID_FORMAT' });

    // Delete by name.
    expect((await api('DELETE', `${tplUrl}?name=spring_sale`)).body).toEqual({ success: true });
    expect((await api('GET', '/api/projects/wa/providers/meta/templates')).body.map((t: any) => t.name)).not.toContain('spring_sale');
  });

  it('360dialog: D360-API-KEY, Cloud API send + webhooks, replies to the single webhook, templates', async () => {
    expect((await addProvider('360dialog', 'd360', { apiKey: 'K360' })).status).toBe(201);
    const H = { 'D360-API-KEY': 'K360' };
    const text = { messaging_product: 'whatsapp', to: digits('d360'), type: 'text', text: { body: 'Hello from 360' } };
    expect((await api('POST', '/mock/wa/d360/messages', text)).status).toBe(401);
    expect((await api('POST', '/mock/wa/d360/messages', text, { 'D360-API-KEY': 'wrong' })).body.meta.http_code).toBe(401);
    const r = await api('POST', '/mock/wa/d360/messages', text, H);
    expect(r.status).toBe(200);
    expect(r.body.messages[0].id).toMatch(/^wamid\./);
    const st = await waitFor(() => hooks('/hook/d360').find((h) => h.entry[0].changes[0].value.statuses?.[0]?.status === 'delivered'));
    expect(st.object).toBe('whatsapp_business_account');

    // Replies go to the same webhook when no inbound URL is set.
    const rep = await api('POST', `/api/projects/wa/users/${users.d360.id}/reply`, { channel: 'whatsapp', text: 'thanks', instance: 'd360' });
    expect(rep.status).toBe(201);
    const inbound = hooks('/hook/d360').find((h) => h.entry[0].changes[0].value.messages);
    expect(inbound.entry[0].changes[0].value.messages[0]).toMatchObject({ type: 'text', text: { body: 'thanks' } });

    // Templates on /v1/configs/templates.
    const c = await api('POST', '/mock/wa/d360/v1/configs/templates', { name: 'otp_code', language: 'en', category: 'AUTHENTICATION', components: [{ type: 'BODY', text: '{{1}} is your code' }] }, H);
    expect(c.body).toMatchObject({ status: 'PENDING', category: 'AUTHENTICATION' });
    const list = await api('GET', '/mock/wa/d360/v1/configs/templates', undefined, H);
    expect(list.body.waba_templates).toEqual([expect.objectContaining({ name: 'otp_code', status: 'pending' })]);
    const tpl = { messaging_product: 'whatsapp', to: digits('d360'), type: 'template', template: { name: 'otp_code', language: { code: 'en' } } };
    expect((await api('POST', '/mock/wa/d360/messages', tpl, H)).body.error.code).toBe(132001);
    await api('PATCH', `/api/projects/wa/providers/d360/templates/${c.body.id}`, { status: 'APPROVED' });
    expect(hooks('/hook/d360').at(-1).entry[0].changes[0]).toMatchObject({ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: 'otp_code' } });
    expect((await api('POST', '/mock/wa/d360/messages', tpl, H)).status).toBe(200);
    expect((await api('DELETE', '/mock/wa/d360/v1/configs/templates/otp_code', undefined, H)).body).toEqual({ success: true });
  });

  it('Infobip WhatsApp: App key auth, text / template / buttons, DLRs, seen reports, window, inbound, templates', async () => {
    expect((await addProvider('infobip-whatsapp', 'ib', { apiKey: 'IBKEY', fromNumber: '441134960000', inboundUrl: `${appUrl}/in/ib`, readReceipts: 'true' })).status).toBe(201);
    const H = { Authorization: 'App IBKEY' };
    const text = { from: '441134960000', to: digits('ib'), content: { text: 'Hi from Infobip' }, callbackData: 'order-9' };
    const unauth = await api('POST', '/mock/wa/ib/whatsapp/1/message/text', text);
    expect(unauth.status).toBe(401);
    expect(unauth.body.requestError.serviceException.messageId).toBe('UNAUTHORIZED');
    expect((await api('POST', '/mock/wa/ib/whatsapp/1/message/text', text, { Authorization: 'App nope' })).status).toBe(401);
    const bad = await api('POST', '/mock/wa/ib/whatsapp/1/message/text', { from: '441134960000', to: digits('ib'), content: {} }, H);
    expect(bad.status).toBe(400);
    expect(bad.body.requestError.serviceException.validationErrors['content.text']).toBeTruthy();

    const r = await api('POST', '/mock/wa/ib/whatsapp/1/message/text', text, H);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ to: digits('ib'), messageCount: 1, status: { groupName: 'PENDING', name: 'PENDING_ENROUTE' } });
    const dlr = await waitFor(() => hooks('/hook/ib').find((h) => h.results?.[0]?.status?.groupName === 'DELIVERED'));
    expect(dlr.results[0]).toMatchObject({ messageId: r.body.messageId, callbackData: 'order-9', error: { groupName: 'OK' } });
    const seen = await waitFor(() => hooks('/hook/ib').find((h) => h.results?.[0]?.seenAt));
    expect(seen.results[0].messageId).toBe(r.body.messageId);

    // Interactive buttons, then the user taps one → INTERACTIVE_BUTTON_REPLY.
    await api('POST', '/mock/wa/ib/whatsapp/1/message/interactive/buttons', { from: '441134960000', to: digits('ib'), content: { body: { text: 'Confirm?' }, action: { buttons: [{ type: 'REPLY', id: 'yes', title: 'Yes' }, { type: 'REPLY', id: 'no', title: 'No' }] } } }, H);
    const tap = await api('POST', `/api/projects/wa/users/${users.ib.id}/reply`, { channel: 'whatsapp', text: '', button: 'Yes', instance: 'ib' });
    expect(tap.status).toBe(201);
    const inbound = hooks('/in/ib').at(-1);
    expect(inbound).toMatchObject({ messageCount: 1, results: [{ integrationType: 'WHATSAPP', from: digits('ib'), to: '441134960000', message: { type: 'INTERACTIVE_BUTTON_REPLY', id: 'yes', title: 'Yes' } }] });

    // Templates: create (PENDING), sending it fails in the delivery report, approve, send works.
    const c = await api('POST', '/mock/wa/ib/whatsapp/2/senders/441134960000/templates', { name: 'ship_notice', language: 'en', category: 'UTILITY', structure: { body: { text: 'Shipped {{1}}' }, type: 'TEXT' } }, H);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'ship_notice', status: 'PENDING' });
    expect((await api('GET', '/mock/wa/ib/whatsapp/2/senders/441134960000/templates', undefined, H)).body.templates).toHaveLength(1);
    const tplBody = { messages: [{ from: '441134960000', to: digits('ib'), content: { templateName: 'ship_notice', templateData: { body: { placeholders: ['A-1'] } }, language: 'en' } }] };
    const t1 = await api('POST', '/mock/wa/ib/whatsapp/1/message/template', tplBody, H);
    expect(t1.status).toBe(200);
    expect(t1.body.bulkId).toBeTruthy();
    const failed = await waitFor(() => hooks('/hook/ib').find((h) => h.results?.[0]?.messageId === t1.body.messages[0].messageId && h.results[0].status.groupName === 'UNDELIVERABLE'));
    expect(failed.results[0].error).toMatchObject({ id: 132001 });
    await api('PATCH', `/api/projects/wa/providers/ib/templates/${c.body.id}`, { status: 'APPROVED' });
    await api('POST', '/mock/wa/ib/whatsapp/1/message/template', tplBody, H);
    expect(await latest('ib')).toMatchObject({ status: 'delivered' });
    expect((await api('DELETE', '/mock/wa/ib/whatsapp/2/senders/441134960000/templates/ship_notice', undefined, H)).status).toBe(204);

    // 24-hour window: a fresh user who never wrote gets a failed delivery report.
    await api('PATCH', '/api/projects/wa/providers/ib', { config: { apiKey: 'IBKEY', fromNumber: '441134960000', statusCallbackUrl: `${appUrl}/hook/ib`, enforce24hWindow: 'true' } });
    const w = await api('POST', '/mock/wa/ib/whatsapp/1/message/text', { from: '441134960000', to: digits('uni'), content: { text: 'free-form' } }, H);
    expect(w.status).toBe(200);
    const wf = await waitFor(() => hooks('/hook/ib').find((h) => h.results?.[0]?.messageId === w.body.messageId && h.results[0].status.groupName === 'UNDELIVERABLE'));
    expect(wf.results[0].error.id).toBe(131047);
  });

  it('Gupshup: apikey, form-encoded send, message events, inbound on the callback URL, templates by id', async () => {
    expect((await addProvider('gupshup', 'gs', { apiKey: 'GSKEY', appName: 'DemoApp', fromNumber: '917834811114' })).status).toBe(201);
    const H = { apikey: 'GSKEY' };
    const send = (fields: Record<string, string>, h: Record<string, string> = H) => api('POST', '/mock/wa/gs/wa/api/v1/msg', form({ channel: 'whatsapp', source: '917834811114', destination: digits('gs'), 'src.name': 'DemoApp', ...fields }), h);
    const unauth = await send({ message: 'hi' }, {});
    expect(unauth.status).toBe(401);
    expect(unauth.body).toMatchObject({ status: 'error', message: 'Authentication Failed' });
    expect((await send({})).body).toMatchObject({ status: 'error' });

    const r = await send({ message: JSON.stringify({ type: 'text', text: 'Hello from Gupshup' }) });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('submitted');
    const ev = await waitFor(() => hooks('/hook/gs').find((h) => h.type === 'message-event' && h.payload.type === 'delivered'));
    expect(ev).toMatchObject({ app: 'DemoApp', version: 2, payload: { id: r.body.messageId, destination: digits('gs') } });
    // Plain-text message field and the older /sm/ path work too.
    expect((await api('POST', '/mock/wa/gs/sm/api/v1/msg', form({ channel: 'whatsapp', source: '917834811114', destination: digits('gs'), message: 'plain' }), H)).status).toBe(202);

    // Inbound goes to the callback URL (one URL per Gupshup app).
    await api('POST', `/api/projects/wa/users/${users.gs.id}/reply`, { channel: 'whatsapp', text: 'hey', instance: 'gs' });
    const inbound = hooks('/hook/gs').find((h) => h.type === 'message');
    expect(inbound.payload).toMatchObject({ type: 'text', payload: { text: 'hey' }, sender: { phone: digits('gs'), name: 'gs' } });

    // Templates: create on the partner API, send by id → failed event, approve → template-event, send works.
    const c = await api('POST', '/mock/wa/gs/partner/app/app-1/templates', form({ elementName: 'order_ready', languageCode: 'en', category: 'UTILITY', templateType: 'TEXT', content: 'Order {{1}} is ready', example: 'Order 7 is ready' }), H);
    expect(c.body).toMatchObject({ status: 'success', template: { elementName: 'order_ready', status: 'PENDING' } });
    const tid = c.body.template.id;
    const tsend = () => api('POST', '/mock/wa/gs/wa/api/v1/template/msg', form({ source: '917834811114', destination: digits('gs'), 'src.name': 'DemoApp', template: JSON.stringify({ id: tid, params: ['7'] }) }), H);
    const t1 = await tsend();
    expect(t1.status).toBe(202);
    const failed = await waitFor(() => hooks('/hook/gs').find((h) => h.type === 'message-event' && h.payload.id === t1.body.messageId && h.payload.type === 'failed'));
    expect(failed.payload.payload.code).toBe(132001);
    await api('PATCH', `/api/projects/wa/providers/gs/templates/${tid}`, { status: 'APPROVED' });
    expect(hooks('/hook/gs').find((h) => h.type === 'template-event')).toMatchObject({ payload: { id: tid, elementName: 'order_ready', status: 'approved' } });
    await tsend();
    expect(await latest('gs')).toMatchObject({ status: 'delivered' });
    expect((await api('GET', '/mock/wa/gs/partner/app/app-1/templates', undefined, H)).body.templates[0]).toMatchObject({ id: tid, status: 'APPROVED' });
  });

  it('Unifonic WhatsApp: PublicId / Secret, send, status and inbound webhooks, rejected template', async () => {
    expect((await addProvider('unifonic-whatsapp', 'uni', { publicId: 'PUB', secret: 'SEC', inboundUrl: `${appUrl}/in/uni` })).status).toBe(201);
    const H = { PublicId: 'PUB', Secret: 'SEC' };
    const text = { recipient: { contact: users.uni.phone, channel: 'whatsapp' }, content: { type: 'text', text: 'مرحبا' } };
    expect((await api('POST', '/mock/wa/uni/v1/messages', text)).status).toBe(401);
    expect((await api('POST', '/mock/wa/uni/v1/messages', text, { PublicId: 'PUB', Secret: 'x' })).status).toBe(401);
    const r = await api('POST', '/mock/wa/uni/v1/messages', text, H);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'queued' });
    const st = await waitFor(() => hooks('/hook/uni').find((h) => h.status === 'delivered'));
    expect(st).toMatchObject({ messageId: r.body.messageId, channel: 'whatsapp' });
    await api('POST', `/api/projects/wa/users/${users.uni.id}/reply`, { channel: 'whatsapp', text: 'ok', instance: 'uni' });
    expect(hooks('/in/uni').at(-1)).toMatchObject({ event: 'message.inbound', content: { type: 'text', text: 'ok' }, sender: { contact: users.uni.phone } });

    // A template created (dashboard / REST) and rejected: the send is accepted, then fails.
    const c = await api('POST', '/api/projects/wa/providers/uni/templates', { name: 'promo_eid', language: 'ar', category: 'MARKETING', body: 'Eid offer' });
    expect(c.status).toBe(201);
    await api('PATCH', `/api/projects/wa/providers/uni/templates/${c.body.id}`, { status: 'REJECTED' });
    const t = await api('POST', '/mock/wa/uni/v1/messages', { recipient: { contact: users.uni.phone, channel: 'whatsapp' }, content: { type: 'template', name: 'promo_eid', language: { code: 'ar' } } }, H);
    expect(t.status).toBe(202);
    const f = await waitFor(() => hooks('/hook/uni').find((h) => h.messageId === t.body.messageId && h.status === 'failed'));
    expect(f.error.code).toBe('132001');
  });

  it('MCP tools: create_wa_template, list_wa_templates, set_wa_template_status (by name, sends the webhook)', async () => {
    expect((await addProvider('meta-whatsapp', 'mcpwa', { phoneNumberId: '555000222', wabaId: '777' })).status).toBe(201);
    let rpc = 0;
    const mcp = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } });
      expect(r.status).toBe(200);
      expect(r.body.result.isError, `${name}: ${r.body.result.content[0].text}`).toBeFalsy();
      return JSON.parse(r.body.result.content[0].text);
    };
    const c = await mcp('create_wa_template', { project: 'wa', instance: 'mcpwa', name: 'mcp_hello', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] });
    expect(c).toMatchObject({ name: 'mcp_hello', language: 'en_US', status: 'PENDING' });
    expect((await mcp('list_wa_templates', { project: 'wa', instance: 'mcpwa' })).templates).toEqual([expect.objectContaining({ id: c.id, name: 'mcp_hello' })]);
    const before = hooks('/hook/mcpwa').length;
    const s = await mcp('set_wa_template_status', { project: 'wa', instance: 'mcpwa', id_or_name: 'mcp_hello', status: 'APPROVED' });
    expect(s.template).toMatchObject({ id: c.id, status: 'APPROVED' });
    expect(s.webhooks[0]).toMatchObject({ ok: true });
    const h = await waitFor(() => hooks('/hook/mcpwa').slice(before).find((x) => x.entry?.[0]?.changes?.[0]?.field === 'message_template_status_update'));
    expect(h.entry[0].changes[0].value).toMatchObject({ event: 'APPROVED', message_template_name: 'mcp_hello' });
    // By id too.
    expect((await mcp('set_wa_template_status', { project: 'wa', instance: 'mcpwa', id_or_name: c.id, status: 'PAUSED' })).template.status).toBe('PAUSED');
  });

  it('export → import into a new project keeps the WhatsApp templates on the remapped instance', async () => {
    const exp = await api('GET', '/api/projects/wa/export');
    expect(exp.status).toBe(200);
    expect(exp.body.waTemplates.length).toBeGreaterThan(0);
    const imp = await api('POST', '/api/projects/import', { json: exp.body, slug: 'wa-copy', mode: 'create' });
    expect(imp.status).toBe(201);
    expect(imp.body.imported.waTemplates).toBe(exp.body.waTemplates.length);
    const orig = (await api('GET', '/api/projects/wa/providers/mcpwa/templates')).body;
    const copy = (await api('GET', '/api/projects/wa-copy/providers/mcpwa/templates')).body;
    const strip = (t: any) => [t.name, t.language, t.category, t.status, t.quality, t.components];
    expect(copy.map(strip)).toEqual(orig.map(strip));
    expect(copy[0].id).not.toBe(orig[0].id);
    expect(copy[0].providerInstanceId).not.toBe(orig[0].providerInstanceId);
    // Deleting the copy (FK cascade) leaves the original's templates.
    expect((await api('DELETE', '/api/projects/wa-copy')).status).toBeLessThan(300);
    expect((await api('GET', '/api/projects/wa/providers/mcpwa/templates')).body).toHaveLength(orig.length);
  });
});
