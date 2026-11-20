import { createHash } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bodyOf, header, IdempotencyCache, parseBracketForm, unix } from '../common.js';
import { currencyDigits, normalizeOutcome } from '../engine.js';
import { badUrl, finding, httpUrl, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';

/**
 * Fake Stripe Checkout (hosted, mode=payment) under /pay/<project>/<instance>/v1/…: checkout sessions, payment intents,
 * charges, refunds and events, Stripe-shaped errors, Idempotency-Key replay and Stripe-Signature webhooks.
 */

const API_VERSION = '2024-06-20';
const idem = new Map<string, IdempotencyCache>();
const det = (prefix: string, seed: string, n = 24) => prefix + createHash('sha256').update(seed).digest('base64url').replace(/[-_]/g, '').slice(0, n);
const piId = (p: Payment) => det('pi_3', `${p.id}:pi`);
const chId = (p: Payment) => det('ch_3', `${p.id}:ch`);

class StripeError extends Error {
  constructor(
    public status: number,
    public body: { type: string; message: string; code?: string; param?: string; decline_code?: string },
  ) {
    super(body.message);
  }
}
const invalid = (message: string, param?: string, code?: string) => new StripeError(400, { type: 'invalid_request_error', message, ...(param ? { param } : {}), ...(code ? { code } : {}) });
const missing = (kind: string, id: string) => new StripeError(404, { type: 'invalid_request_error', code: 'resource_missing', message: `No such ${kind}: '${id}'`, param: 'id' });

function auth(c: GatewayCtx): void {
  const h = header(c.req, 'authorization') ?? '';
  let key = '';
  const bearer = /^Bearer\s+(.+)$/i.exec(h);
  const basic = /^Basic\s+(.+)$/i.exec(h);
  if (bearer) key = bearer[1]!.trim();
  else if (basic) key = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':')[0] ?? '';
  if (!key) {
    throw new StripeError(401, { type: 'invalid_request_error', message: "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY')." });
  }
  const masked = `${key.slice(0, 8)}${'*'.repeat(Math.max(0, key.length - 12))}${key.slice(-4)}`;
  if (/^(sk|rk)_live_/.test(key)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', `A live key (${key.slice(0, 8)}…) was sent to ${c.inst.slug}`));
    c.resolved.warnings = ['live key rejected'];
    throw new StripeError(401, { type: 'invalid_request_error', message: `Invalid API Key provided: ${masked}. stubyard never accepts live keys; use the instance's sk_test_ key.` });
  }
  if (!/^(sk|rk)_test_/.test(key) || (c.inst.config.strictKeys && key !== c.inst.config.secretKey)) {
    throw new StripeError(401, { type: 'invalid_request_error', message: `Invalid API Key provided: ${masked}` });
  }
}

function lineItems(p: Payment) {
  return ((p.providerData.lineItems as Json[] | undefined) ?? []).map((li) => ({ ...li }));
}

function sessionOf(svc: PaymentService, p: Payment, inst: PaymentInstance, expand: string[] = []): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const st = sessionStatus(p);
  const attempted = !['created', 'pending'].includes(p.status) || !!p.outcome;
  const user = p.testUserId ? svc.hub.users.get(p.projectId, p.testUserId) : null;
  const pd = p.providerData;
  return {
    id: p.providerRef,
    object: 'checkout.session',
    after_expiration: null,
    allow_promotion_codes: null,
    amount_subtotal: p.amount,
    amount_total: p.amount,
    automatic_tax: { enabled: false, liability: null, status: null },
    billing_address_collection: null,
    cancel_url: p.cancelUrl,
    client_reference_id: (pd.clientReferenceId as string | null) ?? null,
    client_secret: null,
    consent: null,
    created: unix(p.createdAt),
    currency: p.currency.toLowerCase(),
    customer: null,
    customer_creation: 'if_required',
    customer_details: st.status === 'complete' ? { email: p.customerEmail ?? user?.email ?? null, name: user?.name ?? null, phone: null, address: null, tax_exempt: 'none', tax_ids: [] } : null,
    customer_email: p.customerEmail,
    expires_at: unix(p.expiresAt),
    invoice: null,
    livemode: false,
    locale: (pd.locale as string | null) ?? null,
    metadata: (pd.metadata as Json) ?? {},
    mode: 'payment',
    payment_intent: attempted ? (expand.includes('payment_intent') ? paymentIntentOf(svc, p) : piId(p)) : null,
    payment_link: null,
    payment_method_collection: 'if_required',
    payment_method_types: (pd.paymentMethodTypes as string[]) ?? ['card'],
    payment_status: st.paymentStatus,
    status: st.status,
    submit_type: (pd.submitType as string | null) ?? null,
    success_url: p.returnUrl,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: 'hosted',
    url: st.status === 'open' ? svc.entryUrl(project, inst, p) : null,
    ...(expand.includes('line_items') ? { line_items: listOf(lineItems(p), `/v1/checkout/sessions/${p.providerRef}/line_items`) } : {}),
  };
}

