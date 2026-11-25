import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { asString, bodyOf, fixedBrowserBase, header } from '../common.js';
import { currencyDigits, fromDecimal, normalizeOutcome, OPEN, toDecimal } from '../engine.js';
import { finding, httpUrl, rejectUrl } from '../lint.js';
import { renderMerchantDemo } from '../pages.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod } from '../repo.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';
import { buildWidgetJs, widgetIntegrity } from './widget.js';

/**
 * Fake HyperPay (OPPWA) COPYandPAY under /pay/<project>/<instance>/…: POST /v1/checkouts (prepare, optional SRI
 * integrity), GET /v1/paymentWidgets.js (the widget: an iframe with the stubyard payment form), the shopper's return to
 * shopperResultUrl?id=…&resourcePath=…, GET /v1/checkouts/<id>/payment (result), backoffice POST /v1/payments/<id>
 * (CP capture, RV reversal, RF refund), GET /v1/query/<id> and AES-256-GCM encrypted webhooks.
 * Result codes and patterns follow hyperpay.docs.oppwa.com/reference/resultCodes. mada rules (own entityId,
 * mandatory KSA fields, no testMode) follow HyperPay KSA integration guides and could not be checked against an
 * official page.
 */

type Result = { code: string; description: string };
const r = (code: string, description: string): Result => ({ code, description });

/** Result codes stubyard emits, by meaning. */
export const HYPERPAY_RESULTS = {
  success: r('000.100.110', "Request successfully processed in 'Merchant in Integrator Test Mode'"),
  checkoutCreated: r('000.200.100', 'successfully created checkout'),
  pending: r('000.200.000', 'transaction pending'),
  generic: r('800.100.152', 'transaction declined by authorization system'),
  insufficient_funds: r('800.100.155', 'transaction declined (amount exceeds credit)'),
  incorrect_cvc: r('800.100.153', 'transaction declined (invalid CVV)'),
  expired_card: r('100.100.303', 'card expired'),
  authentication_failed: r('100.380.401', 'User Authentication Failed'),
  cancelled: r('100.396.101', 'Cancelled by user'),
  processing_error: r('900.100.300', 'timeout, uncertain result'),
  invalidAuth: r('800.900.300', 'invalid authentication information'),
  invalidParam: r('200.300.404', 'invalid or missing parameter'),
  noSession: r('200.300.404', 'invalid or missing parameter - (opp) No payment session found for the requested id - are you mixing test/live servers or have you paid more than 30min ago?'),
  cannotCapture: r('700.400.100', 'cannot capture (PA value exceeded, PA reverted or invalid workflow?)'),
  cannotRefund: r('700.400.200', 'cannot refund (refund volume exceeded or tx reversed or invalid workflow?)'),
  cannotReverse: r('700.400.300', 'cannot reverse (already refunded|reversed, invalid workflow or amount exceeded)'),
} as const;

/** The published result-code patterns (check result.code with these, never with equality). */
export const HYPERPAY_RESULT_PATTERNS = {
  success: /^(000\.000\.|000\.100\.1|000\.[36]|000\.400\.[1][12]0|000\.500\.)/,
  review: /^(000\.400\.0[^3]|000\.400\.100)/,
  pending: /^(000\.200)/,
  pendingDelayed: /^(800\.400\.5|100\.400\.500)/,
  rejected: /^(000\.400\.[1][0-9][1-9]|000\.400\.2|800\.[17]00|800\.800\.[123]|900\.[1234]00|000\.400\.030|800\.[56]|999\.|600\.1|800\.800\.[84]|100\.39[765]|300\.100\.100|100\.400\.[0-3]|100\.380\.100|100\.380\.11|100\.380\.4|100\.380\.5|100\.100|100\.2[01]|200\.[123]|100\.[53][07]|800\.900|100\.[69]00\.500|100\.310\.40[12]|700\.[1345][05]0)/,
};

export function hyperpayResultClass(code: string): 'success' | 'review' | 'pending' | 'rejected' | 'unknown' {
  const P = HYPERPAY_RESULT_PATTERNS;
  if (P.success.test(code)) return 'success';
  if (P.review.test(code)) return 'review';
  if (P.pending.test(code) || P.pendingDelayed.test(code)) return 'pending';
  if (P.rejected.test(code)) return 'rejected';
  return 'unknown';
}

class HpError extends Error {
  constructor(
    public status: number,
    public result: Result,
    public extra: Json = {},
  ) {
    super(result.description);
  }
}

const hex = (n: number) => randomBytes(n).toString('hex');
const BUILD_NUMBER = 'b8f4e3d1c2a5b6e7f8091a2b3c4d5e6f70819203@2026-11-01 10:00:00 +0000';
const timestamp = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '+0000');
const envelope = (ndc: string) => ({ buildNumber: BUILD_NUMBER, timestamp: timestamp(), ndc });
const paramError = (name: string, value: unknown, message: string) => new HpError(400, { ...HYPERPAY_RESULTS.invalidParam, parameterErrors: [{ name, value: value === undefined ? '' : String(value), message }] } as Result);

