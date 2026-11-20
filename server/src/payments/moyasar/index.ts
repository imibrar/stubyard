import type { Gateway, GatewayCtx, GatewayTestCard, Json } from '../gateway.js';
import { asString, basicAuth, bodyOf, decodeRef, header, isLiveKey, uuid, alnum, digits } from '../common.js';
import { currencyDigits, describeCard, formatMoney, normalizeOutcome, OPEN, toDecimal } from '../engine.js';
import { finding, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import type { PaymentService } from '../service.js';
import { HttpError } from '../../util.js';

/**
 * Fake Moyasar (api.moyasar.com/v1) under /pay/<project>/<instance>/v1/…: invoices (hosted page), payments with a
 * creditcard / token / applepay / stcpay source (3-D Secure or STC Pay OTP on the stubyard page), refund / capture /
 * void, webhooks registration and payment_* webhooks carrying the shared secret as secret_token (no HMAC).
 * Shapes follow docs.moyasar.com (Nov 2026).
 */

class MoyError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public errors: Json | null = null,
  ) {
    super(message);
  }
}

/** Moyasar's documented test cards (docs.moyasar.com/guides/card-payments/test-cards). */
export const MOYASAR_TEST_CARDS: GatewayTestCard[] = [
  { number: '4201320111111010', brand: 'mada', magicId: 'success', label: 'Approved', code: '00' },
  { number: '5421080101000000', brand: 'mastercard', magicId: 'success', label: 'Approved', code: '00' },
  { number: '4201320000311101', brand: 'mada', magicId: 'insufficient_funds', label: 'Insufficient funds', code: '51' },
  { number: '4123120001090000', brand: 'visa', magicId: 'insufficient_funds', label: 'Insufficient funds', code: '51' },
  { number: '5457210001000092', brand: 'mastercard', magicId: 'insufficient_funds', label: 'Insufficient funds', code: '51' },
  { number: '4201321234411220', brand: 'mada', magicId: 'decline', label: 'Declined', code: '05' },
  { number: '4123120001090109', brand: 'visa', magicId: 'decline', label: 'Declined', code: '05' },
  { number: '5204730000002514', brand: 'mastercard', magicId: 'decline', label: 'Declined', code: '05' },
  { number: '4201320131000508', brand: 'mada', magicId: 'decline', label: 'Declined: lost card', code: '41' },
  { number: '4123450131000508', brand: 'visa', magicId: 'decline', label: 'Declined: lost card', code: '41' },
  { number: '5204010101000000', brand: 'mastercard', magicId: 'decline', label: 'Declined: lost card', code: '41' },
  { number: '4201322267774310', brand: 'mada', magicId: 'expired_card', label: 'Declined: expired card', code: '54' },
  { number: '4123128518640738', brand: 'visa', magicId: 'expired_card', label: 'Declined: expired card', code: '54' },
  { number: '5105107550274126', brand: 'mastercard', magicId: 'expired_card', label: 'Declined: expired card', code: '54' },
  { number: '4201326324640570', brand: 'mada', magicId: 'decline', label: 'Declined: exceeds withdrawal limit', code: '61' },
  { number: '4123123033308648', brand: 'visa', magicId: 'decline', label: 'Declined: exceeds withdrawal limit', code: '61' },
  { number: '5105106475101067', brand: 'mastercard', magicId: 'decline', label: 'Declined: exceeds withdrawal limit', code: '61' },
  { number: '4201321144311528', brand: 'mada', magicId: 'decline', label: 'Declined: stolen card', code: '43' },
  { number: '4123125276780003', brand: 'visa', magicId: 'decline', label: 'Declined: stolen card', code: '43' },
  { number: '5105107304607225', brand: 'mastercard', magicId: 'decline', label: 'Declined: stolen card', code: '43' },
  { number: '4201320000013020', brand: 'mada', magicId: 'processing_error', label: 'Unspecified failure', code: '99' },
  { number: '4123120000000000', brand: 'visa', magicId: 'processing_error', label: 'Unspecified failure', code: '99' },
  { number: '5105105105105100', brand: 'mastercard', magicId: 'processing_error', label: 'Unspecified failure', code: '99' },
  { number: '4111114005765430', brand: 'visa', magicId: 'success', label: '3-D Secure frictionless: paid' },
  { number: '4111115784228433', brand: 'visa', magicId: '3ds', label: '3-D Secure challenge (authentication rejected by issuer)' },
  { number: '340000000900000', brand: 'amex', magicId: 'success', label: 'Approved', code: '00' },
];

/** STC Pay test OTPs that pay (docs.moyasar.com/guides/stc-pay/testing). */
const STC_OK_OTPS = ['123456', '000000'];

const DECLINE: Record<string, [string, string]> = {
  generic: ['05', 'Declined'],
  insufficient_funds: ['51', 'Insufficient funds'],
  expired_card: ['54', 'Declined: expired card'],
  incorrect_cvc: ['05', 'Declined: invalid CVC'],
  processing_error: ['99', 'Unspecified failure'],
  authentication_failed: ['', '3-D Secure transaction attempt failed (Authentication rejected by issuer)'],
  otp_failed: ['', 'Invalid OTP'],
};

