import { createHmac } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { asList, asString, bodyOf, digits, ExpiringStore, header, phpUrlencode } from '../common.js';
import { currencyDigits, fromDecimal, normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';
import { PAYLIB_VERSION, paylibDemo, paylibJs } from '../sdk/paytabs-paylib.js';
import { checkSdkOrigin, requestBase, sdkCors } from '../sdk/runtime.js';

/**
 * Fake PayTabs PT2 Hosted Payment Page under /pay/<project>/<instance>/…: POST /payment/request (sale / auth and the
 * refund / capture / void follow-ups), POST /payment/query, the hosted page entry /payment/page/<tran_ref>, the signed
 * browser return (form POST, or GET with return_using_get) and the server callback (header "Signature").
 * Shapes follow the PayTabs PHP SDK and support docs; PayTabs error codes other than 1 (authentication) are approximations.
 */

class PtError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

const trace = () => `PMNT${digits(4)}.${Date.now().toString(16).toUpperCase()}.${digits(8)}`;
export const tranRef = () => `TST${digits(13)}`;

/** The PayTabs return signature: drop "signature" and empty fields, sort keys, PHP http_build_query, HMAC-SHA256 hex with the server key. */
export function paytabsReturnSignature(fields: Record<string, string>, serverKey: string): string {
  const q = Object.keys(fields)
    .filter((k) => k !== 'signature' && fields[k] !== '' && fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${phpUrlencode(k)}=${phpUrlencode(String(fields[k]))}`)
    .join('&');
  return createHmac('sha256', serverKey).update(q).digest('hex');
}

const METHOD_IDS: Record<string, PaymentMethod[]> = {
  all: ['card', 'mada', 'stcpay', 'applepay'],
  card: ['card'],
  creditcard: ['card'],
  visa: ['card'],
  mastercard: ['card'],
  mada: ['mada'],
  stcpay: ['stcpay'],
  applepay: ['applepay'],
};

function auth(c: GatewayCtx): void {
  const key = header(c.req, 'authorization');
  if (!key) throw new PtError(401, 1, 'Authentication failed. Check authentication header.');
  if (/^Bearer\s/i.test(key)) {
    c.resolved.warnings = ['PayTabs expects "authorization: <server key>" without "Bearer"'];
    throw new PtError(401, 1, 'Authentication failed. Check authentication header.');
  }
  if (c.inst.config.strictKeys && key !== c.inst.config.serverKey) throw new PtError(401, 1, 'Authentication failed. Check authentication header.');
  if (!c.inst.config.strictKeys && !/^S[A-Z0-9]{9}-[A-Z0-9]{10}-[A-Z0-9]{10}$/.test(key) && key !== c.inst.config.serverKey) {
    throw new PtError(401, 1, 'Authentication failed. Check authentication header.');
  }
}

function profileCheck(c: GatewayCtx, b: Json): void {
  const pid = asString(b.profile_id);
  if (!pid) throw new PtError(400, 2, 'Profile ID is required');
  if (c.inst.config.profileId && String(pid) !== String(c.inst.config.profileId)) throw new PtError(400, 206, 'Profile ID mismatch with the server key');
}

/** respStatus letter of a payment (A authorised, H hold, P pending, V voided, E error, D declined, X expired, C cancelled). */
function statusLetter(p: Payment): string {
  switch (p.status) {
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return 'A';
    case 'authorized':
      return p.providerData.async ? 'P' : 'A';
    case 'failed':
      return p.providerData.declineReason === 'authentication_failed' ? 'E' : 'D';
    case 'cancelled':
      return p.providerData.voided ? 'V' : 'C';
    case 'expired':
      return 'X';
    default:
      return 'P';
  }
}

const DECLINE_TEXT: Record<string, [string, string]> = {
  generic: ['400', 'Declined'],
  insufficient_funds: ['301', 'Insufficient funds'],
  expired_card: ['303', 'Expired card'],
  incorrect_cvc: ['302', 'Invalid CVV'],
  processing_error: ['500', 'Processing error'],
  authentication_failed: ['334', '3DSecure authentication rejected'],
  otp_failed: ['400', 'Declined'],
};

function result(p: Payment): { response_status: string; response_code: string; response_message: string; acquirer_message?: string; acquirer_rrn?: string; cvv_result?: string; avs_result?: string; transaction_time: string } {
  const s = statusLetter(p);
  const code = String(p.providerData.respCode ?? '');
  const time = String(p.providerData.tranTime ?? p.updatedAt);
  if (s === 'A') return { response_status: 'A', response_code: code || 'G00000', response_message: 'Authorised', acquirer_message: '', acquirer_rrn: String(p.providerData.rrn ?? ''), cvv_result: '', avs_result: '', transaction_time: time };
  if (s === 'D' || s === 'E') {
    const [c, m] = DECLINE_TEXT[String(p.providerData.declineReason ?? 'generic')] ?? DECLINE_TEXT.generic!;
    return { response_status: s, response_code: c, response_message: m, transaction_time: time };
  }
  if (s === 'C') return { response_status: 'C', response_code: '321', response_message: 'Cancelled by customer', transaction_time: time };
  if (s === 'X') return { response_status: 'X', response_code: '340', response_message: 'Expired', transaction_time: time };
  if (s === 'V') return { response_status: 'V', response_code: code || 'G00000', response_message: 'Voided', transaction_time: time };
  return { response_status: 'P', response_code: '', response_message: 'Pending', transaction_time: time };
}

function paymentInfo(p: Payment): Json | null {
  if (!p.method) return null;
  if (p.method === 'stcpay') return { payment_method: 'STCPay', card_type: 'Wallet', card_scheme: 'STCPay', payment_description: 'STC Pay' };
  const brand = p.method === 'mada' ? 'mada' : (p.cardBrand ?? 'visa');
  const scheme = brand === 'mada' ? 'mada' : brand === 'mastercard' ? 'MasterCard' : brand === 'amex' ? 'AMEX' : 'Visa';
  const last4 = p.cardLast4 ?? '1111';
  const first = brand === 'mastercard' ? '5200 00' : brand === 'mada' ? '4464 04' : '4111 11';
  return {
    payment_method: p.method === 'applepay' ? 'ApplePay' : scheme,
    card_type: brand === 'mada' ? 'Debit' : 'Credit',
    card_scheme: scheme,
    payment_description: `${first}## #### ${last4}`,
    expiryMonth: 12,
    expiryYear: new Date().getFullYear() + 3,
  };
}

const tranTypeName = (p: Payment) => (p.providerData.tranType === 'auth' ? 'Auth' : 'Sale');

/** The transaction object (query response, callback body). */
function transaction(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const req = p.request;
  const out: Json = {
    tran_ref: p.providerRef,
    tran_type: tranTypeName(p),
    cart_id: p.reference ?? '',
    cart_description: asString(req.cart_description) ?? '',
    cart_currency: p.currency,
    cart_amount: toDecimal(p.amount, p.currency),
    tran_currency: p.currency,
    tran_total: toDecimal(p.amount, p.currency),
    customer_details: (req.customer_details as Json) ?? {},
    payment_result: result(p),
    payment_info: paymentInfo(p),
    serviceId: 2,
    profileId: Number(inst.config.profileId ?? 0),
    merchantId: Number(p.providerData.merchantId ?? 0),
    trace: trace(),
  };
  if (req.shipping_details) out.shipping_details = req.shipping_details;
  if (req.user_defined) out.user_defined = req.user_defined;
  if (p.returnUrl) out.return = p.returnUrl;
  if (p.callbackUrl) out.callback = p.callbackUrl;
  if (p.refunded) out.refunded_amount = toDecimal(p.refunded, p.currency);
  return out;
}

function lintCreate(b: Json, amountBad: boolean, currency: string, amountMinor: number): LintFinding[] {
  const out: LintFinding[] = [];
  if (amountMinor <= 0) out.push(finding('pay.amount-zero', `cart_amount is ${String(b.cart_amount)}`));
  if (amountBad) out.push(finding('pay.amount-precision', `cart_amount ${String(b.cart_amount)} has more decimals than ${currency} allows (${currencyDigits(currency)})`));
  const ru = badUrl(b.return);
  if (ru) out.push(finding('pay.return-url-missing-or-bad', `return ${ru}`));
  if (!asString(b.cart_id)) out.push(finding('pay.no-reference', 'No cart_id: the callback cannot be matched to your order'));
  return out;
}

async function request(c: GatewayCtx, b: Json): Promise<unknown> {
  const type = (asString(b.tran_type) ?? '').toLowerCase();
  if (!type) throw new PtError(400, 4, 'tran_type is required');
  const tranClass = (asString(b.tran_class) ?? '').toLowerCase();
  if (['refund', 'capture', 'void', 'release'].includes(type)) return followUp(c, b, type);
  if (type !== 'sale' && type !== 'auth') throw new PtError(400, 4, `tran_type "${type}" is not simulated by stubyard (sale, auth, refund, capture, void)`);
  if (tranClass && tranClass !== 'ecom') throw new PtError(400, 4, `tran_class "${tranClass}" is not simulated by stubyard (ecom: Hosted Payment Page)`);
  const currency = (asString(b.cart_currency) ?? '').toUpperCase();
  if (!currency) throw new PtError(400, 4, 'cart_currency is required');
  if (currencyDigits(currency) === null) {
    c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', `Unknown currency "${currency}"`));
    throw new PtError(400, 4, 'Currency not supported');
  }
  if (b.cart_amount === undefined || b.cart_amount === null || b.cart_amount === '') throw new PtError(400, 4, 'cart_amount is required');
  const amt = fromDecimal(b.cart_amount, currency);
  if (!amt.ok) throw new PtError(400, 4, 'Invalid cart_amount');
  if (!asString(b.cart_description)) throw new PtError(400, 4, 'cart_description is required');
  const allowed = asList(b.payment_methods).flatMap((m) => METHOD_IDS[m.toLowerCase()] ?? []);
  // Managed form (paylib.js): the card behind payment_token (single use).
  const ptok = asString(b.payment_token);
  const card = ptok ? paylibTokensOf(c.inst).get(ptok) : undefined;
  if (ptok && !card) throw new PtError(400, 4, 'Invalid or used payment_token (paylib tokens are single use and expire after 30 minutes)');
  if (ptok) paylibTokensOf(c.inst).delete(ptok);
  const methods = card ? [card.brand === 'mada' ? 'mada' : 'card'] : allowed.length ? [...new Set(allowed)] : ['card', 'mada', 'stcpay', 'applepay'];
  let preset: string | null = null;
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (forced) {
    try {
      preset = normalizeOutcome(forced);
    } catch (e) {
      throw new PtError(400, 4, `X-Hub-Payment-Outcome: ${(e as Error).message}`);
    }
  }
  for (const param of ['return', 'callback'] as const) {
    const why = rejectUrl(b[param]);
    if (why) {
      c.svc.addInstanceLint(c.inst, finding(param === 'return' ? 'pay.return-url-missing-or-bad' : 'pay.no-webhook-url', `${param} ${why}`));
      throw new PtError(400, 4, `Invalid ${param} URL: it must be an absolute http(s) URL`);
    }
  }
  const customer = (b.customer_details as Json | undefined) ?? {};
  const lint = lintCreate(b, amt.digits > (currencyDigits(currency) ?? 2), currency, amt.minor);
  if (b.callback !== undefined && badUrl(b.callback)) lint.push(finding('pay.no-webhook-url', `callback ${badUrl(b.callback)}`));
  const ref = tranRef();
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: ref,
    secondaryRef: null,
    amount: amt.minor,
    currency,
    reference: asString(b.cart_id),
    customerEmail: asString(customer.email),
    returnUrl: asString(b.return),
    cancelUrl: null,
    callbackUrl: asString(b.callback),
    presetOutcome: preset,
    request: b,
    ...(card ? { method: (card.brand === 'mada' ? 'mada' : 'card') as PaymentMethod } : {}),
    providerData: { tranType: type, methods, returnUsingGet: b.return_using_get === true || b.return_using_get === 'true', framed: !!b.framed, merchantId: 10000 + (Number(c.inst.config.profileId ?? 0) % 90000), ...(card ? { paylibCard: card } : {}) },
    idempotencyKey: null,
    lint,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  c.resolved.endpoint = `payment request (${type})`;
  const out: Json = {
    tran_ref: ref,
    tran_type: type === 'auth' ? 'Auth' : 'Sale',
    cart_id: p.reference ?? '',
    cart_description: String(b.cart_description),
    cart_currency: currency,
    cart_amount: toDecimal(p.amount, currency),
    tran_currency: currency,
    tran_total: toDecimal(p.amount, currency),
    callback: p.callbackUrl ?? undefined,
    return: p.returnUrl ?? undefined,
    redirect_url: c.svc.entryUrl(c.project, c.inst, p),
    customer_details: customer,
    serviceId: 2,
    profileId: Number(b.profile_id),
    merchantId: Number(p.providerData.merchantId),
    trace: trace(),
  };
  return card ? tokenSale(c, b, out, ref) : out;
}

async function followUp(c: GatewayCtx, b: Json, type: string): Promise<unknown> {
  const ref = asString(b.tran_ref);
  if (!ref) throw new PtError(400, 4, 'tran_ref is required for follow-up transactions');
  const p0 = c.svc.repo.byInstanceRef(c.inst.id, ref);
  if (!p0) throw new PtError(400, 4, 'Transaction not found');
  c.resolved.payment = p0.id;
  c.resolved.endpoint = `payment request (${type})`;
  let p = await c.svc.touch(p0);
  const currency = (asString(b.cart_currency) ?? p.currency).toUpperCase();
  if (currency !== p.currency) throw new PtError(400, 4, 'Currency mismatch with the original transaction');
  const amt = b.cart_amount === undefined ? { minor: p.amount - p.refunded, ok: true, digits: 0 } : fromDecimal(b.cart_amount, currency);
  if (!amt.ok) throw new PtError(400, 4, 'Invalid cart_amount');
  const newRef = tranRef();
  const now = new Date().toISOString();
  let ok = true;
  let message = 'Authorised';
  try {
    if (type === 'refund') {
      if (p.status !== 'paid' && p.status !== 'partially_refunded') throw new HttpError(409, `Transaction is ${p.status}; only captured sales can be refunded`);
      p = (await c.svc.refund(p, amt.minor, { providerRef: newRef, reason: asString(b.cart_description) })).payment;
    } else if (type === 'capture') {
      if (p.providerData.tranType !== 'auth') throw new HttpError(409, 'Only Auth transactions can be captured');
      if (amt.minor !== p.amount) throw new HttpError(400, 'stubyard only simulates full captures (cart_amount must equal the authorised amount)');
      const r = await c.svc.capture(p, { idempotencyKey: newRef });
      p = r.payment;
      if (r.error) {
        ok = false;
        message = r.error === 'already_captured' ? 'Transaction already captured' : r.error === 'not_approved' ? 'Transaction is not authorised' : 'Declined';
      }
    } else {
      if (p.providerData.tranType !== 'auth' || p.status !== 'authorized' || p.providerData.captured) throw new HttpError(409, 'Only uncaptured Auth transactions can be voided');
      p = await c.svc.voidPayment(p);
    }
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    ok = false;
    message = e.message;
  }
  c.svc.repo.addEvent(p, `paytabs_${type}`, { tranRef: newRef, ok, message });
  return {
    tran_ref: newRef,
    previous_tran_ref: p.providerRef,
    tran_type: type[0]!.toUpperCase() + type.slice(1),
    cart_id: asString(b.cart_id) ?? p.reference ?? '',
    cart_description: asString(b.cart_description) ?? '',
    cart_currency: currency,
    cart_amount: toDecimal(amt.minor, currency),
    tran_currency: currency,
    tran_total: toDecimal(amt.minor, currency),
    payment_result: ok
      ? { response_status: 'A', response_code: `G${digits(5)}`, response_message: 'Authorised', transaction_time: now }
      : { response_status: 'E', response_code: '4', response_message: message, transaction_time: now },
    payment_info: paymentInfo(p),
    serviceId: 2,
    profileId: Number(c.inst.config.profileId ?? 0),
    merchantId: Number(p.providerData.merchantId ?? 0),
    trace: trace(),
  };
}

async function query(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'payment query';
  const ref = asString(b.tran_ref);
  const cart = asString(b.cart_id);
  if (ref) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, ref);
    if (!p) throw new PtError(400, 4, 'Transaction not found');
    c.resolved.payment = p.id;
    return transaction(c.svc, await c.svc.touch(p), c.inst);
  }
  if (cart) {
    const list = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, reference: cart, limit: 50 });
    return Promise.all(list.map(async (p) => transaction(c.svc, await c.svc.touch(p), c.inst)));
  }
  throw new PtError(400, 4, 'tran_ref or cart_id is required');
}

