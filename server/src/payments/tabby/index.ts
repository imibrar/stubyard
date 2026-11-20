import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bearerToken, bodyOf, decodeRef, header, isLiveKey, uuid } from '../common.js';
import { currencyDigits, fromDecimal, normalizeOutcome, OPEN, toDecimal } from '../engine.js';
import { finding, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance } from '../repo.js';
import type { PaymentService } from '../service.js';
import { HttpError } from '../../util.js';

/**
 * Fake Tabby (Pay in 4) under /pay/<project>/<instance>/api/…: POST /api/v2/checkout (session + pre-scoring), the
 * hosted page (web_url: test-user picker + OTP), GET/PUT /api/v2/payments/:id, captures, refunds, close, and webhooks
 * (POST /api/v1/webhooks) that carry the merchant's own header title / value instead of a signature. docs.tabby.ai, Nov 2026.
 */

class TabbyError extends Error {
  constructor(
    public status: number,
    public errorType: string,
    message: string,
  ) {
    super(message);
  }
}

/** Tabby's documented test buyers (docs.tabby.ai/testing-guidelines/testing-credentials). OTP is always 8888. */
export const TABBY_OTP = '8888';
const PRESCORING_REJECT = ['+971500000002', '+966500000002', '971500000002', '966500000002', '0500000002', '500000002'];
const HPP_REJECT_EMAIL = 'otp.rejected@tabby.ai';

const money = (minor: number, currency: string) => toDecimal(minor, currency);

function tabbyStatus(p: Payment): string {
  switch (p.status) {
    case 'created':
    case 'pending':
    case 'requires_action':
      return 'CREATED';
    case 'authorized':
      return 'AUTHORIZED';
    case 'paid':
      return p.providerData.partialCapture && !p.providerData.closed ? 'AUTHORIZED' : 'CLOSED';
    case 'partially_refunded':
    case 'refunded':
      return 'CLOSED';
    case 'failed':
      return 'REJECTED';
    case 'cancelled':
      return p.providerData.voided ? 'CLOSED' : 'EXPIRED';
    case 'expired':
      return 'EXPIRED';
  }
}

type Capture = { id: string; created_at: string; amount: string; tax_amount: string; shipping_amount: string; discount_amount: string; items: unknown[]; reference_id: string | null };
type Refund = { id: string; created_at: string; amount: string; reason: string | null; items: unknown[]; reference_id: string | null };

/** The Tabby payment object (API: uppercase status; webhooks: lowercase). */
export function tabbyPayment(svc: PaymentService, p: Payment, _inst: PaymentInstance, opts: { webhook?: boolean } = {}): Json {
  const pay = (p.request.payment ?? {}) as Json;
  const st = tabbyStatus(p);
  const order = { ...((pay.order ?? {}) as Json), ...(p.providerData.orderReference ? { reference_id: p.providerData.orderReference } : {}) };
  return {
    id: p.providerRef,
    created_at: p.createdAt,
    expires_at: p.expiresAt,
    status: opts.webhook ? st.toLowerCase() : st,
    is_test: true,
    is_expired: st === 'EXPIRED',
    product: { type: 'installments', installments_count: 4, installment_period: 'P1M' },
    amount: money(p.amount, p.currency),
    currency: p.currency,
    description: asString(pay.description) ?? '',
    buyer: (pay.buyer as Json | undefined) ?? {},
    buyer_history: (pay.buyer_history as Json | undefined) ?? {},
    shipping_address: (pay.shipping_address as Json | undefined) ?? {},
    order,
    order_history: (pay.order_history as unknown[] | undefined) ?? [],
    meta: (pay.meta as Json | undefined) ?? {},
    captures: (p.providerData.captures as Capture[] | undefined) ?? [],
    refunds: (p.providerData.tabbyRefunds as Refund[] | undefined) ?? [],
    cancelable: st === 'AUTHORIZED' && !(p.providerData.captures as unknown[] | undefined)?.length,
    attachment: (pay.attachment as Json | undefined) ?? null,
  };
}