const isInvoice = (p: Payment) => p.providerData.moyasarObject === 'invoice';
/** The Moyasar payment id (invoices: the payment made on the invoice page). */
const paymentId = (p: Payment) => (isInvoice(p) ? (p.secondaryRef ?? p.providerRef) : p.providerRef);
const isoOrNull = (v: unknown) => (v ? String(v) : null);

function moyStatus(p: Payment): string {
  switch (p.status) {
    case 'created':
    case 'pending':
    case 'requires_action':
      return 'initiated';
    case 'authorized':
      return p.providerData.async ? 'initiated' : 'authorized';
    case 'paid':
      return p.providerData.manual ? 'captured' : 'paid';
    case 'partially_refunded':
    case 'refunded':
      return 'refunded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return p.providerData.voided ? 'voided' : 'failed';
    case 'expired':
      return 'expired';
  }
}

function invoiceStatus(p: Payment): string {
  if (p.status === 'cancelled') return p.providerData.voided ? 'voided' : 'canceled';
  if (p.status === 'expired') return p.providerData.canceled ? 'canceled' : 'expired';
  if (OPEN.includes(p.status)) return 'initiated';
  const s = moyStatus(p);
  return s === 'captured' ? 'paid' : s === 'authorized' ? 'on_hold' : s;
}

function message(p: Payment): string | null {
  if (OPEN.includes(p.status)) return null;
  if (p.status === 'failed') {
    if (p.providerData.providerMessage) return String(p.providerData.providerMessage);
    return (DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? DECLINE.generic!)[1];
  }
  if (p.status === 'cancelled' && !p.providerData.voided) return 'Canceled';
  if (p.status === 'expired') return 'Expired';
  return 'APPROVED';
}

function responseCode(p: Payment): string | null {
  if (p.status === 'failed') return asString(p.providerData.providerCode) ?? (DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? DECLINE.generic!)[0] ?? null;
  return OPEN.includes(p.status) ? null : '00';
}

const company = (brand: string | null) => (brand === 'mastercard' ? 'master' : brand === 'mada' || brand === 'amex' || brand === 'visa' ? brand : (brand ?? 'visa'));
const maskNumber = (brand: string | null, last4: string | null) => {
  const first = brand === 'mastercard' ? '5421-08' : brand === 'mada' ? '4201-32' : brand === 'amex' ? '3400-00' : '4111-11';
  return first + 'XX-XXXX-' + (last4 ?? '1111');
};

function source(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const req = (p.request.source ?? {}) as Json;
  const type = String(p.providerData.sourceType ?? (p.method === 'stcpay' ? 'stcpay' : p.method === 'applepay' ? 'applepay' : 'creditcard'));
  const project = svc.hub.projects.get(p.projectId)!;
  const txUrl = OPEN.includes(p.status) && !isInvoice(p) ? svc.entryUrl(project, inst, p) : undefined;
  if (type === 'stcpay') {
    const stc = (p.providerData.stc ?? {}) as Json;
    return { type: 'stcpay', mobile: asString(req.mobile) ?? asString(stc.phone), reference_number: p.providerData.rrn ?? null, branch: asString(req.branch), cashier: asString(req.cashier), transaction_url: txUrl, message: message(p) };
  }
  const brand = p.cardBrand ?? asString(p.providerData.cardBrand);
  const last4 = p.cardLast4 ?? asString(p.providerData.cardLast4);
  const base: Json = {
    type,
    company: company(brand),
    name: asString(req.name),
    number: maskNumber(brand, last4),
    gateway_id: String(p.providerData.gatewayId ?? ''),
    reference_number: p.providerData.rrn ?? null,
    token: type === 'token' ? asString(req.token) : null,
    message: message(p),
    transaction_url: txUrl,
    response_code: responseCode(p),
  };
  return base;
}

/** The Moyasar payment object. */
export function moyasarPayment(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const status = moyStatus(p);
  const captured = p.providerData.manual ? Number(p.providerData.capturedAmount ?? (['paid', 'partially_refunded', 'refunded'].includes(p.status) ? p.amount : 0)) : ['paid', 'partially_refunded', 'refunded'].includes(p.status) ? p.amount : 0;
  return {
    id: paymentId(p),
    status,
    amount: p.amount,
    fee: 0,
    currency: p.currency,
    refunded: p.refunded,
    refunded_at: p.refunded ? isoOrNull(p.providerData.refundedAt ?? p.updatedAt) : null,
    captured: p.providerData.manual ? captured : 0,
    captured_at: p.providerData.manual && captured ? isoOrNull(p.providerData.capturedAt ?? p.updatedAt) : null,
    voided_at: p.providerData.voided ? p.updatedAt : null,
    description: asString(p.request.description),
    amount_format: formatMoney(p.amount, p.currency),
    fee_format: formatMoney(0, p.currency),
    refunded_format: formatMoney(p.refunded, p.currency),
    captured_format: formatMoney(p.providerData.manual ? captured : 0, p.currency),
    invoice_id: isInvoice(p) ? p.providerRef : null,
    ip: null,
    callback_url: isInvoice(p) ? null : p.returnUrl,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    metadata: (p.request.metadata as Json | undefined) ?? null,
    source: source(svc, p, inst),
  };
}

