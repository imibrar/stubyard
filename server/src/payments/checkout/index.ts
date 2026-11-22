import { createHash, createHmac } from 'node:crypto';
import type { Gateway, GatewayCtx, GatewayTestCard, Json } from '../gateway.js';
import { alnum, asString, bodyOf, decodeRef, ExpiringStore, header, IdempotencyCache, isLiveKey, safeEqual } from '../common.js';
import { currencyDigits, describeCard, normalizeOutcome, OPEN, toDecimal } from '../engine.js';
import { t, type Locale } from '../kit/i18n.js';
import { flowDemo, flowJs, FLOW_VERSION, renderFlowFrame } from '../sdk/checkout-flow.js';
import { channelOf, checkSdkOrigin, sdkCors } from '../sdk/runtime.js';
import { htmlReply, renderSdkError } from '../sdk/wallet.js';
import { finding, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import type { PaymentService } from '../service.js';
import { HttpError } from '../../util.js';

/**
 * Fake Checkout.com (unified payments API) under /pay/<project>/<instance>/…: POST /hosted-payments, /payment-links,
 * /payments (card / token sources, 3-D Secure 202 + redirect), GET /payments/:id (pay_ or sid_), /actions, captures,
 * refunds, voids (202 + action_id), Cko-Idempotency-Key, and webhooks signed with Cko-Signature (HMAC-SHA256 hex of
 * the raw body with the signature key). checkout.com/docs + api-reference, Nov 2026.
 */

class CkoError extends Error {
  constructor(
    public status: number,
    public codes: string[] = [],
    public errorType = 'request_invalid',
  ) {
    super(codes.join(', ') || 'HTTP ' + status);
  }
}

/** Checkout.com sandbox test cards (checkout.com/docs/developer-resources/testing/test-cards). */
export const CHECKOUT_TEST_CARDS: GatewayTestCard[] = [
  { number: '4242424242424242', brand: 'visa', magicId: null, label: 'Visa (frictionless)' },
  { number: '4543474002249996', brand: 'visa', magicId: null, label: 'Visa' },
  { number: '5436031030606378', brand: 'mastercard', magicId: null, label: 'Mastercard' },
  { number: '345678901234564', brand: 'amex', magicId: null, label: 'Amex' },
  { number: '4539467987109256', brand: 'visa', magicId: 'decline', label: 'Visa declined (20005)', code: '20005' },
  { number: '4024007181869214', brand: 'visa', magicId: 'decline', label: 'Visa declined (20005)', code: '20005' },
  { number: '4243754271700719', brand: 'visa', magicId: '3ds', label: 'Visa 3DS challenge' },
  { number: '4485597929486000', brand: 'visa', magicId: '3ds', label: 'Visa 3DS challenge' },
];

/** Engine decline reason → Checkout.com response code / summary. */
export const CHECKOUT_DECLINE: Record<string, [string, string]> = {
  generic: ['20005', 'Declined - Do not honour'],
  insufficient_funds: ['20051', 'Insufficient Funds'],
  expired_card: ['30033', 'Expired Card - Pick Up'],
  incorrect_cvc: ['20087', 'Bad Track Data (invalid CVV and/or expiry date)'],
  processing_error: ['20068', 'Response received too late / Timeout'],
  authentication_failed: ['20150', 'Card not 3D Secure enabled / Authentication failed'],
};
/** Magic amounts of the sandbox (minor units). */
const AMOUNT_DECLINE: Record<number, string> = { 101: 'insufficient_funds', 5: 'generic' };
const REFUND_DECLINE_AMOUNT = 3738;

const idem = new Map<string, IdempotencyCache>();
const isHpp = (p: Payment) => p.providerRef.startsWith('hpp_') || p.providerRef.startsWith('pl_');
const payId = (p: Payment) => (isHpp(p) ? p.secondaryRef! : p.providerRef);
const iso = (s: string | null | undefined) => (s ? new Date(s).toISOString() : null);

type Action = { id: string; type: string; processed_on: string; amount: number; approved: boolean; response_code: string; response_summary: string; reference: string | null };
const actionsOf = (p: Payment): Action[] => ((p.providerData.actions as Action[] | undefined) ?? []).slice();
function addAction(svc: PaymentService, p: Payment, a: Omit<Action, 'id' | 'processed_on'>): { payment: Payment; action: Action } {
  const cur = svc.repo.get(p.id)!;
  const action: Action = { id: 'act_' + alnum(26).toLowerCase(), processed_on: new Date().toISOString(), ...a };
  return { payment: svc.repo.update(p.id, { providerData: { ...cur.providerData, actions: [...actionsOf(cur), action] } }), action };
}

function ckoStatus(p: Payment): string {
  const captured = Number(p.providerData.capturedAmount ?? (['paid', 'partially_refunded', 'refunded'].includes(p.status) ? p.amount : 0));
  switch (p.status) {
    case 'created':
    case 'pending':
    case 'requires_action':
      return 'Pending';
    case 'authorized':
      return 'Authorized';
    case 'paid':
      return captured < p.amount ? 'Partially Captured' : 'Captured';
    case 'partially_refunded':
      return 'Partially Refunded';
    case 'refunded':
      return 'Refunded';
    case 'failed':
      return 'Declined';
    case 'cancelled':
      return p.providerData.voided ? 'Voided' : 'Canceled';
    case 'expired':
      return 'Expired';
  }
}

function sourceOf(p: Payment): Json {
  const reqSrc = (p.request.source ?? {}) as Json;
  if (OPEN.includes(p.status) && !p.cardLast4) return { type: asString(reqSrc.type) ?? 'card' };
  const brand = p.method === 'mada' ? 'mada' : (p.cardBrand ?? 'visa');
  const scheme = brand === 'mastercard' ? 'Mastercard' : brand === 'amex' ? 'Amex' : brand === 'mada' ? 'Mada' : 'Visa';
  return { id: 'src_' + String(p.providerData.sourceId ?? alnum(26).toLowerCase()), type: 'card', expiry_month: Number(reqSrc.expiry_month ?? 12), expiry_year: Number(reqSrc.expiry_year ?? 2030), scheme, last4: p.cardLast4 ?? '4242', fingerprint: String(p.providerData.fingerprint ?? alnum(64)), bin: String(p.providerData.bin ?? '424242'), card_type: brand === 'mada' ? 'DEBIT' : 'CREDIT', issuer_country: brand === 'mada' ? 'SA' : 'GB', avs_check: 'G', cvv_check: 'Y' };
}

function balances(p: Payment): Json {
  const status = ckoStatus(p);
  const authorized = ['Pending', 'Declined', 'Canceled', 'Expired'].includes(status) ? 0 : p.amount;
  const captured = Number(p.providerData.capturedAmount ?? (['Captured', 'Partially Refunded', 'Refunded'].includes(status) ? p.amount : 0));
  const refunded = p.refunded;
  const voided = p.providerData.voided ? p.amount : 0;
  return { total_authorized: authorized, total_voided: voided, available_to_void: status === 'Authorized' ? p.amount : 0, total_captured: captured, available_to_capture: status === 'Authorized' ? p.amount - captured : 0, total_refunded: refunded, available_to_refund: captured - refunded };
}

function links(svc: PaymentService, p: Payment, inst: PaymentInstance, base: string): Json {
  const self = base + '/payments/' + payId(p);
  const st = ckoStatus(p);
  const out: Json = { self: { href: self }, actions: { href: self + '/actions' } };
  if (st === 'Pending' && !isHpp(p)) {
    const project = svc.hub.projects.get(p.projectId)!;
    out.redirect = { href: svc.entryUrl(project, inst, p) };
  }
  if (st === 'Authorized') Object.assign(out, { capture: { href: self + '/captures' }, void: { href: self + '/voids' } });
  if (['Captured', 'Partially Captured', 'Partially Refunded'].includes(st)) out.refund = { href: self + '/refunds' };
  return out;
}

/** GET /payments/:id. */
export function checkoutPayment(svc: PaymentService, p: Payment, inst: PaymentInstance, base = ''): Json {
  const st = ckoStatus(p);
  const decline = CHECKOUT_DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? CHECKOUT_DECLINE.generic!;
  return {
    id: payId(p),
    requested_on: iso(p.createdAt),
    source: sourceOf(p),
    amount: p.amount,
    amount_requested: p.amount,
    currency: p.currency,
    payment_type: asString(p.request.payment_type) ?? 'Regular',
    reference: p.reference,
    description: asString(p.request.description) ?? undefined,
    approved: !['Pending', 'Declined', 'Expired', 'Canceled'].includes(st),
    status: st,
    balances: balances(p),
    '3ds': p.request['3ds'] || p.providerData.challenge ? { downgraded: false, enrolled: 'Y', authentication_response: st === 'Declined' && p.providerData.declineReason === 'authentication_failed' ? 'N' : 'Y' } : undefined,
    risk: { flagged: false, score: 0 },
    customer: { id: 'cus_' + String(p.providerData.customerId ?? alnum(26).toLowerCase()), email: p.customerEmail ?? undefined, name: asString(((p.request.customer ?? {}) as Json).name) ?? undefined },
    metadata: (p.request.metadata as Json | undefined) ?? {},
    eci: st === 'Pending' ? undefined : '05',
    scheme_id: st === 'Pending' ? undefined : String(p.providerData.schemeId ?? ''),
    ...(st === 'Declined' ? { response_code: decline[0], response_summary: decline[1] } : {}),
    _links: links(svc, p, inst, base),
  };
}

/** The create (POST /payments) response. */
function createResponse(svc: PaymentService, p: Payment, inst: PaymentInstance, base: string): Json {
  const st = ckoStatus(p);
  if (st === 'Pending') return { id: payId(p), status: 'Pending', reference: p.reference, customer: { id: 'cus_' + String(p.providerData.customerId ?? '') }, '3ds': { downgraded: false, enrolled: 'Y' }, _links: links(svc, p, inst, base) };
  const auth = actionsOf(p).find((a) => a.type === 'Authorization');
  const decline = CHECKOUT_DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? CHECKOUT_DECLINE.generic!;
  const ok = st !== 'Declined';
  return {
    id: payId(p),
    action_id: auth?.id ?? 'act_' + alnum(26).toLowerCase(),
    amount: p.amount,
    currency: p.currency,
    approved: ok,
    status: st,
    auth_code: ok ? String(p.providerData.authCode ?? '') : undefined,
    response_code: ok ? '10000' : decline[0],
    response_summary: ok ? 'Approved' : decline[1],
    balances: balances(p),
    risk: { flagged: false, score: 0 },
    source: sourceOf(p),
    customer: { id: 'cus_' + String(p.providerData.customerId ?? '') },
    processed_on: iso(p.updatedAt),
    reference: p.reference,
    scheme_id: String(p.providerData.schemeId ?? ''),
    _links: links(svc, p, inst, base),
  };
}

function hostedView(svc: PaymentService, p: Payment, inst: PaymentInstance, base: string): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const link = p.providerRef.startsWith('pl_');
  const st = ckoStatus(p);
  const status = link ? (st === 'Pending' ? 'Active' : st === 'Expired' ? 'Expired' : 'Payment Received') : st === 'Pending' ? 'Payment Pending' : st === 'Expired' ? 'Expired' : 'Payment Received';
  const out: Json = {
    id: p.providerRef,
    status,
    amount: p.amount,
    currency: p.currency,
    reference: p.reference,
    description: asString(p.request.description) ?? undefined,
    customer: (p.request.customer as Json | undefined) ?? undefined,
    billing: (p.request.billing as Json | undefined) ?? undefined,
    products: (p.request.products as unknown[] | undefined) ?? undefined,
    metadata: (p.request.metadata as Json | undefined) ?? {},
    expires_on: p.expiresAt,
    created_on: p.createdAt,
    _links: { self: { href: base + (link ? '/payment-links/' : '/hosted-payments/') + p.providerRef }, redirect: { href: svc.entryUrl(project, inst, p) } } as Json,
  };
  if (link) out.return_url = asString(p.request.return_url) ?? undefined;
  else Object.assign(out, { success_url: p.returnUrl, cancel_url: p.cancelUrl, failure_url: asString(p.request.failure_url) });
  if (status === 'Payment Received') (out._links as Json).payment = { href: base + '/payments/' + payId(p) };
  return out;
}

