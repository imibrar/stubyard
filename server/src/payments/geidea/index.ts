import { createHmac, randomUUID } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { asString, bodyOf, decodeRef, digits, header, safeEqual } from '../common.js';
import { currencyDigits, fromDecimal, normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';

/**
 * Fake Geidea checkout v2 under /pay/<project>/<instance>/…: create session (signed), the hosted page
 * /hpp/checkout/?<sessionId> and a geideaCheckout.min.js shim (redirect mode), the order API (fetch, capture, void,
 * cancel, refund) and the signed callback to the session's callbackUrl. Auth: Basic merchantPublicKey:apiPassword.
 */

class GdError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detailed: string,
    message: string,
    public detailedMessage: string,
  ) {
    super(message);
  }
}
const integration = (detailed: string, msg: string, status = 400) => new GdError(status, '110', detailed, 'HPP Integration error', msg);

const two = (minor: number, currency: string) => (Number(toDecimal(minor, currency))).toFixed(2);
const hmac64 = (key: string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest('base64');
const same = safeEqual;

/** Create-session signature: base64(HMAC-SHA256(apiPassword, merchantPublicKey + amount (2 dp) + currency + merchantReferenceId + timestamp)). */
export function geideaSessionSignature(i: { merchantPublicKey: string; apiPassword: string; amount: number | string; currency: string; merchantReferenceId: string; timestamp: string }): string {
  return hmac64(i.apiPassword, i.merchantPublicKey + Number(i.amount).toFixed(2) + i.currency + i.merchantReferenceId + i.timestamp);
}

/** Callback / return signature: base64(HMAC-SHA256(apiPassword, merchantPublicKey + amount (2 dp) + currency + orderId + status + merchantReferenceId + timeStamp)). */
export function geideaCallbackSignature(i: { merchantPublicKey: string; apiPassword: string; amount: number | string; currency: string; orderId: string; status: string; merchantReferenceId: string; timeStamp: string }): string {
  return hmac64(i.apiPassword, i.merchantPublicKey + Number(i.amount).toFixed(2) + i.currency + i.orderId + i.status + i.merchantReferenceId + i.timeStamp);
}

/** Decline reasons → responseCode / detailed code / message (000, 300, 010 are Geidea's; the decline codes are stubyard's). */
export const GEIDEA_CODES: Record<string, [string, string, string]> = {
  success: ['000', '000', 'Success'],
  generic: ['210', '001', 'Transaction declined - please contact your bank!'],
  insufficient_funds: ['210', '051', 'Transaction declined - insufficient funds'],
  expired_card: ['210', '054', 'Transaction failed - expired card'],
  incorrect_cvc: ['210', '082', 'Transaction declined - invalid CVV'],
  processing_error: ['999', '001', 'Provider connection timed out'],
  authentication_failed: ['300', '001', '3DS authentication failed'],
  otp_failed: ['300', '001', '3DS authentication failed'],
  cancelled: ['010', '001', 'Transaction Cancelled By User.'],
};

function codeOf(p: Payment): [string, string, string] {
  if (p.status === 'failed') return GEIDEA_CODES[String(p.providerData.declineReason ?? 'generic')] ?? GEIDEA_CODES.generic!;
  if (p.status === 'cancelled' && !p.providerData.voided) return GEIDEA_CODES.cancelled!;
  if (p.status === 'expired') return ['010', '002', 'Session expired'];
  return GEIDEA_CODES.success!;
}

const isPreAuth = (p: Payment) => p.providerData.operation === 'PreAuthorize';
/** order.status (Success / Failed / InProgress) and detailedStatus. */
function statusOf(p: Payment): { status: string; detailed: string } {
  switch (p.status) {
    case 'paid':
      return { status: 'Success', detailed: p.providerData.captured ? 'Captured' : 'Paid' };
    case 'partially_refunded':
      return { status: 'Success', detailed: 'PartiallyRefunded' };
    case 'refunded':
      return { status: 'Success', detailed: 'Refunded' };
    case 'authorized':
      return p.providerData.async ? { status: 'InProgress', detailed: 'Pending' } : { status: 'Success', detailed: 'Authorized' };
    case 'failed':
      return { status: 'Failed', detailed: 'OrderFailed' };
    case 'cancelled':
      return { status: p.providerData.voided ? 'Success' : 'Failed', detailed: p.providerData.voided ? 'Voided' : 'Cancelled' };
    case 'expired':
      return { status: 'Failed', detailed: 'Expired' };
    default:
      return { status: 'InProgress', detailed: 'Initiated' };
  }
}

function stamp(svc: PaymentService, p0: Payment): Payment {
  const cur = svc.repo.get(p0.id) ?? p0;
  const keep = (d: Json) => ({ ...p0, providerData: { ...p0.providerData, ...d } });
  if (cur.providerData.rrn || p0.status === 'created') return keep(cur.providerData);
  return keep(svc.repo.update(cur.id, { providerData: { ...cur.providerData, rrn: digits(12), authCode: digits(6), txId: randomUUID() } }).providerData);
}

function orderOf(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const s = statusOf(p);
  const d = p.providerData;
  const txs: Json[] = [];
  const at = p.updatedAt;
  const money = (minor: number) => Number(toDecimal(minor, p.currency));
  if (d.rrn) {
    const ok = p.status !== 'failed';
    const [code, detailed, msg] = codeOf(p);
    txs.push({ transactionId: String(d.txId), type: isPreAuth(p) ? 'Authorization' : 'Pay', status: ok ? 'Success' : 'Failed', amount: money(p.amount), currency: p.currency, createdDate: at, rrn: String(d.rrn), authorizationCode: ok ? String(d.authCode) : null, responseCode: code, detailedResponseCode: detailed, responseMessage: msg });
    if (d.captured) txs.push({ transactionId: String(d.captureTxId ?? d.txId), type: 'Capture', status: 'Success', amount: money(Number(d.capturedAmount ?? p.amount)), currency: p.currency, createdDate: at, parentTransactionId: String(d.txId) });
    if (d.voided) txs.push({ transactionId: String(d.voidTxId ?? d.txId), type: 'Void', status: 'Success', amount: money(p.amount), currency: p.currency, createdDate: at, parentTransactionId: String(d.txId) });
    for (const r of svc.repo.refunds(p.id)) txs.push({ transactionId: r.providerRef, type: 'Refund', status: 'Success', amount: money(r.amount), currency: p.currency, createdDate: r.createdAt, rrn: digits(12), parentTransactionId: String(d.txId) });
  }
  const card = p.method === 'card' || p.method === 'mada' || p.method === 'applepay';
  return {
    orderId: p.providerRef,
    merchantId: String(inst.config.merchantId ?? ''),
    merchantPublicKey: String(inst.config.merchantPublicKey ?? ''),
    merchantReferenceId: p.reference ?? '',
    amount: money(p.amount),
    currency: p.currency,
    status: s.status,
    detailedStatus: s.detailed,
    totalAuthorizedAmount: d.rrn && p.status !== 'failed' ? money(p.amount) : 0,
    totalCapturedAmount: ['paid', 'partially_refunded', 'refunded'].includes(p.status) ? money(Number(d.capturedAmount ?? p.amount)) : 0,
    totalRefundedAmount: money(p.refunded),
    callbackUrl: p.callbackUrl,
    returnUrl: p.returnUrl,
    language: String(p.request.language ?? 'en'),
    createdDate: p.createdAt,
    updatedDate: p.updatedAt,
    isTest: true,
    paymentOperation: String(d.operation ?? 'Pay'),
    paymentMethod: card ? { type: 'Card', brand: p.method === 'mada' ? 'mada' : p.cardBrand ?? 'visa', cardholderName: 'test', maskedCardNumber: (p.method === 'mada' ? '446404' : '512345') + '******' + (p.cardLast4 ?? '0008'), wallet: p.method === 'applepay' ? 'ApplePay' : null } : null,
    customer: (p.request.customer as Json | undefined) ?? null,
    transactions: txs,
  };
}

const success = (extra: Json) => ({ ...extra, responseCode: '000', responseMessage: 'Success', detailedResponseCode: '000', detailedResponseMessage: 'The operation was successful', language: 'en' });

function auth(c: GatewayCtx): void {
  const h = header(c.req, 'authorization') ?? '';
  const m = /^Basic\s+(\S+)$/i.exec(h);
  const [user, pass] = m ? Buffer.from(m[1]!, 'base64').toString('utf8').split(':') : [];
  if (!user || !pass) throw new GdError(401, '401', '001', 'Unauthorized', 'Basic authentication with merchantPublicKey:apiPassword is required');
  if (user !== c.inst.config.merchantPublicKey || pass !== c.inst.config.apiPassword) throw new GdError(401, '401', '002', 'Unauthorized', 'Invalid merchant public key or API password');
}

function presetOutcome(c: GatewayCtx): string | null {
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (!forced) return null;
  try {
    return normalizeOutcome(forced);
  } catch (e) {
    throw new HttpError(400, 'X-Hub-Payment-Outcome: ' + (e as Error).message);
  }
}

function lintCreate(b: Json, amount: number): LintFinding[] {
  const out: LintFinding[] = [];
  if (amount <= 0) out.push(finding('pay.amount-zero', 'amount is ' + String(b.amount)));
  const cb = asString(b.callbackUrl);
  if (cb && !/^https:/i.test(cb)) out.push(finding('pay.geidea-callback-not-https', 'callbackUrl ' + cb + ' is not HTTPS: Geidea only calls HTTPS callback URLs'));
  if (b.returnUrl !== undefined && badUrl(b.returnUrl)) out.push(finding('pay.return-url-missing-or-bad', 'returnUrl ' + badUrl(b.returnUrl)));
  if (!asString(b.merchantReferenceId)) out.push(finding('pay.no-reference', 'No merchantReferenceId'));
  return out;
}

async function createSession(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'create session';
  const currency = (asString(b.currency) ?? '').toUpperCase();
  if (!currency || currencyDigits(currency) === null) {
    if (currency) c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', 'Unknown currency "' + currency + '"'));
    throw integration('004', 'Invalid currency');
  }
  const amt = fromDecimal(b.amount, currency);
  if (b.amount === undefined || !amt.ok || amt.minor <= 0) throw integration('003', 'Invalid amount');
  if (amt.digits > 2) c.svc.addInstanceLint(c.inst, finding('pay.amount-precision', 'amount ' + String(b.amount) + ' has more than 2 decimals'));
  const ref = asString(b.merchantReferenceId) ?? '';
  const ts = asString(b.timestamp) ?? '';
  const sig = asString(b.signature);
  if (!sig) throw integration('010', 'signature is required');
  const want = geideaSessionSignature({ merchantPublicKey: String(c.inst.config.merchantPublicKey), apiPassword: String(c.inst.config.apiPassword), amount: Number(b.amount), currency, merchantReferenceId: ref, timestamp: ts });
  if (!same(sig, want)) {
    c.svc.addInstanceLint(c.inst, finding('pay.geidea-signature', 'create session: signature mismatch (base64 HMAC-SHA256 with the API password over merchantPublicKey + amount (2 dp) + currency + merchantReferenceId + timestamp)'));
    throw integration('011', 'Invalid signature');
  }
  const op = asString(b.paymentOperation) ?? 'Pay';
  if (!['Pay', 'PreAuthorize', 'AuthorizeCapture'].includes(op)) throw integration('012', 'Invalid paymentOperation (Pay, PreAuthorize, AuthorizeCapture)');
  for (const k of ['callbackUrl', 'returnUrl']) if (b[k] !== undefined && b[k] !== null && b[k] !== '' && badUrl(b[k])) throw integration('013', 'Invalid ' + k);
  const sessionId = randomUUID();
  const customer = (b.customer as Json | undefined) ?? {};
  const methods: PaymentMethod[] = op === 'PreAuthorize' ? ['card', 'applepay'] : ['card', 'mada', 'applepay'];
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: randomUUID(),
    secondaryRef: sessionId,
    amount: amt.minor,
    currency,
    reference: ref || null,
    customerEmail: asString(customer.email),
    returnUrl: asString(b.returnUrl),
    cancelUrl: null,
    callbackUrl: asString(b.callbackUrl),
    presetOutcome: presetOutcome(c),
    request: b,
    providerData: { operation: op, sessionId, methods },
    idempotencyKey: null,
    lint: lintCreate(b, amt.minor),
    expiresAt: expires,
  });
  c.resolved.payment = p.id;
  return success({
    session: {
      id: sessionId,
      amount: Number(two(p.amount, currency)),
      currency,
      callbackUrl: p.callbackUrl,
      returnUrl: p.returnUrl,
      expiryDate: expires,
      status: 'Initiated',
      merchantId: String(c.inst.config.merchantId ?? ''),
      merchantPublicKey: String(c.inst.config.merchantPublicKey),
      merchantReferenceId: ref,
      paymentOperation: op,
      language: asString(b.language) ?? 'en',
      customer,
      orderId: p.providerRef,
      createdDate: p.createdAt,
    },
  });
}

