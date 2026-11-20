import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bodyOf, digits, header } from '../common.js';
import { fromDecimal, normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';

/**
 * Fake Easypaisa "Easypay" (Pakistan) under /pay/<project>/<instance>/…: the two-step hosted checkout
 * (/easypay/Index.jsf with merchantHashedReq → postBackURL?auth_token=… → /easypay/Confirm.jsf → stubyard page →
 * postBackURL?status=…), the REST v4 mobile-account initiate + inquire calls (header "Credentials") and the IPN: a GET
 * to the instance IPN URL with ?url=<a URL the app then GETs to read the transaction JSON>. PKR only.
 * Easypay's merchant guide is a portal PDF: shapes follow open-source merchant plugins (see AGENT_GUIDE Z.19.5 / Z.20).
 * Easypay documents no refund API: refunds happen in stubyard's dashboard, control API or MCP only.
 */

class EpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const aesName = (key: Buffer) => (key.length === 32 ? 'aes-256-ecb' : key.length === 24 ? 'aes-192-ecb' : 'aes-128-ecb');

/** The plain text of merchantHashedReq: posted fields except merchantHashedReq, non-empty, sorted by name, "k=v&k=v". */
export function easypaisaHashPlain(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .filter((k) => k !== 'merchantHashedReq' && fields[k] !== undefined && fields[k] !== null && String(fields[k]) !== '')
    .sort()
    .map((k) => k + '=' + String(fields[k]))
    .join('&');
}

/** merchantHashedReq = base64(AES/ECB/PKCS5Padding(plain, hash key)); a 16-character key is AES-128. */
export function easypaisaHashedRequest(fields: Record<string, unknown>, hashKey: string): string {
  const key = Buffer.from(hashKey, 'utf8');
  const c = createCipheriv(aesName(key), key, null);
  return Buffer.concat([c.update(easypaisaHashPlain(fields), 'utf8'), c.final()]).toString('base64');
}

/**
 * Lenient check: the decrypted text must be "k=v&…" pairs that all match the posted values and cover the required
 * fields (amount, orderRefNum, postBackURL, storeId). Merchant plugins differ in which optional fields they hash.
 */
export function easypaisaVerify(fields: Record<string, unknown>, hashKey: string): { ok: boolean; why?: string } {
  const sent = asString(fields.merchantHashedReq);
  if (!sent) return { ok: false, why: 'merchantHashedReq is missing' };
  let plain: string;
  try {
    const key = Buffer.from(hashKey, 'utf8');
    const d = createDecipheriv(aesName(key), key, null);
    plain = Buffer.concat([d.update(Buffer.from(sent, 'base64')), d.final()]).toString('utf8');
  } catch {
    return { ok: false, why: 'merchantHashedReq does not decrypt with the hash key (AES/ECB/PKCS5Padding, base64)' };
  }
  const pairs = new Map<string, string>();
  for (const part of plain.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) return { ok: false, why: 'merchantHashedReq is not "name=value&…" text' };
    pairs.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const k of ['amount', 'orderRefNum', 'postBackURL', 'storeId']) if (!pairs.has(k)) return { ok: false, why: 'merchantHashedReq does not cover ' + k };
  for (const [k, v] of pairs) if (String(fields[k] ?? '') !== v) return { ok: false, why: 'merchantHashedReq has ' + k + '=' + v + ' but the form posted ' + k + '=' + String(fields[k] ?? '') };
  return { ok: true };
}

const PM: Record<string, PaymentMethod[]> = { MA_PAYMENT_METHOD: ['wallet'], OTC_PAYMENT_METHOD: ['voucher'], CC_PAYMENT_METHOD: ['card'] };
const modeOf = (p: Payment) => (p.method === 'voucher' ? 'OTC' : p.method === 'card' ? 'CC' : 'MA');

/** Easypay transactionStatus (PAID / PENDING / FAILED / BLOCKED are documented; EXPIRED / REVERSED are stubyard's). */
function txStatus(p: Payment): string {
  if (p.status === 'paid' || p.status === 'partially_refunded') return 'PAID';
  if (p.status === 'refunded') return 'REVERSED';
  if (p.status === 'failed') return 'FAILED';
  if (p.status === 'expired' || p.status === 'cancelled') return p.status === 'expired' ? 'EXPIRED' : 'FAILED';
  return 'PENDING';
}

