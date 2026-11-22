import { alnum, asString, header, unix } from '../common.js';
import { currencyDigits, normalizeOutcome, OPEN } from '../engine.js';
import type { GatewayCtx, Json, LifecyclePoint, ReturnSpec } from '../gateway.js';
import { finding, httpUrl, rejectUrl } from '../lint.js';
import type { LintFinding, Payment } from '../repo.js';
import type { PaymentService } from '../service.js';
import { checkSdkOrigin, originOf, sdkCors } from '../sdk/runtime.js';
import { HttpError } from '../../util.js';
import { chId, clientSecretOf, det, hasCharge, invalid, isIntent, lastError, listOf, missing, paymentIntentOf, piId, StripeError } from './index.js';

/**
 * Stripe PaymentIntents on the fake (Payments P4a; research R1 §1 "PaymentIntents"):
 *
 *   POST /v1/payment_intents                 amount, currency, capture_method, payment_method_types /
 *                                            automatic_payment_methods, metadata, description, receipt_email,
 *                                            setup_future_usage, customer, payment_method, confirm, return_url, off_session
 *   GET  /v1/payment_intents                 list (this instance's own intents)
 *   POST /v1/payment_intents/:id             update (amount, currency, metadata, description, receipt_email, payment_method…)
 *   POST /v1/payment_intents/:id/confirm     payment_method (pm_card_visa… test methods or a Stripe.js pm_), return_url
 *   POST /v1/payment_intents/:id/capture     amount_to_capture (capture_method=manual)
 *   POST /v1/payment_intents/:id/cancel      cancellation_reason
 *   GET  /v1/payment_methods/:id
 * With the publishable key (Stripe.js, key=pk_test_… in the query / form, CORS for allowed origins):
 *   GET  /v1/payment_intents/:id?client_secret=…   POST /v1/payment_intents/:id/confirm (client_secret, payment_method=pm_…)
 *
 * Statuses: requires_payment_method → (requires_confirmation) → requires_action (3-D Secure: next_action
 * use_stripe_sdk for Stripe.js, redirect_to_url when the server confirmed with a return_url) → succeeded /
 * processing / requires_capture; canceled. A decline goes back to requires_payment_method with last_payment_error.
 * The engine decides every outcome as everywhere else (forced rules, magic cards, defaults). A cancelled intent is
 * "expired" in stubyard's own status (or "cancelled" when it was requires_capture).
 * Webhooks: payment_intent.created, .requires_action, .processing, .amount_capturable_updated, .succeeded,
 * .payment_failed, .canceled, and charge.succeeded / .captured / .failed / .refunded.
 * Raw card numbers are refused as Stripe does (lint pay.stripe-raw-card-data): cards come from Stripe.js frames
 * (brand / last 4 / magic id only) or from test payment methods.
 */

export interface CardFacts {
  brand: string;
  last4: string;
  magicId: string | null;
  luhnValid: boolean;
  testCard: boolean;
}

/** Stripe's documented test PaymentMethods (and tok_… tokens of the same name), mapped to the engine magic cards. */
const TEST_PM: Record<string, [string, string, string]> = {
  visa: ['success', 'visa', '4242'],
  visa_debit: ['success', 'visa', '5556'],
  mastercard: ['success', 'mastercard', '4444'],
  amex: ['success', 'amex', '8431'],
  chargeDeclined: ['decline', 'visa', '0002'],
  visa_chargeDeclined: ['decline', 'visa', '0002'],
  chargeDeclinedInsufficientFunds: ['insufficient_funds', 'visa', '9995'],
  visa_chargeDeclinedInsufficientFunds: ['insufficient_funds', 'visa', '9995'],
  chargeDeclinedExpiredCard: ['expired_card', 'visa', '0069'],
  visa_chargeDeclinedExpiredCard: ['expired_card', 'visa', '0069'],
  chargeDeclinedIncorrectCvc: ['incorrect_cvc', 'visa', '0127'],
  visa_chargeDeclinedIncorrectCvc: ['incorrect_cvc', 'visa', '0127'],
  chargeDeclinedProcessingError: ['processing_error', 'visa', '0119'],
  visa_chargeDeclinedProcessingError: ['processing_error', 'visa', '0119'],
  threeDSecure2Required: ['3ds', 'visa', '3220'],
  threeDSecureRequired: ['3ds', 'visa', '3063'],
  authenticationRequired: ['3ds', 'visa', '3184'],
};
export const TEST_PAYMENT_METHODS = Object.keys(TEST_PM).map((k) => 'pm_card_' + k);

const CONFIRMABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
const unexpected = (verb: string, st: string, allowed: string) => invalid(`You cannot ${verb} this PaymentIntent because it has a status of ${st}. Only a PaymentIntent with one of the following statuses may be ${verb === 'confirm' ? 'confirmed' : verb === 'cancel' ? 'canceled' : verb + 'd'}: ${allowed}.`, undefined, 'payment_intent_unexpected_state');
const RAW_CARD = 'Sending credit card numbers directly to the Stripe API is generally unsafe. We suggest you use test tokens that map to the test card you are using, see https://stripe.com/docs/testing. (stubyard: use a test PaymentMethod such as pm_card_visa, or Stripe.js.)';
const TEST_MODE_REAL = 'Your card was declined. Your request was in test mode, but used a non test card. For a list of valid test cards, visit: https://stripe.com/docs/testing.';

/** The status the intent shows (index.ts piStatus, via the JSON). */
const statusOf = (svc: PaymentService, p: Payment) => String(paymentIntentOf(svc, p).status);

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === '1';
}

/** A Stripe card PaymentMethod object (no digits: brand / last 4 only). */
export function paymentMethodOf(id: string, card: { brand: string; last4: string }, billing: Json = {}, created = Math.floor(Date.now() / 1000)): Json {
  const year = new Date().getFullYear() + 3;
  const addr = (billing.address as Json | undefined) ?? {};
  return {
    id,
    object: 'payment_method',
    billing_details: { address: { city: addr.city ?? null, country: addr.country ?? null, line1: addr.line1 ?? null, line2: addr.line2 ?? null, postal_code: addr.postal_code ?? null, state: addr.state ?? null }, email: billing.email ?? null, name: billing.name ?? null, phone: billing.phone ?? null },
    card: { brand: card.brand === 'mada' ? 'visa' : card.brand, checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: 'pass' }, country: 'US', display_brand: card.brand, exp_month: 12, exp_year: year, funding: 'credit', last4: card.last4, networks: { available: [card.brand], preferred: null }, three_d_secure_usage: { supported: true }, wallet: null },
    created,
    customer: null,
    livemode: false,
    metadata: {},
    type: 'card',
  };
}

/** Card facts of a payment method id: a documented test method, or one created by Stripe.js (payment_tokens). */
export function resolvePm(c: GatewayCtx, id: string): (CardFacts & { billing: Json }) | null {
  const key = id.replace(/^(pm_card_|tok_)/, '');
  const hit = /^(pm_card_|tok_)/.test(id) ? TEST_PM[key] : undefined;
  if (hit) return { magicId: hit[0], brand: hit[1], last4: hit[2], luhnValid: true, testCard: true, billing: {} };
  const t = c.svc.repo.tokenByRef(c.inst.id, id, 'payment');
  if (!t || (t.data as Json).stripe !== 'payment_method') return null;
  return { magicId: ((t.data as Json).magicId as string | null) ?? null, brand: t.cardBrand ?? 'visa', last4: t.cardLast4 ?? '0000', luhnValid: true, testCard: true, billing: ((t.data as Json).billing as Json | undefined) ?? {} };
}

/** A payment method made from Stripe.js card facts (stored as a payment token of the instance). */
export function savePm(c: GatewayCtx, card: CardFacts, billing: Json, prefix: 'pm_1' | 'tok_1' = 'pm_1'): Json {
  const id = prefix + alnum(24);
  c.svc.repo.addToken({ projectId: c.project.id, instanceId: c.inst.id, runId: c.run?.id ?? null, kind: 'payment', providerRef: id, customerId: null, status: 'active', source: 'card', cardBrand: card.brand, cardLast4: card.last4, expiry: null, data: { stripe: 'payment_method', magicId: card.magicId, billing } });
  return paymentMethodOf(id, card, billing);
}

