import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { asString, bodyOf, digits, ExpiringStore, header, safeEqual } from '../common.js';
import { currencyDigits, normalizeOutcome } from '../engine.js';
import { finding, httpUrl } from '../lint.js';
import { renderFormPost, renderPayError } from '../pages.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';
import type { Locale } from '../kit/i18n.js';
import { apsMerchantDemo, apsMerchantDemoNext, renderApsMerchantPage } from '../sdk/aps-merchant.js';
import { requestBase } from '../sdk/runtime.js';
import { htmlReply } from '../sdk/wallet.js';

/**
 * Fake Amazon Payment Services (PayFort) under /pay/<project>/<instance>/…: Redirection (form POST to
 * /FortAPI/paymentPage → stubyard page → signed form POST to return_url), the JSON maintenance API /FortAPI/paymentApi
 * (CAPTURE, VOID_AUTHORIZATION, REFUND, query_command CHECK_STATUS) and the transaction feedback (form POST, or JSON,
 * of the signed response parameters to the instance feedback URL). Every request and response carries "signature".
 */

export type ApsShaType = 'SHA-256' | 'SHA-512' | 'HMAC-256' | 'HMAC-512';

class ApsError extends Error {
  constructor(
    public statusCode2: string,
    public message3: string,
    message: string,
  ) {
    super(message);
  }
  get responseCode() {
    return this.statusCode2 + this.message3;
  }
}

/** The signature string: params sorted by name, "name=value" joined without separator, wrapped in the phrase. */
export function apsSignatureString(params: Record<string, unknown>, phrase: string, opts: { includeEmpty?: boolean } = {}): string {
  const body = Object.keys(params)
    .filter((k) => k !== 'signature' && params[k] !== undefined && params[k] !== null && (opts.includeEmpty || String(params[k]) !== ''))
    .sort()
    .map((k) => k + '=' + (typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k])))
    .join('');
  return phrase + body + phrase;
}

/** signature = hex(SHA-256 / SHA-512 of the wrapped string), or hex(HMAC with the phrase as key over the wrapped string). */
export function apsSignature(params: Record<string, unknown>, phrase: string, shaType: ApsShaType = 'SHA-256', opts: { includeEmpty?: boolean } = {}): string {
  const s = apsSignatureString(params, phrase, opts);
  if (shaType === 'HMAC-256' || shaType === 'HMAC-512') return createHmac(shaType === 'HMAC-256' ? 'sha256' : 'sha512', phrase).update(s, 'utf8').digest('hex');
  return createHash(shaType === 'SHA-512' ? 'sha512' : 'sha256').update(s, 'utf8').digest('hex');
}

/** Case-insensitive check; empty values counted or not, and for HMAC the unwrapped string too (the docs are ambiguous). */
export function apsVerify(params: Record<string, unknown>, phrase: string, shaType: ApsShaType = 'SHA-256'): boolean {
  const got = String(params.signature ?? '').trim().toLowerCase();
  if (!got) return false;
  const tries = [apsSignature(params, phrase, shaType), apsSignature(params, phrase, shaType, { includeEmpty: true })];
  if (shaType.startsWith('HMAC')) {
    const s = apsSignatureString(params, phrase).slice(phrase.length, -phrase.length || undefined);
    tries.push(createHmac(shaType === 'HMAC-256' ? 'sha256' : 'sha512', phrase).update(s, 'utf8').digest('hex'));
  }
  // Every candidate is compared (no early exit), each in constant time.
  return tries.map((t) => safeEqual(t, got)).some(Boolean);
}

const shaTypeOf = (inst: PaymentInstance): ApsShaType => (['SHA-256', 'SHA-512', 'HMAC-256', 'HMAC-512'].includes(String(inst.config.shaType)) ? (inst.config.shaType as ApsShaType) : 'SHA-256');
const signResponse = (inst: PaymentInstance, f: Record<string, string>) => ({ ...f, signature: apsSignature(f, String(inst.config.shaResponsePhrase ?? ''), shaTypeOf(inst)) });

/** Message codes (last 3 digits of response_code) of the decline reasons. */
export const APS_MESSAGES: Record<string, [string, string]> = {
  success: ['000', 'Success'],
  generic: ['666', 'Transaction declined'],
  insufficient_funds: ['029', 'Insufficient funds'],
  expired_card: ['012', 'Card expired'],
  incorrect_cvc: ['016', 'Invalid card number'],
  processing_error: ['666', 'Transaction declined'],
  authentication_failed: ['030', 'Authentication failed'],
  otp_failed: ['030', 'Authentication failed'],
  cancelled: ['072', 'Transaction cancelled by the consumer'],
};

const OPTION_METHODS: Record<string, PaymentMethod[]> = { VISA: ['card'], MASTERCARD: ['card'], AMEX: ['card'], MADA: ['mada'], KNET: ['knet'], APPLE_PAY: ['applepay'] };
const isAuth = (p: Payment) => p.providerData.command === 'AUTHORIZATION';