/** Decline reasons → the return "status" code (0000 is Easypay's; the failure codes are stubyard's). */
export const EASYPAISA_CODES: Record<string, [string, string]> = {
  success: ['0000', 'SUCCESS'],
  generic: ['0001', 'TRANSACTION FAILED'],
  insufficient_funds: ['0014', 'LOW BALANCE'],
  expired_card: ['0001', 'CARD EXPIRED'],
  incorrect_cvc: ['0001', 'INVALID CARD DETAILS'],
  processing_error: ['0001', 'SYSTEM ERROR'],
  authentication_failed: ['0001', 'AUTHENTICATION FAILED'],
  otp_failed: ['0001', 'INVALID OTP / PIN'],
  cancelled: ['0013', 'TRANSACTION CANCELLED BY USER'],
  expired: ['0015', 'TRANSACTION EXPIRED'],
};
function codeOf(p: Payment): [string, string] {
  if (p.status === 'failed') return EASYPAISA_CODES[String(p.providerData.declineReason ?? 'generic')] ?? EASYPAISA_CODES.generic!;
  if (p.status === 'cancelled') return EASYPAISA_CODES.cancelled!;
  if (p.status === 'expired') return EASYPAISA_CODES.expired!;
  return EASYPAISA_CODES.success!;
}

