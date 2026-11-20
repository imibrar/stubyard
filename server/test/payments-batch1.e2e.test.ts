import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { jwtVerify } from 'jose';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { ExpiringStore } from '../src/payments/common.js';

// Round 4, gateways batch 1: Moyasar, Tap, Tabby, Tamara, Checkout.com.

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
type Hit = { path: string; body: string; headers: http.IncomingHttpHeaders; method: string };
const received: Hit[] = [];

async function call<T = any>(method: string, p: string, opts: { json?: unknown; form?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = opts.form;
  }
  const r = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}
const api = <T = any>(method: string, p: string, json?: unknown) => call<T>(method, p, json === undefined ? {} : { json });
async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}
const mcp = async (name: string, args: Record<string, unknown>) => {
  const r = await api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (r.body.result.isError) throw new Error(r.body.result.content[0].text);
  return JSON.parse(r.body.result.content[0].text);
};
const form = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const hitsAt = (p: string) => received.filter((r) => r.path === p);
/** The inbound traffic row of the latest request to a URL path, once its response was logged. */
const trafficRow = (urlPath: string) =>
  waitFor(() => hub.db.prepare("SELECT res_status, outcome, resolved FROM traffic_logs WHERE direction = 'inbound' AND url LIKE ? AND outcome != 'pending' ORDER BY received_at DESC, rowid DESC LIMIT 1").get(`%${urlPath}`) as { res_status: number; outcome: string; resolved: string } | undefined);

/** A Luhn-valid number that is not a published test card (generated here, not a real card). */
function fakeRealPan(): string {
  const body = '49162039178825';
  for (let d = 0; d <= 9; d++) {
    const n = body + d;
    let sum = 0;
    for (let i = 0; i < n.length; i++) {
      let x = Number(n[n.length - 1 - i]);
      if (i % 2 === 1) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
    }
    if (sum % 10 === 0) return n;
  }
  throw new Error('unreachable');
}