function findOrder(c: GatewayCtx, id: string | null): Payment {
  const p = id ? c.svc.repo.byInstanceRef(c.inst.id, id) : null;
  if (!p || p.providerRef !== id) throw new GdError(404, '404', '001', 'Not found', 'Order ' + String(id) + ' was not found');
  c.resolved.payment = p.id;
  return p;
}

async function capture(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'capture';
  const p0 = await c.svc.touch(findOrder(c, asString(b.orderId)));
  if (!isPreAuth(p0)) throw integration('020', 'Only PreAuthorize orders can be captured');
  const amt = b.captureAmount === undefined || b.captureAmount === null ? null : fromDecimal(b.captureAmount, p0.currency);
  if (amt && (!amt.ok || amt.minor <= 0)) throw integration('003', 'Invalid captureAmount');
  const r = await c.svc.capture(p0, { idempotencyKey: p0.providerRef + ':capture', amount: amt?.minor ?? null, final: true });
  if (r.error) throw integration(r.error === 'already_captured' ? '021' : r.error === 'amount_exceeds' ? '022' : '023', r.error === 'already_captured' ? 'Order is already captured' : r.error === 'amount_exceeds' ? 'captureAmount exceeds the authorized amount' : r.error === 'declined' ? 'Capture declined' : 'Order is not authorized');
  const p = c.svc.repo.update(r.payment.id, { providerData: { ...r.payment.providerData, captureTxId: randomUUID() } });
  return success({ order: orderOf(c.svc, p, c.inst) });
}

