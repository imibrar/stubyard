import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';

/** Payments P4a: Stripe PaymentIntents, Embedded Checkout sessions, the fake Stripe.js frames, 3DS pages and the demo. */

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
const hooks: { type: string; id: string; object: any }[] = [];
const PJ = '/api/projects/p4a';
let slug = '';
let cfg: Record<string, any> = {};
const CH = 'chtest123456';

async function call<T = any>(method: string, p: string, opts: { json?: unknown; form?: Record<string, string | number>; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(Object.entries(opts.form).map(([k, v]) => [k, String(v)])).toString();
  }
  const r = await fetch(base + p, { method, headers, body, redirect: 'manual' });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: r.status, body: parsed as T, text, headers: r.headers };
}
const api = <T = any>(method: string, p: string, json?: unknown) => call<T>(method, p, json === undefined ? {} : { json });
const I = () => '/pay/p4a/' + slug;
/** The Stripe API with the secret key (form-encoded like stripe-node). */
const sk = (method: string, p: string, form?: Record<string, string | number>, headers: Record<string, string> = {}) => call(method, I() + p, { form, headers: { authorization: 'Bearer ' + cfg.secretKey, ...headers } });
const pi = (extra: Record<string, string | number> = {}) => sk('POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', 'metadata[order_id]': 'o-1', ...extra }, { 'idempotency-key': 'k-' + Math.random() });
const inst = () => hub.payments!.repo.requireInstance(hub.projects.require('p4a').id, slug);
const pay = (ref: string) => hub.payments!.repo.byInstanceRef(inst().id, ref)!;
const instLint = () => ((hub.payments as any).instanceLint.get(inst().id) ?? []) as { check: string }[];
const setConfig = async (config: Record<string, unknown>) => {
  const r = await api('PATCH', PJ + '/payment-instances/' + slug, { config });
  expect(r.status, r.text).toBe(200);
};
async function hooksFor(id: string, n: number): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    const got = hooks.filter((h) => h.object?.id === id || h.object?.payment_intent === id).map((h) => h.type);
    if (got.length >= n) return got;
    await new Promise((r) => setTimeout(r, 25));
  }
  return hooks.filter((h) => h.object?.id === id || h.object?.payment_intent === id).map((h) => h.type);
}
function expectCsp(html: string, csp: string) {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(csp).toContain("'sha256-" + createHash('sha256').update(m[1]!, 'utf8').digest('base64') + "'");
}
function expectNoWildcardPost(text: string) {
  expect(text).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]\)/);
  expect(text).not.toContain('document.referrer');
}
const facts = (magicId: string | null, last4 = '4242', extra: Record<string, unknown> = {}) => ({ brand: 'visa', last4, magicId, luhn: true, test: true, ...extra });
const frameCall = (p: string, json: Record<string, unknown>) => call('POST', I() + '/stripe-js/' + p, { json: { key: cfg.publishableKey, ...json } });

