import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import { RetryLater, type Job } from '../jobs/scheduler.js';
import { holdTimeout } from '../messages/simulator.js';
import { str, type Ctx, type MockRequest, type Reply, type SendError } from '../providers/adapters/types.js';
import type { Verification } from '../repos/verify.js';
import { sendOutbound } from '../traffic/outbound.js';
import { normalizeEmail, normalizePhone } from '../util.js';
import { deliverCode, generateCode, type VerifyChannel } from './deliver.js';

/**
 * Vonage Verify v2 on a `vonage` instance (real host: api.nexmo.com): POST /v2/verify, POST /v2/verify/:id (check),
 * DELETE /v2/verify/:id (cancel), POST /v2/verify/:id/next_workflow; summary callbacks to the instance's callback URL.
 */
const NEW = /^\/v2\/verify\/?$/;
const ONE = /^\/v2\/verify\/([0-9a-f-]{36})\/?$/i;
const NEXT = /^\/v2\/verify\/([0-9a-f-]{36})\/next_workflow\/?$/i;

export const VONAGE_MAX_CHECK_ATTEMPTS = 3;
const CHANNELS = ['sms', 'whatsapp', 'email', 'voice'] as const;
const JOB_CALLBACK = 'vonage-verify-callback';
const JOB_EXPIRE = 'vonage-verify-expire';

const problem = (status: number, slug: string, title: string, detail: string, extra: Record<string, unknown> = {}): Reply => ({
  status,
  headers: { 'content-type': 'application/problem+json' },
  body: { type: `https://developer.vonage.com/api-errors${slug}`, title, detail, instance: randomUUID(), ...extra },
});
const invalidParams = (params: { name: string; reason: string }[]): Reply =>
  problem(422, '#invalid-param', 'Invalid request params', 'The value of one or more parameters is invalid', { invalid_parameters: params });
const notFound = (id: string) => problem(404, '#not-found', 'Not Found', `Request '${id}' was not found or it has been verified already.`);

export function isVonageVerifyPath(path: string): boolean {
  return /^\/v2\/verify(\/|$)/.test(path);
}

interface Workflow {
  channel: VerifyChannel;
  to: string;
  from?: string | null;
}

interface CallbackJob {
  verificationId: string;
  status: 'completed' | 'failed' | 'expired';
}

export class VonageVerify {
  constructor(private hub: Hub) {
    hub.scheduler.register(JOB_CALLBACK, (job) => this.runCallback(job as unknown as Job<CallbackJob>));
    hub.scheduler.register(JOB_EXPIRE, (job) => this.runExpire(job as unknown as Job<{ verificationId: string }>));
  }

  async handle(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, mreq: MockRequest, resolved: Record<string, unknown>): Promise<unknown> {
    const send = (r: Reply) => reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    resolved.api = 'vonage-verify2';
    // Verify v2 uses a JWT (application) or Basic auth; any credentials are accepted, none is a 401 like Vonage.
    if (!mreq.headers.authorization) {
      req.trafficOutcome = 'rejected';
      return send(problem(401, '#unauthorized', 'Unauthorized', 'You did not provide correct credentials.'));
    }
    let x: RegExpExecArray | null;
    if (NEW.test(mreq.path) && mreq.method === 'POST') return this.create(req, reply, ctx, mreq, resolved);
    if ((x = NEXT.exec(mreq.path)) && mreq.method === 'POST') {
      const v = this.active(ctx, x[1]);
      if (!v) return (req.trafficOutcome = 'unmatched'), send(notFound(x[1]));
      const workflows = (v.params.workflow ?? []) as Workflow[];
      const idx = Number(v.params.workflowIndex ?? 0) + 1;
      if (idx >= workflows.length) return (req.trafficOutcome = 'rejected'), send(problem(409, '/verify#conflict', 'Conflict', 'There are no more workflows to trigger.'));
      const r = await this.deliver(req, ctx, v, idx, resolved);
      if (r.kind === 'timeout') return holdTimeout(this.hub, req, reply, resolved);
      if (r.kind === 'send_error') return (req.trafficOutcome = 'forced_error'), send(r.reply);
      return send({ status: 200, body: { status: 'ok' } });
    }
    if ((x = ONE.exec(mreq.path))) {
      const id = x[1].toLowerCase();
      resolved.requestId = id;
      if (mreq.method === 'DELETE') {
        const v = this.active(ctx, id);
        if (!v) return (req.trafficOutcome = 'unmatched'), send(notFound(id));
        this.publish(this.hub.verify.update(v.id, { status: 'cancelled' })!);
        return reply.status(204).send();
      }
      if (mreq.method === 'POST') return this.check(req, reply, ctx, id, mreq, resolved);
    }
    req.trafficOutcome = 'unmatched';
    return send(problem(404, '#not-found', 'Not Found', `${mreq.method} ${mreq.path} is not a Vonage Verify v2 endpoint`));
  }

