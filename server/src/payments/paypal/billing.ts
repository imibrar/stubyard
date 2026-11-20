import type { Hub } from '../../hub.js';
import type { Job } from '../../jobs/scheduler.js';
import { sendOutbound } from '../../traffic/outbound.js';
import { sign } from '../../webhooks/signing.js';
import { alnum, upper } from '../common.js';
import type { Json } from '../gateway.js';
import type { PaymentInstance, PaymentToken } from '../repo.js';
import type { PaymentService } from '../service.js';
import { RETRY_DELAYS_MS } from '../webhooks.js';
import { certUrlOf, PpError } from './index.js';

/**
 * Shared plumbing of PayPal subscriptions (subscriptions.ts) and disputes (disputes.ts): their resources live in
 * payment_tokens (kind pp_product | pp_plan | pp_subscription | pp_dispute, provider_ref = the PayPal id, status = the
 * PayPal status, data = the resource), and events that belong to no payment (BILLING.PLAN.*, BILLING.SUBSCRIPTION.*,
 * CATALOG.PRODUCT.*) are signed like every PayPal webhook and delivered here, with the payment webhooks' retry delays
 * through the durable job queue.
 */

export const PP_KIND = { product: 'pp_product', plan: 'pp_plan', subscription: 'pp_subscription', dispute: 'pp_dispute' } as const;
export type PpKind = (typeof PP_KIND)[keyof typeof PP_KIND];
const asKind = (k: PpKind) => k as unknown as PaymentToken['kind'];

/** PayPal timestamps: second precision, Z. */
export const ppTime = (ms: number = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const debugId = () => alnum(13).toLowerCase();

export function ppFind(svc: PaymentService, inst: PaymentInstance, kind: PpKind, ref: string): PaymentToken | null {
  return svc.repo.tokenByRef(inst.id, ref, asKind(kind));
}
export function ppList(svc: PaymentService, projectId: string, kind: PpKind, f: { instanceId?: string; runId?: string; limit?: number } = {}): PaymentToken[] {
  return svc.repo.listTokens(projectId, { instanceId: f.instanceId, runId: f.runId, kind, limit: f.limit ?? 500 });
}
export function ppAdd(svc: PaymentService, inst: PaymentInstance, kind: PpKind, f: { ref: string; status: string; runId: string | null; customerId?: string | null; data: Json }): PaymentToken {
  return svc.repo.addToken({ projectId: inst.projectId, instanceId: inst.id, runId: f.runId, kind: asKind(kind), providerRef: f.ref, customerId: f.customerId ?? null, status: f.status, source: 'paypal', cardBrand: null, cardLast4: null, expiry: null, data: f.data });
}
export function ppSave(svc: PaymentService, t: PaymentToken, patch: { status?: string; data?: Json; customerId?: string | null }): PaymentToken {
  const cur = svc.repo.token(t.id) ?? t;
  return svc.repo.updateToken(t.id, { ...(patch.status ? { status: patch.status } : {}), ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}), data: { ...cur.data, ...(patch.data ?? {}) } });
}

/** PayPal error envelope (subscriptions / catalog / disputes docs link). */
export function ppError(status: number, issue: string, description: string, opts: { field?: string; api?: 'subscriptions' | 'disputes' | 'catalog' } = {}): PpError {
  const name = status === 404 ? 'RESOURCE_NOT_FOUND' : status === 422 ? 'UNPROCESSABLE_ENTITY' : status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_SERVER_ERROR';
  const message =
    status === 404
      ? 'The specified resource does not exist.'
      : status === 422
        ? 'The requested action could not be performed, semantically incorrect, or failed business validation.'
        : status === 400
          ? 'Request is not well-formed, syntactically incorrect, or violates schema.'
          : 'An internal server error has occurred.';
  const doc = opts.api === 'disputes' ? 'customer-disputes/v1' : opts.api === 'catalog' ? 'catalog-products/v1' : 'subscriptions/v1';
  return new PpError(status, {
    name,
    message,
    debug_id: debugId(),
    details: [{ ...(opts.field ? { field: opts.field, location: 'body' } : {}), issue, description }],
    links: [{ href: `https://developer.paypal.com/docs/api/${doc}/#error-${issue}`, rel: 'information_link', method: 'GET' }],
  });
}

/** One webhook record on the resource (data.webhooks, newest 20). */
function record(svc: PaymentService, tokenId: string | null, rec: Json): void {
  if (!tokenId) return;
  const t = svc.repo.token(tokenId);
  if (!t) return;
  const list = ((t.data.webhooks as Json[] | undefined) ?? []).slice(-19);
  svc.repo.updateToken(t.id, { data: { ...t.data, webhooks: [...list, rec] } });
}

export const WEBHOOK_JOB = 'paypal.extras.webhook';