/** The Moyasar invoice object. */
export function moyasarInvoice(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const paid = p.method !== null && !OPEN.includes(p.status);
  return {
    id: p.providerRef,
    status: invoiceStatus(p),
    amount: p.amount,
    currency: p.currency,
    description: asString(p.request.description),
    logo_url: null,
    amount_format: formatMoney(p.amount, p.currency),
    url: svc.entryUrl(project, inst, p),
    callback_url: p.callbackUrl,
    expired_at: p.expiresAt,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    back_url: p.cancelUrl,
    success_url: p.returnUrl,
    payments: paid ? [moyasarPayment(svc, p, inst)] : [],
    metadata: (p.request.metadata as Json | undefined) ?? null,
  };
}

// ---------------- auth ----------------

function auth(c: GatewayCtx, publishableOk: boolean): void {
  const cred = basicAuth(c.req);
  const fail = () => new MoyError(401, 'authentication_error', 'Invalid authorization credentials');
  if (!cred) {
    if (/^Bearer\s/i.test(header(c.req, 'authorization') ?? '')) c.resolved.warnings = ['Moyasar uses HTTP Basic auth: the API key as user name, empty password (curl -u sk_test_…:)'];
    throw fail();
  }
  const key = cred.user;
  if (isLiveKey(key)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', 'A live key (' + key.slice(0, 8) + '…) was sent to ' + c.inst.slug));
    c.resolved.warnings = ['live key rejected'];
    throw fail();
  }
  const isPk = /^pk_test_/.test(key);
  if (isPk && !publishableOk) {
    c.resolved.warnings = ['the publishable key only allows POST /v1/payments'];
    throw new MoyError(403, 'api_error', 'User not authorized');
  }
  const cfg = c.inst.config;
  if (cfg.strictKeys) {
    if (key !== cfg.secretKey && !(isPk && key === cfg.publishableKey)) throw fail();
    return;
  }
  if (!/^(sk|pk)_test_[A-Za-z0-9]{8,}$/.test(key) && key !== cfg.secretKey && key !== cfg.publishableKey) throw fail();
}

// ---------------- create ----------------

function amountOf(b: Json): number {
  const a = b.amount;
  if (a === undefined || a === null || a === '') throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: ['is required'] });
  const n = Number(a);
  if (!Number.isInteger(n) || (typeof a === 'string' && !/^\d+$/.test(a))) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: ['must be an integer'] });
  if (n <= 0) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: ['must be greater than 0'] });
  return n;
}

function currencyOf(b: Json): string {
  const c = (asString(b.currency) ?? 'SAR').toUpperCase();
  if (currencyDigits(c) === null) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { currency: ['is not a valid currency'] });
  return c;
}

function forcedOutcome(c: GatewayCtx): string | null {
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (!forced) return null;
  try {
    return normalizeOutcome(forced);
  } catch (e) {
    throw new MoyError(400, 'invalid_request_error', 'X-Hub-Payment-Outcome: ' + (e as Error).message);
  }
}

function lintAmount(amount: number, currency: string, what: string): LintFinding[] {
  const digitsN = currencyDigits(currency) ?? 2;
  if (digitsN > 0 && amount < 10 ** digitsN) {
    return [finding('pay.moyasar-amount-unit', what + ' amount ' + amount + ' is ' + formatMoney(amount, currency) + ': Moyasar amounts are in the smallest unit (100 = 1.00 SAR). Did you send major units?')];
  }
  return [];
}

function checkUrl(c: GatewayCtx, b: Json, key: string): void {
  const why = rejectUrl(b[key]);
  if (why) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { [key]: ['is not a valid URL'] });
}

async function createInvoice(c: GatewayCtx, b: Json): Promise<unknown> {
  const amount = amountOf(b);
  const currency = currencyOf(b);
  if (amount < 100) {
    c.svc.addInstanceLint(c.inst, lintAmount(amount, currency, 'Invoice')[0] ?? finding('pay.amount-zero', 'amount ' + amount));
    throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: ['must be greater than or equal to 100'] });
  }
  if (!asString(b.description)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { description: ["can't be blank"] });
  for (const k of ['callback_url', 'success_url', 'back_url']) checkUrl(c, b, k);
  const lint: LintFinding[] = [];
  const meta = (b.metadata ?? null) as Json | null;
  if (!meta || !Object.keys(meta).length) lint.push(finding('pay.no-reference', 'No metadata (e.g. order_id): the webhook cannot be matched to your order'));
  if (!asString(b.success_url)) lint.push(finding('pay.return-url-missing-or-bad', 'No success_url: the buyer stays on the Moyasar receipt page'));
  let expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  if (b.expired_at) {
    const d = Date.parse(String(b.expired_at));
    if (!Number.isFinite(d)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { expired_at: ['is not a valid date'] });
    expiresAt = new Date(d).toISOString();
  }
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: uuid(),
    secondaryRef: uuid(),
    amount,
    currency,
    reference: meta ? (asString(meta.order_id) ?? asString(Object.values(meta)[0])) : null,
    customerEmail: meta ? asString(meta.email) : null,
    returnUrl: asString(b.success_url),
    cancelUrl: asString(b.back_url),
    callbackUrl: asString(b.callback_url),
    presetOutcome: forcedOutcome(c),
    request: b,
    providerData: { moyasarObject: 'invoice', methods: ['card', 'mada', 'applepay', 'stcpay'], gatewayId: 'moyasar_cc_' + alnum(22) },
    idempotencyKey: null,
    lint,
    expiresAt,
  });
  c.resolved.endpoint = 'create invoice';
  return c.reply.status(201).send(moyasarInvoice(c.svc, p, c.inst));
}

