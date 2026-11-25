import { sendOutbound } from '../traffic/outbound.js';
import { sign } from '../webhooks/signing.js';
import type { Project } from '../repos/projects.js';
import type { Outcome } from './engine.js';
import type { BuiltEvent, EventCtx, Json, LifecyclePoint } from './gateway.js';
import { finding } from './lint.js';
import type { Payment, PaymentEventRow, PaymentInstance } from './repo.js';
import type { PaymentService } from './service.js';

/** BuiltEvent.method / query as stored on the scheduled event (only when not the default POST without query). */
function httpOf(b: BuiltEvent): Json {
  return { ...(b.method && b.method !== 'POST' ? { method: b.method } : {}), ...(b.query && Object.keys(b.query).length ? { query: b.query } : {}) };
}

/** url with query parameters appended (existing ones kept). */
export function withQuery(url: string, q: Record<string, string> | undefined): string {
  if (!q || !Object.keys(q).length) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

/** Retries after a failed delivery (attempt 2, 3, 4), like a real gateway backing off. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];
const DEFAULT_DELAY_MS = 500;
const DEFAULT_SETTLE_MS = 3_000;

/** The event context stored on a scheduled event (a refund's events carry the refund id). */
const ctxOf = (data: Json): EventCtx | undefined => (data.refund ? { refund: String(data.refund) } : undefined);

export interface DeliverResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  attempt: number;
  eventType: string;
  eventId: string;
  logId: string | null;
  settled?: boolean;
  retry: { scheduleId: string | null; inMs: number } | null;
}

/**
 * Payment webhooks: built when the payment changes, recorded as "webhook_scheduled" events and delivered through
 * hub.schedules (action payment.webhook → POST /api/projects/<slug>/payments/<id>/webhooks/<event>/deliver).
 * A delay of 0 delivers inline (before the browser is redirected). Failed deliveries are retried as new schedules.
 */
export class PaymentWebhooks {
  constructor(private svc: PaymentService) {}

  private get hub() {
    return this.svc.hub;
  }

  /** Queue the webhooks of one lifecycle point (honours no_webhook / duplicate_webhook / webhook_delay). */
  async emit(p: Payment, inst: PaymentInstance, point: LifecyclePoint, o: Outcome | null, ctx?: EventCtx): Promise<void> {
    const g = this.svc.gateway(inst.preset);
    const types = g.events(p, point, ctx);
    if (!types.length) return;
    if (o?.noWebhook) {
      for (const t of types) this.svc.repo.addEvent(p, 'webhook_skipped', { eventType: t, reason: 'no_webhook', ...(ctx?.refund ? { refund: ctx.refund } : {}) });
      return;
    }
    const delay = o?.webhookDelayMs ?? inst.config.webhookDelayMs ?? DEFAULT_DELAY_MS;
    for (const t of types) {
      const row = await this.queue(p, inst, t, { delayMs: delay, ctx });
      if (row && o?.duplicateWebhook) await this.redeliver(p, row, Math.max(delay, 0) + 200);
    }
  }

  /** pending_then_success: settle later; the "settled" events are built at delivery (after the payment is paid). */
  async scheduleSettle(p: Payment, inst: PaymentInstance, o: Outcome | null): Promise<void> {
    const g = this.svc.gateway(inst.preset);
    const delay = inst.config.settleDelayMs ?? DEFAULT_SETTLE_MS;
    const types = g.events({ ...p, status: 'paid' }, 'settled');
    const silent = !!o?.noWebhook || !types.length;
    const list = silent ? ['(settle)'] : types;
    for (const [i, t] of list.entries()) {
      const row = this.svc.repo.addEvent(p, 'webhook_scheduled', { eventType: t, eventId: null, lazy: true, settle: i === 0, silent, delayMs: delay });
      await this.dispatch(p, row, delay + i * 50, 1);
    }
  }

  /**
   * A refund that resolves later (pending_then_success / failed): the first scheduled event moves the refund to `to`
   * (PaymentService.settleRefund) at delivery; the events are built then, with the refund as it is after the move.
   */
  async scheduleRefundSettle(p: Payment, inst: PaymentInstance, refund: string, to: { status: 'succeeded' | 'failed'; failureReason?: string | null }, types: string[], o: Outcome | null): Promise<void> {
    const delay = inst.config.settleDelayMs ?? DEFAULT_SETTLE_MS;
    const silent = !!o?.noWebhook || !types.length;
    const list = silent ? ['(refund settle)'] : types;
    for (const [i, t] of list.entries()) {
      const row = this.svc.repo.addEvent(p, 'webhook_scheduled', { eventType: t, eventId: null, lazy: true, refund, ...(i === 0 ? { refundSettle: to } : {}), silent, delayMs: delay });
      await this.dispatch(p, row, delay + i * 50, 1);
    }
  }