/** The fields only an intent of its own has (called by paymentIntentOf). */
export function intentExtras(svc: PaymentService, p: Payment, base: Json): Json {
  const pd = p.providerData;
  const paid = ['paid', 'partially_refunded', 'refunded'].includes(p.status);
  const capture = (pd.captureMethod as string | undefined) ?? 'automatic_async';
  const action = pd.piAction as { via?: string; returnUrl?: string | null } | null | undefined;
  const status = String(base.status);
  let next: Json | null = null;
  if (status === 'requires_action' && action) {
    const project = svc.hub.projects.get(p.projectId);
    const inst = svc.repo.instanceById(p.instanceId);
    const url = project && inst ? `${svc.base(project, inst)}/stripe-js/3ds/${encodeURIComponent(p.providerRef)}?client_secret=${encodeURIComponent(clientSecretOf(p))}` : null;
    next =
      action.via === 'api' && action.returnUrl
        ? { type: 'redirect_to_url', redirect_to_url: { url: url + '&mode=redirect', return_url: action.returnUrl } }
        : { type: 'use_stripe_sdk', use_stripe_sdk: { type: 'three_d_secure_redirect', stripe_js: url, source: det('src_1', p.id + ':3ds') } };
  }
  return {
    ...base,
    amount_capturable: p.status === 'authorized' && capture === 'manual' && !pd.captured ? p.amount : 0,
    amount_received: paid ? Number(pd.capturedAmount ?? p.amount) : 0,
    automatic_payment_methods: pd.automaticPaymentMethods ? { allow_redirects: 'always', enabled: true } : null,
    canceled_at: (pd.canceledAt as number | undefined) ?? null,
    cancellation_reason: (pd.cancellationReason as string | undefined) ?? null,
    capture_method: capture,
    customer: (pd.customer as string | undefined) ?? null,
    description: (pd.description as string | undefined) ?? null,
    last_payment_error: status === 'requires_action' ? null : base.last_payment_error,
    next_action: next,
    payment_method: hasCharge(p) || status !== 'requires_payment_method' ? ((pd.pm as string | undefined) ?? (hasCharge(p) ? base.payment_method : null)) : null,
    payment_method_options: { card: { installments: null, mandate_options: null, network: null, request_three_d_secure: 'automatic' } },
    processing: null,
    setup_future_usage: (pd.setupFutureUsage as string | undefined) ?? null,
    shipping: (pd.shipping as Json | undefined) ?? null,
    statement_descriptor: null,
  };
}

/** Webhook types of an intent's lifecycle points. */
export function intentEvents(p: Payment, point: LifecyclePoint): string[] {
  const manual = p.providerData.captureMethod === 'manual';
  switch (point) {
    case 'approved':
      return ['charge.succeeded', 'payment_intent.amount_capturable_updated'];
    case 'paid':
      return manual ? ['charge.captured', 'payment_intent.succeeded'] : ['charge.succeeded', 'payment_intent.succeeded'];
    case 'pending':
      return ['payment_intent.processing'];
    case 'settled':
      return ['charge.succeeded', 'payment_intent.succeeded'];
    case 'failed':
      return hasCharge(p) && p.providerData.declineReason !== 'authentication_failed' ? ['charge.failed', 'payment_intent.payment_failed'] : ['payment_intent.payment_failed'];
    case 'cancelled':
    case 'expired':
      return ['payment_intent.canceled'];
    case 'refunded':
      return ['charge.refunded'];
    default:
      return [];
  }
}

/** return_url?payment_intent=…&payment_intent_client_secret=…&redirect_status=… (what Stripe.js and the 3DS redirect use). */
export function returnUrlOf(p: Payment, url: string, status: 'succeeded' | 'failed' | 'pending'): string | null {
  if (!httpUrl(url)) return null;
  try {
    const u = new URL(url);
    u.searchParams.set('payment_intent', piId(p));
    u.searchParams.set('payment_intent_client_secret', clientSecretOf(p));
    u.searchParams.set('redirect_status', status);
    return u.toString();
  } catch {
    return null;
  }
}

/** Where a hosted page opened for an intent (dashboard "Open page") returns: the confirm's return_url. */
export function intentReturn(p: Payment, kind: 'success' | 'failed' | 'cancelled'): ReturnSpec | null {
  const url = (p.providerData.piReturnUrl as string | undefined) ?? p.returnUrl;
  if (!url || kind !== 'success') return null;
  const to = returnUrlOf(p, url, p.providerData.async ? 'pending' : 'succeeded');
  return to ? { kind: 'redirect', url: to } : null;
}

function queue(c: GatewayCtx, p: Payment, type: string): Promise<unknown> {
  const cfg = c.inst.config as Json;
  const registered = Array.isArray(cfg.webhooks) && (cfg.webhooks as unknown[]).length > 0;
  if (!cfg.webhookUrl && !registered) return Promise.resolve();
  return c.svc.webhooks.queue(c.svc.repo.get(p.id)!, c.inst, type, { delayMs: Number(cfg.webhookDelayMs ?? 500) });
}

