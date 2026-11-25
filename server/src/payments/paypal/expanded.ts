import type { GatewayCtx, Json } from '../gateway.js';
import { alnum, asString, header, upper } from '../common.js';
import { describeCard, fromDecimal, OPEN, toDecimal } from '../engine.js';
import { finding } from '../lint.js';
import { pageCsp, renderChallengePage } from '../pages.js';
import type { Payment, PaymentInstance, PaymentToken } from '../repo.js';
import type { PaymentService } from '../service.js';
import { captureOf, findOrder, invalidRequest, mockOf, money, notFound, orderOf, unprocessable } from './index.js';
import { vaultOnSuccess } from './vault.js';

/**
 * PayPal Expanded Checkout on the fake: cards as payment_source (server-side numbers, Card Fields, vaulted cards),
 * 3D Secure (SCA_ALWAYS / SCA_WHEN_REQUIRED, the magic "3ds" card) with authentication_result, and intent AUTHORIZE
 * (authorize the order, then capture / void / reauthorize the authorization; partial captures).
 * Simplifications: reauthorize is accepted at any time (PayPal: after the 3-day honor period, within 29 days).
 */

export interface Authorization {
  id: string;
  status: 'CREATED' | 'CAPTURED' | 'PARTIALLY_CAPTURED' | 'VOIDED' | 'DENIED';
  amount: number;
  captures: { id: string; amount: number; final: boolean; at: string; status: string }[];
  capturedAmount: number;
  expiration: string;
  honorExpiration: string;
  previous: string[];
  createdAt: string;
  updatedAt: string;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const authorizationOfPayment = (p: Payment) => (p.providerData.authorization as Authorization | undefined) ?? null;
export const intentOf = (p: Payment) => String(p.providerData.intent ?? 'CAPTURE');

const BRAND: Record<string, string> = { visa: 'VISA', mastercard: 'MASTERCARD', amex: 'AMEX', discover: 'DISCOVER', jcb: 'JCB', mada: 'VISA' };
export const ppBrand = (b: string | null | undefined) => BRAND[String(b ?? '').toLowerCase()] ?? 'UNKNOWN';

/** Processor response codes of a card decline (PayPal codes; the mapping per reason is stubyard's choice). */
const PROCESSOR: Record<string, string> = { generic: '0500', insufficient_funds: '5120', expired_card: '5400', incorrect_cvc: '5110', processing_error: '9500', authentication_failed: '0500' };
export function processorResponse(p: Payment): Json {
  const reason = String(p.providerData.declineReason ?? p.providerData.captureDecline ?? 'generic');
  return { avs_code: 'G', cvv_code: reason === 'incorrect_cvc' ? 'N' : 'M', response_code: PROCESSOR[reason] ?? '0500' };
}

/** 3D Secure result as the order shows it (null when no authentication happened). */
export function authResultOf(svc: PaymentService, p: Payment): Json | null {
  if (p.method !== 'card') return null;
  const ev = svc.repo.events(p.id).filter((e) => e.type === '3ds').at(-1);
  if (ev?.data.result === 'failed') return { liability_shift: 'NO', three_d_secure: { enrollment_status: 'Y', authentication_status: 'N' } };
  if (ev || (p.providerData.challenged && !OPEN.includes(p.status))) return { liability_shift: 'POSSIBLE', three_d_secure: { enrollment_status: 'Y', authentication_status: 'Y' } };
  return null;
}
export const liabilityShiftOf = (svc: PaymentService, p: Payment) => (authResultOf(svc, p)?.liability_shift as string | undefined) ?? null;

/** payment_source.card of the order. */
export function cardSourceOf(svc: PaymentService, p: Payment): Json {
  const card = (p.providerData.card as Json | undefined) ?? {};
  const out: Json = { last_digits: p.cardLast4 ?? card.last4 ?? null, brand: ppBrand(p.cardBrand ?? (card.brand as string)), available_networks: [ppBrand(p.cardBrand ?? (card.brand as string))], type: 'CREDIT' };
  if (card.name) out.name = card.name;
  if (card.expiry) out.expiry = card.expiry;
  const auth = authResultOf(svc, p);
  if (auth) out.authentication_result = auth;
  return out;
}

type CardStart =
  | { kind: 'direct'; brand: string; last4: string; magicId: string | null; name: string | null; expiry: string | null; sca: string }
  | { kind: 'vault'; token: PaymentToken; sca: string }
  | { kind: 'fields'; sca: string };

/** Validate payment_source.card of a create-order call (before anything is stored). */
export function parseCardSource(c: GatewayCtx, card: Json): CardStart {
  const attrs = (card.attributes as Json | undefined) ?? {};
  const sca = String(((attrs.verification as Json | undefined)?.method as string | undefined) ?? 'SCA_WHEN_REQUIRED').toUpperCase();
  if (!['SCA_ALWAYS', 'SCA_WHEN_REQUIRED', '3D_SECURE', 'AVS_CVV'].includes(sca)) throw invalidRequest('/payment_source/card/attributes/verification/method', 'INVALID_PARAMETER_VALUE', 'The value of a field is invalid.');
  const vaultId = asString(card.vault_id);
  if (vaultId) {
    const t = c.svc.repo.tokenByRef(c.inst.id, vaultId, 'payment');
    if (!t || t.status === 'DELETED' || t.source !== 'card') throw unprocessable('INVALID_RESOURCE_ID', 'Specified resource ID (vault_id) does not exist. Please check the resource ID and try again.');
    return { kind: 'vault', token: t, sca };
  }
  const number = asString(card.number);
  if (!number) return { kind: 'fields', sca };
  const digits = number.replace(/\D/g, '');
  const d = describeCard(digits);
  if (d.luhnValid && !d.testCard) {
    c.svc.addInstanceLint(c.inst, finding('pay.real-card-entered', `A real-looking ${d.brand} number was sent as payment_source.card.number (masked in stubyard, not stored)`));
    throw unprocessable('CARD_NUMBER_NOT_A_TEST_CARD', 'stubyard only accepts test card numbers (4111 1111 1111 1111, 4242 4242 4242 4242, magic cards); nothing was stored.');
  }
  if (digits.length < 12 || !d.luhnValid) throw invalidRequest('/payment_source/card/number', 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
  const expiry = asString(card.expiry);
  if (!expiry || !/^\d{4}-(0[1-9]|1[0-2])$/.test(expiry)) throw invalidRequest('/payment_source/card/expiry', expiry ? 'INVALID_PARAMETER_SYNTAX' : 'MISSING_REQUIRED_PARAMETER', 'Card expiry must be YYYY-MM.');
  return { kind: 'direct', brand: d.brand, last4: d.last4, magicId: d.magicId, name: asString(card.name), expiry, sca };
}

/** After the order row exists: approve it at once, ask for 3DS (PAYER_ACTION_REQUIRED) or wait for Card Fields. */
export async function startCardOrder(c: GatewayCtx, p0: Payment, s: CardStart): Promise<Payment> {
  let p = p0;
  if (s.kind === 'fields') {
    p = c.svc.repo.update(p.id, { method: 'card', providerData: { ...p.providerData, methods: ['card'], cardFields: { sca: s.sca } } });
    return p;
  }
  const card = s.kind === 'direct' ? { brand: s.brand, last4: s.last4, magicId: s.magicId, name: s.name, expiry: s.expiry } : { brand: s.token.cardBrand ?? 'visa', last4: s.token.cardLast4 ?? '0000', magicId: (s.token.data.magicId as string | null) ?? null, name: (s.token.data.name as string | null) ?? null, expiry: s.token.expiry };
  p = c.svc.repo.update(p.id, { method: 'card', cardBrand: card.brand, cardLast4: card.last4, providerData: { ...p.providerData, methods: ['card'], card, sca: s.sca, ...(s.kind === 'vault' ? { vaultUsed: s.token.providerRef } : {}) } });
  const needs3ds = s.sca === 'SCA_ALWAYS' || card.magicId === '3ds';
  if (needs3ds && s.kind === 'direct') {
    p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, payerAction: true } });
    c.svc.repo.addEvent(p, 'payer_action_required', { reason: '3ds', sca: s.sca });
    return p;
  }
  await completeCard(c.svc, p, card, 'api');
  return c.svc.repo.get(p.id)!;
}

