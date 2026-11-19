import type { FastifyRequest } from 'fastify';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Hub } from '../hub.js';
import { RetryLater, type Job } from '../jobs/scheduler.js';
import type { Ctx, Reply, SendError } from '../providers/adapters/types.js';
import { getEmailAdapter } from '../providers/email-adapters/index.js';
import { EVENT_STATUS, bounceDetails, formatAddress, type EmailAdapter, type EmailApiMeta, type EmailEvent, type EmailRequest, type ParsedEmail } from '../providers/email-adapters/types.js';
import type { Message } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import type { TestUser } from '../repos/users.js';
import type { Decision } from '../rules/engine.js';
import { sendOutbound } from '../traffic/outbound.js';
import { normalizeEmail } from '../util.js';
import { htmlToText } from './extract.js';
import type { MockExtension } from './simulator.js';

const JOB = 'email-event';

interface EventJob {
  messageId: string;
  /** Event to report to the app (null: only change the status). */
  event: EmailEvent | null;
  /** Change the message's status in devhub when this step happens. */
  setStatus?: string;
  statusDetail?: string | null;
  parentLogId?: string | null;
}

interface Rcpt {
  emailIndex: number;
  address: string;
  kind: 'to' | 'cc' | 'bcc';
  user: TestUser | null;
  decision: Decision;
}

interface Step {
  at: number;
  event: EmailEvent | null;
  setStatus?: string;
  statusDetail?: string | null;
}

