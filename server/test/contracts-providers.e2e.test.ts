import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import type { Hub } from '../src/hub.js';
import { createHub } from '../src/index.js';
import { contractModeOf } from '../src/contracts/providers/index.js';

// C1 slice S11a: provider contracts for the built-in fakes (framework + Stripe). config.contract on the payment
// instance: off (default) / report / strict. In-memory hub, no Mailpit.

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
let stripeKey = '';

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

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

const logOf = (res: { headers: Headers }) => {
  const id = res.headers.get('x-hub-request-id')!;
  expect(id).toBeTruthy();
  return waitFor(() => {
    const l = hub.traffic.repo.get(id);
    return l && l.respondedAt ? l : null;
  });
};

const form = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const stripe = (method: string, p: string, body?: Record<string, string | number>) =>
  call(method, `/pay/shop/stripe${p}`, { ...(body ? { form: form(body) } : {}), headers: { authorization: `Bearer ${stripeKey}` } });
const setMode = async (contract: string | null) => {
  const r = await call('PATCH', '/api/projects/shop/payment-instances/stripe', { json: { config: { contract } } });
  expect(r.status, r.text).toBe(200);
};

describe('provider contracts (C1 S11a)', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-contracts-prov-'));
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
    expect((await call('POST', '/api/projects', { json: { name: 'Shop', slug: 'shop' } })).status).toBe(201);
    const s = await call('POST', '/api/projects/shop/payment-instances', { json: { preset: 'stripe-checkout', config: { webhookDelayMs: 0 } } });
    expect(s.status, s.text).toBe(201);
    expect(s.body.slug).toBe('stripe');
    stripeKey = s.body.config.secretKey;
  });

  afterAll(async () => {
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the mode from config.contract (default off)', () => {
    expect(contractModeOf({})).toBe('off');
    expect(contractModeOf({ contract: 'nonsense' })).toBe('off');
    expect(contractModeOf({ contract: 'report' })).toBe('report');
    expect(contractModeOf({ contract: 'strict' })).toBe('strict');
    expect(contractModeOf({ contract: true })).toBe('strict');
    expect(contractModeOf({ contractMode: 'report' })).toBe('report');
  });

  it('off (default): no contract on the log, the fake answers as before', async () => {
    const r = await stripe('POST', '/v1/payment_intents', { currency: 'usd', bogus: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/amount/i);
    const log = await logOf(r);
    expect(log.contract).toBeNull();
    expect(log.contractLevel).toBeNull();
  });

  it('report: issues are recorded on the traffic log and the fake still answers', async () => {
    await setMode('report');
    const r = await stripe('POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', bogus: 'x' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.object).toBe('payment_intent');
    const log = await logOf(r);
    expect(log.contract).toMatchObject({
      v: 1,
      subject: 'provider-request',
      source: 'provider',
      spec: null,
      provider: { preset: 'stripe-checkout', instance: 'stripe' },
      operation: { key: 'POST /v1/payment_intents', operationId: 'PostPaymentIntents' },
      mode: 'report',
      enforced: false,
      level: 'error',
    });
    expect(log.contract!.issues[0]).toMatchObject({ check: 'contract.body', pointer: '/bogus' });
    expect(log.contractLevel).toBe('error');
    expect(log.resolved.contract).toMatchObject({ spec: 'stripe-checkout', operation: 'POST /v1/payment_intents', level: 'error' });
  });

  it('report: a valid request is recorded clean; endpoints outside the contract are not recorded', async () => {
    const r = await stripe('POST', '/v1/payment_intents', { amount: 1500, currency: 'eur', capture_method: 'manual', 'metadata[order_id]': 'o-1', 'payment_method_types[]': 'card' });
    expect(r.status, r.text).toBe(200);
    const log = await logOf(r);
    expect(log.contract).toMatchObject({ mode: 'report', level: null, counts: { error: 0, warn: 0, info: 0 } });

    const other = await stripe('GET', '/v1/customers/cus_1');
    expect(other.status).toBe(404);
    expect((await logOf(other)).contract).toBeNull();
  });

  describe('strict', () => {
    beforeAll(() => setMode('strict'));
    afterAll(() => setMode(null));

    it('missing amount → Stripe-shaped 400 with param', async () => {
      const r = await stripe('POST', '/v1/payment_intents', { currency: 'usd' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ type: 'invalid_request_error', code: 'parameter_missing', param: 'amount', message: 'Missing required param: amount.' });
      const log = await logOf(r);
      expect(log.contract).toMatchObject({ mode: 'strict', enforced: true, level: 'error' });
      expect(log.outcome).toBe('invalid');
      expect(log.resolved.contractEnforced).toBe(true);
    });

    it('unknown param → parameter_unknown', async () => {
      const r = await stripe('POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', amout: 5 });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ type: 'invalid_request_error', code: 'parameter_unknown', param: 'amout', message: 'Received unknown parameter: amout' });
    });

    it('bad currency, bad enum, non-integer amount → param named', async () => {
      const cur = await stripe('POST', '/v1/payment_intents', { amount: 2000, currency: 'USDX' });
      expect(cur.status).toBe(400);
      expect(cur.body.error).toMatchObject({ type: 'invalid_request_error', param: 'currency' });

      const cap = await stripe('POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', capture_method: 'later' });
      expect(cap.body.error).toMatchObject({ param: 'capture_method' });
      expect(cap.body.error.message).toMatch(/automatic/);

      const amt = await stripe('POST', '/v1/payment_intents', { amount: '12.5', currency: 'usd' });
      expect(amt.body.error).toMatchObject({ code: 'parameter_invalid_integer', param: 'amount', message: 'Invalid integer: 12.5' });

      const zero = await stripe('POST', '/v1/payment_intents', { amount: 0, currency: 'usd' });
      expect(zero.body.error).toMatchObject({ code: 'parameter_invalid_integer', param: 'amount' });
    });

    it('nested params use bracket notation', async () => {
      const r = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        success_url: 'http://127.0.0.1/ok',
        cancel_url: 'http://127.0.0.1/cancel',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': 'ten',
        'line_items[0][price_data][product_data][name]': 'T-shirt',
        'line_items[0][quantity]': 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'parameter_invalid_integer', param: 'line_items[0][price_data][unit_amount]' });
    });

    it('unknown query params on a retrieve are rejected too', async () => {
      const r = await stripe('GET', '/v1/payment_intents/pi_missing?foo=1');
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'parameter_unknown', param: 'foo' });
    });

    it('valid create → the normal answer and no issues', async () => {
      const r = await stripe('POST', '/v1/payment_intents', { amount: 2000, currency: 'usd', 'automatic_payment_methods[enabled]': 'true', 'expand[]': 'latest_charge' });
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ object: 'payment_intent', amount: 2000, currency: 'usd' });
      const log = await logOf(r);
      expect(log.contract).toMatchObject({ mode: 'strict', enforced: false, level: null, issues: [] });

      const s = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'payment',
        success_url: 'http://127.0.0.1/ok',
        cancel_url: 'http://127.0.0.1/cancel',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': 2500,
        'line_items[0][price_data][product_data][name]': 'T-shirt',
        'line_items[0][quantity]': 2,
        client_reference_id: 'order-1',
      });
      expect(s.status, s.text).toBe(200);
      expect((await logOf(s)).contract).toMatchObject({ level: null });
      const got = await stripe('GET', `/v1/checkout/sessions/${s.body.id}?expand[]=payment_intent`);
      expect(got.status, got.text).toBe(200);
      expect((await logOf(got)).contract).toMatchObject({ operation: { key: 'GET /v1/checkout/sessions/{session}' }, level: null });
    });
  });

  // C1 slice S11b: PayPal and Moyasar.
  describe('PayPal (S11b)', () => {
    let ppToken = '';
    const pp = (method: string, p: string, json?: unknown) => call(method, `/pay/shop/paypal${p}`, { ...(json !== undefined ? { json } : {}), headers: { authorization: `Bearer ${ppToken}` } });
    const ppMode = async (contract: unknown) => {
      const r = await call('PATCH', '/api/projects/shop/payment-instances/paypal', { json: { config: { contract } } });
      expect(r.status, r.text).toBe(200);
    };
    const order = (over: Record<string, unknown> = {}) => ({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: 'o-1', amount: { currency_code: 'USD', value: '10.00' } }],
      payment_source: { paypal: { experience_context: { return_url: 'http://127.0.0.1/ok', cancel_url: 'http://127.0.0.1/cancel' } } },
      ...over,
    });

    beforeAll(async () => {
      const p = await call('POST', '/api/projects/shop/payment-instances', { json: { preset: 'paypal', config: { webhookDelayMs: 0 } } });
      expect(p.status, p.text).toBe(201);
      expect(p.body.slug).toBe('paypal');
      const cfg = p.body.config;
      const t = await call('POST', '/pay/shop/paypal/v1/oauth2/token', {
        form: 'grant_type=client_credentials',
        headers: { authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64') },
      });
      expect(t.status, t.text).toBe(200);
      ppToken = t.body.access_token;
    });

    it('off (default): the fake answers its own error, no contract recorded', async () => {
      const r = await pp('POST', '/v2/checkout/orders', order({ intent: undefined }));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ name: 'INVALID_REQUEST', details: [{ field: '/intent', issue: 'MISSING_REQUIRED_PARAMETER' }] });
      expect((await logOf(r)).contract).toBeNull();
    });

    it('report: issues recorded, the fake still answers', async () => {
      await ppMode('report');
      const r = await pp('POST', '/v2/checkout/orders', order({ purchase_units: [{ reference_id: 'o-1', amount: { currency_code: 'USD', value: '10.00' }, soft_descriptor: 'x'.repeat(40) }] }));
      expect(r.status, r.text).toBe(201);
      const log = await logOf(r);
      expect(log.contract).toMatchObject({ provider: { preset: 'paypal', instance: 'paypal' }, operation: { key: 'POST /v2/checkout/orders', operationId: 'orders.create' }, mode: 'report', enforced: false, level: 'error' });
      expect(log.contract!.issues[0]).toMatchObject({ check: 'contract.body', pointer: '/purchase_units/0/soft_descriptor' });
    });

    describe('strict', () => {
      beforeAll(() => ppMode(true));
      afterAll(() => ppMode(null));

      it('missing purchase_units → PayPal INVALID_REQUEST with details', async () => {
        const r = await pp('POST', '/v2/checkout/orders', { intent: 'CAPTURE' });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({
          name: 'INVALID_REQUEST',
          message: 'Request is not well-formed, syntactically incorrect, or violates schema.',
          details: [{ field: '/purchase_units', location: 'body', issue: 'MISSING_REQUIRED_PARAMETER', description: 'A required field / parameter is missing.' }],
        });
        expect(typeof r.body.debug_id).toBe('string');
        const log = await logOf(r);
        expect(log.contract).toMatchObject({ mode: 'strict', enforced: true, level: 'error' });
        expect(log.outcome).toBe('invalid');
      });

      it('bad intent, currency and decimal value → one detail each', async () => {
        const r = await pp('POST', '/v2/checkout/orders', order({ intent: 'SALE', purchase_units: [{ amount: { currency_code: 'usd', value: '10,00' } }] }));
        expect(r.status).toBe(400);
        expect(r.body.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: '/intent', issue: 'INVALID_PARAMETER_VALUE', value: 'SALE' }),
            expect.objectContaining({ field: '/purchase_units/0/amount/currency_code', issue: 'INVALID_PARAMETER_SYNTAX', value: 'usd' }),
            expect.objectContaining({ field: '/purchase_units/0/amount/value', issue: 'INVALID_PARAMETER_SYNTAX', value: '10,00' }),
          ]),
        );
      });

      it('OAuth token without grant_type → OAuth error', async () => {
        const r = await call('POST', '/pay/shop/paypal/v1/oauth2/token', { form: 'scope=x', headers: { authorization: 'Basic eDp5' } });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ error: 'invalid_request' });
      });

      it('valid order create and get pass', async () => {
        const r = await pp('POST', '/v2/checkout/orders', order());
        expect(r.status, r.text).toBe(201);
        expect((await logOf(r)).contract).toMatchObject({ mode: 'strict', enforced: false, level: null, issues: [] });
        const got = await pp('GET', `/v2/checkout/orders/${r.body.id}`);
        expect(got.status, got.text).toBe(200);
        expect((await logOf(got)).contract).toMatchObject({ operation: { key: 'GET /v2/checkout/orders/{id}' }, level: null });
      });
    });
  });

  describe('Moyasar (S11b)', () => {
    let moyKey = '';
    const moyAuth = () => ({ authorization: 'Basic ' + Buffer.from(moyKey + ':').toString('base64') });
    const moy = (method: string, p: string, json?: unknown) => call(method, `/pay/shop/moyasar${p}`, { ...(json !== undefined ? { json } : {}), headers: moyAuth() });
    const moyMode = async (contract: unknown) => {
      const r = await call('PATCH', '/api/projects/shop/payment-instances/moyasar', { json: { config: { contract } } });
      expect(r.status, r.text).toBe(200);
      return r;
    };
    const card = (over: Record<string, unknown> = {}) => ({ type: 'creditcard', name: 'Test Buyer', number: '4111111111111111', month: 12, year: 2030, cvc: '987', ...over });
    const payment = (over: Record<string, unknown> = {}) => ({ amount: 1000, currency: 'SAR', callback_url: 'http://127.0.0.1/r', description: 'Order 1', metadata: { order_id: 'o-1' }, source: card(), ...over });

    beforeAll(async () => {
      const m = await call('POST', '/api/projects/shop/payment-instances', { json: { preset: 'moyasar', config: { webhookDelayMs: 0, contractMode: 'report' } } });
      expect(m.status, m.text).toBe(201);
      expect(m.body.slug).toBe('moyasar');
      moyKey = m.body.config.secretKey;
      // contractMode is an alias, stored as contract.
      expect(m.body.config.contract).toBe('report');
      expect(m.body.config.contractMode).toBeUndefined();
      await moyMode(null);
    });

    it('off (default): the fake answers its own error, no contract recorded', async () => {
      const r = await moy('POST', '/v1/payments', payment({ amount: 10.5 }));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ type: 'invalid_request_error', errors: { amount: ['must be an integer'] } });
      expect((await logOf(r)).contract).toBeNull();
    });

    it('report: issues recorded, the fake still answers; form bodies are not covered', async () => {
      await moyMode('report');
      const r = await moy('POST', '/v1/payments', payment({ given_id: 'not-a-uuid' }));
      expect(r.status).toBe(400);
      expect(r.body.errors).toEqual({ given_id: ['must be a UUID'] });
      const log = await logOf(r);
      expect(log.contract).toMatchObject({ provider: { preset: 'moyasar', instance: 'moyasar' }, operation: { operationId: 'CreatePayment' }, mode: 'report', enforced: false, level: 'error' });
      expect(log.contract!.issues[0]).toMatchObject({ pointer: '/given_id' });
      const f = await call('POST', '/pay/shop/moyasar/v1/invoices', { form: 'amount=1000&currency=SAR&description=Inv', headers: moyAuth() });
      expect(f.status, f.text).toBe(201);
      expect((await logOf(f)).contract).toBeNull();
    });

    describe('strict', () => {
      beforeAll(() => moyMode('strict'));
      afterAll(() => moyMode(null));

      it('missing source → Moyasar Validation Failed', async () => {
        const r = await moy('POST', '/v1/payments', payment({ source: undefined }));
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ type: 'invalid_request_error', message: 'Validation Failed', errors: { source: ['is required'] } });
        const log = await logOf(r);
        expect(log.contract).toMatchObject({ mode: 'strict', enforced: true, level: 'error' });
        expect(log.outcome).toBe('invalid');
      });

      it('decimal / zero amount, lower-case currency, missing callback_url → per-field errors', async () => {
        const r = await moy('POST', '/v1/payments', payment({ amount: 10.5, currency: 'sar' }));
        expect(r.status).toBe(400);
        expect(r.body.errors).toMatchObject({ amount: ['must be an integer'], currency: ['is invalid'] });
        const z = await moy('POST', '/v1/invoices', { amount: 0, currency: 'SAR', description: 'x' });
        expect(z.status).toBe(400);
        expect(z.body.errors).toEqual({ amount: ['must be greater than 0'] });
        const cb = await moy('POST', '/v1/payments', payment({ callback_url: undefined }));
        expect(cb.status).toBe(400);
        expect(cb.body.errors).toEqual({ callback_url: ['is required'] });
      });

      it('card values never appear in the stored contract result', async () => {
        const r = await moy('POST', '/v1/payments', payment({ source: card({ number: '4111-1111-1111-1111', cvc: '98x7', month: 13, name: undefined }) }));
        expect(r.status).toBe(400);
        expect(Object.keys(r.body.errors).sort()).toEqual(['source.cvc', 'source.month', 'source.name', 'source.number']);
        const log = await logOf(r);
        const stored = JSON.stringify(log.contract);
        expect(log.contract!.issues.length).toBeGreaterThanOrEqual(4);
        expect(stored).not.toContain('98x7');
        expect(stored).not.toContain('4111-1111-1111');
        expect(stored).not.toContain('411111111111');
      });

      it('valid payment, fetch and invoice pass', async () => {
        const r = await moy('POST', '/v1/payments', payment());
        expect(r.status, r.text).toBe(201);
        const log = await logOf(r);
        expect(log.contract).toMatchObject({ mode: 'strict', enforced: false, level: null, issues: [] });
        const got = await moy('GET', `/v1/payments/${r.body.id}`);
        expect(got.status, got.text).toBe(200);
        expect((await logOf(got)).contract).toMatchObject({ operation: { key: 'GET /v1/payments/{id}' }, level: null });
        const inv = await moy('POST', '/v1/invoices', { amount: 5000, currency: 'SAR', description: 'Invoice 1', success_url: 'http://127.0.0.1/ok' });
        expect(inv.status, inv.text).toBe(201);
        expect((await logOf(inv)).contract).toMatchObject({ level: null });
      });
    });
  });

  it('a bad contract config value is refused on create and update (S11b)', async () => {
    const c = await call('POST', '/api/projects/shop/payment-instances', { json: { preset: 'moyasar', slug: 'moy-bad', config: { contract: 'loud' } } });
    expect(c.status).toBe(400);
    expect(c.text).toMatch(/contract must be \\"off\\", \\"report\\" or \\"strict\\"|contract must be "off", "report" or "strict"/);
    expect((await call('PATCH', '/api/projects/shop/payment-instances/paypal', { json: { config: { contract: 'yes' } } })).status).toBe(400);
    expect((await call('PATCH', '/api/projects/shop/payment-instances/paypal', { json: { config: { contractMode: 1 } } })).status).toBe(400);
    const ok = await call('PATCH', '/api/projects/shop/payment-instances/paypal', { json: { config: { contract: true } } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.config.contract).toBe('strict');
    expect((await call('PATCH', '/api/projects/shop/payment-instances/paypal', { json: { config: { contract: null } } })).status).toBe(200);
  });

  describe('Twilio (S11c)', () => {
    const ACC = 'AC' + 'a'.repeat(32);
    const MSG = `/2010-04-01/Accounts/${ACC}/Messages.json`;
    const tw = (method: string, p: string, body?: Record<string, string>, slug = 'twilio') =>
      call(method, `/mock/shop/${slug}${p}`, { ...(body ? { form: form(body) } : {}), headers: { authorization: 'Basic ' + Buffer.from(`${ACC}:token`).toString('base64') } });
    const twMode = async (contract: unknown, slug = 'twilio') => {
      const r = await call('PATCH', `/api/projects/shop/providers/${slug}`, { json: { config: { contract } } });
      expect(r.status, r.text).toBe(200);
      return r;
    };
    const sms = (over: Record<string, string | undefined> = {}) =>
      Object.fromEntries(Object.entries({ To: '+15550001234', From: '+15550009999', Body: 'Your code is 123456', ...over }).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const twErr = (code: number) => ({ code, more_info: `https://www.twilio.com/docs/errors/${code}`, status: 400 });

    beforeAll(async () => {
      const t = await call('POST', '/api/projects/shop/providers', { json: { preset: 'twilio', slug: 'twilio' } });
      expect(t.status, t.text).toBe(201);
      const w = await call('POST', '/api/projects/shop/providers', { json: { preset: 'twilio-whatsapp', slug: 'twwa', config: { contractMode: 'strict' } } });
      expect(w.status, w.text).toBe(201);
    });

    it('off (default): the fake answers its own error, no contract recorded', async () => {
      const r = await tw('POST', MSG, sms({ To: undefined }));
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject(twErr(21604));
      expect((await logOf(r)).contract).toBeNull();
    });

    it('report: issues recorded, the fake still answers', async () => {
      await twMode('report');
      // The fake normalises a national number; the contract wants E.164.
      const r = await tw('POST', MSG, sms({ To: '5550001234' }));
      expect(r.status, r.text).toBe(201);
      const log = await logOf(r);
      expect(log.contract).toMatchObject({ provider: { preset: 'twilio', instance: 'twilio' }, operation: { operationId: 'CreateMessage' }, mode: 'report', enforced: false, level: 'error' });
      expect(log.contract!.issues[0]).toMatchObject({ pointer: '/To' });
      await twMode(null);
    });

    describe('strict', () => {
      beforeAll(() => twMode('strict'));
      afterAll(() => twMode(null));

      it('missing To → 21604', async () => {
        const r = await tw('POST', MSG, sms({ To: undefined }));
        expect(r.status).toBe(400);
        expect(r.body).toEqual({ ...twErr(21604), message: "A 'To' phone number is required." });
        const log = await logOf(r);
        expect(log.contract).toMatchObject({ mode: 'strict', enforced: true, level: 'error' });
        expect(log.outcome).toBe('invalid');
      });

      it('bad To format → 21211; missing Body / MediaUrl / ContentSid → 21602; missing From → 21603', async () => {
        const bad = await tw('POST', MSG, sms({ To: '5550001234' }));
        expect(bad.status).toBe(400);
        expect(bad.body).toMatchObject(twErr(21211));
        const nobody = await tw('POST', MSG, sms({ Body: undefined }));
        expect(nobody.status).toBe(400);
        expect(nobody.body).toEqual({ ...twErr(21602), message: 'Message body is required.' });
        const nofrom = await tw('POST', MSG, sms({ From: undefined }));
        expect(nofrom.status).toBe(400);
        expect(nofrom.body).toMatchObject(twErr(21603));
        // To is checked first, like Twilio.
        const both = await tw('POST', MSG, { Body: 'x' });
        expect(both.body).toMatchObject(twErr(21604));
      });

      it('valid sends (Body, MediaUrl only, MessagingServiceSid) and fetch pass', async () => {
        const r = await tw('POST', MSG, sms());
        expect(r.status, r.text).toBe(201);
        expect((await logOf(r)).contract).toMatchObject({ mode: 'strict', enforced: false, level: null, issues: [] });
        const media = await tw('POST', MSG, sms({ Body: undefined, MediaUrl: 'https://example.com/a.png' }));
        expect(media.status, media.text).toBe(201);
        const svc = await tw('POST', `/2010-04-01/Accounts/${ACC}/Messages`, sms({ From: undefined, MessagingServiceSid: 'MG' + 'b'.repeat(32) }));
        expect(svc.status, svc.text).toBe(201);
        const got = await tw('GET', `/2010-04-01/Accounts/${ACC}/Messages/${r.body.sid}.json`);
        expect(got.status, got.text).toBe(200);
        expect((await logOf(got)).contract).toMatchObject({ operation: { key: 'GET /2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json' }, level: null });
      });

      it('Verify: Channel enum, missing To, To or VerificationSid on the check', async () => {
        const s = await tw('POST', '/v2/Services', { FriendlyName: 'Shop' });
        expect(s.status, s.text).toBe(201);
        const V = `/v2/Services/${s.body.sid}`;
        const ch = await tw('POST', `${V}/Verifications`, { To: '+15550001234', Channel: 'pigeon' });
        expect(ch.status).toBe(400);
        expect(ch.body).toEqual({ ...twErr(60200), message: 'Invalid parameter: Channel' });
        const noTo = await tw('POST', `${V}/Verifications`, { Channel: 'sms' });
        expect(noTo.body).toEqual({ ...twErr(20001), message: 'Missing required parameter To in the post body' });
        const ok = await tw('POST', `${V}/Verifications`, { To: '+15550001234', Channel: 'sms' });
        expect(ok.status, ok.text).toBe(201);
        expect((await logOf(ok)).contract).toMatchObject({ operation: { operationId: 'CreateVerification' }, level: null });
        const chk = await tw('POST', `${V}/VerificationCheck`, { Code: '123456' });
        expect(chk.status).toBe(400);
        expect(chk.body).toMatchObject(twErr(60200));
        expect(chk.body.message).toMatch(/Either a 'To' or a 'VerificationSid'/);
      });
    });

    it('twilio-whatsapp shares the contract; contractMode is read as an alias', async () => {
      const r = await tw('POST', MSG, { To: 'whatsapp:+15550001234', From: 'whatsapp:+15550009999' }, 'twwa');
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject(twErr(21602));
      const log = await logOf(r);
      expect(log.contract).toMatchObject({ provider: { preset: 'twilio-whatsapp', instance: 'twwa' }, enforced: true });
      const ok = await tw('POST', MSG, { To: 'whatsapp:+15550001234', From: 'whatsapp:+15550009999', Body: 'hi' }, 'twwa');
      expect(ok.status, ok.text).toBe(201);
    });

    it('instance config: bad contract values are 400; contractMode is stored as contract; true means strict', async () => {
      const bad = await call('POST', '/api/projects/shop/providers', { json: { preset: 'twilio', slug: 'twbad', config: { contract: 'loud' } } });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/contract must be "off", "report" or "strict"/);
      const up = await call('PATCH', '/api/projects/shop/providers/twilio', { json: { config: { contract: 'loud' } } });
      expect(up.status).toBe(400);
      expect(hub.providers.get(hub.projects.getBySlug('shop')!.id, 'twwa')!.config).toMatchObject({ contract: 'strict' });
      expect(hub.providers.get(hub.projects.getBySlug('shop')!.id, 'twwa')!.config).not.toHaveProperty('contractMode');
      const t = await twMode(true);
      expect(t.body.config.contract).toBe('strict');
      await twMode(null);
      expect(hub.providers.get(hub.projects.getBySlug('shop')!.id, 'twilio')!.config).not.toHaveProperty('contract');
    });
  });
});