function paymentOption(p: Payment): string {
  if (p.method === 'mada') return 'MADA';
  if (p.method === 'knet') return 'KNET';
  if (p.method === 'applepay') return 'APPLE_PAY';
  if (p.cardBrand === 'mastercard') return 'MASTERCARD';
  if (p.cardBrand === 'amex') return 'AMEX';
  return p.method ? 'VISA' : String(p.request.payment_option ?? '');
}
const BIN: Record<string, string> = { visa: '400555', mastercard: '512345', amex: '345678', mada: '529741' };
function maskedCard(p: Payment): string {
  if (!p.method || p.method === 'knet') return '';
  const last4 = p.cardLast4 ?? '0001';
  const bin = BIN[p.method === 'mada' ? 'mada' : p.cardBrand ?? 'visa'] ?? '400555';
  return p.cardBrand === 'amex' ? bin + '*****' + last4 : bin + '******' + last4;
}
const expiryYYMM = () => String((new Date().getUTCFullYear() + 3) % 100).padStart(2, '0') + '05';

/** status (2 digits) + message (3 digits) of the page result. */
function resultCodes(p: Payment): { status: string; msg: [string, string] } {
  const auth = isAuth(p);
  switch (p.status) {
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return { status: auth ? '02' : '14', msg: APS_MESSAGES.success! };
    case 'authorized':
      if (p.providerData.async) return { status: '19', msg: ['000', 'Transaction pending'] };
      return { status: auth ? '02' : '14', msg: APS_MESSAGES.success! };
    case 'failed':
      return { status: auth ? '03' : '13', msg: APS_MESSAGES[String(p.providerData.declineReason ?? 'generic')] ?? APS_MESSAGES.generic! };
    case 'cancelled':
      if (p.providerData.voided) return { status: '02', msg: APS_MESSAGES.success! };
      return { status: auth ? '03' : '13', msg: APS_MESSAGES.cancelled! };
    case 'expired':
      return { status: auth ? '03' : '13', msg: ['072', 'Transaction cancelled by the consumer'] };
    default:
      return { status: '20', msg: ['064', '3-D Secure check requested'] };
  }
}

function stamp(svc: PaymentService, p0: Payment): Payment {
  const cur = svc.repo.get(p0.id) ?? p0;
  const keep = (d: Json) => ({ ...p0, providerData: { ...p0.providerData, ...d } });
  if (cur.providerData.authorizationCode || !['paid', 'authorized', 'partially_refunded', 'refunded', 'cancelled'].includes(p0.status)) return keep(cur.providerData);
  return keep(svc.repo.update(cur.id, { providerData: { ...cur.providerData, authorizationCode: digits(6) } }).providerData);
}