const stampTime = (d = new Date()) => new Date(d.getTime() + 5 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
function parseExpiry(s: string | null): Date | null {
  const m = s ? /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+05:00');
  return Number.isFinite(t) ? new Date(t) : null;
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

function amountOf(c: GatewayCtx, v: unknown, field: string): number {
  const amt = fromDecimal(v, 'PKR');
  if (!amt.ok || amt.minor <= 0) throw new EpError(400, '0002', 'Invalid ' + field + ': a positive PKR amount such as "10.0"');
  if (/,/.test(String(v))) c.svc.addInstanceLint(c.inst, finding('pay.amount-precision', field + ' "' + String(v) + '" has a thousands separator'));
  return amt.minor;
}

function token(svc: PaymentService, p0: Payment): Payment {
  const cur = svc.repo.get(p0.id) ?? p0;
  const keep = (d: Json) => ({ ...p0, providerData: { ...p0.providerData, ...d } });
  if (cur.providerData.ipnToken) return keep(cur.providerData);
  return keep(svc.repo.update(cur.id, { providerData: { ...cur.providerData, ipnToken: alnum(24) } }).providerData);
}

/** The IPN transaction JSON (snake_case, as merchant plugins read it). */
function ipnJson(p: Payment, inst: PaymentInstance): Json {
  const out: Json = {
    order_id: p.reference ?? '',
    store_id: String(inst.config.storeId ?? ''),
    store_name: String(inst.config.storeName ?? 'stubyard store'),
    transaction_id: p.providerRef,
    transaction_status: txStatus(p),
    transaction_amount: toDecimal(p.amount, 'PKR'),
    transaction_date_time: String(p.providerData.txnTime ?? stampTime(new Date(p.createdAt))),
    payment_method: modeOf(p),
    msisdn: String(p.providerData.msisdn ?? ''),
    response_code: codeOf(p)[0],
    response_desc: codeOf(p)[1],
  };
  if (p.method === 'voucher') out.payment_token = String(p.providerData.paymentToken ?? '');
  if (p.method === 'voucher') out.token_expiry_date_time = String(p.providerData.tokenExpiry ?? '');
  return out;
}

/** REST inquire-transaction answer (camelCase). */
function inquiryJson(p: Payment, inst: PaymentInstance): Json {
  const out: Json = {
    orderId: p.reference ?? '',
    accountNum: String(inst.config.accountNum ?? ''),
    storeId: String(inst.config.storeId ?? ''),
    storeName: String(inst.config.storeName ?? 'stubyard store'),
    transactionId: p.providerRef,
    transactionStatus: txStatus(p),
    transactionAmount: Number(toDecimal(p.amount, 'PKR')),
    transactionDateTime: String(p.providerData.txnTime ?? stampTime(new Date(p.createdAt))),
    paymentMode: modeOf(p),
    msisdn: String(p.providerData.msisdn ?? ''),
    responseCode: '0000',
    responseDesc: 'SUCCESS',
  };
  if (p.method === 'voucher') out.paymentToken = String(p.providerData.paymentToken ?? '');
  return out;
}

function lintCreate(b: Json, amount: number): LintFinding[] {
  const out: LintFinding[] = [];
  if (amount <= 0) out.push(finding('pay.amount-zero', 'amount is ' + String(b.amount)));
  const ru = badUrl(b.postBackURL);
  if (ru) out.push(finding('pay.return-url-missing-or-bad', 'postBackURL ' + ru));
  return out;
}

function pagePath(c: GatewayCtx, p: Payment): string {
  return '../'.repeat(Math.max(c.path.split('/').length - 2, 0)) + 'page/' + p.id;
}

/** Step 1: POST /easypay/Index.jsf → 302 to postBackURL?auth_token=…&postBackURL=… */
async function index(c: GatewayCtx): Promise<unknown> {
  c.resolved.endpoint = 'checkout (Index.jsf)';
  const b = bodyOf(c.req);
  const storeId = asString(b.storeId);
  if (!storeId) throw new EpError(400, '0002', 'storeId is required');
  if ((c.inst.config.strictKeys || c.inst.config.storeId) && storeId !== String(c.inst.config.storeId)) throw new EpError(400, '0006', 'Invalid store id ' + storeId);
  for (const k of ['amount', 'postBackURL', 'orderRefNum']) if (!asString(b[k])) throw new EpError(400, '0002', k + ' is required');
  if (badUrl(b.postBackURL)) throw new EpError(400, '0002', 'postBackURL must be an absolute http(s) URL');
  const amount = amountOf(c, b.amount, 'amount');
  if (b.merchantHashedReq !== undefined || c.inst.config.requireHash !== false) {
    const v = easypaisaVerify(b, String(c.inst.config.hashKey ?? ''));
    if (!v.ok) {
      c.svc.addInstanceLint(c.inst, finding('pay.easypaisa-hash', 'Index.jsf: ' + v.why));
      throw new EpError(400, '0002', 'Invalid merchantHashedReq: ' + v.why);
    }
  }
  const pm = asString(b.paymentMethod);
  if (pm && !PM[pm]) throw new EpError(400, '0002', 'Invalid paymentMethod ' + pm + ' (MA_PAYMENT_METHOD, OTC_PAYMENT_METHOD, CC_PAYMENT_METHOD)');
  const expiry = parseExpiry(asString(b.expiryDate));
  const authToken = alnum(32);
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: digits(9),
    secondaryRef: authToken,
    amount,
    currency: 'PKR',
    reference: asString(b.orderRefNum),
    customerEmail: asString(b.emailAddr),
    returnUrl: asString(b.postBackURL),
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: presetOutcome(c),
    request: b,
    providerData: { methods: pm ? PM[pm] : ['wallet', 'voucher', 'card'], authToken, autoRedirect: asString(b.autoRedirect) ?? '0', msisdn: asString(b.mobileNum) ?? '' },
    idempotencyKey: null,
    lint: lintCreate(b, amount),
    expiresAt: (expiry && expiry.getTime() > Date.now() ? expiry : new Date(Date.now() + 3600_000)).toISOString(),
  });
  c.resolved.payment = p.id;
  const u = new URL(String(b.postBackURL));
  u.searchParams.set('auth_token', authToken);
  u.searchParams.set('postBackURL', String(b.postBackURL));
  return c.reply.redirect(u.toString(), 302);
}

/** Step 2: POST /easypay/Confirm.jsf {auth_token, postBackURL} → the stubyard page. */
async function confirm(c: GatewayCtx): Promise<unknown> {
  c.resolved.endpoint = 'checkout (Confirm.jsf)';
  const b = { ...(c.query as Json), ...bodyOf(c.req) };
  const tok = asString(b.auth_token);
  const p0 = tok ? c.svc.repo.byInstanceRef(c.inst.id, tok) : null;
  if (!p0 || p0.secondaryRef !== tok) throw new EpError(400, '0002', 'Invalid or expired auth_token');
  c.resolved.payment = p0.id;
  const pb = asString(b.postBackURL);
  if (pb && badUrl(pb)) throw new EpError(400, '0002', 'postBackURL must be an absolute http(s) URL');
  const p = pb && pb !== p0.returnUrl ? c.svc.repo.update(p0.id, { returnUrl: pb }) : p0;
  c.svc.repo.addEvent(p, 'easypaisa_confirm', { postBackURL: pb });
  return c.reply.redirect(pagePath(c, p), 303);
}