describe('checkout P4a: Stripe PaymentIntents, Embedded Checkout, Stripe.js', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-p4a-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await app.close();
      hub.db.close();
    };
    base = 'http://127.0.0.1:' + httpPort;
    appServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        try {
          const ev = JSON.parse(raw);
          hooks.push({ type: ev.type, id: ev.id, object: ev.data?.object });
        } catch {
          /* not json */
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = 'http://127.0.0.1:' + (appServer.address() as net.AddressInfo).port;
    expect((await api('POST', '/api/projects', { name: 'P4a Shop', slug: 'p4a' })).status).toBe(201);
    const r = await api('POST', PJ + '/payment-instances', { preset: 'stripe-checkout', config: { webhookDelayMs: 0, webhookUrl: appUrl + '/hook' } });
    expect(r.status, r.text).toBe(201);
    slug = r.body.slug;
    cfg = inst().config as Record<string, any>;
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('PaymentIntents API (secret key)', () => {
    it('creates an intent: requires_payment_method, client_secret, payment_intent.created; validates params', async () => {
      const r = await pi();
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ object: 'payment_intent', amount: 2000, currency: 'usd', status: 'requires_payment_method', capture_method: 'automatic_async', next_action: null, metadata: { order_id: 'o-1' }, livemode: false });
      expect(r.body.id).toMatch(/^pi_3/);
      expect(r.body.client_secret).toMatch(new RegExp('^' + r.body.id + '_secret_[A-Za-z0-9]+$'));
      expect(await hooksFor(r.body.id, 1)).toContain('payment_intent.created');
      const g = await sk('GET', '/v1/payment_intents/' + r.body.id);
      expect(g.body.id).toBe(r.body.id);
      const list = await sk('GET', '/v1/payment_intents?limit=100');
      expect(list.body.object).toBe('list');
      expect(list.body.data.some((x: any) => x.id === r.body.id)).toBe(true);
      expect((await sk('POST', '/v1/payment_intents', { currency: 'usd' })).body.error.param).toBe('amount');
      expect((await sk('POST', '/v1/payment_intents', { amount: 0, currency: 'usd' })).body.error.code).toBe('amount_too_small');
      expect((await sk('POST', '/v1/payment_intents', { amount: 100, currency: 'zzz' })).body.error.param).toBe('currency');
      expect((await sk('POST', '/v1/payment_intents', { amount: 100, currency: 'usd', capture_method: 'later' })).body.error.param).toBe('capture_method');
      expect((await sk('GET', '/v1/payment_intents/pi_nope')).status).toBe(404);
      const noKey = await sk('POST', '/v1/payment_intents', { amount: 100, currency: 'usd' });
      expect(pay(noKey.body.id).lint.map((l: any) => l.check)).toEqual(expect.arrayContaining(['pay.no-idempotency-key', 'pay.no-reference']));
    });

    it('confirm with pm_card_visa: succeeded, charge, webhooks charge.succeeded + payment_intent.succeeded', async () => {
      const c = await pi();
      const r = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', { payment_method: 'pm_card_visa' });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ status: 'succeeded', amount_received: 2000, payment_method: 'pm_card_visa' });
      expect(r.body.latest_charge).toMatch(/^ch_/);
      const types = await hooksFor(c.body.id, 3);
      expect(types).toEqual(expect.arrayContaining(['payment_intent.created', 'charge.succeeded', 'payment_intent.succeeded']));
      expect(pay(c.body.id).status).toBe('paid');
      const again = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', { payment_method: 'pm_card_visa' });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('payment_intent_unexpected_state');
      const pmo = await sk('GET', '/v1/payment_methods/pm_card_visa');
      expect(pmo.body).toMatchObject({ object: 'payment_method', type: 'card', card: { brand: 'visa', last4: '4242' } });
    });

    it('create with confirm=true; a decline is 402 card_error and the intent can be retried', async () => {
      const r = await pi({ confirm: 'true', payment_method: 'pm_card_chargeDeclinedInsufficientFunds' });
      expect(r.status, r.text).toBe(402);
      expect(r.body.error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' });
      expect(r.body.error.payment_intent.status).toBe('requires_payment_method');
      expect(r.body.error.payment_intent.last_payment_error.decline_code).toBe('insufficient_funds');
      const id = r.body.error.payment_intent.id;
      expect(await hooksFor(id, 2)).toContain('payment_intent.payment_failed');
      const ok = await sk('POST', '/v1/payment_intents/' + id + '/confirm', { payment_method: 'pm_card_mastercard' });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.status).toBe('succeeded');
      expect(ok.body.last_payment_error).toBeNull();
    });

    it('3-D Secure from the server with return_url: redirect_to_url page, then the redirect with redirect_status', async () => {
      const c = await pi();
      const r = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', { payment_method: 'pm_card_threeDSecure2Required', return_url: appUrl + '/return?x=1' });
      expect(r.status, r.text).toBe(200);
      expect(r.body.status).toBe('requires_action');
      expect(r.body.next_action.type).toBe('redirect_to_url');
      expect(r.body.next_action.redirect_to_url.return_url).toBe(appUrl + '/return?x=1');
      expect(await hooksFor(c.body.id, 2)).toContain('payment_intent.requires_action');
      const url = new URL(r.body.next_action.redirect_to_url.url);
      expect(url.searchParams.get('mode')).toBe('redirect');
      const page = await call('GET', url.pathname + url.search);
      expect(page.status, page.text).toBe(200);
      for (const s of ['data-testid="stubyard-3ds-complete"', 'data-testid="stubyard-3ds-fail"', 'data-testid="stubyard-test-banner"', '20.00 USD']) expect(page.text, s).toContain(s);
      expectCsp(page.text, page.headers.get('content-security-policy') ?? '');
      const done = await call('POST', url.pathname + url.search, { form: { answer: 'complete' } });
      expect(done.status, done.text).toBe(303);
      const loc = new URL(done.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe(appUrl + '/return');
      expect(loc.searchParams.get('x')).toBe('1');
      expect(loc.searchParams.get('payment_intent')).toBe(c.body.id);
      expect(loc.searchParams.get('payment_intent_client_secret')).toBe(c.body.client_secret);
      expect(loc.searchParams.get('redirect_status')).toBe('succeeded');
      expect((await sk('GET', '/v1/payment_intents/' + c.body.id)).body.status).toBe('succeeded');
      const twice = await call('POST', url.pathname + url.search, { form: { answer: 'complete' } });
      expect(twice.status).toBe(409);
    });

    it('3-D Secure without return_url: use_stripe_sdk; failing it is a decline (requires_payment_method)', async () => {
      const c = await pi();
      const r = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', { payment_method: 'pm_card_authenticationRequired' });
      expect(r.body.status).toBe('requires_action');
      expect(r.body.next_action.type).toBe('use_stripe_sdk');
      const url = new URL(r.body.next_action.use_stripe_sdk.stripe_js);
      const noOrigin = await call('GET', url.pathname + url.search);
      expect(noOrigin.status).toBe(400);
      const q = url.search + '&' + new URLSearchParams({ ch: CH, origin: appUrl, lang: 'ar' }).toString();
      const modal = await call('GET', url.pathname + q);
      expect(modal.status, modal.text).toBe(200);
      expect(modal.text).toContain('dir="rtl"');
      expect(modal.text).toContain(JSON.stringify(appUrl));
      expectNoWildcardPost(modal.text);
      const failed = await call('POST', url.pathname + q, { form: { answer: 'fail' } });
      expect(failed.status, failed.text).toBe(200);
      expect(failed.text).toContain("SYB.post({type:'3ds-done'})");
      const after = (await sk('GET', '/v1/payment_intents/' + c.body.id)).body;
      expect(after.status).toBe('requires_payment_method');
      expect(after.last_payment_error).toBeTruthy();
      expect(after.next_action).toBeNull();
    });

    it('capture_method=manual: requires_capture, amount_capturable, then capture (partial) → succeeded', async () => {
      const c = await pi({ capture_method: 'manual' });
      const r = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', { payment_method: 'pm_card_visa' });
      expect(r.body).toMatchObject({ status: 'requires_capture', amount_capturable: 2000, amount_received: 0, capture_method: 'manual' });
      expect(await hooksFor(c.body.id, 3)).toContain('payment_intent.amount_capturable_updated');
      const tooMuch = await sk('POST', '/v1/payment_intents/' + c.body.id + '/capture', { amount_to_capture: 5000 });
      expect(tooMuch.status).toBe(400);
      const cap = await sk('POST', '/v1/payment_intents/' + c.body.id + '/capture', { amount_to_capture: 1500 }, { 'idempotency-key': 'cap-1' });
      expect(cap.status, cap.text).toBe(200);
      expect(cap.body).toMatchObject({ status: 'succeeded', amount_received: 1500, amount_capturable: 0 });
      expect(await hooksFor(c.body.id, 5)).toContain('payment_intent.succeeded');
      expect((await sk('POST', '/v1/payment_intents/' + c.body.id + '/capture', {})).status).toBe(400);
    });

    it('cancel: an open intent and a requires_capture one; a finished one is refused', async () => {
      const c = await pi();
      const r = await sk('POST', '/v1/payment_intents/' + c.body.id + '/cancel', { cancellation_reason: 'requested_by_customer' });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ status: 'canceled', cancellation_reason: 'requested_by_customer' });
      expect(typeof r.body.canceled_at).toBe('number');
      expect(await hooksFor(c.body.id, 2)).toContain('payment_intent.canceled');
      expect((await sk('POST', '/v1/payment_intents/' + c.body.id + '/cancel', {})).body.error.code).toBe('payment_intent_unexpected_state');
      const m = await pi({ capture_method: 'manual' });
      await sk('POST', '/v1/payment_intents/' + m.body.id + '/confirm', { payment_method: 'pm_card_visa' });
      const v = await sk('POST', '/v1/payment_intents/' + m.body.id + '/cancel', {});
      expect(v.body.status).toBe('canceled');
      expect(pay(m.body.id).status).toBe('cancelled');
    });

    it('update while open; raw card numbers are refused (lint pay.stripe-raw-card-data)', async () => {
      const c = await pi();
      const u = await sk('POST', '/v1/payment_intents/' + c.body.id, { amount: 3100, 'metadata[note]': 'x', description: 'Order 9' });
      expect(u.body).toMatchObject({ amount: 3100, description: 'Order 9', metadata: { order_id: 'o-1', note: 'x' } });
      const raw = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', { 'payment_method_data[type]': 'card', 'payment_method_data[card][number]': '4242424242424242' });
      expect(raw.status).toBe(400);
      expect(raw.body.error.message).toContain('Sending credit card numbers directly');
      expect(pay(c.body.id).lint.map((l: any) => l.check)).toContain('pay.stripe-raw-card-data');
      const none = await sk('POST', '/v1/payment_intents/' + c.body.id + '/confirm', {});
      expect(none.body.error.code).toBe('payment_intent_unexpected_state');
    });
  });

  describe('publishable key (Stripe.js calls)', () => {
    it('retrieve and confirm by client_secret; CORS for allowed origins only; secret / live keys refused', async () => {
      const c = await pi();
      const q = (extra: Record<string, string> = {}) => '?' + new URLSearchParams({ key: cfg.publishableKey, client_secret: c.body.client_secret, ...extra }).toString();
      const g = await call('GET', I() + '/v1/payment_intents/' + c.body.id + q(), { headers: { origin: appUrl } });
      expect(g.status, g.text).toBe(200);
      expect(g.body.status).toBe('requires_payment_method');
      expect(g.body.metadata).toBeUndefined();
      expect(g.headers.get('access-control-allow-origin')).toBe(appUrl);
      const bad = await call('GET', I() + '/v1/payment_intents/' + c.body.id + '?' + new URLSearchParams({ key: cfg.publishableKey, client_secret: c.body.id + '_secret_wrong' }).toString());
      expect(bad.status).toBe(400);
      expect((await call('GET', I() + '/v1/payment_intents/' + c.body.id + q({ key: cfg.secretKey }))).status).toBe(401);
      expect((await call('GET', I() + '/v1/payment_intents/' + c.body.id + q({ key: 'pk_live_abc' }))).status).toBe(401);
      expect((await call('GET', I() + '/v1/checkout/sessions' + q())).status).toBe(401);
      const conf = await call('POST', I() + '/v1/payment_intents/' + c.body.id + '/confirm', { form: { key: cfg.publishableKey, client_secret: c.body.client_secret, payment_method: 'pm_card_visa' }, headers: { origin: appUrl } });
      expect(conf.status, conf.text).toBe(200);
      expect(conf.body.status).toBe('succeeded');
      const pre = await call('OPTIONS', I() + '/v1/payment_intents/' + c.body.id, { headers: { origin: appUrl, 'access-control-request-method': 'GET' } });
      expect(pre.status).toBe(204);
      await setConfig({ sdkOrigins: ['http://shop.example'] });
      const refused = await call('GET', I() + '/v1/payment_intents/' + c.body.id + q(), { headers: { origin: appUrl } });
      expect(refused.status).toBe(403);
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
      await setConfig({ sdkOrigins: null });
    });
  });

  describe('Stripe.js script and element frames', () => {
    it('serves the script at the js.stripe.com paths', async () => {
      for (const p of ['/js.stripe.com/v3/', '/js.stripe.com/v3', '/js.stripe.com/v3/stripe.js', '/js.stripe.com/basil/stripe.js']) {
        const r = await call('GET', I() + p);
        expect(r.status, p).toBe(200);
        expect(r.headers.get('content-type')).toContain('javascript');
        expect(r.text).toContain('window.Stripe = Stripe');
        expectNoWildcardPost(r.text);
      }
      expect((await call('GET', I() + '/js.stripe.com/v2/')).status).toBe(404);
    });

    it('frames: TEST strip inside payment / address, badge-only card / email; origin and channel checked', async () => {
      const f = (type: string, q: Record<string, string> = {}) => call('GET', I() + '/stripe-js/elements/' + type + '?' + new URLSearchParams({ ch: CH, origin: appUrl, lang: 'en', amount: '2000', currency: 'usd', ...q }).toString());
      const p = await f('payment');
      expect(p.status, p.text).toBe(200);
      for (const s of ['data-testid="stubyard-test-banner"', 'data-testid="stubyard-card"', '20.00 USD', JSON.stringify(appUrl)]) expect(p.text, s).toContain(s);
      expectCsp(p.text, p.headers.get('content-security-policy') ?? '');
      expectNoWildcardPost(p.text);
      const card = await f('card');
      expect(card.text).toContain('data-testid="stubyard-card"');
      expect(card.text).not.toContain('data-testid="stubyard-test-banner"');
      expect((await f('address')).text).toContain('data-testid="stubyard-stripe-line1"');
      expect((await f('linkAuthentication')).text).toContain('data-testid="stubyard-stripe-email"');
      expect((await f('payment', { lang: 'ar' })).text).toContain('dir="rtl"');
      expect((await f('cardNumber')).status).toBe(404);
      expect((await f('payment', { origin: '' })).status).toBe(400);
      expect((await f('payment', { ch: 'x' })).status).toBe(400);
      await setConfig({ sdkOrigins: ['http://shop.example'] });
      expect((await f('payment')).status).toBe(403);
      expect(instLint().map((l) => l.check)).toContain('pay.sdk-origin-refused');
      await setConfig({ sdkOrigins: null });
    });

    it('frame confirm: card facts only; success, decline 402, 3DS modal then success; a real card is refused', async () => {
      const a = await pi();
      const ok = await frameCall('confirm', { client_secret: a.body.client_secret, card: facts('success'), return_url: appUrl + '/r' });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.paymentIntent).toMatchObject({ id: a.body.id, status: 'succeeded' });
      expect(ok.body.paymentIntent.payment_method).toMatch(/^pm_1/);
      expect(pay(a.body.id)).toMatchObject({ cardBrand: 'visa', cardLast4: '4242' });
      const b = await pi();
      const dec = await frameCall('confirm', { client_secret: b.body.client_secret, card: facts('decline', '0002') });
      expect(dec.status).toBe(402);
      expect(dec.body.error.type).toBe('card_error');
      expect(dec.body.error.payment_intent.metadata).toBeUndefined();
      const c = await pi();
      const tds = await frameCall('confirm', { client_secret: c.body.client_secret, card: facts('3ds', '3220'), return_url: appUrl + '/r' });
      expect(tds.body.paymentIntent.status).toBe('requires_action');
      expect(tds.body.paymentIntent.next_action.type).toBe('use_stripe_sdk');
      const u = new URL(tds.body.paymentIntent.next_action.use_stripe_sdk.stripe_js);
      const q = u.search + '&' + new URLSearchParams({ ch: CH, origin: appUrl, mode: 'modal' }).toString();
      expect((await call('GET', u.pathname + q)).text).toContain('VISA •••• 3220');
      const done = await call('POST', u.pathname + q, { form: { answer: 'complete' } });
      expect(done.status).toBe(200);
      expect((await sk('GET', '/v1/payment_intents/' + c.body.id)).body.status).toBe('succeeded');
      const d = await pi();
      const real = await frameCall('confirm', { client_secret: d.body.client_secret, card: facts(null, '1111', { test: false }) });
      expect(real.status).toBe(402);
      expect(real.body.error.decline_code).toBe('live_mode_test_card');
      expect((await frameCall('confirm', { client_secret: d.body.client_secret, card: { brand: 'visa' } })).body.error.code).toBe('incomplete_number');
      expect((await frameCall('confirm', { client_secret: d.body.client_secret, card: facts('success'), key: 'pk_live_x' })).status).toBe(401);
    });

    it('createPaymentMethod / createToken: the server confirms with the returned id', async () => {
      const pm = await frameCall('payment_methods', { card: facts('success'), billing_details: { name: 'Jane' } });
      expect(pm.status, pm.text).toBe(200);
      expect(pm.body.paymentMethod).toMatchObject({ object: 'payment_method', card: { last4: '4242' }, billing_details: { name: 'Jane' } });
      const g = await sk('GET', '/v1/payment_methods/' + pm.body.paymentMethod.id);
      expect(g.body.card.last4).toBe('4242');
      const a = await pi();
      const c = await sk('POST', '/v1/payment_intents/' + a.body.id + '/confirm', { payment_method: pm.body.paymentMethod.id });
      expect(c.body.status).toBe('succeeded');
      const tok = await frameCall('tokens', { card: facts('decline', '0002') });
      expect(tok.body.token.id).toMatch(/^tok_1/);
      const b = await pi();
      expect((await sk('POST', '/v1/payment_intents/' + b.body.id + '/confirm', { payment_method: tok.body.token.id })).status).toBe(402);
    });
  });

  describe('Embedded Checkout sessions', () => {
    const embedded = (extra: Record<string, string | number> = {}) =>
      sk('POST', '/v1/checkout/sessions', { mode: 'payment', ui_mode: 'embedded_page', return_url: appUrl + '/ret?session_id={CHECKOUT_SESSION_ID}', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 1500, 'line_items[0][price_data][product_data][name]': 'Mug', 'line_items[0][quantity]': 1, client_reference_id: 'o-2', ...extra }, { 'idempotency-key': 'e-' + Math.random() });

    it('creates an embedded session: client_secret, no url; success_url / missing return_url refused', async () => {
      const s = await embedded();
      expect(s.status, s.text).toBe(200);
      expect(s.body).toMatchObject({ ui_mode: 'embedded_page', url: null, success_url: null, redirect_on_completion: 'always', return_url: appUrl + '/ret?session_id={CHECKOUT_SESSION_ID}' });
      expect(s.body.client_secret).toMatch(new RegExp('^' + s.body.id + '_secret_'));
      expect((await embedded({ success_url: appUrl + '/ok' })).status).toBe(400);
      const noRet = await sk('POST', '/v1/checkout/sessions', { mode: 'payment', ui_mode: 'embedded', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 100, 'line_items[0][price_data][product_data][name]': 'X', 'line_items[0][quantity]': 1 });
      expect(noRet.status).toBe(400);
      expect((await embedded({ redirect_on_completion: 'never' })).status).toBe(400);
      expect((await embedded({ redirect_on_completion: 'sometimes' })).status).toBe(400);
      const hosted = await sk('POST', '/v1/checkout/sessions', { mode: 'payment', success_url: appUrl + '/ok', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 100, 'line_items[0][price_data][product_data][name]': 'X', 'line_items[0][quantity]': 1 });
      expect(hosted.body.url).toMatch(/\/c\/pay\//);
      expect(hosted.body.client_secret ?? null).toBeNull();
    });

    it('the frame entry checks secret and origin; paying posts complete with the return_url redirect', async () => {
      const s = await embedded();
      const entry = (q: Record<string, string>) => call('GET', I() + '/c/pay/' + s.body.id + '?' + new URLSearchParams({ client_secret: s.body.client_secret, stubyard_sdk: CH, stubyard_origin: appUrl, stubyard_mode: 'embedded', ...q }).toString());
      expect((await entry({ client_secret: s.body.id + '_secret_nope' })).status).toBe(403);
      const o = await entry({});
      expect(o.status, o.text).toBe(302);
      const p = pay(s.body.id);
      expect(p.providerData.sdkBridge).toMatchObject({ ch: CH, origin: appUrl, mode: 'embedded' });
      const page = await call('GET', I() + '/page/' + p.id);
      expect(page.status).toBe(200);
      expect(page.text).toContain('data-layout="stripe-hosted"');
      expect(page.text).toContain("SYB.post({type:'ready'})");
      expectCsp(page.text, page.headers.get('content-security-policy') ?? '');
      const done = await call('POST', I() + '/page/' + p.id + '/x/pay', { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1', cname: 'Jane Jones' } });
      expect(done.status, done.text).toBe(200);
      expect(done.text).toContain("type:'complete'");
      expect(done.text).toContain(JSON.stringify(appUrl + '/ret?session_id=' + s.body.id));
      expectNoWildcardPost(done.text);
      expectCsp(done.text, done.headers.get('content-security-policy') ?? '');
      const got = await sk('GET', '/v1/checkout/sessions/' + s.body.id);
      expect(got.body.status).toBe('complete');
    });

    it('redirect_on_completion if_required: onComplete (no redirect); a hosted session refuses the SDK entry', async () => {
      const s = await embedded({ redirect_on_completion: 'if_required' });
      await call('GET', I() + '/c/pay/' + s.body.id + '?' + new URLSearchParams({ client_secret: s.body.client_secret, stubyard_sdk: CH, stubyard_origin: appUrl }).toString());
      const p = pay(s.body.id);
      await call('GET', I() + '/page/' + p.id);
      const done = await call('POST', I() + '/page/' + p.id + '/x/pay', { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1', cname: 'Jane Jones' } });
      expect(done.status, done.text).toBe(200);
      expect(done.text).toContain("type:'complete'");
      expect(done.text).toContain('redirect:null');
      const hosted = await sk('POST', '/v1/checkout/sessions', { mode: 'payment', success_url: appUrl + '/ok', 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 100, 'line_items[0][price_data][product_data][name]': 'X', 'line_items[0][quantity]': 1 });
      const r = await call('GET', I() + '/c/pay/' + hosted.body.id + '?' + new URLSearchParams({ client_secret: 'x', stubyard_sdk: CH, stubyard_origin: appUrl }).toString());
      expect(r.status).toBe(400);
    });
  });

  describe('demo shop and connect', () => {
    it('demo pages for every mode, /demo/intent and the result page', async () => {
      for (const mode of ['payment', 'card', 'deferred', 'embedded']) {
        const d = await call('GET', I() + '/demo?mode=' + mode);
        expect(d.status, mode + ' ' + d.text).toBe(200);
        for (const t of ['/js.stripe.com/v3/', 'Stripe(C.pk', 'data-testid="stubyard-test-banner"', 'data-testid="stubyard-demo-log"']) expect(d.text, mode + ' ' + t).toContain(t);
        expectCsp(d.text, d.headers.get('content-security-policy') ?? '');
      }
      expect((await call('GET', I() + '/demo?lang=ar')).text).toContain('dir="rtl"');
      const it2 = await call('POST', I() + '/demo/intent');
      expect(it2.body.clientSecret).toMatch(/^pi_.+_secret_/);
      const id = it2.body.clientSecret.split('_secret_')[0];
      const res = await call('GET', I() + '/demo/result?payment_intent=' + id);
      expect(res.text).toContain('requires_payment_method');
    });

    it('connect lists the publishable key and the Stripe.js URL', async () => {
      const r = await api('GET', PJ + '/payment-instances/' + slug);
      expect(r.status, r.text).toBe(200);
      expect(r.body.connect.env.STRIPE_PUBLISHABLE_KEY).toBe(cfg.publishableKey);
      expect(r.body.connect.env.STRIPE_JS_URL).toMatch(/\/js\.stripe\.com\/v3\/$/);
      expect(JSON.stringify(r.body.connect.notes)).toContain('loadStripe');
    });
  });
});