/** AES-256-GCM like HyperPay webhooks: hex body, hex IV and tag (uppercase). */
export function encryptHyperpayWebhook(keyHex: string, plain: string): { body: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { body: enc.toString('hex').toUpperCase(), iv: iv.toString('hex').toUpperCase(), tag: c.getAuthTag().toString('hex').toUpperCase() };
}

/** What your app does with a HyperPay webhook (exported for tests and the docs). */
export function decryptHyperpayWebhook(keyHex: string, bodyHex: string, ivHex: string, tagHex: string): string {
  // A short tag would weaken GCM's integrity check: insist on the full 16 bytes (32 hex characters).
  if (!/^[0-9a-f]{32}$/i.test(tagHex)) throw new Error('X-Authentication-Tag must be 32 hex characters');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'), { authTagLength: 16 });
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(bodyHex, 'hex')), d.final()]).toString('utf8');
}

const BRAND_METHOD: Record<string, PaymentMethod> = { VISA: 'card', MASTER: 'card', AMEX: 'card', MADA: 'mada', STC_PAY: 'stcpay', STCPAY: 'stcpay', APPLEPAY: 'applepay' };

function brandOf(p: Payment): string {
  if (p.method === 'mada') return 'MADA';
  if (p.method === 'stcpay') return 'STC_PAY';
  if (p.method === 'applepay') return 'APPLEPAY';
  const b = (p.cardBrand ?? 'visa').toLowerCase();
  return b === 'mastercard' ? 'MASTER' : b === 'amex' ? 'AMEX' : b === 'mada' ? 'MADA' : 'VISA';
}

function resultOf(p: Payment): Result {
  const R = HYPERPAY_RESULTS;
  switch (p.status) {
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return R.success;
    case 'authorized':
      // A declined PA: the engine keeps it approved for the capture to fail; HyperPay declines the PA itself.
      if (p.providerData.captureDecline) return (R as Record<string, Result>)[String(p.providerData.captureDecline)] ?? R.generic;
      return p.providerData.async ? R.pending : R.success;
    case 'failed': {
      const reason = String(p.providerData.declineReason ?? 'generic');
      return (R as Record<string, Result>)[reason] ?? R.generic;
    }
    case 'cancelled':
      return p.providerData.voided ? R.success : R.cancelled;
    case 'expired':
      return R.noSession;
    default:
      return R.pending;
  }
}

const isFinal = (p: Payment) => !OPEN.includes(p.status);

/** customer.* / billing.* form keys of the prepare call as objects. */
function group(req: Json, prefix: string): Json | undefined {
  const out: Json = {};
  for (const [k, v] of Object.entries(req)) if (k.startsWith(prefix + '.') && v !== '' && v !== undefined) out[k.slice(prefix.length + 1)] = v;
  return Object.keys(out).length ? out : undefined;
}

/** The payment as GET /v1/checkouts/<id>/payment and /v1/query/<id> return it (and the webhook payload). */
function paymentOf(svc: PaymentService, p: Payment): Json {
  const pd = p.providerData;
  const res = resultOf(p);
  if (!isFinal(p) || p.status === 'expired') return { result: res, ...envelope(String(pd.ndc)) };
  const out: Json = {
    id: pd.paymentId,
    paymentType: pd.paymentType,
    paymentBrand: brandOf(p),
    amount: toDecimal(p.amount, p.currency),
    currency: p.currency,
    descriptor: String(pd.descriptor),
    ...(p.reference ? { merchantTransactionId: p.reference } : {}),
    result: res,
    resultDetails: { ExtendedDescription: res.description, clearingInstituteName: 'stubyard simulator', ConnectorTxID1: String(pd.connectorTx), AcquirerResponse: hyperpayResultClass(res.code) === 'success' ? '00' : '05' },
  };
  if (p.method === 'card' || p.method === 'mada' || p.method === 'applepay') {
    const brand = brandOf(p);
    const u = p.testUserId ? svc.hub.users.get(p.projectId, p.testUserId) : null;
    out.card = {
      bin: brand === 'MASTER' ? '520000' : brand === 'MADA' ? '446404' : brand === 'AMEX' ? '378282' : '420000',
      last4Digits: p.cardLast4 ?? '0000',
      holder: u?.name ?? 'Jane Jones',
      expiryMonth: '12',
      expiryYear: String(new Date().getFullYear() + 3),
    };
  }
  const customer = group(p.request, 'customer');
  if (customer) out.customer = customer;
  const billing = group(p.request, 'billing');
  if (billing) out.billing = billing;
  if (p.request.customParameters) out.customParameters = p.request.customParameters;
  if (pd.threeDs) out.threeDSecure = pd.threeDs;
  out.risk = { score: '100' };
  const ops = (pd.ops as Json[] | undefined) ?? [];
  if (ops.length) out.stubyardBackofficeOperations = ops.map((o) => ({ id: o.id, paymentType: o.paymentType, amount: o.amount, result: o.result }));
  return { ...out, ...envelope(String(pd.ndc)) };
}

