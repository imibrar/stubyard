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
import { TEST_NOTICE } from '../src/payments/kit/i18n.js';
import { PAYMENT_PRESET_IDS, type PaymentPresetId } from '../src/payments/repo.js';

/** Checkout kit P1: the redirect hosted pages (Checkout.com, PayTabs, APS, Tap, MyFatoorah, Moyasar, PayPal, Geidea, HyperPay). */

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
const PJ = '/api/projects/kit';
const slugs = new Map<PaymentPresetId, string>();
let stripeKey = '';

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

/** A payment row straight in the repo (the hosted page only needs the row; each gateway's own create API is covered by its suite). */
function mkPayment(preset: PaymentPresetId, extra: Record<string, unknown> = {}) {
  const project = hub.projects.require('kit');
  const inst = hub.payments!.repo.requireInstance(project.id, slugs.get(preset)!);
  return hub.payments!.repo.insert({
    projectId: project.id,
    instanceId: inst.id,
    runId: null,
    testUserId: null,
    kind: inst.preset === 'stripe-checkout' ? 'checkout_session' : 'hpp',
    providerRef: `ref_${Math.random().toString(36).slice(2, 12)}`,
    secondaryRef: null,
    status: 'created',
    amount: 5000,
    currency: 'SAR',
    reference: 'order-1',
    customerEmail: 'buyer@example.com',
    returnUrl: `${appUrl}/ok`,
    cancelUrl: `${appUrl}/cancel`,
    callbackUrl: null,
    presetOutcome: null,
    request: {},
    providerData: {},
    idempotencyKey: null,
    lint: [],
    logId: null,
    expiresAt: null,
    ...extra,
  } as any);
}
const pagePath = (preset: PaymentPresetId, id: string) => `/pay/kit/${slugs.get(preset)}/page/${id}`;

