import { createHmac } from 'node:crypto';
import type { Gateway, GatewayCtx, GatewayTestCard, Json } from '../gateway.js';
import { alnum, asString, bearerToken, bodyOf, decodeRef, digits, ExpiringStore, header, isLiveKey } from '../common.js';
import { currencyDigits, describeCard, fromDecimal, normalizeOutcome, OPEN } from '../engine.js';
import { finding, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import type { PaymentService } from '../service.js';
import { HttpError } from '../../util.js';

/**
 * Fake Tap Payments API v2 under /pay/<project>/<instance>/v2/…: charges (hosted page = transaction.url), authorize +
 * capture (a charge whose source.id is the authorize id), refunds, card tokens, list, and the post.url webhook signed
 * with the "hashstring" header (HMAC-SHA256 hex of x_id…x_created… with the secret key). developers.tap.company, Nov 2026.
 */

class TapError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Tap's documented test cards (developers.tap.company/reference/testing-cards). The expiry decides the outcome on the API. */
export const TAP_TEST_CARDS: GatewayTestCard[] = [
  { number: '5123450000000008', brand: 'mastercard', magicId: null, label: 'Mastercard (3-D Secure)' },
  { number: '5111111111111118', brand: 'mastercard', magicId: null, label: 'Mastercard (no 3-D Secure)' },
  { number: '4508750015741019', brand: 'visa', magicId: null, label: 'Visa (3-D Secure)' },
  { number: '4012000033330026', brand: 'visa', magicId: null, label: 'Visa (no 3-D Secure)' },
  { number: '4440000009900010', brand: 'visa', magicId: null, label: 'Visa (3-D Secure)' },
  { number: '345678901234564', brand: 'amex', magicId: null, label: 'Amex (3-D Secure)' },
  { number: '4464040000000007', brand: 'mada', magicId: null, label: 'mada (3-D Secure)' },
  { number: '5588480000000003', brand: 'mada', magicId: null, label: 'mada (no 3-D Secure)' },
  { number: '4837915060379278', brand: 'visa', magicId: null, label: 'OmanNet' },
];
const NO_3DS = ['5111111111111118', '4012000033330026', '371449635398431', '5588480000000003'];

/** Expiry (MM/YY) → engine magic card id, as on Tap's test card page. */
const EXPIRY_OUTCOME: Record<string, string> = { '01/39': 'success', '05/22': 'decline', '04/27': 'expired_card', '08/28': 'processing_error', '01/37': 'processing_error', '02/37': 'processing_error', '05/37': 'processing_error' };

/** Engine decline reason → Tap response code / message / status. */
const DECLINE: Record<string, [string, string, string]> = {
  generic: ['501', 'Declined', 'DECLINED'],
  insufficient_funds: ['505', 'Declined, Insufficient Funds', 'DECLINED'],
  expired_card: ['407', 'Failed, Expired Card', 'FAILED'],
  incorrect_cvc: ['502', 'Declined, Incorrect CSC/CVV', 'DECLINED'],
  processing_error: ['408', 'Failed, Unspecified Failure', 'FAILED'],
  authentication_failed: ['516', 'Declined, Authentication Failed', 'DECLINED'],
  otp_failed: ['512', 'Declined, Not Authenticated', 'DECLINED'],
};

const SOURCE_METHODS: Record<string, PaymentMethod[]> = {
  src_all: ['card', 'mada', 'knet', 'benefit', 'applepay'],
  src_card: ['card', 'mada'],
  'src_kw.knet': ['knet'],
  'src_sa.mada': ['mada'],
  'src_bh.benefit': ['benefit'],
  src_apple_pay: ['applepay'],
};

type TokenCard = { brand: string; last4: string; firstSix: string; magicId: string | null; expiry: string; noThreeDs: boolean; name: string | null; cardId: string };
/** Card tokens per instance (Tap tokens are single use): expire after 15 min, at most 1000 per instance. */
const tokens = new Map<string, ExpiringStore<TokenCard>>();
const tokensOf = (inst: PaymentInstance) => {
  let m = tokens.get(inst.id);
  if (!m) tokens.set(inst.id, (m = new ExpiringStore<TokenCard>()));
  return m;
};

const isAuthorize = (p: Payment) => p.providerData.tapObject === 'authorize';
/** The charge id of an authorize that was captured (secondaryRef), else the payment's own id. */
const chargeId = (p: Payment) => (isAuthorize(p) ? (p.secondaryRef ?? p.providerRef) : p.providerRef);
const fmt = (minor: number, currency: string) => {
  const d = currencyDigits(currency) ?? 2;
  return (minor / 10 ** d).toFixed(d);
};
const amountNumber = (minor: number, currency: string) => Number(fmt(minor, currency));
const created = (p: Payment) => String(Date.parse(p.createdAt));

function tapStatus(p: Payment, view: 'charge' | 'authorize' = isAuthorize(p) && !p.providerData.captured ? 'authorize' : 'charge'): string {
  switch (p.status) {
    case 'created':
    case 'pending':
      return 'INITIATED';
    case 'requires_action':
      return 'IN_PROGRESS';
    case 'authorized':
      if (p.providerData.async) return 'IN_PROGRESS';
      return view === 'authorize' ? 'AUTHORIZED' : 'INITIATED';
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return view === 'authorize' ? 'CAPTURED' : 'CAPTURED';
    case 'failed':
      return (DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? DECLINE.generic!)[2];
    case 'cancelled':
      return p.providerData.voided ? 'VOID' : 'CANCELLED';
    case 'expired':
      return 'ABANDONED';
  }
}

function response(p: Payment, status: string): { code: string; message: string } {
  if (status === 'CAPTURED') return { code: '000', message: 'Captured' };
  if (status === 'AUTHORIZED') return { code: '001', message: 'Authorized' };
  if (status === 'INITIATED' || status === 'IN_PROGRESS') return { code: '100', message: 'Initiated' };
  if (status === 'VOID') return { code: '601', message: 'Void' };
  if (status === 'CANCELLED') return { code: '302', message: 'Canceled' };
  if (status === 'ABANDONED') return { code: '301', message: 'Abandoned' };
  const [code, message] = DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? DECLINE.generic!;
  return { code, message };
}

const BRAND: Record<string, string> = { visa: 'VISA', mastercard: 'MASTERCARD', mada: 'MADA', amex: 'AMERICAN_EXPRESS', knet: 'KNET', benefit: 'BENEFIT' };

function sourceOf(p: Payment): Json {
  const reqSrc = String(((p.request.source ?? {}) as Json).id ?? 'src_all');
  const out: Json = { object: 'source', id: reqSrc };
  if (OPEN.includes(p.status) || !p.method) return out;
  const brand = p.method === 'knet' || p.method === 'benefit' ? p.method : p.method === 'mada' ? 'mada' : (p.cardBrand ?? 'visa');
  Object.assign(out, { type: 'CARD_NOT_PRESENT', payment_type: brand === 'mada' || brand === 'knet' || brand === 'benefit' ? 'DEBIT' : 'CREDIT', payment_method: BRAND[brand] ?? brand.toUpperCase(), channel: 'INTERNET' });
  return out;
}

function cardOf(p: Payment): Json | undefined {
  if (!p.method || !['card', 'mada', 'applepay'].includes(p.method) || OPEN.includes(p.status)) return undefined;
  const brand = p.method === 'mada' ? 'mada' : (p.cardBrand ?? 'visa');
  return { object: 'card', first_six: String(p.providerData.firstSix ?? (brand === 'mastercard' ? '512345' : brand === 'mada' ? '446404' : '450875')), first_eight: undefined, scheme: BRAND[brand] ?? brand.toUpperCase(), brand: BRAND[brand] ?? brand.toUpperCase(), last_four: p.cardLast4 ?? '1019' };
}

function references(p: Payment): Json {
  const r = (p.request.reference ?? {}) as Json;
  const out: Json = { transaction: asString(r.transaction), order: asString(r.order) };
  if (!OPEN.includes(p.status)) Object.assign(out, { track: 'tck_' + String(p.providerData.track ?? ''), payment: String(p.providerData.paymentRef ?? ''), gateway: String(p.providerData.gatewayRef ?? ''), acquirer: String(p.providerData.acquirerRef ?? '') });
  return out;
}

/** The charge (or authorize) object. */
export function tapCharge(svc: PaymentService, p: Payment, inst: PaymentInstance, view: 'charge' | 'authorize' = isAuthorize(p) && !p.providerData.captured ? 'authorize' : 'charge'): Json {
  const status = tapStatus(p, view);
  const project = svc.hub.projects.get(p.projectId)!;
  const amount = view === 'charge' && isAuthorize(p) && p.providerData.capturedAmount !== undefined ? Number(p.providerData.capturedAmount) : p.amount;
  const out: Json = {
    id: view === 'authorize' ? p.providerRef : chargeId(p),
    object: view,
    live_mode: false,
    customer_initiated: true,
    api_version: 'V2',
    method: 'CREATE',
    status,
    amount: amountNumber(amount, p.currency),
    currency: p.currency,
    threeDSecure: p.request.threeDSecure !== false,
    card_threeDSecure: p.status === 'paid' && !p.providerData.noThreeDs,
    save_card: p.request.save_card === true,
    merchant_id: String(inst.config.merchantId ?? ''),
    product: 'GOSELL',
    description: asString(p.request.description) ?? '',
    metadata: (p.request.metadata as Json | undefined) ?? {},
    transaction: { timezone: 'UTC+03:00', created: created(p), url: OPEN.includes(p.status) ? svc.entryUrl(project, inst, p) : undefined, expiry: { period: 30, type: 'MINUTE' }, asynchronous: false, amount: amountNumber(p.amount, p.currency), currency: p.currency },
    reference: references(p),
    response: response(p, status),
    receipt: { email: false, sms: true },
    customer: (p.request.customer as Json | undefined) ?? {},
    merchant: { country: 'KW', currency: p.currency, id: String(inst.config.merchantId ?? '') },
    source: view === 'charge' && isAuthorize(p) ? { object: 'source', id: p.providerRef } : sourceOf(p),
    redirect: { status: OPEN.includes(p.status) ? 'PENDING' : 'SUCCESS', url: p.returnUrl ?? '' },
    post: { status: p.providerData.posted ? 'SUCCESS' : 'PENDING', url: p.callbackUrl ?? '' },
    activities: [{ id: 'activity_' + alnum(20), object: 'activity', created: Number(created(p)), status: 'INITIATED', currency: p.currency, amount: amountNumber(p.amount, p.currency), remarks: 'charge - created' }],
    auto_reversed: false,
  };
  const card = cardOf(p);
  if (card) out.card = card;
  if (view === 'authorize') out.auto = { status: p.providerData.captured || p.providerData.voided ? 'COMPLETED' : 'SCHEDULED', type: String(((p.request.auto ?? {}) as Json).type ?? 'VOID'), time: Number(((p.request.auto ?? {}) as Json).time ?? 100) };
  return out;
}

function refundObject(p: Payment, r: { providerRef: string; amount: number; status: string; createdAt: string }, extra: Json = {}): Json {
  const meta = ((p.providerData.refundMeta ?? {}) as Record<string, Json>)[r.providerRef] ?? {};
  const t = String(Date.parse(r.createdAt));
  return {
    id: r.providerRef,
    object: 'refund',
    api_version: 'V2',
    live_mode: false,
    amount: amountNumber(r.amount, p.currency),
    currency: p.currency,
    charge_id: chargeId(p),
    created: t,
    date: { created: Number(t), completed: Number(t), transaction: Number(t) },
    status: 'REFUNDED',
    reason: asString(meta.reason) ?? '',
    reference: { merchant: asString(((meta.reference ?? {}) as Json).merchant), gateway: String(meta.gatewayRef ?? ''), payment: String(meta.paymentRef ?? ''), acquirer: String(meta.acquirerRef ?? '') },
    response: { code: '000', message: 'Refunded' },
    metadata: (meta.metadata as Json | undefined) ?? {},
    post: { status: 'PENDING', url: asString(meta.post) ?? '' },
    transaction: { timezone: 'UTC+03:00', asynchronous: false, amount: amountNumber(r.amount, p.currency), currency: p.currency, date: { created: Number(t), completed: Number(t) } },
    ...extra,
  };
}

/** Tap's hashstring: HMAC-SHA256 (hex, secret API key) of x_id…x_amount…x_currency…x_gateway_reference…x_payment_reference…x_status…x_created…. */
export function tapHashstring(o: { id: string; amount: number | string; currency: string; gatewayReference: string; paymentReference: string; status: string; created: string }, secretKey: string): string {
  const d = currencyDigits(o.currency) ?? 2;
  const amount = Number(o.amount).toFixed(d);
  const s = 'x_id' + o.id + 'x_amount' + amount + 'x_currency' + o.currency + 'x_gateway_reference' + o.gatewayReference + 'x_payment_reference' + o.paymentReference + 'x_status' + o.status + 'x_created' + o.created;
  return createHmac('sha256', secretKey).update(s).digest('hex');
}

// ---------------- auth ----------------

function auth(c: GatewayCtx, publishableOk = false): void {
  const key = bearerToken(c.req);
  if (!key) throw new TapError(401, header(c.req, 'authorization') ? '2107' : '2105', header(c.req, 'authorization') ? 'Authorization Required: use "Authorization: Bearer sk_test_…"' : 'Authentication credentials required');
  if (isLiveKey(key)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', 'A live key (' + key.slice(0, 8) + '…) was sent to ' + c.inst.slug));
    c.resolved.warnings = ['live key rejected'];
    throw new TapError(401, '1101', 'Secret key and environment mismatch: stubyard only accepts test keys');
  }
  if (/^pk_/.test(key) && !publishableOk) throw new TapError(401, '2106', 'Use the secret key, not the public key');
  const cfg = c.inst.config;
  if (cfg.strictKeys ? key !== cfg.secretKey && !(publishableOk && key === cfg.publishableKey) : !/^(sk|pk)_test_[A-Za-z0-9]{8,}$/.test(key) && key !== cfg.secretKey) throw new TapError(401, '2104', 'Invalid API Key');
}

// ---------------- create ----------------

function forced(c: GatewayCtx): string | null {
  const f = header(c.req, 'x-hub-payment-outcome');
  if (!f) return null;
  try {
    return normalizeOutcome(f);
  } catch (e) {
    throw new TapError(400, '1103', 'X-Hub-Payment-Outcome: ' + (e as Error).message);
  }
}

function moneyIn(b: Json): { minor: number; currency: string; lint: LintFinding[] } {
  const currency = (asString(b.currency) ?? '').toUpperCase();
  if (!currency) throw new TapError(400, '1118', 'Currency is required');
  if (currencyDigits(currency) === null) throw new TapError(400, '1119', 'Currency is not supported');
  if (b.amount === undefined || b.amount === null || b.amount === '') throw new TapError(400, '1117', 'Amount is invalid');
  const a = fromDecimal(b.amount, currency);
  if (!a.ok || a.minor <= 0) throw new TapError(400, '1117', 'Amount is invalid');
  const lint: LintFinding[] = [];
  const d = currencyDigits(currency) ?? 2;
  if (a.digits > d) lint.push(finding('pay.amount-precision', 'amount ' + String(b.amount) + ' has more decimals than ' + currency + ' allows (' + d + ')'));
  if (Number.isInteger(Number(b.amount)) && Number(b.amount) >= 100 * 10 ** Math.max(d - 1, 1) && d > 0) lint.push(finding('pay.amount-precision', 'amount ' + String(b.amount) + ' ' + currency + ' looks like minor units: Tap amounts are decimals (10.500 KWD, 25.00 SAR)'));
  return { minor: a.minor, currency, lint };
}

async function createCharge(c: GatewayCtx, b: Json, as: 'charge' | 'authorize'): Promise<unknown> {
  const src = (b.source ?? {}) as Json;
  const srcId = asString(src.id) ?? 'src_all';
  if (as === 'charge' && /^auth_/.test(srcId)) return captureAuthorize(c, b, srcId);
  const money = moneyIn(b);
  const customer = (b.customer ?? null) as Json | null;
  if (!customer || (!asString(customer.id) && (!asString(customer.first_name) || !asString(customer.email) && !((customer.phone ?? null) as Json | null)?.number))) throw new TapError(400, '1103', 'customer.first_name and customer.email (or phone) are required');
  const redirect = asString(((b.redirect ?? {}) as Json).url);
  const post = asString(((b.post ?? {}) as Json).url);
  const lint: LintFinding[] = [...money.lint];
  let methods: PaymentMethod[];
  let tok: TokenCard | null = null;
  if (/^tok_/.test(srcId)) {
    tok = tokensOf(c.inst).get(srcId) ?? null;
    if (!tok) throw new TapError(400, '1125', 'Source is invalid: unknown or used token');
    tokensOf(c.inst).delete(srcId);
    methods = [tok.brand === 'mada' ? 'mada' : 'card'];
  } else {
    const m = SOURCE_METHODS[srcId];
    if (!m) throw new TapError(400, '1125', 'Source is invalid (stubyard: src_all, src_card, src_kw.knet, src_sa.mada, src_bh.benefit, src_apple_pay, tok_…, auth_…)');
    methods = m;
  }
  const threeDs = b.threeDSecure !== false;
  const needsRedirect = !tok || threeDs || methods.some((m) => m === 'knet' || m === 'mada' || m === 'benefit');
  if (!redirect && needsRedirect) {
    c.svc.addInstanceLint(c.inst, finding('pay.tap-redirect-missing', 'POST /v2/' + (as === 'charge' ? 'charges' : 'authorize') + ' without redirect.url (source ' + srcId + ')'));
    throw new TapError(400, '1110', 'Redirect URL is missing');
  }
  if (rejectUrl(redirect) || rejectUrl(post)) throw new TapError(400, rejectUrl(redirect) ? '1111' : '1103', rejectUrl(redirect) ? 'Redirect URL is invalid' : 'Post URL is invalid');
  const ref = (b.reference ?? {}) as Json;
  if (!asString(ref.order) && !asString(ref.transaction)) lint.push(finding('pay.no-reference', 'No reference.order / reference.transaction: the webhook cannot be matched to your order'));
  const apiCard = tok ? { brand: tok.brand, last4: tok.last4, magicId: tok.magicId, luhnValid: false, testCard: true } : null;
  const id = (as === 'charge' ? 'chg_TS0' : 'auth_TS0') + digits(1) + alnum(18);
  let p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: id,
    secondaryRef: null,
    amount: money.minor,
    currency: money.currency,
    reference: asString(ref.order) ?? asString(ref.transaction),
    customerEmail: customer ? asString(customer.email) : null,
    returnUrl: redirect,
    cancelUrl: null,
    callbackUrl: post,
    presetOutcome: forced(c),
    request: b,
    method: methods.length === 1 ? methods[0]! : undefined,
    cardBrand: tok?.brand ?? null,
    cardLast4: tok?.last4 ?? null,
    providerData: { tapObject: as, methods, ...(apiCard ? { apiCard, firstSix: tok!.firstSix, noThreeDs: tok!.noThreeDs } : {}) },
    idempotencyKey: asString(ref.idempotent),
    lint,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  c.resolved.endpoint = 'create ' + as + ' (' + srcId + ')';
  if (tok && (!threeDs || tok.noThreeDs)) {
    const r = await c.svc.complete(p, { via: 'api', method: methods[0]!, card: apiCard });
    p = r.payment;
  }
  return tapCharge(c.svc, c.svc.repo.get(p.id)!, c.inst, as);
}

async function captureAuthorize(c: GatewayCtx, b: Json, authId: string): Promise<unknown> {
  const p0 = c.svc.repo.byInstanceRef(c.inst.id, authId);
  if (!p0 || !isAuthorize(p0)) throw new TapError(400, '1112', 'Authorize ID is invalid');
  c.resolved.payment = p0.id;
  c.resolved.endpoint = 'capture authorize';
  const p = await c.svc.touch(p0);
  const cur = (asString(b.currency) ?? p.currency).toUpperCase();
  if (cur !== p.currency) throw new TapError(400, '1119', 'Currency must match the authorize');
  const amt = b.amount === undefined ? p.amount : fromDecimal(b.amount, cur).minor;
  if (!(amt > 0)) throw new TapError(400, '1117', 'Amount is invalid');
  if (amt > p.amount) throw new TapError(400, '1150', 'Capture amount exceeds the authorized amount');
  const chg = 'chg_TS0' + digits(1) + alnum(18);
  const r = await c.svc.capture(p, { idempotencyKey: asString(((b.reference ?? {}) as Json).idempotent), amount: amt, final: true });
  if (r.error === 'already_captured') throw new TapError(400, '1114', 'Authorize is already captured');
  if (r.error === 'not_approved') throw new TapError(400, '1113', 'Authorize is not authorized (status ' + tapStatus(p, 'authorize') + ')');
  if (r.error === 'amount_exceeds') throw new TapError(400, '1150', 'Capture amount exceeds the authorized amount');
  const out = r.error === 'declined' ? r.payment : c.svc.repo.update(r.payment.id, { secondaryRef: chg, providerData: { ...r.payment.providerData, captureRequest: b } });
  return tapCharge(c.svc, out, c.inst, 'charge');
}

function cardNumberCheck(c: GatewayCtx, card: Json): TokenCard {
  const number = String(card.number ?? '').replace(/\s/g, '');
  const expM = String(card.exp_month ?? '').padStart(2, '0');
  const expY = String(card.exp_year ?? '').slice(-2);
  if (!/^\d{12,19}$/.test(number)) throw new TapError(400, '4100', 'Card number is invalid');
  if (!/^(0[1-9]|1[0-2])$/.test(expM) || !/^\d{2}$/.test(expY)) throw new TapError(400, '4101', 'Card expiry is invalid');
  if (!/^\d{3,4}$/.test(String(card.cvc ?? ''))) throw new TapError(400, '4102', 'Card CVC is invalid');
  const own = TAP_TEST_CARDS.find((x) => x.number === number);
  const d = describeCard(number);
  if (!own && !d.testCard) {
    if (d.luhnValid) c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking ' + d.brand + ' number was sent to POST /v2/tokens on ' + c.inst.slug + ' (refused, not stored)'));
    throw new TapError(400, '4100', d.luhnValid ? 'Card number is not a Tap test card: stubyard only accepts test cards; nothing was stored' : 'Card number is invalid');
  }
  const expiry = expM + '/' + expY;
  const magicId = d.magicId ?? EXPIRY_OUTCOME[expiry] ?? (own ? 'success' : null);
  return { brand: own?.brand ?? d.brand, last4: number.slice(-4), firstSix: number.slice(0, 6), magicId, expiry, noThreeDs: NO_3DS.includes(number), name: asString(card.name), cardId: 'card_' + alnum(24) };
}

async function createToken(c: GatewayCtx, b: Json): Promise<unknown> {
  const card = (b.card ?? null) as Json | null;
  if (!card) throw new TapError(400, '1103', 'card is required');
  const t = cardNumberCheck(c, card);
  const id = 'tok_' + alnum(24);
  tokensOf(c.inst).set(id, t);
  c.resolved.endpoint = 'create token';
  return { id, created: Date.now(), object: 'token', live_mode: false, type: 'CARD', used: false, card: { id: t.cardId, object: 'card', funding: t.brand === 'mada' ? 'DEBIT' : 'CREDIT', fingerprint: alnum(40), brand: BRAND[t.brand] ?? t.brand.toUpperCase(), scheme: BRAND[t.brand] ?? t.brand.toUpperCase(), name: t.name, exp_month: Number(t.expiry.slice(0, 2)), exp_year: Number(t.expiry.slice(3)), last_four: t.last4, first_six: t.firstSix } };
}

async function refund(c: GatewayCtx, b: Json): Promise<unknown> {
  const cid = asString(b.charge_id);
  if (!cid) throw new TapError(400, '1142', 'Charge ID is required');
  const p0 = c.svc.repo.byInstanceRef(c.inst.id, cid);
  if (!p0 || (isAuthorize(p0) && p0.secondaryRef !== cid)) throw new TapError(400, '1143', 'Charge ID is invalid');
  c.resolved.payment = p0.id;
  c.resolved.endpoint = 'create refund';
  const p = await c.svc.touch(p0);
  if (!asString(b.reason)) throw new TapError(400, '1103', 'reason is required');
  const cur = (asString(b.currency) ?? '').toUpperCase();
  if (!cur) throw new TapError(400, '1118', 'Currency is required');
  if (cur !== p.currency) throw new TapError(400, '1119', 'Currency must match the charge');
  if (b.amount === undefined || b.amount === null || b.amount === '') throw new TapError(400, '1117', 'Amount is invalid');
  const a = fromDecimal(b.amount, cur);
  if (!a.ok || a.minor <= 0) throw new TapError(400, '1117', 'Amount is invalid');
  if (!['paid', 'partially_refunded'].includes(p.status)) throw new TapError(400, '1156', 'The charge is ' + tapStatus(p) + ' and cannot be refunded');
  const rid = 're_TS0' + digits(1) + alnum(18);
  // The refund webhook is built inside svc.refund: store Tap's refund fields (post.url, references) first.
  const meta = { ...((p.providerData.refundMeta ?? {}) as Json), [rid]: { reason: asString(b.reason), reference: b.reference ?? {}, metadata: b.metadata ?? {}, post: asString(((b.post ?? {}) as Json).url), gatewayRef: digits(12), paymentRef: digits(18), acquirerRef: digits(12) } };
  const withMeta = c.svc.repo.update(p.id, { providerData: { ...p.providerData, refundMeta: meta } });
  try {
    await c.svc.refund(withMeta, a.minor, { providerRef: rid, reason: asString(b.reason) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new TapError(400, '1161', 'Refund amount exceeds the limit: ' + e.message);
    throw e;
  }
  const out = c.svc.repo.get(p.id)!;
  const r = c.svc.repo.refunds(p.id).find((x) => x.providerRef === rid)!;
  return refundObject(out, r);
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const m = c.req.method;
  const path = c.path.replace(/\/+$/, '') || '/';
  const entry = /^\/gosell\/([^/]+)$/.exec(path);
  if (entry && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(entry[1]!));
    if (!p) throw new TapError(404, '1143', 'Charge ID is invalid');
    c.resolved.payment = p.id;
    c.resolved.endpoint = 'payment page';
    return c.reply.redirect('../page/' + p.id, 302);
  }
  if (!path.startsWith('/v2/')) throw new TapError(404, '1103', m + ' ' + path + ' is not simulated by stubyard (Tap API v2: /v2/charges, /v2/authorize, /v2/refunds, /v2/tokens)');
  auth(c, m === 'POST' && path === '/v2/tokens');
  const b = bodyOf(c.req);
  if (m === 'POST' && path === '/v2/charges') return createCharge(c, b, 'charge');
  if (m === 'POST' && path === '/v2/authorize') return createCharge(c, b, 'authorize');
  if (m === 'POST' && path === '/v2/refunds') return refund(c, b);
  if (m === 'POST' && path === '/v2/tokens') return createToken(c, b);
  if (m === 'POST' && (path === '/v2/charges/list' || path === '/v2/authorize/list' || path === '/v2/refunds/list')) {
    const kind = path.split('/')[2]!;
    c.resolved.endpoint = 'list ' + kind;
    const limit = Math.min(Math.max(Number(b.limit ?? 25) || 25, 1), 50);
    const all = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, limit: 200 });
    if (kind === 'refunds') {
      const refunds = all.flatMap((p) => c.svc.repo.refunds(p.id).map((r) => refundObject(p, r)));
      return { object_type: 'list', live_mode: false, count: Math.min(refunds.length, limit), has_more: refunds.length > limit, api_version: 'V2', refunds: refunds.slice(0, limit) };
    }
    let views = await Promise.all(all.filter((p) => (kind === 'authorize' ? isAuthorize(p) : !isAuthorize(p) || !!p.secondaryRef)).map(async (p) => tapCharge(c.svc, await c.svc.touch(p), c.inst, kind === 'authorize' ? 'authorize' : 'charge')));
    if (b.status) views = views.filter((v) => v.status === String(b.status).toUpperCase());
    const key = kind === 'authorize' ? 'authorize' : 'charges';
    return { object_type: 'list', live_mode: false, count: Math.min(views.length, limit), has_more: views.length > limit, api_version: 'V2', [key]: views.slice(0, limit) };
  }
  const one = /^\/v2\/(charges|authorize|refunds)\/([^/]+)(\/void)?$/.exec(path);
  if (one) {
    const [, kind, id, voidIt] = one as unknown as [string, string, string, string | undefined];
    if (kind === 'refunds' && m === 'GET') {
      const hit = c.svc.repo.refundByRef(c.project.id, id);
      if (!hit || hit.payment.instanceId !== c.inst.id) throw new TapError(404, '1157', 'Refund ID is invalid');
      c.resolved.payment = hit.payment.id;
      return refundObject(hit.payment, hit.refund);
    }
    const p0 = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(id));
    const wrong = !p0 || (kind === 'authorize' ? !isAuthorize(p0) : isAuthorize(p0) && p0.secondaryRef !== id);
    if (wrong) throw new TapError(404, kind === 'authorize' ? '1112' : '1143', (kind === 'authorize' ? 'Authorize' : 'Charge') + ' ID is invalid');
    c.resolved.payment = p0!.id;
    let p = await c.svc.touch(p0!);
    if (voidIt && kind === 'authorize' && m === 'POST') {
      c.resolved.endpoint = 'void authorize';
      if (p.status !== 'authorized' || p.providerData.captured) throw new TapError(400, '1115', 'Authorize cannot be voided (status ' + tapStatus(p, 'authorize') + ')');
      p = await c.svc.voidPayment(p, { webhook: true });
      return tapCharge(c.svc, p, c.inst, 'authorize');
    }
    if (m === 'GET' && !voidIt) {
      c.resolved.endpoint = 'retrieve ' + kind;
      c.svc.repo.addEvent(p, 'status_queried', { via: 'GET /v2/' + kind + '/:id' });
      return tapCharge(c.svc, p, c.inst, kind === 'authorize' ? 'authorize' : 'charge');
    }
    if (m === 'PUT' && !voidIt && kind === 'charges') {
      c.resolved.endpoint = 'update charge';
      const patch: Json = { ...p.request };
      for (const k of ['description', 'metadata', 'receipt']) if (b[k] !== undefined) patch[k] = b[k];
      p = c.svc.repo.update(p.id, { request: patch });
      return tapCharge(c.svc, p, c.inst, 'charge');
    }
  }
  throw new TapError(404, '1103', m + ' ' + path + ' is not simulated by stubyard');
}

