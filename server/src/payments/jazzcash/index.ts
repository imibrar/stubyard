import { createHmac } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bodyOf, digits, header, safeEqual } from '../common.js';
import { normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl } from '../lint.js';
import { renderFormPost } from '../pages.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';

/**
 * Fake JazzCash (Pakistan) under /pay/<project>/<instance>/…: Page Redirection v1.1 / 2.0 (form POST to
 * /CustomerPortal/transactionmanagement/merchantform/ → stubyard page → signed form POST back to pp_ReturnURL), the
 * REST v2.0 mobile-account purchase, the status inquiry, wallet / card refunds and the IPN (JSON with pp_SecureHash,
 * to the instance IPN URL) for vouchers and delayed wallet payments. PKR only, amounts in paisa.
 * JazzCash's merchant docs are behind the portal: the shapes follow its public sandbox snippets and widely used
 * merchant SDKs (see AGENT_GUIDE Z.19.4 / Z.20).
 */

/** Responses are HTTP 200 with a pp_ResponseCode, like JazzCash. */
class JcError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 200,
  ) {
    super(message);
  }
}

const SUCCESS_MSG = 'Thank you for Using JazzCash, your transaction was successful.';

/**
 * pp_SecureHash: every non-empty field whose name starts with "pp" (pp_… and ppmpf_…) except pp_SecureHash, sorted
 * by name, values joined with "&", prefixed with "<integrity salt>&", HMAC-SHA256 keyed with the salt, upper-case hex.
 */
export function jazzcashSecureHash(fields: Record<string, unknown>, integritySalt: string): string {
  const values = Object.keys(fields)
    .filter((k) => /^pp/i.test(k) && k.toLowerCase() !== 'pp_securehash')
    .filter((k) => fields[k] !== undefined && fields[k] !== null && String(fields[k]) !== '')
    .sort()
    .map((k) => String(fields[k]));
  return createHmac('sha256', integritySalt).update([integritySalt, ...values].join('&'), 'utf8').digest('hex').toUpperCase();
}

/** Case-insensitive check of pp_SecureHash (merchants send upper or lower case hex). */
export function jazzcashVerify(fields: Record<string, unknown>, integritySalt: string): boolean {
  const got = String(fields.pp_SecureHash ?? '').trim().toUpperCase();
  return got !== '' && safeEqual(got, jazzcashSecureHash(fields, integritySalt));
}