/** The redirection response / direct feedback of the page transaction. */
function pageResponse(p: Payment, inst: PaymentInstance): Record<string, string> {
  const req = p.request as Record<string, unknown>;
  const r = resultCodes(p);
  const f: Record<string, string> = {
    command: String(req.command ?? 'PURCHASE'),
    access_code: String(req.access_code ?? inst.config.accessCode ?? ''),
    merchant_identifier: String(req.merchant_identifier ?? inst.config.merchantIdentifier ?? ''),
    merchant_reference: p.reference ?? '',
    amount: String(p.amount),
    currency: p.currency,
    language: String(req.language ?? 'en'),
    customer_email: p.customerEmail ?? '',
    fort_id: p.providerRef,
    payment_option: paymentOption(p),
    eci: String(req.eci ?? 'ECOMMERCE'),
    response_code: r.status + r.msg[0],
    response_message: r.msg[1],
    status: r.status,
  };
  if (p.providerData.authorizationCode && (r.status === '14' || r.status === '02')) f.authorization_code = String(p.providerData.authorizationCode);
  const card = maskedCard(p);
  if (card) {
    f.card_number = card;
    f.expiry_date = expiryYYMM();
  }
  if (req.customer_ip) f.customer_ip = String(req.customer_ip);
  if (req.customer_name) f.customer_name = String(req.customer_name);
  if (req.card_holder_name) f.card_holder_name = String(req.card_holder_name);
  if (req.order_description) f.order_description = String(req.order_description);
  if (req.token_name) f.token_name = String(req.token_name);
  for (const k of ['merchant_extra', 'merchant_extra1', 'merchant_extra2', 'merchant_extra3', 'merchant_extra4', 'merchant_extra5']) if (req[k] !== undefined && req[k] !== '') f[k] = String(req[k]);
  return signResponse(inst, f);
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

function credentials(c: GatewayCtx, b: Json): void {
  if (!asString(b.merchant_identifier)) throw new ApsError('00', '001', 'Missing parameter merchant_identifier');
  if (!asString(b.access_code)) throw new ApsError('00', '001', 'Missing parameter access_code');
  if (String(b.merchant_identifier) !== String(c.inst.config.merchantIdentifier)) throw new ApsError('00', '009', 'Invalid merchant identifier');
  if (String(b.access_code) !== String(c.inst.config.accessCode)) throw new ApsError('00', '010', 'Invalid access code');
  if (!asString(b.signature)) throw new ApsError('00', '001', 'Missing parameter signature');
  if (!apsVerify(b, String(c.inst.config.shaRequestPhrase ?? ''), shaTypeOf(c.inst))) {
    c.svc.addInstanceLint(c.inst, finding('pay.aps-signature', c.path + ': signature mismatch (' + shaTypeOf(c.inst) + ' over the sorted name=value pairs wrapped in the SHA request phrase)'));
    throw new ApsError('00', '008', 'Signature mismatch');
  }
}

function amountOf(c: GatewayCtx, b: Json, currency: string): number {
  const raw = asString(b.amount) ?? '';
  if (!/^\d+$/.test(raw)) {
    if (/^\d*\.\d+$/.test(raw)) c.svc.addInstanceLint(c.inst, finding('pay.aps-amount-unit', 'amount "' + raw + '" has a decimal point: APS amounts are integers in minor units (' + currency + ' × 10^' + (currencyDigits(currency) ?? 2) + ')'));
    throw new ApsError('00', '005', 'Invalid amount');
  }
  const n = Number(raw);
  if (n <= 0) throw new ApsError('00', '005', 'Invalid amount');
  return n;
}

function lintCreate(b: Json, amount: number, currency: string, ret: string | null): LintFinding[] {
  const out: LintFinding[] = [];
  const d = currencyDigits(currency) ?? 2;
  // An amount that looks like whole currency units (e.g. "100" for 100.00 SAR) is a common mistake: flag tiny ones.
  if (d > 0 && amount < 10 ** d && amount > 0) out.push(finding('pay.aps-amount-unit', 'amount ' + amount + ' is ' + amount / 10 ** d + ' ' + currency + ': APS amounts are in minor units (multiply by ' + 10 ** d + ')'));
  if (!ret) out.push(finding('pay.return-url-missing-or-bad', 'No return_url and no redirection URL on the instance'));
  if (!asString(b.merchant_reference)) out.push(finding('pay.no-reference', 'No merchant_reference'));
  return out;
}

function pagePath(c: GatewayCtx, p: Payment): string {
  return '../'.repeat(Math.max(c.path.split('/').length - 2, 0)) + 'page/' + p.id;
}

async function paymentPage(c: GatewayCtx): Promise<unknown> {
  c.resolved.endpoint = 'redirection (paymentPage)';
  const b = bodyOf(c.req);
  if (asString(b.service_command) === 'TOKENIZATION') return tokenizationPage(c, b);
  const command = asString(b.command);
  if (!command) throw new ApsError('00', '001', 'Missing parameter command');
  if (command !== 'PURCHASE' && command !== 'AUTHORIZATION') throw new ApsError('00', '004', 'Invalid command');
  credentials(c, b);
  for (const k of ['merchant_reference', 'currency', 'language', 'customer_email']) if (!asString(b[k])) throw new ApsError('00', '001', 'Missing parameter ' + k);
  const currency = String(b.currency).toUpperCase();
  if (currencyDigits(currency) === null) {
    c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', 'Unknown currency "' + currency + '"'));
    throw new ApsError('00', '013', 'Invalid currency');
  }
  const amount = amountOf(c, b, currency);
  const ref = String(b.merchant_reference);
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(ref)) throw new ApsError('00', '002', 'Invalid parameter format merchant_reference');
  if (c.svc.repo.list(c.project.id, { instanceId: c.inst.id, reference: ref, limit: 1 }).length) throw new ApsError('00', '066', 'Merchant reference already exists');
  const option = asString(b.payment_option)?.toUpperCase() ?? null;
  if (option && !OPTION_METHODS[option]) throw new ApsError('00', '003', 'Payment option not available');
  if (command === 'AUTHORIZATION' && (option === 'KNET' || option === 'MADA')) throw new ApsError('00', '049', 'Operation not valid for this payment option');
  const ret = httpUrl(b.return_url) ?? httpUrl(c.inst.config.redirectionUrl);
  if (asString(b.return_url) && !httpUrl(b.return_url)) throw new ApsError('00', '002', 'Invalid parameter format return_url');
  const methods: PaymentMethod[] = option ? OPTION_METHODS[option]! : command === 'AUTHORIZATION' ? ['card', 'applepay'] : ['card', 'mada', 'applepay', 'knet'];
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: '1' + digits(17),
    secondaryRef: null,
    amount,
    currency,
    reference: ref,
    customerEmail: asString(b.customer_email),
    returnUrl: ret,
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: presetOutcome(c),
    request: b,
    providerData: { command, methods },
    idempotencyKey: null,
    lint: lintCreate(b, amount, currency, ret),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  c.resolved.payment = p.id;
  return c.reply.redirect(pagePath(c, p), 303);
}

function findPayment(c: GatewayCtx, b: Json): Payment {
  const fort = asString(b.fort_id);
  const ref = asString(b.merchant_reference);
  if (!fort && !ref) throw new ApsError('00', '001', 'Missing parameter fort_id or merchant_reference');
  const p = fort ? c.svc.repo.byInstanceRef(c.inst.id, fort) : c.svc.repo.list(c.project.id, { instanceId: c.inst.id, reference: ref!, limit: 1 })[0];
  if (!p) throw new ApsError('00', '036', 'Order not found');
  c.resolved.payment = p.id;
  return p;
}