/** Apply the outcome of a card payment (no buyer page): rules, magic card, default. */
export async function completeCard(svc: PaymentService, p: Payment, card: { brand: string | null; last4: string | null; magicId: string | null }, via: 'api' | 'page') {
  return svc.complete(p, { via, method: 'card', card: { brand: card.brand, last4: card.last4, magicId: card.magicId, luhnValid: true, testCard: true } });
}

/** GET /sdk/challenge/<payment>: the 3DS page of a card order (payer-action link, Card Fields overlay). */
export function challenge(c: GatewayCtx, pid: string): unknown {
  c.resolved.endpoint = '3ds challenge';
  const p0 = c.svc.repo.get(pid);
  if (!p0 || p0.instanceId !== c.inst.id) throw notFound('Unknown payment for the 3D Secure challenge.');
  c.resolved.payment = p0.id;
  if (!OPEN.includes(p0.status)) return c.reply.redirect(`${c.base}/page/${p0.id}`, 302);
  const p = c.svc.repo.update(p0.id, { providerData: { ...p0.providerData, challenged: true } });
  c.svc.repo.addEvent(p, 'challenge_opened', {});
  c.svc.changed(p.projectId, { payment: p.id });
  const card = (p.providerData.card as Json | undefined) ?? {};
  const g = c.svc.gateway(c.inst.preset);
  const html = renderChallengePage({
    presetId: c.inst.preset,
    presetName: g.name,
    amount: `${toDecimal(p.amount, p.currency)} ${p.currency}`,
    action: `${c.base}/page/${p.id}/complete`,
    carry: { method: 'card', card_brand: String(card.brand ?? p.cardBrand ?? 'visa'), card_last4: String(card.last4 ?? p.cardLast4 ?? ''), card_magic: String(card.magicId ?? '3ds') === '3ds' ? '3ds' : String(card.magicId), card_luhn: '1', card_test: '1' },
    dashboardUrl: `${c.svc.browserRoot(c.inst)}/`,
  });
  return c.reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', pageCsp(html)).send(html);
}