/** yyyyMMddHHmmss in Pakistan time (UTC+5, no DST). */
export function pktStamp(d = new Date()): string {
  return new Date(d.getTime() + 5 * 3600_000).toISOString().replace(/\D/g, '').slice(0, 14);
}
function parsePkt(s: string | null): Date | null {
  const m = s ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+05:00');
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Decline reasons → pp_ResponseCode (000 / 110 / 121 / 124 / 157 are JazzCash's; the decline codes are stubyard's). */
export const JAZZCASH_CODES: Record<string, [string, string]> = {
  success: ['000', SUCCESS_MSG],
  pending_voucher: ['124', 'Order is placed and waiting for financials to be received over the counter.'],
  pending_wallet: ['157', 'Transaction is pending.'],
  generic: ['999', 'Transaction declined.'],
  insufficient_funds: ['004', 'Low balance.'],
  expired_card: ['003', 'Account or card is inactive / expired.'],
  incorrect_cvc: ['110', 'Please provide a valid value for card details.'],
  processing_error: ['199', 'System error. Please try again.'],
  authentication_failed: ['134', 'Authentication failed.'],
  otp_failed: ['134', 'Authentication failed (OTP / MPIN).'],
  cancelled: ['101', 'Transaction cancelled by the customer.'],
  expired: ['133', 'Transaction expired.'],
};

const TXN_METHODS: Record<string, PaymentMethod[]> = { MWALLET: ['wallet'], MPAY: ['card'], OTC: ['voucher'] };
const txnTypeOf = (p: Payment): string => (p.method === 'card' ? 'MPAY' : p.method === 'voucher' ? 'OTC' : p.method === 'wallet' ? 'MWALLET' : String(p.providerData.txnType ?? ''));

/** pp_ResponseCode + message of a payment as the return / IPN / inquiry show it. */
function codeOf(p: Payment): [string, string] {
  switch (p.status) {
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return p.providerData.settled ? ['121', 'Transaction has been marked confirmed by Merchant.'] : JAZZCASH_CODES.success!;
    case 'authorized':
      return p.method === 'voucher' ? JAZZCASH_CODES.pending_voucher! : JAZZCASH_CODES.pending_wallet!;
    case 'failed':
      return JAZZCASH_CODES[String(p.providerData.declineReason ?? 'generic')] ?? JAZZCASH_CODES.generic!;
    case 'cancelled':
      return JAZZCASH_CODES.cancelled!;
    case 'expired':
      return JAZZCASH_CODES.expired!;
    default:
      return JAZZCASH_CODES.pending_wallet!;
  }
}

/** pp_Status of the inquiry. */
function statusWord(p: Payment): string {
  if (['paid', 'partially_refunded', 'refunded'].includes(p.status)) return p.status === 'refunded' ? 'Refunded' : 'Completed';
  if (p.status === 'failed') return 'Failed';
  if (p.status === 'cancelled' || p.status === 'expired') return 'Dropped';
  return 'Pending';
}

function stamp(svc: PaymentService, p0: Payment): Payment {
  const cur = svc.repo.get(p0.id) ?? p0;
  const keep = (d: Json) => ({ ...p0, providerData: { ...p0.providerData, ...d } });
  if (cur.providerData.rrn) return keep(cur.providerData);
  return keep(svc.repo.update(cur.id, { providerData: { ...cur.providerData, rrn: digits(12), authCode: digits(6) } }).providerData);
}

/** The response fields (return form, IPN, wallet API answer), signed with the integrity salt. */
function responseFields(p: Payment, inst: PaymentInstance): Record<string, string> {
  const req = p.request as Record<string, unknown>;
  const [code, msg] = codeOf(p);
  const f: Record<string, string> = {
    pp_Amount: String(p.amount),
    pp_AuthCode: ['000', '121'].includes(code) ? String(p.providerData.authCode ?? '') : '',
    pp_BankID: String(req.pp_BankID ?? ''),
    pp_BillReference: p.reference ?? '',
    pp_Language: String(req.pp_Language ?? 'EN'),
    pp_MerchantID: String(inst.config.merchantId ?? req.pp_MerchantID ?? ''),
    pp_ProductID: String(req.pp_ProductID ?? ''),
    pp_ResponseCode: code,
    pp_ResponseMessage: msg,
    pp_RetreivalReferenceNo: String(p.providerData.rrn ?? ''),
    pp_SubMerchantId: String(req.pp_SubMerchantID ?? ''),
    pp_TxnCurrency: 'PKR',
    pp_TxnDateTime: String(p.providerData.txnDateTime ?? ''),
    pp_TxnRefNo: p.providerRef,
    pp_TxnType: txnTypeOf(p),
    pp_Version: String(req.pp_Version ?? '1.1'),
  };
  if (p.method === 'voucher' && code === '124') f.pp_SettlementExpiry = String(p.providerData.settlementExpiry ?? '');
  for (let i = 1; i <= 5; i++) {
    const v = req['ppmpf_' + i];
    if (v !== undefined && v !== null && v !== '') f['ppmpf_' + i] = String(v);
  }
  f.pp_SecureHash = jazzcashSecureHash(f, String(inst.config.integritySalt ?? ''));
  return f;
}

function signed(inst: PaymentInstance, f: Record<string, string>): Record<string, string> {
  return { ...f, pp_SecureHash: jazzcashSecureHash(f, String(inst.config.integritySalt ?? '')) };
}

function credentials(c: GatewayCtx, b: Json): void {
  const mid = asString(b.pp_MerchantID);
  const pw = asString(b.pp_Password);
  if (!mid) throw new JcError('110', 'Please provide a valid value for pp_MerchantID');
  if (!pw) throw new JcError('110', 'Please provide a valid value for pp_Password');
  const strict = c.inst.config.strictKeys || c.inst.config.merchantId;
  if (strict && mid !== String(c.inst.config.merchantId)) throw new JcError('110', 'Please provide a valid value for pp_MerchantID');
  if (c.inst.config.strictKeys && pw !== String(c.inst.config.password)) throw new JcError('110', 'Please provide a valid value for pp_Password');
  if (!jazzcashVerify(b, String(c.inst.config.integritySalt ?? ''))) {
    c.svc.addInstanceLint(c.inst, finding('pay.jazzcash-secure-hash', c.path + ': pp_SecureHash did not match (sorted pp_ values joined with "&", prefixed with the integrity salt, HMAC-SHA256)'));
    throw new JcError('110', 'Please provide a valid value for pp_SecureHash');
  }
}

/** Amount (paisa) and currency checks shared by the page and the wallet API. */
function amountOf(c: GatewayCtx, b: Json): number {
  const cur = (asString(b.pp_TxnCurrency) ?? 'PKR').toUpperCase();
  if (cur !== 'PKR') {
    c.svc.addInstanceLint(c.inst, finding('pay.jazzcash-amount', 'pp_TxnCurrency ' + cur + ': JazzCash only takes PKR'));
    throw new JcError('110', 'Please provide a valid value for pp_TxnCurrency');
  }
  const raw = asString(b.pp_Amount) ?? '';
  if (!/^\d+$/.test(raw)) {
    c.svc.addInstanceLint(c.inst, finding('pay.jazzcash-amount', 'pp_Amount "' + raw + '" must be paisa (rupees × 100) without a decimal point'));
    throw new JcError('110', 'Please provide a valid value for pp_Amount');
  }
  return Number(raw);
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

function lintCreate(b: Json, amount: number, returnRequired: boolean): LintFinding[] {
  const out: LintFinding[] = [];
  if (amount <= 0) out.push(finding('pay.amount-zero', 'pp_Amount is ' + String(b.pp_Amount)));
  if (returnRequired) {
    const ru = badUrl(b.pp_ReturnURL);
    if (ru) out.push(finding('pay.return-url-missing-or-bad', 'pp_ReturnURL ' + ru));
  }
  if (!asString(b.pp_BillReference)) out.push(finding('pay.no-reference', 'No pp_BillReference: hard to match the payment to your order'));
  return out;
}

function newPayment(c: GatewayCtx, b: Json, opts: { methods: PaymentMethod[]; page: boolean }): Payment {
  const amount = amountOf(c, b);
  const ref = asString(b.pp_TxnRefNo);
  if (!ref) throw new JcError('110', 'Please provide a valid value for pp_TxnRefNo');
  if (c.svc.repo.byInstanceRef(c.inst.id, ref)) throw new JcError('110', 'Please provide a valid value for pp_TxnRefNo (it was used before)');
  if (opts.page && badUrl(b.pp_ReturnURL)) throw new JcError('110', 'Please provide a valid value for pp_ReturnURL');
  const expiry = parsePkt(asString(b.pp_TxnExpiryDateTime));
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: ref,
    secondaryRef: null,
    amount,
    currency: 'PKR',
    reference: asString(b.pp_BillReference),
    customerEmail: asString(b.ppmpf_email) ?? asString(b.pp_CustomerEmail),
    returnUrl: asString(b.pp_ReturnURL),
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: presetOutcome(c),
    request: b,
    providerData: {
      methods: opts.methods,
      txnType: asString(b.pp_TxnType) ?? '',
      txnDateTime: asString(b.pp_TxnDateTime) ?? pktStamp(),
      settlementExpiry: pktStamp(new Date(Date.now() + 72 * 3600_000)),
      phone: asString(b.pp_MobileNumber),
    },
    idempotencyKey: null,
    lint: lintCreate(b, amount, opts.page),
    expiresAt: (expiry && expiry.getTime() > Date.now() ? expiry : new Date(Date.now() + 24 * 3600_000)).toISOString(),
  });
  return p;
}