/** Echo of a maintenance request + result, signed with the response phrase. */
function apiAnswer(c: GatewayCtx, b: Json, p: Payment | null, status: string, msg: [string, string], extra: Record<string, string> = {}): Record<string, string> {
  const f: Record<string, string> = {};
  for (const k of ['command', 'query_command', 'access_code', 'merchant_identifier', 'merchant_reference', 'amount', 'currency', 'language', 'fort_id', 'maintenance_reference', 'order_description']) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') f[k] = String(b[k]);
  }
  if (p) {
    f.fort_id = p.providerRef;
    if (p.reference) f.merchant_reference = p.reference;
  }
  Object.assign(f, extra, { response_code: status + msg[0], response_message: msg[1], status });
  return signResponse(c.inst, f);
}

async function maintenance(c: GatewayCtx): Promise<unknown> {
  const b = bodyOf(c.req);
  const command = asString(b.command);
  const query = asString(b.query_command);
  if (!command && !query) throw new ApsError('00', '001', 'Missing parameter command');
  credentials(c, b);
  if (query) {
    if (query !== 'CHECK_STATUS') throw new ApsError('00', '004', 'Invalid command');
    c.resolved.endpoint = 'CHECK_STATUS';
    let p = await c.svc.touch(findPayment(c, b));
    p = stamp(c.svc, p);
    c.svc.repo.addEvent(p, 'status_queried', { via: 'CHECK_STATUS' });
    const r = resultCodes(p);
    const captured = ['paid', 'partially_refunded', 'refunded'].includes(p.status) ? Number(p.providerData.capturedAmount ?? p.amount) : 0;
    return apiAnswer(c, b, p, '12', APS_MESSAGES.success!, {
      transaction_status: r.status,
      transaction_code: r.status + r.msg[0],
      transaction_message: r.msg[1],
      authorized_amount: ['created', 'pending', 'requires_action', 'failed', 'expired'].includes(p.status) ? '0' : String(p.amount),
      captured_amount: String(captured),
      refunded_amount: String(p.refunded),
      ...(p.providerData.authorizationCode ? { authorization_code: String(p.providerData.authorizationCode) } : {}),
    });
  }
  c.resolved.endpoint = command!;
  if ((command === 'PURCHASE' || command === 'AUTHORIZATION') && asString(b.token_name)) return tokenPurchase(c, b, command);
  const p0 = await c.svc.touch(findPayment(c, b));
  if (command === 'CAPTURE') {
    const currency = String(b.currency ?? p0.currency).toUpperCase();
    const amount = amountOf(c, b, currency);
    if (!isAuth(p0)) return apiAnswer(c, b, p0, '05', ['049', 'Operation not valid for this payment option']);
    const r = await c.svc.capture(p0, { idempotencyKey: asString(b.merchant_reference) ?? p0.providerRef, amount });
    if (r.error) {
      const msg: [string, string] = r.error === 'amount_exceeds' ? ['042', 'Operation amount exceeds the authorized amount'] : r.error === 'already_captured' ? ['047', 'Order already processed'] : r.error === 'not_approved' ? ['036', 'Order not found'] : APS_MESSAGES[r.reason ?? 'generic'] ?? APS_MESSAGES.generic!;
      return apiAnswer(c, b, r.payment, '05', msg);
    }
    return apiAnswer(c, b, r.payment, '04', APS_MESSAGES.success!);
  }
  if (command === 'VOID_AUTHORIZATION') {
    if (!isAuth(p0) || p0.status !== 'authorized' || p0.providerData.captured) return apiAnswer(c, b, p0, '09', ['047', 'Order already processed']);
    const p = await c.svc.voidPayment(p0, { webhook: true });
    return apiAnswer(c, b, p, '08', APS_MESSAGES.success!);
  }
  if (command === 'REFUND') {
    const currency = String(b.currency ?? p0.currency).toUpperCase();
    const amount = amountOf(c, b, currency);
    if (currency !== p0.currency) return apiAnswer(c, b, p0, '07', ['013', 'Invalid currency']);
    try {
      const r = await c.svc.refund(p0, amount, { providerRef: asString(b.maintenance_reference) ?? '1' + digits(17), reason: asString(b.order_description) });
      return apiAnswer(c, b, r.payment, '06', APS_MESSAGES.success!);
    } catch (e) {
      if (!(e instanceof HttpError) || e.statusCode >= 500) throw e;
      return apiAnswer(c, b, p0, '07', e.statusCode === 400 ? ['048', 'Operation amount exceeds captured amount'] : ['047', 'Order already processed']);
    }
  }
  throw new ApsError('00', '004', 'Invalid command');
}

// ---------------- Merchant Page (iframe, TOKENIZATION) ----------------

type MpSession = { id: string; request: Record<string, string>; returnUrl: string; tokenName: string | null; used: boolean };
type MpToken = { brand: string; last4: string; bin: string; expiry: string; magicId: string | null; holder: string };
const mpSessions = new Map<string, ExpiringStore<MpSession>>();
const mpTokens = new Map<string, ExpiringStore<MpToken>>();
const storeOf = <T,>(m: Map<string, ExpiringStore<T>>, inst: PaymentInstance, ttl: number) => {
  let s = m.get(inst.id);
  if (!s) m.set(inst.id, (s = new ExpiringStore<T>(ttl)));
  return s;
};
const MP_BIN: Record<string, string> = { visa: '400555', mastercard: '512345', mada: '588845', amex: '345678' };