async function stripeSession(extra: Record<string, string | number> = {}) {
  const r = await call('POST', '/pay/kit/stripe/v1/checkout/sessions', {
    form: { mode: 'payment', success_url: `${appUrl}/ok?sid={CHECKOUT_SESSION_ID}`, cancel_url: `${appUrl}/cancel`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': 2500, 'line_items[0][price_data][product_data][name]': 'T-shirt', 'line_items[0][quantity]': 2, client_reference_id: 'order-1', customer_email: 'buyer@example.com', ...extra },
    headers: { authorization: `Bearer ${stripeKey}` },
  });
  expect(r.status, r.text).toBe(200);
  const id = (await api('GET', `${PJ}/payments/${r.body.id}`)).body.id as string;
  return { cs: r.body, id, page: `/pay/kit/stripe/page/${id}`, x: (step: string) => `/pay/kit/stripe/page/${id}/x/${step}` };
}

function expectBanner(html: string, o: { ar?: boolean } = {}) {
  expect(html).toContain('data-testid="stubyard-test-banner"');
  expect(html).toContain(TEST_NOTICE.en);
  if (o.ar) expect(html).toContain(TEST_NOTICE.ar);
  expect(html).toMatch(/<title>\[TEST\] /);
}
function expectCspCoversScripts(html: string, csp: string) {
  expect(csp).toContain("frame-src 'self'");
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(csp).toContain(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`);
}
/** No provider assets: nothing loaded from outside stubyard, no web fonts or remote images. */
function expectNoExternalAssets(html: string) {
  expect(html).not.toMatch(/(src|href)="https?:\/\/(?!127\.0\.0\.1|localhost)/);
  expect(html).not.toMatch(/@font-face|@import|url\(https?:/i);
  expect(html).not.toMatch(/<img[^>]+src="(?!data:)/);
}

describe('checkout kit P1: redirect hosted pages', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-kit1-'));
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
    expect((await api('POST', '/api/projects', { name: 'Kit Shop', slug: 'kit', generateUsers: { customers: 1 } })).status).toBe(201);
    for (const preset of PAYMENT_PRESET_IDS) {
      const r = await api('POST', `${PJ}/payment-instances`, { preset, config: { webhookDelayMs: 0 } });
      expect(r.status, `${preset}: ${r.text}`).toBe(201);
      slugs.set(preset, r.body.slug);
      if (preset === 'stripe-checkout') stripeKey = r.body.config.secretKey;
    }
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });


  const CARD = { method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' };
  const CARD_3DS = { method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' };
  const x = (preset: PaymentPresetId, id: string, step: string) => pagePath(preset, id) + '/x/' + step;
  const det = async (id: string) => (await api('GET', `${PJ}/payments/${id}`)).body;
  const ref = (pfx: string) => `${pfx}${Math.random().toString(36).slice(2, 12)}`;

  describe('Checkout.com HPP', () => {
    const hpp = () => mkPayment('checkout', { providerRef: ref('hpp_'), secondaryRef: ref('pay_'), request: { success_url: `${appUrl}/ok`, failure_url: `${appUrl}/fail`, cancel_url: `${appUrl}/cancel` }, providerData: { methods: ['card', 'mada', 'applepay'], sessionId: 'sid_x' } });

    it('renders the HPP (tabs, back link, cardholder) and success returns with cko-payment-id', async () => {
      const p = hpp();
      const pg = await call('GET', pagePath('checkout', p.id));
      expect(pg.status).toBe(200);
      for (const s of ['data-layout="checkout-hpp"', 'data-testid="stubyard-back"', 'data-testid="stubyard-cardholder"', 'data-testid="stubyard-method-mada"', 'Checkout.com (simulated)', 'Apple Pay (simulated)']) expect(pg.text, s).toContain(s);
      expectBanner(pg.text);
      expectCspCoversScripts(pg.text, pg.headers.get('content-security-policy') ?? '');
      expectNoExternalAssets(pg.text);
      const ok = await call('POST', x('checkout', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${appUrl}/ok?cko-payment-id=${p.secondaryRef}`);
      expect((await det(p.id)).status).toBe('paid');
    });

    it('3-D Secure is a full-page redirect to the ACS page; answered once; replay refused', async () => {
      const p = hpp();
      const ch = await call('POST', x('checkout', p.id, 'pay'), { form: { outcome: 'success', ...CARD_3DS } });
      expect(ch.status).toBe(303);
      expect(ch.headers.get('location')).toBe('acs');
      const acs = await call('GET', x('checkout', p.id, 'acs'));
      expect(acs.status).toBe(200);
      for (const s of ['data-testid="stubyard-3ds-bank"', 'data-testid="stubyard-3ds-code"', 'Checkout1!', 'data-provider="Checkout.com"']) expect(acs.text, s).toContain(s);
      expect(acs.text).not.toContain('target="_top"');
      expectBanner(acs.text);
      const ok = await call('POST', x('checkout', p.id, '3ds'), { form: { outcome: '3ds_success' } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toContain('cko-payment-id=');
      const again = await call('POST', x('checkout', p.id, '3ds'), { form: { outcome: '3ds_success' } });
      expect(again.status).not.toBe(303);
      expect((await det(p.id)).status).toBe('paid');
    });

    it('a 3DS failure fails the payment (failure_url); cancel / back goes to cancel_url', async () => {
      const p = hpp();
      await call('POST', x('checkout', p.id, 'pay'), { form: { outcome: 'success', ...CARD_3DS } });
      const f = await call('POST', x('checkout', p.id, '3ds'), { form: { outcome: '3ds_fail' } });
      expect([200, 303]).toContain(f.status);
      if (f.status === 303) expect(f.headers.get('location')).toContain(`${appUrl}/fail`);
      const q = hpp();
      const c = await call('POST', x('checkout', q.id, 'pay'), { form: { outcome: 'cancel' } });
      expect(c.status).toBe(303);
      expect(c.headers.get('location')).toBe(`${appUrl}/cancel?cko-payment-id=${q.secondaryRef}`);
      expect((await det(q.id)).status).toBe('cancelled');
    });

    it('decline: failure_url (or the page again with the message)', async () => {
      const p = hpp();
      // the quick Decline button (formnovalidate: no card facts; a magic card would win over the click)
      const d = await call('POST', x('checkout', p.id, 'pay'), { form: { outcome: 'decline', method: 'card' } });
      expect([200, 303]).toContain(d.status);
      if (d.status === 303) expect(d.headers.get('location')).toContain(`${appUrl}/fail?cko-payment-id=`);
      else expect(d.text).toContain('data-testid="stubyard-error"');
    });

    it('a /3ds/ payment (card sent to the API) opens the ACS page directly', async () => {
      const p = mkPayment('checkout', { providerRef: ref('pay_'), request: { success_url: `${appUrl}/ok`, failure_url: `${appUrl}/fail` }, providerData: { methods: ['card'], apiCard: { brand: 'visa', last4: '3155', magicId: '3ds', luhnValid: true, testCard: true }, sessionId: 'sid_y' } });
      const pg = await call('GET', pagePath('checkout', p.id));
      expect(pg.text).toContain('data-testid="stubyard-3ds-bank"');
      expect(pg.text).toContain(`action="${p.id}/x/3ds"`);
      const ok = await call('POST', x('checkout', p.id, '3ds'), { form: { outcome: '3ds_success' } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${appUrl}/ok?cko-session-id=sid_y`);
    });

    it('opened in an iframe: lint pay.hpp-framed, the page is still served', async () => {
      const p = hpp();
      const r = await call('GET', `/pay/kit/${slugs.get('checkout')}/hpp/${p.providerRef}`, { headers: { 'sec-fetch-dest': 'iframe' } });
      expect(r.status).toBe(302);
      expect((await det(p.id)).lint.map((l: any) => l.check)).toContain('pay.hpp-framed');
      const q = hpp();
      await call('GET', `/pay/kit/${slugs.get('checkout')}/hpp/${q.providerRef}`, { headers: { 'sec-fetch-dest': 'document' } });
      expect((await det(q.id)).lint.map((l: any) => l.check)).not.toContain('pay.hpp-framed');
    });

    it('Arabic: RTL page, Arabic provider wording', async () => {
      const p = hpp();
      const pg = await call('GET', pagePath('checkout', p.id) + '?stubyard_lang=ar');
      expect(pg.text).toContain('lang="ar" dir="rtl"');
      expect(pg.text).toContain('العودة إلى المتجر');
      expectBanner(pg.text, { ar: true });
    });
  });

  describe('PayTabs HPP', () => {
    it('renders the cart, Cancel; success is the countdown form POST to the return URL with the same fields', async () => {
      const p = mkPayment('paytabs', { request: { cart_description: 'Cart 1' }, providerData: { tranType: 'sale', methods: ['card', 'mada'] } });
      const pg = await call('GET', pagePath('paytabs', p.id));
      for (const s of ['data-layout="paytabs-hpp"', 'data-testid="stubyard-provider-cancel"', 'PayTabs (simulated)']) expect(pg.text, s).toContain(s);
      const ok = await call('POST', x('paytabs', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(200);
      expect(ok.text).toContain('data-testid="stubyard-return-form"');
      expect(ok.text).toContain(`action="${appUrl}/ok"`);
      for (const f of ['tranRef', 'respStatus', 'cartId', 'signature']) expect(ok.text, f).toContain(`name="${f}"`);
      expect(ok.text).not.toMatch(/target="_(top|parent)"/);
      expectCspCoversScripts(ok.text, ok.headers.get('content-security-policy') ?? '');
    });

    it('return_using_get keeps the plain 303 redirect', async () => {
      const p = mkPayment('paytabs', { providerData: { tranType: 'sale', methods: ['card'], returnUsingGet: true } });
      const ok = await call('POST', x('paytabs', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toMatch(new RegExp(`^${appUrl}/ok\\?.*tranRef=`));
    });

    it('framed: compact page; framed_return_top submits into _top', async () => {
      const p = mkPayment('paytabs', { request: { framed: true, framed_return_top: true }, providerData: { tranType: 'sale', methods: ['card'], framed: true } });
      const pg = await call('GET', pagePath('paytabs', p.id));
      expect(pg.text).toContain('k-compact');
      const ok = await call('POST', x('paytabs', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.text).toContain('target="_top"');
    });

    it('framed without a return URL: hppDone to the framed_message_target origin only', async () => {
      const p = mkPayment('paytabs', { returnUrl: null, request: { framed: true, framed_message_target: 'https://shop.example/checkout/page' }, providerData: { tranType: 'sale', methods: ['card'], framed: true } });
      const ok = await call('POST', x('paytabs', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(200);
      expect(ok.text).toContain('data-testid="stubyard-done"');
      expect(ok.text).toContain(`postMessage('hppDone',"https://shop.example")`);
      expect(ok.text).not.toContain('document.referrer');
      expectCspCoversScripts(ok.text, ok.headers.get('content-security-policy') ?? '');
      const q = mkPayment('paytabs', { returnUrl: null, request: { framed: true }, providerData: { tranType: 'sale', methods: ['card'], framed: true } });
      const r = await call('POST', x('paytabs', q.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(r.text).not.toContain('hppDone');
    });
  });

  describe('APS redirection', () => {
    it('card: form POST of the response fields; KNET goes to the bank page; Arabic', async () => {
      const p = mkPayment('aps', { providerData: { methods: ['card', 'knet'] } });
      const pg = await call('GET', pagePath('aps', p.id));
      expect(pg.text).toContain('data-layout="aps-hosted"');
      expect(pg.text).toContain('k-mlist');
      const ok = await call('POST', x('aps', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(200);
      expect(ok.text).toContain(`action="${appUrl}/ok"`);
      for (const f of ['response_code', 'fort_id', 'signature']) expect(ok.text, f).toContain(`name="${f}"`);
      const q = mkPayment('aps', { providerData: { methods: ['card', 'knet'] } });
      const k = await call('POST', x('aps', q.id, 'pay'), { form: { outcome: 'success', method: 'knet' } });
      expect(k.status).toBe(303);
      expect(k.headers.get('location')).toBe('bank');
      const bank = await call('GET', x('aps', q.id, 'bank'));
      expect(bank.text).toContain('data-bank="knet"');
      const ar = await call('GET', pagePath('aps', mkPayment('aps').id) + '?stubyard_lang=ar');
      expect(ar.text).toContain('lang="ar" dir="rtl"');
    });
  });

  describe('Tap hosted with KNET / BENEFIT bank pages', () => {
    it('KNET: pay → bank page (no digits posted) → success returns with tap_id', async () => {
      const p = mkPayment('tap', { providerData: { methods: ['card', 'knet', 'benefit'] } });
      const pg = await call('GET', pagePath('tap', p.id));
      for (const s of ['data-layout="tap-hosted"', 'data-testid="stubyard-method-knet"', 'data-testid="stubyard-save-card"']) expect(pg.text, s).toContain(s);
      const r = await call('POST', x('tap', p.id, 'pay'), { form: { outcome: 'success', method: 'knet' } });
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('bank');
      const bank = await call('GET', x('tap', p.id, 'bank'));
      expect(bank.status).toBe(200);
      for (const s of ['data-testid="stubyard-bank-page"', 'data-bank="knet"', 'KNET (simulated)', 'Test bank 1', 'data-testid="stubyard-bank-pin"', 'data-testid="stubyard-bank-cancel"']) expect(bank.text, s).toContain(s);
      // the card number and PIN inputs have no name: never posted
      expect(bank.text).not.toMatch(/id="bnum"[^>]*name=|name="[^"]*"[^>]*id="bnum"/);
      expect(bank.text).not.toMatch(/id="bpin"[^>]*name=/);
      expectCspCoversScripts(bank.text, bank.headers.get('content-security-policy') ?? '');
      const ok = await call('POST', x('tap', p.id, 'bank'), { form: { outcome: 'success', method: 'knet' } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${appUrl}/ok?tap_id=${p.providerRef}`);
      expect(await det(p.id)).toMatchObject({ status: 'paid', method: 'knet' });
      // replay of the bank step: refused
      const again = await call('POST', x('tap', p.id, 'bank'), { form: { outcome: 'success' } });
      expect(again.status).not.toBe(303);
    });

    it('BENEFIT: cancel on the bank page; decline on the bank page', async () => {
      const p = mkPayment('tap', { providerData: { methods: ['card', 'benefit'] } });
      await call('POST', x('tap', p.id, 'pay'), { form: { outcome: 'success', method: 'benefit' } });
      const bank = await call('GET', x('tap', p.id, 'bank'));
      expect(bank.text).toContain('BENEFIT (simulated)');
      const c = await call('POST', x('tap', p.id, 'bank'), { form: { outcome: 'cancel' } });
      expect(c.status).toBe(303);
      expect((await det(p.id)).status).toBe('cancelled');
      const q = mkPayment('tap', { providerData: { methods: ['card', 'benefit'] } });
      await call('POST', x('tap', q.id, 'pay'), { form: { outcome: 'success', method: 'benefit' } });
      await call('POST', x('tap', q.id, 'bank'), { form: { outcome: 'decline' } });
      expect((await det(q.id)).status).toBe('failed');
    });

    it('a single-method charge (src_kw.knet) opens the bank page directly; the bank step cannot be skipped', async () => {
      const p = mkPayment('tap', { providerData: { methods: ['knet'] } });
      const skip = await call('POST', x('tap', p.id, 'bank'), { form: { outcome: 'success' } });
      expect(skip.status).not.toBe(303);
      const pg = await call('GET', pagePath('tap', p.id));
      expect(pg.text).toContain('data-bank="knet"');
      expect(pg.text).toContain(`action="${p.id}/x/bank"`);
      const ok = await call('POST', x('tap', p.id, 'bank'), { form: { outcome: 'success' } });
      expect(ok.status).toBe(303);
    });

    it('a tok_ charge (card tokenised by the app) opens the ACS page directly; Arabic bank page', async () => {
      const p = mkPayment('tap', { providerData: { methods: ['card'], apiCard: { brand: 'visa', last4: '4242', magicId: null, luhnValid: true, testCard: true } } });
      expect((await call('GET', pagePath('tap', p.id))).text).toContain('data-testid="stubyard-3ds-bank"');
      const q = mkPayment('tap', { providerData: { methods: ['knet'] } });
      const ar = await call('GET', pagePath('tap', q.id) + '?stubyard_lang=ar');
      expect(ar.text).toContain('lang="ar" dir="rtl"');
      expect(ar.text).toContain('كي نت (محاكاة)');
    });
  });

  describe('MyFatoorah hosted', () => {
    const mf = (methods: string[]) => mkPayment('myfatoorah', { currency: 'KWD', providerData: { methods } });

    it('method selection → card form (Change payment method) → success with paymentId and Id', async () => {
      const p = mf(['knet', 'card', 'applepay']);
      const pg = await call('GET', pagePath('myfatoorah', p.id));
      for (const s of ['data-screen="select"', 'data-testid="stubyard-method-knet"', 'VISA/MASTER', `action="${p.id}/x/select"`]) expect(pg.text, s).toContain(s);
      const sel = await call('POST', x('myfatoorah', p.id, 'select'), { form: { method: 'card' } });
      expect(sel.status).toBe(200);
      for (const s of ['data-screen="method"', 'data-testid="stubyard-change-method"', 'data-testid="stubyard-card"']) expect(sel.text, s).toContain(s);
      expect(sel.text).not.toContain('data-testid="stubyard-method-knet"');
      const ok = await call('POST', x('myfatoorah', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(303);
      const loc = new URL(ok.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe(`${appUrl}/ok`);
      expect(loc.searchParams.get('paymentId')).toBeTruthy();
      expect(loc.searchParams.get('Id')).toBe(loc.searchParams.get('paymentId'));
    });

    it('KNET from the selection: the bank page lists the documented test cards; decline returns to the error URL', async () => {
      const p = mf(['knet', 'card']);
      const sel = await call('POST', x('myfatoorah', p.id, 'select'), { form: { method: 'knet' } });
      expect(sel.status).toBe(303);
      expect(sel.headers.get('location')).toBe('bank');
      const bank = await call('GET', x('myfatoorah', p.id, 'bank'));
      expect(bank.text).toContain('data-testid="stubyard-bank-rules"');
      expect(bank.text).toContain('8888 8800 0000 0001');
      const d = await call('POST', x('myfatoorah', p.id, 'bank'), { form: { outcome: 'decline' } });
      expect(d.status).toBe(303);
      expect(d.headers.get('location')).toContain(`${appUrl}/cancel?paymentId=`);
      expect((await det(p.id)).status).toBe('failed');
    });

    it('Benefit and an unknown method; mada / STC Pay in Saudi; Arabic selection', async () => {
      const p = mf(['benefit', 'card']);
      await call('POST', x('myfatoorah', p.id, 'select'), { form: { method: 'benefit' } });
      expect((await call('GET', x('myfatoorah', p.id, 'bank'))).text).toContain('4600 4101 2345 6789');
      const q = mf(['knet', 'card']);
      expect((await call('POST', x('myfatoorah', q.id, 'select'), { form: { method: 'stcpay' } })).status).toBe(400);
      const s = mkPayment('myfatoorah', { providerData: { methods: ['mada', 'card', 'applepay', 'stcpay'] } });
      const pg = await call('GET', pagePath('myfatoorah', s.id) + '?stubyard_lang=ar');
      for (const t of ['lang="ar" dir="rtl"', 'data-testid="stubyard-method-mada"', 'data-testid="stubyard-method-stcpay"', 'مدى']) expect(pg.text, t).toContain(t);
      const st = await call('POST', x('myfatoorah', s.id, 'select'), { form: { method: 'stcpay' } });
      expect(st.text).toContain('data-testid="stubyard-phone"');
    });

    it('a test shortcut on the selection screen finishes the payment', async () => {
      const p = mf(['knet', 'card']);
      const c = await call('POST', x('myfatoorah', p.id, 'select'), { form: { outcome: 'cancel' } });
      expect(c.status).toBe(303);
      expect((await det(p.id)).status).toBe('cancelled');
    });
  });

  describe('Moyasar hosted invoice', () => {
    it('description heading, invoice id, back link; success / back return as today', async () => {
      const p = mkPayment('moyasar', { request: { description: 'Order #77' }, providerData: { moyasarObject: 'invoice', methods: ['mada', 'card', 'applepay', 'stcpay'] } });
      const pg = await call('GET', pagePath('moyasar', p.id));
      for (const s of ['data-layout="moyasar-invoice"', 'Order #77', p.providerRef, 'data-testid="stubyard-back"', 'data-testid="stubyard-method-stcpay"']) expect(pg.text, s).toContain(s);
      const ok = await call('POST', x('moyasar', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')!.startsWith(`${appUrl}/ok?`)).toBe(true);
      const q = mkPayment('moyasar', { providerData: { moyasarObject: 'invoice' } });
      const back = await call('POST', x('moyasar', q.id, 'pay'), { form: { outcome: 'cancel' } });
      expect(back.headers.get('location')!.startsWith(`${appUrl}/cancel`)).toBe(true);
    });
  });

  describe('PayPal approval (login → review → approve)', () => {
    const pp = (extra: Record<string, unknown> = {}) => mkPayment('paypal', { providerData: { methods: ['paypal'], payerId: 'PAYER123' }, ...extra });

    it('login → review (Pay Now) → return_url with token and PayerID; the password is never posted', async () => {
      const p = pp({ request: { application_context: { user_action: 'PAY_NOW', brand_name: 'Kit Brand' } } });
      const pg = await call('GET', pagePath('paypal', p.id));
      for (const s of ['data-layout="paypal-approval"', 'data-testid="stubyard-login"', 'data-testid="stubyard-password"', 'value="buyer@example.com"', `action="${p.id}/x/login"`]) expect(pg.text, s).toContain(s);
      expect(pg.text).not.toMatch(/type="password"[^>]*name=/);
      // skipping the login is refused
      expect((await call('POST', x('paypal', p.id, 'review'), { form: {} })).status).toBe(409);
      const bad = await call('POST', x('paypal', p.id, 'login'), { form: { email: '' } });
      expect(bad.status).toBe(400);
      expect(bad.text).toContain('data-testid="stubyard-error"');
      const rv = await call('POST', x('paypal', p.id, 'login'), { form: { email: 'buyer@example.com' } });
      expect(rv.status).toBe(200);
      for (const s of ['data-testid="stubyard-pp-review"', 'Pay Now', 'Kit Brand', 'data-testid="stubyard-pp-ship"', 'data-testid="stubyard-not-you"']) expect(rv.text, s).toContain(s);
      const ok = await call('POST', x('paypal', p.id, 'review'), { form: { outcome: 'success' } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${appUrl}/ok?token=${p.providerRef}&PayerID=PAYER123`);
      expect((await det(p.id)).status).toMatch(/authorized|paid|approved/);
      expect((await call('POST', x('paypal', p.id, 'review'), { form: { outcome: 'success' } })).status).not.toBe(303);
    });

    it('Continue (no PAY_NOW), NO_SHIPPING, Not you? goes back to the login, cancel returns to cancel_url', async () => {
      const p = pp({ request: { application_context: { shipping_preference: 'NO_SHIPPING' } } });
      await call('GET', pagePath('paypal', p.id));
      const rv = await call('POST', x('paypal', p.id, 'login'), { form: { email: 'b@example.com' } });
      expect(rv.text).toContain('>Continue<');
      expect(rv.text).not.toContain('data-testid="stubyard-pp-ship"');
      const back = await call('POST', x('paypal', p.id, 'review'), { form: { back: '1' } });
      expect(back.text).toContain('data-testid="stubyard-login"');
      await call('POST', x('paypal', p.id, 'login'), { form: { email: 'b@example.com' } });
      const c = await call('POST', x('paypal', p.id, 'review'), { form: { outcome: 'cancel' } });
      expect(c.status).toBe(303);
      expect(c.headers.get('location')!.startsWith(`${appUrl}/cancel`)).toBe(true);
    });

    it('a drawer outcome chosen on the login screen is carried to the review button; the Decline shortcut on the login finishes at once', async () => {
      const p = pp();
      await call('GET', pagePath('paypal', p.id));
      const rv = await call('POST', x('paypal', p.id, 'login'), { form: { email: 'b@example.com', k_outcome: 'decline' } });
      expect(rv.text).toMatch(/name="k_outcome" value="decline"[^>]*checked/);
      const q = pp();
      await call('GET', pagePath('paypal', q.id));
      const d = await call('POST', x('paypal', q.id, 'login'), { form: { outcome: 'decline' } });
      expect([200, 303]).toContain(d.status);
      // As on the classic page: PayPal approves and the decline happens at the app's capture (captureDecline).
      expect(await det(q.id)).toMatchObject({ status: 'authorized' });
    });

    it('Arabic login page', async () => {
      const p = pp();
      const pg = await call('GET', pagePath('paypal', p.id) + '?stubyard_lang=ar');
      expect(pg.text).toContain('lang="ar" dir="rtl"');
      expect(pg.text).toContain('سجّل الدخول إلى PayPal');
    });
  });

  describe('Geidea and HyperPay', () => {
    it('Geidea: 3-D Secure in a modal; success returns with responseCode etc.', async () => {
      const p = mkPayment('geidea', { providerData: { methods: ['card'] } });
      const ch = await call('POST', x('geidea', p.id, 'pay'), { form: { outcome: 'success', ...CARD_3DS } });
      expect(ch.status).toBe(200);
      expect(ch.text).toContain('data-testid="stubyard-3ds-modal"');
      expect(ch.text).toContain('data-layout="geidea-hpp"');
      const ok = await call('POST', x('geidea', p.id, '3ds'), { form: { outcome: '3ds_success' } });
      expect(ok.status).toBe(303);
      const loc = new URL(ok.headers.get('location')!);
      for (const k of ['responseCode', 'orderId', 'signature']) expect(loc.searchParams.has(k), k).toBe(true);
    });

    it('HyperPay: the widget frame uses the layout (brands as text, forms to _top); return ?id=&resourcePath=', async () => {
      const p = mkPayment('hyperpay', { providerData: { methods: ['card', 'mada'] } });
      const w = await call('GET', pagePath('hyperpay', p.id) + '?embed=1&brands=VISA%20MASTER%20MADA&result=' + encodeURIComponent(`${appUrl}/ok`));
      expect(w.status).toBe(200);
      for (const s of ['data-layout="hyperpay-widget"', 'data-testid="stubyard-brands"', 'MADA', 'target="_top"', 'k-compact']) expect(w.text, s).toContain(s);
      const ok = await call('POST', x('hyperpay', p.id, 'pay'), { form: { outcome: 'success', ...CARD } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${appUrl}/ok?id=${p.providerRef}&resourcePath=${encodeURIComponent(`/v1/checkouts/${p.providerRef}/payment`)}`);
    });
  });

  describe('registry, fidelity and phone layout', () => {
    it('P1 modes are realistic with their layouts and per-step fidelity; the drawer lists the steps', async () => {
      const ref = (await api('GET', '/api/payment-presets')).body;
      const exp = (id: string) => ref.presets.find((p: any) => p.id === id).experiences as any[];
      expect(exp('paypal').find((e: any) => e.layout === 'paypal-approval')).toMatchObject({ status: 'realistic', screens: 'assumed' });
      expect(exp('myfatoorah').find((e: any) => e.layout === 'myfatoorah-hosted')?.status).toBe('realistic');
      expect(exp('checkout').find((e: any) => e.mode === '3ds-acs')?.layout).toBe('checkout-hpp');
      expect(exp('tap').find((e: any) => e.layout === 'tap-hosted')?.steps?.length).toBeGreaterThan(1);
      expect(ref.lintChecks.map((c: any) => c.id)).toContain('pay.hpp-framed');
      const p = mkPayment('tap', { providerData: { methods: ['card', 'knet'] } });
      const pg = await call('GET', pagePath('tap', p.id));
      expect(pg.text).toContain('data-testid="stubyard-fidelity-steps"');
      expect(pg.text).toContain('name="viewport"');
    });
  });
});
