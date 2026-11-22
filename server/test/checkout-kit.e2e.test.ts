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

/** Checkout kit P0: banner + [TEST] title on every gateway's pages, realistic / classic switch, Stripe hosted flow, AR / RTL. */

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

/** The provider layouts of P0 / P1 (other presets: the generic kit page). */
const LAYOUT: Partial<Record<PaymentPresetId, string>> = { 'stripe-checkout': 'stripe-hosted', paytabs: 'paytabs-hpp', paypal: 'paypal-approval', hyperpay: 'hyperpay-widget', moyasar: 'moyasar-invoice', tap: 'tap-hosted', checkout: 'checkout-hpp', aps: 'aps-hosted', myfatoorah: 'myfatoorah-hosted', geidea: 'geidea-hpp' };
const FIRST: Partial<Record<PaymentPresetId, { primary: string; step: string }>> = { paypal: { primary: 'stubyard-login', step: 'login' }, myfatoorah: { primary: 'stubyard-method-card', step: 'select' } };

describe('checkout kit (P0)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-kit-'));
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

  describe('switch and registry', () => {
    it('new instances are realistic; settings are validated; the presets list the modes with split fidelity tags', async () => {
      const inst = (await api('GET', `${PJ}/payment-instances/${slugs.get('stripe-checkout')}`)).body;
      expect(inst.config.experience).toBe('realistic');
      const bad = await api('PATCH', `${PJ}/payment-instances/${slugs.get('paytabs')}`, { config: { experience: 'shiny' } });
      expect(bad.status).toBe(400);
      expect((await api('PATCH', `${PJ}/payment-instances/${slugs.get('paytabs')}`, { config: { pageTimings: 'FAST', pageLocale: 'auto' } })).body.config).toMatchObject({ pageTimings: 'fast', pageLocale: 'auto' });
      const ref = (await api('GET', '/api/payment-presets')).body;
      const stripe = ref.presets.find((p: any) => p.id === 'stripe-checkout');
      expect(stripe.experiences.find((e: any) => e.mode === 'hosted')).toMatchObject({ status: 'realistic', layout: 'stripe-hosted', api: 'verified', screens: 'partial' });
      for (const p of ref.presets) expect(p.experiences.length, p.id).toBeGreaterThan(0);
      expect(ref.lintChecks.map((c: any) => c.id)).toContain('pay.test-notice-hidden');
    });

    it('an instance without the experience key (created before this feature) stays classic; one PATCH switches it', async () => {
      const project = hub.projects.require('kit');
      const old = hub.payments!.repo.createInstance(project.id, { slug: 'old-paytabs', preset: 'paytabs', name: 'Old PayTabs', config: { profileId: '1', serverKey: 'S' } });
      slugs.set('paytabs', 'old-paytabs');
      try {
        const p = mkPayment('paytabs');
        const classic = await call('GET', pagePath('paytabs', p.id));
        expect(classic.status).toBe(200);
        expect(classic.text).toContain('More outcomes');
        expect(classic.text).not.toContain('data-testid="stubyard-drawer"');
        expectBanner(classic.text);
        await api('PATCH', `${PJ}/payment-instances/old-paytabs`, { config: { experience: 'realistic' } });
        const real = await call('GET', pagePath('paytabs', mkPayment('paytabs').id));
        expect(real.text).toContain('data-testid="stubyard-drawer"');
        expect(hub.payments!.repo.instanceById(old.id)!.config.experience).toBe('realistic');
      } finally {
        slugs.set('paytabs', 'paytabs');
      }
    });
  });

  describe('export / import', () => {
    it('an export keeps the view; an old export without the key imports as classic', async () => {
      const ex = (await api('GET', '/api/projects/kit/export')).body;
      const kept = await api('POST', '/api/projects/import', { ...ex, project: { ...ex.project, name: 'Kit copy', slug: 'kit-copy' } });
      expect(kept.status, kept.text).toBeLessThan(300);
      expect((await api('GET', '/api/projects/kit-copy/payment-instances/stripe')).body.config.experience).toBe('realistic');
      const old = JSON.parse(JSON.stringify(ex));
      for (const s of Object.values(old) as any[]) if (Array.isArray(s)) for (const r of s) if (r && r.preset && r.config) delete r.config.experience;
      const rows = JSON.stringify(old).includes('"experience"') ? null : old;
      expect(rows).not.toBeNull();
      const im = await api('POST', '/api/projects/import', { ...old, project: { ...old.project, name: 'Kit old', slug: 'kit-old' } });
      expect(im.status, im.text).toBeLessThan(300);
      expect((await api('GET', '/api/projects/kit-old/payment-instances/stripe')).body.config.experience).toBe('classic');
    });
  });

  describe('banner and [TEST] title on every gateway', () => {
    it.each([...PAYMENT_PRESET_IDS])('%s: realistic page, classic view and the classic done page', async (preset) => {
      const p = mkPayment(preset);
      const pg = await call('GET', pagePath(preset, p.id));
      expect(pg.status, pg.text.slice(0, 300)).toBe(200);
      expectBanner(pg.text);
      expectCspCoversScripts(pg.text, pg.headers.get('content-security-policy') ?? '');
      expectNoExternalAssets(pg.text);
      // Pay / Decline / Cancel without opening the drawer; the drawer holds the rest (testids kept).
      // P1: the first screen of PayPal is the login, of MyFatoorah the method selection.
      const first = FIRST[preset] ?? { primary: 'stubyard-pay', step: 'pay' };
      for (const id of [first.primary, 'stubyard-decline', 'stubyard-cancel', 'stubyard-drawer', 'stubyard-outcome-abandon', 'stubyard-outcome-decline-insufficient_funds', 'stubyard-amount']) expect(pg.text, id).toContain(`data-testid="${id}"`);
      expect(pg.text).toContain(`data-layout="${LAYOUT[preset] ?? 'generic'}"`);
      expect(pg.text).toContain(`action="${p.id}/x/${first.step}"`);

      // ?ui=classic: today's page (plus the banner), and it sticks for this payment.
      const classic = await call('GET', pagePath(preset, p.id) + '?ui=classic');
      expectBanner(classic.text);
      expect(classic.text).toContain('More outcomes');
      expect(classic.text).toMatch(/<title>\[TEST\] Pay 50\.00 SAR – Fake /);
      expect(classic.text).toContain(`action="${p.id}/complete"`);
      expect((await call('GET', pagePath(preset, p.id))).text).toContain('More outcomes');

      // The classic …/complete endpoint still works on a realistic payment and its pages carry the banner.
      const q = mkPayment(preset);
      const dec = await call('POST', pagePath(preset, q.id) + '/complete', { form: { outcome: 'cancel' } });
      // 400: the page again with a validation error (BNPL / wallet rows here lack a phone): still a bannered page.
      expect([200, 303, 400], dec.text.slice(0, 400)).toContain(dec.status);
      if (dec.status !== 303) expectBanner(dec.text);
    });
  });

  describe('Stripe hosted Checkout (realistic)', () => {
    it('layout: summary with line items, email, card group, back to cancel_url; success redirects to success_url', async () => {
      const s = await stripeSession();
      const entry = await call('GET', new URL(s.cs.url).pathname);
      expect(entry.status).toBe(302);
      const pg = await call('GET', s.page);
      expect(pg.status).toBe(200);
      for (const text of ['data-layout="stripe-hosted"', 'T-shirt', 'Qty 2', '25.00 USD each', '50.00 USD', 'Pay Kit Shop', 'data-testid="stubyard-back"', 'value="buyer@example.com" readonly', 'data-testid="stubyard-card-expiry"', 'data-testid="stubyard-card-cvc"', 'data-testid="stubyard-cardholder"', 'Stripe (simulated)', 'lang="en" dir="ltr"', 'data-testid="stubyard-method-applepay"']) expect(pg.text, text).toContain(text);
      expect(pg.text).toMatch(/<title>\[TEST\] Pay 50\.00 USD · Stripe \(simulated\)<\/title>/);
      expect(pg.text).not.toContain('stripe.com');
      const ok = await call('POST', s.x('pay'), { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toBe(`${appUrl}/ok?sid=${s.cs.id}`);
      const det = (await api('GET', `${PJ}/payments/${s.id}`)).body;
      expect(det).toMatchObject({ status: 'paid', cardLast4: '4242', outcomeVia: 'magic card' });
      // The finished page (GET again) is the kit result screen.
      const again = await call('GET', s.page);
      expect(again.text).toContain('data-testid="stubyard-done"');
      expect(again.text).toContain('data-status="paid"');
      expectBanner(again.text);
    });

    it('decline stays on the page with the message and allows a retry; back / cancel goes to cancel_url', async () => {
      const s = await stripeSession();
      await call('GET', s.page);
      const d = await call('POST', s.x('pay'), { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '9995', card_magic: 'insufficient_funds', card_luhn: '1', card_test: '1' } });
      expect(d.status).toBe(402);
      expect(d.text).toContain('Your card has insufficient funds.');
      expect(d.text).toContain('data-layout="stripe-hosted"');
      expect(d.text).toContain('action="pay"');
      const retry = await call('POST', s.x('pay'), { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' } });
      expect(retry.status).toBe(303);
      const c = await stripeSession();
      const cancel = await call('POST', c.x('pay'), { form: { outcome: 'cancel' } });
      expect(cancel.status).toBe(303);
      expect(cancel.headers.get('location')).toBe(`${appUrl}/cancel`);
    });

    it('3-D Secure: modal with the bank frame, answer once, replay and skip refused', async () => {
      const skip = await stripeSession();
      const sk = await call('POST', skip.x('3ds'), { form: { outcome: '3ds_success' } });
      expect(sk.status).toBe(409);
      expect(sk.text).toContain('data-reason="skip"');
      expect((await call('GET', skip.x('acs'))).status).toBe(409);

      const s = await stripeSession();
      const ch = await call('POST', s.x('pay'), { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' } });
      expect(ch.status).toBe(200);
      expect(ch.text).toContain('data-testid="stubyard-3ds-modal"');
      expect(ch.text).toContain('src="acs"');
      expect(ch.text).toMatch(/<form[^>]+id="pay"[^>]* inert/);
      expectCspCoversScripts(ch.text, ch.headers.get('content-security-policy') ?? '');
      const stored = hub.payments!.repo.get(s.id)!.providerData.checkoutFlow as any;
      expect(stored).toMatchObject({ flow: 'card-3ds', step: 'challenge', answers: { card_magic: '3ds', card_last4: '3155' } });
      const acs = await call('GET', s.x('acs'));
      expect(acs.status).toBe(200);
      expect(acs.text).toContain('data-testid="stubyard-3ds-pass"');
      expect(acs.text).toContain('target="_top"');
      expect(acs.text).toContain('sy-strip');
      expectBanner(acs.text);
      const ok = await call('POST', s.x('3ds'), { form: { outcome: '3ds_success' } });
      expect(ok.status).toBe(303);
      expect(ok.headers.get('location')).toContain('/ok?sid=');
      const replay = await call('POST', s.x('3ds'), { form: { outcome: '3ds_success' } });
      expect(replay.status).toBe(409);
      expect(replay.text).toContain('data-reason="replay"');
      const det = (await api('GET', `${PJ}/payments/${s.id}`)).body;
      expect(det.status).toBe('paid');
      expect(det.events.map((e: any) => e.type)).toContain('step');

      const f = await stripeSession();
      await call('POST', f.x('pay'), { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' } });
      const fail = await call('POST', f.x('3ds'), { form: { outcome: '3ds_fail' } });
      expect(fail.status).toBe(402);
      expect(fail.text).toContain('We are unable to authenticate your payment method.');
    });

    it('Arabic: locale=ar on the session gives an RTL page with the Arabic notice and messages', async () => {
      const s = await stripeSession({ locale: 'ar' });
      const pg = await call('GET', s.page);
      expect(pg.text).toContain('lang="ar" dir="rtl"');
      expectBanner(pg.text, { ar: true });
      expect(pg.text).toContain('ادفع');
      expect(pg.text).toContain('أدوات الاختبار');
      const d = await call('POST', s.x('pay'), { form: { outcome: 'decline', method: 'card' } });
      expect(d.status).toBe(402);
      expect(d.text).toContain('تم رفض بطاقتك.');
      // The English page can switch language from the drawer link (?stubyard_lang=ar).
      const e = await stripeSession();
      expect((await call('GET', e.page)).text).toContain('dir="ltr"');
      expect((await call('GET', e.page + '?stubyard_lang=ar')).text).toContain('dir="rtl"');
    });
  });

  describe('generic realistic page (other gateways)', () => {
    it('STC Pay OTP through the kit steps, then the PayTabs form-post return', async () => {
      const r = await call('POST', '/pay/kit/paytabs/payment/request', {
        json: { profile_id: Number((await api('GET', `${PJ}/payment-instances/paytabs?secrets=1`)).body.config.profileId), tran_type: 'sale', tran_class: 'ecom', cart_id: 'cart-k', cart_description: 'Order K', cart_currency: 'SAR', cart_amount: 20, return: `${appUrl}/pt-return`, callback: `${appUrl}/pt-ipn` },
        headers: { authorization: (await api('GET', `${PJ}/payment-instances/paytabs?secrets=1`)).body.config.serverKey },
      });
      expect(r.status, r.text).toBe(200);
      const id = (await api('GET', `${PJ}/payments/${r.body.tran_ref}`)).body.id as string;
      const x = `/pay/kit/paytabs/page/${id}/x/pay`;
      const first = await call('POST', x, { form: { outcome: 'success', method: 'stcpay', phone: '0551234567' } });
      expect(first.status).toBe(200);
      expect(first.text).toContain('data-testid="stubyard-otp"');
      expect(first.text).toContain('+966 551234567');
      expectBanner(first.text);
      const otp = (hub.payments!.repo.get(id)!.providerData.stc as any).otp as string;
      const wrong = await call('POST', x, { form: { outcome: 'success', method: 'stcpay', phone: '0551234567', otp: otp === '000000' ? '111111' : '000000' } });
      expect(wrong.status).toBe(400);
      expect(wrong.text).toContain('Wrong code');
      const right = await call('POST', x, { form: { outcome: 'success', method: 'stcpay', phone: '0551234567', otp } });
      expect(right.status).toBe(200);
      expect(right.text).toContain(`action="${appUrl}/pt-return"`);
      expect((await api('GET', `${PJ}/payments/${id}`)).body.status).toBe('paid');
    });

    it('3-D Secure on a redirect layout (P1) is a 303 to the full simulated ACS page', async () => {
      const p = mkPayment('checkout');
      const ch = await call('POST', pagePath('checkout', p.id) + '/x/pay', { form: { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '3155', card_magic: '3ds', card_luhn: '1', card_test: '1' } });
      expect(ch.status).toBe(303);
      expect(ch.headers.get('location')).toBe('acs');
      const acs = await call('GET', pagePath('checkout', p.id) + '/x/acs');
      expect(acs.text).toContain('data-testid="stubyard-3ds-bank"');
      expect(acs.text).not.toContain('target="_top"');
    });

    it('Arabic by instance setting; drawer open by setting or ?stubyard_drawer=open', async () => {
      await api('PATCH', `${PJ}/payment-instances/${slugs.get('moyasar')}`, { config: { pageLocale: 'ar', pageDrawer: 'open' } });
      const p = mkPayment('moyasar');
      const pg = await call('GET', pagePath('moyasar', p.id));
      expect(pg.text).toContain('lang="ar" dir="rtl"');
      expectBanner(pg.text, { ar: true });
      expect(pg.text).toContain('data-testid="stubyard-drawer" open');
      expect(pg.text).toContain('النص العربي لم يُراجَع بعد');
      const q = mkPayment('tap');
      expect((await call('GET', pagePath('tap', q.id))).text).not.toContain('data-testid="stubyard-drawer" open');
      expect((await call('GET', pagePath('tap', q.id) + '?stubyard_drawer=open')).text).toContain('data-testid="stubyard-drawer" open');
    });
  });

  describe('hidden test notice', () => {
    it('is reported as a lint finding and never blocks the payment', async () => {
      const s = await stripeSession();
      const pg = await call('GET', s.page);
      expect(pg.text).toContain(`data-notice="${s.id}/x/notice"`);
      const r = await call('POST', s.x('notice'), { form: { reason: 'cropped', framed: '1' } });
      expect(r.status).toBe(204);
      const det = (await api('GET', `${PJ}/payments/${s.id}`)).body;
      expect(det.lint.map((l: any) => l.check)).toContain('pay.test-notice-hidden');
      expect(det.lint.find((l: any) => l.check === 'pay.test-notice-hidden').message).toContain('cropped');
      const ok = await call('POST', s.x('pay'), { form: { outcome: 'success', method: 'card' } });
      expect(ok.status).toBe(303);
    });
  });
});