function cardFromNumber(c: GatewayCtx, src: Json): { brand: string; last4: string; magicId: string | null; code?: string; label?: string } {
  const number = String(src.number ?? '').replace(/\s/g, '');
  const errors: Json = {};
  if (!/^\d{16,19}$/.test(number) && !/^\d{15}$/.test(number)) errors['source.number'] = ['is invalid'];
  if (!/^[\w.-]+( [\w.-]+)+$/.test(String(src.name ?? '').trim())) errors['source.name'] = ['must be a full name (two words or more)'];
  const month = Number(src.month);
  const year = Number(src.year);
  if (!(Number.isInteger(month) && month >= 1 && month <= 12)) errors['source.month'] = ['is invalid'];
  if (!(Number.isInteger(year) && year >= 2000)) errors['source.year'] = ['is invalid'];
  if (!/^\d{3,4}$/.test(String(src.cvc ?? ''))) errors['source.cvc'] = ['is invalid'];
  if (Object.keys(errors).length) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', errors);
  const own = MOYASAR_TEST_CARDS.find((x) => x.number === number);
  if (own) return { brand: own.brand, last4: number.slice(-4), magicId: own.magicId, code: own.code, label: own.label };
  const d = describeCard(number);
  if (d.testCard) return { brand: d.brand, last4: d.last4, magicId: d.magicId };
  if (d.luhnValid) {
    c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking ' + d.brand + ' number was sent as source.number to ' + c.inst.slug + ' (refused, not stored)'));
    throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { 'source.number': ['is not a Moyasar test card: stubyard only accepts test cards (e.g. 4111 1111 1111 1111); nothing was stored'] });
  }
  throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { 'source.number': ['is invalid'] });
}

async function createPayment(c: GatewayCtx, b: Json): Promise<unknown> {
  const amount = amountOf(b);
  const currency = currencyOf(b);
  const src = (b.source ?? null) as Json | null;
  if (!src || typeof src !== 'object') throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { source: ['is required'] });
  const type = String(src.type ?? '').toLowerCase();
  if (!['creditcard', 'token', 'applepay', 'stcpay'].includes(type)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { 'source.type': ['is not supported by stubyard (creditcard, token, applepay, stcpay)'] });
  if ((type === 'creditcard' || type === 'token') && !asString(b.callback_url)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { callback_url: ['is required'] });
  checkUrl(c, b, 'callback_url');
  const givenId = asString(b.given_id);
  if (givenId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(givenId)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { given_id: ['must be a UUID'] });
    const prev = c.svc.repo.byInstanceRef(c.inst.id, givenId);
    if (prev) throw new MoyError(400, 'used_given_id', 'given_id is already used by payment ' + givenId);
  }
  const isPk = /^pk_/.test(basicAuth(c.req)?.user ?? '');
  const lint: LintFinding[] = [...lintAmount(amount, currency, 'Payment')];
  const meta = (b.metadata ?? null) as Json | null;
  if (!meta || !Object.keys(meta).length) lint.push(finding('pay.no-reference', 'No metadata (e.g. order_id): the webhook cannot be matched to your order'));
  let card: ReturnType<typeof cardFromNumber> | null = null;
  let method: PaymentMethod = 'card';
  if (type === 'creditcard') {
    card = cardFromNumber(c, src);
    method = card.brand === 'mada' ? 'mada' : 'card';
    if (!isPk) lint.push(finding('pay.moyasar-card-on-server', 'Card numbers went through your server with the secret key: Moyasar expects them from the browser (Moyasar Form / publishable key), or a token'));
  } else if (type === 'token') {
    if (!/^token_/.test(String(src.token ?? ''))) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { 'source.token': ['is invalid'] });
  } else if (type === 'applepay') {
    method = 'applepay';
    if (!asString(src.token) && !asString(src.number)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { 'source.token': ['is required'] });
  } else {
    method = 'stcpay';
    if (!asString(src.mobile)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { 'source.mobile': ['is required'] });
  }
  const manual = src.manual === true || src.manual === 'true';
  const threeDs = type === 'creditcard' ? src['3ds'] !== false && src['3ds'] !== 'false' : type === 'token' ? src['3ds'] === true : false;
  const apiCard = card ? { brand: card.brand, last4: card.last4, magicId: card.magicId, luhnValid: false, testCard: true } : null;
  let p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: givenId ?? uuid(),
    secondaryRef: null,
    amount,
    currency,
    reference: meta ? (asString(meta.order_id) ?? asString(Object.values(meta)[0])) : null,
    customerEmail: meta ? asString(meta.email) : null,
    returnUrl: asString(b.callback_url),
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: forcedOutcome(c),
    request: b,
    method,
    cardBrand: card ? card.brand : null,
    cardLast4: card ? card.last4 : null,
    providerData: {
      moyasarObject: 'payment',
      sourceType: type,
      manual,
      methods: [method],
      gatewayId: 'moyasar_' + (type === 'stcpay' ? 'stc' : 'cc') + '_' + alnum(22),
      ...(apiCard ? { apiCard } : {}),
      ...(card?.code && card.magicId !== 'success' ? { providerCode: card.code, providerMessage: card.label } : {}),
      ...(type === 'stcpay' ? { otpPhone: String(src.mobile) } : {}),
    },
    idempotencyKey: givenId,
    lint,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  c.resolved.endpoint = 'create payment (' + type + ')';
  // No 3-D Secure (applepay, token without 3ds, creditcard with 3ds: false): the result is known at once.
  if (!threeDs && type !== 'stcpay') {
    const r = await c.svc.complete(p, { via: 'api', method, card: apiCard });
    p = r.payment;
  }
  return c.reply.status(201).send(moyasarPayment(c.svc, c.svc.repo.get(p.id)!, c.inst));
}

