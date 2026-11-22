import { createHmac } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, b64url, bearerToken, bodyOf, decodeRef, header, isLiveKey, uuid } from '../common.js';
import { fromDecimal, normalizeOutcome, OPEN, toDecimal } from '../engine.js';
import { finding, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance } from '../repo.js';
import type { PaymentService } from '../service.js';
import { HttpError } from '../../util.js';
import { tamaraWidgetRoute } from './widget.js';

/**
 * Fake Tamara (BNPL) under /pay/<project>/<instance>/…: POST /checkout, the hosted page (checkout_url), POST
 * /orders/:id/authorise, /payments/capture, /payments/simplified-refund/:id, /orders/:id/cancel, GET /orders/:id (and
 * /merchants/orders/reference-id/:ref), PUT /orders/:id/reference-id and the webhook registry (POST /webhooks).
 * Notifications carry tamaraToken: an HS256 JWT signed with the notification token (query + Authorization: Bearer).
 * docs.tamara.co, Nov 2026.
 */

class TamaraError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Json = {},
  ) {
    super(message);
  }
}

/** Tamara's documented decline phones (sandbox). */
const DECLINE_PHONES = ['536422337', '526422337'];
/** Tamara's documented decline test phones (KSA 536422337 / UAE 526422337, any prefix). */
export const isTamaraDeclinePhone = (raw: string) => DECLINE_PHONES.some((x) => String(raw ?? '').replace(/\D/g, '').endsWith(x));
const COUNTRIES: Record<string, string> = { SAR: 'SA', AED: 'AE', KWD: 'KW', BHD: 'BH', OMR: 'OM', QAR: 'QA' };

const money = (minor: number, currency: string) => ({ amount: Number(toDecimal(minor, currency)), currency });

type Tx = { id: string; amount: number; created_at: string; comment?: string | null };

function tamaraStatus(p: Payment): string {
  const captured = Number(p.providerData.capturedAmount ?? 0);
  switch (p.status) {
    case 'created':
    case 'pending':
    case 'requires_action':
      return 'new';
    case 'authorized':
      return p.providerData.authorization ? 'authorised' : 'approved';
    case 'paid':
      return captured > 0 && captured < p.amount ? 'partially_captured' : 'fully_captured';
    case 'partially_refunded':
      return 'partially_refunded';
    case 'refunded':
      return 'fully_refunded';
    case 'failed':
      return 'declined';
    case 'cancelled':
      return p.providerData.voided ? 'canceled' : 'declined';
    case 'expired':
      return 'expired';
  }
}

const txs = (p: Payment, k: 'captures' | 'refunds' | 'cancels') => (((p.providerData.tamaraTx ?? {}) as Record<string, Tx[]>)[k] ?? []).slice();

/** GET /orders/:id. */
export function tamaraOrder(_svc: PaymentService, p: Payment, _inst: PaymentInstance): Json {
  const b = p.request;
  const sum = (k: 'captures' | 'refunds' | 'cancels') => txs(p, k).reduce((a, t) => a + t.amount, 0);
  const tx = (k: 'captures' | 'refunds' | 'cancels') => txs(p, k).map((t) => ({ [k.slice(0, -1) + '_id']: t.id, order_id: p.providerRef, total_amount: money(t.amount, p.currency), created_at: t.created_at, ...(t.comment ? { comment: t.comment } : {}) }));
  return {
    order_id: p.providerRef,
    order_reference_id: p.reference,
    order_number: asString(b.order_number) ?? p.reference,
    consumer: (b.consumer as Json | undefined) ?? {},
    status: tamaraStatus(p),
    shipping_address: (b.shipping_address as Json | undefined) ?? {},
    billing_address: (b.billing_address as Json | undefined) ?? {},
    items: (b.items as unknown[] | undefined) ?? [],
    payment_type: asString(b.payment_type) ?? 'PAY_BY_INSTALMENTS',
    instalments: Number(b.instalments ?? 3),
    total_amount: money(p.amount, p.currency),
    shipping_amount: (b.shipping_amount as Json | undefined) ?? money(0, p.currency),
    tax_amount: (b.tax_amount as Json | undefined) ?? money(0, p.currency),
    discount_amount: (b.discount as Json | undefined) ?? money(0, p.currency),
    captured_amount: money(sum('captures'), p.currency),
    refunded_amount: money(sum('refunds'), p.currency),
    canceled_amount: money(sum('cancels'), p.currency),
    paid_amount: money(0, p.currency),
    settlement_status: 'pending',
    settlement_date: null,
    created_at: p.createdAt,
    description: asString(b.description) ?? '',
    is_mobile: false,
    locale: asString(b.locale) ?? 'en_US',
    platform: asString(b.platform) ?? '',
    wallet_prepaid_amount: money(0, p.currency),
    transactions: { cancels: tx('cancels'), captures: tx('captures'), refunds: tx('refunds') },
    processing: false,
    store_code: null,
    additional_data: (b.additional_data as Json | undefined) ?? {},
  };
}