  /** Build the event now, record it and deliver it (inline or scheduled). */
  async queue(p: Payment, inst: PaymentInstance, type: string, opts: { delayMs: number; ctx?: EventCtx }): Promise<PaymentEventRow | null> {
    const g = this.svc.gateway(inst.preset);
    const built = g.buildEvent(this.svc, p, inst, type, opts.ctx);
    const refund = opts.ctx?.refund ? { refund: opts.ctx.refund } : {};
    if (!built.url) {
      this.svc.repo.addEvent(p, 'webhook_skipped', { eventType: type, eventId: built.eventId, reason: 'no webhook URL', body: built.body, ...refund });
      this.svc.addLint(this.svc.repo.get(p.id)!, [finding('pay.no-webhook-url', `${type} was not sent: no webhook URL`)]);
      return null;
    }
    const row = this.svc.repo.addEvent(p, 'webhook_scheduled', { eventType: type, eventId: built.eventId, ...refund, url: built.url, body: built.body, delayMs: opts.delayMs, ...(built.headers ? { headers: built.headers } : {}), ...(built.plain ? { plain: built.plain } : {}), ...httpOf(built) });
    await this.dispatch(p, row, opts.delayMs, 1);
    return row;
  }

  /** Another delivery of an already built event (duplicate_webhook, resend). */
  async redeliver(p: Payment, row: PaymentEventRow, delayMs: number): Promise<DeliverResult | null> {
    return this.dispatch(p, row, delayMs, 1);
  }

  private async dispatch(p: Payment, row: PaymentEventRow, delayMs: number, attempt: number): Promise<DeliverResult | null> {
    const project = this.hub.projects.get(p.projectId);
    if (!project) return null;
    if (delayMs <= 0) return this.deliver(project, p, row.id, attempt);
    const run = p.runId ? this.hub.runs.resolver.activeById(p.runId) : null;
    const s = this.hub.schedules.create(
      project,
      { method: 'POST', path: `/payments/${p.id}/webhooks/${row.id}/deliver`, body: { attempt }, delayMs, label: `Payment webhook ${String(row.data.eventType)} (${p.providerRef})${attempt > 1 ? ` · retry ${attempt - 1}` : ''}` },
      run,
    );
    this.svc.repo.addEvent(p, 'webhook_queued', { scheduled: row.id, eventType: row.data.eventType, scheduleId: s.id, inMs: delayMs, attempt });
    return null;
  }

