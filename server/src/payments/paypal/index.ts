import { createHash, createVerify } from 'node:crypto';
import { generateSigningKey } from '../../auth/keys.js';
import type { Gateway, GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, bodyOf, header, IdempotencyCache, upper } from '../common.js';
import { currencyDigits, fromDecimal, normalizeOutcome, toDecimal } from '../engine.js';
import { badUrl, finding, httpUrl, rejectUrl } from '../lint.js';
import type { LintFinding, Payment, PaymentInstance } from '../repo.js';
import { paypalSignedString } from '../../webhooks/signing.js';
import { HttpError } from '../../util.js';
import type { PaymentService } from '../service.js';

/**
 * Fake PayPal (Orders v2, intent CAPTURE) under /pay/<project>/<instance>/…: OAuth client-credentials token, orders
 * create / get / capture, captures get / refund, refunds get, verify-webhook-signature and the cert URL, the buyer
 * approval page /checkoutnow?token=<order>, PayPal-Request-Id replay and the PayPal-Mock-Response header.
 */

const tokens = new Map<string, { instanceId: string; expires: number }>();
const idem = new Map<string, IdempotencyCache>();
const debugId = () => alnum(13).toLowerCase();

class PpError extends Error {
  constructor(
    public status: number,
    public body: Json,
  ) {
    super(String(body.message ?? body.error_description ?? body.name));
  }
}

