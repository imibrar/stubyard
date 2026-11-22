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
import { geideaSessionSignature } from '../src/payments/geidea/index.js';
import { TEST_NOTICE } from '../src/payments/kit/i18n.js';

/** Payments P2: Moyasar Form, GeideaCheckout, PayPal Buttons / Card Fields / Pay Later, the wallet sheet, demos, origins. */

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
const PJ = '/api/projects/p2';
const slug: Record<string, string> = {};
const cfg: Record<string, Record<string, any>> = {};

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
const I = (preset: string) => `/pay/p2/${slug[preset]}`;
const det = async (ref: string) => (await api('GET', `${PJ}/payments/${ref}`)).body;
const repoPay = (preset: string, ref: string) => {
  const project = hub.projects.require('p2');
  const inst = hub.payments!.repo.requireInstance(project.id, slug[preset]!);
  return hub.payments!.repo.byInstanceRef(inst.id, ref)!;
};
const setConfig = async (preset: string, config: Record<string, unknown>) => {
  const r = await api('PATCH', `${PJ}/payment-instances/${slug[preset]}`, { config });
  expect(r.status, r.text).toBe(200);
  return r;
};
const instLint = async (preset: string) => {
  const project = hub.projects.require('p2');
  const inst = hub.payments!.repo.requireInstance(project.id, slug[preset]!);
  return ((hub.payments as any).instanceLint.get(inst.id) ?? []) as { check: string }[];
};