function credentials(c: GatewayCtx): void {
  const h = header(c.req, 'credentials');
  if (!h) throw new EpError(401, '0001', 'Credentials header is required (base64 of username:password)');
  let user = '';
  let pass = '';
  try {
    const s = Buffer.from(h, 'base64').toString('utf8');
    const i = s.indexOf(':');
    if (i > 0) [user, pass] = [s.slice(0, i), s.slice(i + 1)];
  } catch {
    /* fall through */
  }
  if (!user || !pass) throw new EpError(401, '0001', 'Invalid Credentials header (base64 of username:password)');
  if (c.inst.config.strictKeys && (user !== c.inst.config.username || pass !== c.inst.config.password)) throw new EpError(401, '0001', 'Invalid credentials');
}

function storeCheck(c: GatewayCtx, b: Json): void {
  const s = asString(b.storeId);
  if (!s) throw new EpError(400, '0002', 'storeId is required');
  if (s !== String(c.inst.config.storeId)) throw new EpError(400, '0006', 'Invalid store id ' + s);
}

async function initiateMa(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'initiate-ma-transaction';
  credentials(c);
  storeCheck(c, b);
  for (const k of ['orderId', 'transactionAmount', 'mobileAccountNo']) if (!asString(b[k])) throw new EpError(400, '0002', k + ' is required');
  if (asString(b.transactionType) && String(b.transactionType) !== 'MA') throw new EpError(400, '0002', 'transactionType must be MA');
  const msisdn = String(b.mobileAccountNo);
  if (!/^03\d{9}$/.test(msisdn)) throw new EpError(400, '0002', 'Invalid mobileAccountNo (format 03XXXXXXXXX)');
  if (b.signature !== undefined) c.resolved.warnings = ['RSA request signature accepted and not checked by stubyard'];
  const amount = amountOf(c, b.transactionAmount, 'transactionAmount');
  let p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: digits(9),
    secondaryRef: null,
    amount,
    currency: 'PKR',
    reference: String(b.orderId),
    customerEmail: asString(b.emailAddress),
    returnUrl: null,
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: presetOutcome(c),
    request: b,
    providerData: { methods: ['wallet'], msisdn, api: true },
    idempotencyKey: null,
    lint: amount <= 0 ? [finding('pay.amount-zero', 'transactionAmount is ' + String(b.transactionAmount))] : [],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  c.resolved.payment = p.id;
  const r = await c.svc.complete(p, { via: 'api', method: 'wallet', phone: '+92' + msisdn.slice(1), otp: 'auto' });
  p = c.svc.repo.update(r.payment.id, { providerData: { ...r.payment.providerData, txnTime: stampTime() } });
  const [code, desc] = p.status === 'paid' || p.status === 'authorized' ? EASYPAISA_CODES.success! : codeOf(p);
  return { orderId: String(b.orderId), storeId: String(b.storeId), transactionId: p.providerRef, transactionDateTime: String(p.providerData.txnTime), responseCode: code, responseDesc: desc };
}

async function inquire(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'inquire-transaction';
  credentials(c);
  storeCheck(c, b);
  const orderId = asString(b.orderId);
  if (!orderId) throw new EpError(400, '0002', 'orderId is required');
  const p0 = c.svc.repo.list(c.project.id, { instanceId: c.inst.id, reference: orderId, limit: 1 })[0];
  if (!p0) throw new EpError(400, '0003', 'Invalid order id ' + orderId);
  c.resolved.payment = p0.id;
  const p = await c.svc.touch(p0);
  c.svc.repo.addEvent(p, 'status_queried', { via: 'inquire-transaction' });
  return inquiryJson(p, c.inst);
}