/** POST /FortAPI/paymentPage with service_command TOKENIZATION: the card form inside the shop's iframe. */
function tokenizationPage(c: GatewayCtx, b: Json): unknown {
  c.resolved.endpoint = 'merchant page (TOKENIZATION)';
  credentials(c, b);
  for (const k of ['merchant_reference', 'language']) if (!asString(b[k])) throw new ApsError('18', '001', 'Missing parameter ' + k);
  const ret = httpUrl(b.return_url) ?? httpUrl(c.inst.config.redirectionUrl);
  if (asString(b.return_url) && !httpUrl(b.return_url)) throw new ApsError('18', '002', 'Invalid parameter format return_url');
  if (!ret) throw new ApsError('18', '001', 'Missing parameter return_url');
  const request: Record<string, string> = {};
  for (const k of ['access_code', 'merchant_identifier', 'merchant_reference', 'language', 'return_url', 'token_name', 'merchant_extra', 'merchant_extra1', 'merchant_extra2']) if (asString(b[k])) request[k] = String(b[k]);
  const id = randomUUID();
  const tokenName = asString(b.token_name)?.slice(0, 100) ?? null;
  storeOf(mpSessions, c.inst, 30 * 60_000).set(id, { id, request, returnUrl: ret, tokenName, used: false });
  const L: Locale = String(b.language).toLowerCase() === 'ar' ? 'ar' : 'en';
  const html = renderApsMerchantPage({ locale: L, session: id, merchant: String(c.inst.name ?? c.inst.slug), holder: asString(b.card_holder_name) });
  return htmlReply(c, 200, html);
}

/** The card form's submit: card facts → token_name and the signed TOKENIZATION response for return_url. */
function merchantPageToken(c: GatewayCtx): unknown {
  c.resolved.endpoint = 'merchant page token';
  const b = bodyOf(c.req);
  const bad = (status: number, message: string) => c.reply.status(status).send({ message });
  const s = storeOf(mpSessions, c.inst, 30 * 60_000).get(String(b.session ?? ''));
  if (!s || s.used) return bad(404, 'The merchant page session expired: post the TOKENIZATION form again');
  const f = (b.card && typeof b.card === 'object' ? b.card : {}) as Json;
  const brand = String(f.brand ?? 'visa').toLowerCase().slice(0, 20);
  if (f.test !== true) {
    if (f.luhn === true) c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking ' + brand + ' card reached the APS merchant page on ' + c.inst.slug + ' (refused, not stored)'));
    return bad(400, 'Use a test card: stubyard does not accept real card numbers');
  }
  const last4 = String(f.last4 ?? '').replace(/\D/g, '').slice(-4);
  const bin = String(b.first_six ?? '').replace(/\D/g, '').slice(0, 6);
  const mm = Number(b.exp_month);
  const yy = Number(b.exp_year) % 100;
  if (last4.length !== 4 || bin.length !== 6 || !(mm >= 1 && mm <= 12) || !(yy >= 0)) return bad(400, 'Invalid card details');
  s.used = true;
  const tokenName = s.tokenName ?? randomHex(32);
  const holder = (asString(b.name) ?? '').slice(0, 50);
  const expiry = String(yy).padStart(2, '0') + String(mm).padStart(2, '0');
  storeOf(mpTokens, c.inst, 24 * 60 * 60_000).set(tokenName, { brand, last4, bin, expiry, magicId: asString(f.magicId)?.slice(0, 40) ?? null, holder });
  const fields = signResponse(c.inst, {
    ...s.request,
    service_command: 'TOKENIZATION',
    token_name: tokenName,
    card_number: bin + (brand === 'amex' ? '*****' : '******') + last4,
    expiry_date: expiry,
    card_bin: bin,
    card_holder_name: holder,
    response_code: '18000',
    response_message: 'Success',
    status: '18',
  });
  return { url: s.returnUrl, fields };
}

