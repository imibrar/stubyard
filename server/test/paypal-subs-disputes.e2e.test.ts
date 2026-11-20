import { createVerify } from 'node:crypto';
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
import { scheduleBilling } from '../src/payments/paypal/subscriptions.js';
import { paypalSignedString } from '../src/webhooks/signing.js';

// PayPal subscriptions (Catalog Products v1, Billing Plans / Subscriptions v1, v1 sales) and Disputes v1 on the fake.

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

async function call<T = any>(method: string, p: string, opts: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
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

const PJ = '/api/projects/subs';
const PP = '/pay/subs/paypal';
let pp: { clientId: string; clientSecret: string; webhookId: string; certPem: string };
let ppToken = '';
const auth = () => ({ authorization: `Bearer ${ppToken}` });
const ppPost = (p: string, json: unknown, extra: Record<string, string> = {}) => call('POST', PP + p, { json, headers: { ...auth(), 'paypal-request-id': `r-${Math.random()}`, ...extra } });
const ppGet = (p: string) => call('GET', PP + p, { headers: auth() });
const ppPatch = (p: string, json: unknown) => call('PATCH', PP + p, { json, headers: auth() });

/** Webhooks of one type received by the app (parsed), oldest first. */
const events = (type: string, pred: (e: any) => boolean = () => true) => received.filter((h) => h.path === '/pp').map((h) => ({ ...JSON.parse(h.body), _hit: h })).filter((e) => e.event_type === type && pred(e));
const eventFor = (type: string, pred: (e: any) => boolean = () => true) => waitFor(() => events(type, pred).at(-1));
/** Independent check: RSA-SHA256 over "<id>|<time>|<webhook id>|<crc32>" with the instance certificate. */
function signatureOk(h: Hit): boolean {
  const signed = paypalSignedString(String(h.headers['paypal-transmission-id']), String(h.headers['paypal-transmission-time']), pp.webhookId, h.body);
  return createVerify('RSA-SHA256').update(signed).verify(pp.certPem, String(h.headers['paypal-transmission-sig']), 'base64');
}
const issue = (r: { body: any }) => r.body?.details?.[0]?.issue;
const rel = (o: any, r: string) => (o.links as { rel: string; href: string }[]).find((l) => l.rel === r)?.href;
const local = (href: string) => {
  const u = new URL(href);
  return u.pathname + u.search;
};

async function product(name = 'Video streaming') {
  const r = await ppPost('/v1/catalogs/products', { name, description: 'Streaming service', type: 'SERVICE', category: 'SOFTWARE', home_url: 'https://example.com' });
  expect(r.status, r.text).toBe(201);
  return r.body;
}
async function plan(productId: string, over: Record<string, unknown> = {}) {
  const r = await ppPost(
    '/v1/billing/plans',
    {
      product_id: productId,
      name: 'Basic monthly',
      billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 12, pricing_scheme: { fixed_price: { value: '10.00', currency_code: 'USD' } } }],
      payment_preferences: { auto_bill_outstanding: true, setup_fee: { value: '1.00', currency_code: 'USD' }, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 2 },
      ...over,
    },
    { prefer: 'return=representation' },
  );
  expect(r.status, r.text).toBe(201);
  return r.body;
}
async function subscribe(planId: string, extra: Record<string, unknown> = {}) {
  const r = await ppPost('/v1/billing/subscriptions', { plan_id: planId, custom_id: 'user-42', subscriber: { email_address: 'buyer@example.com', name: { given_name: 'Sam', surname: 'Buyer' } }, application_context: { return_url: `${appUrl}/ok`, cancel_url: `${appUrl}/cancel`, user_action: 'SUBSCRIBE_NOW' }, ...extra });
  expect(r.status, r.text).toBe(201);
  return r.body;
}
/** Buyer approves on the stubyard PayPal page (approve link → page → complete). */
async function approve(sub: any, outcome = 'success') {
  const link = rel(sub, 'approve')!;
  const hop = await call('GET', local(link));
  expect(hop.status).toBe(302);
  const ctl = (await api('GET', `${PJ}/payments/subscriptions/${sub.id}`)).body;
  const done = await api('POST', `${PJ}/payments/${ctl.approvalPayment}/complete`, { outcome });
  expect(done.status, done.text).toBe(200);
  return done.body;
}
const view = async (id: string) => (await api('GET', `${PJ}/payments/subscriptions/${id}`)).body;