async function voidOrder(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'void';
  const p0 = await c.svc.touch(findOrder(c, asString(b.orderId)));
  if (p0.status !== 'authorized' || p0.providerData.captured || !isPreAuth(p0)) throw integration('024', 'Only authorized, uncaptured orders can be voided');
  let p = await c.svc.voidPayment(p0, { webhook: true });
  p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, voidTxId: randomUUID() } });
  return success({ order: orderOf(c.svc, p, c.inst) });
}

async function cancelOrder(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'cancel';
  const p0 = await c.svc.touch(findOrder(c, asString(b.orderId)));
  if (!['created', 'pending', 'requires_action'].includes(p0.status)) throw integration('025', 'Order is already completed');
  const outcome = await c.svc.complete(p0, { via: 'api', outcome: 'cancel', method: p0.method ?? 'card' });
  return { orderId: outcome.payment.providerRef, responseMessage: 'Cancelled', detailedResponseMessage: 'Order cancelled by user', language: 'en', responseCode: '010', detailedResponseCode: '001' };
}

/** Refund signature (v2): accepted over timestamp + publicKey + refundAmount + orderId or publicKey + refundAmount + orderId + timestamp. */
export function geideaRefundSignature(i: { merchantPublicKey: string; apiPassword: string; refundAmount: number | string; orderId: string; timestamp: string }): string {
  return hmac64(i.apiPassword, i.timestamp + i.merchantPublicKey + Number(i.refundAmount).toFixed(2) + i.orderId);
}