// ---------------- Managed form (paylib.js) ----------------

type PaylibToken = { brand: string; last4: string; firstSix: string; magicId: string | null; expMonth: number; expYear: number };
/** payment_token values per instance (single use, 30 min). */
const paylibTokens = new Map<string, ExpiringStore<PaylibToken>>();
const paylibTokensOf = (inst: PaymentInstance) => {
  let m = paylibTokens.get(inst.id);
  if (!m) paylibTokens.set(inst.id, (m = new ExpiringStore<PaylibToken>(30 * 60_000)));
  return m;
};

function clientKeyOk(c: GatewayCtx, key: unknown): boolean {
  const k = typeof key === 'string' ? key : '';
  if (c.inst.config.strictKeys || c.inst.config.clientKey) return k === c.inst.config.clientKey;
  return /^C[A-Z0-9]{9}-[A-Z0-9]{10}-[A-Z0-9]{10}$/.test(k);
}

/** POST /payment/request with payment_token (managed form): 3-D Secure → redirect_url; else the result at once. */
async function tokenSale(c: GatewayCtx, b: Json, out: Json, ref: string): Promise<unknown> {
  const p0 = c.svc.repo.byInstanceRef(c.inst.id, ref)!;
  const tok = p0.providerData.paylibCard as PaylibToken;
  const threeDs = tok.magicId === '3ds';
  const apiCard = { brand: tok.brand, last4: tok.last4, magicId: threeDs ? null : tok.magicId, luhnValid: true, testCard: true };
  const cv = (p0.providerData.checkoutView as Json | undefined) ?? {};
  let p = c.svc.repo.update(p0.id, { cardBrand: tok.brand, cardLast4: tok.last4, providerData: { ...p0.providerData, apiCard, checkoutView: { ...cv, ui: 'realistic' } } });
  c.resolved.endpoint = 'payment request (' + String(b.tran_type).toLowerCase() + ', payment_token' + (threeDs ? ', 3DS' : '') + ')';
  if (threeDs) return out;
  const r = await c.svc.complete(p, { via: 'api', method: p.method ?? 'card', card: apiCard });
  p = c.svc.repo.get(r.payment.id)!;
  return transaction(c.svc, p, c.inst);
}

