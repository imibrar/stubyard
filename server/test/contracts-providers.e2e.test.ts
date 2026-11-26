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
});