function stamp(svc: PaymentService, p: Payment): Payment {
  if (OPEN.includes(p.status) || p.providerData.gatewayRef) return p;
  return svc.repo.update(p.id, { providerData: { ...p.providerData, gatewayRef: digits(12), paymentRef: digits(18), acquirerRef: digits(12), track: alnum(20) } });
}

export const tapGateway: Gateway = {
  preset: 'tap',
  name: 'Tap Payments',
  description: 'Tap API v2: charges (hosted page), authorize + capture / void, refunds, card tokens, list; hashstring-signed post.url webhooks; cards, mada, KNET, BENEFIT, Apple Pay.',
  available: true,
  note: 'Built from developers.tap.company (Nov 2026). GET /v2/charges/:id, POST /v2/authorize/:id/void and the tap_id return parameter are not on the public pages stubyard could read; they follow Tap\'s SDKs.',
  kind: 'hpp',
  methods: ['card', 'mada', 'knet', 'benefit', 'applepay'],
  logo: 'TP',
  slugBase: 'tap',
  webhookToCallbackUrl: true,
  testCards: TAP_TEST_CARDS,
  fields: [
    { key: 'secretKey', label: 'Secret key', secret: true, hint: 'sk_test_…: Authorization: Bearer; also the hashstring HMAC key' },
    { key: 'publishableKey', label: 'Public key', hint: 'pk_test_…: card SDK / POST /v2/tokens only' },
    { key: 'merchantId', label: 'Merchant ID', hint: 'Shown in charge objects' },
    { key: 'webhookUrl', label: 'Default post URL', hint: 'Used when a charge has no post.url' },
  ],
  defaults: () => ({ secretKey: 'sk_test_' + alnum(24), publishableKey: 'pk_test_' + alnum(24), merchantId: digits(7), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => !isAuthorize(p),
  retryOnDecline: false,
  entryPath: (p) => '/gosell/' + p.providerRef,
  refundRef: () => 're_TS0' + digits(1) + alnum(18),
  methodsFor: (p) => (p.providerData.methods as PaymentMethod[] | undefined) ?? ['card', 'mada', 'knet', 'benefit', 'applepay'],
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof TapError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ errors: [{ code: e.code, description: e.message }] });
      }
      if (e instanceof HttpError && e.statusCode < 500) return c.reply.status(e.statusCode).send({ errors: [{ code: '1103', description: e.message }] });
      throw e;
    }
  },
  returnTo: (_svc, p) => {
    if (!p.returnUrl) return null;
    const u = new URL(p.returnUrl);
    u.searchParams.set('tap_id', p.providerRef);
    return { kind: 'redirect', url: u.toString() };
  },
  events: (p, point) => {
    if (point === 'refunded') return ['refund'];
    if (point === 'pending') return [];
    if (isAuthorize(p)) return point === 'approved' || point === 'failed' || point === 'cancelled' ? ['authorize'] : point === 'paid' ? ['charge'] : [];
    return ['paid', 'settled', 'failed', 'cancelled'].includes(point) ? ['charge'] : [];
  },
  buildEvent: (svc, p0, inst, type) => {
    const p = stamp(svc, p0);
    const key = inst.config.secretKey ?? '';
    if (type === 'refund') {
      const r = svc.repo.refunds(p.id).at(-1);
      const meta = r ? ((((p.providerData.refundMeta ?? {}) as Record<string, Json>)[r.providerRef] ?? {}) as Json) : {};
      const obj = r ? refundObject(p, r) : {};
      const hash = r ? tapHashstring({ id: r.providerRef, amount: Number(obj.amount), currency: p.currency, gatewayReference: String(meta.gatewayRef ?? ''), paymentReference: String(meta.paymentRef ?? ''), status: 'REFUNDED', created: String(obj.created) }, key) : '';
      return { url: asString(meta.post) ?? p.callbackUrl ?? inst.config.webhookUrl ?? null, body: JSON.stringify(obj), eventId: (r?.providerRef ?? p.providerRef) + ':REFUNDED', signing: null, headers: { hashstring: hash } };
    }
    const view = type === 'authorize' ? 'authorize' : 'charge';
    const obj = tapCharge(svc, p, inst, view);
    const ref = obj.reference as Json;
    const hash = tapHashstring({ id: String(obj.id), amount: Number(obj.amount), currency: p.currency, gatewayReference: String(ref.gateway ?? ''), paymentReference: String(ref.payment ?? ''), status: String(obj.status), created: String((obj.transaction as Json).created) }, key);
    return { url: p.callbackUrl ?? inst.config.webhookUrl ?? null, body: JSON.stringify(obj), eventId: obj.id + ':' + String(obj.status), signing: null, headers: { hashstring: hash } };
  },
  shape: (svc, p, inst) => tapCharge(svc, p, inst),
  providerStatus: (p) => {
    const s = tapStatus(p);
    return s + ' (' + response(p, s).code + ')';
  },
  afterComplete: (svc, p) => {
    stamp(svc, p);
  },
  lateLint: (svc, p) => {
    if (OPEN.includes(p.status) || p.status === 'expired' || !p.returnUrl) return [];
    const ev = svc.repo.events(p.id);
    if (ev.some((e) => e.type === 'status_queried' || e.type === 'webhook_delivered')) return [];
    return [finding('pay.tap-charge-not-retrieved', (isAuthorize(p) ? 'Authorize ' : 'Charge ') + p.providerRef + ' finished but GET /v2/' + (isAuthorize(p) ? 'authorize' : 'charges') + '/:id was never called and no webhook reached your app')];
  },
  connect: (inst, urls) => ({
    env: { TAP_SECRET_KEY: inst.config.secretKey ?? '', TAP_PUBLIC_KEY: String(inst.config.publishableKey ?? ''), TAP_BASE_URL: urls.backend + '/v2', TAP_BASE_URL_LOCAL: urls.backendLocal + '/v2' },
    notes: [
      'Use TAP_BASE_URL instead of https://api.tap.company/v2. Auth: "Authorization: Bearer <secret key>". Amounts are decimals in the currency precision (10.500 KWD, 25.00 SAR).',
      'POST /v2/charges with source.id src_all (stubyard page: card, mada, KNET, BENEFIT, Apple Pay), src_card, src_kw.knet, src_sa.mada, src_bh.benefit or a tok_… from POST /v2/tokens → transaction.url; the browser returns to redirect.url?tap_id=chg_….',
      'Authorize + capture: POST /v2/authorize, then POST /v2/charges with source.id = the auth_… id; POST /v2/authorize/:id/void releases it.',
      'Webhooks: the charge / authorize / refund object is POSTed to post.url (else the default post URL here) with header "hashstring" = HMAC-SHA256 hex of x_id…x_amount…x_currency…x_gateway_reference…x_payment_reference…x_status…x_created…, keyed with the secret key, amount with the currency\'s decimals.',
      'Tap\'s server SDKs are thin REST wrappers without a documented base-URL option: call the REST API with your own HTTP client, or route api.tap.company to stubyard with the host form <instance>.<project>.pay.<domain>.',
      'Test tokens: Tap test cards with expiry 01/39 approve, 05/22 decline, 04/27 expired card, 08/28 timeout; the stubyard magic cards also work.',
    ],
    snippets: [
      {
        title: 'Verify the hashstring (Node)',
        lang: 'js',
        code: "import { createHmac, timingSafeEqual } from 'node:crypto';\nconst DIGITS = { KWD: 3, BHD: 3, OMR: 3, JOD: 3 };\nfunction tapHash(o, key) {\n  const amount = Number(o.amount).toFixed(DIGITS[o.currency] ?? 2);\n  const created = o.object === 'refund' ? o.created : o.transaction.created;\n  const s = 'x_id' + o.id + 'x_amount' + amount + 'x_currency' + o.currency + 'x_gateway_reference' + (o.reference?.gateway ?? '') + 'x_payment_reference' + (o.reference?.payment ?? '') + 'x_status' + o.status + 'x_created' + created;\n  return createHmac('sha256', key).update(s).digest('hex');\n}\napp.post('/webhooks/tap', express.json(), (req, res) => {\n  const want = Buffer.from(tapHash(req.body, process.env.TAP_SECRET_KEY));\n  const got = Buffer.from(String(req.headers.hashstring ?? ''));\n  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.sendStatus(401);\n  res.sendStatus(200);\n});",
      },
      {
        title: 'Verify the hashstring (PHP)',
        lang: 'php',
        code: "$o = json_decode(file_get_contents('php://input'), true);\n$dec = in_array($o['currency'], ['KWD','BHD','OMR','JOD']) ? 3 : 2;\n$created = $o['object'] === 'refund' ? $o['created'] : $o['transaction']['created'];\n$s = 'x_id'.$o['id'].'x_amount'.number_format($o['amount'], $dec, '.', '').'x_currency'.$o['currency'].'x_gateway_reference'.($o['reference']['gateway'] ?? '').'x_payment_reference'.($o['reference']['payment'] ?? '').'x_status'.$o['status'].'x_created'.$created;\nif (!hash_equals(hash_hmac('sha256', $s, getenv('TAP_SECRET_KEY')), $_SERVER['HTTP_HASHSTRING'] ?? '')) { http_response_code(401); exit; }",
      },
    ],
  }),
};