// ---------------- notification token ----------------

/** tamaraToken: HS256 JWT {iss: 'Tamara', iat, exp} signed with the notification token. */
export function tamaraToken(notificationToken: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: 'Tamara', iat: now, exp: now + 900, jti: uuid() }));
  const sig = createHmac('sha256', notificationToken).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}

// ---------------- auth ----------------

function auth(c: GatewayCtx): void {
  const key = bearerToken(c.req);
  if (!key) throw new TamaraError(401, 'unauthorized', 'Unauthorized: send "Authorization: Bearer <API token>"');
  if (isLiveKey(key)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', 'A live key (' + key.slice(0, 8) + '…) was sent to ' + c.inst.slug));
    c.resolved.warnings = ['live key rejected'];
    throw new TamaraError(401, 'unauthorized', 'stubyard never accepts live credentials');
  }
  const cfg = c.inst.config;
  if (cfg.strictKeys ? key !== cfg.apiToken : key.length < 16 && key !== cfg.apiToken) throw new TamaraError(401, 'unauthorized', 'Invalid API token');
}

function forced(c: GatewayCtx): string | null {
  const f = header(c.req, 'x-hub-payment-outcome');
  if (!f) return null;
  try {
    return normalizeOutcome(f);
  } catch (e) {
    throw new TamaraError(400, 'invalid_outcome', 'X-Hub-Payment-Outcome: ' + (e as Error).message);
  }
}

function moneyField(v: unknown, field: string, currency: string | null): { minor: number; currency: string } {
  const m = (v ?? null) as Json | null;
  if (!m || typeof m !== 'object') throw new TamaraError(400, 'invalid_' + field, field + ' is required', { field });
  const cur = (asString(m.currency) ?? '').toUpperCase();
  if (!cur) throw new TamaraError(400, 'invalid_' + field + '_currency', field + '.currency is required');
  if (currency && cur !== currency) throw new TamaraError(400, 'currency_mismatch', field + '.currency must be ' + currency);
  const a = fromDecimal(m.amount, cur);
  if (!a.ok || a.minor <= 0) throw new TamaraError(400, 'invalid_' + field + '_amount', field + '.amount is invalid');
  return { minor: a.minor, currency: cur };
}