function rawCardIn(b: Json): boolean {
  const pmd = (b.payment_method_data as Json | undefined) ?? {};
  const card = (pmd.card as Json | undefined) ?? (b.card as Json | undefined);
  return !!card && typeof card === 'object' && (card.number !== undefined || card.cvc !== undefined);
}

function refuseRawCard(c: GatewayCtx, p: Payment | null, b: Json): void {
  if (!rawCardIn(b)) return;
  const f = finding('pay.stripe-raw-card-data', 'A card number was sent to the Stripe API (payment_method_data[card][number]); the real API refuses raw card data by default');
  if (p) c.svc.addLint(p, [f]);
  else c.svc.addInstanceLint(c.inst, f);
  throw invalid(RAW_CARD, 'payment_method_data[card][number]');
}

/** The intent named by id (404 Stripe-style). */
async function findIntent(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p || !isIntent(p) || p.providerRef !== id) throw missing('payment_intent', id);
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

/** The intent of a client_secret (publishable-key calls and the Stripe.js frames). */
export async function intentBySecret(c: GatewayCtx, secret: unknown): Promise<Payment> {
  const cs = typeof secret === 'string' ? secret : '';
  const id = cs.split('_secret_')[0] ?? '';
  if (!cs || !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(cs)) throw invalid('Invalid value for client_secret: must be the client_secret of a PaymentIntent (pi_…_secret_…).', 'client_secret');
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p || piId(p) !== id) throw missing('payment_intent', id);
  if (clientSecretOf(p) !== cs) throw invalid('The client_secret provided does not match the client_secret associated with the PaymentIntent.', 'client_secret');
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

/** A card declined at confirm: 402 with the error and the intent (as Stripe answers). */
function declined(svc: PaymentService, p: Payment): StripeError {
  const err = lastError(p) ?? { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' };
  return new StripeError(402, { ...(err as StripeError['body']), payment_intent: paymentIntentOf(svc, p) } as unknown as StripeError['body']);
}

export interface ConfirmOpts {
  returnUrl: string | null;
  via: 'js' | 'api';
  offSession?: boolean;
}

/**
 * Confirm an intent with a card: the 3-D Secure card (without a forced outcome) stops at requires_action; everything
 * else goes through svc.complete (forced rules, magic cards, the instance default). Throws StripeError 402 on a decline.
 */
export async function confirmWith(c: GatewayCtx, p0: Payment, card: CardFacts, o: ConfirmOpts): Promise<Json> {
  let p = p0;
  const st = statusOf(c.svc, p);
  if (!CONFIRMABLE.includes(st)) throw unexpected('confirm', st, CONFIRMABLE.join(', '));
  if (card.luhnValid && !card.testCard) {
    c.svc.realCardWarning(p, card.brand);
    throw new StripeError(402, { type: 'card_error', code: 'card_declined', decline_code: 'live_mode_test_card', message: TEST_MODE_REAL });
  }
  const forced = c.svc.peekForced(p, p.testUserId);
  p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, piAction: null, ...(o.returnUrl ? { piReturnUrl: o.returnUrl } : {}) } });
  if (card.magicId === '3ds' && !forced && !o.offSession) {
    p = c.svc.repo.update(p.id, { method: 'card', cardBrand: card.brand, cardLast4: card.last4, providerData: { ...p.providerData, piAction: { card, returnUrl: o.returnUrl, via: o.via, at: new Date().toISOString() } } });
    c.svc.repo.addEvent(p, 'payer_action_required', { reason: '3ds', via: o.via === 'js' ? 'stripe.js' : 'api' });
    await queue(c, p, 'payment_intent.requires_action');
    c.svc.changed(p.projectId, { payment: p.id });
    return paymentIntentOf(c.svc, c.svc.repo.get(p.id)!);
  }
  let out: Payment;
  try {
    const r = await c.svc.complete(p, { via: o.via === 'js' ? 'page' : 'api', method: 'card', card, outcome: card.magicId === '3ds' && o.offSession && !forced ? '3ds_fail' : null });
    out = r.payment;
  } catch (e) {
    if (e instanceof HttpError && e.statusCode === 409) throw unexpected('confirm', statusOf(c.svc, c.svc.repo.get(p.id) ?? p), CONFIRMABLE.join(', '));
    throw e;
  }
  c.resolved.outcome = out.outcome;
  if (out.status === 'failed') throw declined(c.svc, out);
  return paymentIntentOf(c.svc, out);
}