function auth(c: GatewayCtx): void {
  const m = /^Bearer\s+(.+)$/i.exec(header(c.req, 'authorization') ?? '');
  if (!m || !c.inst.config.accessToken || m[1]!.trim() !== c.inst.config.accessToken) throw new HpError(401, HYPERPAY_RESULTS.invalidAuth);
}

/** The entity of a request: must be the instance's card or mada entity (missing → 400, foreign → 401). */
function entityOf(c: GatewayCtx, value: unknown): { entityId: string; mada: boolean } {
  const e = asString(value);
  if (!e) throw paramError('entityId', value, 'may not be empty');
  const { entityId, madaEntityId } = c.inst.config;
  if (e !== entityId && e !== madaEntityId) throw new HpError(401, HYPERPAY_RESULTS.invalidAuth);
  return { entityId: e, mada: !!madaEntityId && e === madaEntityId && madaEntityId !== entityId };
}

const MADA_FIELDS = ['merchantTransactionId', 'customer.email', 'customer.givenName', 'customer.surname', 'billing.street1', 'billing.city', 'billing.state', 'billing.country', 'billing.postcode'];

/** POST /v1/checkouts (also used by the demo page, which skips the bearer check). */
/** `widgetBase`: the instance base the browser loads paymentWidgets.js from (the demo page uses its own request origin). */
async function prepare(c: GatewayCtx, b: Json, widgetBase?: string): Promise<{ p: Payment; body: Json }> {
  c.resolved.endpoint = 'prepare checkout';
  const ent = entityOf(c, b.entityId);
  const currency = (asString(b.currency) ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw paramError('currency', b.currency, 'must match ^[A-Z]{3}$');
  if (currencyDigits(currency) === null) {
    c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', `Unknown currency "${currency}"`));
    throw paramError('currency', b.currency, 'currency not supported');
  }
  const amt = fromDecimal(b.amount, currency);
  if (b.amount === undefined || b.amount === '' || !amt.ok || amt.minor < 0) throw paramError('amount', b.amount, 'must match ^[0-9]{1,12}(\\.[0-9]{2})?$');
  const type = (asString(b.paymentType) ?? '').toUpperCase();
  if (type !== 'DB' && type !== 'PA') throw paramError('paymentType', b.paymentType, 'must be DB (debit) or PA (preauthorization) for a checkout');
  const shopper = asString(b.shopperResultUrl);
  const why = rejectUrl(shopper);
  if (why) {
    c.svc.addInstanceLint(c.inst, finding('pay.return-url-missing-or-bad', `shopperResultUrl ${why}`));
    throw paramError('shopperResultUrl', shopper, 'must be an absolute http(s) URL');
  }
  let preset: string | null = null;
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (forced) {
    try {
      preset = normalizeOutcome(forced);
    } catch (e) {
      throw paramError('X-Hub-Payment-Outcome', forced, (e as Error).message);
    }
  }
  const lint: LintFinding[] = [];
  if (amt.minor <= 0) lint.push(finding('pay.amount-zero', `amount is ${String(b.amount)}`));
  if (amt.digits > (currencyDigits(currency) ?? 2)) lint.push(finding('pay.amount-precision', `amount ${String(b.amount)} has more decimals than ${currency} allows (${currencyDigits(currency)})`));
  const merchantTx = asString(b.merchantTransactionId);
  if (!merchantTx) lint.push(finding('pay.no-reference', 'No merchantTransactionId: the result and the webhook cannot be matched to your order'));
  const integrityWanted = String(b.integrity ?? '').toLowerCase() === 'true';
  if (!integrityWanted) lint.push(finding('pay.hyperpay-no-integrity', 'Checkout prepared without integrity=true: the widget script cannot be loaded with Subresource Integrity'));
  const testMode = asString(b.testMode);
  if (ent.mada) {
    const missing = MADA_FIELDS.filter((k) => !asString(b[k]));
    if (missing.length) lint.push(finding('pay.hyperpay-mada-missing-fields', `mada checkout without ${missing.join(', ')}`));
    if (testMode) lint.push(finding('pay.hyperpay-testmode-with-mada', `testMode=${testMode} sent on the mada entity`));
  }
  const checkoutId = `${hex(16).toUpperCase()}.uat01-vm-tx0${1 + (randomBytes(1)[0]! % 4)}`;
  const ndc = `${ent.entityId}_${hex(16)}`;
  // Brands the widget may offer: mada entity → mada only; card entity → everything else.
  const methods: PaymentMethod[] = ent.mada ? ['mada'] : ['card', 'stcpay', 'applepay', ...(c.inst.config.madaEntityId ? [] : (['mada'] as PaymentMethod[]))];
  const base = widgetBase ?? c.svc.base(c.project, c.inst);
  const integrity = integrityWanted ? widgetIntegrity(base, checkoutId) : null;
  const p = c.svc.create(c, {
    kind: 'hpp',
    providerRef: checkoutId,
    secondaryRef: hex(16),
    amount: amt.minor,
    currency,
    reference: merchantTx,
    customerEmail: asString(b['customer.email']),
    returnUrl: shopper,
    cancelUrl: null,
    callbackUrl: null,
    presetOutcome: preset,
    request: b,
    providerData: {
      entityId: ent.entityId,
      mada: ent.mada,
      paymentType: type,
      integrity,
      ...(widgetBase ? { widgetBase } : {}),
      testMode,
      methods,
      ndc,
      descriptor: `${String(1000 + (randomBytes(2).readUInt16BE(0) % 9000))}.${String(1000 + (randomBytes(2).readUInt16BE(0) % 9000))}.${String(1000 + (randomBytes(2).readUInt16BE(0) % 9000))} stubyard_Channel`,
      connectorTx: hex(8).toUpperCase(),
    },
    idempotencyKey: null,
    lint,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  // The payment id (used by backoffice operations and /v1/query) is the secondary ref.
  c.svc.repo.update(p.id, { providerData: { ...p.providerData, paymentId: p.secondaryRef } });
  const body: Json = { result: HYPERPAY_RESULTS.checkoutCreated, ...envelope(ndc), id: checkoutId, ...(integrity ? { integrity } : {}) };
  return { p: c.svc.repo.get(p.id)!, body };
}

function widget(c: GatewayCtx): unknown {
  c.resolved.endpoint = 'paymentWidgets.js';
  const id = asString(c.query.checkoutId);
  c.reply.header('access-control-allow-origin', '*').header('cross-origin-resource-policy', 'cross-origin').header('cache-control', 'no-store').type('application/javascript; charset=utf-8');
  const p = id ? c.svc.repo.byInstanceRef(c.inst.id, id) : null;
  if (!p || p.kind !== 'hpp') {
    c.resolved.error = 'unknown checkout';
    return c.reply.status(404).send(`/* stubyard: no HyperPay checkout "${String(id ?? '').replace(/\*\//g, '')}" on this instance */\nconsole.error('[stubyard] paymentWidgets.js: unknown or missing checkoutId');\n`);
  }
  c.resolved.payment = p.id;
  const mode = header(c.req, 'sec-fetch-mode');
  const origin = header(c.req, 'origin');
  // <script crossorigin="anonymous"> fetches in cors mode; without it SRI cannot be checked by the browser.
  const noCors = mode ? mode !== 'cors' : !origin;
  c.svc.repo.addEvent(p, 'widget_loaded', { secFetchMode: mode, origin, sri: !noCors && !!p.providerData.integrity });
  if (noCors) c.svc.addLint(p, [finding('pay.hyperpay-no-integrity', `paymentWidgets.js was fetched ${mode ? `with Sec-Fetch-Mode: ${mode}` : 'without an Origin'}: add integrity="…" crossorigin="anonymous" to the script tag`)]);
  c.svc.changed(p.projectId, { payment: p.id });
  // The SRI hash covers the frame URL: rebuild with the base the checkout was prepared for.
  return c.reply.send(buildWidgetJs(asString(p.providerData.widgetBase) ?? c.svc.base(c.project, c.inst), p.providerRef));
}

async function findCheckout(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p || p.providerRef !== id) throw new HpError(400, HYPERPAY_RESULTS.noSession);
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

/** Status reads: lint over-polling (more than 2 a minute for a checkout / payment). */
function noteQuery(c: GatewayCtx, p: Payment, what: 'status' | 'query'): Payment {
  const now = Date.now();
  const recent = c.svc.repo.events(p.id).filter((e) => e.type === 'status_queried' && now - Date.parse(e.createdAt) < 60_000).length;
  c.svc.repo.addEvent(p, 'status_queried', { via: what, status: p.status });
  let out = p;
  if (recent >= 2) out = c.svc.addLint(p, [finding('pay.hyperpay-result-overpolled', `${recent + 1} ${what === 'status' ? 'payment-status' : 'query'} requests within a minute (HyperPay allows 2)`)]);
  c.svc.changed(p.projectId, { payment: p.id });
  return out;
}

const httpOf = (res: Result) => (hyperpayResultClass(res.code) === 'rejected' ? 400 : 200);

async function status(c: GatewayCtx, id: string): Promise<unknown> {
  c.resolved.endpoint = 'payment status';
  auth(c);
  let p = await findCheckout(c, id);
  const ent = entityOf(c, c.query.entityId);
  if (ent.entityId !== p.providerData.entityId) throw new HpError(401, HYPERPAY_RESULTS.invalidAuth);
  p = noteQuery(c, p, 'status');
  const body = paymentOf(c.svc, p);
  return c.reply.status(httpOf((body.result as Result) ?? HYPERPAY_RESULTS.pending)).send(body);
}

async function query(c: GatewayCtx, id: string): Promise<unknown> {
  c.resolved.endpoint = 'transaction report';
  auth(c);
  const p0 = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p0) throw new HpError(400, { ...HYPERPAY_RESULTS.invalidParam, description: 'invalid or missing parameter - no payment found for the id' });
  c.resolved.payment = p0.id;
  let p = await c.svc.touch(p0);
  entityOf(c, c.query.entityId);
  p = noteQuery(c, p, 'query');
  return paymentOf(c.svc, p);
}

/** POST /v1/payments/<paymentId>: CP capture (of a PA), RV reversal, RF refund. */
async function backoffice(c: GatewayCtx, id: string, b: Json): Promise<unknown> {
  auth(c);
  const p0 = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p0 || p0.secondaryRef !== id) throw new HpError(400, { ...HYPERPAY_RESULTS.invalidParam, description: 'invalid or missing parameter - referenced payment not found' });
  c.resolved.payment = p0.id;
  let p = await c.svc.touch(p0);
  entityOf(c, b.entityId);
  const type = (asString(b.paymentType) ?? '').toUpperCase();
  c.resolved.endpoint = `backoffice ${type || '?'}`;
  if (!['CP', 'RV', 'RF'].includes(type)) throw paramError('paymentType', b.paymentType, 'must be CP, RV or RF for a backoffice operation');
  const currency = (asString(b.currency) ?? p.currency).toUpperCase();
  if (currency !== p.currency) throw paramError('currency', b.currency, `must be ${p.currency} (the currency of the referenced payment)`);
  let minor: number | null = null;
  if (b.amount !== undefined && b.amount !== '') {
    const a = fromDecimal(b.amount, currency);
    if (!a.ok || a.minor <= 0) throw paramError('amount', b.amount, 'must match ^[0-9]{1,12}(\\.[0-9]{2})?$');
    minor = a.minor;
  } else if (type !== 'RV') throw paramError('amount', b.amount, 'may not be empty');
  const opId = hex(16);
  let res: Result = HYPERPAY_RESULTS.success;
  if (type === 'CP') {
    if (p.providerData.paymentType !== 'PA') res = HYPERPAY_RESULTS.cannotCapture;
    else {
      const out = await c.svc.capture(p, { idempotencyKey: opId, amount: minor, final: true });
      p = out.payment;
      if (out.error === 'declined') res = (HYPERPAY_RESULTS as Record<string, Result>)[out.reason ?? 'generic'] ?? HYPERPAY_RESULTS.generic;
      else if (out.error) res = HYPERPAY_RESULTS.cannotCapture;
    }
  } else if (type === 'RV') {
    try {
      if (p.status === 'authorized' && !p.providerData.captured) p = await c.svc.voidPayment(p, { webhook: true });
      else if (p.status === 'paid' && !p.refunded) p = (await c.svc.refund(p, null, { providerRef: opId, reason: 'reversal' })).payment;
      else res = HYPERPAY_RESULTS.cannotReverse;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      res = HYPERPAY_RESULTS.cannotReverse;
    }
  } else {
    try {
      p = (await c.svc.refund(p, minor, { providerRef: opId, reason: asString(b.descriptor) })).payment;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      p = c.svc.repo.get(p.id) ?? p;
      res = HYPERPAY_RESULTS.cannotRefund;
    }
  }
  const amount = toDecimal(minor ?? (type === 'RV' ? p.amount : 0), p.currency);
  const op = { id: opId, paymentType: type, amount, currency: p.currency, result: res, at: new Date().toISOString() };
  p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, ops: [...((p.providerData.ops as Json[] | undefined) ?? []), op] } });
  c.svc.repo.addEvent(p, `hyperpay_${type.toLowerCase()}`, { id: opId, amount, code: res.code });
  c.svc.changed(p.projectId, { payment: p.id });
  const body = { id: opId, referencedId: id, paymentType: type, amount, currency: p.currency, descriptor: String(p.providerData.descriptor), result: res, resultDetails: { ExtendedDescription: res.description }, ...envelope(String(p.providerData.ndc)) };
  return c.reply.status(httpOf(res)).send(body);
}

