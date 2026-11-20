import { createCipheriv, createHash, createHmac } from 'node:crypto';
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
import { apsSignature, apsVerify } from '../src/payments/aps/index.js';
import { easypaisaGateway } from '../src/payments/easypaisa/index.js';
import { jazzcashGateway, jazzcashSecureHash, jazzcashVerify } from '../src/payments/jazzcash/index.js';
import { myfatoorahGateway } from '../src/payments/myfatoorah/index.js';

// Round 4, part C: Amazon Payment Services, MyFatoorah, Geidea, JazzCash, Easypaisa. Signatures are re-implemented
// here from the providers' documented rules (not imported), so a gateway that drifts from the docs fails.

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
type Hit = { path: string; url: string; body: string; headers: http.IncomingHttpHeaders; method: string };
const received: Hit[] = [];

async function call<T = any>(method: string, p: string, opts: { json?: unknown; form?: string | Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = typeof opts.form === 'string' ? opts.form : new URLSearchParams(opts.form).toString();
  }
  const r = await fetch(p.startsWith('http') ? p : base + p, { method, headers, body, redirect: 'manual' });
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
const hitsAt = (p: string) => received.filter((r) => r.path === p);
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Hidden fields of an auto-submitting form (renderFormPost) and its action. */
function formOf(html: string): { action: string; fields: Record<string, string> } {
  const action = decode(/<form method="post" action="([^"]*)"/.exec(html)?.[1] ?? '');
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)"/g)) fields[decode(m[1]!)] = decode(m[2]!);
  return { action, fields };
}
const pageIdOf = (location: string | null) => /page\/([^/?#]+)/.exec(location ?? '')?.[1] ?? '';
/** Submit the stubyard hosted page. */
const payPage = (inst: string, id: string, form: Record<string, string>) => call('POST', '/pay/shop2/' + inst + '/page/' + id + '/complete', { form });

const PJ = '/api/projects/shop2';
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmacB64 = (key: string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest('base64');

describe('payments batch 2 (APS, MyFatoorah, Geidea, JazzCash, Easypaisa)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-pay-b2-'));
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
        const u = new URL(req.url ?? '/', 'http://x');
        received.push({ path: u.pathname, url: req.url ?? '', body, headers: req.headers, method: req.method ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"pp_ResponseCode":"000","pp_ResponseMessage":"OK"}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = 'http://127.0.0.1:' + (appServer.address() as net.AddressInfo).port;
    expect((await api('POST', '/api/projects', { name: 'Shop 2', slug: 'shop2', generateUsers: { admins: 1, customers: 1 } })).status).toBe(201);
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const instance = async (preset: string, config: Record<string, unknown>) => {
    const r = await api('POST', PJ + '/payment-instances', { preset, config: { webhookDelayMs: 0, settleDelayMs: 50, ...config } });
    expect(r.status, r.text).toBe(201);
    return r.body as { slug: string; config: Record<string, any>; connect: { env: Record<string, string>; snippets?: unknown[] } };
  };

  // ------------------------------------------------------------------ APS
  describe('Amazon Payment Services', () => {
    let cfg: Record<string, any>;
    const AP = '/pay/shop2/aps';
    /** Independent: sorted name=value pairs, no separator, wrapped in the phrase, SHA-256 hex. */
    const sig = (p: Record<string, string>, phrase: string) =>
      sha256hex(
        phrase +
          Object.keys(p)
            .filter((k) => k !== 'signature' && p[k] !== '')
            .sort()
            .map((k) => k + '=' + p[k])
            .join('') +
          phrase,
      );
    const page = (extra: Record<string, string> = {}, opts: { badSig?: boolean } = {}) => {
      const f: Record<string, string> = { command: 'PURCHASE', access_code: cfg.accessCode, merchant_identifier: cfg.merchantIdentifier, merchant_reference: 'ord-' + Math.random().toString(36).slice(2, 9), amount: '10000', currency: 'SAR', language: 'en', customer_email: 'buyer@example.com', return_url: appUrl + '/aps-return', ...extra };
      f.signature = opts.badSig ? 'deadbeef' : sig(f, cfg.shaRequestPhrase);
      return call('POST', AP + '/FortAPI/paymentPage', { form: f });
    };
    const apiCall = (body: Record<string, string>) => {
      const b = { access_code: cfg.accessCode, merchant_identifier: cfg.merchantIdentifier, language: 'en', ...body };
      return call('POST', AP + '/FortAPI/paymentApi', { json: { ...b, signature: sig(b, cfg.shaRequestPhrase) } });
    };

    beforeAll(async () => {
      cfg = (await instance('aps', { webhookUrl: appUrl + '/aps-feedback' })).config;
    });

    it('verifies signatures in constant time (any case; wrong length or one changed digit fails)', () => {
      const params = { access_code: 'abc', amount: '1000', command: 'PURCHASE', currency: 'USD', merchant_reference: 'r1' };
      for (const sha of ['SHA-256', 'SHA-512', 'HMAC-256'] as const) {
        const sig = apsSignature(params, 'PASS', sha);
        expect(apsVerify({ ...params, signature: sig }, 'PASS', sha), sha).toBe(true);
        expect(apsVerify({ ...params, signature: sig.toUpperCase() }, 'PASS', sha), sha).toBe(true);
        expect(apsVerify({ ...params, signature: sig.slice(0, -1) }, 'PASS', sha), sha).toBe(false);
        expect(apsVerify({ ...params, signature: (sig[0] === '0' ? '1' : '0') + sig.slice(1) }, 'PASS', sha), sha).toBe(false);
      }
      expect(apsVerify({ ...params, signature: '' }, 'PASS')).toBe(false);
      const f = { pp_Amount: '100', pp_TxnRefNo: 'T1', pp_MerchantID: 'MC1' };
      const h = jazzcashSecureHash(f, 'salt');
      expect(jazzcashVerify({ ...f, pp_SecureHash: h.toLowerCase() }, 'salt')).toBe(true);
      expect(jazzcashVerify({ ...f, pp_SecureHash: h.slice(0, -2) }, 'salt')).toBe(false);
      expect(jazzcashVerify({ ...f, pp_SecureHash: (h[0] === 'A' ? 'B' : 'A') + h.slice(1) }, 'salt')).toBe(false);
      expect(jazzcashVerify({ ...f, pp_SecureHash: '' }, 'salt')).toBe(false);
    });

    it('matches the signature example of the APS docs', () => {
      const params = { access_code: 'SILgpo7pWbmzuURp2qri', amount: '1000', command: 'PURCHASE', currency: 'USD', customer_email: 'test@gmail.com', language: 'en', merchant_identifier: 'MxvOupuG', merchant_reference: 'Test010' };
      expect(apsSignature(params, 'PASS').toUpperCase()).toBe('94C38AFC7BDAE0114FC8C740EDF12416F22998241CE4B4EA70D5521233A2C882');
    });

    it('purchase: page → signed return → feedback → CHECK_STATUS → partial + full refund', async () => {
      const r = await page();
      expect(r.status, r.text).toBe(303);
      const id = pageIdOf(r.headers.get('location'));
      const done = await payPage('aps', id, { outcome: 'success', method: 'card', card_brand: 'visa', card_last4: '0001' });
      expect(done.status).toBe(200);
      const ret = formOf(done.text);
      expect(ret.action).toBe(appUrl + '/aps-return');
      expect(ret.fields.status).toBe('14');
      expect(ret.fields.response_code).toBe('14000');
      expect(ret.fields.card_number).toMatch(/^\d{6}\*{6}0001$/);
      expect(ret.fields.expiry_date).toMatch(/^\d{4}$/);
      expect(ret.fields.signature).toBe(sig(ret.fields, cfg.shaResponsePhrase));
      const fort = ret.fields.fort_id!;
      const fb = await waitFor(() => hitsAt('/aps-feedback').find((h) => new URLSearchParams(h.body).get('fort_id') === fort));
      expect(fb.headers['content-type']).toMatch(/x-www-form-urlencoded/);
      const fbf = Object.fromEntries(new URLSearchParams(fb.body));
      expect(fbf.command).toBe('PURCHASE');
      expect(fbf.signature).toBe(sig(fbf, cfg.shaResponsePhrase));

      const st = await apiCall({ query_command: 'CHECK_STATUS', merchant_reference: ret.fields.merchant_reference! });
      expect(st.body.response_code).toBe('12000');
      expect(st.body.transaction_status).toBe('14');
      expect(st.body.captured_amount).toBe('10000');
      expect(st.body.signature).toBe(sig(st.body, cfg.shaResponsePhrase));

      const r1 = await apiCall({ command: 'REFUND', fort_id: fort, amount: '4000', currency: 'SAR' });
      expect(r1.body.response_code).toBe('06000');
      const over = await apiCall({ command: 'REFUND', fort_id: fort, amount: '9000', currency: 'SAR' });
      expect(over.body.response_code).toBe('07048');
      const r2 = await apiCall({ command: 'REFUND', fort_id: fort, amount: '6000', currency: 'SAR' });
      expect(r2.body.status).toBe('06');
      const refundHook = await waitFor(() => hitsAt('/aps-feedback').filter((h) => new URLSearchParams(h.body).get('command') === 'REFUND' && new URLSearchParams(h.body).get('fort_id') === fort).length === 2);
      expect(refundHook).toBe(true);
      const pay = (await api('GET', PJ + '/payments/' + id)).body;
      expect(pay.status).toBe('refunded');
      expect(pay.lint.some((f: any) => f.check === 'pay.refund-exceeds')).toBe(true);
    });

    it('authorization → capture; another → void; KNET needs PURCHASE', async () => {
      const a = await page({ command: 'AUTHORIZATION' });
      const id = pageIdOf(a.headers.get('location'));
      const ret = formOf((await payPage('aps', id, { outcome: 'success', method: 'card' })).text);
      expect(ret.fields.response_code).toBe('02000');
      const cap = await apiCall({ command: 'CAPTURE', fort_id: ret.fields.fort_id!, amount: '10000', currency: 'SAR' });
      expect(cap.body.response_code).toBe('04000');
      expect((await api('GET', PJ + '/payments/' + id)).body.status).toBe('paid');
      const again = await apiCall({ command: 'CAPTURE', fort_id: ret.fields.fort_id!, amount: '10000', currency: 'SAR' });
      expect(again.body.status).toBe('05');

      const b = await page({ command: 'AUTHORIZATION' });
      const id2 = pageIdOf(b.headers.get('location'));
      const ret2 = formOf((await payPage('aps', id2, { outcome: 'success', method: 'card' })).text);
      const v = await apiCall({ command: 'VOID_AUTHORIZATION', fort_id: ret2.fields.fort_id! });
      expect(v.body.response_code).toBe('08000');
      expect((await api('GET', PJ + '/payments/' + id2)).body.status).toBe('cancelled');
      await waitFor(() => hitsAt('/aps-feedback').some((h) => new URLSearchParams(h.body).get('command') === 'VOID_AUTHORIZATION'));

      const k = await page({ command: 'AUTHORIZATION', payment_option: 'KNET' });
      expect(k.status).toBe(200);
      expect(formOf(k.text).fields.response_code).toBe('00049');
    });

    it('decline code, bad signature, bad access code, decimal amount', async () => {
      const r = await page();
      const ret = formOf((await payPage('aps', pageIdOf(r.headers.get('location')), { outcome: 'decline:insufficient_funds', method: 'card' })).text);
      expect(ret.fields.response_code).toBe('13029');
      expect(ret.fields.signature).toBe(sig(ret.fields, cfg.shaResponsePhrase));
      const bad = await page({}, { badSig: true });
      const bf = formOf(bad.text).fields;
      expect(bf.response_code).toBe('00008');
      expect(bf.response_message).toBe('Signature mismatch');
      const ac = await apiCall({ query_command: 'CHECK_STATUS', merchant_reference: 'x', access_code: 'wrong' });
      expect(ac.body.response_code).toBe('00010');
      const dec = await page({ amount: '100.00' });
      expect(formOf(dec.text).fields.response_code).toBe('00005');
      const lint = (await api('GET', PJ + '/payments/lint')).body.findings.map((f: any) => f.check);
      expect(lint).toContain('pay.aps-signature');
      expect(lint).toContain('pay.aps-amount-unit');
    });
  });

  // ------------------------------------------------------------------ MyFatoorah
  describe('MyFatoorah', () => {
    let cfg: Record<string, any>;
    const MP = '/pay/shop2/myfatoorah';
    const h = () => ({ authorization: 'Bearer ' + cfg.apiToken });
    /** Independent v1 rule: Data properties sorted by name, "Name=value" joined by ",", null → "", base64 HMAC-SHA256. */
    const v1 = (data: Record<string, unknown>, secret: string) =>
      hmacB64(
        secret,
        Object.keys(data)
          .filter((k) => data[k] === null || typeof data[k] !== 'object')
          .sort()
          .map((k) => k + '=' + (data[k] === null ? '' : String(data[k])))
          .join(','),
      );

    beforeAll(async () => {
      cfg = (await instance('myfatoorah', { webhookUrl: appUrl + '/mf-hook', country: 'KWT' })).config;
    });

    it('signs the documented v1 example string', () => {
      const text = 'AuthorizationId=B68413,BaseCurrency=KWD,CreatedDate=04032021211555,CustomerEmail=test@mail.com,CustomerMobile=96512345678,CustomerName=Test Webhook,CustomerReference=12223444,DisplayCurrency=KWD,InvoiceId=586170,InvoiceReference=2021000184,InvoiceValueInBaseCurrency=456.75,InvoiceValueInDisplayCurreny=456.75,InvoiceValueInPayCurrency=456.75,PayCurrency=KWD,PaymentId=100202106359084366,PaymentMethod=KNET,ReferenceId=106310001097,TrackId=04-03-2021_477336,TransactionStatus=SUCCESS,UserDefinedField=';
      const data = Object.fromEntries(text.split(',').map((kv) => kv.split('=') as [string, string]));
      data.UserDefinedField = null as never;
      expect(v1(data, 'secret')).toBe(hmacB64('secret', text));
      expect(myfatoorahGateway.preset).toBe('myfatoorah');
    });

    it('InitiatePayment + ExecutePayment → page → CallBackUrl?paymentId → GetPaymentStatus → webhook → refunds', async () => {
      const init = await call('POST', MP + '/v2/InitiatePayment', { json: { InvoiceAmount: 12.5, CurrencyIso: 'KWD' }, headers: h() });
      expect(init.status, init.text).toBe(200);
      const knet = init.body.Data.PaymentMethods.find((m: any) => m.PaymentMethodCode === 'kn');
      expect(knet.PaymentMethodId).toBe(1);
      const ex = await call('POST', MP + '/v2/ExecutePayment', { json: { PaymentMethodId: knet.PaymentMethodId, InvoiceValue: 12.5, CustomerName: 'Test User', CustomerReference: 'mf-1', CallBackUrl: appUrl + '/mf-ok', ErrorUrl: appUrl + '/mf-err', InvoiceItems: [{ ItemName: 'Book', Quantity: 1, UnitPrice: 12.5 }] }, headers: h() });
      expect(ex.status, ex.text).toBe(200);
      expect(ex.body.IsSuccess).toBe(true);
      const go = await call('GET', ex.body.Data.PaymentURL.replace(/^https?:\/\/[^/]+/, ''));
      expect(go.status).toBe(302);
      const id = pageIdOf(go.headers.get('location'));
      const done = await payPage('myfatoorah', id, { outcome: 'success', method: 'knet' });
      expect(done.status).toBe(303);
      const back = new URL(done.headers.get('location')!);
      expect(back.pathname).toBe('/mf-ok');
      const paymentId = back.searchParams.get('paymentId')!;
      expect(paymentId).toMatch(/^\d{18}$/);
      const st = await call('POST', MP + '/v2/GetPaymentStatus', { json: { Key: paymentId, KeyType: 'PaymentId' }, headers: h() });
      expect(st.body.Data.InvoiceStatus).toBe('Paid');
      expect(st.body.Data.InvoiceTransactions[0].TransactionStatus).toBe('Succss');
      expect(st.body.Data.InvoiceTransactions[0].PaymentGateway).toBe('KNET');
      const hook = await waitFor(() => hitsAt('/mf-hook').find((x) => JSON.parse(x.body).Data?.PaymentId === paymentId));
      const hb = JSON.parse(hook.body);
      expect(hb.EventType).toBe(1);
      expect(hb.Data.TransactionStatus).toBe('SUCCESS');
      expect(hook.headers['myfatoorah-signature']).toBe(v1(hb.Data, cfg.webhookSecret));

      const r1 = await call('POST', MP + '/v2/MakeRefund', { json: { KeyType: 'PaymentId', Key: paymentId, Amount: 2.5, Comment: 'part' }, headers: h() });
      expect(r1.body.IsSuccess, r1.text).toBe(true);
      expect(r1.body.Data.Amount).toBe(2.5);
      const over = await call('POST', MP + '/v2/MakeRefund', { json: { KeyType: 'InvoiceId', Key: String(ex.body.Data.InvoiceId), Amount: 50 }, headers: h() });
      expect(over.status).toBe(400);
      expect(over.body.ValidationErrors[0].Name).toBe('Amount');
      await call('POST', MP + '/v2/MakeRefund', { json: { KeyType: 'InvoiceId', Key: String(ex.body.Data.InvoiceId), Amount: 10 }, headers: h() });
      const rh = await waitFor(() => {
        const l = hitsAt('/mf-hook').filter((x) => JSON.parse(x.body).EventType === 2 && JSON.parse(x.body).Data.InvoiceId === ex.body.Data.InvoiceId);
        return l.length === 2 ? l : null;
      });
      const rb = JSON.parse(rh[0]!.body);
      const { GatewayReference: _g, ...signed } = rb.Data;
      expect(rh[0]!.headers['myfatoorah-signature']).toBe(v1(signed, cfg.webhookSecret));
      expect((await api('GET', PJ + '/payments/' + id)).body.status).toBe('refunded');
    });

    it('SendPayment EML puts the link in the inbox; decline goes to ErrorUrl; v2 webhook; bad token', async () => {
      const users = (await api('GET', PJ + '/users')).body as any[];
      const u = users.find((x) => x.email)!;
      const sp = await call('POST', MP + '/v2/SendPayment', { json: { NotificationOption: 'EML', CustomerName: u.name, CustomerEmail: u.email, InvoiceValue: 3, CallBackUrl: appUrl + '/mf-ok', ErrorUrl: appUrl + '/mf-err', CustomerReference: 'mf-2' }, headers: h() });
      expect(sp.body.Message).toBe('Invoice Created Successfully!');
      const url = sp.body.Data.InvoiceURL as string;
      const msgs = await waitFor(async () => JSON.stringify((await api('GET', PJ + '/messages?limit=20')).body).includes(url));
      expect(msgs).toBeTruthy();
      await api('PATCH', PJ + '/payment-instances/myfatoorah', { config: { webhookVersion: '2' } });
      const go = await call('GET', url.replace(/^https?:\/\/[^/]+/, ''));
      const id = pageIdOf(go.headers.get('location'));
      const done = await payPage('myfatoorah', id, { outcome: 'decline', method: 'card' });
      const back = new URL(done.headers.get('location')!);
      expect(back.pathname).toBe('/mf-err');
      const hook = await waitFor(() => hitsAt('/mf-hook').find((x) => JSON.parse(x.body).Data?.Invoice?.Id === String(sp.body.Data.InvoiceId)));
      const hb = JSON.parse(hook.body);
      expect(hb.Event.Name).toBe('PAYMENT_STATUS_CHANGED');
      expect(hb.Data.Transaction.Status).toBe('FAILED');
      const text = ['Invoice.Id=' + hb.Data.Invoice.Id, 'Invoice.Status=' + hb.Data.Invoice.Status, 'Transaction.Status=' + hb.Data.Transaction.Status, 'Transaction.PaymentId=' + hb.Data.Transaction.PaymentId, 'Invoice.ExternalIdentifier=' + (hb.Data.Invoice.ExternalIdentifier ?? '')].join(',');
      expect(hook.headers['myfatoorah-signature']).toBe(hmacB64(cfg.webhookSecret, text));
      const st = await call('POST', MP + '/v2/GetPaymentStatus', { json: { Key: String(sp.body.Data.InvoiceId), KeyType: 'InvoiceId' }, headers: h() });
      expect(st.body.Data.InvoiceTransactions[0].TransactionStatus).toBe('Failed');
      expect(st.body.Data.InvoiceTransactions[0].ErrorCode).toMatch(/^MF/);
      await api('PATCH', PJ + '/payment-instances/myfatoorah', { config: { webhookVersion: '1' } });
      const bad = await call('POST', MP + '/v2/InitiatePayment', { json: { InvoiceAmount: 1, CurrencyIso: 'KWD' }, headers: { authorization: 'Bearer x' } });
      expect(bad.status).toBe(401);
      expect(bad.body.IsSuccess).toBe(false);
      const inv = await call('POST', MP + '/v2/SendPayment', { json: { NotificationOption: 'LNK', CustomerName: 'x', InvoiceValue: 0 }, headers: h() });
      expect(inv.status).toBe(400);
      expect(inv.body.ValidationErrors[0]).toEqual({ Name: 'InvoiceValue', Error: 'Invoice value must be more than 0' });
    });
  });

  // ------------------------------------------------------------------ Geidea
  describe('Geidea', () => {
    let cfg: Record<string, any>;
    const GP = '/pay/shop2/geidea';
    const auth = () => ({ authorization: 'Basic ' + Buffer.from(cfg.merchantPublicKey + ':' + cfg.apiPassword).toString('base64') });
    const session = async (extra: Record<string, unknown> = {}, opts: { badSig?: boolean } = {}) => {
      const ts = '2026/11/20 10:00:00';
      const body = { amount: 50, currency: 'SAR', timestamp: ts, merchantReferenceId: 'g-' + Math.random().toString(36).slice(2, 8), callbackUrl: appUrl + '/gd-cb', returnUrl: appUrl + '/gd-ret', language: 'en', paymentOperation: 'Pay', ...extra } as Record<string, any>;
      body.signature = opts.badSig ? 'nope' : hmacB64(cfg.apiPassword, cfg.merchantPublicKey + Number(body.amount).toFixed(2) + body.currency + body.merchantReferenceId + ts);
      return call('POST', GP + '/payment-intent/api/v2/direct/session', { json: body, headers: auth() });
    };
    const openPage = async (sid: string) => {
      const r = await call('GET', GP + '/hpp/checkout/?' + sid);
      expect(r.status).toBe(302);
      return pageIdOf(r.headers.get('location'));
    };
    const cbSig = (o: any, ts: string) => hmacB64(cfg.apiPassword, cfg.merchantPublicKey + Number(o.amount).toFixed(2) + o.currency + o.orderId + o.status + o.merchantReferenceId + ts);

    beforeAll(async () => {
      cfg = (await instance('geidea', {})).config;
    });

    it('session → hosted page → return + callback (signed) → fetch order → refunds', async () => {
      const s = await session();
      expect(s.status, s.text).toBe(200);
      expect(s.body.responseCode).toBe('000');
      expect(s.body.session.status).toBe('Initiated');
      const js = await call('GET', GP + '/hpp/geideaCheckout.min.js');
      expect(js.text).toContain('GeideaCheckout');
      const id = await openPage(s.body.session.id);
      const done = await payPage('geidea', id, { outcome: 'success', method: 'mada' });
      const back = new URL(done.headers.get('location')!);
      expect(back.pathname).toBe('/gd-ret');
      expect(back.searchParams.get('responseCode')).toBe('000');
      const orderId = back.searchParams.get('orderId')!;
      const cb = await waitFor(() => hitsAt('/gd-cb').find((x) => JSON.parse(x.body).order.orderId === orderId));
      const cbb = JSON.parse(cb.body);
      expect(cbb.order.status).toBe('Success');
      expect(cbb.signature).toBe(cbSig(cbb.order, cbb.timeStamp));
      const o = await call('GET', GP + '/pgw/api/v1/direct/order/' + orderId, { headers: auth() });
      expect(o.body.order.detailedStatus).toBe('Paid');
      expect(o.body.order.paymentMethod.brand).toBe('mada');
      const ts = '2026/11/20 10:05:00';
      const refund = (amount: number) => call('POST', GP + '/pgw/api/v2/direct/refund', { json: { orderId, refundAmount: amount, timestamp: ts, signature: hmacB64(cfg.apiPassword, ts + cfg.merchantPublicKey + amount.toFixed(2) + orderId) }, headers: auth() });
      const r1 = await refund(20);
      expect(r1.body.order.detailedStatus, r1.text).toBe('PartiallyRefunded');
      const bad = await call('POST', GP + '/pgw/api/v2/direct/refund', { json: { orderId, refundAmount: 5, timestamp: ts, signature: 'x' }, headers: auth() });
      expect(bad.status).toBe(400);
      const r2 = await refund(30);
      expect(r2.body.order.detailedStatus).toBe('Refunded');
      expect(r2.body.order.totalRefundedAmount).toBe(50);
    });

    it('PreAuthorize → capture, PreAuthorize → void, cancel before pay, decline, bad signature, bad auth', async () => {
      const s = await session({ paymentOperation: 'PreAuthorize' });
      const id = await openPage(s.body.session.id);
      const orderId = new URL((await payPage('geidea', id, { outcome: 'success', method: 'card' })).headers.get('location')!).searchParams.get('orderId')!;
      expect((await call('GET', GP + '/pgw/api/v1/direct/order/' + orderId, { headers: auth() })).body.order.detailedStatus).toBe('Authorized');
      const cap = await call('POST', GP + '/pgw/api/v1/direct/capture', { json: { orderId }, headers: auth() });
      expect(cap.body.order.detailedStatus, cap.text).toBe('Captured');

      const s2 = await session({ paymentOperation: 'PreAuthorize' });
      const id2 = await openPage(s2.body.session.id);
      const order2 = new URL((await payPage('geidea', id2, { outcome: 'success', method: 'card' })).headers.get('location')!).searchParams.get('orderId')!;
      const v = await call('POST', GP + '/pgw/api/v3/direct/void', { json: { orderId: order2 }, headers: auth() });
      expect(v.body.order.detailedStatus, v.text).toBe('Voided');

      const s3 = await session();
      const c = await call('POST', GP + '/pgw/api/v1/direct/cancel', { json: { orderId: s3.body.session.orderId, reason: 'CancelledByUser' }, headers: auth() });
      expect(c.body.responseCode).toBe('010');

      const s4 = await session();
      const id4 = await openPage(s4.body.session.id);
      const back = new URL((await payPage('geidea', id4, { outcome: 'decline:expired_card', method: 'card' })).headers.get('location')!);
      expect(back.searchParams.get('responseCode')).not.toBe('000');
      expect(back.searchParams.get('responseMessage')).toBe('Transaction failed - expired card');

      const bs = await session({}, { badSig: true });
      expect(bs.status).toBe(400);
      expect(bs.body.responseCode).toBe('110');
      const ba = await call('POST', GP + '/payment-intent/api/v2/direct/session', { json: {}, headers: { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') } });
      expect(ba.status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ JazzCash
  describe('JazzCash', () => {
    let cfg: Record<string, any>;
    const JP = '/pay/shop2/jazzcash';
    /** Independent: salt + "&" + sorted non-empty pp* values joined with "&", HMAC-SHA256 (salt), upper-case hex. */
    const hash = (f: Record<string, string>, salt: string) =>
      createHmac('sha256', salt)
        .update(
          [
            salt,
            ...Object.keys(f)
              .filter((k) => k.startsWith('pp') && k !== 'pp_SecureHash' && f[k] !== '')
              .sort()
              .map((k) => f[k]),
          ].join('&'),
        )
        .digest('hex')
        .toUpperCase();
    let n = 0;
    const common = (extra: Record<string, string> = {}) => {
      const f: Record<string, string> = { pp_Version: '1.1', pp_TxnType: '', pp_Language: 'EN', pp_MerchantID: cfg.merchantId, pp_SubMerchantID: '', pp_Password: cfg.password, pp_BankID: '', pp_ProductID: '', pp_TxnRefNo: 'T20261120' + String(100000 + n++), pp_Amount: '150000', pp_TxnCurrency: 'PKR', pp_TxnDateTime: '20261120100000', pp_BillReference: 'billRef' + n, pp_Description: 'Order', pp_TxnExpiryDateTime: '20991231235959', pp_ReturnURL: appUrl + '/jc-return', ppmpf_1: 'x', ...extra };
      f.pp_SecureHash = hash(f, cfg.integritySalt);
      return f;
    };

    beforeAll(async () => {
      cfg = (await instance('jazzcash', { webhookUrl: appUrl + '/jc-ipn' })).config;
    });

    it('page redirection: card → signed return → Inquire → partial + full refund', async () => {
      const f = common({ pp_TxnType: 'MPAY' });
      const r = await call('POST', JP + '/CustomerPortal/transactionmanagement/merchantform/', { form: f });
      expect(r.status, r.text).toBe(303);
      const id = pageIdOf(r.headers.get('location'));
      const ret = formOf((await payPage('jazzcash', id, { outcome: 'success', method: 'card' })).text);
      expect(ret.action).toBe(appUrl + '/jc-return');
      expect(ret.fields.pp_ResponseCode).toBe('000');
      expect(ret.fields.pp_TxnRefNo).toBe(f.pp_TxnRefNo);
      expect(ret.fields.pp_SecureHash).toBe(hash(ret.fields, cfg.integritySalt));
      const inq = { pp_TxnRefNo: f.pp_TxnRefNo!, pp_MerchantID: cfg.merchantId, pp_Password: cfg.password, pp_Version: '1.1' } as Record<string, string>;
      const q = await call('POST', JP + '/ApplicationAPI/API/PaymentInquiry/Inquire', { json: { ...inq, pp_SecureHash: hash(inq, cfg.integritySalt) } });
      expect(q.body.pp_ResponseCode).toBe('000');
      expect(q.body.pp_Status).toBe('Completed');
      expect(q.body.pp_SecureHash).toBe(hash(q.body, cfg.integritySalt));
      const refund = (amount: string) => {
        const b = { pp_TxnRefNo: f.pp_TxnRefNo!, pp_Amount: amount, pp_TxnCurrency: 'PKR', pp_MerchantID: cfg.merchantId, pp_Password: cfg.password };
        return call('POST', JP + '/ApplicationAPI/API/authorize/Refund', { json: { ...b, pp_SecureHash: hash(b, cfg.integritySalt) } });
      };
      expect((await refund('50000')).body.pp_ResponseCode).toBe('000');
      expect((await refund('200000')).body.pp_ResponseCode).not.toBe('000');
      expect((await refund('100000')).body.pp_ResponseCode).toBe('000');
      expect((await api('GET', PJ + '/payments/' + id)).body.status).toBe('refunded');
    });

    it('voucher: 124 at return, IPN with 121 when settled (verified hash)', async () => {
      const f = common({ pp_TxnType: 'OTC' });
      const r = await call('POST', JP + '/CustomerPortal/transactionmanagement/merchantform/', { form: f });
      const id = pageIdOf(r.headers.get('location'));
      const ret = formOf((await payPage('jazzcash', id, { outcome: 'pending_then_success', method: 'voucher' })).text);
      expect(ret.fields.pp_ResponseCode).toBe('124');
      const ipn = await waitFor(() => hitsAt('/jc-ipn').find((x) => JSON.parse(x.body).pp_TxnRefNo === f.pp_TxnRefNo));
      const b = JSON.parse(ipn.body);
      expect(b.pp_ResponseCode).toBe('121');
      expect(b.pp_SecureHash).toBe(hash(b, cfg.integritySalt));
      expect((await api('GET', PJ + '/payments/' + id)).body.status).toBe('paid');
    });

    it('mobile-account REST purchase, decline, bad hash, non-PKR', async () => {
      const w = common({ pp_TxnType: 'MWALLET', pp_MobileNumber: '03123456789', pp_CNIC: '345678', pp_ReturnURL: '' });
      delete (w as any).pp_ReturnURL;
      w.pp_SecureHash = hash(w, cfg.integritySalt);
      const ok = await call('POST', JP + '/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction', { json: w });
      expect(ok.body.pp_ResponseCode, ok.text).toBe('000');
      expect(ok.body.pp_SecureHash).toBe(hash(ok.body, cfg.integritySalt));
      const d = common({ pp_TxnType: 'MWALLET', pp_MobileNumber: '03123456789', pp_CNIC: '345678' });
      const dec = await call('POST', JP + '/ApplicationAPI/API/2.0/Purchase/DoMWalletTransaction', { json: d, headers: { 'x-hub-payment-outcome': 'decline:insufficient_funds' } });
      expect(dec.body.pp_ResponseCode).toBe('004');
      const bad = { ...common({ pp_TxnType: 'MPAY' }), pp_SecureHash: 'ABC' };
      const bp = await call('POST', JP + '/CustomerPortal/transactionmanagement/merchantform/', { form: bad });
      expect(formOf(bp.text).fields.pp_ResponseCode).toBe('110');
      const usd = await call('POST', JP + '/CustomerPortal/transactionmanagement/merchantform/', { form: common({ pp_TxnCurrency: 'USD' }) });
      expect(formOf(usd.text).fields.pp_ResponseCode).toBe('110');
      const lint = (await api('GET', PJ + '/payments/lint')).body.findings.map((f: any) => f.check);
      expect(lint).toContain('pay.jazzcash-secure-hash');
      expect(lint).toContain('pay.jazzcash-amount');
    });

    it('lateLint: never inquired', async () => {
      const inst = hub.payments.repo.getInstance(hub.projects.require('shop2').id, 'jazzcash')!;
      const p = hub.payments.repo.list(hub.projects.require('shop2').id, { instanceId: inst.id, status: ['paid'], limit: 1 })[0]!;
      expect(jazzcashGateway.lateLint!(hub.payments, p, inst).map((f) => f.check)).toEqual(['pay.jazzcash-never-inquired']);
    });
  });

  // ------------------------------------------------------------------ Easypaisa
  describe('Easypaisa', () => {
    let cfg: Record<string, any>;
    const EP = '/pay/shop2/easypaisa';
    /** Independent: sorted "k=v&…" of the posted fields, AES-128-ECB (PKCS5), base64. */
    const hashReq = (f: Record<string, string>, key: string) => {
      const plain = Object.keys(f)
        .filter((k) => f[k] !== '')
        .sort()
        .map((k) => k + '=' + f[k])
        .join('&');
      const c = createCipheriv('aes-128-ecb', Buffer.from(key), null);
      return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');
    };
    const creds = () => ({ credentials: Buffer.from(cfg.username + ':' + cfg.password).toString('base64') });
    let n = 0;
    const checkout = async (extra: Record<string, string> = {}, opts: { badHash?: boolean } = {}) => {
      const f: Record<string, string> = { storeId: cfg.storeId, amount: '10.0', postBackURL: appUrl + '/ep-back', orderRefNum: 'ep-' + n++ + '-' + Math.random().toString(36).slice(2, 6), expiryDate: '20991231 235959', autoRedirect: '1', paymentMethod: 'CC_PAYMENT_METHOD', emailAddr: 'buyer@example.com', mobileNum: '03001234567', ...extra };
      f.merchantHashedReq = opts.badHash ? hashReq({ ...f, amount: '99.0' }, cfg.hashKey) : hashReq(f, cfg.hashKey);
      const r = await call('POST', EP + '/easypay/Index.jsf', { form: f });
      return { r, f };
    };
    const confirmAndPay = async (r: Awaited<ReturnType<typeof checkout>>['r'], form: Record<string, string>) => {
      const loc = new URL(r.headers.get('location')!);
      const tok = loc.searchParams.get('auth_token')!;
      const c = await call('POST', EP + '/easypay/Confirm.jsf', { form: { auth_token: tok, postBackURL: appUrl + '/ep-final' } });
      expect(c.status).toBe(303);
      const id = pageIdOf(c.headers.get('location'));
      const done = await payPage('easypaisa', id, form);
      return { id, back: new URL(done.headers.get('location')!) };
    };

    beforeAll(async () => {
      cfg = (await instance('easypaisa', { webhookUrl: appUrl + '/ep-ipn' })).config;
    });

    it('Index.jsf → auth_token → Confirm.jsf → page → postBackURL → GET IPN → details URL → inquire', async () => {
      const { r, f } = await checkout();
      expect(r.status, r.text).toBe(302);
      const loc = new URL(r.headers.get('location')!);
      expect(loc.pathname).toBe('/ep-back');
      expect(loc.searchParams.get('postBackURL')).toBe(appUrl + '/ep-back');
      const { id, back } = await confirmAndPay(r, { outcome: 'success', method: 'card' });
      expect(back.pathname).toBe('/ep-final');
      expect(back.searchParams.get('status')).toBe('0000');
      expect(back.searchParams.get('success')).toBe('true');
      expect(back.searchParams.get('orderRefNumber')).toBe(f.orderRefNum);
      const ipn = await waitFor(() => hitsAt('/ep-ipn').at(-1));
      expect(ipn.method).toBe('GET');
      const detailsUrl = new URL(ipn.url, 'http://x').searchParams.get('url')!;
      expect(detailsUrl).toContain('/easypay-service/rest/ipn/');
      const details = await call('GET', detailsUrl);
      expect(details.body.transaction_status).toBe('PAID');
      expect(details.body.order_id).toBe(f.orderRefNum);
      expect(details.body.payment_method).toBe('CC');
      const ev = (await api('GET', PJ + '/payments/' + id)).body.events.map((e: any) => e.type);
      expect(ev).toContain('ipn_fetched');
      const inq = await call('POST', EP + '/easypay-service/rest/v4/inquire-transaction', { json: { orderId: f.orderRefNum, storeId: cfg.storeId, accountNum: cfg.accountNum }, headers: creds() });
      expect(inq.body.transactionStatus).toBe('PAID');
      expect(inq.body.responseCode).toBe('0000');
      // No refund API: dashboard / control API refunds (partial + full).
      expect((await api('POST', PJ + '/payments/' + id + '/refund', { amount: 400 })).status).toBe(200);
      expect((await api('POST', PJ + '/payments/' + id + '/refund', {})).body.payment.status).toBe('refunded');
    });

    it('OTC voucher shows a payment token; REST MA initiate; decline; bad hash; bad credentials', async () => {
      const { r } = await checkout({ paymentMethod: 'OTC_PAYMENT_METHOD' });
      const { back } = await confirmAndPay(r, { outcome: 'pending_then_success', method: 'voucher' });
      expect(back.searchParams.get('paymentToken')).toMatch(/^\d{8}$/);
      const ma = await call('POST', EP + '/easypay-service/rest/v4/initiate-ma-transaction', { json: { orderId: 'ma-1', storeId: cfg.storeId, transactionAmount: '25.0', transactionType: 'MA', mobileAccountNo: '03451234567', emailAddress: 'a@b.c' }, headers: creds() });
      expect(ma.body.responseCode, ma.text).toBe('0000');
      expect(ma.body.transactionId).toMatch(/^\d+$/);
      const { r: r2 } = await checkout();
      const { back: b2 } = await confirmAndPay(r2, { outcome: 'decline:insufficient_funds', method: 'card' });
      expect(b2.searchParams.get('success')).toBe('false');
      expect(b2.searchParams.get('status')).toBe('0014');
      const { r: bad } = await checkout({}, { badHash: true });
      expect(bad.status).toBe(400);
      const nc = await call('POST', EP + '/easypay-service/rest/v4/inquire-transaction', { json: { orderId: 'ma-1', storeId: cfg.storeId }, headers: {} });
      expect(nc.status).toBe(401);
      const lint = (await api('GET', PJ + '/payments/lint')).body.findings.map((f: any) => f.check);
      expect(lint).toContain('pay.easypaisa-hash');
    });

    it('lateLint: IPN delivered but never fetched', async () => {
      const { r } = await checkout();
      const { id } = await confirmAndPay(r, { outcome: 'success', method: 'card' });
      await waitFor(async () => ((await api('GET', PJ + '/payments/' + id)).body.events as any[]).some((e) => e.type === 'webhook_delivered'));
      const p = hub.payments.repo.get(id)!;
      const inst = hub.payments.instanceOf(p);
      expect(easypaisaGateway.lateLint!(hub.payments, p, inst).map((f) => f.check)).toEqual(['pay.easypaisa-ipn-not-fetched']);
    });
  });

  // ------------------------------------------------------------------ shared
  describe('runs, presets, export', () => {
    it('lists the five presets with logos and fields', async () => {
      const presets = (await api('GET', '/api/payment-presets')).body.presets as any[];
      for (const id of ['aps', 'myfatoorah', 'geidea', 'jazzcash', 'easypaisa']) expect(presets.some((p) => p.id === id && p.available)).toBe(true);
    });

    it('run isolation through /run/<key>', async () => {
      const run = (await api('POST', PJ + '/runs', { key: 'b2run' })).body;
      const cfg = (await api('GET', PJ + '/payment-instances/geidea?secrets=1')).body.config;
      const ts = 't1';
      const body = { amount: 5, currency: 'SAR', timestamp: ts, merchantReferenceId: 'run-1', signature: hmacB64(cfg.apiPassword, cfg.merchantPublicKey + '5.00' + 'SAR' + 'run-1' + ts) };
      const s = await call('POST', '/run/' + run.key + '/pay/shop2/geidea/payment-intent/api/v2/direct/session', { json: body, headers: { authorization: 'Basic ' + Buffer.from(cfg.merchantPublicKey + ':' + cfg.apiPassword).toString('base64') } });
      expect(s.status, s.text).toBe(200);
      const inRun = (await api('GET', PJ + '/payments?run=' + run.key)).body as any[];
      expect(inRun.map((p) => p.reference)).toEqual(['run-1']);
      await api('POST', PJ + '/runs/' + run.key + '/stop', {});
    });

    it('export keeps the instances and hides secrets without ?secrets=1', async () => {
      const plain = await api('GET', '/api/projects/shop2/export');
      const text = JSON.stringify(plain.body);
      for (const preset of ['aps', 'myfatoorah', 'geidea', 'jazzcash', 'easypaisa']) expect(text).toContain('"preset":"' + preset + '"');
      const secret = (await api('GET', PJ + '/payment-instances?secrets=1')).body as any[];
      for (const i of secret) {
        for (const k of ['shaRequestPhrase', 'shaResponsePhrase', 'apiToken', 'webhookSecret', 'apiPassword', 'integritySalt', 'password', 'hashKey']) {
          if (i.config[k]) expect(text).not.toContain(String(i.config[k]));
        }
      }
      const full = await api('GET', '/api/projects/shop2/export?secrets=1');
      const im = await api('POST', '/api/projects/import', { ...full.body, project: { ...full.body.project, name: 'Shop 2 copy', slug: 'shop2-copy' } });
      expect(im.status, im.text).toBeLessThan(300);
      const copy = (await api('GET', '/api/projects/shop2-copy/payment-instances?secrets=1')).body as any[];
      const orig = secret.find((i) => i.preset === 'jazzcash');
      expect(copy.find((i) => i.preset === 'jazzcash').config.integritySalt).toBe(orig.config.integritySalt);
    });
  });
});
