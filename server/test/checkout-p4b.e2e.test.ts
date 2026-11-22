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
import { apsSignature } from '../src/payments/aps/index.js';
import { TEST_NOTICE } from '../src/payments/kit/i18n.js';

/** Payments P4b: Checkout.com Flow, Tap Card SDK v2, MyFatoorah session.js, PayTabs managed form (paylib), APS Merchant Page. */

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
const PJ = '/api/projects/p4b';
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
const I = (preset: string) => `/pay/p4b/${slug[preset]}`;
const det = async (ref: string) => (await api('GET', `${PJ}/payments/${ref}`)).body;
const repoPay = (preset: string, ref: string) => {
  const project = hub.projects.require('p4b');
  const inst = hub.payments!.repo.requireInstance(project.id, slug[preset]!);
  return hub.payments!.repo.byInstanceRef(inst.id, ref)!;
};
const setConfig = async (preset: string, config: Record<string, unknown>) => {
  const r = await api('PATCH', `${PJ}/payment-instances/${slug[preset]}`, { config });
  expect(r.status, r.text).toBe(200);
  return r;
};
const instLint = async (preset: string) => {
  const project = hub.projects.require('p4b');
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

describe('checkout P4b: embedded SDKs', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-p4b-'));
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
    expect((await api('POST', '/api/projects', { name: 'P4b Shop', slug: 'p4b' })).status).toBe(201);
    for (const preset of ['checkout', 'tap', 'myfatoorah', 'paytabs', 'aps']) {
      const r = await api('POST', `${PJ}/payment-instances`, { preset, config: { webhookDelayMs: 0 } });
      expect(r.status, r.text).toBe(201);
      slug[preset] = r.body.slug;
      const project = hub.projects.require('p4b');
      cfg[preset] = hub.payments!.repo.requireInstance(project.id, r.body.slug).config as Record<string, any>;
    }
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const facts = (magicId: string | null, last4: string, brand = 'visa') => ({ brand, last4, magicId, luhn: true, test: true });
  const REAL = { brand: 'visa', last4: '6467', magicId: null, luhn: true, test: false };
  const local = (u: string) => (u.startsWith('http') ? new URL(u).pathname + new URL(u).search : u);
  /** GET a stubyard URL and follow its redirects inside stubyard; the final response and path. */
  async function open(u: string) {
    let p = local(u);
    for (let i = 0; i < 5; i++) {
      const r = await call('GET', p);
      const loc = r.headers.get('location');
      if (r.status < 300 || r.status >= 400 || !loc) return { ...r, path: p };
      const next = new URL(loc, base + p);
      if (next.origin !== base) return { ...r, path: p };
      p = next.pathname + next.search;
    }
    throw new Error('too many redirects: ' + u);
  }
  const pageOf = (p: string) => /^(.*\/page\/[^/?]+)/.exec(p)![1]!;
  /** The 3-D Secure page (opened directly for these card payments), answered. */
  async function acs(u: string, outcome = '3ds_success') {
    const pg = await open(u);
    expect(pg.status, pg.text).toBe(200);
    expect(pg.text).toContain('data-testid="stubyard-3ds-bank"');
    expectCsp(pg.text, pg.headers.get('content-security-policy') ?? '');
    return call('POST', pageOf(pg.path) + '/x/3ds', { form: { outcome } });
  }
  const frameQ = (q: Record<string, string>) => new URLSearchParams({ ch: CH, origin: appUrl, lang: 'en', ...q }).toString();

  describe('Checkout.com Flow', () => {
    const sk = () => ({ authorization: 'Bearer ' + cfg.checkout!.secretKey });
    const session = async (extra: Record<string, unknown> = {}) => {
      const r = await call('POST', I('checkout') + '/payment-sessions', { headers: sk(), json: { amount: 1000, currency: 'SAR', reference: 'ord-' + Math.random().toString(36).slice(2, 8), success_url: appUrl + '/ok', failure_url: appUrl + '/fail', billing: { address: { country: 'SA' } }, ...extra } });
      expect(r.status, r.text).toBe(201);
      return r.body;
    };
    const sessionData = (ps: any, card: unknown) => call('POST', I('checkout') + '/flow/session-data', { json: { key: cfg.checkout!.publicKey, session: ps.id, card } });
    const submit = (ps: any, sd: string, secret = ps.payment_session_secret) => call('POST', I('checkout') + '/flow/submit', { json: { payment_session_id: ps.id, payment_session_secret: secret, session_data: sd } });

    it('serves checkout-web-components with the real global; the frame (EN / AR) with CSP and the page origin', async () => {
      const j = await call('GET', I('checkout') + '/checkout-web-components/index.js');
      expect(j.status).toBe(200);
      expect(j.headers.get('content-type')).toContain('javascript');
      for (const s of ['window.CheckoutWebComponents = CheckoutWebComponents', '/flow/frame?', 'onPaymentCompleted', 'handleSubmit', TEST_NOTICE.en]) expect(j.text, s).toContain(s);
      expectNoWildcardPost(j.text);
      const ps = await session();
      expect(ps.id).toMatch(/^ps_/);
      expect(ps.payment_session_secret).toMatch(/^pss_/);
      expect(JSON.parse(Buffer.from(ps.payment_session_token, 'base64').toString()).id).toBe(ps.id);
      for (const lang of ['en', 'ar']) {
        const f = await call('GET', I('checkout') + '/flow/frame?' + frameQ({ lang, session: ps.id, key: cfg.checkout!.publicKey, component: 'flow', pay: '1', name: '1' }));
        expect(f.status, f.text).toBe(200);
        expect(f.text).toContain(TEST_NOTICE[lang as 'en' | 'ar']);
        expect(f.text).toContain(JSON.stringify(appUrl));
        expectCsp(f.text, f.headers.get('content-security-policy') ?? '');
        expectNoWildcardPost(f.text);
      }
      const pub = await call('GET', I('checkout') + '/flow/payment-sessions/' + ps.id + '?key=' + cfg.checkout!.publicKey, { headers: { origin: appUrl } });
      expect(pub.body).toMatchObject({ id: ps.id, amount: 1000, currency: 'SAR' });
      expect((await call('GET', I('checkout') + '/flow/frame?' + frameQ({ session: 'ps_unknown000', key: cfg.checkout!.publicKey }))).status).toBe(404);
    });

    it('POST /payment-sessions checks its input and the key', async () => {
      const r = await call('POST', I('checkout') + '/payment-sessions', { headers: sk(), json: { amount: 1000, currency: 'SAR', success_url: appUrl + '/ok', failure_url: appUrl + '/fail' } });
      expect(r.status).toBe(422);
      expect(r.text).toContain('billing_address_country_required');
      expect((await call('POST', I('checkout') + '/payment-sessions', { json: { amount: 1000 } })).status).toBe(401);
    });

    it('3-D Secure: Action Required → redirect → ACS → success_url with cko-payment-id; metadata.cko_payment_session_id', async () => {
      const ps = await session();
      const sd = await sessionData(ps, facts('3ds', '3155'));
      expect(sd.status, sd.text).toBe(200);
      expect(sd.body.session_data).toMatch(/^sd_/);
      expect((await submit(ps, sd.body.session_data, 'pss_wrong')).status).toBe(401);
      const r = await submit(ps, sd.body.session_data);
      expect(r.status, r.text).toBeLessThan(300);
      expect(r.body).toMatchObject({ status: 'Action Required', type: 'card', action: { type: 'redirect' } });
      const done = await acs(r.body.action.url);
      expect(done.status).toBe(303);
      const loc = new URL(done.headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe(appUrl + '/ok');
      expect(loc.searchParams.get('cko-payment-id')).toBe(r.body.id);
      const pay = await call('GET', I('checkout') + '/payments/' + r.body.id, { headers: sk() });
      expect(pay.body.status).toBe('Captured');
      expect(pay.body.metadata?.cko_payment_session_id).toBe(ps.id);
    });

    it('a card without 3-D Secure is Approved at once; the session then refuses another submit; a decline is Declined', async () => {
      const ps = await session();
      const sd = await sessionData(ps, facts('success', '4242'));
      const r = await submit(ps, sd.body.session_data);
      expect(r.body.status, r.text).toBe('Approved');
      const sd2 = await sessionData(ps, facts('success', '4242'));
      const again = await submit(ps, sd2.body.session_data);
      expect(again.status).toBe(422);
      const ps2 = await session();
      const d = await submit(ps2, (await sessionData(ps2, facts('decline', '0002'))).body.session_data);
      expect(d.body.status).toBe('Declined');
    });

    it('refuses real card facts (lint), unknown sessions; the demo shop renders (EN / AR)', async () => {
      const ps = await session();
      const r = await sessionData(ps, REAL);
      expect(r.status).toBe(422);
      expect((await instLint('checkout')).map((l) => l.check)).toContain('pay.real-card-entered');
      for (const q of ['', '?lang=ar']) {
        const d = await call('GET', I('checkout') + '/demo' + q);
        expect(d.status, d.text).toBe(200);
        expect(d.text).toContain('/checkout-web-components/index.js');
        expectCsp(d.text, d.headers.get('content-security-policy') ?? '');
      }
    });
  });

  describe('Tap Card SDK v2', () => {
    const token = (card: unknown, extra: Record<string, unknown> = {}) => call('POST', I('tap') + '/card-sdk/tokens', { json: { key: cfg.tap!.publishableKey, card, first_six: '424242', exp_month: 12, exp_year: new Date().getFullYear() + 2, name: 'Jane Jones', no3ds: false, save_card: false, ...extra } });

    it('serves card-sdk/index.js (window.CardSDK) and the frame (EN / AR) with the page origin', async () => {
      const j = await call('GET', I('tap') + '/card-sdk/index.js');
      expect(j.status).toBe(200);
      for (const s of ['window.CardSDK = { renderTapCard: renderTapCard', 'onBinIdentification', 'onChangeSaveCardLater', '/card-sdk/frame?']) expect(j.text, s).toContain(s);
      expectNoWildcardPost(j.text);
      for (const lang of ['en', 'ar']) {
        const f = await call('GET', I('tap') + '/card-sdk/frame?' + frameQ({ lang, key: cfg.tap!.publishableKey, brands: 'VISA,MADA', save: '1' }));
        expect(f.status, f.text).toBe(200);
        expect(f.text).toContain(TEST_NOTICE[lang as 'en' | 'ar']);
        expect(f.text).toContain(JSON.stringify(appUrl));
        expectCsp(f.text, f.headers.get('content-security-policy') ?? '');
      }
      expect((await call('GET', I('tap') + '/card-sdk/frame?' + frameQ({ key: 'pk_test_wrong' }))).status).toBe(401);
    });

    it('tokenize → tok_ → charge → transaction.url → ACS → redirect with tap_id', async () => {
      const t = await token(facts('3ds', '3155'));
      expect(t.status, t.text).toBe(200);
      expect(t.body.id).toMatch(/^tok_/);
      expect(t.body.card).toMatchObject({ last_four: '3155' });
      const ch = await call('POST', I('tap') + '/v2/charges', { headers: { authorization: 'Bearer ' + cfg.tap!.secretKey }, json: { amount: 12, currency: 'SAR', threeDSecure: true, customer: { first_name: 'Jane', email: 'jane@example.com' }, source: { id: t.body.id }, redirect: { url: appUrl + '/tap-back' } } });
      expect(ch.status, ch.text).toBe(200);
      expect(ch.body.status).toBe('INITIATED');
      const done = await acs(ch.body.transaction.url);
      expect(done.status).toBe(303);
      expect(done.headers.get('location')).toContain(appUrl + '/tap-back');
      expect(done.headers.get('location')).toContain('tap_id=' + ch.body.id);
      expect((await call('GET', I('tap') + '/v2/charges/' + ch.body.id, { headers: { authorization: 'Bearer ' + cfg.tap!.secretKey } })).body.status).toBe('CAPTURED');
    });

    it('refuses real card facts and wrong keys; the demo charges a token', async () => {
      expect((await token(REAL)).status).toBe(400);
      expect((await instLint('tap')).map((l) => l.check)).toContain('pay.real-card-entered');
      expect((await call('POST', I('tap') + '/card-sdk/tokens', { json: { key: 'pk_test_nope', card: facts('success', '4242') } })).status).toBe(401);
      const t = await token(facts('success', '4242'));
      const d = await call('POST', I('tap') + '/demo/charge', { json: { token: t.body.id } });
      expect(d.status, d.text).toBe(200);
      expect(d.body.transaction?.url ?? d.body.redirect?.url).toBeTruthy();
      for (const q of ['', '?lang=ar']) expect((await call('GET', I('tap') + '/demo' + q)).status).toBe(200);
    });
  });

  describe('MyFatoorah session.js', () => {
    const auth = () => ({ authorization: 'Bearer ' + cfg.myfatoorah!.apiToken });
    const initiate = async () => {
      const r = await call('POST', I('myfatoorah') + '/v2/InitiateSession', { headers: auth(), json: {} });
      expect(r.status, r.text).toBe(200);
      expect(r.body.IsSuccess).toBe(true);
      return r.body.Data as { SessionId: string; CountryCode: string };
    };
    const submit = (sid: string, paymentType: string, card: unknown = facts('3ds', '3155')) => call('POST', I('myfatoorah') + '/payment/v1/submit', { json: { session: sid, paymentType, card, name: 'Jane Jones' } });
    const execute = (sid: string) => call('POST', I('myfatoorah') + '/v2/ExecutePayment', { headers: auth(), json: { SessionId: sid, InvoiceValue: 5, DisplayCurrencyIso: 'KWD', CustomerName: 'Jane', CallBackUrl: appUrl + '/mf-ok', ErrorUrl: appUrl + '/mf-err' } });

    it('serves session.js (window.myfatoorah) and the frame (EN / AR); InitiateSession answers SessionId + CountryCode', async () => {
      const j = await call('GET', I('myfatoorah') + '/payment/v1/session.js');
      expect(j.status).toBe(200);
      for (const s of ['window.myfatoorah = { init: init', '/payment/v1/frame?']) expect(j.text, s).toContain(s);
      expectNoWildcardPost(j.text);
      const s = await initiate();
      expect(s.CountryCode).toBe('KWT');
      for (const lang of ['en', 'ar']) {
        const f = await call('GET', I('myfatoorah') + '/payment/v1/frame?' + frameQ({ lang, session: s.SessionId, currency: 'KWD', amount: '5.000', options: 'Card,ApplePay,GooglePay,STCPay' }));
        expect(f.status, f.text).toBe(200);
        expect(f.text).toContain(TEST_NOTICE[lang as 'en' | 'ar']);
        expect(f.text).toContain('5.000 KWD');
        expect(f.text).toContain(JSON.stringify(appUrl));
        expectCsp(f.text, f.headers.get('content-security-policy') ?? '');
      }
      expect((await call('GET', I('myfatoorah') + '/payment/v1/frame?' + frameQ({ session: 'nope' }))).status).toBe(404);
    });

    it('card: submit → ExecutePayment(SessionId) → PaymentURL → ACS → framed return posts MF-3DSecure to the page origin', async () => {
      const s = await initiate();
      expect((await execute(s.SessionId)).status).toBe(400);
      await call('GET', I('myfatoorah') + '/payment/v1/frame?' + frameQ({ session: s.SessionId }));
      const sub = await submit(s.SessionId, 'Card');
      expect(sub.body).toMatchObject({ isSuccess: true, sessionId: s.SessionId, paymentType: 'Card', cardBrand: 'Visa' });
      const ex = await execute(s.SessionId);
      expect(ex.status, ex.text).toBe(200);
      expect(ex.body.Data.PaymentURL).toContain('/PayInvoice/Checkout?invoiceKey=');
      expect((await execute(s.SessionId)).status).toBe(400);
      const done = await acs(ex.body.Data.PaymentURL);
      expect(done.status, done.text).toBe(200);
      expect(done.text).toContain("sender:'MF-3DSecure'");
      expect(done.text).toContain(JSON.stringify(appUrl));
      expect(done.text).toContain(appUrl + '/mf-ok?paymentId=');
      expectCsp(done.text, done.headers.get('content-security-policy') ?? '');
      expectNoWildcardPost(done.text);
      const st = await call('POST', I('myfatoorah') + '/v2/GetPaymentStatus', { headers: auth(), json: { Key: String(ex.body.Data.InvoiceId), KeyType: 'InvoiceId' } });
      expect(st.body.Data.InvoiceStatus).toBe('Paid');
    });

    it('Apple Pay is paid at ExecutePayment (PaymentURL is the CallBackUrl); real cards are refused', async () => {
      const s = await initiate();
      expect((await submit(s.SessionId, 'ApplePay', facts('success', '4242'))).body.isSuccess).toBe(true);
      const ex = await execute(s.SessionId);
      expect(ex.status, ex.text).toBe(200);
      expect(ex.body.Data.PaymentURL).toContain(appUrl + '/mf-ok?paymentId=');
      const s2 = await initiate();
      const bad = await submit(s2.SessionId, 'Card', REAL);
      expect(bad.status).toBe(400);
      expect(bad.body.isSuccess).toBe(false);
      expect((await instLint('myfatoorah')).map((l) => l.check)).toContain('pay.real-card-entered');
      for (const q of ['', '?lang=ar']) expect((await call('GET', I('myfatoorah') + '/demo' + q)).status).toBe(200);
    });
  });

  describe('PayTabs managed form (paylib.js)', () => {
    const token = (card: unknown, key = cfg.paytabs!.clientKey) => call('POST', I('paytabs') + '/payment/js/token', { headers: { origin: appUrl }, json: { key, card, first_six: '400000', exp_month: 12, exp_year: new Date().getFullYear() + 2 } });
    const request = (payment_token: string) => call('POST', I('paytabs') + '/payment/request', { headers: { authorization: cfg.paytabs!.serverKey }, json: { profile_id: cfg.paytabs!.profileId, tran_type: 'sale', tran_class: 'ecom', cart_id: 'c-' + Math.random().toString(36).slice(2, 8), cart_currency: 'SAR', cart_amount: 10, cart_description: 'Order', payment_token, return: appUrl + '/pt-back', customer_details: { name: 'Jane', email: 'jane@example.com', country: 'SA' } } });

    it('serves paylib.js (inlineForm, handleError) with the TEST notice; the instance has a client key', async () => {
      const j = await call('GET', I('paytabs') + '/payment/js/paylib.js');
      expect(j.status).toBe(200);
      for (const s of ['window.paylib = { inlineForm: inlineForm, handleError: handleError', 'payment_token', 'data-paylib', TEST_NOTICE.en]) expect(j.text, s).toContain(s);
      expectNoWildcardPost(j.text);
      expect(cfg.paytabs!.clientKey).toMatch(/^C[A-Z0-9]{9}-\d{10}-\d{10}$/);
      const pre = await call('OPTIONS', I('paytabs') + '/payment/js/token', { headers: { origin: appUrl, 'access-control-request-method': 'POST' } });
      expect(pre.status).toBe(204);
    });

    it('payment_token without 3-D Secure: payment_result at once; the token is single use', async () => {
      const t = await token(facts('success', '4242'));
      expect(t.status, t.text).toBe(200);
      const r = await request(t.body.token);
      expect(r.status, r.text).toBe(200);
      expect(r.body.payment_result).toMatchObject({ response_status: 'A' });
      expect(r.body.redirect_url).toBeUndefined();
      expect((await request(t.body.token)).status).toBe(400);
    });

    it('payment_token with 3-D Secure: redirect_url → ACS → signed return', async () => {
      const t = await token(facts('3ds', '3155'));
      const r = await request(t.body.token);
      expect(r.status, r.text).toBe(200);
      expect(r.body.redirect_url).toBeTruthy();
      const done = await acs(r.body.redirect_url);
      expect([200, 303]).toContain(done.status);
      expect(done.text + (done.headers.get('location') ?? '')).toContain(appUrl + '/pt-back');
      const q = await call('POST', I('paytabs') + '/payment/query', { headers: { authorization: cfg.paytabs!.serverKey }, json: { profile_id: cfg.paytabs!.profileId, tran_ref: r.body.tran_ref } });
      expect(q.body.payment_result.response_status).toBe('A');
    });

    it('refuses real cards (lint) and a wrong client key; the demo page renders', async () => {
      expect((await token(REAL)).status).toBe(400);
      expect((await instLint('paytabs')).map((l) => l.check)).toContain('pay.real-card-entered');
      expect((await token(facts('success', '4242'), 'CWRONG')).status).toBe(401);
      for (const q of ['', '?lang=ar']) {
        const d = await call('GET', I('paytabs') + '/demo' + q);
        expect(d.status).toBe(200);
        expect(d.text).toContain('data-paylib="number"');
        expect(d.text).not.toMatch(/data-paylib="number"[^>]*name=/);
      }
    });
  });

  describe('APS Merchant Page', () => {
    const sign = (f: Record<string, string>, phrase = cfg.aps!.shaRequestPhrase) => ({ ...f, signature: apsSignature(f, phrase, 'SHA-256') });
    const creds = () => ({ access_code: cfg.aps!.accessCode, merchant_identifier: cfg.aps!.merchantIdentifier });
    const tokenization = (extra: Record<string, string> = {}) => call('POST', I('aps') + '/FortAPI/paymentPage', { headers: { 'sec-fetch-dest': 'iframe' }, form: sign({ service_command: 'TOKENIZATION', ...creds(), merchant_reference: 'mp-' + Math.random().toString(36).slice(2, 8), language: 'en', return_url: appUrl + '/aps-token', ...extra }) });
    async function tokenName(card = facts('3ds', '3155')) {
      const pg = await tokenization();
      expect(pg.status, pg.text).toBe(200);
      const sess = /"session":"([^"]+)"/.exec(pg.text)![1]!;
      const t = await call('POST', I('aps') + '/FortAPI/merchantPage/token', { json: { session: sess, card, first_six: '400000', exp_month: 12, exp_year: new Date().getFullYear() + 2, name: 'Jane Jones' } });
      return t;
    }
    const purchase = (token_name: string, extra: Record<string, string> = {}) => call('POST', I('aps') + '/FortAPI/paymentApi', { json: sign({ command: 'PURCHASE', ...creds(), merchant_reference: 'o-' + Math.random().toString(36).slice(2, 10), amount: '10000', currency: 'SAR', language: 'en', customer_email: 'jane@example.com', customer_ip: '192.0.2.1', token_name, return_url: appUrl + '/aps-back', ...extra }) });

    it('TOKENIZATION renders the card form for an iframe (EN / AR, TEST notice, no framed-page lint)', async () => {
      for (const language of ['en', 'ar']) {
        const pg = await tokenization({ language });
        expect(pg.status, pg.text).toBe(200);
        expect(pg.text).toContain('data-layout="aps-merchant-page"');
        expect(pg.text).toContain(TEST_NOTICE[language as 'en' | 'ar']);
        expectCsp(pg.text, pg.headers.get('content-security-policy') ?? '');
      }
      expect((await instLint('aps')).map((l) => l.check)).not.toContain('pay.hpp-framed');
      const bad = await call('POST', I('aps') + '/FortAPI/paymentPage', { form: { service_command: 'TOKENIZATION', ...creds(), merchant_reference: 'x', language: 'en', return_url: appUrl + '/aps-token', signature: 'bad' } });
      expect(bad.text).toContain('00008');
    });

    it('the card form answers a signed 18000 response with token_name for return_url', async () => {
      const t = await tokenName();
      expect(t.status, t.text).toBe(200);
      expect(t.body.url).toBe(appUrl + '/aps-token');
      const f = t.body.fields as Record<string, string>;
      expect(f).toMatchObject({ service_command: 'TOKENIZATION', response_code: '18000', status: '18', card_bin: '400000', card_holder_name: 'Jane Jones' });
      expect(f.card_number).toBe('400000******3155');
      expect(f.token_name).toMatch(/^[0-9a-f]{32}$/);
      const { signature, ...rest } = f;
      expect(signature).toBe(apsSignature(rest, cfg.aps!.shaResponsePhrase, 'SHA-256'));
      expect(JSON.stringify(f)).not.toContain('4000002500003155');
    });

    it('PURCHASE with token_name: 3ds_url (20064) → ACS → signed POST to return_url (14000); check_3ds NO pays at once', async () => {
      const t = await tokenName();
      const r = await purchase(t.body.fields.token_name);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ status: '20', response_code: '20064' });
      expect(r.body['3ds_url']).toBeTruthy();
      const done = await acs(r.body['3ds_url']);
      expect(done.status, done.text).toBe(200);
      expect(done.text).toContain(appUrl + '/aps-back');
      expect(done.text).toContain('14000');
      const t2 = await tokenName(facts('success', '4242'));
      const now = await purchase(t2.body.fields.token_name, { check_3ds: 'NO' });
      expect(now.body).toMatchObject({ status: '14', response_code: '14000' });
      const unknown = await purchase('0'.repeat(32));
      expect(unknown.body.response_code).toBe('13024');
    });

    it('refuses real cards (lint); the demo page posts the signed form into its iframe', async () => {
      const t = await tokenName(REAL as any);
      expect(t.status).toBe(400);
      expect((await instLint('aps')).map((l) => l.check)).toContain('pay.real-card-entered');
      for (const q of ['', '?lang=ar']) {
        const d = await call('GET', I('aps') + '/demo' + q);
        expect(d.status, d.text).toBe(200);
        expect(d.text).toContain('name="service_command" value="TOKENIZATION"');
        expect(d.text).toContain('target="aps-mp"');
        expectCsp(d.text, d.headers.get('content-security-policy') ?? '');
      }
    });
  });

  it('the registry lists the five modes as realistic', async () => {
    const { EXPERIENCES } = await import('../src/payments/kit/registry.js');
    const want = [['checkout', 'flow'], ['tap', 'card-sdk'], ['myfatoorah', 'session'], ['paytabs', 'paylib'], ['aps', 'merchant-page']];
    for (const [preset, mode] of want) expect((EXPERIENCES as any[]).find((m) => m.preset === preset && m.mode === mode)?.status, preset + ' ' + mode).toBe('realistic');
  });
});
