import { createHmac, createVerify } from 'node:crypto';
import { crc32 } from 'node:zlib';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { canTransition, parseOutcome, resolveOutcome, transition } from '../src/payments/engine.js';
import { parseBracketForm } from '../src/payments/common.js';
import { paytabsReturnSignature } from '../src/payments/paytabs/index.js';
import { rewritePayHost } from '../src/payments/host.js';

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
let failNext = 0;

async function call<T = any>(method: string, p: string, opts: { json?: unknown; form?: string; headers?: Record<string, string>; redirect?: 'manual' } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
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

const PJ = '/api/projects/shop';
const form = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const hitsAt = (p: string) => received.filter((r) => r.path === p);
let stripeKey = '';
let whsec = '';
let ptKey = '';
let ptProfile = '';
let pp: { clientId: string; clientSecret: string; webhookId: string; certPem: string };

const stripeHeaders = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${stripeKey}`, ...extra });
async function stripeSession(extra: Record<string, string | number> = {}, headers: Record<string, string> = {}) {
  const r = await call('POST', '/pay/shop/stripe/v1/checkout/sessions', {
    form: form({ mode: 'payment', success_url: `${appUrl}/ok?sid={CHECKOUT_SESSION_ID}`, cancel_url: `${appUrl}/cancel`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 2500, 'line_items[0][price_data][product_data][name]': 'T-shirt', 'line_items[0][quantity]': 2, client_reference_id: 'order-1', ...extra }),
    headers: stripeHeaders({ 'idempotency-key': `k-${Math.random()}`, ...headers }),
  });
  expect(r.status, r.text).toBe(200);
  return r.body;
}
const payId = async (ref: string) => (await api('GET', `${PJ}/payments/${ref}`)).body.id as string;

describe('payments', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devhub-pay-'));
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
    base = `http://127.0.0.1:${httpPort}`;
    appServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body, headers: req.headers, method: req.method ?? '' });
        if (failNext > 0) {
          failNext--;
          return res.writeHead(500).end('nope');
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Shop', slug: 'shop', generateUsers: { admins: 1, customers: 2 } })).status).toBe(201);

    const s = await api('POST', `${PJ}/payment-instances`, { preset: 'stripe-checkout', config: { webhookUrl: `${appUrl}/stripe`, webhookDelayMs: 0 } });
    expect(s.status, s.text).toBe(201);
    expect(s.body.slug).toBe('stripe');
    stripeKey = s.body.config.secretKey;
    whsec = s.body.config.webhookSecret;
    const t = await api('POST', `${PJ}/payment-instances`, { preset: 'paytabs', config: { webhookDelayMs: 0 } });
    expect(t.status, t.text).toBe(201);
    ptKey = t.body.config.serverKey;
    ptProfile = t.body.config.profileId;
    const p = await api('POST', `${PJ}/payment-instances`, { preset: 'paypal', config: { webhookUrl: `${appUrl}/paypal`, webhookDelayMs: 0 } });
    expect(p.status, p.text).toBe(201);
    pp = p.body.config;
    expect(pp.certPem).toContain('BEGIN CERTIFICATE');
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('engine', () => {
    it('state machine', () => {
      expect(transition('created', 'open')).toBe('pending');
      expect(transition('pending', 'authorize')).toBe('authorized');
      expect(transition('authorized', 'capture')).toBe('paid');
      expect(transition('paid', 'refund_partial')).toBe('partially_refunded');
      expect(transition('partially_refunded', 'refund_full')).toBe('refunded');
      expect(transition('failed', 'retry')).toBe('pending');
      expect(canTransition('refunded', 'capture')).toBe(false);
      expect(() => transition('paid', 'open')).toThrow();
    });
    it('outcome parsing and precedence', () => {
      const o = parseOutcome('decline:insufficient_funds+webhook_delay=5000+duplicate_webhook');
      expect(o).toMatchObject({ base: 'decline', reason: 'insufficient_funds', webhookDelayMs: 5000, duplicateWebhook: true });
      expect(() => parseOutcome('explode')).toThrow();
      const all = { header: 'cancel', runRule: () => 'decline', userRule: () => '3ds_fail', instanceRule: () => 'abandon', magicCard: 'decline:expired_card', magicAmount: 'decline:generic', click: 'success', clickVia: 'page' as const, defaultOutcome: 'pending_then_success' };
      const consumed: string[] = [];
      const track = (k: string, v: string) => () => (consumed.push(k), v);
      expect(resolveOutcome({ ...all, runRule: track('run', 'decline') })).toMatchObject({ outcome: 'cancel', via: 'header' });
      expect(consumed).toEqual([]); // the header wins: no rule consumed
      expect(resolveOutcome({ ...all, header: null })).toMatchObject({ via: 'run rule' });
      expect(resolveOutcome({ ...all, header: null, runRule: () => null })).toMatchObject({ via: 'user rule' });
      expect(resolveOutcome({ ...all, header: null, runRule: () => null, userRule: () => null })).toMatchObject({ via: 'instance rule' });
      const noRules = { ...all, header: null, runRule: () => null, userRule: () => null, instanceRule: () => null };
      expect(resolveOutcome(noRules)).toMatchObject({ via: 'magic card' });
      expect(resolveOutcome({ ...noRules, magicCard: null })).toMatchObject({ via: 'magic amount' });
      expect(resolveOutcome({ ...noRules, magicCard: null, magicAmount: null })).toMatchObject({ outcome: 'success', via: 'page' });
      expect(resolveOutcome({ ...noRules, magicCard: null, magicAmount: null, click: null })).toMatchObject({ outcome: 'pending_then_success', via: 'default' });
    });
    it('bracket forms, PayTabs signature, pay host', () => {
      expect(parseBracketForm({ 'line_items[0][price_data][unit_amount]': '5', 'expand[]': ['a', 'b'], 'metadata[k]': 'v' })).toEqual({ line_items: [{ price_data: { unit_amount: '5' } }], expand: ['a', 'b'], metadata: { k: 'v' } });
      // ksort, drop empty and signature, PHP urlencode (space → +)
      const sig = paytabsReturnSignature({ tranRef: 'TST1', respMessage: 'Cancelled by customer', token: '', signature: 'x' }, 'K');
      expect(sig).toBe(createHmac('sha256', 'K').update('respMessage=Cancelled+by+customer&tranRef=TST1').digest('hex'));
      expect(rewritePayHost({ url: '/v1/x', headers: { host: 'stripe.shop.pay.devhub.test:4443' } }, 'devhub.test')).toBe('/pay/shop/stripe/v1/x');
      expect(rewritePayHost({ url: '/v1/x', headers: { host: 'a.b.c.devhub.test' } }, 'devhub.test')).toBeNull();
    });
  });

  describe('Stripe Checkout', () => {
    it('happy path: form-encoded create, hosted page, redirect, signed webhooks, retrieve, refund', async () => {
      const cs = await stripeSession();
      expect(cs.id).toMatch(/^cs_test_/);
      expect(cs).toMatchObject({ object: 'checkout.session', amount_total: 5000, currency: 'usd', status: 'open', payment_status: 'unpaid', client_reference_id: 'order-1' });
      const entry = await call('GET', new URL(cs.url).pathname);
      expect(entry.status).toBe(302);
      const pageUrl = new URL(entry.headers.get('location')!, base + new URL(cs.url).pathname).pathname;
      const page = await call('GET', pageUrl);
      expect(page.status).toBe(200);
      expect(page.text).toContain('data-testid="devhub-pay"');
      expect(page.text).toContain('50.00 USD');
      const before = hitsAt('/stripe').length;
      const done = await call('POST', `${pageUrl}/complete`, { form: form({ outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' }) });
      expect(done.status).toBe(303);
      expect(done.headers.get('location')).toBe(`${appUrl}/ok?sid=${cs.id}`);
      // webhooks were delivered inline (webhookDelayMs 0) and are Stripe-signed
      const hooks = hitsAt('/stripe').slice(before);
      const types = hooks.map((h) => JSON.parse(h.body).type);
      expect(types).toEqual(['payment_intent.succeeded', 'checkout.session.completed']);
      for (const h of hooks) {
        const sigH = String(h.headers['stripe-signature']);
        const t = /t=(\d+)/.exec(sigH)![1];
        expect(sigH).toContain(`v1=${createHmac('sha256', whsec).update(`${t}.${h.body}`).digest('hex')}`);
      }
      const completed = JSON.parse(hooks[1]!.body).data.object;
      expect(completed).toMatchObject({ id: cs.id, status: 'complete', payment_status: 'paid' });
      const got = await call('GET', `/pay/shop/stripe/v1/checkout/sessions/${cs.id}?expand[]=payment_intent`, { headers: stripeHeaders() });
      expect(got.body.payment_intent).toMatchObject({ object: 'payment_intent', status: 'succeeded', amount_received: 5000 });
      const pi = got.body.payment_intent.id;
      const ref1 = await call('POST', '/pay/shop/stripe/v1/refunds', { form: form({ payment_intent: pi, amount: 1000 }), headers: stripeHeaders() });
      expect(ref1.status, ref1.text).toBe(200);
      expect(ref1.body).toMatchObject({ object: 'refund', amount: 1000, status: 'succeeded' });
      const tooMuch = await call('POST', '/pay/shop/stripe/v1/refunds', { form: form({ payment_intent: pi, amount: 9000 }), headers: stripeHeaders() });
      expect(tooMuch.status).toBe(400);
      expect(tooMuch.body.error.code).toBe('amount_too_large');
      const detail = (await api('GET', `${PJ}/payments/${cs.id}`)).body;
      expect(detail.status).toBe('partially_refunded');
      expect(detail.refunded).toBe(1000);
      expect(detail.lint.map((l: any) => l.check)).toContain('pay.refund-exceeds');
      expect(hitsAt('/stripe').map((h) => JSON.parse(h.body).type)).toContain('charge.refunded');
    });

    it('idempotency replay, live keys, decline keeps the page open, cancel', async () => {
      const key = 'idem-1';
      const a = await stripeSession({}, { 'idempotency-key': key });
      const b = await call('POST', '/pay/shop/stripe/v1/checkout/sessions', {
        form: form({ mode: 'payment', success_url: `${appUrl}/ok?sid={CHECKOUT_SESSION_ID}`, cancel_url: `${appUrl}/cancel`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 2500, 'line_items[0][price_data][product_data][name]': 'T-shirt', 'line_items[0][quantity]': 2, client_reference_id: 'order-1' }),
        headers: stripeHeaders({ 'idempotency-key': key }),
      });
      expect(b.headers.get('idempotent-replayed')).toBe('true');
      expect(b.body.id).toBe(a.id);
      const live = await call('GET', `/pay/shop/stripe/v1/checkout/sessions/${a.id}`, { headers: { authorization: 'Bearer sk_live_abcdefghijklmnop1234' } });
      expect(live.status).toBe(401);
      expect((await api('GET', `${PJ}/payments/lint`)).body.findings.map((f: any) => f.check)).toContain('pay.live-key');

      const id = await payId(a.id);
      const declined = await call('POST', `/pay/shop/stripe/page/${id}/complete`, { form: form({ outcome: 'decline:insufficient_funds', method: 'card' }) });
      expect(declined.status).toBe(402);
      expect(declined.text).toContain('insufficient funds');
      const s1 = await call('GET', `/pay/shop/stripe/v1/checkout/sessions/${a.id}?expand[]=payment_intent`, { headers: stripeHeaders() });
      expect(s1.body.status).toBe('open');
      expect(s1.body.payment_intent.last_payment_error).toMatchObject({ code: 'card_declined', decline_code: 'insufficient_funds' });
      const retry = await call('POST', `/pay/shop/stripe/page/${id}/complete`, { form: form({ outcome: 'success', method: 'card' }) });
      expect(retry.status).toBe(303);

      const c = await stripeSession();
      const cancel = await api('POST', `${PJ}/payments/${c.id}/complete`, { outcome: 'cancel' });
      expect(cancel.body.redirectUrl).toBe(`${appUrl}/cancel`);
      expect(cancel.body.payment.status).toBe('cancelled');
      // expire through the Stripe API
      const d = await stripeSession();
      const ex = await call('POST', `/pay/shop/stripe/v1/checkout/sessions/${d.id}/expire`, { headers: stripeHeaders() });
      expect(ex.body.status).toBe('expired');
      expect(hitsAt('/stripe').map((h) => JSON.parse(h.body).type)).toContain('checkout.session.expired');
    });

    it('3DS magic card shows a challenge; pending_then_success settles via a scheduled webhook', async () => {
      const a = await stripeSession();
      const id = await payId(a.id);
      const ch = await call('POST', `/pay/shop/stripe/page/${id}/complete`, { form: form({ outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' }) });
      expect(ch.text).toContain('devhub-3ds-pass');
      const ok = await call('POST', `/pay/shop/stripe/page/${id}/complete`, { form: form({ outcome: '3ds_success', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' }) });
      expect(ok.status).toBe(303);
      const det = (await api('GET', `${PJ}/payments/${id}`)).body;
      expect(det.status).toBe('paid');
      expect(det.events.map((e: any) => e.type)).toContain('3ds');

      await api('PATCH', `${PJ}/payment-instances/stripe`, { config: { settleDelayMs: 60_000 } });
      const b = await stripeSession();
      const r = await api('POST', `${PJ}/payments/${b.id}/complete`, { outcome: 'pending_then_success' });
      expect(r.body.payment.status).toBe('authorized');
      const s = await call('GET', `/pay/shop/stripe/v1/checkout/sessions/${b.id}?expand[]=payment_intent`, { headers: stripeHeaders() });
      expect(s.body.payment_intent.status).toBe('processing');
      await api('POST', `${PJ}/schedules/flush`, {});
      const paid = await waitFor(async () => {
        const x = (await api('GET', `${PJ}/payments/${b.id}`)).body;
        return x.status === 'paid' ? x : null;
      });
      expect(paid.events.map((e: any) => e.type)).toContain('settled');
      expect(hitsAt('/stripe').map((h) => JSON.parse(h.body).type)).toContain('checkout.session.async_payment_succeeded');
      await api('PATCH', `${PJ}/payment-instances/stripe`, { config: { settleDelayMs: null } });
    });
  });

  describe('PayTabs', () => {
    const ptReq = (body: Record<string, unknown>, key = ptKey) => call('POST', '/pay/shop/paytabs/payment/request', { json: { profile_id: Number(ptProfile), ...body }, headers: { authorization: key } });
    const sale = (extra: Record<string, unknown> = {}) =>
      ptReq({ tran_type: 'sale', tran_class: 'ecom', cart_id: 'cart-7', cart_description: 'Order 7', cart_currency: 'SAR', cart_amount: 115.5, callback: `${appUrl}/paytabs-ipn`, return: `${appUrl}/paytabs-return`, customer_details: { name: 'A B', email: 'a@example.com' }, ...extra });

    it('auth header, request, page, signed return, signed callback, query, refund', async () => {
      const bad = await ptReq({ tran_type: 'sale' }, 'Bearer nope');
      expect(bad.status).toBe(401);
      expect(bad.body).toMatchObject({ code: 1, message: 'Authentication failed. Check authentication header.' });
      const r = await sale();
      expect(r.status, r.text).toBe(200);
      expect(r.body.tran_ref).toMatch(/^TST\d{13}$/);
      expect(r.body).toMatchObject({ tran_type: 'Sale', cart_id: 'cart-7', cart_amount: '115.50', cart_currency: 'SAR' });
      const entry = await call('GET', new URL(r.body.redirect_url).pathname);
      expect(entry.status).toBe(302);
      const id = await payId(r.body.tran_ref);
      const page = await call('GET', `/pay/shop/paytabs/page/${id}`);
      for (const m of ['card', 'mada', 'stcpay', 'applepay']) expect(page.text).toContain(`devhub-method-${m}`);
      const done = await call('POST', `/pay/shop/paytabs/page/${id}/complete`, { form: form({ outcome: 'success', method: 'mada' }) });
      expect(done.status).toBe(200);
      expect(done.text).toContain(`action="${appUrl}/paytabs-return"`);
      const fields: Record<string, string> = {};
      for (const m of done.text.matchAll(/name="([^"]+)" value="([^"]*)"/g)) fields[m[1]!] = m[2]!.replace(/&amp;/g, '&');
      expect(fields).toMatchObject({ respStatus: 'A', respMessage: 'Authorised', tranRef: r.body.tran_ref, cartId: 'cart-7' });
      expect(fields.signature).toBe(paytabsReturnSignature(fields, ptKey));
      const ipn = hitsAt('/paytabs-ipn').at(-1)!;
      expect(ipn.headers.signature).toBe(createHmac('sha256', ptKey).update(ipn.body).digest('hex'));
      expect(JSON.parse(ipn.body)).toMatchObject({ tran_ref: r.body.tran_ref, payment_result: { response_status: 'A' }, payment_info: { card_scheme: 'mada' } });
      const q = await call('POST', '/pay/shop/paytabs/payment/query', { json: { profile_id: Number(ptProfile), tran_ref: r.body.tran_ref }, headers: { authorization: ptKey } });
      expect(q.body.payment_result.response_status).toBe('A');
      const byCart = await call('POST', '/pay/shop/paytabs/payment/query', { json: { profile_id: Number(ptProfile), cart_id: 'cart-7' }, headers: { authorization: ptKey } });
      expect(Array.isArray(byCart.body)).toBe(true);
      const ref = await ptReq({ tran_type: 'refund', tran_class: 'ecom', tran_ref: r.body.tran_ref, cart_id: 'cart-7', cart_description: 'refund', cart_currency: 'SAR', cart_amount: 15.5 });
      expect(ref.body).toMatchObject({ tran_type: 'Refund', previous_tran_ref: r.body.tran_ref, payment_result: { response_status: 'A' } });
      expect((await api('GET', `${PJ}/payments/${id}`)).body).toMatchObject({ status: 'partially_refunded', refunded: 1550 });
    });

    it('decline returns a D status; auth + capture + void; cancel = C 321', async () => {
      const r = await sale({ return_using_get: true });
      const res = await api('POST', `${PJ}/payments/${r.body.tran_ref}/complete`, { outcome: 'decline:insufficient_funds' });
      const u = new URL(res.body.redirectUrl);
      expect(u.searchParams.get('respStatus')).toBe('D');
      const f = Object.fromEntries(u.searchParams);
      expect(f.signature).toBe(paytabsReturnSignature(f, ptKey));

      const a = await sale({ tran_type: 'auth' });
      await api('POST', `${PJ}/payments/${a.body.tran_ref}/complete`, { outcome: 'success' });
      expect((await api('GET', `${PJ}/payments/${a.body.tran_ref}`)).body.status).toBe('authorized');
      const cap = await ptReq({ tran_type: 'capture', tran_class: 'ecom', tran_ref: a.body.tran_ref, cart_id: 'cart-7', cart_description: 'cap', cart_currency: 'SAR', cart_amount: 115.5 });
      expect(cap.body.payment_result.response_status).toBe('A');
      expect((await api('GET', `${PJ}/payments/${a.body.tran_ref}`)).body.status).toBe('paid');

      const v = await sale({ tran_type: 'auth' });
      await api('POST', `${PJ}/payments/${v.body.tran_ref}/complete`, { outcome: 'success' });
      const vo = await ptReq({ tran_type: 'void', tran_class: 'ecom', tran_ref: v.body.tran_ref, cart_id: 'cart-7', cart_description: 'void', cart_currency: 'SAR', cart_amount: 115.5 });
      expect(vo.body).toMatchObject({ tran_type: 'Void', payment_result: { response_status: 'A' } });
      const q = await call('POST', '/pay/shop/paytabs/payment/query', { json: { profile_id: Number(ptProfile), tran_ref: v.body.tran_ref }, headers: { authorization: ptKey } });
      expect(q.body.payment_result.response_status).toBe('V');

      const c = await sale();
      const cr = await api('POST', `${PJ}/payments/${c.body.tran_ref}/complete`, { outcome: 'cancel' });
      expect(cr.body.redirect.fields).toMatchObject({ respStatus: 'C', respCode: '321' });
    });

    it('STC Pay: OTP in the SMS inbox, wrong code, right code', async () => {
      const r = await sale();
      const id = await payId(r.body.tran_ref);
      const first = await call('POST', `/pay/shop/paytabs/page/${id}/complete`, { form: form({ outcome: 'success', method: 'stcpay', phone: '0551234567' }) });
      expect(first.text).toContain('devhub-otp');
      const sms = await waitFor(async () => {
        const list = (await api('GET', `${PJ}/messages?channel=sms`)).body as any[];
        const items = Array.isArray(list) ? list : (list as any).messages ?? (list as any).items ?? [];
        return items.find((m: any) => String(m.bodyText ?? '').includes('STC Pay')) ?? null;
      });
      const otp = /\b(\d{6})\b/.exec(String(sms.bodyText))![1]!;
      expect(sms.otp).toBe(otp);
      const wrong = await call('POST', `/pay/shop/paytabs/page/${id}/complete`, { form: form({ outcome: 'success', method: 'stcpay', phone: '0551234567', otp: otp === '000000' ? '111111' : '000000' }) });
      expect(wrong.status).toBe(400);
      expect(wrong.text).toContain('Wrong code');
      const right = await call('POST', `/pay/shop/paytabs/page/${id}/complete`, { form: form({ outcome: 'success', method: 'stcpay', phone: '0551234567', otp }) });
      expect(right.text).toContain('paytabs-return');
      const det = (await api('GET', `${PJ}/payments/${id}`)).body;
      expect(det.status).toBe('paid');
      expect(det.method).toBe('stcpay');
      expect(JSON.stringify(det)).not.toContain(`"otp":"${otp}"`);
    });
  });

  describe('PayPal', () => {
    let token = '';
    const auth = () => ({ authorization: `Bearer ${token}` });
    const order = async (extra: Record<string, unknown> = {}) => {
      const r = await call('POST', '/pay/shop/paypal/v2/checkout/orders', {
        json: { intent: 'CAPTURE', purchase_units: [{ reference_id: 'ord-9', custom_id: 'c-9', amount: { currency_code: 'USD', value: '20.00' } }], payment_source: { paypal: { experience_context: { return_url: `${appUrl}/pp-return`, cancel_url: `${appUrl}/pp-cancel` } } }, ...extra },
        headers: { ...auth(), 'paypal-request-id': `r-${Math.random()}` },
      });
      expect(r.status, r.text).toBe(201);
      return r.body;
    };

    it('token, order, capture-before-approve, approve, signed webhook + verify, capture, double capture, refund', async () => {
      const t = await call('POST', '/pay/shop/paypal/v1/oauth2/token', { form: 'grant_type=client_credentials', headers: { authorization: `Basic ${Buffer.from(`${pp.clientId}:x`).toString('base64')}` } });
      expect(t.status, t.text).toBe(200);
      token = t.body.access_token;
      expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 32400 });
      expect((await call('GET', '/pay/shop/paypal/v2/checkout/orders/NOPE', { headers: { authorization: 'Bearer bad' } })).status).toBe(401);

      const o = await order();
      expect(o.status).toBe('PAYER_ACTION_REQUIRED');
      const approve = o.links.find((l: any) => l.rel === 'payer-action').href;
      expect((await call('GET', new URL(approve).pathname + new URL(approve).search)).status).toBe(302);
      const early = await call('POST', `/pay/shop/paypal/v2/checkout/orders/${o.id}/capture`, { json: {}, headers: auth() });
      expect(early.status).toBe(422);
      expect(early.body.details[0].issue).toBe('ORDER_NOT_APPROVED');

      const before = hitsAt('/paypal').length;
      const r = await api('POST', `${PJ}/payments/${o.id}/complete`, { outcome: 'success' });
      const ru = new URL(r.body.redirectUrl);
      expect(ru.searchParams.get('token')).toBe(o.id);
      expect(ru.searchParams.get('PayerID')).toBeTruthy();
      const hook = hitsAt('/paypal')[before]!;
      expect(JSON.parse(hook.body)).toMatchObject({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: o.id, status: 'APPROVED' } });
      const h = hook.headers;
      const signed = `${h['paypal-transmission-id']}|${h['paypal-transmission-time']}|${pp.webhookId}|${crc32(Buffer.from(hook.body)) >>> 0}`;
      expect(createVerify('RSA-SHA256').update(signed).verify(pp.certPem, String(h['paypal-transmission-sig']), 'base64')).toBe(true);
      expect(h['paypal-auth-algo']).toBe('SHA256withRSA');
      const cert = await call('GET', new URL(String(h['paypal-cert-url'])).pathname);
      expect(cert.text).toContain('BEGIN CERTIFICATE');
      expect((await api('GET', `${PJ}/payments/lint`)).body.findings.map((f: any) => f.check)).toContain('pay.paypal-signature-never-verified');
      const ver = await call('POST', '/pay/shop/paypal/v1/notifications/verify-webhook-signature', {
        json: { auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: pp.webhookId, webhook_event: JSON.parse(hook.body) },
        headers: auth(),
      });
      expect(ver.body).toEqual({ verification_status: 'SUCCESS' });
      const forged = await call('POST', '/pay/shop/paypal/v1/notifications/verify-webhook-signature', {
        json: { auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: 'other', transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: pp.webhookId, webhook_event: JSON.parse(hook.body) },
        headers: auth(),
      });
      expect(forged.body).toEqual({ verification_status: 'FAILURE' });
      expect((await api('GET', `${PJ}/payments/lint`)).body.findings.map((f: any) => f.check)).not.toContain('pay.paypal-signature-never-verified');

      const cap = await call('POST', `/pay/shop/paypal/v2/checkout/orders/${o.id}/capture`, { json: {}, headers: { ...auth(), 'paypal-request-id': 'cap-1' } });
      expect(cap.status, cap.text).toBe(201);
      expect(cap.body.status).toBe('COMPLETED');
      const capture = cap.body.purchase_units[0].payments.captures[0];
      expect(capture).toMatchObject({ status: 'COMPLETED', amount: { currency_code: 'USD', value: '20.00' } });
      const replay = await call('POST', `/pay/shop/paypal/v2/checkout/orders/${o.id}/capture`, { json: {}, headers: { ...auth(), 'paypal-request-id': 'cap-1' } });
      expect(replay.status).toBe(201);
      const twice = await call('POST', `/pay/shop/paypal/v2/checkout/orders/${o.id}/capture`, { json: {}, headers: { ...auth(), 'paypal-request-id': 'cap-2' } });
      expect(twice.body.details[0].issue).toBe('ORDER_ALREADY_CAPTURED');
      expect(hitsAt('/paypal').map((x) => JSON.parse(x.body).event_type)).toContain('PAYMENT.CAPTURE.COMPLETED');
      const ref = await call('POST', `/pay/shop/paypal/v2/payments/captures/${capture.id}/refund`, { json: { amount: { currency_code: 'USD', value: '5.00' } }, headers: auth() });
      expect(ref.status, ref.text).toBe(201);
      expect(ref.body.status).toBe('COMPLETED');
      const gc = await call('GET', `/pay/shop/paypal/v2/payments/captures/${capture.id}`, { headers: auth() });
      expect(gc.body.status).toBe('PARTIALLY_REFUNDED');
      expect(hitsAt('/paypal').map((x) => JSON.parse(x.body).event_type)).toContain('PAYMENT.CAPTURE.REFUNDED');
    });

    it('decline happens at capture (page decline or PayPal-Mock-Response)', async () => {
      const o = await order();
      await api('POST', `${PJ}/payments/${o.id}/complete`, { outcome: 'decline' });
      const cap = await call('POST', `/pay/shop/paypal/v2/checkout/orders/${o.id}/capture`, { json: {}, headers: auth() });
      expect(cap.status).toBe(422);
      expect(cap.body.details[0].issue).toBe('INSTRUMENT_DECLINED');
      expect(hitsAt('/paypal').map((x) => JSON.parse(x.body).event_type)).toContain('PAYMENT.CAPTURE.DENIED');
      const o2 = await order();
      await api('POST', `${PJ}/payments/${o2.id}/complete`, { outcome: 'success' });
      const m = await call('POST', `/pay/shop/paypal/v2/checkout/orders/${o2.id}/capture`, { json: {}, headers: { ...auth(), 'paypal-mock-response': '{"mock_application_codes":"INSTRUMENT_DECLINED"}' } });
      expect(m.body.details[0].issue).toBe('INSTRUMENT_DECLINED');
      const o3 = await order();
      const c = await api('POST', `${PJ}/payments/${o3.id}/complete`, { outcome: 'cancel' });
      expect(c.body.redirectUrl).toBe(`${appUrl}/pp-cancel?token=${o3.id}`);
    });
  });

  describe('outcome precedence over the API', () => {
    it('header > run rule > user rule > instance rule > magic card > magic amount > click > default', async () => {
      const users = (await api('GET', `${PJ}/users`)).body as any[];
      const user = users.find((u) => u.email) ?? users[0];
      const run = (await api('POST', `${PJ}/runs`, { key: 'prec' })).body;
      const viaOf = async (opts: { header?: string; run?: boolean; card?: string; amount?: number; outcome?: string; user?: string }) => {
        const h: Record<string, string> = opts.header ? { 'x-hub-payment-outcome': opts.header } : {};
        if (opts.run) h['x-hub-run'] = run.key;
        const cs = await call('POST', '/pay/shop/stripe/v1/checkout/sessions', {
          form: form({ mode: 'payment', success_url: `${appUrl}/ok`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': opts.amount ?? 1000, 'line_items[0][price_data][product_data][name]': 'x', client_reference_id: 'p' }),
          headers: stripeHeaders(h),
        });
        expect(cs.status, cs.text).toBe(200);
        const r = await api('POST', `${PJ}/payments/${cs.body.id}/complete`, { outcome: opts.outcome, user: opts.user, card: opts.card });
        expect(r.status, r.text).toBe(200);
        return `${r.body.via}:${r.body.outcome}`;
      };
      await api('PATCH', `${PJ}/payment-instances/stripe`, { config: { magicAmounts: true, defaultOutcome: 'cancel' } });
      await api('POST', `${PJ}/payment-rules`, { outcome: 'decline:processing_error', run: run.key, count: 1 });
      await api('POST', `${PJ}/payment-rules`, { outcome: 'decline:expired_card', user: user.id, count: 1 });
      await api('POST', `${PJ}/payment-rules`, { outcome: 'decline:incorrect_cvc', instance: 'stripe', count: 1 });
      expect(await viaOf({ header: 'decline', run: true, user: user.id, card: 'decline', outcome: 'success' })).toBe('header:decline:generic');
      expect(await viaOf({ run: true, user: user.id, card: 'decline', outcome: 'success' })).toBe('run rule:decline:processing_error');
      expect(await viaOf({ user: user.id, card: 'decline', outcome: 'success' })).toBe('user rule:decline:expired_card');
      expect(await viaOf({ card: 'decline', outcome: 'success' })).toBe('instance rule:decline:incorrect_cvc');
      expect(await viaOf({ card: '4000000000009995', amount: 1002, outcome: 'success' })).toBe('magic card:decline:insufficient_funds');
      expect(await viaOf({ amount: 1002, outcome: 'success' })).toBe('magic amount:decline:generic');
      expect(await viaOf({ outcome: 'success' })).toBe('api:success');
      expect(await viaOf({})).toBe('default:cancel');
      await api('PATCH', `${PJ}/payment-instances/stripe`, { config: { magicAmounts: false, defaultOutcome: null } });
      // a real-looking card is refused and never stored
      const cs = await stripeSession();
      const real = await api('POST', `${PJ}/payments/${cs.id}/complete`, { card: '4532015112830366' });
      expect(real.status).toBe(400);
      await api('POST', `/api/projects/shop/runs/${run.key}/stop`, {});
    });
  });

  describe('hardening: URLs, CSP, redaction, card masking', () => {
    const ppToken = async () => (await call('POST', '/pay/shop/paypal/v1/oauth2/token', { form: 'grant_type=client_credentials', headers: { authorization: `Basic ${Buffer.from(`${pp.clientId}:x`).toString('base64')}` } })).body.access_token as string;
    const ptReq = (body: Record<string, unknown>) =>
      call('POST', '/pay/shop/paytabs/payment/request', { json: { profile_id: Number(ptProfile), tran_type: 'sale', tran_class: 'ecom', cart_id: 'h-1', cart_description: 'H', cart_currency: 'SAR', cart_amount: 10, return: `${appUrl}/r`, ...body }, headers: { authorization: ptKey } });
    const stripeCreate = (extra: Record<string, string | number>) =>
      call('POST', '/pay/shop/stripe/v1/checkout/sessions', {
        form: form({ mode: 'payment', success_url: `${appUrl}/ok`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 100, 'line_items[0][price_data][product_data][name]': 'x', client_reference_id: 'h', ...extra }),
        headers: stripeHeaders(),
      });

    it('rejects non-http(s) and relative return / cancel / callback URLs with provider-shaped 400s', async () => {
      const s1 = await stripeCreate({ success_url: 'javascript:alert(document.domain)' });
      expect(s1.status).toBe(400);
      expect(s1.body.error).toMatchObject({ type: 'invalid_request_error', param: 'success_url', code: 'url_invalid' });
      const s2 = await stripeCreate({ cancel_url: '/relative/cancel' });
      expect(s2.status).toBe(400);
      expect(s2.body.error.param).toBe('cancel_url');

      const token = await ppToken();
      const ppCreate = (ctx: Record<string, string>) =>
        call('POST', '/pay/shop/paypal/v2/checkout/orders', { json: { intent: 'CAPTURE', purchase_units: [{ reference_id: 'h', amount: { currency_code: 'USD', value: '1.00' } }], payment_source: { paypal: { experience_context: ctx } } }, headers: { authorization: `Bearer ${token}` } });
      const p1 = await ppCreate({ return_url: 'javascript:alert(1)', cancel_url: `${appUrl}/c` });
      expect(p1.status).toBe(400);
      expect(p1.body).toMatchObject({ name: 'INVALID_REQUEST', details: [{ field: '/payment_source/paypal/experience_context/return_url', issue: 'INVALID_PARAMETER_SYNTAX' }] });
      expect((await ppCreate({ return_url: `${appUrl}/r`, cancel_url: 'cancel.html' })).status).toBe(400);

      const t1 = await ptReq({ return: 'javascript:alert(1)' });
      expect(t1.status).toBe(400);
      expect(t1.body).toMatchObject({ code: 4 });
      expect((await ptReq({ callback: '/ipn' })).status).toBe(400);
      expect((await api('GET', `${PJ}/payments/lint`)).body.findings.map((f: any) => f.check)).toContain('pay.return-url-missing-or-bad');
    });

    it('a stored return URL that does not parse never causes a 500: "no return URL" instead', async () => {
      const cs = await stripeSession();
      const id = await payId(cs.id);
      hub.payments.repo.update(id, { returnUrl: 'javascript:alert(1)' });
      const done = await call('POST', `/pay/shop/stripe/page/${id}/complete`, { form: form({ outcome: 'success', method: 'card' }) });
      expect(done.status).toBe(200);
      expect(done.text).toContain('devhub-no-return');
      expect(done.text).not.toContain('javascript:');

      const token = await ppToken();
      const o = await call('POST', '/pay/shop/paypal/v2/checkout/orders', { json: { intent: 'CAPTURE', purchase_units: [{ reference_id: 'h2', amount: { currency_code: 'USD', value: '2.00' } }], payment_source: { paypal: { experience_context: { return_url: `${appUrl}/r`, cancel_url: `${appUrl}/c` } } } }, headers: { authorization: `Bearer ${token}` } });
      expect(o.status, o.text).toBe(201);
      const pid = await payId(o.body.id);
      hub.payments.repo.update(pid, { returnUrl: 'relative/return', cancelUrl: 'also bad' });
      const r = await api('POST', `${PJ}/payments/${pid}/complete`, { outcome: 'success' });
      expect(r.status, r.text).toBe(200);
      expect(r.body.redirectUrl).toBeNull();
      const page = await call('GET', `/pay/shop/paypal/page/${pid}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain('devhub-no-return');

      const t = await ptReq({ cart_id: 'h-3' });
      const tid = await payId(t.body.tran_ref);
      hub.payments.repo.update(tid, { returnUrl: '::nope' });
      expect((await api('POST', `${PJ}/payments/${tid}/complete`, { outcome: 'success' })).status).toBe(200);
    });

    it('hosted pages send a strict CSP that allows only their own inline script', async () => {
      const cs = await stripeSession();
      const id = await payId(cs.id);
      const page = await call('GET', `/pay/shop/stripe/page/${id}`);
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      const script = /<script>([\s\S]*?)<\/script>/.exec(page.text)![1]!;
      const { createHash } = await import('node:crypto');
      expect(csp).toContain(`script-src 'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`);
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    });

    it('gateway credentials are redacted in the traffic log; card fields are masked in the log and the stored request', async () => {
      await stripeCreate({ 'payment_method_data[card][number]': '4111 1111 1111 1111', 'payment_method_data[card][cvc]': '987' });
      await ptReq({ cart_id: 'h-card', card_details: { pan: '5200828282828210', cvv: '321' } });
      await ppToken();
      const rows = hub.db.prepare("SELECT url, req_headers, req_body FROM traffic_logs WHERE url LIKE '/pay/%'").all() as { url: string; req_headers: string; req_body: string | null }[];
      const all = JSON.stringify(rows);
      expect(all).not.toContain(stripeKey);
      expect(all).not.toContain(ptKey);
      expect(all).not.toContain(Buffer.from(`${pp.clientId}:x`).toString('base64'));
      const stripeRow = rows.filter((r) => r.url.includes('/v1/checkout/sessions')).at(-1)!;
      expect(JSON.parse(stripeRow.req_headers).authorization).toMatch(/^Bearer sk_test_••••.{4}$/);
      expect(JSON.parse(stripeRow.req_headers).authorization.endsWith(stripeKey.slice(-4))).toBe(true);
      for (const secret of ['4111 1111 1111 1111', '4111+1111+1111+1111', '4111111111111111', '5200828282828210', '987', '321']) {
        expect(rows.map((r) => r.req_body ?? '').join('\n')).not.toContain(secret === '987' || secret === '321' ? `"${secret}"` : secret);
      }
      const ptRow = rows.filter((r) => r.url.includes('/payment/request')).at(-1)!;
      expect(JSON.parse(ptRow.req_body!).card_details).toEqual({ pan: '••••8210', cvv: '••••' });
      const stored = JSON.stringify(hub.db.prepare('SELECT request FROM payments').all());
      for (const pan of ['4111 1111 1111 1111', '5200828282828210']) expect(stored).not.toContain(pan);
      expect(stored).toContain('••••1111');
    });
  });

  describe('webhooks, runs, MCP, privacy', () => {
    it('scheduled delivery, flush, retry after a 500', async () => {
      await api('PATCH', `${PJ}/payment-instances/stripe`, { config: { webhookDelayMs: 60_000 } });
      const cs = await stripeSession();
      const before = hitsAt('/stripe').length;
      await api('POST', `${PJ}/payments/${cs.id}/complete`, { outcome: 'success' });
      expect(hitsAt('/stripe').length).toBe(before);
      const scheds = (await api('GET', `${PJ}/schedules?status=pending`)).body as any[];
      expect(scheds.some((s) => s.action === 'payment.webhook')).toBe(true);
      failNext = 1;
      await api('POST', `${PJ}/schedules/flush`, {});
      await waitFor(() => hitsAt('/stripe').length >= before + 2);
      const det = await waitFor(async () => {
        const d = (await api('GET', `${PJ}/payments/${cs.id}`)).body;
        return d.events.some((e: any) => e.type === 'webhook_failed') && d.events.some((e: any) => e.type === 'webhook_delivered') ? d : null;
      });
      expect(det.lint.map((l: any) => l.check)).toContain('pay.webhook-rejected');
      const queued = det.events.filter((e: any) => e.type === 'webhook_queued' && e.data.attempt === 2);
      expect(queued.length).toBe(1);
      await api('POST', `${PJ}/schedules/flush`, {});
      await waitFor(async () => (await api('GET', `${PJ}/payments/${cs.id}`)).body.events.filter((e: any) => e.type === 'webhook_delivered').length >= 2);
      const re = await api('POST', `${PJ}/payments/${cs.id}/webhooks/resend`, { event: 'checkout.session.completed' });
      expect(re.body).toMatchObject({ ok: true, status: 200, eventType: 'checkout.session.completed' });
      await api('PATCH', `${PJ}/payment-instances/stripe`, { config: { webhookDelayMs: 0 } });
    });

    it('run isolation: run rules, stop and purge', async () => {
      const run = (await api('POST', `${PJ}/runs`, { key: 'iso' })).body;
      await api('POST', `${PJ}/payment-rules`, { outcome: 'decline', run: run.key });
      const outside = await stripeSession();
      expect((await api('POST', `${PJ}/payments/${outside.id}/complete`, {})).body.outcome).toBe('success');
      const inside = await stripeSession({}, { 'x-hub-run': run.key });
      expect((await api('POST', `${PJ}/payments/${inside.id}/complete`, {})).body.via).toBe('run rule');
      const list = (await api('GET', `${PJ}/payments?run=${run.key}`)).body as any[];
      expect(list.map((p) => p.providerRef)).toEqual([inside.id]);
      await api('POST', `${PJ}/runs/${run.key}/stop`, {});
      expect(((await api('GET', `${PJ}/payment-rules?all=1`)).body as any[]).some((r) => r.run === run.key)).toBe(false);
      await api('DELETE', `${PJ}/runs/${run.key}`);
      expect((await api('GET', `${PJ}/payments/${inside.id}`)).status).toBe(404);
    });

    it('MCP tools', async () => {
      const cs = await stripeSession({ client_reference_id: 'mcp-1' });
      await mcp('set_payment_rule', { project: 'shop', outcome: 'decline:expired_card', instance: 'stripe', count: 1 });
      const done = await mcp('complete_payment', { project: 'shop', payment: cs.id });
      expect(done).toMatchObject({ outcome: 'decline:expired_card', via: 'instance rule', forced: true });
      expect(await mcp('reset_payment_rules', { project: 'shop' })).toHaveProperty('deleted');
      const ok = await mcp('complete_payment', { project: 'shop', payment: cs.id, outcome: 'success' });
      expect(ok.payment.status).toBe('paid');
      const waited = await mcp('wait_for_payment', { project: 'shop', reference: 'mcp-1', status: 'paid', timeout_seconds: 2 });
      expect(waited.timedOut).toBe(false);
      expect((await mcp('list_payments', { project: 'shop', reference: 'mcp-1' }))[0].status).toBe('paid');
      expect((await mcp('get_payment', { project: 'shop', payment: cs.id })).providerRef).toBe(cs.id);
      expect((await mcp('refund_payment', { project: 'shop', payment: cs.id })).payment.status).toBe('refunded');
      expect((await mcp('resend_payment_webhook', { project: 'shop', payment: cs.id, event: 'charge.refunded' })).ok).toBe(true);
      const lint = await mcp('payment_lint', { project: 'shop' });
      expect(lint.counts.error).toBeGreaterThan(0);
    });

    it('no card number is stored anywhere; reset clears payments', async () => {
      const cs = await stripeSession();
      await api('POST', `${PJ}/payments/${cs.id}/complete`, { card: '4000000000000069' });
      const dump = JSON.stringify([hub.db.prepare('SELECT * FROM payments').all(), hub.db.prepare('SELECT * FROM payment_events').all()]);
      for (const pan of ['4000000000000069', '4242424242424242', '4000002500003155', '4532015112830366']) expect(dump).not.toContain(pan);
      // traffic: page posts carry only brand / last 4 (the public test numbers appear only in the page HTML chips)
      const posts = JSON.stringify(hub.db.prepare("SELECT req_body FROM traffic_logs WHERE url LIKE '/pay/%/complete'").all());
      expect(posts).toContain('card_last4');
      for (const pan of ['4000002500003155', '4242424242424242', '4532015112830366']) expect(posts).not.toContain(pan);
      expect(JSON.stringify(hub.db.prepare('SELECT * FROM traffic_logs').all())).not.toContain('4532015112830366');
      expect((await api('GET', `${PJ}/payments/${cs.id}`)).body).toMatchObject({ status: 'failed', providerStatus: 'open / unpaid', cardLast4: '0069' });
      await api('POST', `${PJ}/reset`, {});
      expect(((await api('GET', `${PJ}/payments`)).body as any[]).length).toBe(0);
      expect(((await api('GET', `${PJ}/payment-instances`)).body as any[]).length).toBe(3);
    });
  });
});