/** GET /easypay-service/rest/ipn/<token>: the URL the IPN hands to the app. */
async function ipnRead(c: GatewayCtx, tok: string): Promise<unknown> {
  c.resolved.endpoint = 'IPN transaction details';
  const p0 = c.svc.repo.byDataRef(c.inst.id, 'ipnToken', tok);
  if (!p0) throw new EpError(404, '0003', 'Unknown IPN reference');
  c.resolved.payment = p0.id;
  const p = await c.svc.touch(p0);
  c.svc.repo.addEvent(p, 'ipn_fetched', {});
  c.svc.changed(p.projectId, { payment: p.id });
  return ipnJson(p, c.inst);
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  let mm: RegExpExecArray | null;
  if ((mm = /^\/easypay-service\/rest\/ipn\/([A-Za-z0-9]+)$/.exec(path)) && (m === 'GET' || m === 'HEAD')) return ipnRead(c, mm[1]!);
  if (/^\/easypay\/index\.jsf$/i.test(path) && m === 'POST') return index(c);
  if (/^\/easypay\/confirm\.jsf$/i.test(path) && (m === 'POST' || m === 'GET')) return confirm(c);
  if (m === 'POST' && path === '/easypay-service/rest/v4/initiate-ma-transaction') return initiateMa(c, bodyOf(req));
  if (m === 'POST' && path === '/easypay-service/rest/v4/inquire-transaction') return inquire(c, bodyOf(req));
  throw new EpError(404, '0002', m + ' ' + path + ' is not simulated by stubyard (easypay/Index.jsf, easypay/Confirm.jsf, rest/v4/initiate-ma-transaction, rest/v4/inquire-transaction)');
}

/** Voucher payments get a payment token (shown on the page) when they go pending. */
function voucherToken(svc: PaymentService, p: Payment): Payment {
  if (p.method !== 'voucher' || p.providerData.paymentToken) return p;
  return svc.repo.update(p.id, { providerData: { ...p.providerData, paymentToken: digits(8), tokenExpiry: stampTime(new Date(Date.now() + 72 * 3600_000)) } });
}