function expectCsp(html: string, csp: string) {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(csp).toContain(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`);
}
/** No message to "*" and no document.referrer anywhere in a served page or script. */
function expectNoWildcardPost(text: string) {
  expect(text).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]\)/);
  expect(text).not.toContain('document.referrer');
}
const CH = 'chtest123456';

describe('checkout P2: popup and drop-in SDKs', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-p2-'));
    const httpPort = await freePort();
    const config = loadConfig({ host: '127.0.0.1', httpPort, dataDir, webDir: path.join(dataDir, 'no-web'), logLevel: 'silent', maintenanceIntervalMs: 0 });
    hub = createHub(config, { mailpit: null, tls: false, dbFile: ':memory:', logger: pino({ level: 'silent' }) });
    const { app } = await buildApp(hub, pino({ level: 'silent' }));
    await app.listen({ port: httpPort, host: '127.0.0.1' });
    close = async () => {
      await app.close();
      hub.db.close();
    };
    base = `http://127.0.0.1:${httpPort}`;
    appServer = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'P2 Shop', slug: 'p2' })).status).toBe(201);
    for (const preset of ['moyasar', 'geidea', 'paypal']) {
      const r = await api('POST', `${PJ}/payment-instances `.trim(), { preset, config: { webhookDelayMs: 0 } });
      expect(r.status, r.text).toBe(201);
      slug[preset] = r.body.slug;
      const project = hub.projects.require('p2');
      cfg[preset] = hub.payments!.repo.requireInstance(project.id, r.body.slug).config as Record<string, any>;
    }
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('Moyasar Form', () => {
    const form = (q: Record<string, string> = {}) => `${I('moyasar')}/mpf/form?` + new URLSearchParams({ ch: CH, origin: appUrl, lang: 'en', key: cfg.moyasar!.publishableKey, amount: '1000', currency: 'SAR', methods: 'creditcard,stcpay,applepay', networks: 'visa,mastercard,mada', ...q }).toString();
    const pay = (source: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      call('POST', `${I('moyasar')}/mpf/payments`, { json: { publishable_api_key: cfg.moyasar!.publishableKey, amount: 1000, currency: 'SAR', description: 'Order 1', callback_url: `${appUrl}/cb`, source, ...extra } });
    const facts = (magicId: string, last4: string) => ({ brand: 'visa', last4, magicId, luhn: true, test: true });

    it('serves moyasar.js / moyasar.css with the real global and the frame URL', async () => {
      const j = await call('GET', `${I('moyasar')}/mpf/moyasar.js`);
      expect(j.status).toBe(200);
      expect(j.headers.get('content-type')).toContain('javascript');
      for (const s of ['window.Moyasar = { init: init', '/mpf/form?', 'on_initiating', 'on_completed', 'on_failure', 'on_redirect', TEST_NOTICE.en]) expect(j.text, s).toContain(s);
      expectNoWildcardPost(j.text);
      expect((await call('GET', `${I('moyasar')}/mpf/moyasar.min.js`)).status).toBe(200);
      const css = await call('GET', `${I('moyasar')}/mpf/moyasar.css`);
      expect(css.headers.get('content-type')).toContain('text/css');
    });

    it('the form frame: TEST notice, methods, posts only to the page origin, EN and AR', async () => {
      const f = await call('GET', form());
      expect(f.status, f.text).toBe(200);
      for (const s of ['data-testid="stubyard-test-banner"', 'data-testid="stubyard-moyasar-form"', 'data-testid="stubyard-method-stcpay"', 'data-testid="stubyard-applepay"', 'data-testid="stubyard-cardholder"', JSON.stringify(appUrl)]) expect(f.text, s).toContain(s);
      expect(f.text).not.toContain(cfg.moyasar!.secretKey);
      expectCsp(f.text, f.headers.get('content-security-policy') ?? '');
      expectNoWildcardPost(f.text);
      const ar = await call('GET', form({ lang: 'ar' }));
      expect(ar.text).toContain('lang="ar"');
      expect(ar.text).toContain('dir="rtl"');
      expect(ar.text).toContain(TEST_NOTICE.ar);
    });

    it('refuses a frame without origin (400) and an origin outside sdkOrigins (403, lint)', async () => {
      expect((await call('GET', form({ origin: '' }))).status).toBe(400);
      expect((await call('GET', form({ ch: 'x' }))).status).toBe(400);
      await setConfig('moyasar', { sdkOrigins: 'http://shop.example' });
      const bad = await call('GET', form());
      expect(bad.status).toBe(403);
      expect(bad.text).toContain('data-testid="stubyard-sdk-error"');
      expect((await instLint('moyasar')).map((l: any) => l.check)).toContain('pay.sdk-origin-refused');
      await setConfig('moyasar', { sdkOrigins: [appUrl, 'http://shop.example'] });
      expect((await call('GET', form())).status).toBe(200);
      const wrong = await api('PATCH', `${PJ}/payment-instances/${slug.moyasar}`, { config: { sdkOrigins: 'not an origin' } });
      expect(wrong.status).toBe(400);
      await setConfig('moyasar', { sdkOrigins: null });
    });

    it('card: created with the publishable key from card facts only; 3-D Secure redirect, then callback', async () => {
      const r = await pay({ type: 'creditcard', name: 'Jane Jones', month: '12', year: '2030', card: facts('3ds', '3155'), number: '4000002500003155' });
      expect(r.status, r.text).toBe(201);
      expect(r.body.status).toBe('initiated');
      expect(r.body.source.transaction_url).toBeTruthy();
      const p = repoPay('moyasar', r.body.id);
      expect(JSON.stringify(p.request)).not.toContain('4000002500003155');
      expect(JSON.stringify(p.request)).not.toContain('magicId');
      expect((p.providerData.apiCard as any).last4).toBe('3155');
      const ok = await pay({ type: 'creditcard', name: 'Jane Jones', month: '12', year: '2030', card: facts('success', '4242') });
      expect(ok.status, ok.text).toBe(201);
      expect(['initiated', 'paid']).toContain(ok.body.status);
    });

    it('card: refuses a non-test card, a bad name, a wrong key', async () => {
      const real = await pay({ type: 'creditcard', name: 'Jane Jones', month: '12', year: '2030', card: { brand: 'visa', last4: '1234', luhn: true, test: false } });
      expect(real.status).toBeGreaterThanOrEqual(400);
      const name = await pay({ type: 'creditcard', name: '', month: '12', year: '2030', card: facts('success', '4242') });
      expect(name.status).toBe(400);
      expect(name.body.type).toBe('invalid_request_error');
      const key = await call('POST', `${I('moyasar')}/mpf/payments`, { json: { publishable_api_key: 'pk_live_abcdefghijkl', amount: 1000, currency: 'SAR', callback_url: appUrl, source: { type: 'creditcard', name: 'Jane Jones', month: '12', year: '2030', card: facts('success', '4242') } } });
      expect(key.status).toBe(401);
    });

    it('Apple Pay from the wallet sheet: paid or failed at once by the chosen card', async () => {
      const ok = await pay({ type: 'applepay', token: 'stubyard_wallet_abc', card: facts('success', '4242') });
      expect(ok.status, ok.text).toBe(201);
      expect(ok.body.status).toBe('paid');
      expect(ok.body.source.type).toBe('applepay');
      const no = await pay({ type: 'applepay', token: 'stubyard_wallet_def', card: facts('decline', '0002') });
      expect(no.status, no.text).toBe(201);
      expect(no.body.status).toBe('failed');
    });

    it('STC Pay: initiated, the OTP from the form (wrong code keeps it open), then paid', async () => {
      const r = await pay({ type: 'stcpay', mobile: '0512345678' });
      expect(r.status, r.text).toBe(201);
      expect(r.body.status).toBe('initiated');
      const wrong = await call('POST', `${I('moyasar')}/checkout/${r.body.id}?otp_value=999999`);
      expect(wrong.status, wrong.text).toBe(400);
      expect(wrong.body.message).toMatch(/Wrong STC Pay code/);
      expect(repoPay('moyasar', r.body.id).status).not.toBe('failed');
      const otp = (repoPay('moyasar', r.body.id).providerData.stc as any).otp as string;
      const ok = await call('POST', `${I('moyasar')}/checkout/${r.body.id}?otp_value=${otp}`);
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.status).toBe('paid');
    });

    it('demo page and its result page', async () => {
      const d = await call('GET', `${I('moyasar')}/demo`);
      expect(d.status).toBe(200);
      for (const s of ['/mpf/moyasar.js', 'Moyasar.init(', 'class="mysr-form"', 'data-testid="stubyard-test-banner"']) expect(d.text, s).toContain(s);
      expectCsp(d.text, d.headers.get('content-security-policy') ?? '');
      const ar = await call('GET', `${I('moyasar')}/demo?lang=ar`);
      expect(ar.text).toContain('dir="rtl"');
      const r = await pay({ type: 'applepay', token: 'stubyard_wallet_x', card: facts('success', '4242') });
      const res = await call('GET', `${I('moyasar')}/demo/result?id=${r.body.id}&status=paid&message=APPROVED`);
      expect(res.text).toContain('data-testid="stubyard-demo-status">paid<');
    });
  });

  describe('wallet sheet', () => {
    const w = (q: Record<string, string> = {}) => `${I('moyasar')}/stubyard-sdk/wallet?` + new URLSearchParams({ wallet: 'applepay', amount: '10.00 SAR', label: 'Shop', ch: CH, origin: appUrl, lang: 'en', ...q }).toString();
    it('is marked TEST, offers the test cards, posts only to the page origin; refuses other origins', async () => {
      const s = await call('GET', w());
      expect(s.status, s.text).toBe(200);
      for (const t of ['data-testid="stubyard-wallet-confirm"', 'data-testid="stubyard-wallet-cancel"', TEST_NOTICE.en, JSON.stringify(appUrl)]) expect(s.text, t).toContain(t);
      expectNoWildcardPost(s.text);
      expectCsp(s.text, s.headers.get('content-security-policy') ?? '');
      expect((await call('GET', w({ lang: 'ar' }))).text).toContain(TEST_NOTICE.ar);
      await setConfig('moyasar', { sdkOrigins: 'http://shop.example' });
      expect((await call('GET', w())).status).toBe(403);
      await setConfig('moyasar', { sdkOrigins: null });
    });
  });

  describe('GeideaCheckout', () => {
    const session = async (extra: Record<string, unknown> = {}) => {
      const g = cfg.geidea!;
      const b: Record<string, unknown> = { amount: 25, currency: 'SAR', merchantReferenceId: 'ord-' + Math.random().toString(36).slice(2, 8), timestamp: new Date().toISOString(), returnUrl: `${appUrl}/ret`, ...extra };
      b.signature = geideaSessionSignature({ merchantPublicKey: g.merchantPublicKey, apiPassword: g.apiPassword, amount: b.amount as number, currency: 'SAR', merchantReferenceId: b.merchantReferenceId as string, timestamp: b.timestamp as string });
      const r = await call('POST', `${I('geidea')}/payment-intent/api/v2/direct/session`, { json: b, headers: { authorization: 'Basic ' + Buffer.from(`${g.merchantPublicKey}:${g.apiPassword}`).toString('base64') } });
      expect(r.status, r.text).toBe(200);
      return r.body.session as { id: string; orderId: string };
    };
    const open = (sid: string, q: Record<string, string> = {}) => call('GET', `${I('geidea')}/hpp/checkout/?${sid}&` + new URLSearchParams({ stubyard_sdk: CH, stubyard_origin: appUrl, stubyard_mode: 'popup', ...q }).toString());
    const payOf = (sid: string) => {
      const project = hub.projects.require('p2');
      const inst = hub.payments!.repo.requireInstance(project.id, slug.geidea!);
      return hub.payments!.repo.byInstanceRef(inst.id, sid)!;
    };

    it('serves GeideaCheckout (popup / drop-in); checkoutJsMode "redirect" keeps the redirect', async () => {
      const j = await call('GET', `${I('geidea')}/hpp/geideaCheckout.min.js`);
      expect(j.status).toBe(200);
      for (const s of ['GeideaCheckout.prototype.startPayment', 'onSuccess', 'onError', 'onCancel', '/hpp/sdk/sessions/', 'var MODE = "popup"']) expect(j.text, s).toContain(s);
      expectNoWildcardPost(j.text);
      await setConfig('geidea', { checkoutJsMode: 'redirect' });
      expect((await call('GET', `${I('geidea')}/hpp/geideaCheckout.js`)).text).toContain('var MODE = "redirect"');
      expect((await api('PATCH', `${PJ}/payment-instances/${slug.geidea}`, { config: { checkoutJsMode: 'modal' } })).status).toBe(400);
      await setConfig('geidea', { checkoutJsMode: null });
    });

    it('session state for startPayment: open (CORS for the page), unknown (lint)', async () => {
      const s = await session();
      const st = await call('GET', `${I('geidea')}/hpp/sdk/sessions/${s.id}`, { headers: { origin: appUrl } });
      expect(st.body).toMatchObject({ state: 'open', orderId: s.orderId });
      expect(st.headers.get('access-control-allow-origin')).toBe(appUrl);
      const un = await call('GET', `${I('geidea')}/hpp/sdk/sessions/nope`);
      expect(un.body.state).toBe('unknown');
      expect(un.body.error.responseCode).not.toBe('000');
      expect((await instLint('geidea')).map((l: any) => l.check)).toContain('pay.geidea-sdk-session');
    });

    it('popup: the frame keeps the bridge; success posts one result with responseCode 000 to the page origin', async () => {
      const s = await session();
      const o = await open(s.id);
      expect(o.status, o.text).toBe(302);
      const p = payOf(s.id);
      expect(p.providerData.sdkBridge).toMatchObject({ ch: CH, origin: appUrl, mode: 'popup' });
      const pg = await call('GET', `/pay/p2/${slug.geidea}/` + o.headers.get('location')!.replace(/^(\.\.\/)+/, '').replace(/^\//, ''));
      const page = pg.status === 200 ? pg : await call('GET', `${I('geidea')}/page/${p.id}`);
      expect(page.text).toContain('data-layout="geidea-hpp"');
      expect(page.text).toContain(JSON.stringify(appUrl));
      expectCsp(page.text, page.headers.get('content-security-policy') ?? '');
      const done = await call('POST', `${I('geidea')}/page/${p.id}/x/pay`, { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1', cname: 'Jane Jones' } });
      expect(done.status, done.text).toBe(200);
      expect(done.text).toContain('data-sdk="geidea"');
      expect(done.text).toContain(`type:'result',event:"success"`);
      expect(done.text).toContain('"responseCode":"000"');
      expect(done.text).toContain(JSON.stringify(appUrl));
      expectNoWildcardPost(done.text);
      expectCsp(done.text, done.headers.get('content-security-policy') ?? '');
      const after = await call('GET', `${I('geidea')}/hpp/sdk/sessions/${s.id}`);
      expect(after.body.state).toBe('finished');
      expect(after.body.error.responseCode).toBe('000');
    });

    it('drop-in cancel posts event "cancel"; a decline posts "error"', async () => {
      const s = await session();
      await open(s.id, { stubyard_mode: 'dropin' });
      const p = payOf(s.id);
      expect((p.providerData.sdkBridge as any).mode).toBe('dropin');
      await call('GET', `${I('geidea')}/page/${p.id}`);
      const c = await call('POST', `${I('geidea')}/page/${p.id}/x/pay`, { form: { outcome: 'cancel' } });
      expect(c.status, c.text).toBe(200);
      expect(c.text).toContain('event:"cancel"');
      const s2 = await session();
      await open(s2.id);
      const p2 = payOf(s2.id);
      await call('GET', `${I('geidea')}/page/${p2.id}`);
      const d = await call('POST', `${I('geidea')}/page/${p2.id}/x/pay`, { form: { outcome: 'decline', method: 'card' } });
      expect(d.status).toBe(200);
      if (d.text.includes("type:'result'")) expect(d.text).toContain('event:"error"');
    });

    it('refuses an origin outside sdkOrigins (403), and the plain redirect still works', async () => {
      const s = await session();
      await setConfig('geidea', { sdkOrigins: ['http://shop.example'] });
      expect((await open(s.id)).status).toBe(403);
      await setConfig('geidea', { sdkOrigins: null });
      const plain = await call('GET', `${I('geidea')}/hpp/checkout/?${s.id}`);
      expect(plain.status).toBe(302);
      expect(payOf(s.id).providerData.sdkBridge).toBeUndefined();
    });

    it('demo page creates a session and loads the script', async () => {
      const d = await call('GET', `${I('geidea')}/demo`);
      expect(d.status, d.text).toBe(200);
      for (const t of ['/hpp/geideaCheckout.min.js', 'new GeideaCheckout(', 'data-testid="stubyard-demo-session"', 'data-testid="stubyard-test-banner"']) expect(d.text, t).toContain(t);
      expectCsp(d.text, d.headers.get('content-security-policy') ?? '');
    });
  });

  describe('PayPal Buttons, Pay Later, Card Fields', () => {
    const ch = () => ({ 'x-stubyard-client-id': cfg.paypal!.clientId });
    const order = async () => {
      const c = await call('POST', `${I('paypal')}/sdk/orders`, { json: { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '12.00' } }] }, headers: ch() });
      expect(c.status, c.text).toBe(201);
      return c.body.id as string;
    };

    it('the SDK: neutral stacked buttons with Pay Later, the TEST notice, origin-checked messages', async () => {
      const j = await call('GET', `${I('paypal')}/sdk/js?client-id=${cfg.paypal!.clientId}&components=buttons,card-fields`);
      for (const s of ['stubyard-paypal-buttons', "'paypal', 'paylater', 'card'", 'stubyard-sdk-badge', 'e.origin !== ORIGIN', '&origin=', TEST_NOTICE.en]) expect(j.text, s).toContain(s);
      expect(j.text).not.toContain('#ffc439');
      expectNoWildcardPost(j.text);
    });

    it('Pay Later: checkoutnow keeps the page origin and funding; review shows the offers; the close page posts only to that origin', async () => {
      const id = await order();
      const o = await call('GET', `${I('paypal')}/checkoutnow?token=${id}&sdk=1&origin=${encodeURIComponent(appUrl)}&funding=paylater&locale=en_US`);
      expect(o.status, o.text).toBe(302);
      const p = repoPay('paypal', id);
      expect(p.providerData).toMatchObject({ sdk: true, sdkOrigin: appUrl, funding: 'paylater' });
      await call('GET', `${I('paypal')}/page/${p.id}`);
      const rv = await call('POST', `${I('paypal')}/page/${p.id}/x/login`, { form: { email: 'buyer@example.com' } });
      expect(rv.text).toContain('data-testid="stubyard-pp-paylater"');
      expect(rv.text).toContain('data-testid="stubyard-pp-offer-pay_in_4"');
      expect(rv.text).toContain('3.00 USD');
      const done = await call('POST', `${I('paypal')}/page/${p.id}/x/review`, { form: { outcome: 'success', pp_offer: 'pay_in_4' } });
      expect(done.status, done.text).toBe(200);
      expect(done.text).toContain('stubyard-sdk-done');
      expect(done.text).toContain('o=' + JSON.stringify(appUrl));
      expect(done.text).not.toContain('targetOrigin');
      expectNoWildcardPost(done.text);
      expect((await call('GET', `${I('paypal')}/sdk/orders/${id}/state`, { headers: ch() })).body.state).toBe('approved');
    });

    it('without an origin the close page posts nothing; a refused origin is a 403', async () => {
      const id = await order();
      await call('GET', `${I('paypal')}/checkoutnow?token=${id}&sdk=1`);
      const p = repoPay('paypal', id);
      await call('GET', `${I('paypal')}/page/${p.id}`);
      await call('POST', `${I('paypal')}/page/${p.id}/x/login`, { form: { email: 'buyer@example.com' } });
      const done = await call('POST', `${I('paypal')}/page/${p.id}/x/review`, { form: { outcome: 'success' } });
      expect(done.text).toContain('o=null');
      await setConfig('paypal', { sdkOrigins: 'http://shop.example' });
      const id2 = await order();
      expect((await call('GET', `${I('paypal')}/checkoutnow?token=${id2}&sdk=1&origin=${encodeURIComponent(appUrl)}`)).status).toBe(403);
      expect((await call('GET', `${I('paypal')}/sdk/card-field?type=number&cf=abc123&origin=${encodeURIComponent(appUrl)}`)).status).toBe(403);
      await setConfig('paypal', { sdkOrigins: null });
    });

    it('Card Fields frames post only to the accepted page origin (none without one)', async () => {
      const f = await call('GET', `${I('paypal')}/sdk/card-field?type=number&cf=abc123&origin=${encodeURIComponent(appUrl)}`);
      expect(f.status).toBe(200);
      expect(f.text).toContain('TO=' + JSON.stringify(appUrl));
      expectNoWildcardPost(f.text);
      expectCsp(f.text, f.headers.get('content-security-policy') ?? '');
      const n = await call('GET', `${I('paypal')}/sdk/card-field?type=number&cf=abc123`);
      expect(n.text).toContain('TO=null');
    });

    it('demo page', async () => {
      const d = await call('GET', `${I('paypal')}/demo?lang=ar`);
      expect(d.status, d.text).toBe(200);
      for (const t of ['/sdk/js?client-id=', 'locale=ar_SA', 'paypal.Buttons(', 'paypal.CardFields(', 'dir="rtl"']) expect(d.text, t).toContain(t);
      expectCsp(d.text, d.headers.get('content-security-policy') ?? '');
    });
  });

  describe('registry', () => {
    it('P2 modes are realistic; Stripe Embedded Checkout stays planned', async () => {
      const ref = (await api('GET', '/api/payment-presets')).body;
      const find = (preset: string, mode: string) => (ref.presets.find((p: any) => p.id === preset).experiences as any[]).find((e) => e.mode === mode);
      expect(find('moyasar', 'form')?.status).toBe('realistic');
      expect(find('geidea', 'popup')?.status).toBe('realistic');
      expect(find('paypal', 'buttons-popup')?.status).toBe('realistic');
      expect(find('stripe-checkout', 'embedded')?.status).toBe('planned');
    });
  });
});