/** The 3-D Secure answer (Stripe.js modal or the redirect page): complete / fail. */
export async function answer3ds(c: GatewayCtx, p0: Payment, ok: boolean): Promise<Payment> {
  const action = p0.providerData.piAction as { card?: CardFacts } | null | undefined;
  if (!action?.card) throw new HttpError(409, 'This PaymentIntent is not waiting for 3D Secure authentication.');
  const p = c.svc.repo.update(p0.id, { providerData: { ...p0.providerData, piAction: null } });
  c.svc.repo.addEvent(p, 'step', { flow: 'stripe-3ds', step: 'challenge', answer: ok ? '3ds_success' : '3ds_fail' });
  const r = await c.svc.complete(p, { via: 'page', method: 'card', card: action.card, outcome: ok ? '3ds_success' : '3ds_fail' });
  c.resolved.outcome = r.outcome;
  return r.payment;
}

function lintIntent(c: GatewayCtx, b: Json, amount: number, currency: string): LintFinding[] {
  const out: LintFinding[] = [];
  if (currencyDigits(currency) === 3 && amount % 10 !== 0) out.push(finding('pay.amount-precision', `amount must end in 0 for the 3-decimal currency ${currency.toUpperCase()}`));
  const md = b.metadata && typeof b.metadata === 'object' ? Object.keys(b.metadata as Json) : [];
  if (!md.length) out.push(finding('pay.no-reference', 'No metadata on the PaymentIntent: the webhook cannot be matched to your order'));
  if (!header(c.req, 'idempotency-key')) out.push(finding('pay.no-idempotency-key', 'POST /v1/payment_intents without an Idempotency-Key header'));
  return out;
}

function amountOf(v: unknown, param = 'amount'): number {
  if (v === undefined || v === null || v === '') throw invalid(`Missing required param: ${param}.`, param);
  const n = Number(v);
  if (!Number.isInteger(n)) throw invalid(`Invalid integer: ${String(v)}`, param);
  if (n < 1) throw invalid('Amount must be at least 1 in the smallest currency unit.', param, 'amount_too_small');
  if (n > 99_999_999) throw invalid('Amount must be no more than 99,999,999.', param, 'amount_too_large');
  return n;
}

function currencyOf(c: GatewayCtx, v: unknown): string {
  const cur = asString(v)?.toLowerCase();
  if (!cur) throw invalid('Missing required param: currency.', 'currency');
  if (currencyDigits(cur) === null) {
    c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', `Unknown currency "${cur}"`));
    throw invalid(`Invalid currency: ${cur}. Stripe currently supports these currencies: …`, 'currency');
  }
  return cur;
}

function captureOf(v: unknown): string {
  const s = asString(v) ?? 'automatic_async';
  if (!['automatic', 'automatic_async', 'manual'].includes(s)) throw invalid('Invalid capture_method: must be one of automatic, automatic_async, or manual', 'capture_method');
  return s;
}

function returnUrlParam(c: GatewayCtx, v: unknown): string | null {
  const s = asString(v);
  if (!s) return null;
  const why = rejectUrl(s);
  if (why) {
    c.svc.addInstanceLint(c.inst, finding('pay.return-url-missing-or-bad', `return_url ${why}`));
    throw invalid(`Invalid URL: return_url must be an absolute http(s) URL (${why}).`, 'return_url', 'url_invalid');
  }
  return s;
}