/** A card order captured / authorized after 3DS without the server reading the order (authentication_result) first. */
export function liabilityCheck(svc: PaymentService, p: Payment): Payment {
  if (p.method !== 'card' || !authResultOf(svc, p) || p.providerData.readAfterApproval) return p;
  return svc.addLint(p, [finding('pay.paypal-capture-without-liability-check', 'A 3D Secure card order was captured / authorized without GET /v2/checkout/orders/{id} first: check payment_source.card.authentication_result.liability_shift')]);
}

// ---------------- authorizations ----------------

export function authorizationOf(svc: PaymentService, p: Payment, inst: PaymentInstance, a: Authorization): Json {
  const project = svc.hub.projects.get(p.projectId)!;
  const api = svc.urls(project, inst).backend;
  const self = `${api}/v2/payments/authorizations/${a.id}`;
  const live = a.status === 'CREATED' || a.status === 'PARTIALLY_CAPTURED';
  const out: Json = {
    id: a.id,
    status: a.status,
    amount: money(p, a.amount),
    seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
    expiration_time: a.expiration,
    links: [
      { href: self, rel: 'self', method: 'GET' },
      ...(live ? [{ href: self + '/capture', rel: 'capture', method: 'POST' }, { href: self + '/void', rel: 'void', method: 'POST' }, { href: self + '/reauthorize', rel: 'reauthorize', method: 'POST' }] : []),
      { href: `${api}/v2/checkout/orders/${p.providerRef}`, rel: 'up', method: 'GET' },
    ],
    create_time: a.createdAt,
    update_time: a.updatedAt,
  };
  const unit = (p.request.purchase_units as Json[] | undefined)?.[0] ?? {};
  if (unit.custom_id) out.custom_id = unit.custom_id;
  if (unit.invoice_id) out.invoice_id = unit.invoice_id;
  if (a.status === 'DENIED') out.processor_response = processorResponse(p);
  if (a.status === 'PARTIALLY_CAPTURED') out.status_details = { reason: 'PARTIALLY_CAPTURED' };
  out.supplementary_data = { related_ids: { order_id: p.providerRef } };
  return out;
}

const isCard = (p: Payment) => p.method === 'card';