interface Plan {
  status: string;
  detail: string | null;
  failure?: { code: string; message: string } | null;
  steps: Step[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays email API providers (SendGrid, Mailgun, Amazon SES, generic) on email provider instances:
 * /mock/<project>/<instance>/… → validate like the provider, apply scenario rules, turn the call into a real
 * MIME email in Mailpit (so it shows in the test user's inbox) and send the provider's event webhooks.
 */
export class EmailApiSimulator {
  constructor(private hub: Hub) {
    hub.scheduler.register(JOB, (job) => this.runEventJob(job as unknown as Job<EventJob>));
  }

  readonly handle: MockExtension = async (req, reply, { project, instance }) => {
    const hub = this.hub;
    if (!instance) return reply.status(404).send({ error: 'Not found' });
    const resolved: Record<string, unknown> = { project: project.slug, instance: instance.slug, preset: instance.preset, channel: 'email' };
    req.trafficResolved = resolved;
    const adapter = getEmailAdapter(instance.preset);
    if (!adapter) {
      req.trafficOutcome = 'unmatched';
      if (instance.preset === 'smtp') {
        const user = instance.isDefault ? project.slug : `${project.slug}.${instance.slug}`;
        return reply.status(404).send({
          error: 'Not found',
          message: `"${instance.slug}" is an SMTP provider instance: send email over SMTP (port ${hub.config.smtpPort}, username "${user}"), or add a SendGrid / Mailgun / SES / generic email API instance.`,
        });
      }
      return reply.status(501).send({ error: `The "${instance.preset}" email simulator is not available over HTTP` });
    }

    const ctx: Ctx = { project, instance, baseUrl: baseUrl(req) };
    const ereq: EmailRequest = {
      method: req.method,
      path: '/' + (req.params['*'] ?? ''),
      query: req.query as Record<string, string>,
      headers: req.headers,
      body: req.body,
      url: baseUrl(req) + req.url,
      rawBody: req.rawBody ?? null,
      bodyError: req.bodyError ?? null,
    };
    const send = (r: Reply) => {
      reply.status(r.status).headers(r.headers ?? {});
      return r.body === undefined || r.body === null ? reply.send() : reply.send(r.body);
    };

    if (!adapter.match(ereq, ctx)) {
      req.trafficOutcome = 'unmatched';
      return send(adapter.notFound(ereq));
    }
    const denied = adapter.authorize?.(ereq, ctx);
    if (denied) {
      req.trafficOutcome = 'rejected';
      resolved.error = 'API key does not match the one configured on this provider instance';
      return send(denied);
    }
    const parsed = await adapter.parse(ereq, ctx);
    if ('error' in parsed) {
      req.trafficOutcome = 'invalid';
      return send(parsed.error);
    }

    // One decision per recipient, like SMTP's RCPT TO.
    const header = req.headers['x-hub-scenario'];
    const rcpts: Rcpt[] = [];
    parsed.emails.forEach((e, emailIndex) => {
      const seen = new Set<string>();
      for (const [kind, list] of [['to', e.to], ['cc', e.cc], ['bcc', e.bcc]] as const) {
        for (const a of list) {
          const address = normalizeEmail(a.email) ?? a.email;
          if (seen.has(address)) continue;
          seen.add(address);
          const user = hub.messageService.matchUser(project.id, 'email', address);
          const decision: Decision = !instance.enabled
            ? { action: 'down', errorCode: null, errorMessage: 'Provider instance is disabled in devhub', delayMs: null, level: 'instance', rule: { id: null, position: null, action: 'down', label: 'Instance disabled' } }
            : hub.engine.evaluate({ projectId: project.id, channel: 'email', instance, user, header: Array.isArray(header) ? header[0] : header });
          rcpts.push({ emailIndex, address, kind, user, decision });
        }
      }
    });
    Object.assign(resolved, {
      to: rcpts.map((r) => r.address),
      users: rcpts.map((r) => r.user?.name ?? null),
      actions: rcpts.map((r) => r.decision.action),
      rules: rcpts.map((r) => r.decision.rule?.label ?? null),
    });

    const slowest = Math.max(0, ...rcpts.filter((r) => r.decision.action === 'slow').map((r) => r.decision.delayMs ?? 3000));
    if (slowest) {
      await sleep(slowest);
      for (const r of rcpts) if (r.decision.action === 'slow') r.decision = { ...r.decision, action: 'deliver' };
    }

    const logId = req.trafficLogId ?? null;
    const timedOut = rcpts.filter((r) => r.decision.action === 'timeout');
    if (timedOut.length) {
      for (const r of timedOut) this.store(ctx, parsed.emails[r.emailIndex], r, logId, 'timeout', 'Simulated timeout: devhub never answered');
      req.trafficOutcome = 'forced_error';
      reply.hijack();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, hub.config.timeoutHoldMs);
        req.raw.once('close', () => (clearTimeout(t), resolve()));
      });
      req.raw.socket?.destroy();
      if (logId) {
        hub.traffic.finish(logId, { outcome: 'forced_error', errorType: 'simulated_timeout', errorMessage: 'Rule: no response (timeout)', resStatus: null });
        hub.traffic.mergeResolved(logId, resolved);
      }
      return;
    }

    // Errors the provider's API answers at send time: the whole call fails.
    const refused = rcpts.map((r) => ({ r, kind: sendErrorKind(r.decision, adapter) })).filter((x): x is { r: Rcpt; kind: SendError } => x.kind !== null);
    if (refused.length) {
      const { r: first, kind } = refused[0];
      const res = adapter.sendError(ctx, kind, first.decision.errorCode, first.decision.errorMessage);
      for (const { r, kind: k } of refused) {
        const why = r.decision.errorMessage ?? ERROR_TEXT[k];
        this.store(ctx, parsed.emails[r.emailIndex], r, logId, 'rejected', `${ERROR_LABEL[k]}: HTTP ${res.status} · ${why}`);
      }
      req.trafficOutcome = 'forced_error';
      return send(res);
    }

    const id = adapter.newMessageId(ctx, parsed);
    if (parsed.testMode) {
      resolved.testMode = 'Test/sandbox mode: validated and accepted, not delivered';
      return send(adapter.accepted(ctx, { id, request: parsed }));
    }

    const created: Message[] = [];
    for (const [emailIndex, e] of parsed.emails.entries()) {
      const list = rcpts.filter((r) => r.emailIndex === emailIndex);
      const messageIdHeader = adapter.messageIdHeader(ctx, id, emailIndex, parsed);
      const mailpitId = await this.relay(project, instance, e, messageIdHeader, logId, list.map((r) => r.address));
      list.forEach((r, recipientIndex) => {
        const plan = planFor(r.decision, this.hub.config.callbackDelayMs);
        const meta: EmailApiMeta = {
          preset: instance.preset,
          sender: e.from?.email ?? null,
          recipients: e.to.map((a) => a.email),
          tags: e.tags,
          vars: e.vars,
          recipientIndex,
          emailIndex,
          extra: parsed.extra,
        };
        const m = hub.messageService.capture({
          project,
          instance,
          channel: 'email',
          from: e.from?.email ?? null,
          to: r.address,
          subject: e.subject,
          text: bodyText(e),
          html: e.html,
          attachments: e.attachments.length,
          mailpitId,
          messageIdHeader,
          status: plan.status,
          statusDetail: plan.detail,
          appliedRule: appliedRule(r.decision),
          logId,
          providerMessageId: id,
          duplicateWindowSeconds: project.settings.duplicateWindowSeconds,
          metadata: {
            preset: instance.preset,
            emailApi: meta,
            headerTo: e.to.map((a) => normalizeEmail(a.email)),
            cc: e.cc.map((a) => normalizeEmail(a.email)),
            bcc: r.kind === 'bcc',
            ...(plan.failure ? { errorCode: plan.failure.code, errorMessage: plan.failure.message } : {}),
          },
        });
        created.push(m);
        for (const s of plan.steps) {
          hub.scheduler.schedule(
            JOB,
            { messageId: m.id, event: s.event, setStatus: s.setStatus, statusDetail: s.statusDetail, parentLogId: logId } satisfies EventJob as unknown as Record<string, unknown>,
            { projectId: project.id, delayMs: s.at },
          );
        }
      });
    }
    resolved.messageIds = created.map((m) => m.id);
    resolved.testUserIds = created.map((m) => m.testUserId);
    resolved.providerMessageId = id;
    return send(adapter.accepted(ctx, { id, request: parsed }));
  };