async function refund(c: GatewayCtx, b: Json, v2: boolean): Promise<unknown> {
  c.resolved.endpoint = 'refund';
  const p0 = await c.svc.touch(findOrder(c, asString(b.orderId)));
  const amt = b.refundAmount === undefined || b.refundAmount === null ? null : fromDecimal(b.refundAmount, p0.currency);
  if (v2 && !amt) throw integration('003', 'refundAmount is required');
  if (amt && (!amt.ok || amt.minor <= 0)) throw integration('003', 'Invalid refundAmount');
  if (v2) {
    const sig = asString(b.signature) ?? '';
    const ts = asString(b.timestamp) ?? '';
    const pk = String(c.inst.config.merchantPublicKey);
    const pw = String(c.inst.config.apiPassword);
    const a = Number(b.refundAmount).toFixed(2);
    const ok = [geideaRefundSignature({ merchantPublicKey: pk, apiPassword: pw, refundAmount: Number(b.refundAmount), orderId: p0.providerRef, timestamp: ts }), hmac64(pw, pk + a + p0.providerRef + ts)].some((w) => same(sig, w));
    if (!ok) {
      c.svc.addInstanceLint(c.inst, finding('pay.geidea-signature', 'refund: signature mismatch (base64 HMAC-SHA256 with the API password over timestamp + merchantPublicKey + refundAmount (2 dp) + orderId)'));
      throw integration('011', 'Invalid signature');
    }
  } else c.resolved.warnings = ['POST /pgw/api/v1/direct/refund is the older path; Geidea documents /pgw/api/v2/direct/refund with a signature'];
  try {
    const r = await c.svc.refund(p0, amt?.minor ?? null, { providerRef: randomUUID(), reason: null });
    return success({ order: orderOf(c.svc, r.payment, c.inst) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw integration(e.statusCode === 409 ? '026' : '027', e.message);
    throw e;
  }
}

function checkoutJs(base: string): string {
  return [
    '/* stubyard shim of geideaCheckout.min.js: redirect mode only (startPayment opens the stubyard hosted page). */',
    '(function () {',
    '  var BASE = ' + JSON.stringify(base) + ';',
    '  function GeideaCheckout(onSuccess, onError, onCancel) {',
    '    this.onSuccess = onSuccess; this.onError = onError; this.onCancel = onCancel;',
    "    this.startPayment = function (sessionId) { window.location.href = BASE + '/hpp/checkout/?' + encodeURIComponent(sessionId); };",
    '  }',
    '  window.GeideaCheckout = GeideaCheckout;',
    '})();',
  ].join('\n');
}

function pagePath(c: GatewayCtx, p: Payment): string {
  return '../'.repeat(Math.max(c.path.split('/').length - 2, 0)) + 'page/' + p.id;
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  let mm: RegExpExecArray | null;
  if (/^\/hpp\/geideaCheckout(\.min)?\.js$/.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'checkout js';
    return c.reply.type('application/javascript; charset=utf-8').header('cache-control', 'no-store').send(checkoutJs(c.base));
  }
  if (/^\/hpp\/checkout\/?$/.test(path) && (m === 'GET' || m === 'HEAD')) {
    c.resolved.endpoint = 'hosted page';
    const raw = (c.req.url.split('?')[1] ?? '').split('&')[0] ?? '';
    const sid = decodeRef(raw.replace(/=.*$/, '')) || asString(c.query.sessionId) || '';
    const p = sid ? c.svc.repo.byInstanceRef(c.inst.id, sid) : null;
    if (!p) throw new GdError(404, '404', '001', 'Not found', 'Unknown session ' + sid);
    c.resolved.payment = p.id;
    return c.reply.redirect(pagePath(c, p), 302);
  }
  auth(c);
  const b = m === 'GET' ? {} : bodyOf(req);
  if (m === 'POST' && path === '/payment-intent/api/v2/direct/session') return createSession(c, b);
  if ((mm = /^\/pgw\/api\/v[12]\/direct\/order\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'fetch order';
    let p = await c.svc.touch(findOrder(c, decodeRef(mm[1]!)));
    p = stamp(c.svc, p);
    c.svc.repo.addEvent(p, 'status_queried', { via: 'order' });
    return success({ order: orderOf(c.svc, p, c.inst) });
  }
  if (m === 'POST' && /^\/pgw\/api\/v[12]\/direct\/capture$/.test(path)) return capture(c, b);
  if (m === 'POST' && /^\/pgw\/api\/v3\/direct\/void$/.test(path)) return voidOrder(c, b);
  if (m === 'POST' && path === '/pgw/api/v1/direct/cancel') return cancelOrder(c, b);
  if (m === 'POST' && path === '/pgw/api/v2/direct/refund') return refund(c, b, true);
  if (m === 'POST' && path === '/pgw/api/v1/direct/refund') return refund(c, b, false);
  throw new GdError(404, '404', '001', 'Not found', m + ' ' + path + ' is not simulated by stubyard (payment-intent/api/v2/direct/session, pgw/api/v1/direct/order/{id}, capture, v3 void, cancel, v2 refund)');
}

function signedResult(p: Payment, inst: PaymentInstance, timeStamp: string): string {
  return geideaCallbackSignature({ merchantPublicKey: String(inst.config.merchantPublicKey ?? ''), apiPassword: String(inst.config.apiPassword ?? ''), amount: toDecimal(p.amount, p.currency), currency: p.currency, orderId: p.providerRef, status: statusOf(p).status, merchantReferenceId: p.reference ?? '', timeStamp });
}

export const geideaGateway: Gateway = {
  preset: 'geidea',
  name: 'Geidea',
  description: 'Checkout v2: signed create session, hosted page (redirect + geideaCheckout.min.js shim), order fetch / capture / void / cancel / refund, signed callback; cards, mada, Apple Pay.',
  available: true,
  note: 'The drop-in and modal UI modes of Checkout JS are shown as a redirect to the stubyard page.',
  kind: 'hpp',
  methods: ['card', 'mada', 'applepay'],
  logo: 'GD',
  slugBase: 'geidea',
  webhookToCallbackUrl: true,
  fields: [
    { key: 'merchantPublicKey', label: 'Merchant public key', hint: 'Basic auth user; part of every signature' },
    { key: 'apiPassword', label: 'API password', secret: true, hint: 'Basic auth password; HMAC key of the signatures' },
    { key: 'webhookUrl', label: 'Default callback URL', hint: 'Used when a session has no callbackUrl' },
  ],
  defaults: () => ({ merchantPublicKey: randomUUID(), apiPassword: randomUUID(), merchantId: randomUUID(), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => !isPreAuth(p),
  retryOnDecline: false,
  entryPath: (p) => '/hpp/checkout/?' + String(p.secondaryRef ?? ''),
  refundRef: () => randomUUID(),
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof GdError) {
        c.resolved.error = e.detailedMessage;
        return c.reply.status(e.status).send({ responseCode: e.code, responseMessage: e.message, detailedResponseCode: e.detailed, detailedResponseMessage: e.detailedMessage, language: 'en' });
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        c.resolved.error = e.message;
        return c.reply.status(e.statusCode).send({ responseCode: '110', responseMessage: 'HPP Integration error', detailedResponseCode: '000', detailedResponseMessage: e.message, language: 'en' });
      }
      throw e;
    }
  },
  returnTo: (svc, p0, inst) => {
    const ret = httpUrl(p0.returnUrl);
    if (!ret) return null;
    const p = stamp(svc, p0);
    const [code, detailed, msg] = codeOf(p);
    const ts = new Date().toISOString();
    const u = new URL(ret);
    const q: Record<string, string> = { responseCode: code, responseMessage: msg, detailedResponseCode: detailed, detailedResponseMessage: code === '000' ? 'The operation was successful' : msg, orderId: p.providerRef, reference: String(p.providerData.txId ?? ''), sessionId: String(p.secondaryRef ?? ''), merchantReferenceId: p.reference ?? '', timeStamp: ts, signature: signedResult(p, inst, ts) };
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return { kind: 'redirect', url: u.toString() };
  },
  events: (_p, point) => (['paid', 'approved', 'failed', 'cancelled', 'settled', 'refunded'].includes(point) ? ['order.callback'] : []),
  buildEvent: (svc, p0, inst) => {
    const p = stamp(svc, p0);
    const [code, detailed, msg] = codeOf(p);
    const timeStamp = new Date().toISOString();
    const order = orderOf(svc, p, inst);
    const body = { order, responseCode: code, responseMessage: msg, detailedResponseCode: detailed, detailedResponseMessage: code === '000' ? 'The operation was successful' : msg, timeStamp, signature: signedResult(p, inst, timeStamp) };
    return { url: p.callbackUrl ?? inst.config.webhookUrl ?? null, body: JSON.stringify(body), eventId: p.providerRef + ':' + String(order.detailedStatus) + ':' + svc.repo.refunds(p.id).length, signing: null };
  },
  shape: (svc, p, inst) => orderOf(svc, p, inst),
  providerStatus: (p) => {
    const s = statusOf(p);
    return s.status + ' / ' + s.detailed;
  },
  connect: (inst, urls) => ({
    env: {
      GEIDEA_PUBLIC_KEY: String(inst.config.merchantPublicKey ?? ''),
      GEIDEA_API_PASSWORD: String(inst.config.apiPassword ?? ''),
      GEIDEA_BASE_URL: urls.backend,
      GEIDEA_BASE_URL_LOCAL: urls.backendLocal,
      GEIDEA_HPP_URL: urls.browser + '/hpp/checkout/',
      GEIDEA_CHECKOUT_JS: urls.browser + '/hpp/geideaCheckout.min.js',
    },
    notes: [
      'Use GEIDEA_BASE_URL instead of https://api.merchant.geidea.net (Egypt), https://api.ksamerchant.geidea.net (KSA) or https://api.geidea.ae (UAE), with Basic auth merchantPublicKey:apiPassword.',
      'Open the page with GEIDEA_HPP_URL + "?" + session.id, or load GEIDEA_CHECKOUT_JS and call new GeideaCheckout(onSuccess, onError, onCancel).startPayment(session.id) (stubyard redirects; the callbacks are not called).',
      'The callback (JSON) goes to the session callbackUrl, else the instance URL; verify "signature", then GET /pgw/api/v1/direct/order/{orderId}.',
    ],
    snippets: [
      {
        title: 'Session + callback signatures (Node)',
        lang: 'js',
        code: [
          "const crypto = require('node:crypto');",
          "const sign = (s) => crypto.createHmac('sha256', process.env.GEIDEA_API_PASSWORD).update(s).digest('base64');",
          'const sessionSignature = (amount, currency, ref, timestamp) => sign(process.env.GEIDEA_PUBLIC_KEY + Number(amount).toFixed(2) + currency + ref + timestamp);',
          'const o = body.order;',
          'const ok = sign(process.env.GEIDEA_PUBLIC_KEY + Number(o.amount).toFixed(2) + o.currency + o.orderId + o.status + o.merchantReferenceId + body.timeStamp) === body.signature;',
        ].join('\n'),
      },
      {
        title: 'Session signature (PHP)',
        lang: 'php',
        code: ['$data = $publicKey . number_format($amount, 2, ".", "") . $currency . $merchantReferenceId . $timestamp;', '$signature = base64_encode(hash_hmac("sha256", $data, $apiPassword, true));'].join('\n'),
      },
    ],
  }),
};