// ---------------- follow-ups ----------------

async function find(c: GatewayCtx, id: string, kind: 'payment' | 'invoice'): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p || (kind === 'invoice' && !isInvoice(p))) throw new MoyError(404, 'record_not_found', 'The ' + (kind === 'invoice' ? 'Invoice' : 'Payment') + ' record you were looking for was not found');
  if (kind === 'payment' && isInvoice(p) && p.secondaryRef !== id) throw new MoyError(404, 'record_not_found', 'The Payment record you were looking for was not found');
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

function intAmount(b: Json, left: number): number {
  if (b.amount === undefined || b.amount === null || b.amount === '') return left;
  const n = Number(b.amount);
  if (!Number.isInteger(n) || n <= 0) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: ['must be a positive integer'] });
  return n;
}

async function refund(c: GatewayCtx, p: Payment, b: Json): Promise<unknown> {
  if (!['paid', 'partially_refunded'].includes(p.status)) throw new MoyError(400, 'invalid_request_error', 'Payment is ' + moyStatus(p) + ' and cannot be refunded');
  const captured = p.providerData.capturedAmount === undefined ? p.amount : Number(p.providerData.capturedAmount);
  const amount = intAmount(b, captured - p.refunded);
  try {
    await c.svc.refund(p, amount, { providerRef: 'rf_' + alnum(20), reason: asString(b.description) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: [e.message] });
    throw e;
  }
  const out = c.svc.repo.update(p.id, { providerData: { ...c.svc.repo.get(p.id)!.providerData, refundedAt: new Date().toISOString() } });
  return moyasarPayment(c.svc, out, c.inst);
}

async function capture(c: GatewayCtx, p: Payment, b: Json): Promise<unknown> {
  if (!p.providerData.manual) throw new MoyError(400, 'invalid_request_error', 'Payment is ' + moyStatus(p) + ' and cannot be captured (only manual: true payments are authorized first)');
  const amount = intAmount(b, p.amount);
  const r = await c.svc.capture(p, { idempotencyKey: 'moyasar', amount, final: true });
  if (r.error === 'already_captured') throw new MoyError(400, 'invalid_request_error', 'Payment is already captured');
  if (r.error === 'not_approved') throw new MoyError(400, 'invalid_request_error', 'Payment is ' + moyStatus(p) + ' and cannot be captured');
  if (r.error === 'amount_exceeds') throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { amount: ['must be less than or equal to the authorized amount'] });
  const out = c.svc.repo.update(p.id, { providerData: { ...c.svc.repo.get(p.id)!.providerData, capturedAt: new Date().toISOString() } });
  return moyasarPayment(c.svc, out, c.inst);
}

async function voidIt(c: GatewayCtx, p: Payment): Promise<unknown> {
  if (p.status !== 'authorized' || p.providerData.captured) throw new MoyError(400, 'invalid_request_error', 'Payment is ' + moyStatus(p) + ' and cannot be voided (stubyard voids authorized payments; refund paid ones)');
  const out = await c.svc.voidPayment(p, { webhook: true });
  return moyasarPayment(c.svc, out, c.inst);
}

// ---------------- webhooks registry ----------------

export const MOYASAR_EVENTS = ['payment_paid', 'payment_failed', 'payment_voided', 'payment_authorized', 'payment_captured', 'payment_refunded', 'payment_abandoned', 'payment_verified'];
type Hook = { id: string; http_method: string; url: string; shared_secret: string; events: string[]; created_at: string; verified: boolean; verified_at: string };
const MAX_HOOKS = 20;
const hooksOf = (inst: PaymentInstance): Hook[] => (Array.isArray(inst.config.webhooks) ? (inst.config.webhooks as Hook[]) : []);
const hookView = (h: Hook) => ({ id: h.id, http_method: h.http_method, url: h.url, created_at: h.created_at, events: h.events, verified: h.verified, verified_at: h.verified_at });