/** PURCHASE / AUTHORIZATION with token_name on /FortAPI/paymentApi: 3ds_url (status 20), or the result with check_3ds NO. */
async function tokenPurchase(c: GatewayCtx, b: Json, command: string): Promise<unknown> {
  c.resolved.endpoint = command + ' (token_name)';
  const tok = storeOf(mpTokens, c.inst, 24 * 60 * 60_000).get(String(b.token_name));
  if (!tok) return apiAnswer(c, b, null, command === 'AUTHORIZATION' ? '03' : '13', ['024', 'Invalid token name']);
  for (const k of ['merchant_reference', 'currency', 'language', 'customer_email']) if (!asString(b[k])) throw new ApsError('00', '001', 'Missing parameter ' + k);
  const currency = String(b.currency).toUpperCase();
  if (currencyDigits(currency) === null) throw new ApsError('00', '013', 'Invalid currency');
  const amount = amountOf(c, b, currency);
  const ref = String(b.merchant_reference);
  if (c.svc.repo.list(c.project.id, { instanceId: c.inst.id, reference: ref, limit: 1 }).length) throw new ApsError('00', '066', 'Merchant reference already exists');
  const ret = httpUrl(b.return_url) ?? httpUrl(c.inst.config.redirectionUrl);
  const method: PaymentMethod = tok.brand === 'mada' ? 'mada' : 'card';
  if (command === 'AUTHORIZATION' && method === 'mada') throw new ApsError('00', '049', 'Operation not valid for this payment option');
  const threeDs = String(b.check_3ds ?? '').toUpperCase() !== 'NO';
  const apiCard = { brand: tok.brand, last4: tok.last4, magicId: tok.magicId === '3ds' ? null : tok.magicId, luhnValid: true, testCard: true };
  let p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: '1' + digits(17),
    secondaryRef: null,
    amount,
    currency,
    reference: ref,
    customerEmail: asString(b.customer_email),
    returnUrl: ret,
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: presetOutcome(c),
    request: { ...b, card_holder_name: asString(b.card_holder_name) ?? tok.holder },
    providerData: { command, methods: [method], apiCard, checkoutView: { ui: 'realistic' }, merchantPage: true },
    idempotencyKey: null,
    lint: lintCreate(b, amount, currency, ret),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  p = c.svc.repo.update(p.id, { method, cardBrand: tok.brand, cardLast4: tok.last4 });
  c.resolved.payment = p.id;
  if (!threeDs) {
    const r = await c.svc.complete(p, { via: 'api', method, card: apiCard });
    return pageResponse(stamp(c.svc, c.svc.repo.get(r.payment.id)!), c.inst);
  }
  if (!ret) throw new ApsError('00', '001', 'Missing parameter return_url (needed for 3-D Secure)');
  const f = { ...pageResponse(p, c.inst) };
  delete f.signature;
  f['3ds_url'] = c.svc.entryUrl(c.project, c.inst, p);
  return signResponse(c.inst, f);
}

/** The demo shop (its server signs the TOKENIZATION form and charges the token at its return URL). */
async function merchantDemo(c: GatewayCtx, m: string, path: string): Promise<unknown> {
  const sign = (f: Record<string, string>) => ({ ...f, signature: apsSignature(f, String(c.inst.config.shaRequestPhrase ?? ''), shaTypeOf(c.inst)) });
  if ((path === '/demo' || path === '/demo/result') && (m === 'GET' || m === 'HEAD')) {
    return apsMerchantDemo(c, path.slice(5), {
      form: (base, lang) => sign({ service_command: 'TOKENIZATION', access_code: String(c.inst.config.accessCode ?? ''), merchant_identifier: String(c.inst.config.merchantIdentifier ?? ''), merchant_reference: 'demo-' + digits(8), language: lang, return_url: base + '/demo/return?lang=' + lang }),
      status: (fort) => {
        const p = c.svc.repo.byInstanceRef(c.inst.id, fort);
        if (!p) return null;
        const r = resultCodes(p);
        return r.status + r.msg[0] + ' ' + r.msg[1];
      },
    });
  }
  if (path === '/demo/result' && m === 'POST') {
    const b = bodyOf(c.req);
    const q = new URLSearchParams();
    for (const k of ['fort_id', 'response_code', 'response_message', 'status', 'merchant_reference']) if (typeof b[k] === 'string') q.set(k, String(b[k]));
    return c.reply.redirect(requestBase(c) + '/demo/result?' + q.toString(), 303);
  }
  if (path === '/demo/return' && m === 'POST') {
    // The shop's server: verify the TOKENIZATION response, then PURCHASE with token_name.
    const b = bodyOf(c.req);
    const base = requestBase(c);
    const lang = c.query.lang === 'ar' ? 'ar' : 'en';
    if (!apsVerify(b, String(c.inst.config.shaResponsePhrase ?? ''), shaTypeOf(c.inst)) || b.response_code !== '18000') {
      return apsMerchantDemoNext(c, base + '/demo/result?' + new URLSearchParams({ response_code: String(b.response_code ?? ''), response_message: String(b.response_message ?? 'Tokenization failed') }).toString());
    }
    const req = sign({ command: 'PURCHASE', access_code: String(c.inst.config.accessCode ?? ''), merchant_identifier: String(c.inst.config.merchantIdentifier ?? ''), merchant_reference: 'demo-' + digits(10), amount: '10000', currency: 'SAR', language: lang, customer_email: 'demo@example.com', customer_ip: '192.0.2.10', token_name: String(b.token_name ?? ''), return_url: base + '/demo/result' });
    credentials(c, req);
    const r = (await tokenPurchase(c, req, 'PURCHASE')) as Record<string, string>;
    c.resolved.endpoint = 'demo return';
    return apsMerchantDemoNext(c, r['3ds_url'] ?? base + '/demo/result?' + new URLSearchParams({ fort_id: r.fort_id ?? '', response_code: r.response_code ?? '', response_message: r.response_message ?? '' }).toString());
  }
  return undefined;
}

const randomHex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

