import { createHash, createVerify } from 'node:crypto';
import { generateSigningKey } from '../../auth/keys.js';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bodyOf, header, IdempotencyCache, upper } from '../common.js';
import { currencyDigits, fromDecimal, normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance, PaymentMethod, PaymentToken } from '../repo.js';
import { paypalSignedString } from '../../webhooks/signing.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';
import { authorizationOf, authorizationOfPayment, authorizationRoute, authorizeOrder, cardSourceOf, completeCard, intentOf, liabilityCheck, parseCardSource, processorResponse, startCardOrder } from './expanded.js';
import { sdkRoute } from './sdk.js';
import { paypalDemo } from '../sdk/demos.js';
import { checkSdkOrigin } from '../sdk/runtime.js';
import { htmlReply, renderSdkError } from '../sdk/wallet.js';
import { hasIdTokenRequest, vaultAttributes, vaultOnSuccess, vaultRoute, vaultToken } from './vault.js';
import { disputesApiRoute } from './disputes.js';
import { saleEventResource, subscriptionApproved, subscriptionPageRoute, subscriptionPaymentEvents, subscriptionPaymentStatus, subscriptionReturn, subscriptionsApiRoute, saleOf } from './subscriptions.js';

/** Subscription payments (approval charge, revision approval, billed cycles): sales, not orders. */
const isSubPayment = (p: Payment) => !!p.providerData.subscription;

/**
 * Fake PayPal (Orders v2, intents CAPTURE and AUTHORIZE; Payments 1b adds cards / 3DS / authorizations in expanded.ts,
 * the JS SDK in sdk.ts and Vault v3 in vault.ts) under /pay/<project>/<instance>/…: OAuth client-credentials token, orders
 * create / get / capture, captures get / refund, refunds get, verify-webhook-signature and the cert URL, the buyer
 * approval page /checkoutnow?token=<order>, PayPal-Request-Id replay and the PayPal-Mock-Response header.
 */

/** scope "sdk": the JS SDK's facilitatorAccessToken, handed to the browser; refused by the server API (bearer). */
const tokens = new Map<string, { instanceId: string; expires: number; scope: 'server' | 'sdk' }>();
const idem = new Map<string, IdempotencyCache>();
const debugId = () => alnum(13).toLowerCase();

export class PpError extends Error {
  constructor(
    public status: number,
    public body: Json,
  ) {
    super(String(body.message ?? body.error_description ?? body.name));
  }
}