/** GET /demo: a merchant page that prepares a checkout and shows the widget; /demo/result reads the result. */
async function demo(c: GatewayCtx, sub: string): Promise<unknown> {
  const send = (d: { html: string; csp: string }) => c.reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', d.csp).send(d.html);
  c.resolved.endpoint = `demo${sub}`;
  // The demo opens in the browser: use the origin it was opened on (STUBYARD_PUBLIC_URL wins), not a fixed localhost:4443.
  const pageBase = demoBase(c);
  if (sub === '/result') {
    const id = asString(c.query.id);
    let p = id ? c.svc.repo.byInstanceRef(c.inst.id, id) : null;
    if (p) {
      p = noteQuery(c, await c.svc.touch(p), 'status');
      c.resolved.payment = p.id;
    }
    const body = p ? paymentOf(c.svc, p) : { result: HYPERPAY_RESULTS.noSession };
    const code = String((body.result as Result).code);
    return send(
      renderMerchantDemo({
        title: 'HyperPay demo shop: result',
        presetName: 'HyperPay',
        html: `<p>Your server reads <code>GET {resourcePath}?entityId=…</code> and checks <code>result.code</code> against the patterns. Class: <b data-testid="stubyard-demo-class">${hyperpayResultClass(code)}</b>.</p><pre data-testid="stubyard-demo-result">${escHtml(JSON.stringify(body, null, 2))}</pre><p><a class="btn" href="${escHtml(pageBase)}/demo">Start another payment</a></p>`,
      }),
    );
  }
  const amount = /^\d{1,9}(\.\d{1,3})?$/.test(String(c.query.amount ?? '')) ? String(c.query.amount) : '25.00';
  const currency = /^[A-Za-z]{3}$/.test(String(c.query.currency ?? '')) ? String(c.query.currency).toUpperCase() : 'SAR';
  const mada = c.query.brand === 'mada' && !!c.inst.config.madaEntityId;
  const { p, body } = await prepare(c, {
    entityId: mada ? c.inst.config.madaEntityId : c.inst.config.entityId,
    amount,
    currency,
    paymentType: c.query.paymentType === 'PA' ? 'PA' : 'DB',
    merchantTransactionId: `demo-${hex(4)}`,
    integrity: 'true',
    'customer.email': 'buyer@example.com',
    'customer.givenName': 'Demo',
    'customer.surname': 'Buyer',
    'billing.street1': 'King Fahd Road',
    'billing.city': 'Riyadh',
    'billing.state': 'Riyadh',
    'billing.country': 'SA',
    'billing.postcode': '12211',
  }, pageBase);
  c.resolved.payment = p.id;
  const brands = mada ? 'MADA' : c.inst.config.madaEntityId ? 'VISA MASTER STC_PAY APPLEPAY' : 'VISA MASTER MADA STC_PAY APPLEPAY';
  const script = `${pageBase}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(String(body.id))}`;
  return send(
    renderMerchantDemo({
      title: 'HyperPay demo shop',
      presetName: 'HyperPay',
      html: `<p>A merchant page using COPYandPAY: the server prepared checkout <code>${escHtml(String(body.id))}</code> (${escHtml(amount)} ${escHtml(currency)}, ${mada ? 'mada entity' : 'card entity'}) and the page loads the widget with SRI.</p>
<p class="row"><a class="btn" href="${escHtml(pageBase)}/demo?brand=mada">mada checkout</a><a class="btn" href="${escHtml(pageBase)}/demo?paymentType=PA">PA (authorize only)</a></p>
<form action="${escHtml(pageBase)}/demo/result" class="paymentWidgets" data-brands="${brands}"></form>`,
      inline: 'var wpwlOptions = { onReady: function () { document.body.setAttribute("data-wpwl-ready", "1"); } };',
      scripts: [{ src: script, integrity: String(body.integrity), crossorigin: 'anonymous' }],
    }),
  );
}