async function handle(c: GatewayCtx): Promise<unknown> {
  const path = c.path.replace(/\/+$/, '');
  if (c.req.method === 'POST' && /^\/FortAPI\/paymentPage$/i.test(path)) return paymentPage(c);
  if (c.req.method === 'POST' && /^\/FortAPI\/paymentApi$/i.test(path)) return maintenance(c);
  if (c.req.method === 'POST' && /^\/FortAPI\/merchantPage\/token$/i.test(path)) return merchantPageToken(c);
  if (c.req.method === 'POST' && /^\/FortAPI\/merchantPage\/card-warning$/i.test(path)) {
    c.resolved.endpoint = 'merchant page card warning';
    c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', 'A real-looking card number was typed into the APS merchant page on ' + c.inst.slug + ' (cleared in the frame, never sent)'));
    return c.reply.status(204).send();
  }
  const demo = await merchantDemo(c, c.req.method, path);
  if (demo !== undefined) return demo;
  throw new HttpError(404, c.req.method + ' ' + c.path + ' is not simulated by stubyard (POST /FortAPI/paymentPage, POST /FortAPI/paymentApi)');
}

/** Feedback body of one command (PURCHASE / AUTHORIZATION from the page, CAPTURE / REFUND / VOID_AUTHORIZATION). */
function feedbackFields(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): Record<string, string> {
  if (type === 'PURCHASE' || type === 'AUTHORIZATION') return pageResponse(p, inst);
  const base: Record<string, string> = {
    command: type,
    access_code: String(inst.config.accessCode ?? ''),
    merchant_identifier: String(inst.config.merchantIdentifier ?? ''),
    merchant_reference: p.reference ?? '',
    fort_id: p.providerRef,
    language: String(p.request.language ?? 'en'),
  };
  if (type === 'REFUND') {
    const last = svc.repo.refunds(p.id).at(-1);
    Object.assign(base, { amount: String(last?.amount ?? p.refunded), currency: p.currency, response_code: '06000', response_message: 'Success', status: '06' });
  } else if (type === 'CAPTURE') {
    const ok = ['paid', 'partially_refunded', 'refunded'].includes(p.status);
    Object.assign(base, { amount: String(p.providerData.capturedAmount ?? p.amount), currency: p.currency, response_code: ok ? '04000' : '05666', response_message: ok ? 'Success' : 'Transaction declined', status: ok ? '04' : '05' });
  } else Object.assign(base, { response_code: '08000', response_message: 'Success', status: '08' });
  return signResponse(inst, base);
}

