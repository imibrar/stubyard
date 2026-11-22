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

/** Checkout kit P3: Tabby / Tamara hosted flows, JazzCash / Easypaisa hosted pages, promo widget routes, classic done-page language. */

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

/** The TEST banner in the page language (the result strip carries one language). */
function anyBanner(html: string) {
  expect(html).toContain('data-testid="stubyard-test-banner"');
  expect(html.includes(TEST_NOTICE.en) || html.includes(TEST_NOTICE.ar)).toBe(true);
  expect(html).toMatch(/<title>\[TEST\] /);
}
const otpOf = (id: string) => String((hub.payments!.repo.get(id)!.providerData.stc as any)?.otp ?? '');
const get = (id: string) => hub.payments!.repo.get(id)!;
const CARD = { method: 'card', card_brand: 'visa', card_last4: '4242', card_magic: 'success', card_luhn: '1', card_test: '1' };
const CARD_3DS = { ...CARD, card_last4: '3220', card_magic: '3ds' };

function tabbyPayment(extra: Record<string, unknown> = {}, buyer: Record<string, string> = {}) {
  return mkPayment('tabby', {
    kind: 'order',
    method: 'bnpl',
    currency: 'AED',
    amount: 40000,
    request: { payment: { buyer: { name: 'Test', phone: '+971500000001', email: 'otp.success@tabby.ai', ...buyer } }, merchant_urls: { success: appUrl + '/ok', cancel: appUrl + '/cancel', failure: appUrl + '/fail' }, lang: 'en' },
    providerData: { methods: ['bnpl'], otpPhone: buyer.phone ?? '+971500000001', ...((extra.providerData as object) ?? {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'providerData')),
  });
}
function tamaraPayment(extra: Record<string, unknown> = {}, phone = '+966500000001') {
  return mkPayment('tamara', {
    kind: 'order',
    method: 'bnpl',
    amount: 30000,
    request: { consumer: { first_name: 'Test', phone_number: phone }, merchant_url: { success: appUrl + '/ok', cancel: appUrl + '/cancel', failure: appUrl + '/fail' }, instalments: 3 },
    providerData: { methods: ['bnpl'], otpPhone: phone },
    ...extra,
  });
}
const jazzPayment = (methods = ['wallet', 'card', 'voucher']) => mkPayment('jazzcash', { currency: 'PKR', amount: 150000, providerData: { methods, phone: '03123456789', txnDateTime: '20261123100000', settlementExpiry: '20261126100000' } });
const epPayment = (methods = ['wallet', 'voucher', 'card']) => mkPayment('easypaisa', { currency: 'PKR', amount: 150000, providerData: { methods, msisdn: '03001234567', autoRedirect: '0' } });

describe('checkout kit P3: BNPL, wallets and promo widgets', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-kit3-'));
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
    for (const preset of ['tabby', 'tamara', 'jazzcash', 'easypaisa', 'paypal'] as PaymentPresetId[]) {
      const r = await api('POST', `${PJ}/payment-instances`, { preset, config: { webhookDelayMs: 0 } });
      expect(r.status, `${preset}: ${r.text}`).toBe(201);
      slugs.set(preset, r.body.slug);
    }
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const x = (preset: PaymentPresetId, id: string, step: string) => pagePath(preset, id) + '/x/' + step;
  const page = async (preset: PaymentPresetId, id: string, q = '') => {
    const r = await call('GET', pagePath(preset, id) + q);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    anyBanner(r.text);
    expectCspCoversScripts(r.text, r.headers.get('content-security-policy') ?? '');
    expectNoExternalAssets(r.text);
    return r;
  };
  const step = async (preset: PaymentPresetId, id: string, name: string, form: Record<string, string | number>, status = 200) => {
    const r = await call('POST', x(preset, id, name), { form });
    expect(r.status, r.text.slice(0, 600)).toBe(status);
    if (status === 200 || status === 400) {
      anyBanner(r.text);
      expectCspCoversScripts(r.text, r.headers.get('content-security-policy') ?? '');
    }
    return r;
  };

  describe('Tabby hosted flow', () => {
    it('phone + email → OTP 8888 (a wrong code first) → plan → card → success_url', async () => {
      const p = tabbyPayment();
      const pg = await page('tabby', p.id);
      expect(pg.text).toContain('data-layout="tabby-hpp"');
      expect(pg.text).toContain('data-screen="phone"');
      expect(pg.text).toContain(`action="${p.id}/x/phone"`);
      expect(pg.text).toContain('value="otp.success@tabby.ai"');
      for (const id of ['stubyard-phone', 'stubyard-email', 'stubyard-decline', 'stubyard-cancel', 'stubyard-drawer', 'stubyard-provider-cancel', 'stubyard-cancel-confirm', 'stubyard-step-no']) expect(pg.text, id).toContain(`data-testid="${id}"`);
      const otp = await step('tabby', p.id, 'phone', { phone: '+971500000001', email: 'otp.success@tabby.ai', method: 'bnpl' });
      expect(otp.text).toContain('data-screen="otp"');
      expect(otp.text).toContain('maxlength="4"');
      const code = otpOf(p.id);
      expect(code).toMatch(/^\d{4}$/);
      const wrong = await step('tabby', p.id, 'otp', { otp: code === '1111' ? '2222' : '1111', method: 'bnpl' });
      expect(wrong.text).toContain('data-screen="otp"');
      expect(wrong.text).toContain('Wrong code, 2 tries left');
      const plan = await step('tabby', p.id, 'otp', { otp: '8888', method: 'bnpl' });
      expect(plan.text).toContain('data-screen="plan"');
      expect(plan.text.match(/data-testid="stubyard-instalment"/g)?.length).toBe(4);
      expect(plan.text).toContain('100.00 AED');
      const card = await step('tabby', p.id, 'plan', { method: 'bnpl' });
      expect(card.text).toContain('data-screen="card"');
      expect(card.text).toContain('data-testid="stubyard-card"');
      expect(card.text).toContain('Pay 100.00 AED');
      const done = await step('tabby', p.id, 'card', { ...CARD, outcome: 'success' }, 303);
      expect(done.headers.get('location')).toBe(`${appUrl}/ok?payment_id=${p.providerRef}`);
      const after = get(p.id);
      expect(after.status).toBe('authorized');
      expect(after.method).toBe('bnpl');
      expect((after.providerData.stc as any).verified).toBe(true);
      const st = (await api('GET', `${PJ}/payments/${p.id}`)).body;
      expect(JSON.stringify(st.events ?? st)).toContain('otp_verified');
    });

    it('steps are kept in order: replay and skip are refused (409); "Change number" goes back', async () => {
      const p = tabbyPayment();
      await page('tabby', p.id);
      expect((await call('POST', x('tabby', p.id, 'plan'), { form: {} })).status).toBe(409);
      await step('tabby', p.id, 'phone', { phone: '+971500000001', email: 'a@b.co' });
      const back = await step('tabby', p.id, 'otp', { back: '1' });
      expect(back.text).toContain('data-screen="phone"');
      await step('tabby', p.id, 'phone', { phone: '+966500000001', email: 'a@b.co' });
      expect((get(p.id).providerData.stc as any).phone).toBe('+966500000001');
      await step('tabby', p.id, 'otp', { otp: '8888' });
      const replay = await call('POST', x('tabby', p.id, 'otp'), { form: { otp: '8888' } });
      expect(replay.status).toBe(409);
      expect(replay.text).toContain('data-testid="stubyard-test-banner"');
      expect((await call('POST', x('tabby', p.id, 'card'), { form: CARD })).status).toBe(409);
      const bad = await step('tabby', p.id, 'phone', { phone: '1' }, 409);
      expect(bad.status).toBe(409);
    });

    it('validation: a bad phone shows the error (400); a missing card on the last screen (400)', async () => {
      const p = tabbyPayment();
      await page('tabby', p.id);
      const r = await step('tabby', p.id, 'phone', { phone: '12' }, 400);
      expect(r.text).toContain('Enter a valid mobile number.');
      await step('tabby', p.id, 'phone', { phone: '+971500000001' });
      await step('tabby', p.id, 'otp', { otp: '8888' });
      await step('tabby', p.id, 'plan', {});
      const c = await step('tabby', p.id, 'card', { method: 'card', outcome: 'success' }, 400);
      expect(c.text).toContain('Enter your card details.');
      // Back from the card to the plan.
      const b = await step('tabby', p.id, 'card', { back: '1' });
      expect(b.text).toContain('data-screen="plan"');
    });

    it('pre-scoring reject phone typed on the first screen: "We can\'t approve this purchase" → failure URL, no SMS', async () => {
      const p = tabbyPayment();
      await page('tabby', p.id);
      const r = await step('tabby', p.id, 'phone', { phone: '+966500000002', email: 'otp.success@tabby.ai' });
      expect(r.text).toContain('data-testid="stubyard-tabby-rejected"');
      expect(r.text).toMatch(/We can(&#39;|&#x27;|')t approve this purchase/);
      expect(r.text).toContain('Sorry, Tabby is unable to approve this purchase, please use an alternative payment method for your order.');
      expect(r.text).toContain(`href="${appUrl}/fail?payment_id=${p.providerRef}"`);
      const after = get(p.id);
      expect(after.status).toBe('failed');
      expect((after.providerData.stc as any).skipped).toBe('prescoring');
      expect((after.providerData.stc as any).otp).toBe('');
      // The page of the finished payment shows the same screen.
      const again = await page('tabby', p.id);
      expect(again.text).toContain('data-testid="stubyard-tabby-rejected"');
    });

    it('a session created with a pre-scoring reject phone is rejected at once (Arabic: the Arabic message)', async () => {
      const p = tabbyPayment({ status: 'failed', providerData: { rejected: true, declineReason: 'generic' } }, { phone: '+971500000002' });
      const r = await page('tabby', p.id, '?stubyard_lang=ar');
      expect(r.text).toContain('lang="ar" dir="rtl"');
      expect(r.text).toContain('لا يمكننا الموافقة على عملية الشراء هذه');
      expect(r.text).toContain('نأسف، تابي غير قادرة على الموافقة على هذه العملية. الرجاء استخدام طريقة دفع أخرى.');
      expect(r.text).toContain('العودة إلى المتجر');
    });

    it('HPP reject buyer otp.rejected@tabby.ai: rejected after the OTP', async () => {
      const p = tabbyPayment();
      await page('tabby', p.id);
      await step('tabby', p.id, 'phone', { phone: '+971500000001', email: 'otp.rejected@tabby.ai' });
      const r = await step('tabby', p.id, 'otp', { otp: '8888' });
      expect(r.text).toContain('data-testid="stubyard-tabby-rejected"');
      expect(get(p.id).status).toBe('failed');
      // The same buyer sent with the checkout (testBuyer) is rejected after the OTP too.
      const q = tabbyPayment({ presetOutcome: 'decline:generic', providerData: { testBuyer: 'otp.rejected' } }, { email: 'otp.rejected@tabby.ai' });
      await page('tabby', q.id);
      await step('tabby', q.id, 'phone', { phone: '+971500000001', email: 'otp.rejected@tabby.ai' });
      expect((await step('tabby', q.id, 'otp', { otp: '8888' })).text).toContain('stubyard-tabby-rejected');
    });

    it('three wrong codes decline (otp_failed)', async () => {
      const p = tabbyPayment();
      await page('tabby', p.id);
      await step('tabby', p.id, 'phone', { phone: '+971500000001' });
      const code = otpOf(p.id);
      const bad = code === '0000' ? '0001' : '0000';
      expect((await step('tabby', p.id, 'otp', { otp: bad })).text).toContain('2 tries left');
      expect((await step('tabby', p.id, 'otp', { otp: bad })).text).toContain('1 tries left');
      const r = await step('tabby', p.id, 'otp', { otp: bad });
      expect(r.text).toContain('stubyard-tabby-rejected');
      const after = get(p.id);
      expect(after.status).toBe('failed');
      expect(after.providerData.declineReason).toBe('otp_failed');
    });

    it('Back to store with a confirmation → cancel_url (EXPIRED); the finished page shows the cancel message', async () => {
      const p = tabbyPayment();
      await page('tabby', p.id);
      await step('tabby', p.id, 'phone', { phone: '+971500000001' });
      const r = await step('tabby', p.id, 'otp', { outcome: 'cancel' }, 303);
      expect(r.headers.get('location')).toBe(`${appUrl}/cancel?payment_id=${p.providerRef}`);
      expect(get(p.id).status).toBe('cancelled');
      const st = await call('GET', `/pay/kit/${slugs.get("tabby")}/api/v2/payments/${p.providerRef}`, { headers: { authorization: 'Bearer sk_test_abcdefgh12345678' } });
      expect(st.body.status).toBe('EXPIRED');
      const pg = await page('tabby', p.id);
      expect(pg.text).toContain('You aborted the payment. Please retry or choose another payment method.');
      const ar = await page('tabby', p.id, '?stubyard_lang=ar');
      expect(ar.text).toContain('لقد ألغيت الدفعة. فضلاً حاول مجددًا أو اختر طريقة دفع أخرى.');
    });

    it('Arabic: every screen in Arabic, right to left', async () => {
      const p = tabbyPayment();
      const pg = await page('tabby', p.id, '?stubyard_lang=ar');
      expect(pg.text).toContain('lang="ar" dir="rtl"');
      expect(pg.text).toContain('رقم الجوال');
      expect(pg.text).toContain('العودة إلى المتجر');
      const otp = await step('tabby', p.id, 'phone', { phone: '+966500000001' });
      expect(otp.text).toContain('أدخل الرمز');
      const plan = await step('tabby', p.id, 'otp', { otp: '8888' });
      expect(plan.text).toContain('خطة الدفع');
      expect(plan.text).toContain('اليوم');
      const card = await step('tabby', p.id, 'plan', {});
      expect(card.text).toContain('ادفع الدفعة الأولى');
      expect(card.text).toContain('lang="ar"');
    });
  });

  describe('Tamara hosted flow', () => {
    it('phone → Send OTP → OTP (filled in) → terms → plan (default from instalments) → card → Pay and Confirm Order', async () => {
      const p = tamaraPayment();
      const pg = await page('tamara', p.id);
      expect(pg.text).toContain('data-layout="tamara-hpp"');
      expect(pg.text).toContain('value="+966500000001"');
      expect(pg.text).toContain('data-testid="stubyard-send-otp"');
      const otp = await step('tamara', p.id, 'phone', { phone: '+966500000001', method: 'bnpl' });
      expect(otp.text).toContain('data-screen="otp"');
      expect(otp.text).toContain(`value="${otpOf(p.id)}"`);
      const terms = await step('tamara', p.id, 'otp', { otp: otpOf(p.id) });
      expect(terms.text).toContain('data-screen="terms"');
      const no = await step('tamara', p.id, 'terms', {}, 400);
      expect(no.text).toContain('Accept the terms and conditions to continue.');
      const plan = await step('tamara', p.id, 'terms', { terms: '1' });
      expect(plan.text).toContain('data-screen="plan"');
      expect(plan.text).toMatch(/value="3" checked/);
      for (const v of ['2', '3', '4', 'full']) expect(plan.text).toContain(`data-testid="stubyard-plan-${v}"`);
      const card = await step('tamara', p.id, 'plan', { plan: '4' });
      expect(card.text).toContain('Pay and Confirm Order');
      expect(card.text).toContain('Today you pay 75.00 SAR.');
      const back = await step('tamara', p.id, 'card', { back: '1' });
      expect(back.text).toMatch(/value="4" checked/);
      await step('tamara', p.id, 'plan', { plan: '2' });
      const done = await step('tamara', p.id, 'card', { ...CARD, outcome: 'success' }, 303);
      expect(done.headers.get('location')).toBe(`${appUrl}/ok?orderId=${p.providerRef}&paymentStatus=approved`);
      const after = get(p.id);
      expect(after.status).toBe('authorized');
      expect((after.providerData.checkoutFlow as any).answers.plan).toBe('2');
    });

    it('a decline phone typed on the page declines after the OTP; 123456 works', async () => {
      const p = tamaraPayment();
      await page('tamara', p.id);
      await step('tamara', p.id, 'phone', { phone: '+966536422337' });
      const r = await step('tamara', p.id, 'otp', { otp: '123456' }, 303);
      expect(r.headers.get('location')).toBe(`${appUrl}/fail?orderId=${p.providerRef}&paymentStatus=declined`);
      expect(get(p.id).status).toBe('failed');
    });

    it('cancel with the confirmation → cancel URL (paymentStatus=canceled); a wrong code is shown again', async () => {
      const p = tamaraPayment();
      await page('tamara', p.id);
      await step('tamara', p.id, 'phone', { phone: '+966500000001' });
      const w = await step('tamara', p.id, 'otp', { otp: '000000' === otpOf(p.id) ? '000001' : '000000' });
      expect(w.text).toContain('Wrong code, 2 tries left');
      await step('tamara', p.id, 'otp', { otp: otpOf(p.id) });
      const r = await step('tamara', p.id, 'terms', { outcome: 'cancel' }, 303);
      expect(r.headers.get('location')).toBe(`${appUrl}/cancel?orderId=${p.providerRef}&paymentStatus=canceled`);
    });

    it('Arabic screens', async () => {
      const p = tamaraPayment();
      const pg = await page('tamara', p.id, '?stubyard_lang=ar');
      expect(pg.text).toContain('lang="ar" dir="rtl"');
      expect(pg.text).toContain('إرسال رمز التحقق');
      await step('tamara', p.id, 'phone', { phone: '+966500000001' });
      const t = await step('tamara', p.id, 'otp', { otp: otpOf(p.id) });
      expect(t.text).toContain('الشروط والأحكام');
      const pl = await step('tamara', p.id, 'terms', { terms: '1' });
      expect(pl.text).toContain('اختر طريقة الدفع');
      expect((await step('tamara', p.id, 'plan', { plan: 'full' })).text).toContain('ادفع وأكّد الطلب');
    });
  });

  describe('JazzCash hosted page', () => {
    it('Mobile Account: number + CNIC → MPIN (not posted) → OTP → signed POST back', async () => {
      const p = jazzPayment();
      const pg = await page('jazzcash', p.id);
      expect(pg.text).toContain('data-layout="jazzcash-hosted"');
      for (const id of ['stubyard-method-wallet', 'stubyard-method-card', 'stubyard-method-voucher', 'stubyard-cnic', 'stubyard-phone']) expect(pg.text, id).toContain(`data-testid="${id}"`);
      expect(pg.text).toContain('Mobile Account');
      const bad = await step('jazzcash', p.id, 'pay', { method: 'wallet', phone: '03123456789', cnic: '12' });
      expect(bad.text).toContain('Enter the last 6 digits of your CNIC.');
      const mpin = await step('jazzcash', p.id, 'pay', { method: 'wallet', phone: '03123456789', cnic: '987654' });
      expect(mpin.text).toContain('data-screen="mpin"');
      expect(mpin.text).not.toMatch(/name="mpin"/);
      expect(JSON.stringify(get(p.id).providerData)).not.toContain('987654');
      const otp = await step('jazzcash', p.id, 'mpin', {});
      expect(otp.text).toContain('data-screen="otp"');
      expect((get(p.id).providerData.stc as any).phone).toBe('+923123456789');
      const w = await step('jazzcash', p.id, 'otp', { otp: 'x' + otpOf(p.id) });
      expect(w.text).toContain('Wrong code, 2 tries left');
      const r = await step('jazzcash', p.id, 'otp', { otp: otpOf(p.id), outcome: 'success' });
      expect(r.text).toContain(`action="${appUrl}/ok"`);
      expect(r.text).toContain('name="pp_SecureHash"');
      expect(r.text).toContain('name="pp_TxnType" value="MWALLET"');
      expect(['paid', 'authorized']).toContain(get(p.id).status);
    });

    it('Voucher: the voucher number and expiry, then the signed POST (124) on Continue', async () => {
      const p = jazzPayment();
      await page('jazzcash', p.id);
      const r = await step('jazzcash', p.id, 'pay', { method: 'voucher', outcome: 'success' });
      expect(r.text).toContain('data-testid="stubyard-voucher"');
      expect(r.text).toContain('2026-11-26 10:00');
      expect(r.text).toContain(`action="${appUrl}/ok"`);
      expect(r.text).toContain('name="pp_ResponseCode" value="124"');
      expect(r.text).toContain('name="pp_SecureHash"');
      expect(r.text).not.toContain('.submit()');
      const rrn = /name="pp_RetreivalReferenceNo" value="(\d+)"/.exec(r.text)?.[1];
      expect(r.text).toContain(`>${rrn}</div>`);
    });

    it('Card: 3-D Secure on the ACS page; the page is English only (D11)', async () => {
      const p = jazzPayment();
      const ar = await page('jazzcash', p.id, '?stubyard_lang=ar');
      expect(ar.text).toContain('Debit / Credit Card');
      expect(ar.text).toContain('data-layout="jazzcash-hosted"');
      expect(ar.text).toMatch(/<form method="post" action="[^"]+\/x\/pay"/);
      const r = await call('POST', x('jazzcash', p.id, 'pay'), { form: { ...CARD_3DS, outcome: 'success' } });
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('acs');
    });
  });

  describe('Easypaisa hosted page', () => {
    it('Mobile Account: number → OTP → redirect to postBackURL (success=true)', async () => {
      const p = epPayment();
      const pg = await page('easypaisa', p.id);
      expect(pg.text).toContain('data-layout="easypaisa-hosted"');
      expect(pg.text).toContain('value="03001234567"');
      const bad = await step('easypaisa', p.id, 'pay', { method: 'wallet', phone: '12345' });
      expect(bad.text).toContain('Enter your Easypaisa mobile account number (03XXXXXXXXX).');
      const otp = await step('easypaisa', p.id, 'pay', { method: 'wallet', phone: '03001234567' });
      expect(otp.text).toContain('data-screen="otp"');
      const r = await step('easypaisa', p.id, 'otp', { otp: otpOf(p.id), outcome: 'success' }, 303);
      const u = new URL(r.headers.get('location')!);
      expect(u.origin + u.pathname).toBe(appUrl + '/ok');
      expect(u.searchParams.get('success')).toBe('true');
    });

    it('OTC voucher: the payment token screen, then the redirect with paymentToken', async () => {
      const p = epPayment();
      await page('easypaisa', p.id);
      const r = await step('easypaisa', p.id, 'pay', { method: 'voucher', outcome: 'success' });
      const token = String(get(p.id).providerData.paymentToken);
      expect(token).toMatch(/^\d{8}$/);
      expect(r.text).toContain(`>${token}</div>`);
      expect(r.text).toContain('<form method="get"');
      expect(r.text).toContain(`name="paymentToken" value="${token}"`);
      expect(r.text).toContain('data-testid="stubyard-voucher-expiry"');
    });

    it('Decline shortcut on the OTP screen finishes at once', async () => {
      const p = epPayment();
      await page('easypaisa', p.id);
      await step('easypaisa', p.id, 'pay', { method: 'wallet', phone: '03001234567' });
      const r = await step('easypaisa', p.id, 'otp', { outcome: 'decline' }, 303);
      expect(new URL(r.headers.get('location')!).searchParams.get('success')).toBe('false');
      expect(get(p.id).status).toBe('failed');
    });
  });

  describe('promo widget routes', () => {
    const inst = (preset: PaymentPresetId) => `/pay/kit/${slugs.get(preset)}`;
    it('Tabby: tabby-promo.js / tabby-card.js, the info popup and the static snippet', async () => {
      for (const f of ['/tabby-promo.js', '/tabby-card.js']) {
        const r = await call('GET', inst('tabby') + f);
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toContain('application/javascript');
        expect(r.headers.get('cache-control')).toBe('no-store');
        expect(r.text).toContain('window.TabbyPromo = TabbyPromo');
        expect(r.text).toContain('window.TabbyCard = TabbyCard');
      }
      const pop = await call('GET', inst('tabby') + '/promos/learn-more?lang=ar&currency=SAR&price=2000.00');
      expect(pop.status).toBe(200);
      anyBanner(pop.text);
      expect(pop.text).toContain(TEST_NOTICE.ar);
      expect(pop.text).toContain('lang="ar"');
      expect(pop.text).toContain('500.00 SAR');
      expect(pop.headers.get('content-security-policy')).toContain("default-src 'none'");
      const sn = await call('GET', inst('tabby') + '/promos/product-page/installments/en/?price=2000.00&currency=AED&merchant_code=x&public_key=y');
      expect(sn.status).toBe(200);
      expect(sn.text).toContain('4 interest-free payments of AED 500.00');
    });

    it('Tamara: widget-v2 script, iframe variant and popup', async () => {
      const js = await call('GET', inst('tamara') + '/widget-v2/tamara-widget.js');
      expect(js.status).toBe(200);
      expect(js.text).toContain("CE.define('tamara-widget'");
      const fr = await call('GET', inst('tamara') + '/widget-v2/tamara-widget.html?lang=en&public_key=k&country=SA&amount=2500&inline_type=2');
      expect(fr.status).toBe(200);
      expectBanner(fr.text);
      expect(fr.text).toContain('Pay SAR 208/mo or in 4 payments. Sharia-compliant.');
      const pop = await call('GET', inst('tamara') + '/widget-v2/popup?lang=en&amount=250&country=SA');
      expect(pop.text).toContain('Your Payment, your Pace');
      expect(pop.text).toContain('Why Tamara?');
      expect(pop.text).toContain('100% buyer protection');
      expect(pop.text).toContain('SAR 64');
      // The API itself still needs the bearer token.
      expect((await call('GET', inst('tamara') + '/orders/x')).status).toBe(401);
    });

    it('PayPal: components=messages adds paypal.Messages; the Learn more popup', async () => {
      const cfg = (await api('GET', `${PJ}/payment-instances/${slugs.get("paypal")}`)).body.config;
      const js = await call('GET', inst('paypal') + '/sdk/js?client-id=' + encodeURIComponent(cfg.clientId) + '&components=buttons,messages');
      expect(js.text).toContain('paypal.Messages = function');
      const pop = await call('GET', inst('paypal') + '/sdk/messages/learn-more?amount=100&currency=USD');
      expect(pop.status).toBe(200);
      expectBanner(pop.text);
      expect(pop.text).toContain('$25.00');
    });
  });

  describe('carry-over: the classic done page honours ?stubyard_lang', () => {
    it('a finished payment opened with ?ui=classic&stubyard_lang=ar is in Arabic', async () => {
      const p = tabbyPayment({ status: 'paid' });
      const r = await call('GET', pagePath('tabby', p.id) + '?ui=classic&stubyard_lang=ar');
      expect(r.status).toBe(200);
      expect(r.text).toContain('lang="ar"');
      expect(r.text).toContain('dir="rtl"');
      const en = await call('GET', pagePath('tabby', p.id) + '?stubyard_lang=en');
      expect(en.text).toContain('lang="en"');
    });
  });
});