function session(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const rejected = !!p.providerData.rejected;
  const quarter = Math.floor(p.amount / 4);
  const parts = [p.amount - quarter * 3, quarter, quarter, quarter];
  const due = (i: number) => new Date(Date.now() + i * 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    id: p.secondaryRef,
    configuration: {
      currency: p.currency,
      app_type: 'web',
      new_customer: false,
      available_limit: rejected ? '0.00' : '5000.00',
      min_limit: '10.00',
      available_products: rejected
        ? { installments: [] }
        : {
            installments: [
              {
                downpayment: money(parts[0]!, p.currency),
                downpayment_percent: '25',
                amount_to_pay: money(p.amount, p.currency),
                downpayment_total: money(parts[0]!, p.currency),
                order_amount: money(p.amount, p.currency),
                next_payment_date: due(1),
                installments: parts.slice(1).map((a, i) => ({ due_date: due(i + 1), amount: money(a, p.currency), principal: money(a, p.currency), service_fee: '0.00' })),
                pay_after_delivery: false,
                pay_per_installment: money(quarter, p.currency),
                web_url: svc.entryUrl(project, inst, p),
                qr_code: svc.entryUrl(project, inst, p) + '?qr=1',
                id: 1,
                installments_count: 3,
                installment_period: 'P1M',
                service_fee: '0.00',
              },
            ],
          },
      country: asString(((((p.request.payment ?? {}) as Json).shipping_address ?? {}) as Json).country) ?? (p.currency === 'SAR' ? 'SA' : p.currency === 'KWD' ? 'KW' : 'AE'),
      expires_at: p.expiresAt,
      is_bank_card_required: true,
      products: { installments: { type: 'installments', is_available: !rejected, rejection_reason: rejected ? String(p.providerData.rejectionReason ?? 'not_available') : null } },
    },
    api_url: 'https://api.tabby.ai',
    token: null,
    flow: 'regular',
    payment: tabbyPayment(svc, p, inst),
    status: rejected ? 'rejected' : 'created',
    merchant: { name: 'stubyard test merchant', address: '', logo: '' },
    merchant_code: asString(p.request.merchant_code),
    terms_accepted: false,
    merchant_urls: p.request.merchant_urls ?? {},
    lang: asString(p.request.lang) ?? 'en',
  };
}

// ---------------- auth ----------------

function auth(c: GatewayCtx, checkout: boolean): void {
  const key = bearerToken(c.req);
  if (!key) throw new TabbyError(401, 'not_authorized', header(c.req, 'authorization') ? 'missing Bearer scheme' : 'missing authorization header');
  if (isLiveKey(key)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', 'A live key (' + key.slice(0, 8) + '…) was sent to ' + c.inst.slug));
    c.resolved.warnings = ['live key rejected'];
    throw new TabbyError(401, 'not_authorized', 'stubyard never accepts live keys; use the instance\'s sk_test_ key');
  }
  const cfg = c.inst.config;
  if (/^pk_/.test(key)) {
    if (!checkout) throw new TabbyError(401, 'not_authorized', 'this endpoint needs the secret key');
    c.resolved.warnings = ['POST /api/v2/checkout takes the secret key (Authorization: Bearer sk_test_…); the public key is for the promo widgets'];
  }
  const ok = cfg.strictKeys ? key === cfg.secretKey || (checkout && key === cfg.publicKey) : /^(sk|pk)_test_[A-Za-z0-9-]{8,}$/.test(key) || key === cfg.secretKey;
  if (!ok) throw new TabbyError(401, 'not_authorized', 'invalid secret key');
}

function forced(c: GatewayCtx): string | null {
  const f = header(c.req, 'x-hub-payment-outcome');
  if (!f) return null;
  try {
    return normalizeOutcome(f);
  } catch (e) {
    throw new TabbyError(400, 'bad_data', 'X-Hub-Payment-Outcome: ' + (e as Error).message);
  }
}

const isDecimalString = (v: unknown) => typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v);

function amountIn(v: unknown, currency: string, field: string, lint: LintFinding[]): number {
  if (v === undefined || v === null || v === '') throw new TabbyError(400, 'bad_data', field + ' is required');
  if (!isDecimalString(v)) lint.push(finding('pay.tabby-amount-format', field + ' is ' + JSON.stringify(v) + ': send a string with up to 2 decimals ("100.00")'));
  const a = fromDecimal(v, currency);
  if (!a.ok || a.minor <= 0) throw new TabbyError(400, 'bad_data', field + ' is invalid');
  return a.minor;
}

