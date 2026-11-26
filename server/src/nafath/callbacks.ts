import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { sendOutbound } from '../traffic/outbound.js';
import { HttpError, nowIso } from '../util.js';
import type { Decision, NafathDelivery, NafathService } from './service.js';
import type { NafathCallbackAttempt, NafathInstance, NafathRequest } from './types.js';

type J = Record<string, unknown>;

/** Retries after a failed callback (attempt 2, 3, 4), like the payment webhooks. */
export const CALLBACK_RETRY_MS = [5_000, 30_000, 120_000];

/** One recorded attempt, with its attempt number and traffic row. */
export type CallbackAttempt = NafathCallbackAttempt & { attempt: number; logId: string | null; skipped?: string };

export interface CallbackResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  attempt: number;
  logId: string | null;
  /** Not sent (no callback URL, the no_callback fault). */
  skipped?: string;
  retry: { scheduleId: string; inMs: number } | null;
}

/** The callback body (§4.3): {transId, requestId, status, token}; compat adds transactionId. */
export function callbackBody(instance: NafathInstance, r: NafathRequest, token: string): J {
  return {
    transId: r.transId,
    requestId: r.requestId,
    status: r.status,
    token,
    ...(instance.config.callbackFields === 'compat' ? { transactionId: r.transId } : {}),
  };
}

/**
 * Nafath callbacks and delayed decisions, through hub.schedules so they survive restarts: the first callback is sent
 * right after the decision; failed ones are retried by the allowlisted action `nafath.callback`
 * (POST /api/projects/<slug>/nafath/requests/<id>/callback/deliver), delayed decisions by `nafath.decide`.
 */
export class NafathCallbacks implements NafathDelivery {
  constructor(
    private hub: Hub,
    private svc: NafathService,
  ) {}

  private runOf(r: NafathRequest) {
    return r.runId ? this.hub.runs.resolver.activeById(r.runId) : null;
  }

  scheduleDecision(r: NafathRequest, decision: Decision, delayMs: number, decidedBy: string): void {
    const project = this.hub.projects.get(r.projectId);
    if (!project) return;
    this.hub.schedules.create(
      project,
      { method: 'POST', path: `/nafath/requests/${r.id}/decide`, body: { decision, decidedBy }, delayMs, label: `Nafath ${decision} (${r.nationalId})` },
      this.runOf(r),
    );
  }

  /** After a terminal transition: the callback-stage faults, then the first attempt (in the background). */
  callback(r: NafathRequest): void {
    const project = this.hub.projects.get(r.projectId);
    if (!project) return;
    const f = this.svc.pickFault('callback', this.svc.ctxOf(r))?.fault ?? null;
    if (f?.kind === 'no_callback') {
      const instance = this.svc.repo.getInstance(r.instanceId);
      this.record(r.id, { at: nowIso(), url: instance?.config.callbackUrl ?? '', status: null, error: 'Not sent (fault no_callback)', attempt: 1, logId: null, skipped: 'no_callback' });
      return;
    }
    void (async () => {
      await this.deliver(project, r.id, 1);
      if (f?.kind === 'duplicate_callback') await this.deliver(project, r.id, 1, { duplicate: true });
    })().catch(() => {});
  }

  /** Resend now: a fresh first attempt (with its own retries); faults do not apply. */
  resend(project: Project, r: NafathRequest): Promise<CallbackResult> {
    return this.deliver(project, r.id, 1);
  }

  /** One delivery attempt (the schedule target). The app answering non-2xx is a normal result (ok:false). */
  async deliver(project: Project, requestId: string, attempt: number, o: { duplicate?: boolean } = {}): Promise<CallbackResult> {
    const r = this.svc.repo.getRequest(requestId);
    const instance = r ? this.svc.repo.getInstance(r.instanceId) : null;
    if (!r || !instance || r.projectId !== project.id) throw new HttpError(404, `Nafath request "${requestId}" not found`);
    const base: CallbackResult = { ok: false, status: null, error: null, attempt, logId: null, retry: null };
    if (r.status === 'WAITING') return { ...base, error: 'The request is still WAITING', skipped: 'waiting' };
    const url = instance.config.callbackUrl;
    if (!url) return { ...base, error: 'The instance has no callback URL', skipped: 'no_callback_url' };
    const body = callbackBody(instance, r, this.svc.callbackToken(instance, r));
    const res = await sendOutbound(this.hub.traffic, {
      projectId: r.projectId,
      parentLogId: r.logId,
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      purpose: 'Nafath callback',
      runId: r.runId,
      resolved: { kind: 'nafath-callback', instance: instance.slug, transId: r.transId, status: r.status, attempt, ...(o.duplicate ? { duplicate: true } : {}) },
    });
    const error = res.ok ? null : (res.error ?? `Your app answered ${res.status}`);
    let retry: CallbackResult['retry'] = null;
    if (!res.ok && !res.blocked && !o.duplicate && attempt <= CALLBACK_RETRY_MS.length) {
      const inMs = CALLBACK_RETRY_MS[attempt - 1]!;
      const s = this.hub.schedules.create(
        project,
        { method: 'POST', path: `/nafath/requests/${r.id}/callback/deliver`, body: { attempt: attempt + 1 }, delayMs: inMs, label: `Nafath callback ${r.status} (${r.nationalId}) · retry ${attempt}` },
        this.runOf(r),
      );
      retry = { scheduleId: s.id, inMs };
    }
    this.record(r.id, { at: nowIso(), url, status: res.status, error, attempt, logId: res.logId, ...(o.duplicate ? { duplicate: true } : {}) });
    return { ok: res.ok, status: res.status, error, attempt, logId: res.logId, retry };
  }

  /** Appends an attempt to the request row (read and written in one tick: no lost update between deliveries). */
  private record(requestId: string, a: CallbackAttempt): void {
    const cur = this.svc.repo.getRequest(requestId);
    if (!cur) return;
    const next = this.svc.repo.updateRequest(requestId, { callback: [...cur.callback, a] });
    this.svc.changed(next.projectId, { request: next.id, status: next.status, user: next.testUserId, callback: { attempt: a.attempt, status: a.status, ok: !a.error } });
  }
}
