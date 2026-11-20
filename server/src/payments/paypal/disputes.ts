import type { FastifyRequest } from 'fastify';
import { HttpError } from '../../util.js';
import { asString, decodeRef, header, upper } from '../common.js';
import { fromDecimal, toDecimal } from '../engine.js';
import type { GatewayCtx, Json } from '../gateway.js';
import type { Payment, PaymentInstance, PaymentToken } from '../repo.js';
import type { PaymentService } from '../service.js';
import { PP_KIND, ppAdd, ppError, ppFind, ppList, ppSave, ppTime, sendPpEvent } from './billing.js';
import { captureOf, invalidRequest } from './index.js';

/**
 * PayPal Disputes v1 (/v1/customer/disputes) on the fake. A dispute is opened from the stubyard control API or the
 * dashboard on a captured PayPal payment (an order capture or a subscription sale) — the buyer's side — and the app
 * answers with the merchant actions (make-offer, accept-claim, provide-evidence, escalate, send-message,
 * acknowledge-return-item) plus the sandbox-only adjudicate / require-evidence. Refunds that settle a dispute go
 * through the payment's normal refund path (PAYMENT.CAPTURE.REFUNDED / PAYMENT.SALE.REFUNDED). Events:
 * CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED. Stored in payment_tokens kind pp_dispute (data.disputedPayment).
 */