describe('paypal subscriptions and disputes', () => {
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubyard-ppsubs-'));
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
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', () => r()));
    appUrl = `http://127.0.0.1:${(appServer.address() as net.AddressInfo).port}`;
    expect((await api('POST', '/api/projects', { name: 'Subs', slug: 'subs', generateUsers: { admins: 1, customers: 1 } })).status).toBe(201);
    const p = await api('POST', `${PJ}/payment-instances`, { preset: 'paypal', config: { webhookUrl: `${appUrl}/pp`, webhookDelayMs: 0 } });
    expect(p.status, p.text).toBe(201);
    pp = p.body.config;
    const t = await call('POST', `${PP}/v1/oauth2/token`, { body: 'grant_type=client_credentials', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${pp.clientId}:${pp.clientSecret}`).toString('base64') } });
    expect(t.status, t.text).toBe(200);
    ppToken = t.body.access_token;
  });

  afterAll(async () => {
    appServer?.close();
    await close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('catalog products', () => {
    it('creates, reads, lists and patches a product; signed CATALOG.PRODUCT.* webhooks', async () => {
      expect((await call('POST', `${PP}/v1/catalogs/products`, { json: { name: 'x' } })).status).toBe(401);
      const bad = await ppPost('/v1/catalogs/products', { description: 'no name' });
      expect(bad.status).toBe(400);
      expect(issue(bad)).toBe('MISSING_REQUIRED_PARAMETER');
      const prod = await product();
      expect(prod.id).toMatch(/^PROD-[A-Z0-9]{17}$/);
      expect(prod.type).toBe('SERVICE');
      const got = await ppGet(`/v1/catalogs/products/${prod.id}`);
      expect(got.body.name).toBe('Video streaming');
      const list = await ppGet('/v1/catalogs/products?page_size=5&total_required=true');
      expect(list.body.products.some((x: any) => x.id === prod.id)).toBe(true);
      expect(list.body.total_items).toBeGreaterThanOrEqual(1);
      const patched = await ppPatch(`/v1/catalogs/products/${prod.id}`, [{ op: 'replace', path: '/description', value: 'Premium streaming' }]);
      expect(patched.status, patched.text).toBe(204);
      expect((await ppGet(`/v1/catalogs/products/${prod.id}`)).body.description).toBe('Premium streaming');
      const badPath = await ppPatch(`/v1/catalogs/products/${prod.id}`, [{ op: 'replace', path: '/name', value: 'x' }]);
      expect(badPath.status).toBe(400);
      expect(issue(badPath)).toBe('INVALID_PATCH_PATH');
      const created = await eventFor('CATALOG.PRODUCT.CREATED', (e) => e.resource.id === prod.id);
      expect(created.resource_type).toBe('product');
      expect(signatureOk(created._hit)).toBe(true);
      const updated = await eventFor('CATALOG.PRODUCT.UPDATED', (e) => e.resource.id === prod.id);
      expect(updated.resource.description).toBe('Premium streaming');
      // PayPal's own verification endpoint accepts it too (event not tied to a payment).
      const h = updated._hit.headers;
      const v = await ppPost('/v1/notifications/verify-webhook-signature', { auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: pp.webhookId, webhook_event: JSON.parse(updated._hit.body) });
      expect(v.body.verification_status).toBe('SUCCESS');
    });
  });

  describe('billing plans', () => {
    it('validates cycles, returns minimal / full representations, activates, deactivates and reprices', async () => {
      const prod = await product('Plans product');
      const noRegular = await ppPost('/v1/billing/plans', { product_id: prod.id, name: 'x', payment_preferences: {}, billing_cycles: [{ frequency: { interval_unit: 'MONTH' }, tenure_type: 'TRIAL', sequence: 1, total_cycles: 1 }] });
      expect(noRegular.status).toBe(422);
      expect(issue(noRegular)).toBe('INVALID_BILLING_CYCLE_SEQUENCE');
      const unknownProduct = await ppPost('/v1/billing/plans', { product_id: 'PROD-NOPE00', name: 'x', payment_preferences: {}, billing_cycles: [] });
      expect(unknownProduct.status).toBe(400);
      const minimal = await ppPost('/v1/billing/plans', { product_id: prod.id, name: 'Minimal', payment_preferences: {}, billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: '5.00', currency_code: 'USD' } } }] });
      expect(minimal.status).toBe(201);
      expect(minimal.body.id).toMatch(/^P-[A-Z0-9]{24}$/);
      expect(minimal.body.status).toBe('ACTIVE');
      expect(minimal.body.billing_cycles).toBeUndefined();
      const full = await plan(prod.id, { billing_cycles: [{ frequency: { interval_unit: 'WEEK', interval_count: 1 }, tenure_type: 'TRIAL', sequence: 1, total_cycles: 1, pricing_scheme: { fixed_price: { value: '0', currency_code: 'USD' } } }, { frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 2, total_cycles: 0, pricing_scheme: { fixed_price: { value: '9.99', currency_code: 'USD' } } }] });
      expect(full.billing_cycles).toHaveLength(2);
      expect(full.payment_preferences.payment_failure_threshold).toBe(2);
      const deact = await ppPost(`/v1/billing/plans/${full.id}/deactivate`, {});
      expect(deact.status).toBe(204);
      expect((await ppPost(`/v1/billing/plans/${full.id}/deactivate`, {})).status).toBe(422);
      const inactiveSub = await ppPost('/v1/billing/subscriptions', { plan_id: full.id });
      expect(inactiveSub.status).toBe(422);
      expect(issue(inactiveSub)).toBe('PLAN_STATUS_INVALID');
      expect((await ppPost(`/v1/billing/plans/${full.id}/activate`, {})).status).toBe(204);
      const price = await ppPost(`/v1/billing/plans/${full.id}/update-pricing-schemes`, { pricing_schemes: [{ billing_cycle_sequence: 2, pricing_scheme: { fixed_price: { value: '12.50', currency_code: 'USD' } } }] });
      expect(price.status, price.text).toBe(204);
      const after = (await ppGet(`/v1/billing/plans/${full.id}`)).body;
      expect(after.billing_cycles[1].pricing_scheme.fixed_price.value).toBe('12.50');
      expect(after.billing_cycles[1].pricing_scheme.version).toBe(2);
      expect((await ppPatch(`/v1/billing/plans/${full.id}`, [{ op: 'replace', path: '/payment_preferences/payment_failure_threshold', value: 3 }])).status).toBe(204);
      expect((await ppGet(`/v1/billing/plans/${full.id}`)).body.payment_preferences.payment_failure_threshold).toBe(3);
      const listed = await ppGet(`/v1/billing/plans?product_id=${prod.id}&total_required=true`);
      expect(listed.body.total_items).toBe(2);
      for (const t of ['BILLING.PLAN.CREATED', 'BILLING.PLAN.DEACTIVATED', 'BILLING.PLAN.ACTIVATED', 'BILLING.PLAN.PRICING-CHANGE.ACTIVATED', 'BILLING.PLAN.UPDATED']) {
        const e = await eventFor(t, (x) => x.resource.id === full.id);
        expect(signatureOk(e._hit)).toBe(true);
      }
    });
  });

  describe('subscriptions', () => {
    let planId = '';
    let subId = '';
    beforeAll(async () => {
      planId = (await plan((await product('Subs product')).id)).id;
    });

    it('creates APPROVAL_PENDING with an approve link; the buyer approves; ACTIVE with the first charge', async () => {
      const sub = await subscribe(planId);
      subId = sub.id;
      expect(sub.id).toMatch(/^I-[A-Z0-9]{12}$/);
      expect(sub.status).toBe('APPROVAL_PENDING');
      expect(rel(sub, 'approve')).toContain('/webapps/billing/subscriptions?ba_token=BA-');
      const hop = await call('GET', local(rel(sub, 'approve')!));
      expect(hop.headers.get('location')).toMatch(/page\//);
      const done = await approve(sub);
      expect(done.payment.status).toBe('paid');
      const ret = new URL(done.redirectUrl);
      expect(ret.pathname).toBe('/ok');
      expect(ret.searchParams.get('subscription_id')).toBe(sub.id);
      expect(ret.searchParams.get('ba_token')).toMatch(/^BA-/);
      const got = (await ppGet(`/v1/billing/subscriptions/${sub.id}?fields=plan`)).body;
      expect(got.status).toBe('ACTIVE');
      expect(got.plan.id).toBe(planId);
      expect(got.subscriber.email_address).toBeTruthy();
      expect(got.billing_info.last_payment.amount.value).toBe('11.00');
      expect(got.billing_info.cycle_executions[0].cycles_completed).toBe(1);
      expect(Date.parse(got.billing_info.next_billing_time) - Date.now()).toBeGreaterThan(27 * 86_400_000);
      const created = await eventFor('BILLING.SUBSCRIPTION.CREATED', (e) => e.resource.id === sub.id);
      expect(created.resource.status).toBe('APPROVAL_PENDING');
      const activated = await eventFor('BILLING.SUBSCRIPTION.ACTIVATED', (e) => e.resource.id === sub.id);
      expect(signatureOk(activated._hit)).toBe(true);
      const sale = await eventFor('PAYMENT.SALE.COMPLETED', (e) => e.resource.billing_agreement_id === sub.id);
      expect(sale.resource.amount.total).toBe('11.00');
      expect(sale.resource.state).toBe('completed');
      expect(signatureOk(sale._hit)).toBe(true);
    });

    it('bills the next cycles by advancing the subscription clock; v1 sale and transactions', async () => {
      const r = await api('POST', `${PJ}/payments/subscriptions/${subId}/advance`, { cycles: 1 });
      expect(r.status, r.text).toBe(200);
      expect(r.body.billed).toHaveLength(1);
      expect(r.body.billed[0].amount).toBe(1000);
      expect(r.body.clockOffsetMs).toBeGreaterThan(27 * 86_400_000);
      const v = await view(subId);
      expect(v.cycles[0].completed).toBe(2);
      const saleId = v.payments.at(-1).saleId;
      const sale = await ppGet(`/v1/payments/sale/${saleId}`);
      expect(sale.status, sale.text).toBe(200);
      expect(sale.body.billing_agreement_id).toBe(subId);
      await eventFor('PAYMENT.SALE.COMPLETED', (e) => e.resource.id === saleId);
      const tx = await ppGet(`/v1/billing/subscriptions/${subId}/transactions?start_time=2020-01-01T00:00:00Z&end_time=2099-01-01T00:00:00Z`);
      expect(tx.body.transactions.map((t: any) => t.status)).toEqual(['COMPLETED', 'COMPLETED']);
      expect((await ppGet(`/v1/billing/subscriptions/${subId}/transactions`)).status).toBe(400);
      // by: moves the clock and bills what became due (one more month).
      const by = await api('POST', `${PJ}/payments/subscriptions/${subId}/advance`, { by: '+32d' });
      expect(by.body.billed).toHaveLength(1);
      expect((await view(subId)).cycles[0].completed).toBe(3);
    });

    it('declined cycles: PAYMENT.FAILED, outstanding balance, SUSPENDED at the failure threshold; activate and capture', async () => {
      expect((await api('POST', `${PJ}/payments/subscriptions/${subId}/outcomes`, { outcomes: ['decline', 'decline'] })).status).toBe(200);
      await api('POST', `${PJ}/payments/subscriptions/${subId}/advance`, { cycles: 1 });
      let v = await view(subId);
      expect(v.failedCount).toBe(1);
      expect(v.outstanding).toBe('10.00');
      expect(v.status).toBe('ACTIVE');
      const failed = await eventFor('BILLING.SUBSCRIPTION.PAYMENT.FAILED', (e) => e.resource.id === subId);
      expect(failed.resource.billing_info.last_failed_payment.reason_code).toBe('PAYMENT_DENIED');
      await api('POST', `${PJ}/payments/subscriptions/${subId}/advance`, { cycles: 1 });
      v = await view(subId);
      expect(v.status).toBe('SUSPENDED');
      expect(v.outstanding).toBe('20.00');
      await eventFor('BILLING.SUBSCRIPTION.SUSPENDED', (e) => e.resource.id === subId);
      const blocked = await api('POST', `${PJ}/payments/subscriptions/${subId}/bill`, {});
      expect(blocked.status).toBe(409);
      const act = await ppPost(`/v1/billing/subscriptions/${subId}/activate`, { reason: 'Card updated' });
      expect(act.status, act.text).toBe(204);
      const zero = await ppPost(`/v1/billing/subscriptions/${subId}/capture`, { note: 'x', capture_type: 'OUTSTANDING_BALANCE', amount: { currency_code: 'USD', value: '25.00' } });
      expect(issue(zero)).toBe('AMOUNT_GREATER_THAN_OUTSTANDING_BALANCE');
      const cap = await ppPost(`/v1/billing/subscriptions/${subId}/capture`, { note: 'Balance', capture_type: 'OUTSTANDING_BALANCE', amount: { currency_code: 'USD', value: '20.00' } });
      expect(cap.status, cap.text).toBe(202);
      expect(cap.body.status).toBe('COMPLETED');
      v = await view(subId);
      expect(v.outstanding).toBe('0.00');
      expect(v.status).toBe('ACTIVE');
      expect(issue(await ppPost(`/v1/billing/subscriptions/${subId}/capture`, { note: 'x', capture_type: 'OUTSTANDING_BALANCE', amount: { currency_code: 'USD', value: '1.00' } }))).toBe('ZERO_OUTSTANDING_BALANCE');
    });

    it('suspend / cancel need a reason; status rules; webhooks', async () => {
      const noReason = await ppPost(`/v1/billing/subscriptions/${subId}/suspend`, {});
      expect(noReason.status).toBe(400);
      expect(issue(noReason)).toBe('MISSING_REQUIRED_PARAMETER');
      expect((await ppPost(`/v1/billing/subscriptions/${subId}/suspend`, { reason: 'Paused' })).status).toBe(204);
      const again = await ppPost(`/v1/billing/subscriptions/${subId}/suspend`, { reason: 'Paused' });
      expect(again.status).toBe(422);
      expect(issue(again)).toBe('SUBSCRIPTION_STATUS_INVALID');
      expect((await ppPost(`/v1/billing/subscriptions/${subId}/cancel`, { reason: 'Not needed' })).status).toBe(204);
      const got = (await ppGet(`/v1/billing/subscriptions/${subId}`)).body;
      expect(got.status).toBe('CANCELLED');
      expect(got.status_change_note).toBe('Not needed');
      expect(got.billing_info.next_billing_time).toBeUndefined();
      await eventFor('BILLING.SUBSCRIPTION.CANCELLED', (e) => e.resource.id === subId);
      expect((await ppGet(`/v1/billing/subscriptions?statuses=CANCELLED&plan_ids=${planId}`)).body.subscriptions.map((s: any) => s.id)).toContain(subId);
    });

    it('the durable scheduler bills at next_billing_time on the subscription clock', async () => {
      const prod = await product('Daily');
      const daily = await plan(prod.id, { billing_cycles: [{ frequency: { interval_unit: 'DAY', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 2, pricing_scheme: { fixed_price: { value: '2.00', currency_code: 'USD' } } }], payment_preferences: { auto_bill_outstanding: true } });
      const sub = await subscribe(daily.id);
      await approve(sub);
      await waitFor(async () => (await view(sub.id)).status === 'ACTIVE');
      // Move the subscription clock to 300 ms before the due time; the job queued at next_billing_time fires.
      const t = hub.payments.repo.tokenByRef(hub.payments.repo.instanceById((await view(sub.id)).tokenId ? hub.payments.repo.token((await view(sub.id)).tokenId)!.instanceId : '')!.id, sub.id)!;
      const due = Date.parse(String(t.data.next_billing_time));
      hub.payments.repo.updateToken(t.id, { data: { ...t.data, clockOffsetMs: due - Date.now() - 300 } });
      scheduleBilling(hub.payments, hub.payments.repo.token(t.id)!);
      const v = await waitFor(async () => {
        const x = await view(sub.id);
        return x.status === 'EXPIRED' ? x : null;
      });
      expect(v.cycles[0].completed).toBe(2);
      expect(v.payments.map((p: any) => p.amount)).toEqual(['2.00', '2.00']);
      await eventFor('BILLING.SUBSCRIPTION.EXPIRED', (e) => e.resource.id === sub.id);
    });

    it('trial and future start_time: no charge at approval; cancel on the page keeps APPROVAL_PENDING', async () => {
      const prod = await product('Trial');
      const trial = await plan(prod.id, { billing_cycles: [{ frequency: { interval_unit: 'DAY', interval_count: 7 }, tenure_type: 'TRIAL', sequence: 1, total_cycles: 1, pricing_scheme: { fixed_price: { value: '0', currency_code: 'USD' } } }, { frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 2, total_cycles: 0, pricing_scheme: { fixed_price: { value: '15.00', currency_code: 'USD' } } }], payment_preferences: {} });
      const sub = await subscribe(trial.id);
      const cancelled = await approve(sub, 'cancel');
      expect(new URL(cancelled.redirectUrl).pathname).toBe('/cancel');
      expect((await view(sub.id)).status).toBe('APPROVAL_PENDING');
      const sub2 = await subscribe(trial.id);
      const done = await approve(sub2);
      expect(done.payment.amount).toBe(0);
      const v = await view(sub2.id);
      expect(v.status).toBe('ACTIVE');
      expect(v.nextAmount).toBe('15.00');
      expect(events('PAYMENT.SALE.COMPLETED', (e) => e.resource.billing_agreement_id === sub2.id)).toHaveLength(0);
      const later = await subscribe(trial.id, { start_time: new Date(Date.now() + 10 * 86_400_000).toISOString() });
      await approve(later);
      expect(Date.parse((await view(later.id)).nextBillingTime) - Date.now()).toBeGreaterThan(9 * 86_400_000);
    });

    it('revise: approve a plan change on the PayPal page', async () => {
      const prod = await product('Revise');
      const a = await plan(prod.id);
      const b = await plan(prod.id, { name: 'Pro monthly', billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: '20.00', currency_code: 'USD' } } }] });
      const sub = await subscribe(a.id);
      await approve(sub);
      const rev = await ppPost(`/v1/billing/subscriptions/${sub.id}/revise`, { plan_id: b.id });
      expect(rev.status, rev.text).toBe(200);
      expect(rel(rev.body, 'approve')).toContain('ba_token=BA-');
      const ba = new URL(rel(rev.body, 'approve')!).searchParams.get('ba_token')!;
      const p = (await api('GET', `${PJ}/payments/${ba}`)).body;
      expect((await api('POST', `${PJ}/payments/${p.id}/complete`, { outcome: 'success' })).status).toBe(200);
      const got = (await ppGet(`/v1/billing/subscriptions/${sub.id}`)).body;
      expect(got.plan_id).toBe(b.id);
      await eventFor('BILLING.SUBSCRIPTION.UPDATED', (e) => e.resource.id === sub.id && e.resource.plan_id === b.id);
      expect((await view(sub.id)).nextAmount).toBe('20.00');
      const other = await plan((await product('Other')).id);
      expect(issue(await ppPost(`/v1/billing/subscriptions/${sub.id}/revise`, { plan_id: other.id }))).toBe('PLAN_PRODUCT_NOT_COMPATIBLE');
      // quantity: 1-32 as on create, and only on a plan with quantity_supported.
      const huge = await ppPost(`/v1/billing/subscriptions/${sub.id}/revise`, { quantity: '1000000000' });
      expect(huge.status).toBe(400);
      expect(issue(huge)).toBe('INVALID_PARAMETER_VALUE');
      expect(issue(await ppPost(`/v1/billing/subscriptions/${sub.id}/revise`, { quantity: '2.5' }))).toBe('INVALID_PARAMETER_VALUE');
      expect(issue(await ppPost(`/v1/billing/subscriptions/${sub.id}/revise`, { quantity: '2' }))).toBe('SUBSCRIPTION_CANNOT_HAVE_QUANTITY');
    });

    it('advance limits: more than 120 cycles due is refused; the billing job waits at least 1 s; payments list capped at 500', async () => {
      const prod = await product('Daily forever');
      const daily = await plan(prod.id, { billing_cycles: [{ frequency: { interval_unit: 'DAY', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: '1.00', currency_code: 'USD' } } }], payment_preferences: { auto_bill_outstanding: true } });
      const sub = await subscribe(daily.id);
      await approve(sub);
      const tokenOf = async () => hub.payments.repo.token((await view(sub.id)).tokenId)!;
      const before = Number((await tokenOf()).data.clockOffsetMs ?? 0);
      const far = await api('POST', `${PJ}/payments/subscriptions/${sub.id}/advance`, { by: '+10y' });
      expect(far.status, far.text).toBe(400);
      expect(far.body.error ?? far.body.message).toMatch(/more than 120 billing cycles/);
      expect(Number((await tokenOf()).data.clockOffsetMs ?? 0)).toBe(before);
      expect((await api('POST', `${PJ}/payments/subscriptions/${sub.id}/advance`, { by: '+122d' })).status).toBe(400);
      const ok = await api('POST', `${PJ}/payments/subscriptions/${sub.id}/advance`, { by: '+5d' });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.billed).toHaveLength(5);
      expect((await api('POST', `${PJ}/payments/subscriptions/${sub.id}/advance`, { cycles: 121 })).status).toBe(400);
      // A next_billing_time in the past is not billed back to back: the job waits at least 1 s.
      let t = await tokenOf();
      hub.payments.repo.updateToken(t.id, { data: { ...t.data, next_billing_time: new Date(Date.now() + Number(t.data.clockOffsetMs ?? 0) - 3 * 86_400_000).toISOString() } });
      t = scheduleBilling(hub.payments, hub.payments.repo.token(t.id)!);
      const job = hub.db.prepare('SELECT run_at FROM scheduled_jobs WHERE id = ?').get(String(t.data.job_id)) as { run_at: string };
      expect(Date.parse(job.run_at) - Date.now()).toBeGreaterThan(800);
      hub.scheduler.cancel(String(t.data.job_id));
      // data.payments keeps the newest 500 ids.
      t = await tokenOf();
      const filler = Array.from({ length: 600 }, (_, i) => `pay_filler_${i}`);
      hub.payments.repo.updateToken(t.id, { data: { ...t.data, payments: filler, next_billing_time: new Date(Date.now() + Number(t.data.clockOffsetMs ?? 0) + 86_400_000).toISOString() } });
      const one = await api('POST', `${PJ}/payments/subscriptions/${sub.id}/advance`, { cycles: 1 });
      expect(one.status, one.text).toBe(200);
      const ids = (await tokenOf()).data.payments as string[];
      expect(ids).toHaveLength(500);
      expect(ids.at(-1)).not.toMatch(/^pay_filler_/);
      expect(ids[0]).toBe('pay_filler_101');
      await ppPost(`/v1/billing/subscriptions/${sub.id}/cancel`, { reason: 'done' });
    });

    it('MCP tools list and bill subscriptions', async () => {
      const sub = await subscribe(planId);
      await approve(sub);
      const list = await mcp('list_paypal_subscriptions', { project: 'subs', status: 'ACTIVE' });
      expect(list.some((s: any) => s.id === sub.id)).toBe(true);
      const billed = await mcp('bill_paypal_subscription', { project: 'subs', subscription: sub.id, cycles: 2 });
      expect(billed.billed).toHaveLength(2);
      expect(billed.subscription.cycles[0].completed).toBe(3);
      const st = await mcp('set_paypal_subscription_status', { project: 'subs', subscription: sub.id, action: 'suspend' });
      expect(st.status).toBe('SUSPENDED');
    });
  });

  describe('disputes', () => {
    /** A captured PayPal order (approve on the page, capture by the app). */
    async function capturedOrder(value = '30.00') {
      const o = await ppPost('/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ reference_id: 'o1', amount: { currency_code: 'USD', value } }], application_context: { return_url: `${appUrl}/ok` } });
      expect(o.status, o.text).toBe(201);
      const p = (await api('GET', `${PJ}/payments/${o.body.id}`)).body;
      expect((await api('POST', `${PJ}/payments/${p.id}/complete`, { outcome: 'success', method: 'paypal' })).status).toBe(200);
      const cap = await ppPost(`/v2/checkout/orders/${o.body.id}/capture`, {});
      expect(cap.status, cap.text).toBe(201);
      return { payment: p.id as string, captureId: cap.body.purchase_units[0].payments.captures[0].id as string };
    }
    const dget = (id: string) => ppGet(`/v1/customer/disputes/${id}`);
    const act = (id: string, a: string, json: unknown) => ppPost(`/v1/customer/disputes/${id}/${a}`, json);

    it('open on a capture, offer, buyer denies, escalate, evidence (multipart), adjudicate for the buyer', async () => {
      const { payment, captureId } = await capturedOrder();
      const notPaid = await ppPost('/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '5.00' } }] });
      expect((await api('POST', `${PJ}/payments/${notPaid.body.id}/dispute`, {})).status).toBe(409);
      const opened = await api('POST', `${PJ}/payments/${payment}/dispute`, { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' });
      expect(opened.status, opened.text).toBe(201);
      const id = opened.body.id;
      expect(id).toMatch(/^PP-D-\d{5}$/);
      expect(opened.body.sellerTransactionId).toBe(captureId);
      expect((await api('POST', `${PJ}/payments/${payment}/dispute`, {})).status).toBe(409);
      const created = await eventFor('CUSTOMER.DISPUTE.CREATED', (e) => e.resource.dispute_id === id);
      expect(signatureOk(created._hit)).toBe(true);
      expect(created.resource.status).toBe('WAITING_FOR_SELLER_RESPONSE');
      const list = await ppGet(`/v1/customer/disputes?dispute_state=REQUIRED_ACTION&disputed_transaction_id=${captureId}`);
      expect(list.body.items.map((x: any) => x.dispute_id)).toEqual([id]);
      expect((await ppGet('/v1/customer/disputes?page_size=99')).body.details[0].issue).toBe('INVALID_PAGE_SIZE');
      const d0 = (await dget(id)).body;
      expect(d0.links.map((l: any) => l.rel)).toEqual(expect.arrayContaining(['make_offer', 'accept_claim', 'provide_evidence', 'escalate']));
      const offer = await act(id, 'make-offer', { note: 'Half back?', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '15.00' } });
      expect(offer.status, offer.text).toBe(200);
      expect(rel(offer.body, 'parent')).toContain(id);
      expect((await dget(id)).body.status).toBe('WAITING_FOR_BUYER_RESPONSE');
      expect((await api('POST', `${PJ}/payments/disputes/${id}/buyer`, { action: 'deny-offer', note: 'No' })).body.status).toBe('WAITING_FOR_SELLER_RESPONSE');
      expect((await act(id, 'escalate', { note: 'Please review' })).status).toBe(200);
      const d1 = (await dget(id)).body;
      expect(d1.status).toBe('UNDER_REVIEW');
      expect(d1.dispute_life_cycle_stage).toBe('CHARGEBACK');
      expect(d1.offer.history.map((h: any) => h.event_type)).toEqual(['PROPOSED', 'DENIED']);
      const late = await act(id, 'make-offer', { note: 'x', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '1.00' } });
      expect(late.status).toBe(422);
      expect(issue(late)).toBe('ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE');
      expect(issue(await act(id, 'require-evidence', { action: 'NOBODY' }))).toBe('INVALID_PARAMETER_VALUE');
      expect((await act(id, 'require-evidence', { action: 'SELLER_EVIDENCE' })).status).toBe(200);
      expect((await dget(id)).body.status).toBe('WAITING_FOR_SELLER_RESPONSE');
      const fd = new FormData();
      fd.append('input', JSON.stringify({ evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Tracking attached' }] }));
      fd.append('evidence-file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'tracking.pdf');
      const ev = await call('POST', `${PP}/v1/customer/disputes/${id}/provide-evidence`, { body: fd, headers: auth() });
      expect(ev.status, ev.text).toBe(200);
      const bad = new FormData();
      bad.append('evidence-file', new Blob([Buffer.from('MZ')]), 'tool.exe');
      expect(issue(await call('POST', `${PP}/v1/customer/disputes/${id}/provide-evidence`, { body: bad, headers: auth() }))).toBe('INVALID_EVIDENCE_FILE');
      const d2 = (await dget(id)).body;
      expect(d2.status).toBe('UNDER_REVIEW');
      expect(d2.evidences[0].documents[0].name).toBe('tracking.pdf');
      const adj = await act(id, 'adjudicate', { adjudication_outcome: 'BUYER_FAVOR' });
      expect(adj.status, adj.text).toBe(200);
      const d3 = (await dget(id)).body;
      expect(d3.status).toBe('RESOLVED');
      expect(d3.dispute_outcome.outcome_code).toBe('RESOLVED_BUYER_FAVOUR');
      expect(d3.dispute_outcome.amount_refunded.value).toBe('30.00');
      expect((await api('GET', `${PJ}/payments/${payment}`)).body.status).toBe('refunded');
      await eventFor('PAYMENT.CAPTURE.REFUNDED', (e) => e.resource.links?.some((l: any) => l.href.includes(captureId)));
      const resolved = await eventFor('CUSTOMER.DISPUTE.RESOLVED', (e) => e.resource.dispute_id === id);
      expect(signatureOk(resolved._hit)).toBe(true);
      expect(issue(await act(id, 'accept-claim', {}))).toBe('ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE');
    });

    it('accepted offer refunds part of the payment; accept-claim on a subscription sale refunds the sale', async () => {
      const { payment } = await capturedOrder('40.00');
      const id = (await api('POST', `${PJ}/payments/${payment}/dispute`, {})).body.id;
      expect(issue(await act(id, 'accept-claim', { accept_claim_type: 'REFUND', refund_amount: { currency_code: 'USD', value: '1.00' } }))).toBe('AMOUNT_SHOULD_NOT_BE_PASSED');
      await act(id, 'make-offer', { note: 'Ten back', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '10.00' } });
      const acc = await mcp('act_on_paypal_dispute', { project: 'subs', dispute: id, action: 'accept-offer', note: 'OK' });
      expect(acc.status).toBe('RESOLVED');
      expect(acc.refunded).toBe('10.00');
      expect((await api('GET', `${PJ}/payments/${payment}`)).body.status).toBe('partially_refunded');

      const pl = await plan((await product('Dispute sub')).id);
      const sub = await subscribe(pl.id);
      await approve(sub);
      const salePayment = (await view(sub.id)).payments[0];
      const opened = await mcp('open_paypal_dispute', { project: 'subs', payment: salePayment.id, reason: 'UNAUTHORISED' });
      expect(opened.sellerTransactionId).toBe(salePayment.saleId);
      expect((await act(opened.id, 'accept-claim', { note: 'Sorry', accept_claim_type: 'REFUND' })).status).toBe(200);
      const d = (await dget(opened.id)).body;
      expect(d.status).toBe('RESOLVED');
      const refunded = await eventFor('PAYMENT.SALE.REFUNDED', (e) => e.resource.sale_id === salePayment.saleId);
      expect(refunded.resource.amount.total).toBe('11.00');
      expect((await ppGet(`/v1/payments/sale/${salePayment.saleId}`)).body.state).toBe('refunded');
      const listed = await mcp('list_paypal_disputes', { project: 'subs', status: 'RESOLVED' });
      expect(listed.length).toBeGreaterThanOrEqual(2);
    });

    it('control resolve for the seller; v1 sale refund', async () => {
      const pl = await plan((await product('Sale refund')).id);
      const sub = await subscribe(pl.id);
      await approve(sub);
      const sale = (await view(sub.id)).payments[0];
      const r = await ppPost(`/v1/payments/sale/${sale.saleId}/refund`, { amount: { total: '2.00', currency: 'USD' } });
      expect(r.status, r.text).toBe(201);
      expect(r.body.state).toBe('completed');
      expect(r.body.sale_id).toBe(sale.saleId);
      const opened = (await api('POST', `${PJ}/payments/${sale.id}/dispute`, { stage: 'CHARGEBACK' })).body;
      expect(opened.status).toBe('UNDER_REVIEW');
      expect(opened.amount).toBe('9.00');
      const asked = await api('POST', `${PJ}/payments/disputes/${opened.id}/merchant`, { action: 'require-evidence', input: { action: 'SELLER_EVIDENCE' } });
      expect(asked.status, asked.text).toBe(200);
      expect(asked.body.status).toBe('WAITING_FOR_SELLER_RESPONSE');
      expect(asked.body.allowed).toContain('provide-evidence');
      const res = await api('POST', `${PJ}/payments/disputes/${opened.id}/resolve`, { outcome: 'seller' });
      expect(res.body.outcome).toBe('RESOLVED_SELLER_FAVOUR');
      expect((await api('POST', `${PJ}/payments/disputes/${opened.id}/resolve`, { outcome: 'seller' })).status).toBe(409);
    });
  });
});