async function webhooks(c: GatewayCtx, rest: string): Promise<unknown> {
  const m = c.req.method;
  const hooks = hooksOf(c.inst);
  if (rest === '/available_events' && m === 'GET') return { events: MOYASAR_EVENTS };
  if (rest === '' && m === 'GET') return { webhooks: hooks.map(hookView) };
  if (rest === '' && m === 'POST') {
    const b = bodyOf(c.req);
    const url = asString(b.url);
    if (!url || rejectUrl(url)) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { url: ['is not a valid URL'] });
    const events = Array.isArray(b.events) && b.events.length ? b.events.map(String) : MOYASAR_EVENTS;
    const bad = events.find((e) => !MOYASAR_EVENTS.includes(e));
    if (bad) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { events: [bad + ' is not a valid event'] });
    if (hooks.length >= MAX_HOOKS) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { base: ['at most ' + MAX_HOOKS + ' webhooks can be registered (stubyard limit)'] });
    if ((asString(b.shared_secret) ?? '').length > 500) throw new MoyError(400, 'invalid_request_error', 'Validation Failed', { shared_secret: ['is too long (maximum is 500 characters)'] });
    const now = new Date().toISOString();
    const h: Hook = { id: uuid(), http_method: String(b.http_method ?? 'post').toLowerCase(), url, shared_secret: asString(b.shared_secret) ?? '', events, created_at: now, verified: true, verified_at: now };
    c.svc.repo.updateInstance(c.inst.id, { config: { ...c.inst.config, webhooks: [...hooks, h] } });
    c.svc.changed(c.inst.projectId, { instance: c.inst.slug, webhook: h.id });
    c.resolved.endpoint = 'create webhook';
    return c.reply.status(201).send(hookView(h));
  }
  const one = /^\/([^/]+)$/.exec(rest);
  if (one) {
    const h = hooks.find((x) => x.id === one[1]);
    if (!h) throw new MoyError(404, 'record_not_found', 'The Webhook record you were looking for was not found');
    if (m === 'GET') return hookView(h);
    if (m === 'DELETE') {
      c.svc.repo.updateInstance(c.inst.id, { config: { ...c.inst.config, webhooks: hooks.filter((x) => x.id !== h.id) } });
      c.svc.changed(c.inst.projectId, { instance: c.inst.slug, webhookDeleted: h.id });
      return c.reply.status(204).send();
    }
  }
  throw new MoyError(404, 'invalid_request_error', m + ' /v1/webhooks' + rest + ' is not simulated by stubyard');
}

// ---------------- router ----------------

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  const entry = /^\/checkout\/([^/]+)$/.exec(path);
  if (entry && (m === 'GET' || m === 'HEAD' || m === 'POST')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(entry[1]!));
    if (!p) throw new MoyError(404, 'record_not_found', 'The Payment record you were looking for was not found');
    c.resolved.payment = p.id;
    // STC Pay without the page: GET|POST <transaction_url>?otp_value=123456 (stubyard: the OTP checked like the page).
    const otp = asString((c.query.otp_value as string | undefined) ?? (bodyOf(req).otp_value as string | undefined));
    if (otp && p.method === 'stcpay' && OPEN.includes(p.status)) {
      c.resolved.endpoint = 'stcpay otp';
      try {
        const r = await c.svc.complete(p, { via: 'api', method: 'stcpay', otp });
        return moyasarPayment(c.svc, r.payment, c.inst);
      } catch (e) {
        if (e instanceof HttpError && e.statusCode < 500) throw new MoyError(400, 'invalid_request_error', e.message);
        throw e;
      }
    }
    c.resolved.endpoint = 'payment page';
    return c.reply.redirect('../page/' + p.id, 302);
  }
  if (!path.startsWith('/v1/')) throw new MoyError(404, 'invalid_request_error', m + ' ' + path + ' is not simulated by stubyard (Moyasar API: /v1/invoices, /v1/payments, /v1/webhooks)');
  const isCreatePayment = m === 'POST' && path === '/v1/payments';
  auth(c, isCreatePayment);
  const b = bodyOf(req);
  if (path === '/v1/invoices' && m === 'POST') return createInvoice(c, b);
  if (path === '/v1/invoices' && m === 'GET') {
    c.resolved.endpoint = 'list invoices';
    const list = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: 100 }).filter(isInvoice);
    return { invoices: await Promise.all(list.map(async (p) => moyasarInvoice(c.svc, await c.svc.touch(p), c.inst))), meta: { current_page: 1, next_page: null, prev_page: null, total_pages: 1, total_count: list.length } };
  }
  if (isCreatePayment) return createPayment(c, b);
  if (path === '/v1/payments' && m === 'GET') {
    c.resolved.endpoint = 'list payments';
    const q = c.query as Record<string, string | undefined>;
    let list = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: 200 });
    const views = await Promise.all(list.map(async (p) => ({ p, v: moyasarPayment(c.svc, await c.svc.touch(p), c.inst) })));
    let out = views.filter((x) => !isInvoice(x.p) || x.p.method !== null);
    for (const [k, v] of Object.entries(q)) {
      const mm = /^metadata\[(.+)\]$/.exec(k);
      if (mm && v !== undefined) out = out.filter((x) => String(((x.p.request.metadata ?? {}) as Json)[mm[1]!] ?? '') === v);
    }
    if (q.status) out = out.filter((x) => x.v.status === q.status);
    if (q.id) out = out.filter((x) => x.v.id === q.id);
    list = out.map((x) => x.p);
    return { payments: out.map((x) => x.v), meta: { current_page: 1, next_page: null, prev_page: null, total_pages: 1, total_count: out.length } };
  }
  const inv = /^\/v1\/invoices\/([^/]+)(\/cancel)?$/.exec(path);
  if (inv) {
    const p = await find(c, decodeRef(inv[1]!), 'invoice');
    if (inv[2] && m === 'PUT') {
      c.resolved.endpoint = 'cancel invoice';
      if (!OPEN.includes(p.status)) throw new MoyError(400, 'invalid_request_error', 'Invoice is ' + invoiceStatus(p) + ' and cannot be canceled');
      const out = await c.svc.expire(p, 'api');
      const cancelled = c.svc.repo.update(out.id, { providerData: { ...out.providerData, canceled: true } });
      return moyasarInvoice(c.svc, cancelled, c.inst);
    }
    if (!inv[2] && m === 'GET') {
      c.resolved.endpoint = 'fetch invoice';
      c.svc.repo.addEvent(p, 'status_queried', { via: 'GET /v1/invoices/:id' });
      return moyasarInvoice(c.svc, p, c.inst);
    }
  }
  const pm = /^\/v1\/payments\/([^/]+)(?:\/(refund|capture|void))?$/.exec(path);
  if (pm) {
    const p = await find(c, decodeRef(pm[1]!), 'payment');
    if (!pm[2] && m === 'GET') {
      c.resolved.endpoint = 'fetch payment';
      c.svc.repo.addEvent(p, 'status_queried', { via: 'GET /v1/payments/:id' });
      return moyasarPayment(c.svc, p, c.inst);
    }
    if (m === 'POST' && pm[2]) {
      c.resolved.endpoint = pm[2] + ' payment';
      if (pm[2] === 'refund') return refund(c, p, b);
      if (pm[2] === 'capture') return capture(c, p, b);
      return voidIt(c, p);
    }
  }
  const wh = /^\/v1\/webhooks(\/.*)?$/.exec(path);
  if (wh) return webhooks(c, wh[1] ?? '');
  throw new MoyError(404, 'invalid_request_error', m + ' ' + path + ' is not simulated by stubyard');
}