interface Delivery {
  instanceId: string;
  tokenId: string | null;
  url: string;
  body: string;
  type: string;
  eventId: string;
  runId: string | null;
  attempt: number;
}

/**
 * Send a PayPal event that belongs to no payment (plan, product, subscription): built now, signed with the instance
 * key at each attempt, delivered after webhookDelayMs (inline when 0), retried after 5 s / 30 s / 120 s on failure.
 */
export async function sendPpEvent(svc: PaymentService, inst: PaymentInstance, t: PaymentToken | null, ev: { type: string; resourceType: string; resourceVersion: string; summary: string; resource: Json }): Promise<void> {
  const project = svc.hub.projects.get(inst.projectId);
  if (!project) return;
  const api = svc.urls(project, inst).backend;
  const id = `WH-${upper(17)}-${upper(17)}`;
  const body = JSON.stringify({
    id,
    event_version: '1.0',
    create_time: new Date().toISOString(),
    resource_type: ev.resourceType,
    resource_version: ev.resourceVersion,
    event_type: ev.type,
    summary: ev.summary,
    resource: ev.resource,
    links: [
      { href: `${api}/v1/notifications/webhooks-events/${id}`, rel: 'self', method: 'GET' },
      { href: `${api}/v1/notifications/webhooks-events/${id}/resend`, rel: 'resend', method: 'POST' },
    ],
  });
  const url = inst.config.webhookUrl;
  if (!url) {
    record(svc, t?.id ?? null, { type: ev.type, eventId: id, at: new Date().toISOString(), ok: false, status: null, error: 'no webhook URL', attempt: 0 });
    svc.changed(inst.projectId, { paypal: ev.type });
    return;
  }
  const d: Delivery = { instanceId: inst.id, tokenId: t?.id ?? null, url, body, type: ev.type, eventId: id, runId: t?.runId ?? null, attempt: 1 };
  const delay = Number(inst.config.webhookDelayMs ?? 500);
  if (delay > 0) {
    svc.hub.scheduler.schedule(WEBHOOK_JOB, d as unknown as Json, { projectId: inst.projectId, delayMs: delay });
    record(svc, d.tokenId, { type: ev.type, eventId: id, at: new Date().toISOString(), queued: true, inMs: delay, attempt: 1 });
    return;
  }
  await deliver(svc, d);
}

async function deliver(svc: PaymentService, d: Delivery): Promise<void> {
  const inst = svc.repo.instanceById(d.instanceId);
  if (!inst) return;
  const sig = inst.config.privateKeyPem && inst.config.webhookId ? sign({ preset: 'paypal', privateKey: inst.config.privateKeyPem, webhookId: inst.config.webhookId, certUrl: certUrlOf(svc, inst) }, d.body) : {};
  const res = await sendOutbound(svc.hub.traffic, {
    projectId: inst.projectId,
    parentLogId: null,
    url: d.url,
    headers: { 'content-type': 'application/json', ...sig },
    body: d.body,
    purpose: 'payment webhook',
    runId: d.runId,
    resolved: { kind: 'payment-webhook', instance: inst.slug, event: d.type, eventId: d.eventId, attempt: d.attempt },
  });
  let retryIn: number | null = null;
  if (!res.ok && !res.blocked && d.attempt <= RETRY_DELAYS_MS.length) {
    retryIn = RETRY_DELAYS_MS[d.attempt - 1]!;
    svc.hub.scheduler.schedule(WEBHOOK_JOB, { ...d, attempt: d.attempt + 1 } as unknown as Json, { projectId: inst.projectId, delayMs: retryIn });
  }
  record(svc, d.tokenId, { type: d.type, eventId: d.eventId, at: new Date().toISOString(), ok: res.ok, status: res.status, logId: res.logId, attempt: d.attempt, ...(res.ok ? {} : { error: res.error ?? `Your app answered ${res.status}` }), ...(retryIn ? { retryInMs: retryIn } : {}), ...(sig['PAYPAL-TRANSMISSION-ID'] ? { transmissionId: sig['PAYPAL-TRANSMISSION-ID'] } : {}) });
  svc.changed(inst.projectId, { paypal: d.type, webhook: d.type, ...(res.ok ? {} : { failed: true }) });
}

const registered = new WeakSet<object>();
/** Job handlers of this module (webhook deliveries) and of subscriptions.ts (billing cycles); called once per hub. */
export function registerPpJobs(hub: Hub, extra: Record<string, (job: Job) => Promise<void>>): void {
  if (registered.has(hub)) return;
  registered.add(hub);
  hub.scheduler.register(WEBHOOK_JOB, async (job) => {
    const svc = hub.payments;
    if (!svc) return;
    await deliver(svc, job.payload as unknown as Delivery);
  });
  for (const [type, fn] of Object.entries(extra)) hub.scheduler.register(type, fn);
}