/** Cko-Signature: hex HMAC-SHA256 of the raw webhook body with the signature key. */
export function checkoutSignature(body: string, key: string): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

// ---------------- auth ----------------

function auth(c: GatewayCtx, publicOk: boolean): void {
  const raw = header(c.req, 'authorization');
  if (!raw) throw new CkoError(401);
  const bearer = /^Bearer\s+(.+)$/i.exec(raw);
  const key = (bearer ? bearer[1]! : raw).trim();
  if (isLiveKey(key) || /^(sk|pk)_(?!sbox_|test_)[a-z0-9]{2,}_/i.test(key) === false && /^(sk|pk)_[0-9a-f]{8}-/i.test(key)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', 'A live / production-format key (' + key.slice(0, 8) + '…) was sent to ' + c.inst.slug));
    c.resolved.warnings = ['live key rejected'];
    throw new CkoError(401);
  }
  if (!bearer) {
    if (/^sk_sbox_/.test(key)) {
      c.svc.addInstanceLint(c.inst, finding('pay.checkout-key-without-bearer', 'Authorization: ' + key.slice(0, 12) + '… without "Bearer ": the current sk_sbox_ keys need the Bearer scheme'));
      throw new CkoError(401);
    }
  }
  const cfg = c.inst.config;
  if (/^pk_/.test(key) && !publicOk) throw new CkoError(401);
  const ok = cfg.strictKeys ? key === cfg.secretKey || (publicOk && key === cfg.publicKey) : /^(sk|pk)_(sbox|test)_[A-Za-z0-9]{8,}$/.test(key) || key === cfg.secretKey;
  if (!ok) throw new CkoError(401);
}