// ---------------- webhooks ----------------

function hookFor(inst: PaymentInstance, type: string): { url: string; secret: string } | null {
  const h = hooksOf(inst).find((x) => x.events.includes(type));
  if (h) return { url: h.url, secret: h.shared_secret };
  return inst.config.webhookUrl ? { url: inst.config.webhookUrl, secret: inst.config.webhookSecret ?? '' } : null;
}

function returnQuery(p: Payment): Record<string, string> {
  return { id: isInvoice(p) ? p.providerRef : paymentId(p), status: isInvoice(p) ? invoiceStatus(p) : moyStatus(p), message: message(p) ?? '' };
}

export const moyasarGateway: Gateway = {
  preset: 'moyasar',
  name: 'Moyasar',
  description: 'Moyasar API v1: invoices (hosted page) and payments (creditcard / token / Apple Pay / STC Pay), refund / capture / void, webhooks with secret_token; mada, cards, Apple Pay, STC Pay.',
  available: true,
  note: 'Built from docs.moyasar.com (Nov 2026). Webhooks carry the shared secret as secret_token in the body (no HMAC header). Webhook endpoint verification (webhook_verification code) is not simulated: registered webhooks are verified at once.',
  kind: 'hpp',
  methods: ['card', 'mada', 'applepay', 'stcpay'],
  logo: 'MY',
  slugBase: 'moyasar',
  webhookToCallbackUrl: true,
  magicOtps: STC_OK_OTPS,
  testCards: MOYASAR_TEST_CARDS,
  fields: [
    { key: 'secretKey', label: 'Secret key', secret: true, hint: 'sk_test_…: HTTP Basic user name, empty password' },
    { key: 'publishableKey', label: 'Publishable key', hint: 'pk_test_…: allowed only for POST /v1/payments (Moyasar Form)' },
    { key: 'webhookSecret', label: 'Webhook shared secret', secret: true, hint: 'Sent as secret_token in every webhook body (default webhook URL)' },
    { key: 'webhookUrl', label: 'Default webhook URL', hint: 'payment_* events; webhooks registered with POST /v1/webhooks win' },
  ],
  defaults: () => ({ secretKey: 'sk_test_' + alnum(40), publishableKey: 'pk_test_' + alnum(40), webhookSecret: alnum(32), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => !p.providerData.manual,
  retryOnDecline: false,
  entryPath: (p) => '/checkout/' + p.providerRef,
  refundRef: () => 'rf_' + alnum(20),
  methodsFor: (p) => {
    const allowed = p.providerData.methods as PaymentMethod[] | undefined;
    return allowed?.length ? (allowed.filter((m) => ['card', 'mada', 'applepay', 'stcpay'].includes(m)) as PaymentMethod[]) : ['card', 'mada', 'applepay', 'stcpay'];
  },
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof MoyError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ type: e.type, message: e.message, errors: e.errors });
      }
      if (e instanceof HttpError && e.statusCode < 500) return c.reply.status(e.statusCode).send({ type: 'invalid_request_error', message: e.message, errors: null });
      throw e;
    }
  },
  returnTo: (_svc, p, _inst, kind) => {
    const target = isInvoice(p) ? (kind === 'cancelled' ? p.cancelUrl : kind === 'success' ? p.returnUrl : null) : p.returnUrl;
    if (!target) return null;
    const u = new URL(target);
    for (const [k, v] of Object.entries(returnQuery(p))) u.searchParams.set(k, v);
    return { kind: 'redirect', url: u.toString() };
  },
  events: (p, point) => {
    const types: string[] = [];
    switch (point) {
      case 'paid':
        types.push(p.providerData.manual ? 'payment_captured' : 'payment_paid');
        break;
      case 'settled':
        types.push('payment_paid');
        break;
      case 'approved':
      case 'authorized':
        if (p.providerData.manual) types.push('payment_authorized');
        break;
      case 'failed':
        types.push('payment_failed');
        break;
      case 'refunded':
        types.push('payment_refunded');
        break;
      case 'cancelled':
        if (p.providerData.voided) types.push('payment_voided');
        break;
      default:
        break;
    }
    // Invoices: the invoice object is POSTed to callback_url when it is paid.
    if (isInvoice(p) && p.callbackUrl && (point === 'paid' || point === 'settled')) types.push('invoice_callback');
    return types;
  },
  buildEvent: (svc, p, inst, type) => {
    if (type === 'invoice_callback') return { url: p.callbackUrl, body: JSON.stringify(moyasarInvoice(svc, p, inst)), eventId: p.providerRef + ':' + invoiceStatus(p), signing: null };
    if (!p.providerData.rrn && !OPEN.includes(p.status)) p = svc.repo.update(p.id, { providerData: { ...p.providerData, rrn: digits(12) } });
    const hook = hookFor(inst, type);
    const id = uuid();
    const body = { id, type, created_at: new Date().toISOString(), secret_token: hook?.secret ?? '', account_name: 'stubyard', live: false, data: moyasarPayment(svc, p, inst) };
    return { url: hook?.url ?? null, body: JSON.stringify(body), eventId: id, signing: null };
  },
  shape: (svc, p, inst) => (isInvoice(p) ? moyasarInvoice(svc, p, inst) : moyasarPayment(svc, p, inst)),
  providerStatus: (p) => (isInvoice(p) ? 'invoice ' + invoiceStatus(p) + ' · payment ' + moyStatus(p) : moyStatus(p)),
  afterComplete: (svc, p) => {
    // A Moyasar test card typed on the page: keep its own response code.
    if (p.status !== 'failed' || p.providerData.providerCode) return;
    const own = MOYASAR_TEST_CARDS.find((x) => x.number.endsWith(p.cardLast4 ?? '----') && (x.brand === p.cardBrand || (p.method === 'mada' && x.brand === 'mada')));
    if (own?.code) svc.repo.update(p.id, { providerData: { ...p.providerData, providerCode: own.code, providerMessage: own.label } });
  },
  lateLint: (_svc, p) => {
    if (OPEN.includes(p.status) || p.status === 'expired' || !p.method) return [];
    if (_svc.repo.events(p.id).some((e) => e.type === 'status_queried')) return [];
    return [finding('pay.moyasar-payment-not-fetched', (isInvoice(p) ? 'Invoice ' : 'Payment ') + paymentId(p) + ' finished but your app never fetched it (GET /v1/payments/:id): the redirect query is not proof of payment')];
  },
  connect: (inst, urls) => ({
    env: { MOYASAR_SECRET_KEY: inst.config.secretKey ?? '', MOYASAR_PUBLISHABLE_KEY: String(inst.config.publishableKey ?? ''), MOYASAR_WEBHOOK_SECRET: inst.config.webhookSecret ?? '', MOYASAR_BASE_URL: urls.backend + '/v1', MOYASAR_BASE_URL_LOCAL: urls.backendLocal + '/v1' },
    notes: [
      'Use MOYASAR_BASE_URL instead of https://api.moyasar.com/v1. Auth: HTTP Basic with the secret key as user name and an empty password (curl -u "$MOYASAR_SECRET_KEY:").',
      'Amounts are integers in the smallest unit (100 = 1.00 SAR). Invoices: POST /v1/invoices → url (hosted page). Payments: POST /v1/payments with source.type creditcard | token | applepay | stcpay → source.transaction_url (3-D Secure / STC Pay OTP page), then the browser returns to callback_url?id=…&status=…&message=….',
      'There is no official server SDK with a base-URL option; call the REST API (or set the base URL of your HTTP client). Moyasar Form (moyasar.js) posts to api.moyasar.com and is not redirected: use the hosted invoice page or the payments API against stubyard.',
      'Webhooks: register with POST /v1/webhooks {url, shared_secret, events} or set the default webhook URL here. Compare body.secret_token with your shared secret (constant-time); there is no signature header.',
      'Test cards: Moyasar\'s documented ones (4201320111111010 mada approved, 4111111111111111 Visa approved, 4123120001090000 insufficient funds, …) and the stubyard magic cards. STC Pay: OTP from the SMS inbox, or 123456 / 000000.',
    ],
    snippets: [
      {
        title: 'Verify a webhook (Node)',
        lang: 'js',
        code: "import { timingSafeEqual } from 'node:crypto';\napp.post('/webhooks/moyasar', express.json(), (req, res) => {\n  const got = Buffer.from(String(req.body.secret_token ?? ''));\n  const want = Buffer.from(process.env.MOYASAR_WEBHOOK_SECRET);\n  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.sendStatus(401);\n  // then GET /v1/payments/:id (req.body.data.id) before trusting the status\n  res.sendStatus(200);\n});",
      },
      {
        title: 'Verify a webhook (PHP)',
        lang: 'php',
        code: "$event = json_decode(file_get_contents('php://input'), true);\nif (!hash_equals(getenv('MOYASAR_WEBHOOK_SECRET'), (string)($event['secret_token'] ?? ''))) { http_response_code(401); exit; }\nhttp_response_code(200);",
      },
    ],
  }),
};