/** Relative URL of the stubyard page from the current request path. */
function pagePath(c: GatewayCtx, p: Payment): string {
  return '../'.repeat(Math.max(c.path.split('/').length - 2, 0)) + 'page/' + p.id;
}

async function merchantForm(c: GatewayCtx): Promise<unknown> {
  c.resolved.endpoint = 'page redirection';
  const b = bodyOf(c.req);
  credentials(c, b);
  const type = (asString(b.pp_TxnType) ?? '').toUpperCase();
  if (type && !TXN_METHODS[type]) throw new JcError('110', 'Please provide a valid value for pp_TxnType');
  const p = newPayment(c, b, { methods: type ? TXN_METHODS[type]! : ['wallet', 'card', 'voucher'], page: true });
  c.resolved.payment = p.id;
  return c.reply.redirect(pagePath(c, p), 303);
}

/** POST …/DoMWalletTransaction: no page, the outcome comes from the header / rules / default (wallet + OTP auto). */
async function walletPurchase(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'mobile account purchase';
  credentials(c, b);
  const phone = asString(b.pp_MobileNumber);
  if (!phone || !/^03\d{9}$/.test(phone)) throw new JcError('110', 'Please provide a valid value for pp_MobileNumber');
  if (!/^\d{6}$/.test(asString(b.pp_CNIC) ?? '')) throw new JcError('110', 'Please provide a valid value for pp_CNIC');
  let p = newPayment(c, { ...b, pp_TxnType: 'MWALLET' }, { methods: ['wallet'], page: false });
  c.resolved.payment = p.id;
  const r = await c.svc.complete(p, { via: 'api', method: 'wallet', phone: '+92' + phone.slice(1), otp: 'auto' });
  p = stamp(c.svc, r.payment);
  c.svc.repo.addEvent(p, 'jazzcash_wallet', { code: codeOf(p)[0] });
  const f = responseFields(p, c.inst);
  return { ...f, pp_MobileNumber: phone, pp_CNIC: String(b.pp_CNIC), pp_SecureHash: jazzcashSecureHash({ ...f, pp_MobileNumber: phone, pp_CNIC: String(b.pp_CNIC) }, String(c.inst.config.integritySalt ?? '')) };
}