function forced(c: GatewayCtx): string | null {
  const f = header(c.req, 'x-hub-payment-outcome');
  if (!f) return null;
  try {
    return normalizeOutcome(f);
  } catch (e) {
    throw new CkoError(422, ['outcome_invalid: ' + (e as Error).message]);
  }
}

function amountIn(c: GatewayCtx, b: Json, required = true): { minor: number; currency: string } {
  const currency = (asString(b.currency) ?? '').toUpperCase();
  if (!currency) throw new CkoError(422, ['currency_required']);
  const d = currencyDigits(currency);
  if (d === null) throw new CkoError(422, ['currency_invalid']);
  if (b.amount === undefined || b.amount === null) {
    if (required) throw new CkoError(422, ['amount_required']);
    return { minor: 0, currency };
  }
  const n = Number(b.amount);
  if (!Number.isInteger(n) || n < 0) throw new CkoError(422, ['amount_invalid']);
  if (d === 3 && n % 10 !== 0) {
    c.svc.addInstanceLint(c.inst, finding('pay.checkout-amount-invalid', 'amount ' + n + ' ' + currency + ': 3-decimal currencies need a last digit of 0 (minor units, e.g. 10.500 KWD → 10500)'));
    throw new CkoError(422, ['amount_invalid']);
  }
  if (currency === 'CLP' && n % 100 !== 0) {
    c.svc.addInstanceLint(c.inst, finding('pay.checkout-amount-invalid', 'amount ' + n + ' CLP must end in 00'));
    throw new CkoError(422, ['amount_invalid']);
  }
  return { minor: n, currency };
}

function stamp(p: Payment): Json {
  return { customerId: alnum(26).toLowerCase(), sourceId: alnum(26).toLowerCase(), schemeId: String(Date.now()).slice(-12) + '000', authCode: String(100000 + Math.floor(Math.random() * 899999)), fingerprint: alnum(64), ...p.providerData };
}

async function createHosted(c: GatewayCtx, b: Json, link: boolean): Promise<unknown> {
  const money = amountIn(c, b);
  if (money.minor <= 0) throw new CkoError(422, ['amount_invalid']);
  const lint: LintFinding[] = [];
  const ref = asString(b.reference);
  if (!link) {
    if (!asString(b.success_url)) throw new CkoError(422, ['success_url_required']);
    if (!asString(b.failure_url)) throw new CkoError(422, ['failure_url_required']);
    if (!asString(b.cancel_url)) throw new CkoError(422, ['cancel_url_required']);
  }
  if (!asString(((((b.billing ?? {}) as Json).address ?? {}) as Json).country)) throw new CkoError(422, ['billing_address_country_required']);
  for (const k of ['success_url', 'failure_url', 'cancel_url', 'return_url']) if (rejectUrl(b[k])) throw new CkoError(422, [k + '_invalid']);
  if (!ref) lint.push(finding('pay.no-reference', 'No reference: the webhook cannot be matched to your order'));
  const methods: PaymentMethod[] = ['card', 'mada', 'applepay'];
  const allowed = Array.isArray(b.allow_payment_methods) ? (b.allow_payment_methods as unknown[]).map(String) : null;
  const ms = allowed ? methods.filter((m) => allowed.includes(m) || (m === 'card' && allowed.includes('card'))) : methods;
  const id = (link ? 'pl_' : 'hpp_') + alnum(12);
  const expiresIn = link ? Number(b.expires_in ?? 86400) : 3600;
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: id,
    secondaryRef: 'pay_' + alnum(26).toLowerCase(),
    amount: money.minor,
    currency: money.currency,
    reference: ref,
    customerEmail: asString(((b.customer ?? {}) as Json).email),
    returnUrl: asString(link ? b.return_url : b.success_url),
    cancelUrl: asString(b.cancel_url),
    callbackUrl: null,
    presetOutcome: forced(c),
    request: b,
    providerData: { methods: ms.length ? ms : methods, sessionId: 'sid_' + alnum(26).toLowerCase() },
    idempotencyKey: header(c.req, 'cko-idempotency-key'),
    lint,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });
  c.resolved.endpoint = link ? 'create payment link' : 'create hosted payment';
  const project = c.project;
  const out: Json = { id: p.providerRef, reference: p.reference, _links: { self: { href: c.base + (link ? '/payment-links/' : '/hosted-payments/') + p.providerRef }, redirect: { href: c.svc.entryUrl(project, c.inst, p) } } };
  if (link) out.expires_on = p.expiresAt;
  c.reply.status(201);
  return out;
}

function sourceCard(c: GatewayCtx, src: Json): { brand: string; last4: string; magicId: string | null; luhnValid: boolean; testCard: boolean; bin: string } {
  if (src.type === 'token') {
    const t = asString(src.token);
    const card = t ? tokensOf(c.inst).get(t) : undefined;
    if (!card) throw new CkoError(422, ['token_invalid']);
    tokensOf(c.inst).delete(t!);
    return card;
  }
  if (src.type !== 'card') throw new CkoError(422, ['source_type_invalid']);
  return cardCheck(c, src, 'POST /payments');
}

function cardCheck(c: GatewayCtx, src: Json, where: string): { brand: string; last4: string; magicId: string | null; luhnValid: boolean; testCard: boolean; bin: string } {
  const number = String(src.number ?? '').replace(/\s/g, '');
  if (!/^\d{12,19}$/.test(number)) throw new CkoError(422, ['card_number_invalid']);
  if (!(Number(src.expiry_month) >= 1 && Number(src.expiry_month) <= 12)) throw new CkoError(422, ['card_expiry_month_invalid']);
  if (!(Number(src.expiry_year) >= 2000)) throw new CkoError(422, ['card_expiry_year_invalid']);
  const own = CHECKOUT_TEST_CARDS.find((x) => x.number === number);
  const d = describeCard(number);
  if (!own && !d.testCard) {
    if (d.luhnValid) c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking ' + d.brand + ' number was sent to ' + where + ' on ' + c.inst.slug + ' (refused, not stored)'));
    throw new CkoError(422, ['card_number_invalid']);
  }
  const expired = new Date(Number(src.expiry_year), Number(src.expiry_month), 1).getTime() < Date.now();
  return { brand: own?.brand ?? d.brand, last4: number.slice(-4), magicId: expired ? 'expired_card' : (own?.magicId ?? d.magicId), luhnValid: d.luhnValid, testCard: true, bin: number.slice(0, 6) };
}

type Tok = ReturnType<typeof cardCheck>;
/** Card tokens per instance: expire after 15 min (expires_on), at most 1000 per instance. */
const tokens = new Map<string, ExpiringStore<Tok>>();
const tokensOf = (inst: PaymentInstance) => {
  let m = tokens.get(inst.id);
  if (!m) tokens.set(inst.id, (m = new ExpiringStore<Tok>()));
  return m;
};