const PJ = '/api/projects/shop4';
const cfgs: Record<string, any> = {};
const payOf = async (ref: string) => (await api('GET', PJ + '/payments/' + encodeURIComponent(ref))).body;
/** Page complete; text is the redirect Location (303) followed by the body. */
const pageDone = async (inst: string, id: string, fields: Record<string, string | number>) => {
  const r = await call('POST', '/pay/shop4/' + inst + '/page/' + id + '/complete', { form: form(fields) });
  return { ...r, text: (r.headers.get('location') ?? '') + '\n' + r.text };
};
const cardFields = (magic = 'success', brand = 'visa', last4 = '4242') => ({ outcome: magic === 'success' ? 'success' : 'decline', method: 'card', card_brand: brand, card_last4: last4, card_magic: magic, card_luhn: '1', card_test: '1' });
const lintChecks = async () => ((await api('GET', PJ + '/payments/lint')).body.findings as any[]).map((f) => f.check);
const hookAt = (p: string, pred: (h: Hit) => boolean = () => true) => waitFor(() => hitsAt(p).find(pred) ?? null);
/** Pretend a payment was untouched for a minute (late lints). */
const age = (id: string) => hub.db.prepare('UPDATE payments SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), id);

describe('payments batch 1 (round 4)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-pay4b-'));
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
    base = 'http://127.0.0.1:' + httpPort;
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body, headers: req.headers, method: req.method ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = 'http://127.0.0.1:' + (appServer.address() as net.AddressInfo).port;
    expect((await api('POST', '/api/projects', { name: 'Shop 4', slug: 'shop4' })).status).toBe(201);
    for (const preset of ['moyasar', 'tap', 'tabby', 'tamara', 'checkout']) {
      const r = await api('POST', PJ + '/payment-instances', { preset, config: { webhookUrl: appUrl + '/wh/' + preset, webhookDelayMs: 0 } });
      expect(r.status, r.text).toBe(201);
      expect(r.body.slug).toBe(preset);
      cfgs[preset] = (await api('GET', PJ + '/payment-instances/' + preset + '?secrets=1')).body.config;
    }
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the five presets with logos and slug bases', async () => {
    const presets = (await api('GET', '/api/payment-presets')).body.presets as any[];
    for (const id of ['moyasar', 'tap', 'tabby', 'tamara', 'checkout']) {
      const p = presets.find((x) => x.id === id);
      expect(p?.available, id).toBe(true);
      expect(p.logo).toMatch(/^[A-Z]{2}$/);
      expect(p.slugBase).toBe(id);
    }
  });

  // ---------------------------------------------------------------- Moyasar
  describe('Moyasar', () => {
    const M = '/pay/shop4/moyasar';
    const basic = (user?: string) => ({ authorization: 'Basic ' + Buffer.from((user ?? cfgs.moyasar.secretKey) + ':').toString('base64') });
    const mpost = (p: string, json: unknown, user?: string) => call('POST', M + p, { json, headers: basic(user) });
    const mget = (p: string) => call('GET', M + p, { headers: basic() });

    it('invoice: hosted page, success_url redirect, webhook with secret_token, invoice callback, fetch', async () => {
      const inv = await mpost('/v1/invoices', { amount: 5000, currency: 'SAR', description: 'Order 1', callback_url: appUrl + '/moy-cb', success_url: appUrl + '/moy-ok', back_url: appUrl + '/moy-back', metadata: { order_id: 'o-1' } });
      expect(inv.status, inv.text).toBe(201);
      expect(inv.body.status).toBe('initiated');
      expect(inv.body.url).toContain('/checkout/' + inv.body.id);
      const entry = await call('GET', M + '/checkout/' + inv.body.id);
      expect(entry.status).toBe(302);
      const p = await payOf(inv.body.id);
      const done = await pageDone('moyasar', p.id, cardFields('success', 'mada', '1010'));
      expect(done.text).toContain(appUrl + '/moy-ok');
      const wh = await hookAt('/wh/moyasar', (h) => JSON.parse(h.body).type === 'payment_paid');
      const evt = JSON.parse(wh.body);
      expect(evt.secret_token).toBe(cfgs.moyasar.webhookSecret);
      expect(evt.live).toBe(false);
      expect(evt.data.amount).toBe(5000);
      const cb = await hookAt('/moy-cb');
      expect(JSON.parse(cb.body).status).toBe('paid');
      const got = await mget('/v1/invoices/' + inv.body.id);
      expect(got.body.status).toBe('paid');
      expect(got.body.payments[0].status).toBe('paid');
    });

    it('payments API: decline card code, manual capture, partial + full refund, void', async () => {
      const src = (number: string, extra: Record<string, unknown> = {}) => ({ type: 'creditcard', name: 'Test Buyer', number, month: 12, year: 2030, cvc: '123', '3ds': false, ...extra });
      const dec = await mpost('/v1/payments', { amount: 1000, currency: 'SAR', callback_url: appUrl + '/r', source: src('4123120001090109'), metadata: { order_id: 'd' } }, cfgs.moyasar.publishableKey);
      expect(dec.status, dec.text).toBe(201);
      expect(dec.body.status).toBe('failed');
      expect(dec.body.source.response_code ?? dec.body.source.message).toBeTruthy();
      const man = await mpost('/v1/payments', { amount: 2000, currency: 'SAR', callback_url: appUrl + '/r', source: src('5421080101000000', { manual: true }), metadata: { order_id: 'm' } });
      expect(man.body.status).toBe('authorized');
      const cap = await mpost('/v1/payments/' + man.body.id + '/capture', {});
      expect(cap.status, cap.text).toBe(200);
      expect(cap.body.status).toBe('captured');
      const r1 = await mpost('/v1/payments/' + man.body.id + '/refund', { amount: 500 });
      expect(r1.status, r1.text).toBe(200);
      expect(r1.body.refunded).toBe(500);
      const r2 = await mpost('/v1/payments/' + man.body.id + '/refund', {});
      expect(r2.body.status).toBe('refunded');
      expect(r2.body.refunded).toBe(2000);
      const v = await mpost('/v1/payments', { amount: 2000, currency: 'SAR', callback_url: appUrl + '/r', source: src('5421080101000000', { manual: true }), metadata: { order_id: 'v' } });
      const vo = await mpost('/v1/payments/' + v.body.id + '/void', {});
      expect(vo.body.status).toBe('voided');
      expect(await lintChecks()).toContain('pay.moyasar-card-on-server');
    });

    it('3-D Secure via transaction_url, then fetched (no late lint)', async () => {
      const r = await mpost('/v1/payments', { amount: 1500, currency: 'SAR', callback_url: appUrl + '/moy-3ds', source: { type: 'creditcard', name: 'Test Buyer', number: '4201320111111010', month: 12, year: 2030, cvc: '123' }, metadata: { order_id: '3' } }, cfgs.moyasar.publishableKey);
      expect(r.body.status).toBe('initiated');
      expect(r.body.source.transaction_url).toContain('/checkout/' + r.body.id);
      const p = await payOf(r.body.id);
      const done = await pageDone('moyasar', p.id, cardFields('success', 'mada', '1010'));
      expect(done.text).toContain('/moy-3ds?id=' + r.body.id);
      age(p.id);
      expect(await lintChecks()).toContain('pay.moyasar-payment-not-fetched');
      expect((await mget('/v1/payments/' + r.body.id)).body.status).toBe('paid');
    });

    it('errors: bad credentials, publishable key on a read, real card, amount unit', async () => {
      const bad = await call('GET', M + '/v1/payments', { headers: { authorization: 'Basic ' + Buffer.from('nope:').toString('base64') } });
      expect(bad.status).toBe(401);
      expect(bad.body.type).toBe('authentication_error');
      const pk = await call('GET', M + '/v1/payments', { headers: basic(cfgs.moyasar.publishableKey) });
      expect(pk.status).toBe(403);
      const real = await mpost('/v1/payments', { amount: 1000, currency: 'SAR', callback_url: appUrl + '/r', source: { type: 'creditcard', name: 'Test Buyer', number: fakeRealPan(), month: 12, year: 2030, cvc: '123' } }, cfgs.moyasar.publishableKey);
      expect(real.status).toBe(400);
      expect(real.body.type).toBe('invalid_request_error');
      await mpost('/v1/invoices', { amount: 50, currency: 'SAR', description: 'tiny' });
      const checks = await lintChecks();
      expect(checks).toContain('pay.real-card-entered');
    });
  });

  // ---------------------------------------------------------------- Tap
  describe('Tap', () => {
    const T = '/pay/shop4/tap';
    const auth = (k?: string) => ({ authorization: 'Bearer ' + (k ?? cfgs.tap.secretKey) });
    const tpost = (p: string, json: unknown, k?: string) => call('POST', T + p, { json, headers: auth(k) });
    const charge = (extra: Record<string, unknown> = {}) => ({ amount: 10.5, currency: 'KWD', customer: { first_name: 'Test', email: 'buyer@example.test' }, source: { id: 'src_all' }, redirect: { url: appUrl + '/tap-back' }, post: { url: appUrl + '/tap-post' }, reference: { order: 'ord-1' }, ...extra });
    const tapHash = (o: any) => {
      const created = o.object === 'refund' ? o.created : o.transaction.created;
      const s = 'x_id' + o.id + 'x_amount' + Number(o.amount).toFixed(3) + 'x_currency' + o.currency + 'x_gateway_reference' + (o.reference?.gateway ?? '') + 'x_payment_reference' + (o.reference?.payment ?? '') + 'x_status' + o.status + 'x_created' + created;
      return createHmac('sha256', cfgs.tap.secretKey).update(s).digest('hex');
    };

    it('charge: transaction.url, KNET on the page, tap_id redirect, hashstring webhook, retrieve', async () => {
      const c = await tpost('/v2/charges', charge());
      expect(c.status, c.text).toBe(200);
      expect(c.body.status).toBe('INITIATED');
      expect(c.body.id).toMatch(/^chg_/);
      expect(c.body.transaction.url).toContain('/gosell/' + c.body.id);
      expect((await call('GET', T + '/gosell/' + c.body.id)).status).toBe(302);
      const p = await payOf(c.body.id);
      const done = await pageDone('tap', p.id, { outcome: 'success', method: 'knet' });
      expect(done.text).toContain('/tap-back?tap_id=' + c.body.id);
      const wh = await hookAt('/tap-post');
      const obj = JSON.parse(wh.body);
      expect(obj.status).toBe('CAPTURED');
      expect(obj.response.code).toBe('000');
      expect(wh.headers.hashstring).toBe(tapHash(obj));
      const got = await call('GET', T + '/v2/charges/' + c.body.id, { headers: auth() });
      expect(got.body.status).toBe('CAPTURED');
      expect(got.body.source.payment_method).toBe('KNET');
      // partial + full refund, refund webhook signed too
      const r1 = await tpost('/v2/refunds', { charge_id: c.body.id, amount: 0.5, currency: 'KWD', reason: 'requested_by_customer', post: { url: appUrl + '/tap-refund' } });
      expect(r1.status, r1.text).toBe(200);
      expect(r1.body.status).toBe('REFUNDED');
      expect(r1.body.id).toMatch(/^re_/);
      const rw = await hookAt('/tap-refund');
      expect(rw.headers.hashstring).toBe(tapHash(JSON.parse(rw.body)));
      const r2 = await tpost('/v2/refunds', { charge_id: c.body.id, amount: 10, currency: 'KWD', reason: 'rest' });
      expect(r2.status, r2.text).toBe(200);
      expect((await payOf(c.body.id)).status).toBe('refunded');
      const over = await tpost('/v2/refunds', { charge_id: c.body.id, amount: 1, currency: 'KWD', reason: 'x' });
      expect(over.status).toBe(400);
    });

    it('tokens: expiry 05/22 declines with 501; authorize + capture; void', async () => {
      const tok = async (number: string, exp_month: number, exp_year: number) => (await call('POST', T + '/v2/tokens', { json: { card: { number, exp_month, exp_year, cvc: '100', name: 'Test' } }, headers: auth(cfgs.tap.publishableKey) })).body.id as string;
      const t1 = await tok('4012000033330026', 5, 22);
      expect(t1).toMatch(/^tok_/);
      const d = await tpost('/v2/charges', charge({ source: { id: t1 }, threeDSecure: false }));
      expect(d.body.status).toBe('DECLINED');
      expect(d.body.response.code).toBe('501');
      const a = await tpost('/v2/authorize', charge({ source: { id: await tok('4012000033330026', 1, 39) }, threeDSecure: false, auto: { type: 'VOID', time: 100 } }));
      expect(a.status, a.text).toBe(200);
      expect(a.body.id).toMatch(/^auth_/);
      expect(a.body.status).toBe('AUTHORIZED');
      const over = await tpost('/v2/charges', charge({ amount: 99, source: { id: a.body.id } }));
      expect(over.body.errors[0].code).toBe('1150');
      const cap = await tpost('/v2/charges', charge({ source: { id: a.body.id } }));
      expect(cap.status, cap.text).toBe(200);
      expect(cap.body.status).toBe('CAPTURED');
      expect(cap.body.id).toMatch(/^chg_/);
      expect((await call('GET', T + '/v2/charges/' + cap.body.id, { headers: auth() })).body.status).toBe('CAPTURED');
      const a2 = await tpost('/v2/authorize', charge({ source: { id: await tok('4012000033330026', 1, 39) }, threeDSecure: false }));
      const v = await tpost('/v2/authorize/' + a2.body.id + '/void', {});
      expect(v.body.status).toBe('VOID');
    });

    it('errors: missing redirect (1110 + lint), bad key (2104), live key', async () => {
      const r = await tpost('/v2/charges', charge({ redirect: undefined }));
      expect(r.status).toBe(400);
      expect(r.body.errors[0].code).toBe('1110');
      const bad = await tpost('/v2/charges', charge(), 'wrong');
      expect(bad.status).toBe(401);
      expect(bad.body.errors[0].code).toBe('2104');
      const live = await tpost('/v2/charges', charge(), 'sk_live_abcdefgh12345678');
      expect(live.status).toBe(401);
      const checks = await lintChecks();
      expect(checks).toContain('pay.tap-redirect-missing');
      expect(checks).toContain('pay.live-key');
    });
  });

  // ---------------------------------------------------------------- Tabby
  describe('Tabby', () => {
    const B = '/pay/shop4/tabby';
    const auth = (k?: string) => ({ authorization: 'Bearer ' + (k ?? cfgs.tabby.secretKey) });
    const bpost = (p: string, json: unknown, k?: string) => call('POST', B + p, { json, headers: auth(k) });
    const bget = (p: string) => call('GET', B + p, { headers: auth() });
    const session = (buyer: Record<string, string> = {}, amount: unknown = '400.00') =>
      bpost('/api/v2/checkout', {
        payment: { amount, currency: 'AED', buyer: { name: 'Test Buyer', email: 'otp.success@tabby.ai', phone: '+971500000001', ...buyer }, shipping_address: { city: 'Dubai', address: 'x', zip: '0' }, buyer_history: { registered_since: '2024-01-01T00:00:00Z', loyalty_level: 0 }, order: { reference_id: 'tb-' + Math.random().toString(36).slice(2, 7), items: [{ title: 'Shirt', quantity: 1, unit_price: '400.00', category: 'clothes' }] } },
        lang: 'en',
        merchant_code: cfgs.tabby.merchantCode,
        merchant_urls: { success: appUrl + '/tb-ok', cancel: appUrl + '/tb-cancel', failure: appUrl + '/tb-fail' },
      });
    const approve = async (paymentId: string, otp = '8888') => {
      const p = await payOf(paymentId);
      const first = await pageDone('tabby', p.id, { outcome: 'success', method: 'bnpl', phone: '+971500000001' });
      expect(first.text).toContain('stubyard-otp');
      return pageDone('tabby', p.id, { outcome: 'success', method: 'bnpl', phone: '+971500000001', otp });
    };

    it('session → page + OTP 8888 → AUTHORIZED (header-auth webhook) → captures → CLOSED → refunds', async () => {
      const s = await session();
      expect(s.status, s.text).toBe(200);
      expect(s.body.status).toBe('created');
      const web = s.body.configuration.available_products.installments[0].web_url as string;
      expect(web).toContain('/hpp/' + s.body.payment.id);
      expect((await call('GET', B + '/hpp/' + s.body.payment.id)).status).toBe(302);
      const done = await approve(s.body.payment.id);
      expect(done.text).toContain('/tb-ok?payment_id=' + s.body.payment.id);
      const wh = await hookAt('/wh/tabby', (h) => JSON.parse(h.body).status === 'authorized');
      expect(wh.headers['x-auth-key']).toBe(cfgs.tabby.webhookHeaderValue);
      const pid = s.body.payment.id;
      expect((await bget('/api/v2/payments/' + pid)).body.status).toBe('AUTHORIZED');
      const c1 = await bpost('/api/v2/payments/' + pid + '/captures', { amount: '100.00', reference_id: 'cap-1' });
      expect(c1.status, c1.text).toBe(200);
      expect(c1.body.status).toBe('AUTHORIZED');
      expect(c1.body.captures).toHaveLength(1);
      const c2 = await bpost('/api/v2/payments/' + pid + '/captures', { amount: '300.00', reference_id: 'cap-2' });
      expect(c2.body.status).toBe('CLOSED');
      const r1 = await bpost('/api/v2/payments/' + pid + '/refunds', { amount: '50.00', reference_id: 'ref-1', reason: 'size' });
      expect(r1.status, r1.text).toBe(200);
      expect(r1.body.refunds).toHaveLength(1);
      const again = await bpost('/api/v2/payments/' + pid + '/refunds', { amount: '50.00', reference_id: 'ref-1' });
      expect(again.body.refunds).toHaveLength(1);
      await bpost('/api/v2/payments/' + pid + '/refunds', { amount: '350.00', reference_id: 'ref-2' });
      expect((await payOf(pid)).status).toBe('refunded');
    });

    it('pre-scoring reject, rejected test buyer, close without capture, late not-captured lint', async () => {
      const rej = await session({ phone: '+971500000002' });
      expect(rej.body.status).toBe('rejected');
      expect(rej.body.configuration.products.installments.rejection_reason).toBe('not_available');
      const r2 = await session({ email: 'otp.rejected@tabby.ai' });
      const done = await approve(r2.body.payment.id);
      expect(done.text).toContain('/tb-fail?payment_id=');
      expect((await bget('/api/v2/payments/' + r2.body.payment.id)).body.status).toBe('REJECTED');
      const s = await session();
      await approve(s.body.payment.id);
      const p = await payOf(s.body.payment.id);
      age(p.id);
      expect(await lintChecks()).toContain('pay.tabby-not-captured');
      const cl = await bpost('/api/v2/payments/' + s.body.payment.id + '/close', {});
      expect(cl.status, cl.text).toBe(200);
      expect(cl.body.status).toBe('CLOSED');
      const refundClosed = await bpost('/api/v2/payments/' + s.body.payment.id + '/refunds', { amount: '1.00', reference_id: 'x' });
      expect(refundClosed.status).toBe(400);
    });

    it('errors and webhook registry', async () => {
      const bad = await bpost('/api/v2/checkout', {}, 'bad');
      expect(bad.status).toBe(401);
      expect(bad.body).toMatchObject({ status: 'error', errorType: 'not_authorized' });
      const num = await session({}, 400);
      expect(num.status).toBe(200);
      expect(await lintChecks()).toContain('pay.tabby-amount-format');
      const nf = await bget('/api/v2/payments/00000000-0000-0000-0000-000000000000');
      expect(nf.body.errorType).toBe('not_found');
      const h = await call('POST', B + '/api/v1/webhooks', { json: { url: appUrl + '/tb-hook', header: { title: 'X-Mine', value: 'abc' } }, headers: { ...auth(), 'x-merchant-code': 'stubyard' } });
      expect(h.status, h.text).toBe(200);
      expect(h.body.header.title).toBe('X-Mine');
      const s = await session();
      await approve(s.body.payment.id);
      const wh = await hookAt('/tb-hook');
      expect(wh.headers['x-mine']).toBe('abc');
      await call('DELETE', B + '/api/v1/webhooks/' + h.body.id, { headers: { ...auth(), 'x-merchant-code': 'stubyard' } });
    });
  });

  // ---------------------------------------------------------------- Tamara
  describe('Tamara', () => {
    const TM = '/pay/shop4/tamara';
    const auth = (k?: string) => ({ authorization: 'Bearer ' + (k ?? cfgs.tamara.apiToken) });
    const mpost = (p: string, json: unknown, k?: string) => call('POST', TM + p, { json, headers: auth(k) });
    const mget = (p: string) => call('GET', TM + p, { headers: auth() });
    const checkout = (phone = '566027755') =>
      mpost('/checkout', {
        order_reference_id: 'tm-' + Math.random().toString(36).slice(2, 7),
        total_amount: { amount: 300, currency: 'SAR' },
        description: 'x',
        country_code: 'SA',
        payment_type: 'PAY_BY_INSTALMENTS',
        instalments: 3,
        items: [{ name: 'Shoe', quantity: 1, reference_id: 'i1', type: 'Physical', sku: 's', total_amount: { amount: 300, currency: 'SAR' } }],
        consumer: { first_name: 'Test', last_name: 'Buyer', phone_number: phone, email: 'buyer@example.test' },
        shipping_address: { first_name: 'Test', last_name: 'Buyer', line1: 'x', city: 'Riyadh', country_code: 'SA' },
        merchant_url: { success: appUrl + '/tm-ok', failure: appUrl + '/tm-fail', cancel: appUrl + '/tm-cancel', notification: appUrl + '/tm-notify' },
      });
    const approve = async (orderId: string, phone = '566027755') => {
      const p = await payOf(orderId);
      await pageDone('tamara', p.id, { outcome: 'success', method: 'bnpl', phone });
      return pageDone('tamara', p.id, { outcome: 'success', method: 'bnpl', phone, otp: '123456' });
    };
    const ship = { shipping_company: 'DHL', tracking_number: '1' };

    it('checkout → approved (tamaraToken JWT verified with jose) → authorise → partial + full capture → refund', async () => {
      const c = await checkout();
      expect(c.status, c.text).toBe(200);
      expect(c.body.status).toBe('new');
      expect(c.body.checkout_url).toContain('/checkout/' + c.body.order_id);
      const done = await approve(c.body.order_id);
      expect(done.text).toContain('/tm-ok?orderId=' + c.body.order_id);
      const wh = await waitFor(() => received.find((h) => h.path.startsWith('/tm-notify?') && JSON.parse(h.body).event_type === 'order_approved'));
      const token = new URL(appUrl + wh.path).searchParams.get('tamaraToken')!;
      expect(wh.headers.authorization).toBe('Bearer ' + token);
      const v = await jwtVerify(token, new TextEncoder().encode(cfgs.tamara.notificationToken), { algorithms: ['HS256'], issuer: 'Tamara' });
      expect(v.payload.iss).toBe('Tamara');
      await expect(jwtVerify(token, new TextEncoder().encode('wrong-token'), { algorithms: ['HS256'] })).rejects.toThrow();
      const early = await mpost('/payments/capture', { order_id: c.body.order_id, total_amount: { amount: 100, currency: 'SAR' }, shipping_info: ship });
      expect(early.status).toBe(409);
      const a = await mpost('/orders/' + c.body.order_id + '/authorise', {});
      expect(a.status, a.text).toBe(200);
      expect(a.body.status).toBe('authorised');
      const c1 = await mpost('/payments/capture', { order_id: c.body.order_id, total_amount: { amount: 100, currency: 'SAR' }, shipping_info: ship });
      expect(c1.status, c1.text).toBe(200);
      expect(c1.body.status).toBe('partially_captured');
      const c2 = await mpost('/payments/capture', { order_id: c.body.order_id, total_amount: { amount: 200, currency: 'SAR' }, shipping_info: ship });
      expect(c2.body.status).toBe('fully_captured');
      const r1 = await mpost('/payments/simplified-refund/' + c.body.order_id, { total_amount: { amount: 50, currency: 'SAR' }, comment: 'size' });
      expect(r1.status, r1.text).toBe(200);
      expect(r1.body.status).toBe('partially_refunded');
      const r2 = await mpost('/payments/simplified-refund/' + c.body.order_id, { total_amount: { amount: 250, currency: 'SAR' }, comment: 'rest' });
      expect(r2.body.status).toBe('fully_refunded');
      const o = await mget('/orders/' + c.body.order_id);
      expect(o.body.transactions.captures).toHaveLength(2);
      expect(o.body.transactions.refunds).toHaveLength(2);
      expect(o.body.refunded_amount.amount).toBe(300);
    });

    it('declined phone, cancel an authorised order, late not-authorised lint, bad token', async () => {
      const d = await checkout('536422337');
      const done = await approve(d.body.order_id, '536422337');
      expect(done.text).toContain('/tm-fail?orderId=');
      expect((await mget('/orders/' + d.body.order_id)).body.status).toBe('declined');
      const c = await checkout();
      await approve(c.body.order_id);
      const p = await payOf(c.body.order_id);
      age(p.id);
      expect(await lintChecks()).toContain('pay.tamara-not-authorised');
      await mpost('/orders/' + c.body.order_id + '/authorise', {});
      const cn = await mpost('/orders/' + c.body.order_id + '/cancel', { total_amount: { amount: 300, currency: 'SAR' } });
      expect(cn.status, cn.text).toBe(200);
      expect(cn.body.status).toBe('canceled');
      const bad = await mget('/orders/' + c.body.order_id).then(() => call('GET', TM + '/orders/' + c.body.order_id, { headers: { authorization: 'Bearer short' } }));
      expect(bad.status).toBe(401);
      expect(bad.body.errors[0].error_code).toBe('unauthorized');
    });
  });

  // ---------------------------------------------------------------- Checkout.com
  describe('Checkout.com', () => {
    const C = '/pay/shop4/checkout';
    const auth = (k?: string) => ({ authorization: 'Bearer ' + (k ?? cfgs.checkout.secretKey) });
    const cpost = (p: string, json: unknown, headers: Record<string, string> = {}) => call('POST', C + p, { json, headers: { ...auth(), ...headers } });
    const cget = (p: string) => call('GET', C + p, { headers: auth() });
    const card = (number: string) => ({ type: 'card', number, expiry_month: 12, expiry_year: 2030, cvv: '100' });
    const sig = (body: string) => createHmac('sha256', cfgs.checkout.signatureKey).update(body).digest('hex');

    it('hosted payments: page, cko-payment-id redirect, Cko-Signature webhooks, refunds incl. declined amount', async () => {
      const h = await cpost('/hosted-payments', { amount: 10000, currency: 'SAR', reference: 'ck-1', billing: { address: { country: 'SA' } }, success_url: appUrl + '/ck-ok', failure_url: appUrl + '/ck-fail', cancel_url: appUrl + '/ck-cancel' });
      expect(h.status, h.text).toBe(201);
      expect(h.body.id).toMatch(/^hpp_/);
      expect(h.body._links.redirect.href).toContain('/hpp/' + h.body.id);
      const p = await payOf(h.body.id);
      const done = await pageDone('checkout', p.id, cardFields());
      expect(done.text).toContain('/ck-ok?cko-payment-id=pay_');
      const hp = await cget('/hosted-payments/' + h.body.id);
      expect(hp.body.status).toBe('Payment Received');
      const payId = /cko-payment-id=(pay_[a-z0-9]+)/.exec(done.text)![1]!;
      const got = await cget('/payments/' + payId);
      expect(got.body.status).toBe('Captured');
      expect(got.body.balances.available_to_refund).toBe(10000);
      const wh = await hookAt('/wh/checkout', (x) => JSON.parse(x.body).type === 'payment_captured');
      expect(wh.headers['cko-signature']).toBe(sig(wh.body));
      expect(wh.headers.authorization).toBe(cfgs.checkout.webhookAuthorization);
      expect(JSON.parse(wh.body).data.id).toBe(payId);
      const r1 = await cpost('/payments/' + payId + '/refunds', { amount: 2000, reference: 'r1' });
      expect(r1.status, r1.text).toBe(202);
      expect(r1.body.action_id).toMatch(/^act_/);
      await hookAt('/wh/checkout', (x) => JSON.parse(x.body).type === 'payment_refunded');
      const rd = await cpost('/payments/' + payId + '/refunds', { amount: 3738 });
      expect(rd.status).toBe(202);
      await hookAt('/wh/checkout', (x) => JSON.parse(x.body).type === 'payment_refund_declined');
      expect((await cget('/payments/' + payId)).body.status).toBe('Partially Refunded');
      await cpost('/payments/' + payId + '/refunds', {});
      expect((await cget('/payments/' + payId)).body.status).toBe('Refunded');
      const acts = (await cget('/payments/' + payId + '/actions')).body as any[];
      expect(acts.map((a) => a.type)).toEqual(expect.arrayContaining(['Authorization', 'Capture', 'Refund']));
    });

    it('card payments: auth + capture, void, decline 20005, 3DS 202 + sid_, idempotency replay', async () => {
      const a = await cpost('/payments', { source: card('4242424242424242'), amount: 5000, currency: 'SAR', reference: 'a', capture: false }, { 'cko-idempotency-key': 'idem-1' });
      expect(a.status, a.text).toBe(201);
      expect(a.body.status).toBe('Authorized');
      expect(a.body.response_code).toBe('10000');
      const replay = await cpost('/payments', { source: card('4242424242424242'), amount: 5000, currency: 'SAR', reference: 'a', capture: false }, { 'cko-idempotency-key': 'idem-1' });
      expect(replay.body.id).toBe(a.body.id);
      const cap = await cpost('/payments/' + a.body.id + '/captures', {});
      expect(cap.status, cap.text).toBe(202);
      expect((await cget('/payments/' + a.body.id)).body.status).toBe('Captured');
      const again = await cpost('/payments/' + a.body.id + '/captures', {});
      expect(again.status).toBe(403);
      const v = await cpost('/payments', { source: card('4242424242424242'), amount: 5000, currency: 'SAR', reference: 'v', capture: false });
      expect((await cpost('/payments/' + v.body.id + '/voids', {})).status).toBe(202);
      expect((await cget('/payments/' + v.body.id)).body.status).toBe('Voided');
      const d = await cpost('/payments', { source: card('4539467987109256'), amount: 5000, currency: 'SAR', reference: 'd' });
      expect(d.body.status).toBe('Declined');
      expect(d.body.response_code).toBe('20005');
      const f = await cpost('/payments', { source: card('4242424242424242'), amount: 101, currency: 'SAR', reference: 'f' });
      expect(f.body.response_code).toBe('20051');
      const s = await cpost('/payments', { source: card('4242424242424242'), amount: 5000, currency: 'SAR', reference: 's', '3ds': { enabled: true }, success_url: appUrl + '/ck3-ok', failure_url: appUrl + '/ck3-fail' });
      expect(s.status, s.text).toBe(202);
      expect(s.body.status).toBe('Pending');
      expect(s.body._links.redirect.href).toContain('/3ds/' + s.body.id);
      const p = await payOf(s.body.id);
      const done = await pageDone('checkout', p.id, { outcome: '3ds_success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' });
      const sid = /cko-session-id=(sid_[a-z0-9]+)/.exec(done.text)![1]!;
      const bySid = await cget('/payments/' + sid);
      expect(bySid.body.id).toBe(s.body.id);
      expect(bySid.body.status).toBe('Captured');
    });

    it('errors: 401 empty body, bare key lint, KWD amount_invalid, real card 422', async () => {
      const none = await call('POST', C + '/payments', { json: {} });
      expect(none.status).toBe(401);
      expect(none.text).toBe('');
      const bare = await call('POST', C + '/payments', { json: {}, headers: { authorization: cfgs.checkout.secretKey } });
      expect(bare.status).toBe(401);
      const kwd = await cpost('/payments', { source: card('4242424242424242'), amount: 1001, currency: 'KWD' });
      expect(kwd.status).toBe(422);
      expect(kwd.body).toMatchObject({ error_type: 'request_invalid', error_codes: ['amount_invalid'] });
      const real = await cpost('/payments', { source: card(fakeRealPan()), amount: 1000, currency: 'SAR' });
      expect(real.status).toBe(422);
      expect(real.body.error_codes).toEqual(['card_number_invalid']);
      const checks = await lintChecks();
      expect(checks).toContain('pay.checkout-key-without-bearer');
      expect(checks).toContain('pay.checkout-amount-invalid');
    });
  });

  // ---------------------------------------------------------------- shared
  describe('shared', () => {
    it('run isolation through /run/<key>', async () => {
      const run = (await api('POST', PJ + '/runs', { key: 'b1run' })).body;
      const r = await call('POST', '/run/' + run.key + '/pay/shop4/tap/v2/charges', { json: { amount: 1, currency: 'SAR', customer: { first_name: 'T', email: 't@example.test' }, source: { id: 'src_all' }, redirect: { url: appUrl + '/x' }, reference: { order: 'run-tap' } }, headers: { authorization: 'Bearer ' + cfgs.tap.secretKey } });
      expect(r.status, r.text).toBe(200);
      const inRun = (await api('GET', PJ + '/payments?run=' + run.key)).body as any[];
      expect(inRun.map((p) => p.reference)).toEqual(['run-tap']);
      await api('POST', PJ + '/runs/' + run.key + '/stop', {});
    });

    it('export hides secrets without ?secrets=1 and import keeps them with it', async () => {
      const plain = JSON.stringify((await api('GET', '/api/projects/shop4/export')).body);
      for (const preset of ['moyasar', 'tap', 'tabby', 'tamara', 'checkout']) expect(plain).toContain('"preset":"' + preset + '"');
      for (const [k, preset] of [['secretKey', 'moyasar'], ['webhookSecret', 'moyasar'], ['secretKey', 'tap'], ['secretKey', 'tabby'], ['webhookHeaderValue', 'tabby'], ['apiToken', 'tamara'], ['notificationToken', 'tamara'], ['secretKey', 'checkout'], ['signatureKey', 'checkout'], ['webhookAuthorization', 'checkout']] as const) {
        expect(plain, preset + '.' + k).not.toContain(String(cfgs[preset][k]));
      }
      const full = (await api('GET', '/api/projects/shop4/export?secrets=1')).body;
      const im = await api('POST', '/api/projects/import', { ...full, project: { ...full.project, name: 'Shop 4 copy', slug: 'shop4-copy' } });
      expect(im.status, im.text).toBeLessThan(300);
      const copy = (await api('GET', '/api/projects/shop4-copy/payment-instances/tamara?secrets=1')).body.config;
      expect(copy.notificationToken).toBe(cfgs.tamara.notificationToken);
    });

    it('registered webhook secrets are masked in views and travel only in the secrets export section', async () => {
      const moySecret = 'moy-hook-shared-secret-0001';
      const tabbyValue = 'tabby-hook-header-value-0002';
      const tamaraAuth = 'Bearer tamara-hook-auth-0003';
      const moyAuth = { authorization: 'Basic ' + Buffer.from(cfgs.moyasar.secretKey + ':').toString('base64') };
      const tmAuth = { authorization: 'Bearer ' + cfgs.tamara.apiToken };
      const mh = await call('POST', '/pay/shop4/moyasar/v1/webhooks', { json: { url: appUrl + '/moy-hook', shared_secret: moySecret }, headers: moyAuth });
      expect(mh.status, mh.text).toBe(201);
      const bh = await call('POST', '/pay/shop4/tabby/api/v1/webhooks', { json: { url: appUrl + '/tb-hook2', header: { title: 'X-Mine', value: tabbyValue } }, headers: { authorization: 'Bearer ' + cfgs.tabby.secretKey, 'x-merchant-code': 'stubyard' } });
      expect(bh.status, bh.text).toBe(200);
      const th = await call('POST', '/pay/shop4/tamara/webhooks', { json: { url: appUrl + '/tm-hook', events: ['order_approved'], headers: { Authorization: tamaraAuth } }, headers: tmAuth });
      expect(th.status, th.text).toBe(200);
      // Tamara headers: string → string only, header-safe names, single line, at most 10.
      for (const headers of [{ a: { x: 1 } }, { 'Bad Name': 'x' }, { 'X-A': 'x\r\nX-Evil: 1' }, ['x'], Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['X-' + i, 'v']))]) {
        const bad = await call('POST', '/pay/shop4/tamara/webhooks', { json: { url: appUrl + '/tm-hook', events: ['order_approved'], headers }, headers: tmAuth });
        expect(bad.status, JSON.stringify(headers)).toBe(400);
        expect(bad.text).toContain('invalid_headers');
      }
      const secrets = [moySecret, tabbyValue, tamaraAuth, 'tamara-hook-auth-0003'];
      const views = JSON.stringify((await api('GET', PJ + '/payment-instances')).body) + JSON.stringify((await api('GET', PJ + '/payment-instances/tamara')).body);
      for (const s of secrets) expect(views, s).not.toContain(s);
      const tmView = (await api('GET', PJ + '/payment-instances/tamara')).body.config.webhooks;
      expect(tmView[0].url).toBe(appUrl + '/tm-hook');
      expect(tmView[0].headers.Authorization).toMatch(/…/);
      expect(JSON.stringify((await api('GET', PJ + '/payment-instances?secrets=1')).body)).toContain(moySecret);
      // A masked registry sent back unchanged keeps the stored secrets.
      expect((await api('PATCH', PJ + '/payment-instances/tamara', { config: { webhooks: tmView } })).status).toBe(200);
      expect((await api('GET', PJ + '/payment-instances/tamara?secrets=1')).body.config.webhooks[0].headers.Authorization).toBe(tamaraAuth);
      const plain = JSON.stringify((await api('GET', '/api/projects/shop4/export')).body);
      for (const s of secrets) expect(plain, s).not.toContain(s);
      expect(plain).not.toContain('/tm-hook');
      const full = (await api('GET', '/api/projects/shop4/export?secrets=1')).body;
      expect(JSON.stringify(full)).toContain(moySecret);
      const im = await api('POST', '/api/projects/import', { ...full, project: { ...full.project, name: 'Shop 4 hooks', slug: 'shop4-hooks' } });
      expect(im.status, im.text).toBeLessThan(300);
      const copy = async (inst: string) => (await api('GET', '/api/projects/shop4-hooks/payment-instances/' + inst + '?secrets=1')).body.config.webhooks;
      expect((await copy('moyasar')).find((h: any) => h.url === appUrl + '/moy-hook').shared_secret).toBe(moySecret);
      expect((await copy('tabby')).find((h: any) => h.url === appUrl + '/tb-hook2').header.value).toBe(tabbyValue);
      expect((await copy('tamara'))[0].headers.Authorization).toBe(tamaraAuth);
      // Without secrets the registries stay behind.
      const im2 = await api('POST', '/api/projects/import', { ...(await api('GET', '/api/projects/shop4/export')).body, project: { ...full.project, name: 'Shop 4 bare', slug: 'shop4-bare' } });
      expect(im2.status, im2.text).toBeLessThan(300);
      expect((await api('GET', '/api/projects/shop4-bare/payment-instances/tamara?secrets=1')).body.config.webhooks).toBeUndefined();
      // Moyasar / Tamara registries are capped at 20.
      for (let i = (await copy('moyasar')).length; i < 20; i++) expect((await call('POST', '/pay/shop4/moyasar/v1/webhooks', { json: { url: appUrl + '/moy-' + i }, headers: moyAuth })).status).toBe(201);
      expect((await call('POST', '/pay/shop4/moyasar/v1/webhooks', { json: { url: appUrl + '/moy-x' }, headers: moyAuth })).status).toBe(400);
      for (const h of (await call('GET', '/pay/shop4/moyasar/v1/webhooks', { headers: moyAuth })).body.webhooks) await call('DELETE', '/pay/shop4/moyasar/v1/webhooks/' + h.id, { headers: moyAuth });
      await call('DELETE', '/pay/shop4/tabby/api/v1/webhooks/' + bh.body.id, { headers: { authorization: 'Bearer ' + cfgs.tabby.secretKey, 'x-merchant-code': 'stubyard' } });
      await call('DELETE', '/pay/shop4/tamara/webhooks/' + th.body.webhook_id, { headers: tmAuth });
    });

    it('malformed percent-encoding in an id is a not-found, not a 500', async () => {
      // Fastify itself refuses a malformed path (400); an id that decodes to malformed percent-encoding reaches the gateway.
      const bad = '%25E0%25A4%25A';
      const moy = await call('GET', '/pay/shop4/moyasar/v1/payments/' + bad, { headers: { authorization: 'Basic ' + Buffer.from(cfgs.moyasar.secretKey + ':').toString('base64') } });
      const tap = await call('GET', '/pay/shop4/tap/v2/charges/' + bad, { headers: { authorization: 'Bearer ' + cfgs.tap.secretKey } });
      const cko = await call('GET', '/pay/shop4/checkout/payments/' + bad, { headers: { authorization: 'Bearer ' + cfgs.checkout.secretKey } });
      const tm = await call('GET', '/pay/shop4/tamara/orders/' + bad, { headers: { authorization: 'Bearer ' + cfgs.tamara.apiToken } });
      for (const [name, r] of Object.entries({ moy, tap, cko, tm })) {
        expect(r.status, name + ' ' + r.text).toBeLessThan(500);
        expect(r.status, name + ' ' + r.text).toBeGreaterThanOrEqual(400);
      }
    });

    it('card tokens expire and are capped (in-memory store)', async () => {
      const s = new ExpiringStore<number>(50, 3);
      for (let i = 0; i < 5; i++) s.set('t' + i, i);
      expect(s.size).toBe(3);
      expect(s.get('t0')).toBeUndefined();
      expect(s.get('t4')).toBe(4);
      await new Promise((r) => setTimeout(r, 80));
      expect(s.get('t4')).toBeUndefined();
      s.set('n', 1);
      expect(s.size).toBe(1);
    });

    it('connect sections have env, notes and two snippets', async () => {
      for (const preset of ['moyasar', 'tap', 'tabby', 'tamara', 'checkout']) {
        const r = await api('GET', PJ + '/payment-instances/' + preset);
        expect(r.status, preset + ' ' + r.text).toBe(200);
        expect(Object.keys(r.body.connect.env).length).toBeGreaterThan(2);
        expect(r.body.connect.notes.length).toBeGreaterThan(2);
        expect(r.body.connect.snippets.length).toBe(2);
      }
    });
  });
});