/** POST /v2/checkout/orders/<id>/authorize. */
export async function authorizeOrder(c: GatewayCtx, id: string): Promise<unknown> {
  c.resolved.endpoint = 'authorize order';
  const p0 = await findOrder(c, id);
  if (intentOf(p0) !== 'AUTHORIZE') throw unprocessable('ACTION_DOES_NOT_MATCH_INTENT', "Order was created with an intent of 'CAPTURE'. Please use /capture endpoint for CAPTURE intent orders.");
  const mock = mockOf(c);
  if (mock?.startsWith('mock:')) throw unprocessable(mock.slice(5), `Mocked by PayPal-Mock-Response: ${mock.slice(5)}`);
  if (p0.status === 'authorized' && !p0.providerData.authorization) liabilityCheck(c.svc, p0);
  const now = Date.now();
  const data: Authorization = { id: upper(17), status: 'CREATED', amount: p0.amount, captures: [], capturedAmount: 0, expiration: iso(now + 29 * DAY), honorExpiration: iso(now + 3 * DAY), previous: [], createdAt: iso(now), updatedAt: iso(now) };
  const r = await c.svc.authorize(c.svc.repo.get(p0.id)!, { data: data as unknown as Json, mock: mock && !mock.startsWith('mock:') ? mock : null });
  if (r.error === 'not_approved') throw unprocessable('ORDER_NOT_APPROVED', "Payer has not yet approved the Order for payment. Please redirect the payer to the 'rel':'approve' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.");
  if (r.error === 'already_authorized') throw unprocessable('ORDER_ALREADY_AUTHORIZED', "Order already authorized. If 'intent=AUTHORIZE' only one authorization per order is allowed.");
  if (r.error === 'declined') {
    if (!isCard(r.payment)) {
      const e = unprocessable('INSTRUMENT_DECLINED', "The instrument presented  was either declined by the processor or bank, or it can't be used for this payment.");
      (e.body.links as Json[]).push({ href: c.svc.entryUrl(c.project, c.inst, r.payment), rel: 'redirect', method: 'GET' });
      throw e;
    }
    const p = c.svc.repo.update(r.payment.id, { providerData: { ...r.payment.providerData, authorization: { ...data, status: 'DENIED' } } });
    return c.reply.status(201).send(orderOf(c.svc, p, c.inst));
  }
  const p = await vaultOnSuccess(c, r.payment);
  return c.reply.status(201).send(orderOf(c.svc, p, c.inst));
}

function findAuthorization(c: GatewayCtx, id: string): { p: Payment; a: Authorization } {
  const p = c.svc.repo.byAuthorizationId(c.inst.id, id);
  const a = p ? authorizationOfPayment(p) : null;
  if (!p || !a) throw notFound('Specified resource ID does not exist. Please check the resource ID and try again.');
  c.resolved.payment = p.id;
  if (a.id !== id) throw unprocessable('AUTHORIZATION_ALREADY_REAUTHORIZED', `Authorization ${id} was reauthorized; use the new authorization ${a.id}.`);
  return { p, a };
}

function amountOf(p: Payment, b: Json): number | null {
  const amount = b.amount as Json | undefined;
  if (!amount) return null;
  if (asString(amount.currency_code)?.toUpperCase() !== p.currency) throw unprocessable('CURRENCY_MISMATCH', 'Currency code should be the same as the currency of the authorization.');
  const a = fromDecimal(amount.value, p.currency);
  if (!a.ok || a.minor <= 0) throw invalidRequest('/amount/value', 'INVALID_PARAMETER_SYNTAX', 'The value of a field does not conform to the expected format.');
  return a.minor;
}

const expired = (a: Authorization) => Date.parse(a.expiration) < Date.now();
const represent = (c: GatewayCtx) => /return=representation/i.test(header(c.req, 'prefer') ?? '');