  /** Build the MIME message (or take the raw one) and store it in Mailpit, tagged like SMTP mail. */
  private async relay(project: Project, instance: ProviderInstance, e: ParsedEmail, messageIdHeader: string, logId: string | null, rcpts: string[]): Promise<string | null> {
    const mailpit = this.hub.mailpit;
    if (!mailpit) return null;
    const tags = [`project-${project.slug}`, `instance-${instance.slug}`, ...e.tags.map((t) => t.replace(/[^\w .-]/g, '-')).slice(0, 5)];
    const extra = { 'X-Tags': tags.join(', '), 'X-Devhub-Log-Id': logId ?? '', 'X-Devhub-Provider': instance.preset };
    let raw: Buffer;
    if (e.raw) {
      const head = e.raw.subarray(0, Math.max(0, e.raw.indexOf('\r\n\r\n') >= 0 ? e.raw.indexOf('\r\n\r\n') : e.raw.indexOf('\n\n'))).toString('utf8');
      const lines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`);
      if (!/^message-id:/im.test(head)) lines.push(`Message-ID: ${messageIdHeader}`);
      raw = Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n'), e.raw]);
    } else {
      const composer = new MailComposer({
        from: e.from ? formatAddress(e.from) : 'no-reply@devhub.local',
        to: e.to.map(formatAddress),
        cc: e.cc.length ? e.cc.map(formatAddress) : undefined,
        replyTo: e.replyTo.length ? e.replyTo.map(formatAddress) : undefined,
        subject: e.subject,
        text: e.text ?? undefined,
        html: e.html ?? undefined,
        messageId: messageIdHeader,
        attachments: e.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          cid: a.cid,
          contentDisposition: a.inline ? 'inline' : 'attachment',
        })),
        headers: { ...e.headers, ...extra },
      });
      raw = await composer.compile().build();
    }
    return mailpit.relay(raw, { from: e.from?.email ?? '', to: rcpts });
  }

  /** A recipient the call never got through for (rejected at send time / timed out). */
  private store(ctx: Ctx, e: ParsedEmail, r: Rcpt, logId: string | null, status: string, detail: string): Message {
    return this.hub.messageService.capture({
      project: ctx.project,
      instance: ctx.instance,
      channel: 'email',
      from: e.from?.email ?? null,
      to: r.address,
      subject: e.subject,
      text: bodyText(e),
      html: e.html,
      attachments: e.attachments.length,
      status,
      statusDetail: detail,
      appliedRule: appliedRule(r.decision),
      logId,
      duplicateWindowSeconds: ctx.project.settings.duplicateWindowSeconds,
      metadata: { preset: ctx.instance.preset, bcc: r.kind === 'bcc' },
    });
  }

  private async runEventJob(job: Job<EventJob>): Promise<void> {
    const hub = this.hub;
    const p = job.payload;
    let m = hub.messages.get(p.messageId);
    if (!m) return; // deleted (inbox cleared)
    if (p.setStatus && job.attempts === 1) {
      m = hub.messages.updateStatus(m.id, { status: p.setStatus, ...(p.statusDetail !== undefined ? { statusDetail: p.statusDetail } : {}) })!;
      hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: m });
    }
    if (!p.event) return;
    const project = hub.projects.get(m.projectId);
    const instance = m.providerInstanceId ? hub.providers.getById(m.providerInstanceId) : null;
    const adapter = instance ? getEmailAdapter(instance.preset) : null;
    if (!project || !instance || !adapter) return;
    const url = typeof instance.config.eventWebhookUrl === 'string' && instance.config.eventWebhookUrl ? instance.config.eventWebhookUrl : null;
    if (!url) return;
    const call = adapter.event({ project, instance, baseUrl: '' }, m, p.event, url);
    if (!call) return; // this provider does not report this event
    const res = await sendOutbound(hub.traffic, {
      projectId: project.id,
      parentLogId: p.parentLogId ?? null,
      method: call.method ?? 'POST',
      url: call.url,
      headers: call.headers,
      body: call.body,
      purpose: `email event: ${call.name}`,
      resolved: { messageId: m.id, instance: instance.slug, event: call.name, to: m.to },
    });
    const cur = hub.messages.get(m.id) ?? m;
    const reports = Array.isArray(cur.metadata.reports) ? (cur.metadata.reports as unknown[]) : [];
    const updated = hub.messages.updateStatus(m.id, {
      metadata: { reports: [...reports, { status: EVENT_STATUS[p.event.type], event: call.name, at: new Date().toISOString(), httpStatus: res.status, error: res.error, logId: res.logId }] },
    });
    if (updated) hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: updated });
    if (!res.ok && !res.blocked && (res.status === null || res.status >= 500)) throw new RetryLater(res.error ?? `HTTP ${res.status}`, 2000 * job.attempts);
  }
}

/** Install the email API simulator into /mock/<project>/<instance>/… (email instances). */
export function installEmailApi(hub: Hub): EmailApiSimulator {
  const sim = new EmailApiSimulator(hub);
  hub.simulator.extensions.emailApi = sim.handle;
  return sim;
}

const ERROR_LABEL: Record<SendError, string> = { reject: 'Rejected', blocked: 'Blocked', rate_limit: 'Rate limited', down: 'Provider down', opt_out: 'Opted out (DND)' };
const ERROR_TEXT: Record<SendError, string> = {
  reject: 'rejected by the provider',
  blocked: 'recipient blocked',
  rate_limit: 'too many requests',
  down: 'service unavailable',
  opt_out: 'recipient opted out of marketing email',
};

function sendErrorKind(d: Decision, adapter: EmailAdapter): SendError | null {
  if (d.level === 'opt_out') return adapter.optOutAt === 'send' ? 'opt_out' : null;
  switch (d.action) {
    case 'reject':
      return 'reject';
    case 'rate_limit':
      return 'rate_limit';
    case 'down':
      return 'down';
    case 'blocked':
      return adapter.optOutAt === 'send' ? 'blocked' : null;
    default:
      return null;
  }
}

/**
 * What happens to an accepted email per rule: its status now and the provider events (with status changes) later.
 * Email APIs accept at send time and report bounces / complaints through events.
 */
export function planFor(d: Decision, delay: number): Plan {
  const t1 = Math.max(1, Math.round(delay / 3));
  const processed: Step = { at: t1, event: { type: 'processed' } };
  const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const bounce = (bounceType: 'hard' | 'soft' | 'blocked') => {
    const defaults =
      bounceType === 'soft'
        ? { smtpCode: 452, status: '4.2.2', reason: 'Mailbox full' }
        : bounceType === 'blocked'
          ? { smtpCode: 550, status: '5.7.1', reason: 'Message rejected: recipient blocked' }
          : { smtpCode: 550, status: '5.1.1', reason: 'The email account that you tried to reach does not exist' };
    const b = bounceDetails(d.errorCode, d.errorMessage, defaults);
    return { event: { type: 'bounce', bounceType, ...b } as EmailEvent, text: `${b.smtpCode} ${b.status} ${b.reason}` };
  };

  if (d.level === 'opt_out') {
    return {
      status: 'dropped',
      detail: `${d.errorMessage ?? 'Recipient opted out of marketing email (DND)'}: the provider dropped it`,
      steps: [{ at: t1, event: { type: 'dropped', dropReason: 'unsubscribe' } }],
    };
  }
  switch (d.action) {
    case 'fail': {
      const b = bounce('hard');
      return { status: 'failed', detail: `Delivery failed: ${b.text}`, failure: { code: String(b.event.smtpCode), message: b.event.reason ?? '' }, steps: [processed, { at: delay, event: b.event }] };
    }
    case 'bounce_hard': {
      const b = bounce('hard');
      return { status: 'bounced', detail: `Accepted, then bounced: ${b.text}`, steps: [processed, { at: delay, event: b.event }] };
    }
    case 'blocked': {
      const b = bounce('blocked');
      return { status: 'bounced', detail: `Accepted, then blocked: ${b.text}`, steps: [processed, { at: delay, event: b.event }] };
    }
    case 'bounce_soft': {
      const b = bounce('soft');
      return {
        status: 'bounced',
        detail: `Accepted, deferred, then given up: ${b.text}`,
        steps: [processed, { at: delay, event: { type: 'deferred', smtpCode: b.event.smtpCode, status: b.event.status, reason: b.event.reason, attempt: 1 } }, { at: delay * 2, event: b.event }],
      };
    }
    case 'defer': {
      const later = Math.max(d.delayMs ?? delay * 2, delay * 2);
      const b = bounceDetails(d.errorCode, d.errorMessage, { smtpCode: 421, status: '4.7.1', reason: 'Try again later (greylisted)' });
      return {
        status: 'scheduled',
        detail: `Deferred by the receiving server; delivered on retry in ${secs(later)}`,
        steps: [processed, { at: delay, event: { type: 'deferred', ...b, attempt: 1 } }, { at: later, event: { type: 'delivered' }, setStatus: 'delivered', statusDetail: null }],
      };
    }
    case 'delay': {
      const later = Math.max(d.delayMs ?? 0, delay);
      return { status: 'scheduled', detail: `Arrives in ${secs(later)}`, steps: [processed, { at: later, event: { type: 'delivered' }, setStatus: 'delivered', statusDetail: null }] };
    }
    case 'bounce_delayed': {
      const later = Math.max(d.delayMs ?? 10_000, delay * 2);
      const b = bounce('hard');
      return {
        status: 'delivered',
        detail: `Will bounce in ${secs(later)}`,
        steps: [processed, { at: delay, event: { type: 'delivered' } }, { at: later, event: b.event, setStatus: 'bounced', statusDetail: `Bounced later: ${b.text}` }],
      };
    }
    case 'complaint':
      return {
        status: 'delivered',
        detail: 'Delivered; the recipient will mark it as spam',
        steps: [processed, { at: delay, event: { type: 'delivered' } }, { at: delay * 2, event: { type: 'complaint' }, setStatus: 'complained', statusDetail: 'The recipient marked it as spam' }],
      };
    case 'drop':
      return {
        status: 'dropped',
        detail: 'Accepted, then dropped by the provider (suppressed address)',
        steps: [{ at: t1, event: { type: 'dropped', dropReason: 'bounce', reason: d.errorMessage ?? undefined } }],
      };
    default:
      return { status: 'delivered', detail: null, steps: [processed, { at: delay, event: { type: 'delivered' } }] };
  }
}

function appliedRule(d: Decision) {
  return d.rule ? { ...d.rule, level: d.level } : { level: 'default', label: 'Default: deliver' };
}

function bodyText(e: ParsedEmail): string {
  return e.text?.trim() || (e.html ? htmlToText(e.html) : '');
}

function baseUrl(req: FastifyRequest): string {
  const proto = (req.raw.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