export function unprocessable(issue: string, description: string, link?: string): PpError {
  return new PpError(422, {
    name: 'UNPROCESSABLE_ENTITY',
    details: [{ issue, description }],
    message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
    debug_id: debugId(),
    links: [{ href: `https://developer.paypal.com/docs/api/orders/v2/#error-${link ?? issue}`, rel: 'information_link', method: 'GET' }],
  });
}
export function invalidRequest(field: string, issue: string, description: string): PpError {
  return new PpError(400, { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', debug_id: debugId(), details: [{ field, location: 'body', issue, description }], links: [] });
}
export const notFound = (what = 'The specified resource does not exist.') => new PpError(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID', description: what }], message: 'The specified resource does not exist.', debug_id: debugId(), links: [] });
const unauthorized = () => new PpError(401, { error: 'invalid_token', error_description: 'Token signature verification failed' });

function bearer(c: GatewayCtx): void {
  const h = header(c.req, 'authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) throw new PpError(401, { error: 'invalid_token', error_description: 'No access token found' });
  const t = tokens.get(m[1]!.trim());
  // A browser-side token never works on the server API (also not through the lenient A21AA… rule below).
  if (t?.scope === 'sdk') throw new PpError(401, { error: 'invalid_token', error_description: 'This token was issued to the JS SDK (facilitatorAccessToken) and is only valid for the SDK endpoints; get a server token from POST /v1/oauth2/token' });
  if (t && t.instanceId === c.inst.id && t.expires > Date.now()) return;
  if (!c.inst.config.strictKeys && /^A21AA/.test(m[1]!.trim())) return;
  throw unauthorized();
}

function token(c: GatewayCtx): unknown {
  c.resolved.endpoint = 'oauth2 token';
  const h = header(c.req, 'authorization') ?? '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  const [id, secret] = m ? Buffer.from(m[1]!, 'base64').toString('utf8').split(':') : [];
  const b = bodyOf(c.req);
  if (!id || !secret) throw new PpError(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
  if (c.inst.config.strictKeys && (id !== c.inst.config.clientId || secret !== c.inst.config.clientSecret)) throw new PpError(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
  if (String(b.grant_type ?? '') !== 'client_credentials') throw new PpError(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
  const access = issueAccessToken(c.inst.id);
  const idToken = hasIdTokenRequest(b) ? idTokenOf(c, asString(b.target_customer_id)) : null;
  return {
    ...(idToken ? { id_token: idToken } : {}),
    scope: 'https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/checkout/one-click-with-merchant-issued-token',
    access_token: access,
    token_type: 'Bearer',
    app_id: `APP-${upper(17)}`,
    expires_in: 32400,
    nonce: `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}${alnum(43)}`,
  };
}

/**
 * A bearer token for this instance: scope "server" from OAuth (9 h, the server API), scope "sdk" for the JS SDK's
 * facilitatorAccessToken (15 min, rejected outside /sdk/*).
 */
export function issueAccessToken(instanceId: string, scope: 'server' | 'sdk' = 'server'): string {
  const access = `A21AA${alnum(80)}`;
  tokens.set(access, { instanceId, scope, expires: Date.now() + (scope === 'sdk' ? 900_000 : 32_400_000) });
  if (tokens.size > 5000) tokens.delete(tokens.keys().next().value!);
  return access;
}

/** response_type=id_token: the JS SDK's data-user-id-token for returning (vaulted) payers. Unsigned stand-in JWT. */
function idTokenOf(c: GatewayCtx, customerId: string | null): string {
  const b64 = (o: Json) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'RS256', kid: 'stubyard', typ: 'JWT' })}.${b64({ iss: c.svc.urls(c.project, c.inst).backend, sub: customerId ?? `customer_${alnum(10).toLowerCase()}`, aud: c.inst.config.clientId ?? '', iat: now, exp: now + 900, stubyard: true })}.${alnum(43)}`;
}

export const certUrlOf = (svc: PaymentService, inst: PaymentInstance) => {
  const project = svc.hub.projects.get(inst.projectId)!;
  return `${svc.urls(project, inst).backend}/v1/notifications/certs/CERT-360caa42-fca2a594-${createHash('sha256').update(inst.id).digest('hex').slice(0, 8)}`;
};

export const money = (p: Payment, minor = p.amount) => ({ currency_code: p.currency, value: toDecimal(minor, p.currency) });

export function orderStatus(p: Payment): string {
  switch (p.status) {
    case 'authorized':
      return p.providerData.captured || p.providerData.authorization ? 'COMPLETED' : 'APPROVED';
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return 'COMPLETED';
    case 'failed':
      // Cards: the order completes with a DECLINED capture / DENIED authorization.
      return p.method === 'card' && (p.providerData.captureDecline || p.providerData.authorization) ? 'COMPLETED' : 'VOIDED';
    case 'expired':
      return 'VOIDED';
    case 'cancelled':
      if (p.providerData.authorization) return 'COMPLETED';
      return p.providerData.experience ? 'PAYER_ACTION_REQUIRED' : 'CREATED';
    default:
      return p.providerData.experience || p.providerData.payerAction ? 'PAYER_ACTION_REQUIRED' : 'CREATED';
  }
}

function captureStatus(p: Payment): string {
  if (p.status === 'refunded') return 'REFUNDED';
  if (p.status === 'partially_refunded') return 'PARTIALLY_REFUNDED';
  if (p.status === 'failed') return 'DECLINED';
  if (p.status === 'authorized' && p.providerData.captured) return 'PENDING';
  return 'COMPLETED';
}

const hasCapture = (p: Payment) => (authorizationOfPayment(p)?.captures.length ?? 0) > 0 || !!p.providerData.captured || ['paid', 'partially_refunded', 'refunded'].includes(p.status) || (p.status === 'failed' && !!p.providerData.captureDecline);

function links(svc: PaymentService, p: Payment, inst: PaymentInstance): Json[] {
  const project = svc.hub.projects.get(p.projectId)!;
  const api = svc.urls(project, inst).backend;
  const self = { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'self', method: 'GET' };
  const st = orderStatus(p);
  const next = intentOf(p) === 'AUTHORIZE' ? 'authorize' : 'capture';
  const act = { href: `${api}/v2/checkout/orders/${p.providerRef}/${next}`, rel: next, method: 'POST' };
  if (st === 'CREATED' || st === 'PAYER_ACTION_REQUIRED') {
    if (p.providerData.payerAction) return [self, { href: `${svc.base(project, inst)}/sdk/challenge/${p.id}`, rel: 'payer-action', method: 'GET' }];
    if (p.method === 'card') return [self, { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'update', method: 'PATCH' }, act];
    return [self, { href: svc.entryUrl(project, inst, p), rel: p.providerData.experience ? 'payer-action' : 'approve', method: 'GET' }, { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'update', method: 'PATCH' }, act];
  }
  if (st === 'APPROVED') return [self, { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'update', method: 'PATCH' }, act];
  return [self];
}

export function captureOf(svc: PaymentService, p: Payment, inst: PaymentInstance, captureId?: string): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const api = svc.urls(project, inst).backend;
  const auth = authorizationOfPayment(p);
  const rec = auth ? (auth.captures.find((x) => x.id === (captureId ?? String(p.providerData.captureId))) ?? auth.captures.at(-1)) : undefined;
  if (rec) return authCaptureOf(svc, p, api, rec);
  const id = String(p.providerData.captureId);
  const fee = Math.round(p.amount * 0.0349) + (currencyDigits(p.currency) === 0 ? 49 : 49);
  const unit = (p.request.purchase_units as Json[] | undefined)?.[0] ?? {};
  const out: Json = {
    id,
    status: captureStatus(p),
    amount: money(p),
    final_capture: true,
    seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
    seller_receivable_breakdown: { gross_amount: money(p), paypal_fee: money(p, Math.min(fee, p.amount)), net_amount: money(p, Math.max(0, p.amount - fee)) },
    links: [
      { href: `${api}/v2/payments/captures/${id}`, rel: 'self', method: 'GET' },
      { href: `${api}/v2/payments/captures/${id}/refund`, rel: 'refund', method: 'POST' },
      { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'up', method: 'GET' },
    ],
    create_time: p.updatedAt,
    update_time: p.updatedAt,
  };
  if (unit.custom_id) out.custom_id = unit.custom_id;
  if (unit.invoice_id) out.invoice_id = unit.invoice_id;
  if (p.status === 'authorized' && p.providerData.captured) out.status_details = { reason: 'PENDING_REVIEW' };
  if (p.status === 'failed') {
    out.status_details = { reason: 'DECLINED' };
    if (p.method === 'card') out.processor_response = processorResponse(p);
  }
  out.supplementary_data = { related_ids: { order_id: p.providerRef } };
  return out;
}

/** One capture of an authorization (intent AUTHORIZE; partial captures). */
function authCaptureOf(svc: PaymentService, p: Payment, api: string, rec: { id: string; amount: number; final: boolean; at: string; status: string }): Json {
  const auth = authorizationOfPayment(p)!;
  const refunded = p.status === 'refunded' ? 'REFUNDED' : p.status === 'partially_refunded' ? 'PARTIALLY_REFUNDED' : null;
  const status = rec.status === 'DECLINED' ? 'DECLINED' : (refunded ?? 'COMPLETED');
  const fee = Math.min(Math.round(rec.amount * 0.0349) + 49, rec.amount);
  const out: Json = {
    id: rec.id,
    status,
    amount: money(p, rec.amount),
    final_capture: rec.final,
    seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
    seller_receivable_breakdown: { gross_amount: money(p, rec.amount), paypal_fee: money(p, fee), net_amount: money(p, rec.amount - fee) },
    links: [
      { href: `${api}/v2/payments/captures/${rec.id}`, rel: 'self', method: 'GET' },
      { href: `${api}/v2/payments/captures/${rec.id}/refund`, rel: 'refund', method: 'POST' },
      { href: `${api}/v2/payments/authorizations/${auth.id}`, rel: 'up', method: 'GET' },
    ],
    create_time: rec.at,
    update_time: rec.at,
  };
  if (status === 'DECLINED') {
    out.status_details = { reason: 'DECLINED' };
    if (p.method === 'card') out.processor_response = processorResponse(p);
  }
  out.supplementary_data = { related_ids: { order_id: p.providerRef, authorization_id: auth.id } };
  void svc;
  return out;
}

function payerOf(svc: PaymentService, p: Payment): Json | null {
  if (p.method === 'card') return null;
  if (!['authorized', 'paid', 'partially_refunded', 'refunded', 'failed'].includes(p.status)) return null;
  const u = p.testUserId ? svc.hub.users.get(p.projectId, p.testUserId) : null;
  const name = (u?.name ?? 'John Doe').split(' ');
  return {
    name: { given_name: name[0] ?? 'John', surname: name.slice(1).join(' ') || 'Doe' },
    email_address: u?.email ?? p.customerEmail ?? 'sb-buyer@personal.example.com',
    payer_id: String(p.providerData.payerId),
    address: { country_code: 'US' },
  };
}

export function orderOf(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const units = ((p.request.purchase_units as Json[] | undefined) ?? []).map((u, i) => {
    const unit: Json = { reference_id: u.reference_id ?? 'default', amount: u.amount, payee: { email_address: 'sb-merchant@business.example.com', merchant_id: String(p.providerData.merchantId) } };
    for (const k of ['description', 'custom_id', 'invoice_id', 'soft_descriptor', 'items', 'shipping']) if (u[k] !== undefined) unit[k] = u[k];
    const auth = authorizationOfPayment(p);
    if (i === 0 && auth) {
      unit.payments = { authorizations: [authorizationOf(svc, p, inst, auth)], ...(auth.captures.length ? { captures: auth.captures.map((x) => captureOf(svc, p, inst, x.id)) } : {}) };
      const refunds = svc.repo.refunds(p.id);
      if (refunds.length) (unit.payments as Json).refunds = refunds.map((r) => refundOf(svc, p, inst, r));
    } else if (i === 0 && hasCapture(p)) {
      unit.payments = { captures: [captureOf(svc, p, inst)] };
      const refunds = svc.repo.refunds(p.id);
      if (refunds.length) (unit.payments as Json).refunds = refunds.map((r) => refundOf(svc, p, inst, r));
    }
    return unit;
  });
  const out: Json = {
    id: p.providerRef,
    intent: intentOf(p),
    status: orderStatus(p),
    purchase_units: units,
    create_time: p.createdAt,
    links: links(svc, p, inst),
  };
  const payer = payerOf(svc, p);
  const vault = vaultAttributes(p);
  if (p.method === 'card') {
    const card = cardSourceOf(svc, p);
    if (vault) card.attributes = { vault };
    out.payment_source = { card };
  } else if (payer) {
    out.payer = payer;
    out.payment_source = { paypal: { email_address: payer.email_address, account_id: payer.payer_id, account_status: 'VERIFIED', name: payer.name, address: payer.address, ...(vault ? { attributes: { vault } } : {}) } };
  }
  if (orderStatus(p) !== 'CREATED' && orderStatus(p) !== 'PAYER_ACTION_REQUIRED') out.update_time = p.updatedAt;
  return out;
}

function refundOf(svc: PaymentService, p: Payment, inst: PaymentInstance, r: { providerRef: string; amount: number; status: string; createdAt: string }): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const api = svc.urls(project, inst).backend;
  return {
    id: r.providerRef,
    amount: money(p, r.amount),
    status: 'COMPLETED',
    create_time: r.createdAt,
    update_time: r.createdAt,
    links: [
      { href: `${api}/v2/payments/refunds/${r.providerRef}`, rel: 'self', method: 'GET' },
      { href: `${api}/v2/payments/captures/${String(p.providerData.captureId)}`, rel: 'up', method: 'GET' },
    ],
  };
}

function lintCreate(units: Json[], ctx: Json, currency: string, minor: number, precisionBad: boolean, idemKey: string | null): LintFinding[] {
  const out: LintFinding[] = [];
  if (minor <= 0) out.push(finding('pay.amount-zero', `amount.value is ${toDecimal(minor, currency)}`));
  if (precisionBad) out.push(finding('pay.amount-precision', `amount.value has more decimals than ${currency} allows (${currencyDigits(currency)})`));
  const ru = badUrl(ctx.return_url);
  if (ru) out.push(finding('pay.return-url-missing-or-bad', `return_url ${ru}`));
  const u = units[0] ?? {};
  if (!u.reference_id && !u.custom_id && !u.invoice_id) out.push(finding('pay.no-reference', 'No reference_id / custom_id / invoice_id on the purchase unit'));
  if (!idemKey) out.push(finding('pay.no-idempotency-key', 'POST /v2/checkout/orders without a PayPal-Request-Id header'));
  return out;
}

function createOrderRow(c: GatewayCtx, b: Json): { p: Payment; cardStart: ReturnType<typeof parseCardSource> | null; ppToken: PaymentToken | null; pp: boolean } {
  c.resolved.endpoint = 'create order';
  const intent = asString(b.intent);
  if (!intent) throw invalidRequest('/intent', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (intent !== 'CAPTURE' && intent !== 'AUTHORIZE') throw invalidRequest('/intent', 'INVALID_PARAMETER_VALUE', 'The value of a field is invalid (CAPTURE or AUTHORIZE).');
  const ps = (b.payment_source as Json | undefined) ?? {};
  // Validated before anything is stored: a real-looking card number never reaches the database.
  const cardStart = ps.card ? parseCardSource(c, ps.card as Json) : null;
  const ppVaultId = asString((ps.paypal as Json | undefined)?.vault_id);
  const ppToken = ppVaultId ? vaultToken(c, ppVaultId, 'paypal') : null;
  const storeAttr = (((ps.card ?? ps.paypal) as Json | undefined)?.attributes as Json | undefined) ?? {};
  const storeInVault = String(((storeAttr.vault as Json | undefined)?.store_in_vault as string | undefined) ?? '') === 'ON_SUCCESS' ? { customerId: asString((storeAttr.customer as Json | undefined)?.id) } : null;
  const units = Array.isArray(b.purchase_units) ? (b.purchase_units as Json[]) : [];
  if (!units.length) throw invalidRequest('/purchase_units', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (units.length > 1) throw unprocessable('MULTIPLE_PURCHASE_UNITS', 'stubyard simulates one purchase unit per order.');
  const amount = (units[0]!.amount ?? {}) as Json;
  const currency = (asString(amount.currency_code) ?? '').toUpperCase();
  if (!currency) throw invalidRequest('/purchase_units/@reference_id==\'default\'/amount/currency_code', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (currencyDigits(currency) === null) {
    c.svc.addInstanceLint(c.inst, finding('pay.currency-unknown', `Unknown currency "${currency}"`));
    throw unprocessable('CURRENCY_NOT_SUPPORTED', 'Currency code is not currently supported.');
  }
  const amt = fromDecimal(amount.value, currency);
  if (!amt.ok) throw invalidRequest('/purchase_units/@reference_id==\'default\'/amount/value', 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
  const precisionBad = amt.digits > (currencyDigits(currency) ?? 2);
  if (precisionBad) throw invalidRequest('/purchase_units/@reference_id==\'default\'/amount/value', 'DECIMAL_PRECISION', 'If the currency supports decimals, only two decimal place precision is supported.');
  const pp = ((b.payment_source as Json | undefined)?.paypal as Json | undefined)?.experience_context as Json | undefined;
  const cardCtx = ((ps.card as Json | undefined)?.experience_context as Json | undefined) ?? null;
  const ctx = (pp ?? cardCtx ?? (b.application_context as Json | undefined) ?? {}) as Json;
  let preset: string | null = null;
  const forced = header(c.req, 'x-hub-payment-outcome');
  if (forced) {
    try {
      preset = normalizeOutcome(forced);
    } catch (e) {
      throw invalidRequest('X-Hub-Payment-Outcome', 'INVALID_PARAMETER_VALUE', (e as Error).message);
    }
  }
  for (const param of ['return_url', 'cancel_url'] as const) {
    const why = rejectUrl(ctx[param]);
    if (why) {
      c.svc.addInstanceLint(c.inst, finding('pay.return-url-missing-or-bad', `${param} ${why}`));
      throw invalidRequest(`/${pp ? 'payment_source/paypal/experience_context' : cardCtx ? 'payment_source/card/experience_context' : 'application_context'}/${param}`, 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
    }
  }
  const idemKey = header(c.req, 'paypal-request-id');
  const lint = lintCreate(units, ctx, currency, amt.minor, precisionBad, idemKey).filter((f) => f.check !== 'pay.return-url-missing-or-bad' || !(cardStart || ppToken));
  const u0 = units[0]!;
  const email = asString(((b.payment_source as Json | undefined)?.paypal as Json | undefined)?.email_address) ?? asString((b.payer as Json | undefined)?.email_address);
  const p = c.svc.create(c, {
    kind: 'order',
    providerRef: upper(17),
    secondaryRef: null,
    amount: amt.minor,
    currency,
    reference: asString(u0.reference_id) ?? asString(u0.custom_id) ?? asString(u0.invoice_id),
    customerEmail: email,
    returnUrl: asString(ctx.return_url),
    cancelUrl: asString(ctx.cancel_url),
    callbackUrl: null,
    presetOutcome: preset,
    request: { ...b, purchase_units: [{ ...u0, reference_id: u0.reference_id ?? 'default', amount: { currency_code: currency, value: toDecimal(amt.minor, currency), ...(amount.breakdown ? { breakdown: amount.breakdown } : {}) } }] },
    providerData: {
      experience: !!pp && !ppToken,
      captureId: upper(17),
      payerId: (ppToken?.data.payerId as string | undefined) ?? upper(13),
      merchantId: upper(13),
      intent,
      ...(cardStart ? {} : { methods: ['paypal'] as PaymentMethod[] }),
      ...(storeInVault ? { storeInVault } : {}),
    },
    idempotencyKey: idemKey,
    lint,
    expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  });
  return { p, cardStart, ppToken, pp: !!pp };
}

/** POST /v2/checkout/orders (also the JS SDK's actions.order.create). */
export async function createOrder(c: GatewayCtx, b: Json): Promise<Json> {
  const r = createOrderRow(c, b);
  let p = r.p;
  if (r.cardStart) p = await startCardOrder(c, p, r.cardStart);
  else if (r.ppToken) {
    // vault_id: the buyer approved before; no approval page.
    p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, vaultUsed: r.ppToken.providerRef } });
    await c.svc.complete(p, { via: 'api', method: 'paypal', user: null });
    p = c.svc.repo.get(p.id)!;
  }
  const full = orderOf(c.svc, p, c.inst);
  return /return=representation/i.test(header(c.req, 'prefer') ?? '') ? full : { id: full.id, status: full.status, links: full.links, ...(full.payment_source ? { payment_source: full.payment_source } : r.pp ? { payment_source: { paypal: {} } } : {}) };
}

export async function findOrder(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p) throw notFound(`Specified resource ID does not exist. Please check the resource ID and try again.`);
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

/** PayPal-Mock-Response {"mock_application_codes":"INSTRUMENT_DECLINED"} → an outcome for service.capture. */
export function mockOf(c: GatewayCtx): string | null {
  const raw = header(c.req, 'paypal-mock-response');
  if (!raw) return null;
  try {
    const code = String((JSON.parse(raw) as Json).mock_application_codes ?? '');
    c.resolved.mock = code;
    if (code === 'INSTRUMENT_DECLINED') return 'decline:generic';
    if (code === 'TRANSACTION_REFUSED') return 'decline:processing_error';
    if (code) return `mock:${code}`;
  } catch {
    /* ignore */
  }
  return null;
}

export async function captureOrder(c: GatewayCtx, id: string): Promise<unknown> {
  c.resolved.endpoint = 'capture order';
  let p0 = await findOrder(c, id);
  if (intentOf(p0) === 'AUTHORIZE') throw unprocessable('ACTION_DOES_NOT_MATCH_INTENT', "Order was created with an intent of 'AUTHORIZE'. Please use /authorize endpoint for AUTHORIZE intent orders.");
  if (p0.status === 'authorized' && !p0.providerData.captured) p0 = liabilityCheck(c.svc, p0);
  const mock = mockOf(c);
  if (mock?.startsWith('mock:')) {
    const code = mock.slice(5);
    if (code === 'ORDER_NOT_APPROVED' || code === 'ORDER_ALREADY_CAPTURED' || code === 'DUPLICATE_INVOICE_ID' || code === 'PAYER_ACTION_REQUIRED') throw unprocessable(code, `Mocked by PayPal-Mock-Response: ${code}`);
    if (code === 'INTERNAL_SERVER_ERROR') throw new PpError(500, { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.', debug_id: debugId(), links: [] });
  }
  const r = await c.svc.capture(p0, { idempotencyKey: header(c.req, 'paypal-request-id'), mock: mock && !mock.startsWith('mock:') ? mock : null });
  if (r.error === 'not_approved') {
    const st = r.payment.status;
    if (st === 'failed') throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.');
    throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment. Please redirect the payer to the \'rel\':\'approve\' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.');
  }
  if (r.error === 'already_captured') throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured.If \'intent=CAPTURE\' only one capture per order is allowed.');
  if (r.error === 'declined') {
    // Cards: 201 with the capture DECLINED (processor_response); PayPal wallet: 422 INSTRUMENT_DECLINED.
    if (r.payment.method === 'card') return c.reply.status(201).send(orderOf(c.svc, c.svc.repo.update(r.payment.id, { providerData: { ...r.payment.providerData, captureDecline: r.payment.providerData.captureDecline ?? r.reason ?? 'generic' } }), c.inst));
    const e = unprocessable('INSTRUMENT_DECLINED', 'The instrument presented  was either declined by the processor or bank, or it can\'t be used for this payment.');
    (e.body.links as Json[]).push({ href: c.svc.entryUrl(c.project, c.inst, r.payment), rel: 'redirect', method: 'GET' });
    throw e;
  }
  const done = await vaultOnSuccess(c, r.payment);
  return c.reply.status(201).send(orderOf(c.svc, done, c.inst));
}

async function refundCapture(c: GatewayCtx, captureId: string, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'refund capture';
  const p = c.svc.repo.byCaptureId(c.inst.id, captureId);
  if (!p || !hasCapture(p)) throw notFound();
  c.resolved.payment = p.id;
  if (p.status === 'refunded') throw unprocessable('CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded', 'CAPTURE_FULLY_REFUNDED');
  if (p.status !== 'paid' && p.status !== 'partially_refunded') throw unprocessable('REFUND_NOT_ALLOWED', `Capture is ${captureStatus(p)}; it cannot be refunded.`);
  const amount = b.amount as Json | undefined;
  let minor: number | null = null;
  if (amount) {
    if (asString(amount.currency_code)?.toUpperCase() !== p.currency) throw unprocessable('REFUND_CURRENCY_MISMATCH', 'Refund must be in the same currency as the capture.');
    const a = fromDecimal(amount.value, p.currency);
    if (!a.ok) throw invalidRequest('/amount/value', 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
    minor = a.minor;
  }
  try {
    const out = await c.svc.refund(p, minor, { providerRef: upper(17), reason: asString(b.note_to_payer) });
    const r = c.svc.repo.refunds(p.id).find((x) => x.providerRef === out.refundId)!;
    const full = refundOf(c.svc, out.payment, c.inst, r);
    return c.reply.status(201).send(/return=representation/i.test(header(c.req, 'prefer') ?? '') ? full : { id: full.id, status: full.status, links: full.links });
  } catch (e) {
    if (e instanceof HttpError && (e.details as Json | undefined)?.code === 'amount_too_large') throw unprocessable('REFUND_AMOUNT_EXCEEDED', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.');
    throw e;
  }
}

function verifySignature(c: GatewayCtx, b: Json): unknown {
  c.resolved.endpoint = 'verify webhook signature';
  for (const f of ['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time', 'webhook_id', 'webhook_event']) {
    if (b[f] === undefined || b[f] === null || b[f] === '') throw invalidRequest(`/${f}`, 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  }
  const ev = b.webhook_event as Json;
  const evId = asString(ev.id);
  const row = evId
    ? (c.hub.db.prepare("SELECT payment_id, data FROM payment_events WHERE project_id = ? AND type = 'webhook_scheduled' AND json_extract(data, '$.eventId') = ? LIMIT 1").get(c.project.id, evId) as { payment_id: string; data: string } | undefined)
    : undefined;
  // PayPal recomputes over the event it stored; stubyard uses the exact body it sent (falls back to the posted object).
  const body = row ? String((JSON.parse(row.data) as Json).body ?? '') : JSON.stringify(ev);
  let ok = false;
  try {
    ok =
      String(b.webhook_id) === String(c.inst.config.webhookId) &&
      String(b.auth_algo).toUpperCase() === 'SHA256WITHRSA' &&
      createVerify('RSA-SHA256').update(paypalSignedString(String(b.transmission_id), String(b.transmission_time), String(b.webhook_id), body)).verify(c.inst.config.certPem ?? '', String(b.transmission_sig), 'base64');
  } catch {
    ok = false;
  }
  const p = row ? c.svc.repo.get(row.payment_id) : null;
  if (p) {
    c.resolved.payment = p.id;
    c.svc.repo.addEvent(p, 'paypal_signature_verified', { eventId: evId, transmissionId: b.transmission_id, result: ok ? 'SUCCESS' : 'FAILURE' });
    c.svc.changed(p.projectId, { payment: p.id });
  }
  return { verification_status: ok ? 'SUCCESS' : 'FAILURE' };
}

const idemKeyHash = (path: string, b: Json) => createHash('sha256').update(`${path}\n${JSON.stringify(b)}`).digest('hex');

async function handle(c: GatewayCtx): Promise<unknown> {
  const { req, path } = c;
  const m = req.method;
  if (path === '/demo' && m === 'GET') return paypalDemo(c);
  if (path === '/checkoutnow' && (m === 'GET' || m === 'HEAD')) {
    const id = asString(c.query.token);
    let p = id ? c.svc.repo.byInstanceRef(c.inst.id, id) : null;
    if (!p) throw new HttpError(404, 'Unknown PayPal order (token)');
    c.resolved.endpoint = 'approval page';
    c.resolved.payment = p.id;
    // Opened by the JS SDK (popup / overlay): the end of the flow posts to the opener and closes.
    if (c.query.sdk === '1') {
      const extra: Json = { sdk: true };
      // The page origin (origin=location.origin from the SDK): the close page posts only there.
      if (c.query.origin !== undefined) {
        const chk = checkSdkOrigin(c, c.query.origin, 'PayPal Buttons (' + c.inst.slug + ')', (f) => c.svc.addLint(p!, [f]));
        if (!chk.ok) return htmlReply(c, chk.reason === 'refused' ? 403 : 400, renderSdkError(/^ar/i.test(String(c.query.locale ?? '')) ? 'ar' : 'en', 'PayPal', chk.reason === 'refused' ? 'PayPal: the page origin ' + (chk.origin ?? '?') + ' is not allowed for this instance (sdkOrigins / appOrigins).' : 'PayPal: bad origin.'));
        extra.sdkOrigin = chk.origin;
      }
      if (c.query.funding === 'paylater') extra.funding = 'paylater';
      p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, ...extra } });
      if (/^ar/i.test(String(c.query.locale ?? ''))) {
        const cv = (p.providerData.checkoutView as Json | undefined) ?? {};
        if (!cv.locale) p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, checkoutView: { ...cv, locale: 'ar' } } });
      }
    }
    return c.reply.redirect(`page/${p.id}`, 302);
  }
  const subPage = subscriptionPageRoute(c);
  if (subPage !== undefined) return subPage;
  const sdk = await sdkRoute(c);
  // A sent FastifyReply is a thenable: awaiting a route that returned it yields undefined, so check reply.sent too.
  if (sdk !== undefined || c.reply.sent) return c.reply.sent ? c.reply : sdk;
  const cert = /^\/v1\/notifications\/certs\/([^/]+)$/.exec(path);
  if (cert && m === 'GET') {
    c.resolved.endpoint = 'webhook cert';
    return c.reply.type('application/x-pem-file').send(c.inst.config.certPem ?? '');
  }
  if (path === '/v1/oauth2/token' && m === 'POST') return token(c);
  bearer(c);
  const b = m === 'GET' ? {} : bodyOf(req);
  c.reply.header('paypal-debug-id', debugId());

  // PayPal-Request-Id replay for POSTs.
  const key = m === 'POST' ? header(req, 'paypal-request-id') : null;
  const cache = idem.get(c.inst.id) ?? new IdempotencyCache();
  idem.set(c.inst.id, cache);
  if (key) {
    const hit = cache.get(`${path}:${key}`);
    if (hit) {
      c.resolved.idempotentReplay = true;
      return c.reply.status(hit.status).send(hit.body);
    }
  }
  const run = async (fn: () => Promise<unknown> | unknown, okStatus: number) => {
    const before = c.reply.statusCode;
    const body = await fn();
    if (body === c.reply || c.reply.sent) return c.reply;
    const status = okStatus || before;
    if (key) cache.set(`${path}:${key}`, idemKeyHash(path, b), status, body);
    return c.reply.status(status).send(body);
  };

  let mm: RegExpExecArray | null;
  if (path === '/v2/checkout/orders' && m === 'POST') return run(() => createOrder(c, b), 201);
  if ((mm = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'get order';
    let p = await findOrder(c, mm[1]!);
    // Server read after the buyer step: the app can check authentication_result before capturing.
    if (!['created', 'pending', 'requires_action'].includes(p.status) && !p.providerData.readAfterApproval) p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, readAfterApproval: true } });
    return orderOf(c.svc, p, c.inst);
  }
  if ((mm = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(path)) && m === 'POST') {
    const id = mm[1]!;
    const body = await authorizeOrder(c, id);
    if (key && c.reply.statusCode < 300) cache.set(`${path}:${key}`, idemKeyHash(path, b), 201, orderOf(c.svc, c.svc.repo.byInstanceRef(c.inst.id, id)!, c.inst));
    return body;
  }
  if (path.startsWith('/v2/payments/authorizations/')) {
    const out = await authorizationRoute(c, b);
    if (out !== undefined || c.reply.sent) return c.reply.sent ? c.reply : out;
  }
  if (path.startsWith('/v3/vault/')) {
    const out = await vaultRoute(c, b);
    if (out !== undefined || c.reply.sent) return c.reply.sent ? c.reply : out;
  }
  if (path.startsWith('/v1/billing/') || path.startsWith('/v1/catalogs/') || path.startsWith('/v1/payments/sale/')) {
    const out = await subscriptionsApiRoute(c, b);
    if (out !== undefined || c.reply.sent) return c.reply.sent ? c.reply : out;
  }
  if (path.startsWith('/v1/customer/disputes')) {
    const out = await disputesApiRoute(c, b);
    if (out !== undefined || c.reply.sent) return c.reply.sent ? c.reply : out;
  }
  if ((mm = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path)) && m === 'POST') {
    const id = mm[1]!;
    const body = await captureOrder(c, id);
    if (key) cache.set(`${path}:${key}`, idemKeyHash(path, b), 201, orderOf(c.svc, c.svc.repo.byInstanceRef(c.inst.id, id)!, c.inst));
    return body;
  }
  if ((mm = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'get capture';
    const p = c.svc.repo.byCaptureId(c.inst.id, mm[1]!);
    if (!p || !hasCapture(p)) throw notFound();
    c.resolved.payment = p.id;
    return captureOf(c.svc, p, c.inst, mm[1]!);
  }
  if ((mm = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path)) && m === 'POST') {
    const body = await refundCapture(c, mm[1]!, b);
    return body;
  }
  if ((mm = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'get refund';
    const hit = c.svc.repo.refundByRef(c.project.id, mm[1]!);
    if (!hit || hit.payment.instanceId !== c.inst.id) throw notFound();
    return refundOf(c.svc, hit.payment, c.inst, hit.refund);
  }
  if (path === '/v1/notifications/verify-webhook-signature' && m === 'POST') return verifySignature(c, b);
  throw notFound(`${m} ${path} is not simulated by stubyard (orders v2, authorizations, captures, refunds, vault v3, catalog products, billing plans, subscriptions, v1 sales, disputes, verify-webhook-signature).`);
}

function eventResource(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): { resource: Json; resourceType: string; resourceVersion?: string; summary: string } {
  if (type.startsWith('PAYMENT.SALE.')) return saleEventResource(svc, p, inst, type);
  if (type.startsWith('PAYMENT.AUTHORIZATION.')) {
    const a = authorizationOfPayment(p);
    return { resource: a ? authorizationOf(svc, p, inst, a) : orderOf(svc, p, inst), resourceType: 'authorization', summary: `A payment authorization was ${type.endsWith('VOIDED') ? 'voided' : 'created'}` };
  }
  if (type.startsWith('CHECKOUT.ORDER.')) return { resource: orderOf(svc, p, inst), resourceType: 'checkout-order', summary: `An order has been ${type === 'CHECKOUT.ORDER.APPROVED' ? 'approved by buyer' : 'completed'}` };
  if (type === 'PAYMENT.CAPTURE.REFUNDED') {
    const r = svc.repo.refunds(p.id).at(-1);
    return { resource: r ? refundOf(svc, p, inst, r) : captureOf(svc, p, inst), resourceType: 'refund', summary: `A ${toDecimal(r?.amount ?? p.amount, p.currency)} ${p.currency} capture payment was refunded` };
  }
  const verb = type === 'PAYMENT.CAPTURE.COMPLETED' ? 'completed' : type === 'PAYMENT.CAPTURE.PENDING' ? 'pending' : 'denied';
  return { resource: captureOf(svc, p, inst), resourceType: 'capture', summary: `Payment ${verb} for ${toDecimal(p.amount, p.currency)} ${p.currency}` };
}

export const paypalGateway: Gateway = {
  preset: 'paypal',
  name: 'PayPal',
  description: 'PayPal Checkout, Orders v2 (CAPTURE and AUTHORIZE): approval page or JS SDK Buttons, Card Fields and server-side cards with 3D Secure, authorizations (capture / void / reauthorize, partial captures), Vault v3, RSA-signed webhooks with verify-webhook-signature.',
  available: true,
  kind: 'order',
  methods: ['paypal', 'card'],
  fields: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'buttonsMode', label: 'JS SDK buttons', hint: 'popup (default) or inline (overlay iframe, no popup blocker)' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'webhookId', label: 'Webhook ID', hint: 'Sent to verify-webhook-signature' },
    { key: 'webhookUrl', label: 'Webhook URL', hint: 'Your app endpoint for PayPal events' },
  ],
  defaults: () => {
    const k = generateSigningKey('messageverificationcerts.stubyard.paypal');
    return { clientId: `AV${alnum(78)}`, clientSecret: `E${alnum(79)}`, webhookId: upper(17), privateKeyPem: k.privatePem, certPem: k.certPem, webhookDelayMs: 500, magicAmounts: false };
  },
  capturesOnApprove: (p) => isSubPayment(p),
  retryOnDecline: false,
  entryPath: (p) => (isSubPayment(p) ? `/webapps/billing/subscriptions?ba_token=${p.providerRef}` : `/checkoutnow?token=${p.providerRef}`),
  route: async (c) => {
    try {
      return await handle(c);
    } catch (e) {
      if (e instanceof PpError) {
        c.resolved.error = e.message;
        return c.reply.status(e.status).send(e.body);
      }
      if (e instanceof HttpError && e.statusCode < 500) {
        return c.reply.status(e.statusCode).send({ name: e.statusCode === 404 ? 'RESOURCE_NOT_FOUND' : 'UNPROCESSABLE_ENTITY', message: e.message, debug_id: debugId(), details: [], links: [] });
      }
      throw e;
    }
  },
  returnTo: (_svc, p, _inst, kind) => {
    if (isSubPayment(p)) return subscriptionReturn(p, kind);
    if (p.providerData.sdk) {
      const state = kind === 'success' ? 'approved' : kind === 'cancelled' ? 'cancelled' : 'failed';
      return { kind: 'close', url: null, message: { source: 'stubyard-paypal', orderID: p.providerRef, payerID: p.method === 'card' ? null : String(p.providerData.payerId), state, targetOrigin: typeof p.providerData.sdkOrigin === 'string' ? p.providerData.sdkOrigin : null } };
    }
    const ok = httpUrl(p.returnUrl);
    const cancel = httpUrl(p.cancelUrl);
    if (kind === 'success' && ok) {
      const u = new URL(ok);
      u.searchParams.set('token', p.providerRef);
      if (p.method !== 'card') u.searchParams.set('PayerID', String(p.providerData.payerId));
      return { kind: 'redirect', url: u.toString() };
    }
    if (cancel) {
      const u = new URL(cancel);
      u.searchParams.set('token', p.providerRef);
      return { kind: 'redirect', url: u.toString() };
    }
    return null;
  },
  events: (p, point) =>
    isSubPayment(p) ? subscriptionPaymentEvents(p, point) : ({
      approved: ['CHECKOUT.ORDER.APPROVED'],
      authorized: ['PAYMENT.AUTHORIZATION.CREATED'],
      paid: ['PAYMENT.CAPTURE.COMPLETED'],
      pending: ['PAYMENT.CAPTURE.PENDING'],
      settled: ['PAYMENT.CAPTURE.COMPLETED'],
      // A denied authorization has no capture to deny.
      failed: intentOf(p) === 'AUTHORIZE' && !(authorizationOfPayment(p)?.captures.length ?? 0) ? [] : ['PAYMENT.CAPTURE.DENIED'],
      refunded: ['PAYMENT.CAPTURE.REFUNDED'],
      cancelled: authorizationOfPayment(p) ? ['PAYMENT.AUTHORIZATION.VOIDED'] : [],
      expired: [],
    })[point] ?? [],
  buildEvent: (svc, p, inst, type) => {
    const project = svc.hub.projects.get(p.projectId)!;
    const api = svc.urls(project, inst).backend;
    const id = `WH-${upper(17)}-${upper(17)}`;
    const { resource, resourceType, resourceVersion, summary } = eventResource(svc, p, inst, type);
    const body = JSON.stringify({
      id,
      event_version: '1.0',
      create_time: new Date().toISOString(),
      resource_type: resourceType,
      resource_version: resourceVersion ?? '2.0',
      event_type: type,
      summary,
      resource,
      links: [
        { href: `${api}/v1/notifications/webhooks-events/${id}`, rel: 'self', method: 'GET' },
        { href: `${api}/v1/notifications/webhooks-events/${id}/resend`, rel: 'resend', method: 'POST' },
      ],
    });
    const certUrl = certUrlOf(svc, inst);
    return { url: inst.config.webhookUrl ?? null, body, eventId: id, signing: inst.config.privateKeyPem && inst.config.webhookId ? { preset: 'paypal', privateKey: inst.config.privateKeyPem, webhookId: inst.config.webhookId, certUrl } : null };
  },
  afterComplete: (svc, p, inst) => {
    if (isSubPayment(p)) subscriptionApproved(svc, p, inst);
  },
  shape: (svc, p, inst) => (isSubPayment(p) ? { sale: saleOf(svc, p, inst), subscription: p.providerData.subscription } : { order: orderOf(svc, p, inst) }),
  providerStatus: (p) => isSubPayment(p) ? subscriptionPaymentStatus(p) : (hasCapture(p) ? `${orderStatus(p)} / capture ${captureStatus(p)}` : orderStatus(p)),
  connect: (inst, urls) => ({
    env: { PAYPAL_CLIENT_ID: inst.config.clientId ?? '', PAYPAL_CLIENT_SECRET: inst.config.clientSecret ?? '', PAYPAL_WEBHOOK_ID: inst.config.webhookId ?? '', PAYPAL_API_BASE: urls.backend, PAYPAL_API_BASE_LOCAL: urls.backendLocal },
    notes: [
      'Use PAYPAL_API_BASE instead of https://api-m.sandbox.paypal.com: POST {base}/v1/oauth2/token, {base}/v2/checkout/orders, …/capture, /v2/payments/captures/<id>/refund.',
      'Redirect the buyer to the order\'s "approve" (or "payer-action") link; stubyard returns to return_url with ?token=<order>&PayerID=…, then your app captures.',
      'Webhooks carry PAYPAL-TRANSMISSION-* headers signed with the instance key; verify with POST {base}/v1/notifications/verify-webhook-signature (stubyard flags apps that never do).',
      'PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"} on the capture call forces a decline.',
      'JS SDK: load {browser base}/sdk/js?client-id=<PAYPAL_CLIENT_ID>&components=buttons,card-fields,messages instead of https://www.paypal.com/sdk/js. paypal.Buttons opens the stubyard approval page in a popup (buttonsMode "inline": an overlay); paypal.CardFields renders stubyard iframes that never pass card digits to your page. Without fundingSource the buttons are PayPal, Pay Later and Debit or Credit Card (neutral, with the TEST notice); locale=ar_SA gives Arabic. components=messages adds paypal.Messages({ amount, placement, style }).render(selector) and renders [data-pp-message] elements (Pay Later message with the TEST label; Learn more opens an info popup). The frames post only to your page origin (sdkOrigins here or the project app origins). Try it: {browser base}/demo.',
      'intent AUTHORIZE: POST {base}/v2/checkout/orders/<id>/authorize, then /v2/payments/authorizations/<id>/capture (amount + final_capture for partial captures), /void or /reauthorize.',
      'Cards: payment_source.card with a test number (server-side), Card Fields, or a vault_id; attributes.verification.method SCA_ALWAYS (or the magic 3DS card 4000 0025 0000 3155) gives PAYER_ACTION_REQUIRED and a payer-action link; read payment_source.card.authentication_result.liability_shift before capturing.',
      'Vault v3: POST {base}/v3/vault/setup-tokens, then /v3/vault/payment-tokens; pay later with payment_source.paypal.vault_id / card.vault_id, or save while paying with attributes.vault.store_in_vault ON_SUCCESS.',
    ],
    snippets: [
      {
        title: 'JS SDK (page)',
        lang: 'html',
        code: `<script src="${urls.browser}/sdk/js?client-id=${inst.config.clientId ?? ''}&components=buttons,card-fields&intent=capture&currency=USD"></script>
<div id="paypal-buttons"></div>
<script>
paypal.Buttons({
  createOrder: () => fetch('/api/orders', { method: 'POST' }).then((r) => r.json()).then((o) => o.id),
  onApprove: (data) => fetch('/api/orders/' + data.orderID + '/capture', { method: 'POST' }),
}).render('#paypal-buttons');
</script>`,
      },
      {
        title: 'Card Fields (page)',
        lang: 'js',
        code: `const cardFields = paypal.CardFields({
  createOrder: () => fetch('/api/orders?card=1', { method: 'POST' }).then((r) => r.json()).then((o) => o.id),
  onApprove: ({ orderID, liabilityShift }) => fetch('/api/orders/' + orderID + '/capture', { method: 'POST' }),
});
cardFields.NumberField().render('#card-number');
cardFields.ExpiryField().render('#card-expiry');
cardFields.CVVField().render('#card-cvv');
document.querySelector('#pay').onclick = () => cardFields.submit();`,
      },
      {
        title: 'Authorize, then capture part of it (server)',
        lang: 'bash',
        code: `curl -X POST ${urls.backendLocal}/v2/checkout/orders/$ORDER_ID/authorize -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "PayPal-Request-Id: $(uuidgen)"
curl -X POST ${urls.backendLocal}/v2/payments/authorizations/$AUTH_ID/capture -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"amount":{"currency_code":"USD","value":"10.00"},"final_capture":false}'`,
      },
    ],
  }),
};