/** POST /payments; opts.flow: a Flow payment session submit (realistic 3-D Secure page, cko-payment-id on return). */
async function createPayment(c: GatewayCtx, b: Json, opts: { flow?: string } = {}): Promise<unknown> {
  const src = (b.source ?? null) as Json | null;
  if (!src) throw new CkoError(422, ['source_required']);
  const money = amountIn(c, b);
  const card = sourceCard(c, src);
  const threeDs = !!((b['3ds'] ?? {}) as Json).enabled || card.magicId === '3ds';
  for (const k of ['success_url', 'failure_url']) if (rejectUrl(b[k])) throw new CkoError(422, [k + '_invalid']);
  const lint: LintFinding[] = [];
  if (!asString(b.reference)) lint.push(finding('pay.no-reference', 'No reference: the webhook cannot be matched to your order'));
  if (!header(c.req, 'cko-idempotency-key') && !opts.flow) lint.push(finding('pay.no-idempotency-key', 'POST /payments without Cko-Idempotency-Key'));
  const amountDecline = AMOUNT_DECLINE[money.minor];
  const magicId = card.magicId === '3ds' ? null : card.magicId === 'decline' ? 'decline' : card.magicId;
  const apiCard = { brand: card.brand, last4: card.last4, magicId: amountDecline ? (amountDecline === 'insufficient_funds' ? 'insufficient_funds' : 'decline') : magicId, luhnValid: card.luhnValid, testCard: true };
  const id = 'pay_' + alnum(26).toLowerCase();
  let p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: id,
    secondaryRef: null,
    amount: money.minor,
    currency: money.currency,
    reference: asString(b.reference),
    customerEmail: asString(((b.customer ?? {}) as Json).email),
    returnUrl: asString(b.success_url),
    cancelUrl: asString(b.failure_url),
    callbackUrl: null,
    presetOutcome: forced(c),
    request: b,
    method: card.brand === 'mada' ? 'mada' : 'card',
    cardBrand: card.brand,
    cardLast4: card.last4,
    providerData: { methods: [card.brand === 'mada' ? 'mada' : 'card'], apiCard, bin: card.bin, sessionId: 'sid_' + alnum(26).toLowerCase(), challenge: threeDs, ...(opts.flow ? { flowSession: opts.flow, checkoutView: { ui: 'realistic' } } : {}) },
    idempotencyKey: header(c.req, 'cko-idempotency-key'),
    lint,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  p = c.svc.repo.update(p.id, { providerData: stamp(p) });
  c.resolved.endpoint = 'request payment' + (threeDs ? ' (3DS)' : '');
  if (threeDs) {
    c.reply.status(202);
    return createResponse(c.svc, p, c.inst, c.base);
  }
  const r = await c.svc.complete(p, { via: 'api', method: card.brand === 'mada' ? 'mada' : 'card', card: apiCard });
  const out = c.svc.repo.get(r.payment.id)!;
  c.reply.status(201);
  return createResponse(c.svc, out, c.inst, c.base);
}