async function checkout(c: GatewayCtx, b: Json): Promise<unknown> {
  const total = moneyField(b.total_amount, 'total_amount', null);
  if (!COUNTRIES[total.currency]) throw new TamaraError(400, 'unsupported_currency', 'Currency ' + total.currency + ' is not supported');
  const lint: LintFinding[] = [];
  if (!asString(b.order_reference_id)) throw new TamaraError(400, 'order_reference_id_is_required', 'order_reference_id is required');
  if (!Array.isArray(b.items) || !b.items.length) throw new TamaraError(400, 'items_is_required', 'items is required');
  const consumer = (b.consumer ?? null) as Json | null;
  if (!consumer || !asString(consumer.phone_number) || !asString(consumer.first_name)) throw new TamaraError(400, 'consumer_is_invalid', 'consumer.first_name and consumer.phone_number are required');
  if (!b.shipping_address) throw new TamaraError(400, 'shipping_address_is_required', 'shipping_address is required');
  const urls = (b.merchant_url ?? {}) as Json;
  for (const k of ['success', 'failure', 'cancel', 'notification']) if (rejectUrl(urls[k])) throw new TamaraError(400, 'invalid_merchant_url', 'merchant_url.' + k + ' is not a valid URL');
  if (!asString(urls.success)) lint.push(finding('pay.return-url-missing-or-bad', 'merchant_url.success is missing'));
  if (!asString(b.country_code)) throw new TamaraError(400, 'country_code_is_required', 'country_code is required');
  const phone = String(consumer.phone_number).replace(/\D/g, '');
  const declined = DECLINE_PHONES.some((x) => phone.endsWith(x));
  const preset = forced(c) ?? (declined ? 'decline:generic' : null);
  const p = c.svc.create(c, {
    kind: 'order',
    providerRef: uuid(),
    secondaryRef: uuid(),
    amount: total.minor,
    currency: total.currency,
    reference: asString(b.order_reference_id),
    customerEmail: asString(consumer.email),
    returnUrl: asString(urls.success),
    cancelUrl: asString(urls.cancel),
    callbackUrl: asString(urls.notification),
    presetOutcome: preset,
    request: b,
    method: 'bnpl',
    providerData: { methods: ['bnpl'], otpPhone: String(consumer.phone_number) },
    idempotencyKey: null,
    lint,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  c.resolved.endpoint = 'create checkout session';
  return { order_id: p.providerRef, checkout_id: p.secondaryRef, checkout_url: c.svc.entryUrl(c.project, c.inst, p), status: 'new' };
}

async function findOrder(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p) throw new TamaraError(404, 'order_not_found', 'Order not found');
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

const pushTx = (svc: PaymentService, p: Payment, k: 'captures' | 'refunds' | 'cancels', t: Tx) => {
  const cur = svc.repo.get(p.id)!;
  const all = { ...((cur.providerData.tamaraTx ?? {}) as Json), [k]: [...txs(cur, k), t] };
  return svc.repo.update(p.id, { providerData: { ...cur.providerData, tamaraTx: all } });
};

async function authorise(c: GatewayCtx, p: Payment): Promise<unknown> {
  const st = tamaraStatus(p);
  if (st === 'authorised' || st === 'fully_captured') {
    return { order_id: p.providerRef, status: st, order_expiry_time: p.expiresAt, payment_type: asString(p.request.payment_type) ?? 'PAY_BY_INSTALMENTS', auto_captured: false, authorized_amount: money(p.amount, p.currency), capture_id: null };
  }
  if (st !== 'approved') throw new TamaraError(409, 'order_not_approved', 'Order is ' + st + ', expected approved');
  const r = await c.svc.authorize(p, { data: { authorised_at: new Date().toISOString() }, mock: header(c.req, 'x-hub-payment-outcome') });
  c.resolved.endpoint = 'authorise order';
  if (r.error === 'declined') throw new TamaraError(409, 'order_authorise_declined', 'Authorisation declined (' + (r.reason ?? 'generic') + ')');
  if (r.error) throw new TamaraError(409, 'order_not_approved', 'Order cannot be authorised: ' + r.error);
  const out = r.payment;
  return { order_id: out.providerRef, status: 'authorised', order_expiry_time: new Date(Date.now() + 72 * 3600_000).toISOString(), payment_type: asString(out.request.payment_type) ?? 'PAY_BY_INSTALMENTS', auto_captured: false, authorized_amount: money(out.amount, out.currency), capture_id: null };
}

async function capture(c: GatewayCtx, b: Json): Promise<unknown> {
  const id = asString(b.order_id);
  if (!id) throw new TamaraError(400, 'order_id_is_required', 'order_id is required');
  const p = await findOrder(c, id);
  c.resolved.endpoint = 'capture';
  const amt = moneyField(b.total_amount, 'total_amount', p.currency);
  if (!b.shipping_info) throw new TamaraError(400, 'shipping_info_is_required', 'shipping_info is required');
  const st = tamaraStatus(p);
  if (st === 'approved') {
    c.svc.addLint(p, [finding('pay.tamara-not-authorised', 'Capture of ' + p.providerRef + ' before POST /orders/:id/authorise')]);
    throw new TamaraError(409, 'order_not_authorised', 'Order must be authorised before capture');
  }
  if (!['authorised', 'partially_captured'].includes(st)) throw new TamaraError(409, 'order_cannot_be_captured', 'Order is ' + st);
  const already = Number(p.providerData.capturedAmount ?? 0);
  if (already + amt.minor > p.amount) throw new TamaraError(400, 'total_amount_invalid_limit', 'Capture amount exceeds the remaining amount');
  const final = already + amt.minor >= p.amount;
  const r = await c.svc.capture(p, { idempotencyKey: null, amount: amt.minor, final });
  if (r.error) throw new TamaraError(409, 'order_cannot_be_captured', 'Capture failed: ' + r.error);
  const cid = uuid();
  const out = pushTx(c.svc, r.payment, 'captures', { id: cid, amount: amt.minor, created_at: new Date().toISOString() });
  return { capture_id: cid, order_id: out.providerRef, status: tamaraStatus(out), captured_amount: money(amt.minor, out.currency) };
}

async function refund(c: GatewayCtx, p: Payment, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'simplified refund';
  const amt = moneyField(b.total_amount, 'total_amount', p.currency);
  if (!asString(b.comment)) throw new TamaraError(400, 'comment_is_required', 'comment is required');
  if (!['fully_captured', 'partially_captured', 'partially_refunded'].includes(tamaraStatus(p))) throw new TamaraError(409, 'order_cannot_be_refunded', 'Order is ' + tamaraStatus(p));
  const rid = uuid();
  try {
    await c.svc.refund(p, amt.minor, { providerRef: rid, reason: asString(b.comment) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new TamaraError(400, 'total_amount_invalid_limit', e.message);
    throw e;
  }
  const out = pushTx(c.svc, p, 'refunds', { id: rid, amount: amt.minor, created_at: new Date().toISOString(), comment: asString(b.comment) });
  const cap = txs(out, 'captures').at(-1);
  return { order_id: out.providerRef, comment: asString(b.comment), refund_id: rid, capture_id: cap?.id ?? null, status: tamaraStatus(out), refunded_amount: money(amt.minor, out.currency) };
}

async function cancel(c: GatewayCtx, p: Payment, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'cancel order';
  const st = tamaraStatus(p);
  if (st !== 'authorised') throw new TamaraError(409, 'order_cannot_be_canceled', 'Order is ' + st + ': only authorised orders can be canceled');
  const amt = b.total_amount ? moneyField(b.total_amount, 'total_amount', p.currency).minor : p.amount;
  if (amt !== p.amount) throw new TamaraError(400, 'total_amount_invalid', 'stubyard cancels the full amount only');
  const out0 = await c.svc.voidPayment(p, { webhook: true });
  const cid = uuid();
  const out = pushTx(c.svc, out0, 'cancels', { id: cid, amount: amt, created_at: new Date().toISOString() });
  return { cancel_id: cid, order_id: out.providerRef, status: 'canceled', canceled_amount: money(amt, out.currency) };
}

// ---------------- webhooks ----------------

type Hook = { webhook_id: string; type: string; events: string[]; url: string; headers: Record<string, string> };
const MAX_HOOKS = 20;
const MAX_HOOK_HEADERS = 10;
/** Extra headers of a registered webhook: string → string only, header-safe names, short values, no line breaks. */
function hookHeaders(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new TamaraError(400, 'invalid_headers', 'headers must be an object of header name → string value');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_HOOK_HEADERS) throw new TamaraError(400, 'invalid_headers', 'at most ' + MAX_HOOK_HEADERS + ' headers');
  const out: Record<string, string> = {};
  for (const [k, x] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(k)) throw new TamaraError(400, 'invalid_headers', 'invalid header name: ' + k.slice(0, 100));
    if (typeof x !== 'string' || x.length > 1000 || /[\r\n\0]/.test(x)) throw new TamaraError(400, 'invalid_headers', 'header ' + k + ' must be a single-line string of at most 1000 characters');
    out[k] = x;
  }
  return out;
}
const hooksOf = (inst: PaymentInstance): Hook[] => (Array.isArray(inst.config.webhooks) ? (inst.config.webhooks as Hook[]) : []);
export const TAMARA_EVENTS = ['order_approved', 'order_declined', 'order_authorised', 'order_canceled', 'order_captured', 'order_refunded', 'order_expired'];

async function webhooks(c: GatewayCtx, id: string | null): Promise<unknown> {
  const m = c.req.method;
  const hooks = hooksOf(c.inst);
  const save = (list: Hook[]) => {
    c.svc.repo.updateInstance(c.inst.id, { config: { ...c.inst.config, webhooks: list } });
    c.svc.changed(c.inst.projectId, { instance: c.inst.slug, webhooks: list.length });
  };
  const view = (h: Hook) => ({ merchant_id: String(c.inst.config.merchantId ?? ''), ...h });
  if (!id && m === 'GET') return hooks.map(view);
  if (!id && m === 'POST') {
    const b = bodyOf(c.req);
    const url = asString(b.url);
    if (!url || rejectUrl(url)) throw new TamaraError(400, 'invalid_url', 'url is invalid');
    const events = Array.isArray(b.events) ? b.events.map(String) : [];
    const bad = events.filter((e) => !TAMARA_EVENTS.includes(e));
    if (!events.length || bad.length) throw new TamaraError(400, 'invalid_events', 'events must be some of ' + TAMARA_EVENTS.join(', '));
    if (hooks.length >= MAX_HOOKS) throw new TamaraError(400, 'too_many_webhooks', 'at most ' + MAX_HOOKS + ' webhooks can be registered (stubyard limit)');
    const h: Hook = { webhook_id: uuid(), type: asString(b.type) ?? 'order', events, url, headers: hookHeaders(b.headers) };
    save([...hooks, h]);
    c.resolved.endpoint = 'register webhook';
    return view(h);
  }
  const h = id ? hooks.find((x) => x.webhook_id === id) : null;
  if (!h) throw new TamaraError(404, 'webhook_not_found', 'Webhook not found');
  if (m === 'GET') return view(h);
  if (m === 'PUT') {
    const b = bodyOf(c.req);
    const newUrl = asString(b.url);
    if (b.url !== undefined && (!newUrl || rejectUrl(newUrl))) throw new TamaraError(400, 'invalid_url', 'url is invalid');
    if (Array.isArray(b.events)) {
      const ev = b.events.map(String);
      if (!ev.length || ev.some((e) => !TAMARA_EVENTS.includes(e))) throw new TamaraError(400, 'invalid_events', 'events must be some of ' + TAMARA_EVENTS.join(', '));
    }
    const next: Hook = { ...h, url: newUrl ?? h.url, events: Array.isArray(b.events) ? b.events.map(String) : h.events, headers: b.headers !== undefined ? hookHeaders(b.headers) : h.headers };
    save(hooks.map((x) => (x.webhook_id === h.webhook_id ? next : x)));
    return view(next);
  }
  if (m === 'DELETE') {
    save(hooks.filter((x) => x.webhook_id !== h.webhook_id));
    return c.reply.status(204).send();
  }
  throw new TamaraError(404, 'not_found', 'not simulated');
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const m = c.req.method;
  const path = c.path.replace(/\/+$/, '');
  const entry = /^\/checkout\/([^/]+)$/.exec(path);
  if (entry && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(entry[1]!));
    if (!p) throw new TamaraError(404, 'order_not_found', 'Checkout not found');
    c.resolved.payment = p.id;
    c.resolved.endpoint = 'payment page';
    return c.reply.redirect('../page/' + p.id, 302);
  }
  const widget = tamaraWidgetRoute(c);
  if (widget !== undefined) return widget;
  auth(c);
  const b = bodyOf(c.req);
  if (m === 'POST' && path === '/checkout') return checkout(c, b);
  if (m === 'POST' && path === '/payments/capture') return capture(c, b);
  const om = /^\/orders\/([^/]+)(?:\/(authorise|cancel|reference-id))?$/.exec(path);
  if (om) {
    const p = await findOrder(c, om[1]!);
    if (!om[2] && m === 'GET') {
      c.resolved.endpoint = 'get order';
      c.svc.repo.addEvent(p, 'status_queried', { via: 'GET /orders/:id' });
      return tamaraOrder(c.svc, p, c.inst);
    }
    if (om[2] === 'authorise' && m === 'POST') return authorise(c, p);
    if (om[2] === 'cancel' && m === 'POST') return cancel(c, p, b);
    if (om[2] === 'reference-id' && m === 'PUT') {
      const ref = asString(b.order_reference_id);
      if (!ref) throw new TamaraError(400, 'order_reference_id_is_required', 'order_reference_id is required');
      c.svc.repo.update(p.id, { reference: ref });
      return { message: 'Order reference id was updated successfully' };
    }
  }
  const byRef = /^\/merchants\/orders\/reference-id\/([^/]+)$/.exec(path);
  if (byRef && m === 'GET') {
    const ref = decodeRef(byRef[1]!);
    const p = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: 200 }).find((x) => x.reference === ref);
    if (!p) throw new TamaraError(404, 'order_not_found', 'Order not found');
    c.resolved.payment = p.id;
    const cur = await c.svc.touch(p);
    c.svc.repo.addEvent(cur, 'status_queried', { via: 'GET /merchants/orders/reference-id/:ref' });
    return tamaraOrder(c.svc, cur, c.inst);
  }
  const rf = /^\/payments\/simplified-refund\/([^/]+)$/.exec(path);
  if (rf && m === 'POST') return refund(c, await findOrder(c, rf[1]!), b);
  const wh = /^\/webhooks(?:\/([^/]+))?$/.exec(path);
  if (wh) return webhooks(c, wh[1] ?? null);
  throw new TamaraError(404, 'not_found', m + ' ' + path + ' is not simulated by stubyard (Tamara: /checkout, /orders/:id[/authorise|/cancel], /payments/capture, /payments/simplified-refund/:id, /webhooks)');
}