/** paylib.js and its token endpoint (CORS: the shop's page calls it). */
async function paylibRoute(c: GatewayCtx, m: string, path: string): Promise<unknown> {
  if (/^\/payment\/js\/paylib(?:\.min)?\.js$/.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'paylib.js';
    return c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').header('cross-origin-resource-policy', 'cross-origin').header('access-control-allow-origin', '*').send(paylibJs({ base: c.base, version: PAYLIB_VERSION }));
  }
  if ((path === '/demo' || path === '/demo/result') && (m === 'GET' || m === 'HEAD')) {
    return paylibDemo(c, path.slice(5), (ref) => {
      const p = c.svc.repo.byInstanceRef(c.inst.id, ref);
      return p ? result(p).response_message : null;
    });
  }
  if (path === '/demo/result' && m === 'POST') {
    // The signed return of a 3-D Secure payment: show it as a query.
    const b = bodyOf(c.req);
    const q = new URLSearchParams();
    for (const k of ['tranRef', 'respStatus', 'respCode', 'respMessage', 'cartId']) if (typeof b[k] === 'string') q.set(k, String(b[k]));
    return c.reply.redirect(requestBase(c) + '/demo/result?' + q.toString(), 303);
  }
  if (path === '/demo/pay' && m === 'POST') {
    // The demo shop's server: POST /payment/request with the payment_token paylib added to the form.
    const b = bodyOf(c.req);
    const base = requestBase(c);
    const out = (await request(c, { profile_id: String(c.inst.config.profileId ?? ''), tran_type: 'sale', tran_class: 'ecom', cart_id: 'demo-' + digits(6), cart_currency: 'SAR', cart_amount: 10, cart_description: 'stubyard demo order', payment_token: b.payment_token, return: base + '/demo/result', paypage_lang: b.lang === 'ar' ? 'ar' : 'en', customer_details: { name: 'Demo Buyer', email: 'demo@example.com', country: 'SA' } })) as Json;
    c.resolved.endpoint = 'demo pay';
    if (typeof out.redirect_url === 'string') return c.reply.redirect(out.redirect_url, 303);
    const r = (out.payment_result ?? {}) as Json;
    return c.reply.redirect(base + '/demo/result?' + new URLSearchParams({ tranRef: String(out.tran_ref ?? ''), respStatus: String(r.response_status ?? ''), respMessage: String(r.response_message ?? '') }).toString(), 303);
  }
  if (path === '/payment/js/token' || path === '/payment/js/card-warning') {
    sdkCors(c);
    if (m === 'OPTIONS') return c.reply.status(204).send();
    if (m !== 'POST') return undefined;
    const origin = header(c.req, 'origin');
    if (origin) {
      const chk = checkSdkOrigin(c, origin, 'PayTabs paylib.js (' + c.inst.slug + ')');
      if (!chk.ok && chk.reason === 'refused') return c.reply.status(403).send({ code: 'origin_refused', message: 'This page origin may not use the stubyard PayTabs simulator: add it to sdkOrigins or the project app origins' });
    }
    if (path === '/payment/js/card-warning') {
      c.resolved.endpoint = 'paylib card warning';
      c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking card number was typed into a paylib.js form on ' + c.inst.slug + ' (cleared in the page, never sent)'));
      return c.reply.status(204).send();
    }
    c.resolved.endpoint = 'paylib token';
    const b = bodyOf(c.req);
    if (!clientKeyOk(c, b.key)) return c.reply.status(401).send({ code: 'client_key', message: 'Invalid client key (the instance client key, C…)' });
    const f = (b.card && typeof b.card === 'object' ? b.card : {}) as Json;
    const brand = String(f.brand ?? 'unknown').toLowerCase().slice(0, 20);
    if (f.test !== true) {
      if (f.luhn === true) c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking ' + brand + ' card reached paylib.js on ' + c.inst.slug + ' (refused, not stored)'));
      return c.reply.status(400).send({ code: 'card_number', message: 'Use a test card: stubyard does not accept real card numbers' });
    }
    const last4 = String(f.last4 ?? '').replace(/\D/g, '').slice(-4);
    const firstSix = String(b.first_six ?? '').replace(/\D/g, '').slice(0, 6);
    const expMonth = Number(b.exp_month);
    const expYear = Number(b.exp_year);
    if (last4.length !== 4 || firstSix.length !== 6 || !(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000)) return c.reply.status(400).send({ code: 'card_invalid', message: 'Invalid card details' });
    const token = '2C4' + randomHex(29).toUpperCase();
    paylibTokensOf(c.inst).set(token, { brand, last4, firstSix, magicId: asString(f.magicId)?.slice(0, 40) ?? null, expMonth, expYear });
    return { token };
  }
  return undefined;
}