/** /v2/payments/authorizations/… (GET, capture, void, reauthorize). Undefined when the path is not one of these. */
export async function authorizationRoute(c: GatewayCtx, b: Json): Promise<unknown> {
  const { path } = c;
  const m = c.req.method;
  const mm = /^\/v2\/payments\/authorizations\/([^/]+)(\/capture|\/void|\/reauthorize)?$/.exec(path);
  if (!mm) return undefined;
  const id = decodeURIComponent(mm[1]!);
  const op = mm[2] ?? '';
  if (!op && m === 'GET') {
    c.resolved.endpoint = 'get authorization';
    const p = c.svc.repo.byAuthorizationId(c.inst.id, id);
    const a = p ? authorizationOfPayment(p) : null;
    if (!p || !a) throw notFound();
    c.resolved.payment = p.id;
    return authorizationOf(c.svc, await c.svc.touch(p), c.inst, a.id === id ? a : { ...a, id, status: 'CREATED', captures: [] });
  }
  if (m !== 'POST' || !op) return undefined;
  let { p, a } = findAuthorization(c, id);
  const now = iso(Date.now());
  if (op === '/capture') {
    c.resolved.endpoint = 'capture authorization';
    if (a.status === 'VOIDED') throw unprocessable('AUTHORIZATION_VOIDED', 'A voided authorization cannot be captured or reauthorized.');
    if (a.status === 'DENIED') throw unprocessable('AUTHORIZATION_DENIED', 'A denied authorization cannot be captured.');
    if (a.status === 'CAPTURED') throw unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has been previously captured and hence cannot be captured again.');
    if (expired(a)) throw unprocessable('AUTHORIZATION_EXPIRED', 'An expired authorization cannot be captured.');
    const minor = amountOf(p, b) ?? a.amount - a.capturedAmount;
    if (a.capturedAmount + minor > a.amount) throw unprocessable('MAX_CAPTURE_AMOUNT_EXCEEDED', 'Capture amount exceeds allowable limit.');
    const final = b.final_capture === true || a.capturedAmount + minor >= a.amount;
    p = liabilityCheck(c.svc, p);
    const rec = { id: upper(17), amount: minor, final, at: now, status: 'COMPLETED' };
    // Record the capture first: the PAYMENT.CAPTURE.COMPLETED event is built from it.
    p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, captureId: rec.id, authorization: { ...a, captures: [...a.captures, rec], updatedAt: now } } });
    const mock = mockOf(c);
    const r = await c.svc.capture(p, { idempotencyKey: header(c.req, 'paypal-request-id'), mock: mock && !mock.startsWith('mock:') ? mock : null, amount: minor, final });
    if (r.error && r.error !== 'declined') {
      c.svc.repo.update(p.id, { providerData: { ...c.svc.repo.get(p.id)!.providerData, authorization: a } });
      if (r.error === 'amount_exceeds') throw unprocessable('MAX_CAPTURE_AMOUNT_EXCEEDED', 'Capture amount exceeds allowable limit.');
      throw unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has been previously captured and hence cannot be captured again.');
    }
    if (r.error === 'declined') {
      const failed = { ...rec, status: 'DECLINED' };
      p = c.svc.repo.update(p.id, { providerData: { ...r.payment.providerData, authorization: { ...a, captures: [...a.captures, failed], updatedAt: now } } });
      if (!isCard(p)) throw unprocessable('INSTRUMENT_DECLINED', "The instrument presented  was either declined by the processor or bank, or it can't be used for this payment.");
    } else {
      const capturedAmount = a.capturedAmount + minor;
      p = c.svc.repo.update(p.id, { providerData: { ...r.payment.providerData, authorization: { ...a, captures: [...a.captures, rec], capturedAmount, status: final ? 'CAPTURED' : 'PARTIALLY_CAPTURED', updatedAt: now } } });
      p = await vaultOnSuccess(c, p);
    }
    const full = captureOf(c.svc, p, c.inst, rec.id);
    return c.reply.status(201).send(represent(c) ? full : { id: full.id, status: full.status, links: full.links });
  }
  if (op === '/void') {
    c.resolved.endpoint = 'void authorization';
    if (a.captures.some((x) => x.status === 'COMPLETED')) throw unprocessable('PREVIOUSLY_CAPTURED', 'Authorization has been previously captured and hence cannot be voided.');
    if (a.status === 'VOIDED') throw unprocessable('PREVIOUSLY_VOIDED', 'Authorization has been previously voided and hence cannot be voided again.');
    if (a.status === 'DENIED' || expired(a)) throw unprocessable('CANNOT_BE_VOIDED', 'A reauthorization cannot be voided. Please void the original parent authorization.');
    p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, authorization: { ...a, status: 'VOIDED', updatedAt: now } } });
    p = await c.svc.voidPayment(p, { webhook: true });
    if (represent(c)) return c.reply.status(200).send(authorizationOf(c.svc, p, c.inst, authorizationOfPayment(p)!));
    return c.reply.status(204).send();
  }
  // reauthorize
  c.resolved.endpoint = 'reauthorize authorization';
  if (a.status === 'VOIDED') throw unprocessable('AUTHORIZATION_VOIDED', 'A voided authorization cannot be captured or reauthorized.');
  if (a.status !== 'CREATED') throw unprocessable('REAUTHORIZATION_NOT_ALLOWED', `Only an authorization without captures can be reauthorized (status ${a.status}).`);
  const minor = amountOf(p, b) ?? a.amount;
  if (minor > Math.round(p.amount * 1.15)) throw unprocessable('REAUTHORIZE_AMOUNT_EXCEEDED', 'Reauthorization amount exceeds 115% of the original authorization.');
  const t = Date.now();
  const next: Authorization = { ...a, id: upper(17), amount: Math.min(minor, p.amount), previous: [...a.previous, a.id], expiration: iso(t + 29 * DAY), honorExpiration: iso(t + 3 * DAY), createdAt: iso(t), updatedAt: iso(t) };
  p = c.svc.repo.update(p.id, { providerData: { ...p.providerData, authorization: next } });
  c.svc.repo.addEvent(p, 'reauthorized', { from: a.id, to: next.id, withinHonorPeriod: Date.parse(a.honorExpiration) > t });
  c.svc.changed(p.projectId, { payment: p.id });
  const full = authorizationOf(c.svc, p, c.inst, next);
  return c.reply.status(201).send(represent(c) ? full : { id: full.id, status: full.status, links: full.links });
}

export const newCustomerId = () => `customer_${String(Date.now()).slice(-6)}${alnum(4).toLowerCase()}`;