function sessionStatus(p: Payment): { status: 'open' | 'complete' | 'expired'; paymentStatus: 'paid' | 'unpaid' } {
  if (p.status === 'expired') return { status: 'expired', paymentStatus: 'unpaid' };
  if (['paid', 'partially_refunded', 'refunded'].includes(p.status)) return { status: 'complete', paymentStatus: 'paid' };
  if (p.status === 'authorized') return { status: 'complete', paymentStatus: 'unpaid' };
  return { status: 'open', paymentStatus: 'unpaid' };
}

function lastError(p: Payment): Json | null {
  if (p.status !== 'failed' && !(p.status === 'pending' && p.providerData.declineReason)) return null;
  const reason = String(p.providerData.declineReason ?? 'generic');
  const messages: Record<string, string> = {
    generic: 'Your card was declined.',
    insufficient_funds: 'Your card has insufficient funds.',
    expired_card: 'Your card has expired.',
    incorrect_cvc: "Your card's security code is incorrect.",
    processing_error: 'An error occurred while processing your card. Try again in a little bit.',
    authentication_failed: 'We are unable to authenticate your payment method. Please choose a different payment method and try again.',
    otp_failed: 'Your card was declined.',
  };
  if (reason === 'authentication_failed') return { type: 'invalid_request_error', code: 'payment_intent_authentication_failure', message: messages[reason] };
  const code = reason === 'generic' || reason === 'insufficient_funds' || reason === 'otp_failed' ? 'card_declined' : reason;
  return { type: 'card_error', code, ...(code === 'card_declined' ? { decline_code: reason === 'insufficient_funds' ? 'insufficient_funds' : 'generic_decline' } : {}), message: messages[reason] ?? messages.generic, charge: chId(p) };
}

function piStatus(p: Payment): string {
  switch (p.status) {
    case 'requires_action':
      return 'requires_action';
    case 'authorized':
      return p.providerData.async ? 'processing' : 'requires_capture';
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return 'succeeded';
    case 'expired':
      return 'canceled';
    default:
      return 'requires_payment_method';
  }
}

function paymentIntentOf(svc: PaymentService, p: Payment): Json {
  const paid = ['paid', 'partially_refunded', 'refunded'].includes(p.status);
  return {
    id: piId(p),
    object: 'payment_intent',
    amount: p.amount,
    amount_capturable: 0,
    amount_received: paid ? p.amount : 0,
    capture_method: 'automatic_async',
    client_secret: `${piId(p)}_secret_${det('', p.id + ':cs', 25)}`,
    confirmation_method: 'automatic',
    created: unix(p.createdAt),
    currency: p.currency.toLowerCase(),
    customer: null,
    description: null,
    last_payment_error: lastError(p),
    latest_charge: hasCharge(p) ? chId(p) : null,
    livemode: false,
    metadata: (p.providerData.paymentIntentMetadata as Json) ?? {},
    payment_method: hasCharge(p) ? det('pm_1', p.id + ':pm') : null,
    payment_method_types: (p.providerData.paymentMethodTypes as string[]) ?? ['card'],
    receipt_email: p.customerEmail,
    status: piStatus(p),
  };
}