export async function createIntent(c: GatewayCtx, b: Json): Promise<Json> {
  const amount = amountOf(b.amount);
  const currency = currencyOf(c, b.currency);
  const capture = captureOf(b.capture_method);
  refuseRawCard(c, null, b);
  const types = Array.isArray(b.payment_method_types) ? (b.payment_method_types as unknown[]).map(String) : ['card'];
  const auto = bool((b.automatic_payment_methods as Json | undefined)?.enabled);
  const sfu = asString(b.setup_future_usage);
  if (sfu && !['on_session', 'off_session'].includes(sfu)) throw invalid('Invalid setup_future_usage: must be one of on_session or off_session', 'setup_future_usage');
  const pm = asString(b.payment_method);
  if (pm && !resolvePm(c, pm)) throw new StripeError(400, { type: 'invalid_request_error', code: 'resource_missing', message: `No such PaymentMethod: '${pm}'`, param: 'payment_method' });
  const returnUrl = returnUrlParam(c, b.return_url);
  let preset: string | null = null;
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (forced) {
    try {
      preset = normalizeOutcome(forced);
    } catch (e) {
      throw invalid(`X-Hub-Payment-Outcome: ${(e as Error).message}`);
    }
  }
  const metadata = (b.metadata as Json | undefined) ?? {};
  const p0 = c.svc.create(c, {
    kind: 'checkout_session',
    providerRef: 'pi_3' + alnum(24),
    secondaryRef: null,
    amount,
    currency: currency.toUpperCase(),
    reference: asString(metadata.order_id) ?? asString(metadata.orderId) ?? asString(metadata.order) ?? null,
    customerEmail: asString(b.receipt_email),
    returnUrl,
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: preset,
    request: b,
    providerData: {
      object: 'payment_intent',
      captureMethod: capture,
      paymentMethodTypes: auto ? ['card'] : types,
      automaticPaymentMethods: auto,
      paymentIntentMetadata: metadata,
      description: asString(b.description),
      setupFutureUsage: sfu,
      customer: asString(b.customer),
      shipping: (b.shipping as Json | undefined) ?? null,
      pm: pm ?? null,
      methods: ['card'],
    },
    idempotencyKey: header(c.req, 'idempotency-key'),
    lint: lintIntent(c, b, amount, currency),
    expiresAt: null,
  });
  const p = c.svc.repo.update(p0.id, { providerData: { ...p0.providerData, chargeId: chId(p0) } });
  await queue(c, p, 'payment_intent.created');
  if (bool(b.confirm)) return confirmServer(c, p, b);
  return paymentIntentOf(c.svc, p);
}

/** POST …/confirm with the secret key (or create with confirm=true): a payment method id, never card digits. */
async function confirmServer(c: GatewayCtx, p0: Payment, b: Json): Promise<Json> {
  refuseRawCard(c, p0, b);
  const st = statusOf(c.svc, p0);
  if (!CONFIRMABLE.includes(st)) throw unexpected('confirm', st, CONFIRMABLE.join(', '));
  const pmId = asString(b.payment_method) ?? (p0.providerData.pm as string | null | undefined) ?? null;
  if (!pmId) throw invalid("You cannot confirm this PaymentIntent because it's missing a payment method. You can either update the PaymentIntent with a payment method and then confirm it again, or confirm it again directly with a payment method.", undefined, 'payment_intent_unexpected_state');
  const facts = resolvePm(c, pmId);
  if (!facts) throw new StripeError(400, { type: 'invalid_request_error', code: 'resource_missing', message: `No such PaymentMethod: '${pmId}'`, param: 'payment_method' });
  const returnUrl = returnUrlParam(c, b.return_url) ?? (p0.providerData.piReturnUrl as string | undefined) ?? p0.returnUrl;
  const email = asString(b.receipt_email);
  const p = c.svc.repo.update(p0.id, { ...(email ? { customerEmail: email } : {}), providerData: { ...p0.providerData, pm: pmId } });
  const { billing: _b, ...card } = facts;
  return confirmWith(c, p, card, { returnUrl: returnUrl ?? null, via: 'api', offSession: bool(b.off_session) });
}

async function updateIntent(c: GatewayCtx, p0: Payment, b: Json): Promise<Json> {
  const st = statusOf(c.svc, p0);
  if (!CONFIRMABLE.includes(st)) throw invalid(`You cannot update this PaymentIntent because it has a status of ${st}.`, undefined, 'payment_intent_unexpected_state');
  refuseRawCard(c, p0, b);
  const patch: Partial<Payment> = {};
  const pd: Json = { ...p0.providerData };
  if (b.amount !== undefined) patch.amount = amountOf(b.amount);
  if (b.currency !== undefined) patch.currency = currencyOf(c, b.currency).toUpperCase();
  if (b.metadata !== undefined) {
    const md = { ...((pd.paymentIntentMetadata as Json | undefined) ?? {}) };
    for (const [k, v] of Object.entries((b.metadata as Json) ?? {})) if (v === '' || v === null) delete md[k];
    else md[k] = v;
    pd.paymentIntentMetadata = md;
  }
  if (b.description !== undefined) pd.description = asString(b.description);
  if (b.receipt_email !== undefined) patch.customerEmail = asString(b.receipt_email);
  if (b.capture_method !== undefined) pd.captureMethod = captureOf(b.capture_method);
  if (b.setup_future_usage !== undefined) pd.setupFutureUsage = asString(b.setup_future_usage);
  if (b.payment_method !== undefined) {
    const pm = asString(b.payment_method);
    if (pm && !resolvePm(c, pm)) throw new StripeError(400, { type: 'invalid_request_error', code: 'resource_missing', message: `No such PaymentMethod: '${pm}'`, param: 'payment_method' });
    pd.pm = pm;
  }
  const p = c.svc.repo.update(p0.id, { ...patch, providerData: pd });
  c.svc.changed(p.projectId, { payment: p.id });
  return paymentIntentOf(c.svc, p);
}