const randomHex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const entry = /^\/payment\/page\/([^/]+)$/.exec(path);
  if (entry && (req.method === 'GET' || req.method === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeURIComponent(entry[1]!));
    if (!p) throw new HttpError(404, 'Unknown payment page');
    c.resolved.endpoint = 'payment page';
    c.resolved.payment = p.id;
    return c.reply.redirect(`../../page/${p.id}`, 302);
  }
  const sdk = await paylibRoute(c, req.method, path);
  if (sdk !== undefined) return sdk;
  if (req.method !== 'POST' || !['/payment/request', '/payment/query'].includes(path)) {
    throw new PtError(404, 4, `${req.method} ${path} is not simulated by stubyard (POST /payment/request, POST /payment/query)`);
  }
  auth(c);
  const b = bodyOf(req);
  profileCheck(c, b);
  return path === '/payment/request' ? request(c, b) : query(c, b);
}

/** Return fields (posted or sent as a GET query to "return"). */
function returnFields(p: Payment, inst: PaymentInstance): Record<string, string> {
  const r = result(p);
  const fields: Record<string, string> = {
    acquirerMessage: '',
    acquirerRRN: String(p.providerData.rrn ?? ''),
    cartId: p.reference ?? '',
    customerEmail: p.customerEmail ?? String((p.request.customer_details as Json | undefined)?.email ?? ''),
    respCode: r.response_code,
    respMessage: r.response_message,
    respStatus: r.response_status,
    token: '',
    tranRef: p.providerRef,
  };
  fields.signature = paytabsReturnSignature(fields, inst.config.serverKey ?? '');
  return fields;
}