const hasCharge = (p: Payment) => ['authorized', 'paid', 'partially_refunded', 'refunded', 'failed'].includes(p.status) && !!p.outcome;

function stripeBrand(p: Payment): string {
  // Stripe reports the underlying network of a mada co-badged card.
  const b = p.cardBrand ?? 'visa';
  return b === 'mada' ? 'visa' : b === 'unknown' ? 'visa' : b;
}

function chargeOf(svc: PaymentService, p: Payment): Json {
  const paid = ['paid', 'partially_refunded', 'refunded'].includes(p.status);
  const err = lastError(p);
  return {
    id: chId(p),
    object: 'charge',
    amount: p.amount,
    amount_captured: paid ? p.amount : 0,
    amount_refunded: p.refunded,
    captured: paid,
    created: unix(p.createdAt),
    currency: p.currency.toLowerCase(),
    failure_code: err ? (err.code as string) : null,
    failure_message: err ? (err.message as string) : null,
    livemode: false,
    metadata: {},
    outcome: { network_status: err ? 'declined_by_network' : 'approved_by_network', reason: err ? ((err.decline_code as string) ?? (err.code as string)) : null, risk_level: 'normal', seller_message: err ? 'The bank did not return any further details with this decline.' : 'Payment complete.', type: err ? 'issuer_declined' : 'authorized' },
    paid,
    payment_intent: piId(p),
    payment_method_details: {
      type: p.method === 'applepay' ? 'card' : 'card',
      card: { brand: stripeBrand(p), country: 'SA', exp_month: 12, exp_year: new Date().getFullYear() + 3, funding: p.cardBrand === 'mada' ? 'debit' : 'credit', last4: p.cardLast4 ?? '4242', network: stripeBrand(p), wallet: p.method === 'applepay' ? { type: 'apple_pay' } : null },
    },
    receipt_email: p.customerEmail,
    refunded: p.status === 'refunded',
    status: err ? 'failed' : paid ? 'succeeded' : 'pending',
  };
}

const refundOf = (p: Payment, r: { providerRef: string; amount: number; status: string; createdAt: string }, extra: Json = {}): Json => ({
  id: r.providerRef,
  object: 'refund',
  amount: r.amount,
  charge: chId(p),
  created: unix(r.createdAt),
  currency: p.currency.toLowerCase(),
  metadata: {},
  payment_intent: piId(p),
  reason: null,
  status: r.status,
  ...extra,
});

const listOf = (data: unknown[], url: string) => ({ object: 'list', data, has_more: false, url });

function eventObject(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): Json {
  if (type.startsWith('checkout.session.')) return sessionOf(svc, p, inst);
  if (type.startsWith('payment_intent.')) return paymentIntentOf(svc, p);
  return chargeOf(svc, p);
}

function lintCreate(b: Json, req: GatewayCtx['req'], currency: string, items: { unit: number; precisionBad: boolean }[], amount: number): LintFinding[] {
  const out: LintFinding[] = [];
  if (amount <= 0) out.push(finding('pay.amount-zero', `amount_total is ${amount}`));
  if (items.some((i) => i.precisionBad)) out.push(finding('pay.amount-precision', `unit_amount must be a whole number of the smallest ${currency.toUpperCase()} unit${currencyDigits(currency) === 3 ? ' (and end in 0 for 3-decimal currencies)' : ''}`));
  const su = badUrl(b.success_url);
  if (su) out.push(finding('pay.return-url-missing-or-bad', `success_url ${su}`));
  const cu = b.cancel_url !== undefined ? badUrl(b.cancel_url) : null;
  if (cu) out.push(finding('pay.return-url-missing-or-bad', `cancel_url ${cu}`));
  const md = b.metadata && typeof b.metadata === 'object' ? Object.keys(b.metadata as Json) : [];
  if (!b.client_reference_id && !md.length) out.push(finding('pay.no-reference', 'No client_reference_id or metadata: the webhook cannot be matched to your order'));
  if (!header(req, 'idempotency-key')) out.push(finding('pay.no-idempotency-key', 'POST /v1/checkout/sessions without an Idempotency-Key header'));
  return out;
}