  /** One delivery attempt (the schedule target). App rejections are a normal result (ok:false), not an error. */
  async deliver(project: Project, p0: Payment, scheduledId: string, attempt: number): Promise<DeliverResult> {
    let p = p0;
    const row = this.svc.repo.event(scheduledId);
    if (!row || row.paymentId !== p.id || row.type !== 'webhook_scheduled') throw Object.assign(new Error(`Webhook "${scheduledId}" not found on this payment`), { statusCode: 404 });
    const inst = this.svc.instanceOf(p);
    const g = this.svc.gateway(inst.preset);
    let settled = false;
    if (row.data.settle) {
      const before = p.status;
      p = this.svc.settle(p);
      settled = p.status !== before;
    }
    if (row.data.refundSettle && row.data.refund) p = this.svc.settleRefund(p, String(row.data.refund), row.data.refundSettle as { status: 'succeeded' | 'failed'; failureReason?: string | null });
    let data = row.data;
    if (data.lazy && !data.silent && !data.body) {
      const built = g.buildEvent(this.svc, p, inst, String(data.eventType), ctxOf(data));
      data = { ...data, eventId: built.eventId, url: built.url, body: built.body, ...(built.headers ? { headers: built.headers } : {}), ...(built.plain ? { plain: built.plain } : {}), ...httpOf(built) };
      this.hub.db.prepare('UPDATE payment_events SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    }
    const eventType = String(data.eventType);
    const eventId = String(data.eventId ?? '');
    const base: DeliverResult = { ok: true, status: null, error: null, attempt, eventType, eventId, logId: null, settled, retry: null };
    if (data.silent) return base;
    if (!data.url) {
      this.svc.repo.addEvent(p, 'webhook_skipped', { scheduled: row.id, eventType, eventId, reason: 'no webhook URL' });
      this.svc.addLint(this.svc.repo.get(p.id)!, [finding('pay.no-webhook-url', `${eventType} was not sent: no webhook URL`)]);
      this.svc.changed(p.projectId, { payment: p.id });
      return { ...base, ok: false, error: 'no webhook URL' };
    }
    const body = String(data.body ?? '');
    const built = g.buildEvent(this.svc, p, inst, eventType, ctxOf(data));
    const sig = built.signing ? sign(built.signing, body) : {};
    const get = data.method === 'GET';
    const res = await sendOutbound(this.hub.traffic, {
      projectId: p.projectId,
      parentLogId: p.logId,
      method: get ? 'GET' : 'POST',
      url: withQuery(String(data.url), data.query as Record<string, string> | undefined),
      // Headers stored with the body (an encrypted body's IV / tag belong to that exact body).
      headers: { ...(get ? {} : { 'content-type': 'application/json' }), ...((data.headers as Record<string, string> | undefined) ?? {}), ...sig },
      body: get ? undefined : body,
      purpose: 'payment webhook',
      runId: p.runId,
      resolved: { kind: 'payment-webhook', payment: p.id, instance: inst.slug, event: eventType, eventId, attempt },
    });
    const transmission = sig['PAYPAL-TRANSMISSION-ID'] ? { transmissionId: sig['PAYPAL-TRANSMISSION-ID'], transmissionTime: sig['PAYPAL-TRANSMISSION-TIME'], signature: sig['PAYPAL-TRANSMISSION-SIG'] } : {};
    const rec: Json = { scheduled: row.id, eventType, eventId, attempt, status: res.status, logId: res.logId, url: data.url, ...transmission };
    p = this.svc.repo.get(p.id) ?? p;
    if (res.ok) {
      this.svc.repo.addEvent(p, 'webhook_delivered', rec);
      this.svc.changed(p.projectId, { payment: p.id, webhook: eventType });
      return { ...base, status: res.status, logId: res.logId };
    }
    this.svc.repo.addEvent(p, 'webhook_failed', { ...rec, error: res.error ?? `Your app answered ${res.status}`, blocked: !!res.blocked });
    if (res.status !== null) this.svc.addLint(p, [finding('pay.webhook-rejected', `Your app answered ${res.status} to ${eventType}`)]);
    let retry: DeliverResult['retry'] = null;
    if (!res.blocked && attempt <= RETRY_DELAYS_MS.length) {
      const inMs = RETRY_DELAYS_MS[attempt - 1]!;
      const run = p.runId ? this.hub.runs.resolver.activeById(p.runId) : null;
      const s = this.hub.schedules.create(
        project,
        { method: 'POST', path: `/payments/${p.id}/webhooks/${row.id}/deliver`, body: { attempt: attempt + 1 }, delayMs: inMs, label: `Payment webhook ${eventType} (${p.providerRef}) · retry ${attempt}` },
        run,
      );
      retry = { scheduleId: s.id, inMs };
      this.svc.repo.addEvent(p, 'webhook_queued', { scheduled: row.id, eventType, scheduleId: s.id, inMs, attempt: attempt + 1 });
    }
    this.svc.changed(p.projectId, { payment: p.id, webhook: eventType, failed: true });
    return { ...base, ok: false, status: res.status, error: res.error ?? `Your app answered ${res.status}`, logId: res.logId, retry };
  }

  /** Resend now: a scheduled-event id, or the newest event of a type ("checkout.session.completed"). */
  async resend(project: Project, p: Payment, ref: string): Promise<DeliverResult> {
    const rows = this.svc.repo.events(p.id).filter((e) => e.type === 'webhook_scheduled' && !e.data.silent);
    const row = rows.find((e) => e.id === ref) ?? [...rows].reverse().find((e) => e.data.eventType === ref);
    if (!row) throw Object.assign(new Error(`No webhook "${ref}" on this payment (types: ${[...new Set(rows.map((r) => String(r.data.eventType)))].join(', ') || 'none'})`), { statusCode: 404 });
    // A resend is a fresh first attempt (its own retries).
    const fresh = row.data.url ? row : { ...row, data: { ...row.data, url: this.svc.gateway(this.svc.instanceOf(p).preset).buildEvent(this.svc, p, this.svc.instanceOf(p), String(row.data.eventType), ctxOf(row.data)).url } };
    if (fresh !== row) this.hub.db.prepare('UPDATE payment_events SET data = ? WHERE id = ?').run(JSON.stringify(fresh.data), row.id);
    return this.deliver(project, p, row.id, 1);
  }
}