async function findPayment(c: GatewayCtx, id: string): Promise<Payment> {
  let p = id.startsWith('sid_') ? c.svc.repo.byDataRef(c.inst.id, 'sessionId', id) : c.svc.repo.byInstanceRef(c.inst.id, id);
  if (p && isHpp(p) && id.startsWith('pay_') && OPEN.includes(p.status)) p = null;
  if (!p) throw new CkoError(404);
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

async function action(c: GatewayCtx, p: Payment, kind: 'captures' | 'refunds' | 'voids', b: Json): Promise<unknown> {
  const st = ckoStatus(p);
  const reference = asString(b.reference);
  const done = (x: { payment: Payment; action: Action }) => {
    c.reply.status(202);
    return { action_id: x.action.id, reference: x.action.reference ?? undefined, _links: { payment: { href: c.base + '/payments/' + payId(x.payment) } } };
  };
  const amount = b.amount === undefined || b.amount === null ? null : Number(b.amount);
  if (amount !== null && (!Number.isInteger(amount) || amount <= 0)) throw new CkoError(422, ['amount_invalid']);
  if (kind === 'captures') {
    c.resolved.endpoint = 'capture';
    if (st !== 'Authorized') {
      c.svc.addLint(p, [finding(['Captured', 'Partially Captured', 'Refunded', 'Partially Refunded'].includes(st) ? 'pay.double-capture' : 'pay.capture-before-approve', 'Capture of ' + payId(p) + ' while ' + st)]);
      throw new CkoError(403, ['capture_not_allowed'], 'action_not_allowed');
    }
    const amt = amount ?? p.amount;
    if (amt > p.amount) throw new CkoError(422, ['capture_value_greater_than_authorized']);
    const r = await c.svc.capture(p, { idempotencyKey: header(c.req, 'cko-idempotency-key'), amount: amt, final: true });
    if (r.error && r.error !== 'declined') throw new CkoError(403, ['capture_not_allowed'], 'action_not_allowed');
    return done(addAction(c.svc, r.payment, { type: 'Capture', amount: amt, approved: r.error !== 'declined', response_code: r.error === 'declined' ? '20005' : '10000', response_summary: r.error === 'declined' ? 'Declined - Do not honour' : 'Approved', reference }));
  }
  if (kind === 'voids') {
    c.resolved.endpoint = 'void';
    if (st !== 'Authorized') throw new CkoError(403, ['void_not_allowed'], 'action_not_allowed');
    const out = await c.svc.voidPayment(p, { webhook: true });
    return done(addAction(c.svc, out, { type: 'Void', amount: p.amount, approved: true, response_code: '10000', response_summary: 'Approved', reference }));
  }
  c.resolved.endpoint = 'refund';
  if (!['Captured', 'Partially Captured', 'Partially Refunded'].includes(st)) throw new CkoError(403, ['refund_not_allowed'], 'action_not_allowed');
  const left = Number(balances(p).available_to_refund);
  const amt = amount ?? left;
  if (amt > left) {
    c.svc.addLint(p, [finding('pay.refund-exceeds', 'Refund of ' + amt + ' > ' + left + ' left on ' + payId(p))]);
    throw new CkoError(422, ['refund_amount_exceeds_balance']);
  }
  if (amt === REFUND_DECLINE_AMOUNT) {
    const x = addAction(c.svc, p, { type: 'Refund', amount: amt, approved: false, response_code: '20057', response_summary: 'Transaction not permitted to cardholder', reference });
    c.svc.repo.addEvent(x.payment, 'refund_declined', { amount: amt, action: x.action.id });
    await c.svc.webhooks.queue(x.payment, c.inst, 'payment_refund_declined', { delayMs: Number(c.inst.config.webhookDelayMs ?? 500) });
    c.svc.changed(p.projectId, { payment: p.id });
    return done(x);
  }
  const actId = 'act_' + alnum(26).toLowerCase();
  try {
    await c.svc.refund(p, amt, { providerRef: actId, reason: asString(b.reference) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new CkoError(422, ['refund_amount_exceeds_balance']);
    throw e;
  }
  const cur = c.svc.repo.get(p.id)!;
  const a: Action = { id: actId, processed_on: new Date().toISOString(), type: 'Refund', amount: amt, approved: true, response_code: '10000', response_summary: 'Approved', reference };
  const out = c.svc.repo.update(p.id, { providerData: { ...cur.providerData, actions: [...actionsOf(cur), a] } });
  return done({ payment: out, action: a });
}

// ---------------- Flow (checkout-web-components): payment sessions ----------------

type FlowSession = { id: string; secret: string; amount: number; currency: string; request: Json; locale: string; payment: string | null; approved: boolean };
type SessionData = { session: string; card: Tok };
/** Payment sessions and their session_data per instance (in memory, like the card tokens): 60 / 15 min. */
const flowSessions = new Map<string, ExpiringStore<FlowSession>>();
const flowData = new Map<string, ExpiringStore<SessionData>>();
const sessionsOf = (inst: PaymentInstance) => {
  let m = flowSessions.get(inst.id);
  if (!m) flowSessions.set(inst.id, (m = new ExpiringStore<FlowSession>(60 * 60_000)));
  return m;
};
const sessionDataOf = (inst: PaymentInstance) => {
  let m = flowData.get(inst.id);
  if (!m) flowData.set(inst.id, (m = new ExpiringStore<SessionData>()));
  return m;
};

/** POST /payment-sessions (secret key). */
function createSession(c: GatewayCtx, b: Json): Json {
  const money = amountIn(c, b);
  if (money.minor <= 0) throw new CkoError(422, ['amount_invalid']);
  if (!asString(b.success_url)) throw new CkoError(422, ['success_url_required']);
  if (!asString(b.failure_url)) throw new CkoError(422, ['failure_url_required']);
  for (const k of ['success_url', 'failure_url']) if (rejectUrl(b[k])) throw new CkoError(422, [k + '_invalid']);
  const billing = (b.billing ?? null) as Json | null;
  if (!billing || !asString(((billing.address ?? {}) as Json).country)) throw new CkoError(422, ['billing_address_country_required']);
  if (!asString(b.reference)) c.svc.addInstanceLint(c.inst, finding('pay.no-reference', 'POST /payment-sessions without reference: the webhook cannot be matched to your order'));
  const id = 'ps_' + alnum(26).toLowerCase();
  const secret = 'pss_' + alnum(8).toLowerCase() + '-' + alnum(4).toLowerCase() + '-' + alnum(4).toLowerCase() + '-' + alnum(12).toLowerCase();
  const { amount: _a, currency: _c, ...request } = b;
  sessionsOf(c.inst).set(id, { id, secret, amount: money.minor, currency: money.currency, request, locale: String(b.locale ?? 'en'), payment: null, approved: false });
  c.resolved.endpoint = 'create payment session';
  c.reply.status(201);
  const token = Buffer.from(JSON.stringify({ id, amount: money.minor, currency: money.currency, environment: 'sandbox', stubyard: true })).toString('base64');
  return { id, payment_session_secret: secret, payment_session_token: token, _links: { self: { href: c.base + '/payment-sessions/' + id } } };
}

function sessionOf(c: GatewayCtx, id: string): FlowSession {
  const s = /^ps_[a-z0-9]{8,}$/.test(id) ? sessionsOf(c.inst).get(id) : undefined;
  if (!s) throw new CkoError(404);
  return s;
}

/** The facts a Flow frame sends instead of the card: test cards only. */
function factsCard(c: GatewayCtx, f: unknown, where: string): Tok {
  const card = (f && typeof f === 'object' ? f : {}) as Json;
  const brand = String(card.brand ?? 'unknown').toLowerCase().slice(0, 20);
  if (card.test !== true) {
    if (card.luhn === true) c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking ' + brand + ' card reached ' + where + ' on ' + c.inst.slug + ' (refused, not stored)'));
    throw new CkoError(422, ['card_number_invalid']);
  }
  const last4 = String(card.last4 ?? '').replace(/\D/g, '').slice(-4);
  if (last4.length !== 4) throw new CkoError(422, ['card_number_invalid']);
  const bin = String(card.bin ?? '').replace(/\D/g, '').slice(0, 6);
  return { brand, last4, magicId: asString(card.magicId)?.slice(0, 40) ?? null, luhnValid: card.luhn === true, testCard: true, bin };
}

/** Which public key a Flow request names (the publicKey given to CheckoutWebComponents). */
function publicKeyOk(c: GatewayCtx, key: unknown): boolean {
  const k = typeof key === 'string' ? key : '';
  if (isLiveKey(k)) {
    c.svc.addInstanceLint(c.inst, finding('pay.live-key', 'A live public key (' + k.slice(0, 8) + '…) was given to CheckoutWebComponents on ' + c.inst.slug));
    return false;
  }
  return c.inst.config.strictKeys ? k === c.inst.config.publicKey : /^pk_(sbox|test)_[A-Za-z0-9]{8,}$/.test(k) || k === c.inst.config.publicKey;
}

/** Submit a payment session: the card behind session_data becomes a token payment (POST /payments semantics). */
async function submitSession(c: GatewayCtx, s: FlowSession, b: Json): Promise<Json> {
  c.resolved.endpoint = 'submit payment session';
  if (s.approved) throw new CkoError(422, ['payment_session_completed']);
  const sd = asString(b.session_data);
  const data = sd ? sessionDataOf(c.inst).get(sd) : undefined;
  if (!data || data.session !== s.id) throw new CkoError(422, ['session_data_invalid']);
  sessionDataOf(c.inst).delete(sd!);
  const tok = 'tok_' + alnum(26).toLowerCase();
  tokensOf(c.inst).set(tok, data.card);
  const req = s.request;
  const body: Json = {
    ...req,
    amount: b.amount !== undefined ? b.amount : s.amount,
    currency: s.currency,
    reference: asString(b.reference) ?? req.reference,
    source: { type: 'token', token: tok },
    metadata: { ...((req.metadata ?? {}) as Json), cko_payment_session_id: s.id },
    ...(b['3ds'] !== undefined ? { '3ds': b['3ds'] } : {}),
    ...(b.ip_address !== undefined ? { payment_ip: b.ip_address } : {}),
  };
  const r = (await createPayment(c, body, { flow: s.id })) as Json;
  c.resolved.endpoint = 'submit payment session';
  const status = String(r.status ?? '');
  s.payment = String(r.id ?? '');
  if (status === 'Pending') {
    const href = String((((r._links ?? {}) as Json).redirect as Json | undefined)?.href ?? '');
    return { id: r.id, status: 'Action Required', type: 'card', action: { type: 'redirect', url: href } };
  }
  if (status === 'Declined') return { id: r.id, status: 'Declined', type: 'card', response_code: r.response_code, response_summary: r.response_summary };
  s.approved = true;
  return { id: r.id, status: 'Approved', type: 'card' };
}

/** The Flow browser routes (no Authorization header: the public key and the payment session secret). */
async function flowRoute(c: GatewayCtx, m: string, path: string): Promise<unknown> {
  if (/^\/checkout-web-components\/(?:[\w.-]+\/)*index(?:\.min)?\.js$/.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'flow web components js';
    return c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').header('cross-origin-resource-policy', 'cross-origin').header('access-control-allow-origin', '*').send(flowJs({ base: c.base, version: FLOW_VERSION }));
  }
  if (path === '/demo' || path === '/demo/result') {
    if (m !== 'GET' && m !== 'HEAD') return undefined;
    return flowDemo(c, path.slice(5), async (b) => {
      const s = createSession(c, b);
      c.reply.status(200);
      return s;
    }, (id) => {
      const p = c.svc.repo.byInstanceRef(c.inst.id, id);
      return p ? ckoStatus(p) : null;
    });
  }
  if (!path.startsWith('/flow/')) return undefined;
  const pub = /^\/flow\/payment-sessions\/([^/]+)$/.exec(path);
  if (pub && (m === 'GET' || m === 'OPTIONS')) {
    sdkCors(c);
    if (m === 'OPTIONS') return c.reply.status(204).send();
    c.resolved.endpoint = 'flow payment session (public)';
    if (!publicKeyOk(c, c.query.key)) throw new CkoError(401);
    const s = sessionOf(c, decodeRef(pub[1]!));
    return { id: s.id, amount: s.amount, currency: s.currency, payment_methods: ['card'], status: s.approved ? 'Completed' : 'Active' };
  }
  if (path === '/flow/submit' && (m === 'POST' || m === 'OPTIONS')) {
    sdkCors(c);
    if (m === 'OPTIONS') return c.reply.status(204).send();
    const b = bodyOf(c.req);
    const s = sessionOf(c, String(b.payment_session_id ?? ''));
    if (!safeEqual(String(b.payment_session_secret ?? ''), s.secret)) throw new CkoError(401);
    const out = await submitSession(c, s, { session_data: b.session_data });
    c.resolved.endpoint = 'flow submit (client)';
    return out;
  }
  if (path === '/flow/frame' && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'flow frame';
    const L: Locale = String(c.query.lang ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
    const title = t(L, 'sdkFrameTitle', { provider: 'Checkout.com' });
    const ch = channelOf(c.query.ch);
    const chk = checkSdkOrigin(c, c.query.origin, 'Checkout.com Flow (' + c.inst.slug + ')');
    if (!ch || !chk.ok) {
      const refused = !chk.ok && chk.reason === 'refused';
      return htmlReply(c, refused ? 403 : 400, renderSdkError(L, title, refused ? t(L, 'sdkOriginRefused', { origin: chk.origin ?? '?', provider: 'Checkout.com' }) : "Flow: missing channel or origin (load the component with stubyard's checkout-web-components)."));
    }
    const s = sessionsOf(c.inst).get(String(c.query.session ?? ''));
    if (!s || !publicKeyOk(c, c.query.key)) return htmlReply(c, 404, renderSdkError(L, title, 'Flow: unknown or expired payment session, or a wrong public key.'));
    const component = c.query.component === 'card' ? 'card' : 'flow';
    return htmlReply(c, 200, renderFlowFrame({ locale: L, origin: chk.origin, ch, key: String(c.query.key), session: s.id, amountText: toDecimal(s.amount, s.currency) + ' ' + s.currency, component, showPay: c.query.pay !== '0', cardholder: c.query.name === '1', testCards: CHECKOUT_TEST_CARDS }));
  }
  if ((path === '/flow/session-data' || path === '/flow/tokens') && m === 'POST') {
    // From the component frame (stubyard's origin, no CORS): card facts, never digits.
    const b = bodyOf(c.req);
    if (!publicKeyOk(c, b.key)) throw new CkoError(401);
    const s = sessionOf(c, String(b.session ?? ''));
    const card = factsCard(c, b.card, 'the Flow component');
    if (path === '/flow/tokens') {
      c.resolved.endpoint = 'flow tokenize';
      const id = 'tok_' + alnum(26).toLowerCase();
      tokensOf(c.inst).set(id, card);
      c.reply.status(201);
      return { type: 'card', token: id, expires_on: new Date(Date.now() + 15 * 60_000).toISOString(), expiry_month: Number(b.expiry_month) || undefined, expiry_year: Number(b.expiry_year) || undefined, scheme: card.brand === 'mastercard' ? 'Mastercard' : card.brand === 'amex' ? 'Amex' : card.brand === 'mada' ? 'Mada' : 'Visa', last4: card.last4, bin: card.bin, card_type: 'CREDIT' };
    }
    c.resolved.endpoint = 'flow session data';
    const sd = 'sd_' + alnum(32);
    sessionDataOf(c.inst).set(sd, { session: s.id, card });
    return { session_data: sd };
  }
  if (path === '/flow/card-warning' && m === 'POST') {
    c.resolved.endpoint = 'flow card warning';
    c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking card number was typed into the Flow component on ' + c.inst.slug + ' (cleared in the frame, never sent)'));
    return c.reply.status(204).send();
  }
  return undefined;
}


async function handle(c: GatewayCtx): Promise<unknown> {
  const m = c.req.method;
  const path = c.path.replace(/\/+$/, '');
  const flow = await flowRoute(c, m, path);
  if (flow !== undefined) return flow;
  const entry = /^\/(?:hpp|link|3ds)\/([^/]+)$/.exec(path);
  if (entry && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(entry[1]!));
    if (!p) throw new CkoError(404);
    c.resolved.payment = p.id;
    c.resolved.endpoint = 'payment page';
    return c.reply.redirect('../page/' + p.id, 302);
  }
  auth(c, m === 'POST' && path === '/tokens');
  const b = bodyOf(c.req);

  const key = m === 'POST' ? header(c.req, 'cko-idempotency-key') : null;
  const cache = idem.get(c.inst.id) ?? new IdempotencyCache();
  idem.set(c.inst.id, cache);
  const hash = createHash('sha256').update(path + '\n' + JSON.stringify(b)).digest('hex');
  if (key) {
    const hit = cache.get(key);
    if (hit) {
      if (hit.hash !== hash) throw new CkoError(409, ['idempotency_key_reused'], 'request_invalid');
      c.resolved.idempotentReplay = true;
      return c.reply.status(hit.status).header('cko-idempotency-replayed', 'true').send(hit.body);
    }
  }
  const body = await route(c, m, path, b);
  if (key && c.reply.statusCode < 300) cache.set(key, hash, c.reply.statusCode, body);
  return body;
}

async function route(c: GatewayCtx, m: string, path: string, b: Json): Promise<unknown> {
  if (m === 'POST' && path === '/hosted-payments') return createHosted(c, b, false);
  if (m === 'POST' && path === '/payment-links') return createHosted(c, b, true);
  if (m === 'POST' && path === '/payments') return createPayment(c, b);
  if (m === 'POST' && path === '/payment-sessions') return createSession(c, b);
  const sub = /^\/payment-sessions\/([^/]+)\/submit$/.exec(path);
  if (sub && m === 'POST') return submitSession(c, sessionOf(c, decodeRef(sub[1]!)), b);
  if (m === 'POST' && path === '/tokens') {
    if (b.type !== 'card') throw new CkoError(422, ['token_type_invalid']);
    const t = cardCheck(c, b, 'POST /tokens');
    const id = 'tok_' + alnum(26).toLowerCase();
    tokensOf(c.inst).set(id, t);
    c.resolved.endpoint = 'create token';
    c.reply.status(201);
    return { type: 'card', token: id, expires_on: new Date(Date.now() + 15 * 60_000).toISOString(), expiry_month: Number(b.expiry_month), expiry_year: Number(b.expiry_year), scheme: t.brand === 'mastercard' ? 'Mastercard' : t.brand === 'amex' ? 'Amex' : 'Visa', last4: t.last4, bin: t.bin, card_type: 'CREDIT' };
  }
  const hp = /^\/(hosted-payments|payment-links)\/([^/]+)$/.exec(path);
  if (hp && m === 'GET') {
    const p0 = c.svc.repo.byInstanceRef(c.inst.id, decodeRef(hp[2]!));
    if (!p0 || !isHpp(p0)) throw new CkoError(404);
    c.resolved.payment = p0.id;
    const p = await c.svc.touch(p0);
    c.resolved.endpoint = 'get ' + hp[1];
    return hostedView(c.svc, p, c.inst, c.base);
  }
  const pm = /^\/payments\/([^/]+)(?:\/(actions|captures|refunds|voids))?$/.exec(path);
  if (pm) {
    const p = await findPayment(c, decodeRef(pm[1]!));
    if (!pm[2] && m === 'GET') {
      c.resolved.endpoint = 'get payment details';
      c.svc.repo.addEvent(p, 'status_queried', { via: 'GET /payments/:id' });
      return checkoutPayment(c.svc, p, c.inst, c.base);
    }
    if (pm[2] === 'actions' && m === 'GET') {
      c.resolved.endpoint = 'get payment actions';
      return actionsOf(p)
        .slice()
        .reverse()
        .map((a) => ({ id: a.id, type: a.type, processed_on: a.processed_on, amount: a.amount, approved: a.approved, response_code: a.response_code, response_summary: a.response_summary, reference: a.reference ?? undefined }));
    }
    if (m === 'POST' && (pm[2] === 'captures' || pm[2] === 'refunds' || pm[2] === 'voids')) return action(c, p, pm[2], b);
  }
  throw new CkoError(404);
}

function webhookData(p: Payment, type: string): Json {
  const acts = actionsOf(p);
  const kind = type === 'payment_captured' || type === 'payment_capture_declined' ? 'Capture' : type === 'payment_refunded' || type === 'payment_refund_declined' ? 'Refund' : type === 'payment_voided' ? 'Void' : 'Authorization';
  const a = [...acts].reverse().find((x) => x.type === kind);
  const decline = CHECKOUT_DECLINE[String(p.providerData.declineReason ?? 'generic')] ?? CHECKOUT_DECLINE.generic!;
  const declined = type === 'payment_declined';
  return {
    id: payId(p),
    action_id: a?.id ?? 'act_' + alnum(26).toLowerCase(),
    reference: p.reference,
    amount: a?.amount ?? p.amount,
    currency: p.currency,
    response_code: declined ? decline[0] : (a?.response_code ?? '10000'),
    response_summary: declined ? decline[1] : (a?.response_summary ?? 'Approved'),
    processed_on: a?.processed_on ?? new Date().toISOString(),
    source: sourceOf(p),
    customer: { id: 'cus_' + String(p.providerData.customerId ?? '') },
    metadata: (p.request.metadata as Json | undefined) ?? {},
    balances: balances(p),
    ...(isHpp(p) ? { [p.providerRef.startsWith('pl_') ? 'payment_link_id' : 'hosted_payment_id']: p.providerRef } : {}),
  };
}

export const checkoutGateway: Gateway = {
  preset: 'checkout',
  name: 'Checkout.com',
  description: 'Checkout.com: Hosted Payments Page, Payment Links, card payments with 3-D Secure, captures / refunds / voids (202 + action_id), idempotency, Cko-Signature webhooks.',
  available: true,
  note: 'Built from checkout.com/docs (Nov 2026). The redirect query parameter after the hosted page (cko-payment-id) and the full hosted-payments response are not on the public pages stubyard could read; webhooks are configured here (dashboard), not via the Workflows API. Flow (checkout-web-components) is simulated for card payments (no wallets / APMs inside Flow); Frames (deprecated) is not.',
  kind: 'hpp',
  methods: ['card', 'mada', 'applepay'],
  logo: 'CO',
  slugBase: 'checkout',
  testCards: CHECKOUT_TEST_CARDS,
  fields: [
    { key: 'secretKey', label: 'Secret key', secret: true, hint: 'sk_sbox_…: Authorization: Bearer' },
    { key: 'publicKey', label: 'Public key', hint: 'pk_sbox_…: Frames / Flow / POST /tokens' },
    { key: 'webhookUrl', label: 'Webhook URL', hint: 'Where payment events are POSTed' },
    { key: 'signatureKey', label: 'Webhook signature key', secret: true, hint: 'HMAC-SHA256 key of the Cko-Signature header' },
    { key: 'webhookAuthorization', label: 'Webhook Authorization header', secret: true, hint: 'Sent as Authorization on every webhook (optional)' },
  ],
  defaults: () => ({ secretKey: 'sk_sbox_' + alnum(26).toLowerCase(), publicKey: 'pk_sbox_' + alnum(26).toLowerCase(), signatureKey: alnum(36), webhookAuthorization: alnum(24), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => p.request.capture !== false,
  retryOnDecline: false,
  entryPath: (p) => (p.providerRef.startsWith('pl_') ? '/link/' : p.providerRef.startsWith('hpp_') ? '/hpp/' : '/3ds/') + p.providerRef,
  refundRef: () => 'act_' + alnum(26).toLowerCase(),
  methodsFor: (p) => (p.providerData.methods as PaymentMethod[] | undefined) ?? ['card', 'mada', 'applepay'],
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof CkoError) {
        c.resolved.error = e.message;
        c.reply.header('cko-request-id', alnum(8) + '-' + alnum(4) + '-' + alnum(12));
        if (e.status === 401 || e.status === 404) return c.reply.status(e.status).send('');
        return c.reply.status(e.status).send({ request_id: 'req_' + alnum(26).toLowerCase(), error_type: e.errorType, error_codes: e.codes });
      }
      if (e instanceof HttpError && e.statusCode < 500) return c.reply.status(e.statusCode === 400 ? 422 : e.statusCode).send({ request_id: 'req_' + alnum(26).toLowerCase(), error_type: 'request_invalid', error_codes: [e.message] });
      throw e;
    }
  },
  returnTo: (_svc, p, _inst, kind) => {
    const r = p.request;
    const t = asString(kind === 'success' ? (p.providerRef.startsWith('pl_') ? r.return_url : r.success_url) : kind === 'cancelled' && p.providerRef.startsWith('hpp_') ? r.cancel_url : r.failure_url);
    if (!t) return null;
    const u = new URL(t);
    if (isHpp(p)) u.searchParams.set('cko-payment-id', payId(p));
    else if (p.providerData.flowSession) {
      u.searchParams.set('cko-payment-session-id', String(p.providerData.flowSession));
      u.searchParams.set('cko-payment-id', payId(p));
    } else u.searchParams.set('cko-session-id', String(p.providerData.sessionId ?? ''));
    return { kind: 'redirect', url: u.toString() };
  },
  events: (p, point) => {
    switch (point) {
      case 'approved':
      case 'authorized':
        return ['payment_approved'];
      case 'paid':
        return p.providerData.capturedAmount !== undefined && actionsOf(p).some((a) => a.type === 'Capture') ? ['payment_captured'] : ['payment_approved', 'payment_captured'];
      case 'pending':
        return ['payment_pending'];
      case 'failed':
        return ['payment_declined'];
      case 'refunded':
        return ['payment_refunded'];
      case 'cancelled':
        return [p.providerData.voided ? 'payment_voided' : 'payment_canceled'];
      case 'expired':
        return ['payment_expired'];
      case 'settled':
        return ['payment_captured'];
      default:
        return [];
    }
  },
  buildEvent: (_svc, p, inst, type) => {
    const id = 'evt_' + alnum(26).toLowerCase();
    const body = JSON.stringify({ id, type, version: '1.0.33', created_on: new Date().toISOString(), data: webhookData(p, type), _links: { self: { href: '/workflows/events/' + id }, subject: { href: '/payments/' + payId(p) } } });
    const headers: Record<string, string> = { 'cko-signature': checkoutSignature(body, String(inst.config.signatureKey ?? '')) };
    if (inst.config.webhookAuthorization) headers.authorization = String(inst.config.webhookAuthorization);
    return { url: inst.config.webhookUrl ?? null, body, eventId: id, signing: null, headers };
  },
  shape: (svc, p, inst) => (isHpp(p) && OPEN.includes(p.status) ? hostedView(svc, p, inst, '') : checkoutPayment(svc, p, inst)),
  providerStatus: (p) => ckoStatus(p),
  afterComplete: (svc, p) => {
    if (!p.providerData.authCode) svc.repo.update(p.id, { providerData: stamp(svc.repo.get(p.id)!) });
    const cur = svc.repo.get(p.id)!;
    if (!OPEN.includes(cur.status) && !actionsOf(cur).some((a) => a.type === 'Authorization')) {
      const ok = cur.status !== 'failed';
      const decline = CHECKOUT_DECLINE[String(cur.providerData.declineReason ?? 'generic')] ?? CHECKOUT_DECLINE.generic!;
      addAction(svc, cur, { type: 'Authorization', amount: cur.amount, approved: ok, response_code: ok ? '10000' : decline[0], response_summary: ok ? 'Approved' : decline[1], reference: cur.reference });
      if (ok && cur.status === 'paid') addAction(svc, svc.repo.get(p.id)!, { type: 'Capture', amount: cur.amount, approved: true, response_code: '10000', response_summary: 'Approved', reference: cur.reference });
    }
  },
  connect: (inst, urls) => ({
    env: { CKO_SECRET_KEY: String(inst.config.secretKey ?? ''), CKO_PUBLIC_KEY: String(inst.config.publicKey ?? ''), CKO_SIGNATURE_KEY: String(inst.config.signatureKey ?? ''), CKO_WEBHOOK_AUTHORIZATION: String(inst.config.webhookAuthorization ?? ''), CKO_BASE_URL: urls.backend, CKO_BASE_URL_LOCAL: urls.backendLocal, CKO_WEB_COMPONENTS_URL: urls.browser + '/checkout-web-components/index.js' },
    notes: [
      'Use CKO_BASE_URL instead of https://api.sandbox.checkout.com with "Authorization: Bearer <secret key>". Amounts are integers in minor units; 3-decimal currencies (KWD, BHD, OMR, JOD) must end in 0.',
      'Hosted Payments: POST /hosted-payments {amount, currency, reference, billing.address.country, success_url, failure_url, cancel_url} → _links.redirect.href; the buyer returns with ?cko-payment-id=pay_…; GET /payments/:id for the result.',
      'Card API: POST /payments with source {type: "card", …} or {type: "token", token} → 201 Authorized / Captured / Declined, or 202 Pending + _links.redirect.href with 3ds.enabled (back to success_url?cko-session-id=sid_…; GET /payments/sid_…).',
      'Captures / refunds / voids answer 202 {action_id}; the result arrives as a webhook (payment_captured / payment_refunded / payment_voided). Refund amount 3738 is declined (payment_refund_declined); amount 101 is declined with 20051.',
      'Flow: POST /payment-sessions {amount, currency, reference, billing.address.country, success_url, failure_url} → {id: ps_…, payment_session_secret, payment_session_token}; load CKO_WEB_COMPONENTS_URL instead of https://checkout-web-components.checkout.com/index.js, then (await CheckoutWebComponents({publicKey: CKO_PUBLIC_KEY, environment: "sandbox", paymentSession, locale, onReady, onChange, onPaymentCompleted, onError, handleSubmit})).create("flow").mount("#flow-container"). The component is a stubyard iframe (TEST notice, EN / AR); 3-D Secure is a full-page redirect, back to success_url?cko-payment-id=pay_…; webhooks carry metadata.cko_payment_session_id. handleSubmit: your server calls POST /payment-sessions/{id}/submit {session_data}. Allowed page origins: sdkOrigins here or the project app origins. Try it: {browser base}/demo.',
      'Webhooks: verify Cko-Signature = hex HMAC-SHA256(raw body, signature key) and the Authorization header you configured.',
      'checkout-sdk-node: new Checkout(secretKey, { host: CKO_BASE_URL }). Java: CustomEnvironment. The Python / .NET SDKs have no base-URL option: use the REST API directly, or the host form <instance>.<project>.pay.<domain>.',
    ],
    snippets: [
      {
        title: 'Verify Cko-Signature (Node)',
        lang: 'js',
        code: "import { createHmac, timingSafeEqual } from 'node:crypto';\napp.post('/webhooks/checkout', express.raw({ type: '*/*' }), (req, res) => {\n  const want = Buffer.from(createHmac('sha256', process.env.CKO_SIGNATURE_KEY).update(req.body).digest('hex'));\n  const got = Buffer.from(String(req.headers['cko-signature'] ?? ''));\n  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.sendStatus(401);\n  if (req.headers.authorization !== process.env.CKO_WEBHOOK_AUTHORIZATION) return res.sendStatus(401);\n  const event = JSON.parse(req.body);\n  res.sendStatus(200);\n});",
      },
      {
        title: 'Verify Cko-Signature (Python)',
        lang: 'python',
        code: "import hmac, hashlib, os\n@app.post('/webhooks/checkout')\ndef cko():\n    raw = request.get_data()\n    want = hmac.new(os.environ['CKO_SIGNATURE_KEY'].encode(), raw, hashlib.sha256).hexdigest()\n    if not hmac.compare_digest(want, request.headers.get('Cko-Signature', '')):\n        abort(401)\n    return '', 200",
      },
    ],
  }),
};