  private expiry(ctx: Ctx, channelTimeout: number, workflows: number): number {
    const n = Number(ctx.instance.config.verifyExpirySeconds);
    return Number.isFinite(n) && n > 0 ? n : channelTimeout * Math.max(1, workflows);
  }

  /** Pending request of this instance; marks it expired when its time is up. */
  private active(ctx: Ctx, id: string): Verification | null {
    const v = this.hub.verify.get(id.toLowerCase());
    if (!v || v.providerInstanceId !== ctx.instance.id || v.kind !== 'vonage') return null;
    if (v.status === 'pending' && Date.parse(v.expiresAt) <= Date.now()) {
      this.expire(v);
      return null;
    }
    return v.status === 'pending' ? v : null;
  }

  private async create(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, mreq: MockRequest, resolved: Record<string, unknown>) {
    const hub = this.hub;
    const send = (r: Reply) => reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    const b = (mreq.body && typeof mreq.body === 'object' && !Buffer.isBuffer(mreq.body) ? mreq.body : null) as Record<string, unknown> | null;
    if (!b) return (req.trafficOutcome = 'invalid'), send(problem(400, '#bad-request', 'Bad Request', 'The request body must be JSON.'));
    const errs: { name: string; reason: string }[] = [];
    const brand = str(b.brand);
    if (!brand) errs.push({ name: 'brand', reason: 'must not be blank' });
    else if (brand.length > 16) errs.push({ name: 'brand', reason: 'size must be between 1 and 16' });
    const codeLength = b.code_length === undefined ? 4 : Number(b.code_length);
    if (!Number.isInteger(codeLength) || codeLength < 4 || codeLength > 10) errs.push({ name: 'code_length', reason: 'must be between 4 and 10' });
    const channelTimeout = b.channel_timeout === undefined ? 300 : Number(b.channel_timeout);
    if (!Number.isInteger(channelTimeout) || channelTimeout < 15 || channelTimeout > 900) errs.push({ name: 'channel_timeout', reason: 'must be between 15 and 900' });
    const code = b.code === undefined ? null : str(b.code);
    if (b.code !== undefined && (!code || !/^[0-9A-Za-z]{4,10}$/.test(code))) errs.push({ name: 'code', reason: 'must be 4-10 alphanumeric characters' });
    const workflows: Workflow[] = [];
    if (!Array.isArray(b.workflow) || b.workflow.length === 0) errs.push({ name: 'workflow', reason: 'must not be empty' });
    else if (b.workflow.length > 3) errs.push({ name: 'workflow', reason: 'size must be between 1 and 3' });
    else
      (b.workflow as unknown[]).forEach((w, i) => {
        const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
        const ch = str(o.channel);
        if (!ch || !(CHANNELS as readonly string[]).includes(ch)) return errs.push({ name: `workflow[${i}].channel`, reason: `must be one of ${CHANNELS.join(', ')} (silent_auth / rcs / whatsapp_interactive are not simulated)` });
        const raw = str(o.to);
        const to = ch === 'email' ? normalizeEmail(raw) : raw && /^\+?\d{7,15}$/.test(raw) ? normalizePhone(raw) : null;
        if (!to || (ch === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))) return errs.push({ name: `workflow[${i}].to`, reason: ch === 'email' ? 'Invalid email address' : 'Invalid phone number (E.164 without +, e.g. 447700900000)' });
        workflows.push({ channel: ch as VerifyChannel, to, from: str(o.from) });
      });
    if (errs.length) {
      req.trafficOutcome = 'invalid';
      return send(invalidParams(errs));
    }
    // One active request per recipient, like Vonage.
    const first = workflows[0];
    const busy = hub.verify.findPending(ctx.instance.id, first.to, null);
    if (busy && this.active(ctx, busy.id)) {
      req.trafficOutcome = 'rejected';
      return send(problem(409, '/verify#conflict', 'Conflict', 'Concurrent verifications to the same number are not allowed.', { request_id: busy.id }));
    }
    const id = randomUUID();
    const v = hub.verify.insert({
      id,
      projectId: ctx.project.id,
      providerInstanceId: ctx.instance.id,
      kind: 'vonage',
      serviceId: null,
      to: first.to,
      channel: first.channel,
      code: code ?? generateCode(codeLength),
      status: 'pending',
      sendAttempts: [],
      checkAttempts: 0,
      messageIds: [],
      params: { brand, workflow: workflows, workflowIndex: 0, channelTimeout, clientRef: str(b.client_ref), locale: str(b.locale) ?? 'en-us' },
      runId: null,
      logId: req.trafficLogId ?? null,
      expiresAt: new Date(Date.now() + this.expiry(ctx, channelTimeout, workflows.length) * 1000).toISOString(),
    });
    resolved.requestId = id;
    const r = await this.deliver(req, ctx, v, 0, resolved);
    if (r.kind === 'timeout') {
      hub.verify.update(id, { status: 'failed' });
      return holdTimeout(hub, req, reply, resolved);
    }
    if (r.kind === 'send_error') {
      hub.verify.update(id, { status: 'failed' });
      req.trafficOutcome = 'forced_error';
      return send(r.reply);
    }
    hub.scheduler.schedule(JOB_EXPIRE, { verificationId: id }, { projectId: ctx.project.id, delayMs: Date.parse(v.expiresAt) - Date.now() });
    return send({ status: 202, body: { request_id: id } });
  }

  private async deliver(req: FastifyRequest, ctx: Ctx, v: Verification, idx: number, resolved: Record<string, unknown>) {
    const hub = this.hub;
    const workflows = v.params.workflow as Workflow[];
    const w = workflows[idx];
    const brand = String(v.params.brand);
    const text =
      w.channel === 'voice'
        ? `[Voice call] Your ${brand} verification code is ${v.code.split('').join(' ')}. (${v.code})`
        : w.channel === 'email'
          ? `Your ${brand} verification code is ${v.code}.\n\nIf you did not request this, ignore this email.`
          : `Your ${brand} verification code is: ${v.code}`;
    const result = await deliverCode(hub, {
      ctx,
      req,
      channel: w.channel,
      to: w.to,
      from: w.from ?? (w.channel === 'email' ? `no-reply@${ctx.project.slug}.verify.test` : brand),
      subject: w.channel === 'email' ? `Your ${brand} verification code` : null,
      text,
      code: v.code,
      providerMessageId: v.id,
      metadata: { verify: { api: 'vonage-verify2', requestId: v.id, channel: w.channel, workflow: idx } },
    });
    Object.assign(resolved, { channel: w.channel, to: w.to, action: result.decision.action, rule: result.decision.rule?.label ?? null, messageIds: [result.message.id], testUserIds: [result.message.testUserId] });
    if (result.kind === 'send_error') return { kind: 'send_error' as const, reply: sendError(result.error, result.decision.errorCode, result.decision.errorMessage) };
    if (result.kind === 'timeout') return { kind: 'timeout' as const };
    const attempts = [...v.sendAttempts, { attempt_sid: randomUUID(), channel: w.channel, time: new Date().toISOString(), messageId: result.message.id }];
    const u = hub.verify.update(v.id, {
      channel: w.channel,
      sendAttempts: attempts,
      messageIds: [...v.messageIds, result.message.id],
      params: { ...v.params, workflowIndex: idx },
    })!;
    if (result.runId && !v.runId) hub.db.prepare('UPDATE verifications SET run_id = ? WHERE id = ?').run(result.runId, v.id);
    this.publish(u);
    return { kind: 'accepted' as const };
  }

  private check(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, id: string, mreq: MockRequest, resolved: Record<string, unknown>) {
    const hub = this.hub;
    const send = (r: Reply) => reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    const raw = hub.verify.get(id);
    const mine = raw && raw.providerInstanceId === ctx.instance.id && raw.kind === 'vonage' ? raw : null;
    const v = this.active(ctx, id);
    if (!v) {
      req.trafficOutcome = 'rejected';
      // Gone: expired, or ended by too many wrong codes. Not found: unknown, completed or cancelled.
      if (mine?.status === 'expired' || (mine?.status === 'pending' && Date.parse(mine.expiresAt) <= Date.now()))
        return send(problem(410, '/verify#expired', 'Gone', 'The verification request has expired.'));
      if (mine?.status === 'failed' && mine.checkAttempts >= VONAGE_MAX_CHECK_ATTEMPTS)
        return send(problem(410, '/verify#expired', 'Gone', 'An incorrect code has been provided too many times. Workflow terminated.'));
      return send(notFound(id));
    }
    const b = (mreq.body && typeof mreq.body === 'object' ? mreq.body : {}) as Record<string, unknown>;
    const code = str(b.code);
    if (!code || !/^[0-9A-Za-z]{4,10}$/.test(code)) return (req.trafficOutcome = 'invalid'), send(invalidParams([{ name: 'code', reason: 'must be 4-10 alphanumeric characters' }]));
    if (code === v.code) {
      const u = hub.verify.update(v.id, { status: 'completed', checkAttempts: v.checkAttempts + 1 })!;
      resolved.result = 'completed';
      this.publish(u);
      this.callback(u, 'completed');
      return send({ status: 200, body: { request_id: v.id, status: 'completed' } });
    }
    const attempts = v.checkAttempts + 1;
    resolved.result = 'wrong code';
    req.trafficOutcome = 'rejected';
    if (attempts >= VONAGE_MAX_CHECK_ATTEMPTS) {
      const u = hub.verify.update(v.id, { status: 'failed', checkAttempts: attempts })!;
      this.publish(u);
      this.callback(u, 'failed');
      return send(problem(410, '/verify#expired', 'Gone', 'An incorrect code has been provided too many times. Workflow terminated.'));
    }
    this.publish(hub.verify.update(v.id, { checkAttempts: attempts })!);
    return send(problem(400, '/verify#invalid-code', 'Invalid Code', 'The code you provided does not match the expected value.'));
  }

  private expire(v: Verification) {
    const u = this.hub.verify.update(v.id, { status: 'expired' })!;
    this.publish(u);
    this.callback(u, 'expired');
  }

  private async runExpire(job: Job<{ verificationId: string }>) {
    const v = this.hub.verify.get(job.payload.verificationId);
    if (v && v.status === 'pending') this.expire(v);
  }

  private callback(v: Verification, status: CallbackJob['status']) {
    this.hub.scheduler.schedule(JOB_CALLBACK, { verificationId: v.id, status } satisfies CallbackJob as unknown as Record<string, unknown>, { projectId: v.projectId });
  }

  private async runCallback(job: Job<CallbackJob>): Promise<void> {
    const hub = this.hub;
    const v = hub.verify.get(job.payload.verificationId);
    if (!v) return;
    const instance = hub.providers.getById(v.providerInstanceId);
    if (!instance) return;
    const url = str(instance.config.verifyCallbackUrl) ?? str(instance.config.statusCallbackUrl);
    if (!url) return;
    const workflows = (v.params.workflow ?? []) as Workflow[];
    const idx = Number(v.params.workflowIndex ?? 0);
    const final = job.payload.status;
    const body = {
      request_id: v.id,
      submitted_at: v.createdAt,
      status: final,
      type: 'summary',
      channel_timeout: Number(v.params.channelTimeout ?? 300),
      workflow: workflows.map((w, i) => ({
        channel: w.channel,
        initiated_at: v.sendAttempts.find((a) => a.channel === w.channel)?.time ?? v.createdAt,
        status: i < idx ? 'expired' : i === idx ? final : 'unused',
      })),
      price: '0.10000000',
      ...(v.params.clientRef ? { client_ref: v.params.clientRef } : {}),
    };
    const res = await sendOutbound(hub.traffic, {
      projectId: v.projectId,
      runId: v.runId,
      parentLogId: v.logId,
      url,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      purpose: `verify callback: ${final}`,
      resolved: { requestId: v.id, instance: instance.slug, status: final },
    });
    if (!res.ok && !res.blocked && (res.status === null || res.status >= 500)) throw new RetryLater(res.error ?? `HTTP ${res.status}`, 2000 * job.attempts);
  }

  private publish(v: Verification) {
    this.hub.bus.publish({ type: 'verification.updated', projectId: v.projectId, data: { id: v.id, status: v.status, to: v.to, kind: v.kind } });
  }
}

function sendError(kind: SendError, code: string | null, message: string | null): Reply {
  const status = code && /^[45]\d\d$/.test(code) ? Number(code) : null;
  switch (kind) {
    case 'down':
      return problem(status ?? 503, '#service-unavailable', 'Service Unavailable', message ?? 'The service is temporarily unavailable.');
    case 'rate_limit':
      return problem(status ?? 429, '#rate-limit', 'Rate Limit Hit', message ?? 'Please wait, then retry your request');
    case 'blocked':
    case 'opt_out':
      return problem(status ?? 403, '/verify#fraud-check', 'Forbidden', message ?? 'Your request has been blocked by the fraud check.');
    default:
      return invalidParams([{ name: 'workflow[0].to', reason: message ?? 'Invalid phone number' }]);
  }
}