async function inquire(c: GatewayCtx, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'status inquiry';
  credentials(c, b);
  const ref = asString(b.pp_TxnRefNo);
  const p0 = ref ? c.svc.repo.byInstanceRef(c.inst.id, ref) : null;
  if (!p0) throw new JcError('110', 'Please provide a valid value for pp_TxnRefNo');
  c.resolved.payment = p0.id;
  let p = await c.svc.touch(p0);
  p = stamp(c.svc, p);
  c.svc.repo.addEvent(p, 'status_queried', { via: 'inquire' });
  const [code, msg] = codeOf(p);
  return signed(c.inst, {
    pp_ResponseCode: '000',
    pp_ResponseMessage: 'Operation completed successfully.',
    pp_PaymentResponseCode: code,
    pp_PaymentResponseMessage: msg,
    pp_Status: statusWord(p),
    pp_TxnRefNo: p.providerRef,
    pp_Amount: String(p.amount),
    pp_RetreivalReferenceNo: String(p.providerData.rrn ?? ''),
    pp_AuthCode: String(p.providerData.authCode ?? ''),
    pp_SettlementExpiry: p.method === 'voucher' ? String(p.providerData.settlementExpiry ?? '') : '',
    pp_RefundedAmount: String(p.refunded),
  });
}

async function refund(c: GatewayCtx, b: Json, kind: 'wallet' | 'card'): Promise<unknown> {
  c.resolved.endpoint = kind + ' refund';
  credentials(c, b);
  const ref = asString(b.pp_TxnRefNo);
  const p0 = ref ? c.svc.repo.byInstanceRef(c.inst.id, ref) : null;
  if (!p0) throw new JcError('110', 'Please provide a valid value for pp_TxnRefNo');
  c.resolved.payment = p0.id;
  const raw = asString(b.pp_Amount);
  if (raw !== null && !/^\d+$/.test(raw)) throw new JcError('110', 'Please provide a valid value for pp_Amount');
  if ((asString(b.pp_TxnCurrency) ?? 'PKR').toUpperCase() !== 'PKR') throw new JcError('110', 'Please provide a valid value for pp_TxnCurrency');
  if (kind === 'wallet' && p0.method !== 'wallet') throw new JcError('110', 'Transaction ' + p0.providerRef + ' was not a mobile-account payment (use authorize/Refund for cards)');
  if (kind === 'card' && p0.method !== 'card') throw new JcError('110', 'Transaction ' + p0.providerRef + ' was not a card payment');
  const refundRef = 'R' + pktStamp() + digits(4);
  try {
    await c.svc.refund(p0, raw === null ? null : Number(raw), { providerRef: refundRef, reason: asString(b.pp_Description) });
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new JcError(e.statusCode === 409 ? '199' : '110', e.message);
    throw e;
  }
  return signed(c.inst, { pp_ResponseCode: '000', pp_ResponseMessage: SUCCESS_MSG, pp_TxnRefNo: p0.providerRef, pp_RefundTxnRefNo: refundRef });
}

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req } = c;
  const path = c.path.replace(/\/+$/, '').toLowerCase();
  if (req.method !== 'POST') throw new JcError('110', req.method + ' ' + c.path + ' is not simulated by stubyard', 404);
  if (path === '/customerportal/transactionmanagement/merchantform') return merchantForm(c);
  const b = bodyOf(req);
  if (/^\/applicationapi\/api\/(2\.0\/)?purchase\/domwallettransaction$/.test(path) || /^\/applicationapi\/api\/2\.0\/purchase\/domwallettxn$/.test(path)) return walletPurchase(c, b);
  if (/^\/applicationapi\/api\/(2\.0\/)?paymentinquiry\/inquire$/.test(path)) return inquire(c, b);
  if (/^\/applicationapi\/api\/(2\.0\/)?purchase\/domwalletrefundtransaction$/.test(path)) return refund(c, b, 'wallet');
  if (/^\/applicationapi\/api\/(2\.0\/)?authorize\/refund$/.test(path)) return refund(c, b, 'card');
  throw new JcError('110', 'POST ' + c.path + ' is not simulated by stubyard (CustomerPortal/transactionmanagement/merchantform, DoMWalletTransaction, PaymentInquiry/Inquire, domwalletrefundtransaction, authorize/Refund)', 404);
}