async function createSession(c: GatewayCtx, b: Json): Promise<Json> {
  const mode = asString(b.mode);
  if (!mode) throw invalid('Missing required param: mode.', 'mode');
  if (mode !== 'payment') throw invalid(`mode=${mode} is not simulated by stubyard (Payments 1a: mode=payment, hosted Checkout only).`, 'mode');
  const ui = asString(b.ui_mode);
  if (ui && ui !== 'hosted') throw invalid(`ui_mode=${ui} is not simulated by stubyard (hosted Checkout only).`, 'ui_mode');
  const raw = Array.isArray(b.line_items) ? (b.line_items as Json[]) : [];
  if (!raw.length) throw invalid('Missing required param: line_items.', 'line_items');
  let currency: string | null = null;
  const items: { unit: number; precisionBad: boolean; li: Json }[] = [];
  for (const [i, li] of raw.entries()) {
    if (li.price) throw invalid(`line_items[${i}][price]: saved Prices are not simulated by stubyard; send price_data instead.`, `line_items[${i}][price]`);
    const pdata = (li.price_data ?? {}) as Json;
    const cur = asString(pdata.currency)?.toLowerCase();
    if (!cur) throw invalid(`Missing required param: line_items[${i}][price_data][currency].`, `line_items[${i}][price_data][currency]`);
    if (currencyDigits(cur) === null) {
      c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', `Unknown currency "${cur}"`));
      throw invalid(`Invalid currency: ${cur}. Stripe currently supports these currencies: …`, `line_items[${i}][price_data][currency]`);
    }
    if (currency && cur !== currency) throw invalid('All line_items must use the same currency.', `line_items[${i}][price_data][currency]`);
    currency = cur;
    const unitRaw = pdata.unit_amount ?? pdata.unit_amount_decimal;
    if (unitRaw === undefined) throw invalid(`Missing required param: line_items[${i}][price_data][unit_amount].`, `line_items[${i}][price_data][unit_amount]`);
    const unit = Number(unitRaw);
    if (!Number.isFinite(unit) || unit < 0) throw invalid(`Invalid integer: ${String(unitRaw)}`, `line_items[${i}][price_data][unit_amount]`);
    const qty = li.quantity === undefined ? 1 : Number(li.quantity);
    if (!Number.isInteger(qty) || qty < 1) throw invalid(`Invalid integer: ${String(li.quantity)}`, `line_items[${i}][quantity]`);
    const precisionBad = !Number.isInteger(unit) || (currencyDigits(cur) === 3 && unit % 10 !== 0);
    const name = asString((pdata.product_data as Json | undefined)?.name) ?? asString(pdata.product) ?? 'Item';
    items.push({
      unit,
      precisionBad,
      li: { id: `li_${alnum(24)}`, object: 'item', amount_discount: 0, amount_subtotal: Math.round(unit * qty), amount_tax: 0, amount_total: Math.round(unit * qty), currency: cur, description: name, price: { id: `price_${alnum(24)}`, object: 'price', currency: cur, unit_amount: Math.round(unit), product: `prod_${alnum(14)}` }, quantity: qty },
    });
  }
  const amount = items.reduce((a, i) => a + Number(i.li.amount_total), 0);
  let preset: string | null = null;
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (forced) {
    try {
      preset = normalizeOutcome(forced);
    } catch (e) {
      throw invalid(`X-Hub-Payment-Outcome: ${(e as Error).message}`);
    }
  }
  for (const param of ['success_url', 'cancel_url'] as const) {
    const why = rejectUrl(b[param]);
    if (why) {
      c.svc.addInstanceLint(c.inst, finding('pay.return-url-missing-or-bad', `${param} ${why}`));
      throw invalid(`Invalid URL: ${param} must be an absolute http(s) URL (${why}).`, param, 'url_invalid');
    }
  }
  const lint = lintCreate(b, c.req, currency!, items, amount);
  const exp = b.expires_at ? Number(b.expires_at) * 1000 : Date.now() + 24 * 3_600_000;
  const p = c.svc.create(c, {
    kind: 'checkout_session',
    providerRef: `cs_test_a1${alnum(56)}`,
    secondaryRef: null,
    amount,
    currency: currency!.toUpperCase(),
    reference: asString(b.client_reference_id) ?? asString((b.metadata as Json | undefined)?.order_id) ?? null,
    customerEmail: asString(b.customer_email),
    returnUrl: asString(b.success_url),
    cancelUrl: asString(b.cancel_url),
    callbackUrl: null,
    presetOutcome: preset,
    request: b,
    providerData: {
      lineItems: items.map((i) => i.li),
      metadata: (b.metadata as Json) ?? {},
      paymentIntentMetadata: ((b.payment_intent_data as Json | undefined)?.metadata as Json) ?? {},
      clientReferenceId: asString(b.client_reference_id),
      paymentMethodTypes: Array.isArray(b.payment_method_types) ? b.payment_method_types : ['card'],
      locale: asString(b.locale),
      submitType: asString(b.submit_type),
    },
    idempotencyKey: header(c.req, 'idempotency-key'),
    lint,
    expiresAt: new Date(exp).toISOString(),
  });
  const withPi = c.svc.repo.update(p.id, { secondaryRef: piId(p), providerData: { ...p.providerData, chargeId: chId(p) } });
  return sessionOf(c.svc, withPi, c.inst, expandOf(b, c.query));
}