function eventData(p: Payment, type: string): Json {
  if (type === 'order_captured') {
    const t = txs(p, 'captures').at(-1);
    return { capture_id: t?.id ?? null, captured_amount: t ? money(t.amount, p.currency) : null };
  }
  if (type === 'order_refunded') {
    const t = txs(p, 'refunds').at(-1);
    return { refund_id: t?.id ?? null, refunded_amount: t ? money(t.amount, p.currency) : null, comment: t?.comment ?? null };
  }
  if (type === 'order_canceled') {
    const t = txs(p, 'cancels').at(-1);
    return { cancel_id: t?.id ?? null, canceled_amount: t ? money(t.amount, p.currency) : money(p.amount, p.currency) };
  }
  if (type === 'order_declined') return { declined_reason: 'Order declined', declined_code: String(p.providerData.declineReason ?? 'generic'), decline_type: 'credit_decision' };
  return {};
}

export const tamaraGateway: Gateway = {
  preset: 'tamara',
  name: 'Tamara',
  description: 'Tamara BNPL: checkout session, hosted page (OTP), authorise, capture (partial), simplified refund, cancel, order lookup, webhooks with a tamaraToken JWT.',
  available: true,
  note: 'Built from docs.tamara.co (Nov 2026). Order events are sent to merchant_url.notification (legacy) or to the webhooks registered with POST /webhooks; the redirect query parameters (orderId, paymentStatus) follow Tamara\'s SDKs.',
  kind: 'order',
  methods: ['bnpl'],
  logo: 'TM',
  slugBase: 'tamara',
  webhookToCallbackUrl: true,
  otpSender: 'Tamara',
  magicOtps: ['123456'],
  declineOnApprove: true,
  fields: [
    { key: 'apiToken', label: 'API token', secret: true, hint: 'Authorization: Bearer <token> for every call' },
    { key: 'notificationToken', label: 'Notification token', secret: true, hint: 'HS256 key of the tamaraToken JWT on webhooks' },
    { key: 'publicKey', label: 'Public key', hint: 'Widgets / promo messages' },
    { key: 'merchantId', label: 'Merchant ID', hint: 'Shown in webhook registrations' },
    { key: 'webhookUrl', label: 'Default webhook URL', hint: 'Used when the checkout has no merchant_url.notification and nothing is registered' },
  ],
  defaults: () => ({ apiToken: 'eyJ' + alnum(60), notificationToken: uuid(), publicKey: uuid(), merchantId: uuid(), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: () => false,
  retryOnDecline: false,
  entryPath: (p) => '/checkout/' + p.providerRef,
  refundRef: () => uuid(),
  methodsFor: () => ['bnpl'],
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof TamaraError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ message: e.message, errors: [{ error_code: e.code, data: e.data }], data: {}, title: null, screen_type: null });
      }
      if (e instanceof HttpError && e.statusCode < 500) return c.reply.status(e.statusCode).send({ message: e.message, errors: [{ error_code: 'invalid_request', data: {} }], data: {}, title: null, screen_type: null });
      throw e;
    }
  },
  returnTo: (_svc, p, _inst, kind) => {
    const urls = (p.request.merchant_url ?? {}) as Json;
    const t = asString(kind === 'success' ? urls.success : kind === 'cancelled' ? urls.cancel : urls.failure);
    if (!t) return null;
    const u = new URL(t);
    u.searchParams.set('orderId', p.providerRef);
    u.searchParams.set('paymentStatus', kind === 'success' ? 'approved' : kind === 'cancelled' ? 'canceled' : 'declined');
    return { kind: 'redirect', url: u.toString() };
  },
  events: (p, point) => {
    switch (point) {
      case 'approved':
        return ['order_approved'];
      case 'authorized':
        return ['order_authorised'];
      case 'paid':
        return ['order_captured'];
      case 'refunded':
        return ['order_refunded'];
      case 'failed':
        return ['order_declined'];
      case 'cancelled':
        return [p.providerData.voided ? 'order_canceled' : 'order_declined'];
      case 'expired':
        return ['order_expired'];
      default:
        return [];
    }
  },
  buildEvent: (svc, p, inst, type) => {
    const hook = hooksOf(inst).find((h) => h.events.includes(type));
    const url = hook?.url ?? p.callbackUrl ?? inst.config.webhookUrl ?? null;
    const token = tamaraToken(String(inst.config.notificationToken ?? ''));
    const body = { order_id: p.providerRef, order_reference_id: p.reference, order_number: asString(p.request.order_number) ?? p.reference, event_type: type, data: eventData(p, type) };
    const n = txs(p, 'captures').length + ':' + txs(p, 'refunds').length;
    return { url, body: JSON.stringify(body), eventId: p.providerRef + ':' + type + ':' + n, signing: null, headers: { authorization: 'Bearer ' + token, ...Object.fromEntries(Object.entries(hook?.headers ?? {}).filter(([, v]) => typeof v === 'string' && !/[\r\n\0]/.test(v))) }, query: { tamaraToken: token } };
  },
  shape: (svc, p, inst) => tamaraOrder(svc, p, inst),
  providerStatus: (p) => tamaraStatus(p),
  lateLint: (_svc, p) => (p.status === 'authorized' && !p.providerData.authorization ? [finding('pay.tamara-not-authorised', 'Order ' + p.providerRef + ' was approved but never authorised (POST /orders/:id/authorise)')] : []),
  connect: (inst, urls) => ({
    env: { TAMARA_API_TOKEN: String(inst.config.apiToken ?? ''), TAMARA_NOTIFICATION_TOKEN: String(inst.config.notificationToken ?? ''), TAMARA_PUBLIC_KEY: String(inst.config.publicKey ?? ''), TAMARA_API_URL: urls.backend, TAMARA_API_URL_LOCAL: urls.backendLocal, TAMARA_WIDGET_JS: urls.browser + '/widget-v2/tamara-widget.js' },
    notes: [
      'Use TAMARA_API_URL instead of https://api-sandbox.tamara.co: POST {base}/checkout with "Authorization: Bearer <API token>" → checkout_url. Amounts are {amount: decimal, currency}.',
      'After approval (order_approved webhook or the success redirect ?orderId=…&paymentStatus=approved) call POST /orders/:id/authorise, then POST /payments/capture {order_id, total_amount, shipping_info} when you ship.',
      'Webhooks carry tamaraToken (HS256 JWT signed with the notification token) as the ?tamaraToken= query parameter and in "Authorization: Bearer …". Verify it before trusting the event.',
      'Test values: phone 536422337 (KSA) / 526422337 (UAE) → declined; any other phone → approved; OTP is the SMS code (or 123456).',
      'Tamara\'s PHP and Node SDKs take the API URL as a constructor argument: pass TAMARA_API_URL.',
      'Widget: load TAMARA_WIDGET_JS instead of https://cdn.tamara.co/widget-v2/tamara-widget.js after window.tamaraWidgetConfig = { lang, country, publicKey: TAMARA_PUBLIC_KEY }, then <tamara-widget type="tamara-summary" amount="250.0" inline-type="2"></tamara-widget>. Changing amount re-renders; "More options" opens the stubyard info popup; the widget carries the TEST label.',
    ],
    snippets: [
      {
        title: 'Verify tamaraToken (Node, jose)',
        lang: 'js',
        code: "import { jwtVerify } from 'jose';\napp.post('/webhooks/tamara', express.json(), async (req, res) => {\n  const token = req.query.tamaraToken ?? String(req.headers.authorization ?? '').replace(/^Bearer /, '');\n  try {\n    await jwtVerify(token, new TextEncoder().encode(process.env.TAMARA_NOTIFICATION_TOKEN), { algorithms: ['HS256'], issuer: 'Tamara' });\n  } catch { return res.sendStatus(401); }\n  if (req.body.event_type === 'order_approved') { /* POST /orders/:id/authorise */ }\n  res.sendStatus(200);\n});",
      },
      {
        title: 'Verify tamaraToken (PHP, firebase/php-jwt)',
        lang: 'php',
        code: "use Firebase\\JWT\\JWT; use Firebase\\JWT\\Key;\n$token = $_GET['tamaraToken'] ?? preg_replace('/^Bearer /', '', $_SERVER['HTTP_AUTHORIZATION'] ?? '');\ntry { JWT::decode($token, new Key(getenv('TAMARA_NOTIFICATION_TOKEN'), 'HS256')); } catch (Exception $e) { http_response_code(401); exit; }",
      },
    ],
  }),
};