/** Instance base on the demo request's own origin (proto from X-Forwarded-Proto, else the socket); STUBYARD_PUBLIC_URL wins. */
function demoBase(c: GatewayCtx): string {
  if (c.hub.config.publicUrl || fixedBrowserBase(c.inst)) return c.base;
  const host = String(c.req.headers.host ?? '');
  const fwd = String(c.req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
  const proto = fwd === 'http' || fwd === 'https' ? fwd : c.req.protocol;
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) return c.base;
  return `${proto}://${host}${c.svc.instancePath(c.project, c.inst)}`;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  let mm: RegExpExecArray | null;
  if ((mm = /^\/widget\/([^/]+)$/.exec(path)) && (m === 'GET' || m === 'HEAD')) {
    const p = c.svc.repo.byInstanceRef(c.inst.id, decodeURIComponent(mm[1]!));
    if (!p) throw new HttpError(404, 'Unknown HyperPay checkout');
    c.resolved.endpoint = 'widget frame';
    c.resolved.payment = p.id;
    const qs = new URLSearchParams(Object.entries(c.query).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)])))).toString();
    return c.reply.redirect(`../page/${p.id}${qs ? '?' + qs : ''}`, 302);
  }
  if (path === '/v1/paymentWidgets.js' && (m === 'GET' || m === 'HEAD')) return widget(c);
  if ((path === '/demo' || path === '/demo/result') && m === 'GET') return demo(c, path.slice(5));
  if (path === '/v1/checkouts' && m === 'POST') {
    auth(c);
    const { body } = await prepare(c, bodyOf(req));
    return body;
  }
  if ((mm = /^\/v1\/checkouts\/([^/]+)\/payment$/.exec(path)) && m === 'GET') return status(c, decodeURIComponent(mm[1]!));
  if ((mm = /^\/v1\/payments\/([^/]+)$/.exec(path)) && m === 'POST') return backoffice(c, decodeURIComponent(mm[1]!), bodyOf(req));
  if ((mm = /^\/v1\/query\/([^/]+)$/.exec(path)) && m === 'GET') return query(c, decodeURIComponent(mm[1]!));
  throw new HpError(404, { ...HYPERPAY_RESULTS.invalidParam, description: `${m} ${path} is not simulated by stubyard (POST /v1/checkouts, GET /v1/paymentWidgets.js, GET /v1/checkouts/{id}/payment, POST /v1/payments/{id}, GET /v1/query/{id})` });
}