async function cancelIntent(c: GatewayCtx, p0: Payment, b: Json): Promise<Json> {
  const st = statusOf(c.svc, p0);
  const allowed = ['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action'];
  if (!allowed.includes(st)) throw unexpected('cancel', st, allowed.join(', '));
  const reason = asString(b.cancellation_reason);
  if (reason && !['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'].includes(reason)) throw invalid('Invalid cancellation_reason: must be one of duplicate, fraudulent, requested_by_customer, or abandoned', 'cancellation_reason');
  const p = c.svc.repo.update(p0.id, { providerData: { ...p0.providerData, piAction: null, cancellationReason: reason ?? null, canceledAt: unix(new Date().toISOString()) } });
  const out = p.status === 'authorized' ? await c.svc.voidPayment(p, { webhook: true }) : await c.svc.expire(p, 'api');
  return paymentIntentOf(c.svc, out);
}

async function captureIntent(c: GatewayCtx, p0: Payment, b: Json): Promise<Json> {
  const st = statusOf(c.svc, p0);
  if (st !== 'requires_capture') throw invalid(`This PaymentIntent could not be captured because it has a status of ${st}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`, undefined, 'payment_intent_unexpected_state');
  const amt = b.amount_to_capture === undefined ? null : amountOf(b.amount_to_capture, 'amount_to_capture');
  if (amt !== null && amt > p0.amount) throw invalid(`The amount to capture (${amt}) must be less than or equal to the amount capturable (${p0.amount}).`, 'amount_to_capture', 'amount_too_large');
  let key = header(c.req, 'idempotency-key');
  if (!key) {
    c.svc.addLint(p0, [finding('pay.no-idempotency-key', 'POST /v1/payment_intents/:id/capture without an Idempotency-Key header')]);
    key = 'stubyard-noted';
  }
  const r = await c.svc.capture(c.svc.repo.get(p0.id)!, { idempotencyKey: key, amount: amt, final: true });
  if (r.error === 'declined') throw declined(c.svc, r.payment);
  if (r.error) throw invalid(`This PaymentIntent could not be captured (${r.error}).`, undefined, 'payment_intent_unexpected_state');
  return paymentIntentOf(c.svc, r.payment);
}

type Done = (body: unknown, status?: number) => unknown;

/** /v1/payment_intents… and /v1/payment_methods/:id with the secret key; undefined for other paths. */
export async function intentRoute(c: GatewayCtx, b: Json, done: Done): Promise<unknown> {
  const { path } = c;
  const m = c.req.method;
  let mm: RegExpExecArray | null;
  if (path === '/v1/payment_intents' && m === 'POST') {
    c.resolved.endpoint = 'create payment intent';
    return done(await createIntent(c, b));
  }
  if (path === '/v1/payment_intents' && m === 'GET') {
    c.resolved.endpoint = 'list payment intents';
    const limit = Math.min(Number(c.query.limit ?? 10) || 10, 100);
    const data = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: 500 }).filter(isIntent).slice(0, limit).map((p) => paymentIntentOf(c.svc, p));
    return listOf(data, '/v1/payment_intents');
  }
  if ((mm = /^\/v1\/payment_intents\/(pi_[^/]+)$/.exec(path)) && m === 'POST') {
    c.resolved.endpoint = 'update payment intent';
    return done(await updateIntent(c, await findIntent(c, mm[1]!), b));
  }
  if ((mm = /^\/v1\/payment_intents\/([^/]+)\/(confirm|cancel|capture)$/.exec(path)) && m === 'POST') {
    const verb = mm[2]!;
    c.resolved.endpoint = verb + ' payment intent';
    const p = await findIntent(c, mm[1]!);
    if (verb === 'confirm') return done(await confirmServer(c, p, b));
    if (verb === 'cancel') return done(await cancelIntent(c, p, b));
    return done(await captureIntent(c, p, b));
  }
  if ((mm = /^\/v1\/payment_methods\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve payment method';
    const f = resolvePm(c, mm[1]!);
    if (!f) throw missing('payment_method', mm[1]!);
    return paymentMethodOf(mm[1]!, f, f.billing);
  }
  if (path === '/v1/payment_methods' && m === 'POST') {
    c.resolved.endpoint = 'create payment method';
    refuseRawCard(c, null, b);
    throw invalid('Creating PaymentMethods on the server is not simulated by stubyard: use a test PaymentMethod (pm_card_visa…) or stripe.createPaymentMethod in the browser.');
  }
  return undefined;
}