function unprocessable(issue: string, description: string, link?: string): PpError {
  return new PpError(422, {
    name: 'UNPROCESSABLE_ENTITY',
    details: [{ issue, description }],
    message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
    debug_id: debugId(),
    links: [{ href: `https://developer.paypal.com/docs/api/orders/v2/#error-${link ?? issue}`, rel: 'information_link', method: 'GET' }],
  });
}
function invalidRequest(field: string, issue: string, description: string): PpError {
  return new PpError(400, { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', debug_id: debugId(), details: [{ field, location: 'body', issue, description }], links: [] });
}
const notFound = (what = 'The specified resource does not exist.') => new PpError(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID', description: what }], message: 'The specified resource does not exist.', debug_id: debugId(), links: [] });
const unauthorized = () => new PpError(401, { error: 'invalid_token', error_description: 'Token signature verification failed' });

function bearer(c: GatewayCtx): void {
  const h = header(c.req, 'authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) throw new PpError(401, { error: 'invalid_token', error_description: 'No access token found' });
  const t = tokens.get(m[1]!.trim());
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
  const access = `A21AA${alnum(80)}`;
  tokens.set(access, { instanceId: c.inst.id, expires: Date.now() + 32_400_000 });
  if (tokens.size > 5000) tokens.delete(tokens.keys().next().value!);
  return {
    scope: 'https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/checkout/one-click-with-merchant-issued-token',
    access_token: access,
    token_type: 'Bearer',
    app_id: `APP-${upper(17)}`,
    expires_in: 32400,
    nonce: `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}${alnum(43)}`,
  };
}

const money = (p: Payment, minor = p.amount) => ({ currency_code: p.currency, value: toDecimal(minor, p.currency) });

function orderStatus(p: Payment): string {
  switch (p.status) {
    case 'authorized':
      return p.providerData.captured ? 'COMPLETED' : 'APPROVED';
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
      return 'COMPLETED';
    case 'failed':
    case 'expired':
      return 'VOIDED';
    default:
      return p.providerData.experience ? 'PAYER_ACTION_REQUIRED' : 'CREATED';
  }
}

function captureStatus(p: Payment): string {
  if (p.status === 'refunded') return 'REFUNDED';
  if (p.status === 'partially_refunded') return 'PARTIALLY_REFUNDED';
  if (p.status === 'failed') return 'DECLINED';
  if (p.status === 'authorized' && p.providerData.captured) return 'PENDING';
  return 'COMPLETED';
}

const hasCapture = (p: Payment) => !!p.providerData.captured || ['paid', 'partially_refunded', 'refunded'].includes(p.status) || (p.status === 'failed' && !!p.providerData.captureDecline);

function links(svc: PaymentService, p: Payment, inst: PaymentInstance): Json[] {
  const project = svc.hub.projects.get(p.projectId)!;
  const api = svc.urls(project, inst).backend;
  const self = { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'self', method: 'GET' };
  const st = orderStatus(p);
  if (st === 'CREATED' || st === 'PAYER_ACTION_REQUIRED') {
    return [self, { href: svc.entryUrl(project, inst, p), rel: p.providerData.experience ? 'payer-action' : 'approve', method: 'GET' }, { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'update', method: 'PATCH' }, { href: `${api}/v2/checkout/orders/${p.providerRef}/capture`, rel: 'capture', method: 'POST' }];
  }
  if (st === 'APPROVED') return [self, { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'update', method: 'PATCH' }, { href: `${api}/v2/checkout/orders/${p.providerRef}/capture`, rel: 'capture', method: 'POST' }];
  return [self];
}

function captureOf(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const api = svc.urls(project, inst).backend;
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
  if (p.status === 'failed') out.status_details = { reason: 'DECLINED' };
  out.supplementary_data = { related_ids: { order_id: p.providerRef } };
  return out;
}

function payerOf(svc: PaymentService, p: Payment): Json | null {
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

function orderOf(svc: PaymentService, p: Payment, inst: PaymentInstance): Json {
  const units = ((p.request.purchase_units as Json[] | undefined) ?? []).map((u, i) => {
    const unit: Json = { reference_id: u.reference_id ?? 'default', amount: u.amount, payee: { email_address: 'sb-merchant@business.example.com', merchant_id: String(p.providerData.merchantId) } };
    for (const k of ['description', 'custom_id', 'invoice_id', 'soft_descriptor', 'items', 'shipping']) if (u[k] !== undefined) unit[k] = u[k];
    if (i === 0 && hasCapture(p)) {
      unit.payments = { captures: [captureOf(svc, p, inst)] };
      const refunds = svc.repo.refunds(p.id);
      if (refunds.length) (unit.payments as Json).refunds = refunds.map((r) => refundOf(svc, p, inst, r));
    }
    return unit;
  });
  const out: Json = {
    id: p.providerRef,
    intent: 'CAPTURE',
    status: orderStatus(p),
    purchase_units: units,
    create_time: p.createdAt,
    links: links(svc, p, inst),
  };
  const payer = payerOf(svc, p);
  if (payer) {
    out.payer = payer;
    out.payment_source = { paypal: { email_address: payer.email_address, account_id: payer.payer_id, account_status: 'VERIFIED', name: payer.name, address: payer.address } };
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

function createOrder(c: GatewayCtx, b: Json): Json {
  c.resolved.endpoint = 'create order';
  const intent = asString(b.intent);
  if (!intent) throw invalidRequest('/intent', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (intent !== 'CAPTURE') throw unprocessable('UNSUPPORTED_INTENT', `intent=${intent} is not simulated by devhub (Payments 1a: CAPTURE only).`);
  const units = Array.isArray(b.purchase_units) ? (b.purchase_units as Json[]) : [];
  if (!units.length) throw invalidRequest('/purchase_units', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
  if (units.length > 1) throw unprocessable('MULTIPLE_PURCHASE_UNITS', 'devhub simulates one purchase unit per order.');
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
  const ctx = (pp ?? (b.application_context as Json | undefined) ?? {}) as Json;
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
      throw invalidRequest(`/${pp ? 'payment_source/paypal/experience_context' : 'application_context'}/${param}`, 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
    }
  }
  const idemKey = header(c.req, 'paypal-request-id');
  const lint = lintCreate(units, ctx, currency, amt.minor, precisionBad, idemKey);
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
    providerData: { experience: !!pp, captureId: upper(17), payerId: upper(13), merchantId: upper(13) },
    idempotencyKey: idemKey,
    lint,
    expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  });
  const full = orderOf(c.svc, p, c.inst);
  return /return=representation/i.test(header(c.req, 'prefer') ?? '') ? full : { id: full.id, status: full.status, links: full.links, ...(full.payment_source ? {} : pp ? { payment_source: { paypal: {} } } : {}) };
}

async function findOrder(c: GatewayCtx, id: string): Promise<Payment> {
  const p = c.svc.repo.byInstanceRef(c.inst.id, id);
  if (!p) throw notFound(`Specified resource ID does not exist. Please check the resource ID and try again.`);
  c.resolved.payment = p.id;
  return c.svc.touch(p);
}

/** PayPal-Mock-Response {"mock_application_codes":"INSTRUMENT_DECLINED"} → an outcome for service.capture. */
function mockOf(c: GatewayCtx): string | null {
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

async function captureOrder(c: GatewayCtx, id: string): Promise<unknown> {
  c.resolved.endpoint = 'capture order';
  const p0 = await findOrder(c, id);
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
    const e = unprocessable('INSTRUMENT_DECLINED', 'The instrument presented  was either declined by the processor or bank, or it can\'t be used for this payment.');
    (e.body.links as Json[]).push({ href: c.svc.entryUrl(c.project, c.inst, r.payment), rel: 'redirect', method: 'GET' });
    throw e;
  }
  return c.reply.status(201).send(orderOf(c.svc, r.payment, c.inst));
}

async function refundCapture(c: GatewayCtx, captureId: string, b: Json): Promise<unknown> {
  c.resolved.endpoint = 'refund capture';
  const p = c.svc.repo.byDataRef(c.inst.id, 'captureId', captureId);
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
  // PayPal recomputes over the event it stored; devhub uses the exact body it sent (falls back to the posted object).
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
  if (path === '/checkoutnow' && (m === 'GET' || m === 'HEAD')) {
    const id = asString(c.query.token);
    const p = id ? c.svc.repo.byInstanceRef(c.inst.id, id) : null;
    if (!p) throw new HttpError(404, 'Unknown PayPal order (token)');
    c.resolved.endpoint = 'approval page';
    c.resolved.payment = p.id;
    return c.reply.redirect(`page/${p.id}`, 302);
  }
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
    if (body === c.reply) return body;
    const status = okStatus || before;
    if (key) cache.set(`${path}:${key}`, idemKeyHash(path, b), status, body);
    return c.reply.status(status).send(body);
  };

  let mm: RegExpExecArray | null;
  if (path === '/v2/checkout/orders' && m === 'POST') return run(() => createOrder(c, b), 201);
  if ((mm = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'get order';
    return orderOf(c.svc, await findOrder(c, mm[1]!), c.inst);
  }
  if ((mm = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path)) && m === 'POST') {
    const id = mm[1]!;
    const body = await captureOrder(c, id);
    if (key) cache.set(`${path}:${key}`, idemKeyHash(path, b), 201, orderOf(c.svc, c.svc.repo.byInstanceRef(c.inst.id, id)!, c.inst));
    return body;
  }
  if ((mm = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path)) && m === 'GET') {
    c.resolved.endpoint = 'get capture';
    const p = c.svc.repo.byDataRef(c.inst.id, 'captureId', mm[1]!);
    if (!p || !hasCapture(p)) throw notFound();
    c.resolved.payment = p.id;
    return captureOf(c.svc, p, c.inst);
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
  throw notFound(`${m} ${path} is not simulated by devhub (orders v2 CAPTURE, captures, refunds, verify-webhook-signature).`);
}

function eventResource(svc: PaymentService, p: Payment, inst: PaymentInstance, type: string): { resource: Json; resourceType: string; summary: string } {
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
  description: 'PayPal Checkout, Orders v2 (intent CAPTURE): approve on the devhub page, capture / refund via the API, RSA-signed webhooks with verify-webhook-signature.',
  available: true,
  kind: 'order',
  methods: ['paypal'],
  fields: [
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'webhookId', label: 'Webhook ID', hint: 'Sent to verify-webhook-signature' },
    { key: 'webhookUrl', label: 'Webhook URL', hint: 'Your app endpoint for PayPal events' },
  ],
  defaults: () => {
    const k = generateSigningKey('messageverificationcerts.devhub.paypal');
    return { clientId: `AV${alnum(78)}`, clientSecret: `E${alnum(79)}`, webhookId: upper(17), privateKeyPem: k.privatePem, certPem: k.certPem, webhookDelayMs: 500, magicAmounts: false };
  },
  capturesOnApprove: () => false,
  retryOnDecline: false,
  entryPath: (p) => `/checkoutnow?token=${p.providerRef}`,
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
    const ok = httpUrl(p.returnUrl);
    const cancel = httpUrl(p.cancelUrl);
    if (kind === 'success' && ok) {
      const u = new URL(ok);
      u.searchParams.set('token', p.providerRef);
      u.searchParams.set('PayerID', String(p.providerData.payerId));
      return { kind: 'redirect', url: u.toString() };
    }
    if (cancel) {
      const u = new URL(cancel);
      u.searchParams.set('token', p.providerRef);
      return { kind: 'redirect', url: u.toString() };
    }
    return null;
  },
  events: (_p, point) =>
    ({
      approved: ['CHECKOUT.ORDER.APPROVED'],
      paid: ['PAYMENT.CAPTURE.COMPLETED'],
      pending: ['PAYMENT.CAPTURE.PENDING'],
      settled: ['PAYMENT.CAPTURE.COMPLETED'],
      failed: ['PAYMENT.CAPTURE.DENIED'],
      refunded: ['PAYMENT.CAPTURE.REFUNDED'],
      cancelled: [],
      expired: [],
    })[point] ?? [],
  buildEvent: (svc, p, inst, type) => {
    const project = svc.hub.projects.get(p.projectId)!;
    const api = svc.urls(project, inst).backend;
    const id = `WH-${upper(17)}-${upper(17)}`;
    const { resource, resourceType, summary } = eventResource(svc, p, inst, type);
    const body = JSON.stringify({
      id,
      event_version: '1.0',
      create_time: new Date().toISOString(),
      resource_type: resourceType,
      resource_version: '2.0',
      event_type: type,
      summary,
      resource,
      links: [
        { href: `${api}/v1/notifications/webhooks-events/${id}`, rel: 'self', method: 'GET' },
        { href: `${api}/v1/notifications/webhooks-events/${id}/resend`, rel: 'resend', method: 'POST' },
      ],
    });
    const certUrl = `${api}/v1/notifications/certs/CERT-360caa42-fca2a594-${createHash('sha256').update(inst.id).digest('hex').slice(0, 8)}`;
    return { url: inst.config.webhookUrl ?? null, body, eventId: id, signing: inst.config.privateKeyPem && inst.config.webhookId ? { preset: 'paypal', privateKey: inst.config.privateKeyPem, webhookId: inst.config.webhookId, certUrl } : null };
  },
  shape: (svc, p, inst) => ({ order: orderOf(svc, p, inst) }),
  providerStatus: (p) => (hasCapture(p) ? `${orderStatus(p)} / capture ${captureStatus(p)}` : orderStatus(p)),
  connect: (inst, urls) => ({
    env: { PAYPAL_CLIENT_ID: inst.config.clientId ?? '', PAYPAL_CLIENT_SECRET: inst.config.clientSecret ?? '', PAYPAL_WEBHOOK_ID: inst.config.webhookId ?? '', PAYPAL_API_BASE: urls.backend, PAYPAL_API_BASE_LOCAL: urls.backendLocal },
    notes: [
      'Use PAYPAL_API_BASE instead of https://api-m.sandbox.paypal.com: POST {base}/v1/oauth2/token, {base}/v2/checkout/orders, …/capture, /v2/payments/captures/<id>/refund.',
      'Redirect the buyer to the order\'s "approve" (or "payer-action") link; devhub returns to return_url with ?token=<order>&PayerID=…, then your app captures.',
      'Webhooks carry PAYPAL-TRANSMISSION-* headers signed with the instance key; verify with POST {base}/v1/notifications/verify-webhook-signature (devhub flags apps that never do).',
      'PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"} on the capture call forces a decline.',
    ],
  }),
};