const DAY = 86_400_000;
export const DISPUTE_REASONS = ['MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'UNAUTHORISED', 'CREDIT_NOT_PROCESSED', 'DUPLICATE_TRANSACTION', 'INCORRECT_AMOUNT', 'PAYMENT_BY_OTHER_MEANS', 'CANCELED_RECURRING_BILLING', 'PROBLEM_WITH_REMITTANCE', 'OTHER'];
const OFFER_TYPES = ['REFUND', 'REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND'];
const ACCEPT_TYPES = ['REFUND', 'REFUND_WITH_RETURN', 'PARTIAL_REFUND', 'REFUND_WITH_RETURN_SHIPMENT_LABEL'];
const ACK_TYPES = ['ITEM_RECEIVED', 'ITEM_NOT_RECEIVED', 'DAMAGED', 'EMPTY_PACKAGE_OR_DIFFERENT', 'MISSING_ITEMS'];
const FILE_TYPES = /\.(jpe?g|gif|png|pdf)$/i;
const MAX_FILE = 10 * 1024 * 1024;

export type SellerAction = 'provide-evidence' | 'accept-claim' | 'make-offer' | 'escalate' | 'send-message' | 'acknowledge-return-item' | 'provide-supporting-info' | 'appeal' | 'adjudicate' | 'require-evidence' | 'accept-offer' | 'deny-offer';
const ACTIONS: SellerAction[] = ['provide-evidence', 'accept-claim', 'make-offer', 'escalate', 'send-message', 'acknowledge-return-item', 'provide-supporting-info', 'appeal', 'adjudicate', 'require-evidence', 'accept-offer', 'deny-offer'];

const disputeErr = (status: number, issue: string, description: string, field?: string) => ppError(status, issue, description, { api: 'disputes', field });
const notAllowed = (t: PaymentToken, action: string) => disputeErr(422, 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE', `${action} is not allowed while the dispute is ${t.status} (${String(t.data.stage)}).`);

export function disputeState(t: PaymentToken): string {
  if (t.status === 'RESOLVED') return 'RESOLVED';
  if (t.status === 'UNDER_REVIEW') return 'UNDER_PAYPAL_REVIEW';
  if (t.status === 'WAITING_FOR_BUYER_RESPONSE') return 'REQUIRED_OTHER_PARTY_ACTION';
  if (t.status === 'WAITING_FOR_SELLER_RESPONSE') return 'REQUIRED_ACTION';
  return 'OPEN_INQUIRIES';
}

/** The actions the merchant may take now (HATEOAS links on the dispute). */
export function allowedActions(t: PaymentToken): SellerAction[] {
  const s = t.status;
  const inquiry = t.data.stage === 'INQUIRY';
  const out: SellerAction[] = [];
  if (s === 'RESOLVED') return out;
  if (s === 'WAITING_FOR_SELLER_RESPONSE') {
    out.push('accept-claim', 'provide-evidence', 'send-message');
    if (inquiry) out.push('make-offer', 'escalate');
    if (t.data.return_pending) out.push('acknowledge-return-item');
  }
  if (s === 'WAITING_FOR_BUYER_RESPONSE') {
    out.push('accept-claim', 'send-message');
    if (inquiry) out.push('escalate');
  }
  if (s === 'UNDER_REVIEW') out.push('accept-claim', 'provide-supporting-info', 'adjudicate', 'require-evidence');
  return out;
}

const m = (minor: number, cur: string) => ({ currency_code: cur, value: toDecimal(minor, cur) });

export function disputeOf(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): Json {
  const d = t.data;
  const cur = String(d.currency);
  const api = svc.urls(svc.hub.projects.get(inst.projectId)!, inst).backend;
  const self = `${api}/v1/customer/disputes/${t.providerRef}`;
  const links: Json[] = [{ href: self, rel: 'self', method: 'GET' }, ...allowedActions(t).filter((a) => a !== 'adjudicate' && a !== 'require-evidence').map((a) => ({ href: `${self}/${a}`, rel: a.replace(/-/g, '_'), method: 'POST' }))];
  const offer = d.offer as Json | undefined;
  return {
    dispute_id: t.providerRef,
    create_time: d.create_time,
    update_time: d.update_time,
    disputed_transactions: [d.transaction],
    reason: d.reason,
    status: t.status,
    dispute_amount: m(Number(d.amount), cur),
    ...(d.outcome ? { dispute_outcome: { outcome_code: d.outcome, ...(Number(d.refunded ?? 0) > 0 ? { amount_refunded: m(Number(d.refunded), cur) } : {}) } } : {}),
    ...(Array.isArray(d.adjudications) && d.adjudications.length ? { adjudications: d.adjudications } : {}),
    ...(Array.isArray(d.money_movements) && d.money_movements.length ? { money_movements: d.money_movements } : {}),
    dispute_life_cycle_stage: d.stage,
    dispute_channel: d.channel ?? 'INTERNAL',
    messages: d.messages ?? [],
    ...(Array.isArray(d.evidences) && d.evidences.length ? { evidences: d.evidences } : {}),
    ...(Array.isArray(d.supporting_info) && d.supporting_info.length ? { supporting_info: d.supporting_info } : {}),
    ...(t.status === 'WAITING_FOR_SELLER_RESPONSE' ? { seller_response_due_date: d.seller_response_due_date } : {}),
    ...(t.status === 'WAITING_FOR_BUYER_RESPONSE' ? { buyer_response_due_date: d.buyer_response_due_date } : {}),
    ...(offer ? { offer } : {}),
    allowed_response_options: allowedActions(t).includes('make-offer') || allowedActions(t).includes('accept-claim')
      ? { ...(allowedActions(t).includes('accept-claim') ? { accept_claim: { accept_claim_types: ACCEPT_TYPES } } : {}), ...(allowedActions(t).includes('make-offer') ? { make_offer: { offer_types: OFFER_TYPES } } : {}), ...(d.return_pending ? { acknowledge_return_item: { acknowledgement_types: ACK_TYPES } } : {}) }
      : {},
    links,
  };
}

function disputeInfo(svc: PaymentService, inst: PaymentInstance, t: PaymentToken): Json {
  const full = disputeOf(svc, inst, t);
  return { dispute_id: full.dispute_id, create_time: full.create_time, update_time: full.update_time, reason: full.reason, status: full.status, dispute_state: disputeState(t), dispute_amount: full.dispute_amount, ...(full.dispute_outcome ? { outcome: (full.dispute_outcome as Json).outcome_code } : {}), dispute_life_cycle_stage: full.dispute_life_cycle_stage, dispute_channel: full.dispute_channel, links: [(full.links as Json[])[0]] };
}

function remaining(svc: PaymentService, p: Payment): number {
  const fresh = svc.repo.get(p.id) ?? p;
  return Math.max(0, fresh.amount - Number(fresh.refunded ?? 0));
}

async function event(svc: PaymentService, inst: PaymentInstance, t: PaymentToken, type: 'CREATED' | 'UPDATED' | 'RESOLVED'): Promise<void> {
  const fresh = svc.repo.token(t.id) ?? t;
  await sendPpEvent(svc, inst, fresh, { type: `CUSTOMER.DISPUTE.${type}`, resourceType: 'dispute', resourceVersion: '1.0', summary: type === 'CREATED' ? 'A new dispute opened' : type === 'RESOLVED' ? 'A dispute was resolved' : 'A dispute was updated', resource: disputeOf(svc, inst, fresh) });
  svc.changed(inst.projectId, { paypal: 'dispute', id: t.providerRef });
}

const paymentOf = (svc: PaymentService, t: PaymentToken) => svc.repo.get(String(t.data.disputedPayment));

/** Refund (part of) the disputed payment through the normal refund path; records the money movement. */
async function settle(svc: PaymentService, t: PaymentToken, minor: number | null, why: string): Promise<number> {
  const p = paymentOf(svc, t);
  if (!p) return 0;
  const left = remaining(svc, p);
  const amount = Math.min(minor ?? Number(t.data.amount), left);
  if (amount <= 0) return 0;
  await svc.refund(p, amount, { providerRef: upper(17), reason: `Dispute ${t.providerRef}: ${why}` });
  const cur = String(t.data.currency);
  const fresh = svc.repo.token(t.id)!;
  ppSave(svc, fresh, { data: { refunded: Number(fresh.data.refunded ?? 0) + amount, money_movements: [...((fresh.data.money_movements as Json[] | undefined) ?? []), { affected_party: 'SELLER', amount: m(amount, cur), initiated_time: ppTime(), type: 'DEBIT', reason: 'DISPUTE_SETTLEMENT' }] } });
  return amount;
}

function resolvedPatch(t: PaymentToken, outcome: string): { status: string; data: Json } {
  return { status: 'RESOLVED', data: { outcome, update_time: ppTime(), resolved_at: ppTime(), return_pending: false } };
}

function addMessage(t: PaymentToken, by: 'BUYER' | 'SELLER' | 'ARBITER', content: string, documents: Json[] = []): Json[] {
  return [...((t.data.messages as Json[] | undefined) ?? []), { posted_by: by, time_posted: ppTime(), content, ...(documents.length ? { documents } : {}) }];
}

function money(v: unknown, field: string, cur: string): number {
  const o = (v ?? {}) as Json;
  if (String(o.currency_code ?? '').toUpperCase() !== cur) throw disputeErr(422, 'INVALID_CURRENCY_CODE', `${field} must be in ${cur}.`, field);
  const a = fromDecimal(o.value, cur);
  if (!a.ok || a.minor <= 0) throw invalidRequest(field, 'INVALID_PARAMETER_VALUE', 'The amount must be a positive decimal.');
  return a.minor;
}

/**
 * Apply one dispute action (merchant API, buyer simulation from the control API, or PayPal itself), state checks
 * first, then the state change and the CUSTOMER.DISPUTE.* event.
 */
export async function disputeAction(svc: PaymentService, inst: PaymentInstance, t0: PaymentToken, action: SellerAction, b: Json, opts: { actor: 'SELLER' | 'BUYER' | 'PAYPAL'; documents?: Json[] } = { actor: 'SELLER' }): Promise<PaymentToken> {
  const t = svc.repo.token(t0.id) ?? t0;
  const cur = String(t.data.currency);
  const docs = opts.documents ?? [];
  const seller = opts.actor === 'SELLER';
  const buyerSide = action === 'accept-offer' || action === 'deny-offer';
  if (seller && buyerSide) {
    // Sandbox: the merchant's app can play the buyer here too (PayPal documents accept-offer / deny-offer as buyer calls).
  }
  if (t.status === 'RESOLVED') throw notAllowed(t, action);
  if (seller && !buyerSide && !allowedActions(t).includes(action) && action !== 'appeal') throw notAllowed(t, action);
  const now = ppTime();
  const note = asString(b.note);
  let outcome: 'RESOLVED' | 'UPDATED' = 'UPDATED';
  let patch: { status?: string; data: Json } = { data: { update_time: now } };

  switch (action) {
    case 'appeal':
      throw disputeErr(422, 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE', 'Only a dispute resolved against the merchant in an APPEALABLE state can be appealed; stubyard has none.');
    case 'send-message': {
      const msg = asString(b.message);
      if (!msg) throw invalidRequest('/message', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
      if (msg.length > 2000) throw invalidRequest('/message', 'INVALID_STRING_MAX_LENGTH', 'message is at most 2000 characters.');
      patch.data.messages = addMessage(t, opts.actor === 'BUYER' ? 'BUYER' : 'SELLER', msg, docs);
      break;
    }
    case 'make-offer': {
      if (!note) throw invalidRequest('/note', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
      const type = asString(b.offer_type)?.toUpperCase();
      if (!type || !OFFER_TYPES.includes(type)) throw invalidRequest('/offer_type', type ? 'INVALID_PARAMETER_VALUE' : 'MISSING_REQUIRED_PARAMETER', `offer_type is one of ${OFFER_TYPES.join(', ')}.`);
      let amount = 0;
      if (type !== 'REPLACEMENT_WITHOUT_REFUND') {
        if (!b.offer_amount) throw invalidRequest('/offer_amount', 'MISSING_REQUIRED_PARAMETER', 'offer_amount is required for refund offers.');
        amount = money(b.offer_amount, '/offer_amount', cur);
        if (amount > Number(t.data.amount)) throw disputeErr(422, 'REFUND_AMOUNT_EXCEEDED', 'The offer cannot be more than the disputed amount.', '/offer_amount');
      }
      const prev = (t.data.offer as Json | undefined) ?? { buyer_requested_amount: m(Number(t.data.amount), cur), history: [] };
      patch = {
        status: 'WAITING_FOR_BUYER_RESPONSE',
        data: {
          update_time: now,
          buyer_response_due_date: ppTime(Date.now() + 10 * DAY),
          offer: { ...prev, ...(amount ? { seller_offered_amount: m(amount, cur) } : {}), offer_type: type, history: [...((prev.history as Json[]) ?? []), { offer_time: now, actor: 'SELLER', event_type: 'PROPOSED', offer_type: type, ...(amount ? { offer_amount: m(amount, cur) } : {}) }] },
          offer_minor: amount,
          messages: addMessage(t, 'SELLER', note, docs),
          return_shipping_address: b.return_shipping_address ?? undefined,
        },
      };
      break;
    }
    case 'accept-offer':
    case 'deny-offer': {
      const offer = t.data.offer as Json | undefined;
      if (t.status !== 'WAITING_FOR_BUYER_RESPONSE' || !offer) throw notAllowed(t, action);
      const accepted = action === 'accept-offer';
      const type = String(offer.offer_type);
      const history = [...((offer.history as Json[]) ?? []), { offer_time: now, actor: 'BUYER', event_type: accepted ? 'ACCEPTED' : 'DENIED', offer_type: type }];
      const msgs = note ? addMessage(t, 'BUYER', note) : (t.data.messages as Json[] | undefined);
      if (!accepted) {
        patch = { status: 'WAITING_FOR_SELLER_RESPONSE', data: { update_time: now, offer: { ...offer, history }, seller_response_due_date: ppTime(Date.now() + 10 * DAY), messages: msgs } };
        break;
      }
      ppSave(svc, t, { data: { offer: { ...offer, history }, messages: msgs } });
      if (type === 'REFUND_WITH_RETURN') {
        // The buyer ships the item back; the merchant confirms with acknowledge-return-item, then the refund goes out.
        patch = { status: 'WAITING_FOR_SELLER_RESPONSE', data: { update_time: now, return_pending: true, seller_response_due_date: ppTime(Date.now() + 10 * DAY) } };
        break;
      }
      if (type !== 'REPLACEMENT_WITHOUT_REFUND') await settle(svc, t, Number(t.data.offer_minor ?? 0) || null, 'offer accepted');
      patch = resolvedPatch(t, 'RESOLVED_BUYER_FAVOUR');
      outcome = 'RESOLVED';
      break;
    }
    case 'acknowledge-return-item': {
      if (!t.data.return_pending) throw notAllowed(t, action);
      const ack = asString(b.acknowledgement_type)?.toUpperCase() ?? 'ITEM_RECEIVED';
      if (!ACK_TYPES.includes(ack)) throw invalidRequest('/acknowledgement_type', 'INVALID_PARAMETER_VALUE', `acknowledgement_type is one of ${ACK_TYPES.join(', ')}.`);
      if (ack === 'ITEM_RECEIVED') {
        await settle(svc, t, Number(t.data.offer_minor ?? 0) || null, 'return received');
        patch = resolvedPatch(t, 'RESOLVED_BUYER_FAVOUR');
        outcome = 'RESOLVED';
      } else patch = { status: 'UNDER_REVIEW', data: { update_time: now, return_pending: false, acknowledgement: ack } };
      if (note) patch.data.messages = addMessage(t, 'SELLER', note, docs);
      break;
    }
    case 'accept-claim': {
      const type = (asString(b.accept_claim_type) ?? 'REFUND').toUpperCase();
      if (!ACCEPT_TYPES.includes(type)) throw invalidRequest('/accept_claim_type', 'INVALID_PARAMETER_VALUE', `accept_claim_type is one of ${ACCEPT_TYPES.join(', ')}.`);
      let amount: number | null = null;
      if (b.refund_amount) {
        if (t.data.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && type !== 'PARTIAL_REFUND') throw disputeErr(422, 'AMOUNT_SHOULD_NOT_BE_PASSED', 'refund_amount cannot be passed for this dispute reason.', '/refund_amount');
        amount = money(b.refund_amount, '/refund_amount', cur);
        if (amount > Number(t.data.amount)) throw disputeErr(422, 'REFUND_AMOUNT_EXCEEDED', 'The refund cannot be more than the disputed amount.', '/refund_amount');
      } else if (type === 'PARTIAL_REFUND') throw invalidRequest('/refund_amount', 'MISSING_REQUIRED_PARAMETER', 'PARTIAL_REFUND needs refund_amount.');
      if (type === 'REFUND_WITH_RETURN' || type === 'REFUND_WITH_RETURN_SHIPMENT_LABEL') {
        patch = { status: 'WAITING_FOR_SELLER_RESPONSE', data: { update_time: now, return_pending: true, offer_minor: amount ?? Number(t.data.amount), accept_claim_type: type, ...(note ? { messages: addMessage(t, 'SELLER', note, docs) } : {}) } };
        break;
      }
      await settle(svc, t, amount, 'claim accepted');
      patch = resolvedPatch(t, 'RESOLVED_BUYER_FAVOUR');
      patch.data.accept_claim_type = type;
      if (note) patch.data.messages = addMessage(t, 'SELLER', note, docs);
      outcome = 'RESOLVED';
      break;
    }
    case 'escalate': {
      if (t.data.stage !== 'INQUIRY') throw notAllowed(t, action);
      if (seller && !note) throw invalidRequest('/note', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing.');
      patch = { status: 'UNDER_REVIEW', data: { update_time: now, stage: 'CHARGEBACK', escalated_by: opts.actor, ...(note ? { messages: addMessage(t, opts.actor === 'BUYER' ? 'BUYER' : 'SELLER', note) } : {}), ...(b.buyer_escalation_reason ? { buyer_escalation_reason: String(b.buyer_escalation_reason) } : {}) } };
      break;
    }
    case 'provide-evidence': {
      const list = Array.isArray(b.evidences) ? (b.evidences as Json[]) : [];
      if (!list.length && !docs.length) throw disputeErr(422, 'MISSING_EVIDENCE_TYPE', 'Send evidences [{evidence_type, notes, …}] (multipart part "input") and / or evidence-file parts.');
      const ev = (list.length ? list : [{ evidence_type: 'OTHER' }]).map((e, i) => {
        if (!asString(e.evidence_type)) throw disputeErr(422, 'MISSING_EVIDENCE_TYPE', 'Each evidence needs evidence_type.', `/evidences/${i}/evidence_type`);
        return { evidence_type: String(e.evidence_type).toUpperCase(), ...(e.evidence_info ? { evidence_info: e.evidence_info } : {}), ...(e.notes ? { notes: String(e.notes) } : {}), ...(i === 0 && docs.length ? { documents: docs } : {}), source: 'SUBMITTED_BY_SELLER', date: now };
      });
      patch = { status: 'UNDER_REVIEW', data: { update_time: now, evidences: [...((t.data.evidences as Json[] | undefined) ?? []), ...ev] } };
      break;
    }
    case 'provide-supporting-info': {
      if (!note && !docs.length) throw invalidRequest('/notes', 'MISSING_REQUIRED_PARAMETER', 'notes or a supporting document is required.');
      patch.data.supporting_info = [...((t.data.supporting_info as Json[] | undefined) ?? []), { notes: note ?? asString(b.notes) ?? '', ...(docs.length ? { documents: docs } : {}), source: 'SUBMITTED_BY_SELLER', provided_time: now }];
      break;
    }
    case 'require-evidence': {
      if (t.status !== 'UNDER_REVIEW') throw notAllowed(t, action);
      const who = (asString(b.action) ?? 'SELLER_EVIDENCE').toUpperCase();
      if (who !== 'SELLER_EVIDENCE' && who !== 'BUYER_EVIDENCE') throw invalidRequest('/action', 'INVALID_PARAMETER_VALUE', 'action is BUYER_EVIDENCE or SELLER_EVIDENCE.');
      patch = who === 'SELLER_EVIDENCE' ? { status: 'WAITING_FOR_SELLER_RESPONSE', data: { update_time: now, seller_response_due_date: ppTime(Date.now() + 10 * DAY) } } : { status: 'WAITING_FOR_BUYER_RESPONSE', data: { update_time: now, buyer_response_due_date: ppTime(Date.now() + 10 * DAY) } };
      break;
    }
    case 'adjudicate': {
      if (t.status !== 'UNDER_REVIEW') throw notAllowed(t, action);
      const res = (asString(b.adjudication_outcome) ?? '').toUpperCase();
      if (res !== 'BUYER_FAVOR' && res !== 'SELLER_FAVOR') throw invalidRequest('/adjudication_outcome', res ? 'INVALID_PARAMETER_VALUE' : 'MISSING_REQUIRED_PARAMETER', 'adjudication_outcome is BUYER_FAVOR or SELLER_FAVOR.');
      if (res === 'BUYER_FAVOR') await settle(svc, t, null, 'decided for the buyer');
      patch = resolvedPatch(t, res === 'BUYER_FAVOR' ? 'RESOLVED_BUYER_FAVOUR' : 'RESOLVED_SELLER_FAVOUR');
      patch.data.adjudications = [...((t.data.adjudications as Json[] | undefined) ?? []), { type: res === 'BUYER_FAVOR' ? 'PAY_BUYER' : 'RECOVER_FROM_SELLER', adjudication_time: now, reason: 'stubyard adjudication', dispute_life_cycle_stage: t.data.stage }];
      outcome = 'RESOLVED';
      break;
    }
  }
  const n = ppSave(svc, t, { ...(patch.status ? { status: patch.status } : {}), data: patch.data });
  const p = paymentOf(svc, n);
  if (p) svc.repo.addEvent(p, 'dispute', { dispute: n.providerRef, action, actor: opts.actor, status: n.status, ...(n.data.outcome ? { outcome: n.data.outcome } : {}) });
  await event(svc, inst, n, outcome);
  return svc.repo.token(n.id)!;
}

/** Control API / dashboard: the buyer opens a dispute on a captured PayPal payment. */
export async function openDispute(svc: PaymentService, p: Payment, f: { reason?: unknown; amount?: unknown; stage?: unknown; message?: unknown; channel?: unknown }): Promise<PaymentToken> {
  const inst = svc.repo.instanceById(p.instanceId);
  if (!inst || inst.preset !== 'paypal') throw new HttpError(400, 'Disputes are simulated for PayPal payments only');
  if (p.status !== 'paid' && p.status !== 'partially_refunded') throw new HttpError(409, `Payment is ${p.status}; a dispute needs a captured payment (paid or partially refunded)`, { status: p.status });
  const open = ppList(svc, p.projectId, PP_KIND.dispute, { instanceId: inst.id }).find((t) => t.data.disputedPayment === p.id && t.status !== 'RESOLVED');
  if (open) throw new HttpError(409, `Payment already has an open dispute (${open.providerRef})`, { dispute: open.providerRef });
  const reason = (asString(f.reason) ?? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED').toUpperCase();
  if (!DISPUTE_REASONS.includes(reason)) throw new HttpError(400, `reason is one of ${DISPUTE_REASONS.join(', ')}`);
  const stage = (asString(f.stage) ?? 'INQUIRY').toUpperCase();
  if (stage !== 'INQUIRY' && stage !== 'CHARGEBACK') throw new HttpError(400, 'stage is INQUIRY or CHARGEBACK');
  const channel = (asString(f.channel) ?? (stage === 'CHARGEBACK' ? 'EXTERNAL' : 'INTERNAL')).toUpperCase();
  if (!['INTERNAL', 'EXTERNAL', 'ALERT'].includes(channel)) throw new HttpError(400, 'channel is INTERNAL, EXTERNAL or ALERT');
  const left = remaining(svc, p);
  let amount = left;
  if (f.amount !== undefined && f.amount !== null && f.amount !== '') {
    const a = fromDecimal(f.amount, p.currency);
    if (!a.ok || a.minor <= 0) throw new HttpError(400, 'amount is a decimal string such as "10.00"');
    if (a.minor > left) throw new HttpError(400, `amount is more than the ${toDecimal(left, p.currency)} ${p.currency} left on the payment`);
    amount = a.minor;
  }
  const sale = !!p.providerData.sale || !!p.providerData.subscription;
  const sellerTx = sale ? String(p.providerData.saleId ?? p.providerRef) : String(captureOf(svc, p, inst).id);
  const user = p.testUserId ? svc.hub.users.get(p.projectId, p.testUserId) : null;
  const now = ppTime();
  const id = `PP-D-${Math.floor(10000 + Math.random() * 90000)}`;
  const msg = asString(f.message) ?? (reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' ? 'I have not received the item.' : reason === 'UNAUTHORISED' ? 'I did not make this payment.' : 'The item is not as described.');
  const t = ppAdd(svc, inst, PP_KIND.dispute, {
    ref: id,
    status: stage === 'CHARGEBACK' ? 'UNDER_REVIEW' : 'WAITING_FOR_SELLER_RESPONSE',
    runId: p.runId,
    customerId: user?.id ?? null,
    data: {
      disputedPayment: p.id,
      reason,
      stage,
      channel,
      amount,
      currency: p.currency,
      refunded: 0,
      create_time: now,
      update_time: now,
      seller_response_due_date: ppTime(Date.now() + (stage === 'INQUIRY' ? 20 : 10) * DAY),
      transaction: {
        buyer_transaction_id: upper(17),
        seller_transaction_id: sellerTx,
        create_time: ppTime(Date.parse(p.createdAt)),
        transaction_status: 'COMPLETED',
        gross_amount: m(p.amount, p.currency),
        ...(p.reference ? { invoice_number: p.reference, custom: p.reference } : {}),
        buyer: { name: user?.name ?? 'John Doe' },
        seller: { email: 'sb-merchant@business.example.com', merchant_id: String(p.providerData.merchantId ?? upper(13)), name: 'Test Store' },
      },
      messages: [{ posted_by: 'BUYER', time_posted: now, content: msg }],
    },
  });
  svc.repo.addEvent(p, 'dispute', { dispute: id, action: 'opened', reason, stage, amount });
  await event(svc, inst, t, 'CREATED');
  return svc.repo.token(t.id)!;
}

/** Control API: PayPal decides (buyer / seller favour) or the buyer cancels. */
export async function resolveDispute(svc: PaymentService, t: PaymentToken, outcome: string): Promise<PaymentToken> {
  const inst = svc.repo.instanceById(t.instanceId)!;
  if (t.status === 'RESOLVED') throw new HttpError(409, `Dispute ${t.providerRef} is already resolved`);
  const o = outcome.toLowerCase();
  if (!['buyer', 'seller', 'cancelled'].includes(o)) throw new HttpError(400, 'outcome is buyer, seller or cancelled');
  if (o === 'buyer') await settle(svc, t, null, 'decided for the buyer');
  const n = ppSave(svc, t, resolvedPatch(t, o === 'buyer' ? 'RESOLVED_BUYER_FAVOUR' : o === 'seller' ? 'RESOLVED_SELLER_FAVOUR' : 'CANCELED_BY_BUYER'));
  const p = paymentOf(svc, n);
  if (p) svc.repo.addEvent(p, 'dispute', { dispute: n.providerRef, action: 'resolved', outcome: n.data.outcome });
  await event(svc, inst, n, 'RESOLVED');
  return svc.repo.token(n.id)!;
}

export function disputeView(svc: PaymentService, t: PaymentToken): Json {
  const inst = svc.repo.instanceById(t.instanceId)!;
  const p = paymentOf(svc, t);
  const cur = String(t.data.currency);
  return {
    id: t.providerRef,
    tokenId: t.id,
    instance: inst.slug,
    status: t.status,
    state: disputeState(t),
    stage: t.data.stage,
    reason: t.data.reason,
    amount: toDecimal(Number(t.data.amount), cur),
    refunded: toDecimal(Number(t.data.refunded ?? 0), cur),
    currency: cur,
    outcome: t.data.outcome ?? null,
    paymentId: p?.id ?? null,
    paymentStatus: p?.status ?? null,
    sellerTransactionId: (t.data.transaction as Json).seller_transaction_id,
    allowed: allowedActions(t),
    buyerCan: t.status === 'WAITING_FOR_BUYER_RESPONSE' && t.data.offer ? ['accept-offer', 'deny-offer', 'send-message'] : t.status === 'RESOLVED' ? [] : ['send-message', ...(t.data.stage === 'INQUIRY' ? ['escalate'] : [])],
    offer: t.data.offer ?? null,
    returnPending: !!t.data.return_pending,
    messages: t.data.messages ?? [],
    webhooks: t.data.webhooks ?? [],
    run: t.runId ? (svc.hub.runs.repo.get(t.runId)?.key ?? null) : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resource: disputeOf(svc, inst, t),
  };
}

/** Multipart bodies (provide-evidence, send-message, …): the JSON "input" part plus file parts (≤ 10 MB, JPG/GIF/PNG/PDF). */
async function readBody(req: FastifyRequest, b: Json): Promise<{ body: Json; documents: Json[] }> {
  const ct = header(req, 'content-type') ?? '';
  const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (!/^multipart\/form-data/i.test(ct) || !raw) return { body: b, documents: [] };
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), { headers: { 'content-type': ct } }).formData();
  } catch {
    throw invalidRequest('/', 'MALFORMED_REQUEST', 'The multipart body could not be parsed.');
  }
  let body: Json = {};
  const documents: Json[] = [];
  for (const [name, v] of form.entries()) {
    if (typeof v === 'string') {
      if (name === 'input') {
        try {
          body = JSON.parse(v) as Json;
        } catch {
          throw invalidRequest('/input', 'MALFORMED_REQUEST_JSON', 'The "input" part is not valid JSON.');
        }
      } else body[name] = v;
      continue;
    }
    const file = v as File;
    if (!FILE_TYPES.test(file.name) || file.size > MAX_FILE) throw disputeErr(422, 'INVALID_EVIDENCE_FILE', `${file.name}: files must be JPG, GIF, PNG or PDF and at most 10 MB each.`);
    documents.push({ name: file.name, size: String(file.size), part: name });
  }
  return { body, documents };
}

/** /v1/customer/disputes… (bearer already checked). */
export async function disputesApiRoute(c: GatewayCtx, b0: Json): Promise<unknown> {
  const { svc, inst, path } = c;
  if (!path.startsWith('/v1/customer/disputes')) return undefined;
  const method = c.req.method;
  if (path === '/v1/customer/disputes' && method === 'GET') {
    c.resolved.endpoint = 'list disputes';
    const size = c.query.page_size === undefined ? 10 : Number(c.query.page_size);
    if (!Number.isInteger(size) || size < 1 || size > 50) throw disputeErr(400, 'INVALID_PAGE_SIZE', 'page_size must be 1 to 50.', 'page_size');
    const page = c.query.page === undefined ? 1 : Number(c.query.page);
    if (!Number.isInteger(page) || page < 1) throw disputeErr(400, 'INVALID_PARAMETER_VALUE', 'page must be a positive integer.', 'page');
    const tx = asString(c.query.disputed_transaction_id);
    const states = asString(c.query.dispute_state)?.toUpperCase().split(',');
    const after = asString(c.query.start_time) ?? asString(c.query.create_time_after);
    const before = asString(c.query.create_time_before);
    const all = ppList(svc, inst.projectId, PP_KIND.dispute, { instanceId: inst.id })
      .reverse()
      .filter((t) => (!tx || [(t.data.transaction as Json).seller_transaction_id, (t.data.transaction as Json).buyer_transaction_id].includes(tx)) && (!states || states.includes(disputeState(t))) && (!after || String(t.data.create_time) >= after) && (!before || String(t.data.create_time) <= before));
    const items = all.slice((page - 1) * size, page * size);
    const api = svc.urls(c.project, inst).backend;
    const links: Json[] = [{ href: `${api}/v1/customer/disputes?page_size=${size}&page=${page}`, rel: 'self', method: 'GET' }];
    if (page * size < all.length) links.push({ href: `${api}/v1/customer/disputes?page_size=${size}&page=${page + 1}`, rel: 'next', method: 'GET' });
    return { items: items.map((t) => disputeInfo(svc, inst, t)), links };
  }
  const mm = /^\/v1\/customer\/disputes\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (!mm) return undefined;
  const t = ppFind(svc, inst, PP_KIND.dispute, decodeRef(mm[1]!));
  if (!t) throw disputeErr(404, 'INVALID_RESOURCE_ID', 'The requested dispute does not exist.');
  c.resolved.dispute = t.providerRef;
  if (t.data.disputedPayment) c.resolved.payment = t.data.disputedPayment;
  const action = mm[2] as SellerAction | undefined;
  if (!action && method === 'GET') {
    c.resolved.endpoint = 'get dispute';
    return disputeOf(svc, inst, t);
  }
  if (!action || method !== 'POST') return undefined;
  if (!ACTIONS.includes(action)) return undefined;
  c.resolved.endpoint = `dispute ${action}`;
  const { body, documents } = await readBody(c.req, b0);
  const actor = action === 'accept-offer' || action === 'deny-offer' ? 'BUYER' : 'SELLER';
  const n = await disputeAction(svc, inst, t, action, body, { actor, documents });
  const api = svc.urls(c.project, inst).backend;
  return { links: [{ href: `${api}/v1/customer/disputes/${n.providerRef}`, rel: 'parent', method: 'GET' }] };
}