export const easypaisaGateway: Gateway = {
  preset: 'easypaisa',
  name: 'Easypaisa (Easypay)',
  description: 'Easypay hosted checkout (Index.jsf / Confirm.jsf with merchantHashedReq), REST v4 mobile-account initiate + inquire, GET IPN with a details URL; wallet, voucher (OTC), card (PKR).',
  available: true,
  note: "Easypay's merchant guide is a portal PDF: the shapes follow open-source merchant plugins. No refund API is documented: refund from stubyard.",
  kind: 'hpp',
  methods: ['wallet', 'voucher', 'card'],
  logo: 'EP',
  slugBase: 'easypaisa',
  otpSender: 'Easypaisa',
  fields: [
    { key: 'storeId', label: 'Store ID' },
    { key: 'hashKey', label: 'Hash key', secret: true, hint: 'AES key of merchantHashedReq (16 characters: AES-128)' },
    { key: 'username', label: 'REST username', hint: 'Credentials header: base64(username:password)' },
    { key: 'password', label: 'REST password', secret: true },
    { key: 'accountNum', label: 'Merchant account number' },
    { key: 'webhookUrl', label: 'IPN URL', hint: 'Easypay calls it with GET ?url=<details URL>; your app then GETs that URL' },
  ],
  defaults: () => ({ storeId: digits(5), hashKey: alnum(16), username: 'merchant' + digits(4), password: alnum(12), accountNum: digits(9), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: () => true,
  retryOnDecline: false,
  entryPath: (p) => '/page/' + p.id,
  refundRef: () => 'RF' + digits(10),
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof EpError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send({ responseCode: e.code, responseDesc: e.message });
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        c.resolved.error = e.message;
        return c.reply.status(e.statusCode).send({ responseCode: '0001', responseDesc: e.message });
      }
      throw e;
    }
  },
  afterComplete: (svc, p) => {
    voucherToken(svc, p);
    if (!p.providerData.txnTime) svc.repo.update(p.id, { providerData: { ...svc.repo.get(p.id)!.providerData, txnTime: stampTime() } });
  },
  returnTo: (svc, p0, _inst, kind) => {
    const ret = httpUrl(p0.returnUrl);
    if (!ret) return null;
    const p = voucherToken(svc, p0);
    const [code, desc] = codeOf(p);
    const u = new URL(ret);
    u.searchParams.set('success', kind === 'success' ? 'true' : 'false');
    u.searchParams.set('status', code);
    u.searchParams.set('desc', kind === 'success' ? code : desc);
    u.searchParams.set('orderRefNumber', p.reference ?? '');
    if (p.method === 'voucher' && p.providerData.paymentToken) u.searchParams.set('paymentToken', String(p.providerData.paymentToken));
    return { kind: 'redirect', url: u.toString() };
  },
  events: (p, point) => (['paid', 'settled', 'failed', 'expired'].includes(point) && !(point === 'paid' && p.method === 'voucher') ? ['ipn'] : []),
  buildEvent: (svc, p0, inst) => {
    const p = token(svc, p0);
    const project = svc.hub.projects.get(p.projectId);
    const details = project ? svc.base(project, inst) + '/easypay-service/rest/ipn/' + String(p.providerData.ipnToken) : '';
    return { url: inst.config.webhookUrl ?? null, method: 'GET', query: { url: details }, body: '', eventId: p.providerRef + ':' + txStatus(p), signing: null, plain: JSON.stringify(ipnJson(p, inst)) };
  },
  shape: (_svc, p, inst) => ({ ...inquiryJson(p, inst), ipn: ipnJson(p, inst) }),
  providerStatus: (p) => txStatus(p),
  lateLint: (svc, p) => {
    const ev = svc.repo.events(p.id);
    if (!ev.some((e) => e.type === 'webhook_delivered')) return [];
    if (ev.some((e) => e.type === 'ipn_fetched' || e.type === 'status_queried')) return [];
    return [finding('pay.easypaisa-ipn-not-fetched', 'The IPN for ' + p.providerRef + ' was delivered but your app never fetched its url= (or called inquire-transaction): the IPN itself carries no status')];
  },
  connect: (inst, urls) => ({
    env: {
      EASYPAY_STORE_ID: String(inst.config.storeId ?? ''),
      EASYPAY_HASH_KEY: String(inst.config.hashKey ?? ''),
      EASYPAY_USERNAME: String(inst.config.username ?? ''),
      EASYPAY_PASSWORD: String(inst.config.password ?? ''),
      EASYPAY_ACCOUNT_NUM: String(inst.config.accountNum ?? ''),
      EASYPAY_CHECKOUT_URL: urls.browser + '/easypay/Index.jsf',
      EASYPAY_CONFIRM_URL: urls.browser + '/easypay/Confirm.jsf',
      EASYPAY_REST_BASE_URL: urls.backend + '/easypay-service/rest',
      EASYPAY_REST_BASE_URL_LOCAL: urls.backendLocal + '/easypay-service/rest',
    },
    notes: [
      'Replace https://easypaystg.easypaisa.com.pk/easypay/Index.jsf and Confirm.jsf with EASYPAY_CHECKOUT_URL / EASYPAY_CONFIRM_URL (browser), and …/easypay-service/rest with EASYPAY_REST_BASE_URL (server).',
      'amount has one decimal ("10.0"), expiryDate is "yyyyMMdd HHmmss" (Pakistan time); merchantHashedReq covers the posted fields sorted by name.',
      'The final redirect carries success, status (0000 = paid), desc and orderRefNumber (+ paymentToken for vouchers). Confirm with inquire-transaction or the IPN details URL.',
      'Easypay documents no refund API: refund from the stubyard dashboard, POST /api/projects/<p>/payments/<id>/refund or MCP.',
    ],
    snippets: [
      {
        title: 'merchantHashedReq (Node)',
        lang: 'js',
        code: [
          "const crypto = require('node:crypto');",
          'function merchantHashedReq(fields, hashKey) {',
          "  const plain = Object.keys(fields).filter((k) => fields[k] !== '' && fields[k] != null).sort().map((k) => k + '=' + fields[k]).join('&');",
          "  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(hashKey), null);",
          "  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');",
          '}',
        ].join('\n'),
      },
      {
        title: 'merchantHashedReq (PHP)',
        lang: 'php',
        code: ['ksort($fields);', '$plain = urldecode(http_build_query(array_filter($fields, fn($v) => $v !== "")));', '$hash = base64_encode(openssl_encrypt($plain, "aes-128-ecb", getenv("EASYPAY_HASH_KEY"), OPENSSL_RAW_DATA));'].join('\n'),
      },
      {
        title: 'IPN handler (Node, express)',
        lang: 'js',
        code: ["app.get('/easypay/ipn', async (req, res) => {", '  const tx = await (await fetch(req.query.url)).json(); // { order_id, transaction_status: "PAID", … }', '  res.sendStatus(200);', '});'].join('\n'),
      },
    ],
  }),
};