const randomToken = () => Buffer.from(`${hex(16)}:${randomBytes(9).toString('base64url')}`).toString('base64');

export const hyperpayGateway: Gateway = {
  preset: 'hyperpay',
  name: 'HyperPay',
  description: 'COPYandPAY: prepare a checkout, the paymentWidgets.js widget (SRI integrity), result via resourcePath, backoffice capture / reverse / refund, AES-256-GCM encrypted webhooks; cards, mada, STC Pay, Apple Pay.',
  available: true,
  note: 'Result codes follow the OPPWA reference. mada rules (separate entity, KSA fields, no testMode) are from HyperPay integration guides and could not be checked against an official page.',
  kind: 'hpp',
  methods: ['card', 'mada', 'stcpay', 'applepay'],
  fields: [
    { key: 'accessToken', label: 'Access token', secret: true, hint: 'Authorization: Bearer …' },
    { key: 'entityId', label: 'Entity ID', hint: 'VISA / MASTER / STC_PAY / APPLEPAY checkouts' },
    { key: 'madaEntityId', label: 'mada entity ID', hint: 'mada checkouts must use this one' },
    { key: 'webhookKey', label: 'Webhook decryption key', secret: true, hint: '64 hex chars (AES-256-GCM)' },
    { key: 'webhookUrl', label: 'Webhook URL', hint: 'Your app endpoint for encrypted notifications' },
  ],
  defaults: () => ({ accessToken: randomToken(), entityId: hex(16), madaEntityId: hex(16), webhookKey: hex(32).toUpperCase(), webhookDelayMs: 500, magicAmounts: false }),
  capturesOnApprove: (p) => p.providerData.paymentType !== 'PA',
  retryOnDecline: false,
  entryPath: (p) => `/widget/${encodeURIComponent(p.providerRef)}`,
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof HpError) {
        c.resolved.error = e.result.description;
        c.resolved.resultCode = e.result.code;
        return c.reply.status(e.status).send({ result: e.result, ...envelope(`${String(c.inst.config.entityId ?? '')}_${hex(16)}`), ...e.extra });
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        return c.reply.status(e.statusCode).send({ result: { code: HYPERPAY_RESULTS.invalidParam.code, description: e.message }, ...envelope(hex(16)) });
      }
      throw e;
    }
  },
  pageOpen: (svc, p, query) => {
    if (query.embed !== '1') return p;
    const brands = String(query.brands ?? '').toUpperCase().split(/[\s,]+/).filter(Boolean);
    const offered = (p.providerData.methods as PaymentMethod[] | undefined) ?? ['card', 'mada', 'stcpay', 'applepay'];
    const wanted = [...new Set(brands.map((b) => BRAND_METHOD[b]).filter((x): x is PaymentMethod => !!x))];
    // data-brands narrows the methods; brands the entity cannot take (MADA on the card entity…) still show, so the lint can fire.
    const methods = wanted.length ? wanted : offered;
    const result = httpUrl(query.result);
    const patch: Partial<Payment> = { providerData: { ...p.providerData, methods, widget: { brands, embedded: true } } };
    if (result && result !== p.returnUrl) patch.returnUrl = result;
    let out = svc.repo.update(p.id, patch);
    if (!result) out = svc.addLint(out, [finding('pay.return-url-missing-or-bad', `form.paymentWidgets action ${query.result ? 'is not an absolute http(s) URL' : 'is missing'}`)]);
    return out;
  },
  afterComplete: (svc, p, inst) => {
    if (!inst.config.madaEntityId || inst.config.madaEntityId === inst.config.entityId || !p.method) return;
    const madaPay = p.method === 'mada' || p.cardBrand === 'mada';
    if (madaPay && !p.providerData.mada) svc.addLint(p, [finding('pay.hyperpay-mada-entity', 'A mada payment on a checkout prepared with the card entityId (use madaEntityId)')]);
    if (!madaPay && p.providerData.mada) svc.addLint(p, [finding('pay.hyperpay-mada-entity', `A ${brandOf(p)} payment on a checkout prepared with the mada entityId`)]);
  },
  returnTo: (_svc, p) => {
    const ret = httpUrl(p.returnUrl);
    if (!ret) return null;
    const u = new URL(ret);
    u.searchParams.set('id', p.providerRef);
    u.searchParams.set('resourcePath', `/v1/checkouts/${p.providerRef}/payment`);
    return { kind: 'redirect', url: u.toString() };
  },
  events: (_p, point) => (point === 'expired' ? [] : ['PAYMENT']),
  buildEvent: (svc, p, inst, type) => {
    const plain = JSON.stringify({ type, payload: paymentOf(svc, p) });
    const eventId = `${String(p.providerData.paymentId)}:${p.status}:${Date.now()}`;
    const key = String(inst.config.webhookKey ?? '');
    if (!/^[0-9a-fA-F]{64}$/.test(key)) return { url: inst.config.webhookUrl ?? null, body: plain, eventId, signing: null };
    const enc = encryptHyperpayWebhook(key, plain);
    return { url: inst.config.webhookUrl ?? null, body: enc.body, eventId, signing: null, headers: { 'content-type': 'text/plain', 'x-initialization-vector': enc.iv, 'x-authentication-tag': enc.tag }, plain };
  },
  shape: (svc, p) => ({ checkoutId: p.providerRef, payment: paymentOf(svc, p) }),
  providerStatus: (p) => {
    const res = resultOf(p);
    return `${res.code} (${hyperpayResultClass(res.code)})`;
  },
  connect: (inst, urls) => ({
    env: {
      HYPERPAY_BASE_URL: urls.backend + '/',
      HYPERPAY_BASE_URL_LOCAL: urls.backendLocal + '/',
      HYPERPAY_WIDGET_BASE: urls.browser + '/',
      HYPERPAY_ACCESS_TOKEN: inst.config.accessToken ?? '',
      HYPERPAY_ENTITY_ID: inst.config.entityId ?? '',
      HYPERPAY_MADA_ENTITY_ID: inst.config.madaEntityId ?? '',
      HYPERPAY_WEBHOOK_KEY: inst.config.webhookKey ?? '',
    },
    notes: [
      'Use HYPERPAY_BASE_URL instead of https://eu-test.oppwa.com/ on your server: POST {base}v1/checkouts (form body: entityId, amount, currency, paymentType DB|PA, merchantTransactionId, customer.*, billing.*, integrity=true) with Authorization: Bearer <access token>.',
      'In the browser load {widget base}v1/paymentWidgets.js?checkoutId=<id> with integrity="<integrity>" crossorigin="anonymous" and a <form action="<shopperResultUrl>" class="paymentWidgets" data-brands="VISA MASTER MADA">.',
      'The shopper returns to shopperResultUrl?id=<checkout>&resourcePath=/v1/checkouts/<id>/payment; GET {base}<resourcePath>?entityId=… (at most twice a minute) and test result.code with the patterns: success ^(000\\.000\\.|000\\.100\\.1|000\\.[36]|000\\.400\\.[1][12]0|000\\.500\\.), pending ^(000\\.200), review ^(000\\.400\\.0[^3]|000\\.400\\.100); anything else is a rejection.',
      'mada checkouts use HYPERPAY_MADA_ENTITY_ID (stubyard flags a mada payment on the card entity), need merchantTransactionId, customer and billing fields and no testMode.',
      'Backoffice: POST {base}v1/payments/<payment id> with paymentType CP (capture a PA), RV (reverse) or RF (refund) and amount, currency, entityId.',
      'Webhooks are AES-256-GCM encrypted (text/plain hex body, X-Initialization-Vector, X-Authentication-Tag; key = HYPERPAY_WEBHOOK_KEY) and decrypt to {"type":"PAYMENT","payload":{…}}.',
      'Try it in a browser: {widget base}demo.',
    ],
    snippets: [
      {
        title: 'Prepare a checkout (server)',
        lang: 'bash',
        code: `curl ${urls.backendLocal}/v1/checkouts \\\n  -H 'Authorization: Bearer ${inst.config.accessToken ?? ''}' \\\n  -d entityId=${inst.config.entityId ?? ''} -d amount=92.00 -d currency=SAR -d paymentType=DB \\\n  -d merchantTransactionId=order-1 -d customer.email=buyer@example.com -d integrity=true`,
      },
      {
        title: 'Widget (page)',
        lang: 'html',
        code: `<script>var wpwlOptions = { onReady: function () {} };</script>\n<script src="${urls.browser}/v1/paymentWidgets.js?checkoutId={checkoutId}" integrity="{integrity}" crossorigin="anonymous"></script>\n<form action="https://your-shop.example/payment/result" class="paymentWidgets" data-brands="VISA MASTER MADA STC_PAY APPLEPAY"></form>`,
      },
      {
        title: 'Decrypt a webhook (Node)',
        lang: 'js',
        code: `const tag = String(req.headers['x-authentication-tag'] ?? '');\nif (!/^[0-9a-f]{32}$/i.test(tag)) throw new Error('bad X-Authentication-Tag');\nconst d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(process.env.HYPERPAY_WEBHOOK_KEY, 'hex'), Buffer.from(req.headers['x-initialization-vector'], 'hex'), { authTagLength: 16 });\nd.setAuthTag(Buffer.from(tag, 'hex'));\nconst event = JSON.parse(Buffer.concat([d.update(Buffer.from(rawBody, 'hex')), d.final()]).toString('utf8'));`,
      },
    ],
  }),
};