/** A publishable key from Stripe.js (query or form key=): pk_test_ only, the instance's own under strictKeys. */
export function pkAuth(c: GatewayCtx, key: unknown): void {
  const k = typeof key === 'string' ? key : '';
  if (/^pk_live_/.test(k)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', `A live publishable key (${k.slice(0, 8)}…) was sent to ${c.inst.slug}`));
    throw new StripeError(401, { type: 'invalid_request_error', message: 'Invalid API Key provided: stubyard never accepts live keys; use the instance\'s pk_test_ key.' });
  }
  if (/^sk_/.test(k)) throw new StripeError(401, { type: 'invalid_request_error', message: 'This API call cannot be made with a secret key in the browser. Use your publishable key (pk_test_…) with Stripe.js.' });
  if (!/^pk_test_/.test(k) || (c.inst.config.strictKeys && k !== c.inst.config.publishableKey)) throw new StripeError(401, { type: 'invalid_request_error', message: `Invalid API Key provided: ${k.slice(0, 12) || '(none)'}…` });
}

/** CORS for a browser call from the app page: refused origins get a 403 (lint pay.sdk-origin-refused). */
export function browserCors(c: GatewayCtx): void {
  const origin = originOf(c.req.headers.origin);
  sdkCors(c);
  if (!origin) return;
  const chk = checkSdkOrigin(c, origin, `Stripe.js (${c.inst.slug})`);
  if (!chk.ok) throw new StripeError(403, { type: 'invalid_request_error', message: `stubyard: ${origin} may not use this instance's Stripe.js (add it to the project app origins or the instance sdkOrigins).` });
}

/**
 * Stripe.js calls with the publishable key: retrieve an intent by client secret, confirm it with a payment method id.
 * undefined when the request carries no publishable key (the secret-key API answers it).
 */
export async function pkRoute(c: GatewayCtx): Promise<unknown> {
  const m = c.req.method;
  if (m === 'OPTIONS') {
    sdkCors(c);
    return c.reply.status(204).send();
  }
  const b = m === 'POST' && c.req.body && typeof c.req.body === 'object' ? (c.req.body as Json) : {};
  const key = asString(c.query.key) ?? asString(b.key);
  if (!key) return undefined;
  browserCors(c);
  pkAuth(c, key);
  const secret = asString(c.query.client_secret) ?? asString(b.client_secret);
  let mm: RegExpExecArray | null;
  if ((mm = /^\/v1\/payment_intents\/([^/]+)$/.exec(c.path)) && m === 'GET') {
    c.resolved.endpoint = 'retrieve payment intent (publishable key)';
    const p = await intentBySecret(c, secret);
    if (piId(p) !== mm[1]) throw missing('payment_intent', mm[1]!);
    const { metadata: _m, ...pub } = paymentIntentOf(c.svc, p);
    return pub;
  }
  if ((mm = /^\/v1\/payment_intents\/([^/]+)\/confirm$/.exec(c.path)) && m === 'POST') {
    c.resolved.endpoint = 'confirm payment intent (publishable key)';
    const p = await intentBySecret(c, secret);
    if (piId(p) !== mm[1]) throw missing('payment_intent', mm[1]!);
    const { key: _k, client_secret: _s, ...rest } = b;
    return confirmServer(c, p, { ...rest, off_session: undefined });
  }
  throw new StripeError(401, { type: 'invalid_request_error', message: `This API call cannot be made with a publishable API key (${c.req.method} ${c.path}).` });
}

export { OPEN };