function expandOf(b: Json, q: GatewayCtx['query']): string[] {
  const fromQ = parseBracketForm(q as Record<string, string | string[]>).expand;
  const all = [...(Array.isArray(b.expand) ? b.expand : []), ...(Array.isArray(fromQ) ? fromQ : fromQ ? [fromQ] : [])];
  return all.map(String);
}

async function findSession(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p || !p.providerRef.startsWith('cs_')) throw missing('checkout.session', id);
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  // Hosted page entry (browser)
  const entry = /^\/c\/pay\/([^/]+)$/.exec(path);
  if (entry && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeURIComponent(entry[1]!));
    if (!p) throw new HttpError(404, 'Unknown checkout session');
    c.resolved.endpoint = 'checkout page';
    c.resolved.payment = p.id;
    return c.reply.redirect(`../../page/${p.id}`, 302);
  }
  if (!path.startsWith('/v1/')) throw new StripeError(404, { type: 'invalid_request_error', message: `Unrecognized request URL (${m}: ${path}). stubyard simulates Stripe Checkout under /v1/checkout/sessions, /v1/payment_intents, /v1/charges, /v1/refunds and /v1/events.` });
  auth(c);
  const b = m === 'GET' ? {} : bodyOf(req);
  const q = c.query;
  c.reply.header('request-id', `req_${alnum(14)}`).header('stripe-version', API_VERSION);

  // Idempotency-Key replay (POST only).
  const key = m === 'POST' ? header(req, 'idempotency-key') : null;
  const cache = idem.get(c.inst.id) ?? new IdempotencyCache();
  idem.set(c.inst.id, cache);
  const hash = createHash('sha256').update(`${path}\n${JSON.stringify(b)}`).digest('hex');
  if (key) {
    const hit = cache.get(key);
    if (hit) {
      if (hit.hash !== hash) throw new StripeError(400, { type: 'idempotency_error', message: `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.` });
      c.resolved.idempotentReplay = true;
      return c.reply.status(hit.status).header('idempotent-replayed', 'true').send(hit.body);
    }
  }
  const done = (body: unknown, status = 200) => {
    if (key) cache.set(key, hash, status, body);
    return c.reply.status(status).send(body);
  };

  let mm: RegExpExecArray | null;
  if (path === '/v1/checkout/sessions' && m === 'POST') {
    c.resolved.endpoint = 'create checkout session';
    return done(await createSession(c, b));
  }
  if (path === '/v1/checkout/sessions' && m === 'GET') {
    c.resolved.endpoint = 'list checkout sessions';
    const all = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: Math.min(Number(q.limit ?? 10) || 10, 100) });
    const pi = asString(q.payment_intent);
    const data = all.filter((p) => !pi || p.secondaryRef === pi).map((p) => sessionOf(c.svc, p, c.inst));
    return listOf(data, '/v1/checkout/sessions');
  }
  if ((mm = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve checkout session';
    const p = await findSession(c, mm[1]!);
    return sessionOf(c.svc, p, c.inst, expandOf(b, q));
  }
  if ((mm = /^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'list line items';
    const p = await findSession(c, mm[1]!);
    return listOf(lineItems(p), `/v1/checkout/sessions/${p.providerRef}/line_items`);
  }
  if ((mm = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path)) && m === 'POST') {
    c.resolved.endpoint = 'expire checkout session';
    const p = await findSession(c, mm[1]!);
    if (sessionStatus(p).status !== 'open') throw invalid('Only Checkout Sessions with a status in ["open"] can be expired.', undefined, 'checkout_session_not_open');
    const out = await c.svc.expire(p);
    return done(sessionOf(c.svc, out, c.inst));
  }
  if ((mm = /^\/v1\/payment_intents\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve payment intent';
    const p = c.svc.repo.byInstanceRef(c.inst.id, mm[1]!);
    if (!p) throw missing('payment_intent', mm[1]!);
    c.resolved.payment = p.id;
    return paymentIntentOf(c.svc, await c.svc.touch(p));
  }
  if ((mm = /^\/v1\/charges\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve charge';
    const p = c.svc.repo.byDataRef(c.inst.id, 'chargeId', mm[1]!);
    if (!p || !hasCharge(p)) throw missing('charge', mm[1]!);
    c.resolved.payment = p.id;
    return chargeOf(c.svc, p);
  }
  if (path === '/v1/refunds' && m === 'POST') {
    c.resolved.endpoint = 'create refund';
    const ref = asString(b.payment_intent) ?? asString(b.charge);
    if (!ref) throw invalid('One of the following params should be provided for this request: payment_intent or charge.');
    const p = asString(b.charge) ? c.svc.repo.byDataRef(c.inst.id, 'chargeId', ref) : c.svc.repo.byInstanceRef(c.inst.id, ref);
    if (!p) throw missing(b.charge ? 'charge' : 'payment_intent', ref);
    c.resolved.payment = p.id;
    if (p.status !== 'paid' && p.status !== 'partially_refunded') {
      throw invalid(p.status === 'refunded' ? `Charge ${chId(p)} has already been refunded.` : `This PaymentIntent (${piId(p)}) does not have a successful charge to refund.`, undefined, p.status === 'refunded' ? 'charge_already_refunded' : 'charge_not_refundable');
    }
    const amount = b.amount === undefined ? null : Number(b.amount);
    try {
      const out = await c.svc.refund(p, amount, { providerRef: `re_3${alnum(24)}`, reason: asString(b.reason) });
      const r = c.svc.repo.refunds(p.id).find((x) => x.providerRef === out.refundId)!;
      return done(refundOf(out.payment, r, { reason: asString(b.reason), metadata: (b.metadata as Json) ?? {} }));
    } catch (e) {
      if (e instanceof HttpError && (e.details as Json | undefined)?.code === 'amount_too_large') {
        throw invalid(`Refund amount (${amount}) is greater than unrefunded amount on charge (${p.amount - p.refunded})`, 'amount', 'amount_too_large');
      }
      throw e;
    }
  }
  if ((mm = /^\/v1\/refunds\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve refund';
    const hit = c.svc.repo.refundByRef(c.project.id, mm[1]!);
    if (!hit || hit.payment.instanceId !== c.inst.id) throw missing('refund', mm[1]!);
    return refundOf(hit.payment, hit.refund);
  }
  if ((mm = /^\/v1\/events\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve event';
    const row = c.hub.db
      .prepare("SELECT data FROM payment_events WHERE project_id = ? AND type = 'webhook_scheduled' AND json_extract(data, '$.eventId') = ? LIMIT 1")
      .get(c.project.id, mm[1]!) as { data: string } | undefined;
    const body = row ? (JSON.parse(row.data) as Json).body : null;
    if (!body) throw missing('event', mm[1]!);
    return JSON.parse(String(body));
  }
  throw new StripeError(404, { type: 'invalid_request_error', message: `Unrecognized request URL (${m}: ${path}). This endpoint is not simulated by stubyard.` });
}

export const stripeGateway: Gateway = {
  preset: 'stripe-checkout',
  name: 'Stripe Checkout',
  description: 'Hosted Checkout (mode=payment): checkout sessions, payment intents, refunds, Stripe-Signature webhooks, test cards.',
  available: true,
  kind: 'checkout_session',
  methods: ['card', 'applepay'],
  fields: [
    { key: 'secretKey', label: 'Secret key', secret: true, hint: 'sk_test_… (any sk_test_ key works unless strict keys is on)' },
    { key: 'publishableKey', label: 'Publishable key' },
    { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, hint: 'whsec_…' },
    { key: 'webhookUrl', label: 'Webhook URL', hint: 'Your app endpoint for Stripe events' },
  ],
  defaults: () => ({ secretKey: `sk_test_stubyard${alnum(24)}`, publishableKey: `pk_test_stubyard${alnum(24)}`, webhookSecret: `whsec_${alnum(32)}`, webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: () => true,
  retryOnDecline: true,
  entryPath: (p) => `/c/pay/${p.providerRef}`,
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof StripeError) {
        c.resolved.error = e.body.message;
        return c.reply.status(e.status).send({ error: { ...e.body, request_log_url: null } });
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        return c.reply.status(e.statusCode).send({ error: { type: 'invalid_request_error', message: e.message } });
      }
      throw e;
    }
  },
  returnTo: (_svc, p, _inst, kind) => {
    const ok = httpUrl(p.returnUrl);
    const cancel = httpUrl(p.cancelUrl);
    if (kind === 'success' && ok) return { kind: 'redirect', url: ok.replace(/\{CHECKOUT_SESSION_ID\}/g, p.providerRef) };
    if (kind === 'cancelled' && cancel) return { kind: 'redirect', url: cancel };
    return null; // declined: Stripe keeps the buyer on the Checkout page
  },
  events: (_p, point) =>
    ({
      paid: ['payment_intent.succeeded', 'checkout.session.completed'],
      pending: ['checkout.session.completed'],
      settled: ['payment_intent.succeeded', 'checkout.session.async_payment_succeeded'],
      failed: ['payment_intent.payment_failed'],
      expired: ['checkout.session.expired'],
      refunded: ['charge.refunded'],
      approved: [],
      cancelled: [],
    })[point] ?? [],
  buildEvent: (svc, p, inst, type) => {
    const id = `evt_1${alnum(24)}`;
    const body = JSON.stringify({ id, object: 'event', api_version: API_VERSION, created: Math.floor(Date.now() / 1000), data: { object: eventObject(svc, p, inst, type) }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: p.idempotencyKey }, type });
    return { url: inst.config.webhookUrl ?? null, body, eventId: id, signing: inst.config.webhookSecret ? { preset: 'stripe', secret: inst.config.webhookSecret } : null };
  },
  shape: (svc, p, inst) => ({ session: sessionOf(svc, p, inst, ['line_items']), paymentIntent: paymentIntentOf(svc, p), charge: hasCharge(p) ? chargeOf(svc, p) : null }),
  providerStatus: (p) => {
    const s = sessionStatus(p);
    return `${s.status} / ${s.paymentStatus}`;
  },
  connect: (inst, urls) => ({
    env: { STRIPE_SECRET_KEY: inst.config.secretKey ?? '', STRIPE_WEBHOOK_SECRET: inst.config.webhookSecret ?? '', STRIPE_API_BASE: urls.backend, STRIPE_API_BASE_LOCAL: urls.backendLocal },
    notes: [
      'stripe-python: stripe.api_base = STRIPE_API_BASE; stripe-php: new StripeClient(["api_key" => …, "api_base" => STRIPE_API_BASE]); stripe-go: stripe.SetBackend with URL = STRIPE_API_BASE.',
      'stripe-node has host / port / protocol but no path prefix: set STUBYARD_STORAGE_DOMAIN (e.g. stubyard.test) and use host "<instance>.<project>.pay.<domain>", or call the REST API with fetch.',
      'Webhooks are signed with the instance whsec_ secret: stripe.webhooks.constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET) works unchanged.',
    ],
  }),
};