export const paytabsGateway: Gateway = {
  preset: 'paytabs',
  name: 'PayTabs',
  description: 'PT2 Hosted Payment Page: sale / auth, refund / capture / void, query, signed return and callback; cards, mada, STC Pay, Apple Pay.',
  available: true,
  note: 'Shapes follow the PayTabs PHP SDK and support docs. PayTabs publishes no mada test card: pick "mada" on the stubyard page.',
  kind: 'hpp',
  methods: ['card', 'mada', 'stcpay', 'applepay'],
  fields: [
    { key: 'profileId', label: 'Profile ID', hint: 'Numeric profile id; requests must send the same profile_id' },
    { key: 'serverKey', label: 'Server key', secret: true, hint: 'authorization header; signs the return and the callback' },
    { key: 'clientKey', label: 'Client key', hint: 'C…: paylib.inlineForm({ key }) (managed form)' },
    { key: 'webhookUrl', label: 'Default callback (IPN) URL', hint: 'Used when a request has no "callback"' },
  ],
  defaults: () => ({ profileId: String(100000 + Number(digits(5))), serverKey: `S${digits(9)}-${digits(10)}-${digits(10)}`.replace(/^S(\d)/, 'SJ'), clientKey: `C${digits(9)}-${digits(10)}-${digits(10)}`.replace(/^C(\d)/, 'CK'), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => p.providerData.tranType !== 'auth',
  retryOnDecline: false,
  entryPath: (p) => `/payment/page/${p.providerRef}`,
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof PtError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ code: e.code, message: e.message, trace: trace() });
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        return c.reply.status(e.statusCode).send({ code: 4, message: e.message, trace: trace() });
      }
      throw e;
    }
  },
  returnTo: (_svc, p, inst) => {
    const ret = httpUrl(p.returnUrl);
    if (!ret) return null;
    // Stamp a response code / RRN once, so the return, the callback and queries agree.
    const fields = returnFields(p, inst);
    if (p.providerData.returnUsingGet) {
      const u = new URL(ret);
      for (const [k, v] of Object.entries(fields)) u.searchParams.set(k, v);
      return { kind: 'redirect', url: u.toString() };
    }
    return { kind: 'post', url: ret, fields };
  },
  events: (_p, point) => (['paid', 'approved', 'failed', 'cancelled', 'pending', 'settled'].includes(point) ? ['callback'] : []),
  buildEvent: (svc, p, inst) => {
    if (!p.providerData.respCode && statusLetter(p) === 'A') {
      p = svc.repo.update(p.id, { providerData: { ...p.providerData, respCode: `G${digits(5)}`, rrn: digits(12), tranTime: new Date().toISOString() } });
    }
    const body = JSON.stringify({ ...transaction(svc, p, inst), ipn_trace: `IPNS${digits(4)}.${Date.now().toString(16).toUpperCase()}`, profile_id: Number(inst.config.profileId ?? 0), merchant_id: Number(p.providerData.merchantId ?? 0) });
    return { url: p.callbackUrl ?? inst.config.webhookUrl ?? null, body, eventId: `${p.providerRef}:${statusLetter(p)}`, signing: inst.config.serverKey ? { preset: 'paytabs', secret: inst.config.serverKey } : null };
  },
  shape: (svc, p, inst) => transaction(svc, p, inst),
  providerStatus: (p) => {
    const r = result(p);
    return `${r.response_status} (${r.response_message})`;
  },
  connect: (inst, urls) => ({
    env: { PAYTABS_PROFILE_ID: inst.config.profileId ?? '', PAYTABS_SERVER_KEY: inst.config.serverKey ?? '', PAYTABS_BASE_URL: urls.backend, PAYTABS_BASE_URL_LOCAL: urls.backendLocal, PAYTABS_CLIENT_KEY: String(inst.config.clientKey ?? ''), PAYTABS_PAYLIB_URL: urls.browser + '/payment/js/paylib.js' },
    notes: [
      'Use PAYTABS_BASE_URL instead of https://secure.paytabs.sa (or your regional host): POST {base}/payment/request and {base}/payment/query with header "authorization: <server key>".',
      'The browser return is a form POST (or GET with return_using_get: true) signed like PayTabs: verify it with the server key. The callback carries the "Signature" header (HMAC-SHA256 of the raw body).',
      'mada, STC Pay and Apple Pay are chosen on the stubyard page; STC Pay sends its code to the SMS inbox.',
      'Managed form: load PAYTABS_PAYLIB_URL instead of https://secure.paytabs.sa/payment/js/paylib.js, give the card inputs data-paylib="number|expmonth|expyear|cvv" and no name, and call paylib.inlineForm({ key: PAYTABS_CLIENT_KEY, form, autoSubmit: true, callback }). Your server sends the posted payment_token in POST /payment/request (tran_class ecom): redirect_url for 3-D Secure, else payment_result. Unlike the real paylib, stubyard gets only the card facts (never the digits). Try it: {browser base}/demo.',
    ],
  }),
};