export const apsGateway: Gateway = {
  preset: 'aps',
  name: 'Amazon Payment Services',
  description: 'PayFort redirection (PURCHASE / AUTHORIZATION) with request + response signatures, CAPTURE / VOID / REFUND / CHECK_STATUS, transaction feedback; cards, mada, Apple Pay, KNET.',
  available: true,
  note: 'Merchant Page (iframe): service_command TOKENIZATION → token_name at return_url → PURCHASE / AUTHORIZATION with token_name → 3ds_url is simulated. Merchant Page 2.0 (your own card inputs), saved-card reuse rules, installments and recurring are not.',
  kind: 'hpp',
  methods: ['card', 'mada', 'applepay', 'knet'],
  logo: 'APS',
  slugBase: 'aps',
  fields: [
    { key: 'merchantIdentifier', label: 'Merchant identifier' },
    { key: 'accessCode', label: 'Access code' },
    { key: 'shaRequestPhrase', label: 'SHA request phrase', secret: true, hint: 'Signs your requests' },
    { key: 'shaResponsePhrase', label: 'SHA response phrase', secret: true, hint: 'Signs the return, feedback and API answers' },
    { key: 'shaType', label: 'SHA type', hint: 'SHA-256 (default), SHA-512, HMAC-256 or HMAC-512' },
    { key: 'redirectionUrl', label: 'Redirection URL', hint: 'Used when a request has no return_url' },
    { key: 'webhookUrl', label: 'Transaction feedback URL', hint: 'Direct + notification feedback (form POST; feedbackFormat "json" sends JSON)' },
  ],
  defaults: () => ({ merchantIdentifier: digits(8).replace(/^0/, '1'), accessCode: 'zx' + digits(18), shaRequestPhrase: '$2y$10$' + digits(10) + 'req', shaResponsePhrase: '$2y$10$' + digits(10) + 'res', shaType: 'SHA-256', webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => !isAuth(p),
  retryOnDecline: false,
  entryPath: (p) => '/page/' + p.id,
  refundRef: () => '1' + digits(17),
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (!(e instanceof ApsError) && !(e instanceof HttpError && e.statusCode < 500)) throw e;
      const err = e instanceof ApsError ? e : new ApsError('00', '002', e.message);
      c.resolved.error = err.message;
      const b = bodyOf(c.req);
      const f: Record<string, string> = {};
      for (const k of ['command', 'query_command', 'access_code', 'merchant_identifier', 'merchant_reference', 'amount', 'currency', 'language', 'customer_email', 'fort_id']) if (asString(b[k])) f[k] = String(b[k]);
      Object.assign(f, { response_code: err.responseCode, response_message: err.message, status: err.statusCode2 });
      const signedF = signResponse(c.inst, f);
      if (/paymentPage/i.test(c.path)) {
        // The redirection answers a bad request at the merchant's return_url (or shows an error page).
        const ret = httpUrl(b.return_url) ?? httpUrl(c.inst.config.redirectionUrl);
        if (ret) return c.reply.status(200).type('text/html; charset=utf-8').send(renderFormPost(ret, signedF));
        return c.reply.status(400).type('text/html; charset=utf-8').send(renderPayError('Amazon Payment Services: ' + err.message, 'response_code ' + err.responseCode));
      }
      return c.reply.status(e instanceof HttpError ? e.statusCode : 200).send(signedF);
    }
  },
  returnTo: (svc, p0, inst) => {
    const ret = httpUrl(p0.returnUrl);
    if (!ret) return null;
    return { kind: 'post', url: ret, fields: pageResponse(stamp(svc, p0), inst) };
  },
  events: (p, point) => {
    const page = isAuth(p) ? 'AUTHORIZATION' : 'PURCHASE';
    switch (point) {
      case 'approved':
      case 'failed':
      case 'settled':
        return [page];
      case 'paid':
        return p.providerData.captured ? ['CAPTURE'] : [page];
      case 'cancelled':
        return p.providerData.voided ? ['VOID_AUTHORIZATION'] : [page];
      case 'refunded':
        return ['REFUND'];
      default:
        return [];
    }
  },
  buildEvent: (svc, p0, inst, type) => {
    const p = stamp(svc, p0);
    const f = feedbackFields(svc, p, inst, type);
    const json = inst.config.feedbackFormat === 'json';
    return {
      url: inst.config.webhookUrl ?? null,
      body: json ? JSON.stringify(f) : new URLSearchParams(f).toString(),
      headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      eventId: p.providerRef + ':' + type + ':' + f.response_code + (type === 'REFUND' ? ':' + svc.repo.refunds(p.id).length : ''),
      signing: null,
    };
  },
  shape: (_svc, p, inst) => pageResponse(p, inst),
  providerStatus: (p) => {
    const r = resultCodes(p);
    return r.status + ' (' + r.status + r.msg[0] + ' ' + r.msg[1] + ')';
  },
  connect: (inst, urls) => ({
    env: {
      APS_MERCHANT_IDENTIFIER: String(inst.config.merchantIdentifier ?? ''),
      APS_ACCESS_CODE: String(inst.config.accessCode ?? ''),
      APS_SHA_REQUEST_PHRASE: String(inst.config.shaRequestPhrase ?? ''),
      APS_SHA_RESPONSE_PHRASE: String(inst.config.shaResponsePhrase ?? ''),
      APS_SHA_TYPE: String(inst.config.shaType ?? 'SHA-256'),
      APS_PAGE_URL: urls.browser + '/FortAPI/paymentPage',
      APS_API_URL: urls.backend + '/FortAPI/paymentApi',
      APS_API_URL_LOCAL: urls.backendLocal + '/FortAPI/paymentApi',
    },
    notes: [
      'Post the browser form to APS_PAGE_URL instead of https://sbcheckout.payfort.com/FortAPI/paymentPage, and send maintenance calls (JSON) to APS_API_URL instead of https://sbpaymentservices.payfort.com/FortAPI/paymentApi.',
      'amount is an integer in minor units (SAR 100.00 → 10000, KWD 1.000 → 1000). Sign requests with the request phrase; verify the return, feedback and API answers with the response phrase.',
      'Use command AUTHORIZATION for auth + CAPTURE / VOID_AUTHORIZATION; KNET and mada need PURCHASE.',
      'Merchant Page (iframe): post the signed form with service_command=TOKENIZATION (access_code, merchant_identifier, merchant_reference, language, return_url) to APS_PAGE_URL with target set to your iframe. The card form answers at return_url (inside the iframe) with response_code 18000 and token_name; your server sends command PURCHASE with token_name, customer_ip and return_url to APS_API_URL and opens the 3ds_url (status 20, response_code 20064) in the top window. check_3ds NO answers the result at once. Try it: {browser base}/demo.',
    ],
    snippets: [
      {
        title: 'signature (Node)',
        lang: 'js',
        code: [
          "const crypto = require('node:crypto');",
          'function apsSignature(params, phrase) {',
          "  const s = Object.keys(params).filter((k) => k !== 'signature' && params[k] !== '' && params[k] != null).sort().map((k) => k + '=' + params[k]).join('');",
          "  return crypto.createHash('sha256').update(phrase + s + phrase).digest('hex');",
          '}',
          'const ok = apsSignature(req.body, process.env.APS_SHA_RESPONSE_PHRASE) === String(req.body.signature).toLowerCase();',
        ].join('\n'),
      },
      {
        title: 'signature (PHP)',
        lang: 'php',
        code: ['$p = $_POST; unset($p["signature"]); ksort($p);', '$s = ""; foreach ($p as $k => $v) { if ($v !== "") $s .= "$k=$v"; }', '$phrase = getenv("APS_SHA_RESPONSE_PHRASE");', '$ok = hash_equals(hash("sha256", $phrase . $s . $phrase), strtolower($_POST["signature"]));'].join('\n'),
      },
    ],
  }),
};