async function checkout(c: GatewayCtx, b: Json): Promise<unknown> {
  const pay = (b.payment ?? null) as Json | null;
  if (!pay || typeof pay !== 'object') throw new TabbyError(400, 'bad_data', 'payment is required');
  const currency = (asString(pay.currency) ?? '').toUpperCase();
  if (!['AED', 'SAR', 'KWD'].includes(currency)) throw new TabbyError(400, 'bad_data', "could not create payment: only 'AED', 'SAR' and 'KWD' are supported, but got '" + currency + "'");
  const lint: LintFinding[] = [];
  const amount = amountIn(pay.amount, currency, 'payment.amount', lint);
  const buyer = (pay.buyer ?? null) as Json | null;
  if (!buyer || !asString(buyer.phone) || !asString(buyer.email) || !asString(buyer.name)) throw new TabbyError(400, 'bad_data', 'payment.buyer.name, email and phone are required');
  const order = (pay.order ?? null) as Json | null;
  if (!order || !asString(order.reference_id)) throw new TabbyError(400, 'bad_data', 'payment.order.reference_id is required');
  if (!Array.isArray(order.items) || !order.items.length) throw new TabbyError(400, 'bad_data', 'payment.order.items is required');
  if (!asString(b.merchant_code)) throw new TabbyError(400, 'bad_data', 'merchant_code is required');
  if (c.inst.config.merchantCode && asString(b.merchant_code) !== c.inst.config.merchantCode) throw new TabbyError(400, 'bad_data', 'merchant_code does not match this merchant');
  if (!['ar', 'en'].includes(String(b.lang ?? 'en'))) throw new TabbyError(400, 'bad_data', 'lang must be ar or en');
  const urls = (b.merchant_urls ?? {}) as Json;
  for (const k of ['success', 'cancel', 'failure']) {
    if (rejectUrl(urls[k])) throw new TabbyError(400, 'bad_data', 'merchant_urls.' + k + ' is not a valid URL');
  }
  if (!asString(urls.success)) lint.push(finding('pay.return-url-missing-or-bad', 'merchant_urls.success is missing (required for web checkouts)'));
  if (!pay.shipping_address || !pay.buyer_history) lint.push(finding('pay.no-reference', 'payment.shipping_address / buyer_history missing: the real API rejects the session'));
  for (const k of ['tax_amount', 'shipping_amount', 'discount_amount']) if (order[k] !== undefined && !isDecimalString(order[k])) lint.push(finding('pay.tabby-amount-format', 'payment.order.' + k + ' is ' + JSON.stringify(order[k])));
  const phone = String(buyer.phone).replace(/\s/g, '');
  const rejected = PRESCORING_REJECT.includes(phone) || PRESCORING_REJECT.some((x) => phone.endsWith(x.replace(/^\+/, '')) && x.startsWith('+'));
  let preset = forced(c);
  if (!preset && String(buyer.email).toLowerCase() === HPP_REJECT_EMAIL) preset = 'decline:generic';
  const p = c.svc.create(c, {
    kind: 'order',
    providerRef: uuid(),
    secondaryRef: uuid(),
    amount,
    currency,
    reference: asString(order.reference_id),
    customerEmail: asString(buyer.email),
    returnUrl: asString(urls.success),
    cancelUrl: asString(urls.cancel),
    callbackUrl: null,
    presetOutcome: preset,
    request: b,
    method: 'bnpl',
    status: rejected ? 'failed' : undefined,
    providerData: { methods: ['bnpl'], otpPhone: phone, ...(rejected ? { rejected: true, rejectionReason: 'not_available', declineReason: 'generic' } : {}), ...(preset && String(buyer.email).toLowerCase() === HPP_REJECT_EMAIL ? { testBuyer: 'otp.rejected' } : {}) },
    idempotencyKey: null,
    lint,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  c.resolved.endpoint = 'create checkout session' + (rejected ? ' (pre-scoring: rejected)' : '');
  return session(c.svc, p, c.inst);
}

// ---------------- payments ----------------

async function findPayment(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p) throw new TabbyError(404, 'not_found', 'payment not found');
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

async function capture(c: GatewayCtx, p: Payment, b: Json): Promise<unknown> {
  const ref = asString(b.reference_id);
  if (!ref) throw new TabbyError(400, 'bad_data', 'reference_id is required');
  const caps = ((p.providerData.captures as Capture[] | undefined) ?? []).slice();
  if (caps.some((x) => x.reference_id === ref)) return tabbyPayment(c.svc, p, c.inst);
  if (tabbyStatus(p) !== 'AUTHORIZED') {
    c.svc.addLint(p, [finding('pay.capture-before-approve', 'Capture while the payment was ' + tabbyStatus(p))]);
    throw new TabbyError(400, 'bad_data', 'could not capture not authorized payments');
  }
  const lint: LintFinding[] = [];
  const amount = amountIn(b.amount, p.currency, 'amount', lint);
  if (lint.length) c.svc.addLint(p, lint);
  const r = await c.svc.capture(p, { idempotencyKey: ref, amount, final: false });
  if (r.error === 'amount_exceeds') throw new TabbyError(400, 'bad_data', 'capture amount is greater than the amount left to capture');
  if (r.error) throw new TabbyError(400, 'bad_data', 'could not capture: ' + r.error);
  const cur = c.svc.repo.get(p.id)!;
  caps.push({ id: uuid(), created_at: new Date().toISOString(), amount: money(amount, p.currency), tax_amount: String(b.tax_amount ?? '0.00'), shipping_amount: String(b.shipping_amount ?? '0.00'), discount_amount: String(b.discount_amount ?? '0.00'), items: Array.isArray(b.items) ? b.items : [], reference_id: ref });
  const out = c.svc.repo.update(p.id, { providerData: { ...cur.providerData, captures: caps } });
  return tabbyPayment(c.svc, out, c.inst);
}

async function refund(c: GatewayCtx, p: Payment, b: Json): Promise<unknown> {
  const ref = asString(b.reference_id);
  if (!ref) throw new TabbyError(400, 'bad_data', 'reference_id is required');
  const list = ((p.providerData.tabbyRefunds as Refund[] | undefined) ?? []).slice();
  if (list.some((x) => x.reference_id === ref)) return tabbyPayment(c.svc, p, c.inst);
  if (tabbyStatus(p) !== 'CLOSED' || !((p.providerData.captures as unknown[] | undefined) ?? []).length) throw new TabbyError(400, 'bad_data', 'can not refund payment that has no captures and not closed');
  const lint: LintFinding[] = [];
  const amount = amountIn(b.amount, p.currency, 'amount', lint);
  const rid = uuid();
  try {
    await c.svc.refund(p, amount, { providerRef: rid, reason: asString(b.reason) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new TabbyError(400, 'bad_data', e.message);
    throw e;
  }
  const cur = c.svc.repo.get(p.id)!;
  list.push({ id: rid, created_at: new Date().toISOString(), amount: money(amount, p.currency), reason: asString(b.reason), items: Array.isArray(b.items) ? b.items : [], reference_id: ref });
  const out = c.svc.repo.update(p.id, { providerData: { ...cur.providerData, tabbyRefunds: list } });
  return tabbyPayment(c.svc, out, c.inst);
}

async function close(c: GatewayCtx, p: Payment): Promise<unknown> {
  const st = tabbyStatus(p);
  if (st === 'CLOSED') throw new TabbyError(400, 'bad_data', 'already closed');
  if (st !== 'AUTHORIZED') throw new TabbyError(400, 'bad_data', 'could not close payment in status ' + st);
  if (p.status === 'authorized') {
    // Nothing captured: the authorization is released.
    return tabbyPayment(c.svc, await c.svc.voidPayment(p, { webhook: true }), c.inst);
  }
  // Partly captured: the rest is released, the payment is CLOSED (refunds now possible).
  const out = c.svc.repo.update(p.id, { providerData: { ...p.providerData, closed: true, partialCapture: false } });
  c.svc.repo.addEvent(out, 'tabby_closed', { captured: out.providerData.capturedAmount });
  await c.svc.webhooks.emit(out, c.inst, 'paid', null);
  c.svc.changed(out.projectId, { payment: out.id });
  return tabbyPayment(c.svc, c.svc.repo.get(p.id)!, c.inst);
}

// ---------------- webhooks registry ----------------

type Hook = { id: string; url: string; is_test: boolean; header: { title: string; value: string } };
const hooksOf = (inst: PaymentInstance): Hook[] => (Array.isArray(inst.config.webhooks) ? (inst.config.webhooks as Hook[]) : []);

async function webhooks(c: GatewayCtx, id: string | null): Promise<unknown> {
  if (!header(c.req, 'x-merchant-code')) throw new TabbyError(400, 'bad_data', 'X-Merchant-Code header is required');
  const m = c.req.method;
  const hooks = hooksOf(c.inst);
  const save = (list: Hook[]) => {
    c.svc.repo.updateInstance(c.inst.id, { config: { ...c.inst.config, webhooks: list } });
    c.svc.changed(c.inst.projectId, { instance: c.inst.slug, webhooks: list.length });
  };
  if (!id && m === 'GET') return hooks;
  if (!id && m === 'POST') {
    const b = bodyOf(c.req);
    const url = asString(b.url);
    if (!url || rejectUrl(url)) throw new TabbyError(400, 'bad_data', 'url is invalid');
    if (hooks.length >= 4) throw new TabbyError(400, 'bad_data', 'maximum 4 webhooks per merchant code');
    const h0 = (b.header ?? {}) as Json;
    const h: Hook = { id: uuid(), url, is_test: true, header: { title: asString(h0.title) ?? '', value: asString(h0.value) ?? '' } };
    save([...hooks, h]);
    c.resolved.endpoint = 'register webhook';
    return h;
  }
  const h = id ? hooks.find((x) => x.id === id) : null;
  if (!h) throw new TabbyError(404, 'not_found', 'no such webhook');
  if (m === 'GET') return h;
  if (m === 'PUT') {
    const b = bodyOf(c.req);
    const h0 = (b.header ?? h.header) as Json;
    const next: Hook = { ...h, url: asString(b.url) ?? h.url, header: { title: asString(h0.title) ?? h.header.title, value: asString(h0.value) ?? h.header.value } };
    save(hooks.map((x) => (x.id === h.id ? next : x)));
    return next;
  }
  if (m === 'DELETE') {
    save(hooks.filter((x) => x.id !== h.id));
    return {};
  }
  throw new TabbyError(404, 'not_found', 'not simulated');
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const m = c.req.method;
  const path = c.path.replace(/\/+$/, '');
  const entry = /^\/hpp\/([^/]+)$/.exec(path);
  if (entry && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(entry[1]!));
    if (!p) throw new TabbyError(404, 'not_found', 'session not found');
    c.resolved.payment = p.id;
    c.resolved.endpoint = 'payment page';
    return c.reply.redirect('../page/' + p.id, 302);
  }
  if (!path.startsWith('/api/')) throw new TabbyError(404, 'not_found', m + ' ' + path + ' is not simulated by stubyard (Tabby: /api/v2/checkout, /api/v2/payments, /api/v1/webhooks)');
  auth(c, m === 'POST' && path === '/api/v2/checkout');
  const b = bodyOf(c.req);
  if (m === 'POST' && path === '/api/v2/checkout') return checkout(c, b);
  const cs = /^\/api\/v2\/checkout\/([^/]+)$/.exec(path);
  if (cs && m === 'GET') {
    const p = await findPayment(c, cs[1]!);
    return session(c.svc, p, c.inst);
  }
  if (m === 'GET' && path === '/api/v2/payments') {
    const list = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: Math.min(Number(c.query.limit ?? 20) || 20, 100) });
    return { payments: await Promise.all(list.map(async (p) => tabbyPayment(c.svc, await c.svc.touch(p), c.inst))), pagination: { limit: list.length, offset: 0, total_count: list.length } };
  }
  const pm = /^\/api\/v2\/payments\/([^/]+)(?:\/(captures|refunds|close))?$/.exec(path);
  if (pm) {
    const p = await findPayment(c, pm[1]!);
    const action = pm[2];
    if (!action && m === 'GET') {
      c.resolved.endpoint = 'retrieve payment';
      c.svc.repo.addEvent(p, 'status_queried', { via: 'GET /api/v2/payments/:id' });
      return tabbyPayment(c.svc, p, c.inst);
    }
    if (!action && m === 'PUT') {
      const ref = asString(((b.order ?? {}) as Json).reference_id);
      if (!ref) throw new TabbyError(400, 'bad_data', 'order.reference_id is required');
      if (!['AUTHORIZED', 'CLOSED'].includes(tabbyStatus(p))) throw new TabbyError(400, 'bad_data', 'payment must be AUTHORIZED or CLOSED');
      const out = c.svc.repo.update(p.id, { reference: ref, providerData: { ...p.providerData, orderReference: ref } });
      return tabbyPayment(c.svc, out, c.inst);
    }
    if (m === 'POST' && action) {
      c.resolved.endpoint = action === 'captures' ? 'capture' : action === 'refunds' ? 'refund' : 'close';
      if (action === 'captures') return capture(c, p, b);
      if (action === 'refunds') return refund(c, p, b);
      return close(c, p);
    }
  }
  const wh = /^\/api\/v1\/webhooks(?:\/([^/]+))?$/.exec(path);
  if (wh) return webhooks(c, wh[1] ?? null);
  throw new TabbyError(404, 'not_found', m + ' ' + path + ' is not simulated by stubyard');
}

function target(inst: PaymentInstance): { url: string; header: { title: string; value: string } | null } | null {
  const h = hooksOf(inst)[0];
  if (h) return { url: h.url, header: h.header.title ? h.header : null };
  if (!inst.config.webhookUrl) return null;
  const title = asString(inst.config.webhookHeaderTitle);
  return { url: inst.config.webhookUrl, header: title ? { title, value: String(inst.config.webhookHeaderValue ?? '') } : null };
}

export const tabbyGateway: Gateway = {
  preset: 'tabby',
  name: 'Tabby',
  description: 'Tabby Pay in 4 (API v2): checkout session with pre-scoring, hosted page with test buyers + OTP, captures (partial), refunds, close, webhooks with your own auth header.',
  available: true,
  note: 'Built from docs.tabby.ai (Nov 2026). Webhooks are not signed: Tabby sends the header title / value you registered. The exact webhook body is modelled on the payment object (lowercase status), as the docs describe it.',
  kind: 'order',
  methods: ['bnpl'],
  logo: 'TB',
  slugBase: 'tabby',
  magicOtps: [TABBY_OTP],
  otpSender: 'Tabby',
  declineOnApprove: true,
  fields: [
    { key: 'secretKey', label: 'Secret key', secret: true, hint: 'sk_test_…: Authorization: Bearer for every server call' },
    { key: 'publicKey', label: 'Public key', hint: 'pk_test_…: promo widgets / Tabby Card' },
    { key: 'merchantCode', label: 'Merchant code', hint: 'merchant_code of the checkout and X-Merchant-Code of webhook calls' },
    { key: 'webhookUrl', label: 'Default webhook URL', hint: 'Used until a webhook is registered with POST /api/v1/webhooks' },
    { key: 'webhookHeaderTitle', label: 'Webhook header name', hint: 'e.g. X-Auth-Key (sent with every webhook)' },
    { key: 'webhookHeaderValue', label: 'Webhook header value', secret: true, hint: 'The value your app checks' },
  ],
  defaults: () => ({ secretKey: 'sk_test_' + alnum(32), publicKey: 'pk_test_' + alnum(32), merchantCode: 'stubyard', webhookHeaderTitle: 'X-Auth-Key', webhookHeaderValue: alnum(24), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: () => false,
  retryOnDecline: false,
  entryPath: (p) => '/hpp/' + p.providerRef,
  refundRef: () => uuid(),
  methodsFor: () => ['bnpl'],
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof TabbyError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ status: 'error', errorType: e.errorType, error: e.message });
      }
      if (e instanceof HttpError && e.statusCode < 500) return c.reply.status(e.statusCode).send({ status: 'error', errorType: e.statusCode === 404 ? 'not_found' : e.statusCode === 409 ? 'conflict' : 'bad_data', error: e.message });
      throw e;
    }
  },
  returnTo: (_svc, p, _inst, kind) => {
    const urls = (p.request.merchant_urls ?? {}) as Json;
    const t = asString(kind === 'success' ? urls.success : kind === 'cancelled' ? urls.cancel : urls.failure);
    if (!t) return null;
    const u = new URL(t);
    u.searchParams.set('payment_id', p.providerRef);
    return { kind: 'redirect', url: u.toString() };
  },
  events: (p, point) => {
    switch (point) {
      case 'approved':
        return ['authorized'];
      case 'paid':
        return [p.providerData.partialCapture && !p.providerData.closed ? 'capture' : 'closed'];
      case 'refunded':
        return ['refund'];
      case 'failed':
        return ['rejected'];
      case 'cancelled':
        return [p.providerData.voided ? 'closed' : 'expired'];
      case 'expired':
        return ['expired'];
      default:
        return [];
    }
  },
  buildEvent: (svc, p, inst, type) => {
    const t = target(inst);
    const body = tabbyPayment(svc, p, inst, { webhook: true });
    return { url: t?.url ?? null, body: JSON.stringify(body), eventId: p.providerRef + ':' + type + ':' + String(((p.providerData.captures as unknown[] | undefined) ?? []).length) + ':' + String(((p.providerData.tabbyRefunds as unknown[] | undefined) ?? []).length), signing: null, headers: t?.header ? { [t.header.title]: t.header.value } : undefined };
  },
  shape: (svc, p, inst) => tabbyPayment(svc, p, inst),
  providerStatus: (p) => tabbyStatus(p),
  lateLint: (_svc, p) => (p.status === 'authorized' && !p.providerData.async ? [finding('pay.tabby-not-captured', 'Payment ' + p.providerRef + ' is AUTHORIZED but was never captured (POST /api/v2/payments/:id/captures)')] : []),
  connect: (inst, urls) => ({
    env: { TABBY_SECRET_KEY: inst.config.secretKey ?? '', TABBY_PUBLIC_KEY: String(inst.config.publicKey ?? ''), TABBY_MERCHANT_CODE: String(inst.config.merchantCode ?? ''), TABBY_WEBHOOK_HEADER: String(inst.config.webhookHeaderTitle ?? ''), TABBY_WEBHOOK_SECRET: String(inst.config.webhookHeaderValue ?? ''), TABBY_BASE_URL: urls.backend, TABBY_BASE_URL_LOCAL: urls.backendLocal },
    notes: [
      'Use TABBY_BASE_URL instead of https://api.tabby.ai (or api.tabby.sa): POST {base}/api/v2/checkout with "Authorization: Bearer <secret key>"; send the buyer to configuration.available_products.installments[0].web_url.',
      'Amounts are decimal strings ("100.00"). The buyer returns to merchant_urls.success | cancel | failure?payment_id=…; then GET /api/v2/payments/:id and capture: POST /api/v2/payments/:id/captures {amount, reference_id}.',
      'Test buyers: otp.success@tabby.ai with +971500000001 / +966500000001 → approved; +971500000002 / +966500000002 → pre-scoring rejected (status "rejected", no web_url); otp.rejected@tabby.ai → rejected on the page. OTP 8888 (or the code in the SMS inbox).',
      'Webhooks: register with POST /api/v1/webhooks (X-Merchant-Code header) {url, header: {title, value}}, or set the default URL + header here. There is no signature: compare the header value, then re-fetch the payment.',
      'Tabby has no official server SDK; call the REST API with your HTTP client and a configurable base URL.',
    ],
    snippets: [
      {
        title: 'Check a webhook (Node)',
        lang: 'js',
        code: "import { timingSafeEqual } from 'node:crypto';\napp.post('/webhooks/tabby', express.json(), async (req, res) => {\n  const got = Buffer.from(String(req.headers['x-auth-key'] ?? ''));\n  const want = Buffer.from(process.env.TABBY_WEBHOOK_SECRET);\n  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.sendStatus(401);\n  // re-fetch: GET /api/v2/payments/:id (req.body.id), then capture if AUTHORIZED\n  res.sendStatus(200);\n});",
      },
      {
        title: 'Check a webhook (PHP)',
        lang: 'php',
        code: "if (!hash_equals(getenv('TABBY_WEBHOOK_SECRET'), $_SERVER['HTTP_X_AUTH_KEY'] ?? '')) { http_response_code(401); exit; }\n$payment = json_decode(file_get_contents('php://input'), true);\nhttp_response_code(200);",
      },
    ],
  }),
};