export const jazzcashGateway: Gateway = {
  preset: 'jazzcash',
  name: 'JazzCash',
  description: 'Page Redirection v1.1 / 2.0 with pp_SecureHash, mobile-account REST purchase, status inquiry, refunds and IPN; mobile wallet, card, voucher (PKR).',
  available: true,
  note: "JazzCash's merchant guides are behind its portal: paths and the decline codes follow public sandbox snippets and merchant SDKs.",
  kind: 'hpp',
  methods: ['wallet', 'card', 'voucher'],
  logo: 'JC',
  slugBase: 'jazzcash',
  otpSender: 'JazzCash',
  fields: [
    { key: 'merchantId', label: 'Merchant ID (pp_MerchantID)' },
    { key: 'password', label: 'Password (pp_Password)', secret: true },
    { key: 'integritySalt', label: 'Integrity salt', secret: true, hint: 'Key of pp_SecureHash (HMAC-SHA256) on requests, the return, the IPN and API answers' },
    { key: 'webhookUrl', label: 'IPN URL', hint: 'JazzCash posts the IPN here when a voucher or a pending wallet payment settles' },
  ],
  defaults: () => ({ merchantId: 'MC' + digits(5), password: alnum(10), integritySalt: alnum(10), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: () => true,
  retryOnDecline: false,
  entryPath: (p) => '/page/' + p.id,
  refundRef: () => 'R' + pktStamp() + digits(4),
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof JcError || (e instanceof HttpError && e.statusCode < 500)) {
        const code = e instanceof JcError ? e.code : '110';
        const status = e instanceof JcError ? e.status : (e as HttpError).statusCode;
        c.resolved.error = e.message;
        const salt = String(c.inst.config.integritySalt ?? '');
        const f: Record<string, string> = { pp_ResponseCode: code, pp_ResponseMessage: e.message };
        // A browser form with a usable return URL gets the error posted back, like the real page.
        if (c.path.toLowerCase().includes('merchantform')) {
          const b = bodyOf(c.req);
          const ret = httpUrl(b.pp_ReturnURL);
          if (ret) {
            const fields = { ...f, pp_TxnRefNo: String(b.pp_TxnRefNo ?? ''), pp_Amount: String(b.pp_Amount ?? ''), pp_BillReference: String(b.pp_BillReference ?? '') };
            return c.reply.status(200).type('text/html; charset=utf-8').send(renderFormPost(ret, { ...fields, pp_SecureHash: jazzcashSecureHash(fields, salt) }));
          }
        }
        return c.reply.status(status).send({ ...f, pp_SecureHash: jazzcashSecureHash(f, salt) });
      }
      throw e;
    }
  },
  returnTo: (svc, p0, inst) => {
    const ret = httpUrl(p0.returnUrl);
    if (!ret) return null;
    const p = stamp(svc, p0);
    return { kind: 'post', url: ret, fields: responseFields(p, inst) };
  },
  events: (p, point) => {
    if (point === 'settled') return ['ipn'];
    if ((point === 'failed' || point === 'expired') && (p.method === 'voucher' || p.method === 'wallet')) return ['ipn'];
    return [];
  },
  buildEvent: (svc, p0, inst) => {
    const p = stamp(svc, p0);
    const f = responseFields(p, inst);
    return { url: inst.config.webhookUrl ?? null, body: JSON.stringify(f), eventId: p.providerRef + ':' + f.pp_ResponseCode, signing: null };
  },
  shape: (_svc, p, inst) => ({ ...responseFields(p, inst), pp_Status: statusWord(p) }),
  providerStatus: (p) => {
    const [code, msg] = codeOf(p);
    return code + ' (' + statusWord(p) + ': ' + msg + ')';
  },
  lateLint: (svc, p, inst) => {
    if (['created', 'pending', 'requires_action'].includes(p.status)) return [];
    if (svc.repo.events(p.id).some((e) => e.type === 'status_queried')) return [];
    return [finding('pay.jazzcash-never-inquired', 'Transaction ' + p.providerRef + ' ended (' + codeOf(p)[0] + ') but PaymentInquiry/Inquire was never called; on ' + inst.slug + ' the return form alone is not proof of payment')];
  },
  connect: (inst, urls) => ({
    env: {
      JAZZCASH_MERCHANT_ID: String(inst.config.merchantId ?? ''),
      JAZZCASH_PASSWORD: String(inst.config.password ?? ''),
      JAZZCASH_INTEGRITY_SALT: String(inst.config.integritySalt ?? ''),
      JAZZCASH_BASE_URL: urls.backend,
      JAZZCASH_BASE_URL_LOCAL: urls.backendLocal,
      JAZZCASH_PAGE_URL: urls.browser + '/CustomerPortal/transactionmanagement/merchantform/',
    },
    notes: [
      'Replace https://sandbox.jazzcash.com.pk with JAZZCASH_BASE_URL (server calls) and post the browser form to JAZZCASH_PAGE_URL.',
      'pp_Amount is paisa (rupees × 100, digits only), pp_TxnCurrency PKR, pp_TxnDateTime / pp_TxnExpiryDateTime yyyyMMddHHmmss (Pakistan time).',
      'Verify pp_SecureHash on the return form and on the IPN; then confirm with PaymentInquiry/Inquire. pp_TxnType MWALLET / MPAY / OTC (empty: the buyer chooses).',
      'Vouchers (OTC) return 124 and settle later (IPN with 121); a delayed wallet payment returns 157.',
    ],
    snippets: [
      {
        title: 'Verify pp_SecureHash (Node)',
        lang: 'js',
        code: [
          "const crypto = require('node:crypto');",
          'function secureHash(fields, salt) {',
          "  const values = Object.keys(fields).filter((k) => /^pp/i.test(k) && k !== 'pp_SecureHash' && fields[k] !== '' && fields[k] != null).sort().map((k) => fields[k]);",
          "  return crypto.createHmac('sha256', salt).update([salt, ...values].join('&')).digest('hex').toUpperCase();",
          '}',
          'const ok = secureHash(body, process.env.JAZZCASH_INTEGRITY_SALT) === String(body.pp_SecureHash).toUpperCase();',
        ].join('\n'),
      },
      {
        title: 'Verify pp_SecureHash (PHP)',
        lang: 'php',
        code: [
          '$f = array_filter($_POST, fn($v, $k) => stripos($k, "pp") === 0 && $k !== "pp_SecureHash" && $v !== "", ARRAY_FILTER_USE_BOTH);',
          'ksort($f);',
          '$salt = getenv("JAZZCASH_INTEGRITY_SALT");',
          '$hash = strtoupper(hash_hmac("sha256", $salt . "&" . implode("&", $f), $salt));',
          '$ok = hash_equals($hash, strtoupper($_POST["pp_SecureHash"]));',
        ].join('\n'),
      },
    ],
  }),
};
