import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import { RetryLater, type Job } from '../jobs/scheduler.js';
import { getAdapter } from '../providers/adapters/index.js';
import type { Ctx, DeliveryStatus, MockRequest, ParsedSend, ProviderAdapter, SendError } from '../providers/adapters/types.js';
import type { Channel } from '../providers/catalog.js';
import type { Message } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import type { TestUser } from '../repos/users.js';
import type { Decision } from '../rules/engine.js';
import { sendOutbound } from '../traffic/outbound.js';
import { tagLog } from '../runs/resolver.js';
import { HttpError } from '../util.js';
import { flag } from '../verify/deliver.js';
import { TwilioVerify, isTwilioVerifyPath } from '../verify/twilio-verify.js';
import { VonageVerify, isVonageVerifyPath } from '../verify/vonage-verify.js';
import { EmailInbound } from './email-inbound.js';
import { MEDIA_TYPES, MEDIA_LIMITS, mediaTypeOf, type WaButton, type WaContent } from '../providers/adapters/wa-content.js';
import type { MatchResult, InboundInput } from '../providers/adapters/types.js';
import { randomInt } from 'node:crypto';

interface StatusJob {
  messageId: string;
  /** Delivery status reported to the app. */
  status: DeliveryStatus;
  /** Also change the message's status in stubyard (delayed delivery). */
  setStatus?: string;
  error?: { code: string; message: string } | null;
  callbackUrl?: string | null;
  parentLogId?: string | null;
  /** "read" receipt: record when the user read it. */
  markRead?: boolean;
}

const MOCK_HINT = 'Mock URLs look like /mock/<project>/<provider-instance>/... - check the project and provider slugs in the dashboard (Providers tab).';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type MockExtension = (
  req: FastifyRequest<{ Params: { project: string; instance: string; '*': string } }>,
  reply: FastifyReply,
  ctx: { project: Project; instance: ProviderInstance | null },
) => Promise<unknown>;

/**
 * Plays SMS / WhatsApp providers: handles /mock/<project>/<instance>/… calls, applies scenario rules,
 * stores messages and sends delivery reports and inbound replies to the app.
 */
export class MessagingSimulator {
  /**
   * Other features plug into /mock/<project>/<instance>/…:
   *  - apiMocks: rule-based API mocks under the reserved instance slug "api" (/mock/<project>/api/…)
   *  - emailApi: email API presets (SendGrid, Mailgun, SES, generic-email) on email provider instances
   */
  readonly extensions: { apiMocks?: MockExtension; emailApi?: MockExtension } = {};

  readonly twilioVerify: TwilioVerify;
  readonly vonageVerify: VonageVerify;
  readonly emailInbound: EmailInbound;

  constructor(private hub: Hub) {
    hub.scheduler.register('status', (job) => this.runStatusJob(job as unknown as Job<StatusJob>));
    this.twilioVerify = new TwilioVerify(hub);
    this.vonageVerify = new VonageVerify(hub);
    this.emailInbound = new EmailInbound(hub);
  }

  async handleMock(req: FastifyRequest<{ Params: { project: string; instance: string; '*': string } }>, reply: FastifyReply) {
    const hub = this.hub;
    const project = hub.projects.getBySlug(req.params.project.toLowerCase());
    if (!project) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { unknownProject: req.params.project };
      return reply.status(404).send({
        error: 'Not found',
        message: `stubyard has no route for ${req.method} ${req.url.split('?')[0]}: unknown project "${req.params.project}"`,
        hint: MOCK_HINT,
      });
    }
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });
    if (req.params.instance.toLowerCase() === 'api' && this.extensions.apiMocks) return this.extensions.apiMocks(req, reply, { project, instance: null });
    const instance = hub.providers.get(project.id, req.params.instance.toLowerCase());
    if (!instance) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { project: project.slug, unknownInstance: req.params.instance };
      return reply.status(404).send({
        error: 'Not found',
        message: `stubyard has no route for ${req.method} ${req.url.split('?')[0]}: project "${project.slug}" has no provider instance "${req.params.instance}"`,
        hint: MOCK_HINT,
        instances: hub.providers.list(project.id).map((p) => p.slug),
      });
    }
    if (instance.channel === 'email' && this.extensions.emailApi) return this.extensions.emailApi(req, reply, { project, instance });
    const adapter = getAdapter(instance.preset);
    if (!adapter) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { project: project.slug, instance: instance.slug };
      return reply.status(501).send({ error: `The "${instance.preset}" simulator is not available over HTTP yet` });
    }

    const ctx: Ctx = { project, instance, baseUrl: baseUrl(req), media: (id) => hub.media.info(instance.id, id) };
    const mreq: MockRequest = {
      method: req.method,
      path: '/' + (req.params['*'] ?? ''),
      query: req.query as Record<string, string>,
      headers: req.headers,
      body: req.body,
      url: baseUrl(req) + req.url,
    };
    const resolved: Record<string, unknown> = { project: project.slug, instance: instance.slug, preset: instance.preset };
    req.trafficResolved = resolved;

    // Verify APIs live next to the messaging API on the same instance (real hosts: verify.twilio.com, api.nexmo.com).
    if ((instance.preset === 'twilio' || instance.preset === 'twilio-whatsapp') && isTwilioVerifyPath(mreq.path)) return this.twilioVerify.handle(req, reply, ctx, mreq, resolved);
    if (instance.preset === 'vonage' && isVonageVerifyPath(mreq.path)) return this.vonageVerify.handle(req, reply, ctx, mreq, resolved);

    const match = adapter.match(mreq, ctx);
    if (match && match.kind !== 'send' && match.kind !== 'fetch') return this.handleMedia(req, reply, ctx, adapter, match, resolved);
    if (!match) {
      req.trafficOutcome = 'unmatched';
      const r = adapter.notFound(mreq);
      return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    }
    if (match.kind === 'fetch') {
      const r = adapter.fetch!(ctx, hub.messages.findByProviderId(project.id, match.id), match.id);
      return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    }

    const parsed = adapter.parse(mreq, ctx);
    if ('error' in parsed) {
      req.trafficOutcome = 'invalid';
      return reply.status(parsed.error.status).headers(parsed.error.headers ?? {}).send(parsed.error.body);
    }
    const attributed = hub.runs.resolver.forRecipient(project.id, parsed.channel, parsed.to, hub.runs.resolver.explicitOf(req));
    const user = attributed.user;
    const runId = attributed.run?.id ?? null;
    tagLog(hub, req.trafficLogId, attributed);
    const header = req.headers['x-hub-scenario'];
    let decision: Decision = !instance.enabled
      ? { action: 'down', errorCode: null, errorMessage: 'Provider instance is disabled in stubyard', delayMs: null, level: 'instance', rule: { id: null, position: null, action: 'down', label: 'Instance disabled' } }
      : hub.engine.evaluate({ projectId: project.id, channel: parsed.channel, instance, user, header: Array.isArray(header) ? header[0] : header, runId });
    Object.assign(resolved, { channel: parsed.channel, to: parsed.to, user: user?.name ?? null, action: decision.action, rule: decision.rule?.label ?? null, level: decision.level });

    if (decision.action === 'slow') {
      await sleep(decision.delayMs ?? 3000);
      decision = { ...decision, action: 'deliver' };
    }
    // WhatsApp 24-hour customer service window (opt-in): free-form messages need a recent inbound message.
    if (parsed.channel === 'whatsapp' && adapter.windowError && flag(instance.config.enforce24hWindow) && !adapter.isTemplate?.(parsed) && ['deliver', 'delay'].includes(decision.action)) {
      const last = user ? hub.messages.lastInboundAt(project.id, user.id, 'whatsapp') : null;
      if (!last || Date.now() - Date.parse(last) > 24 * 3600 * 1000) {
        decision = {
          action: 'fail',
          errorCode: adapter.windowError.code,
          errorMessage: adapter.windowError.message,
          delayMs: null,
          level: 'default',
          rule: { id: null, position: null, action: 'fail', label: '24-hour window closed (no reply from the user in the last 24 h; send a template)' },
        };
        resolved.window = 'closed';
      }
    }

    const base = { ctx, adapter, parsed, user, decision, logId: req.trafficLogId ?? null, runId };

    if (decision.action === 'timeout') {
      this.store({ ...base, id: null, status: 'timeout', detail: 'Simulated timeout: stubyard never answered' });
      return holdTimeout(hub, req, reply, resolved);
    }

    const sendErr = sendErrorKind(decision, adapter);
    if (sendErr) {
      const r = adapter.sendError(ctx, sendErr, parsed, decision.errorCode, decision.errorMessage);
      this.store({ ...base, id: null, status: 'rejected', detail: `${errorLabel(sendErr)}: HTTP ${r.status}${decision.errorMessage ? ` · ${decision.errorMessage}` : ''}` });
      req.trafficOutcome = 'forced_error';
      return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    }

    // Accepted by the "provider"; what happens next depends on the rule.
    const id = adapter.newMessageId();
    const failure =
      decision.action === 'fail' || decision.action === 'blocked'
        ? {
            code: decision.errorCode ?? adapter.defaultFailure(decision.action === 'blocked' ? 'blocked' : 'fail').code,
            message: decision.errorMessage ?? adapter.defaultFailure(decision.action === 'blocked' ? 'blocked' : 'fail').message,
          }
        : null;
    const status = failure ? 'failed' : decision.action === 'drop' ? 'dropped' : decision.action === 'delay' ? 'scheduled' : 'delivered';
    const detail = failure
      ? `Delivery failed: ${failure.code} ${failure.message}`
      : status === 'dropped'
        ? 'Accepted, then silently dropped (no delivery report)'
        : status === 'scheduled'
          ? `Arrives in ${((decision.delayMs ?? 0) / 1000).toFixed(1)}s`
          : null;
    const msg = this.store({ ...base, id, status, detail, failure });
    resolved.messageIds = [msg.id];
    resolved.testUserIds = [msg.testUserId];

    // Delivery reports: "sent" soon, then the final status.
    const cbUrl = parsed.statusCallbackUrl ?? str(instance.config.statusCallbackUrl);
    const d = hub.config.callbackDelayMs;
    const job = (status: DeliveryStatus, delay: number, extra: Partial<StatusJob> = {}) =>
      hub.scheduler.schedule('status', { messageId: msg.id, status, callbackUrl: cbUrl, parentLogId: req.trafficLogId ?? null, ...extra } satisfies StatusJob as unknown as Record<string, unknown>, {
        projectId: project.id,
        delayMs: delay,
      });
    if (cbUrl) job('sent', Math.round(d / 3));
    if (status === 'delivered' && cbUrl) job('delivered', d);
    if (status === 'delivered' && cbUrl && parsed.channel === 'whatsapp' && flag(instance.config.readReceipts)) job('read', d * 2, { markRead: true });
    if (status === 'failed' && cbUrl) job('failed', d, { error: failure });
    if (status === 'scheduled') job('delivered', Math.max(decision.delayMs ?? 0, d), { setStatus: 'delivered', callbackUrl: cbUrl });

    const r = adapter.accepted(ctx, { id, parsed, createdAt: msg.createdAt });
    return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
  }

  private store(i: {
    ctx: Ctx;
    adapter: ProviderAdapter;
    parsed: ParsedSend;
    user: TestUser | null;
    decision: Decision;
    logId: string | null;
    runId: string | null;
    id: string | null;
    status: string;
    detail: string | null;
    failure?: { code: string; message: string } | null;
  }): Message {
    return this.hub.messageService.capture({
      project: i.ctx.project,
      instance: i.ctx.instance,
      channel: i.parsed.channel,
      from: i.parsed.from,
      to: i.parsed.to,
      text: i.parsed.body,
      status: i.status,
      statusDetail: i.detail,
      appliedRule: i.decision.rule ? { ...i.decision.rule, level: i.decision.level } : { level: 'default', label: 'Default: deliver' },
      logId: i.logId,
      testUserId: i.user?.id ?? null,
      runId: i.runId,
      providerMessageId: i.id,
      duplicateWindowSeconds: i.ctx.project.settings.duplicateWindowSeconds,
      metadata: {
        preset: i.ctx.instance.preset,
        ...(i.failure ? { errorCode: i.failure.code, errorMessage: i.failure.message } : {}),
        ...(i.parsed.statusCallbackUrl ? { statusCallbackUrl: i.parsed.statusCallbackUrl } : {}),
        ...(i.parsed.extra?.wa ? { wa: i.parsed.extra.wa } : {}),
      },
    });
  }

  private async runStatusJob(job: Job<StatusJob>): Promise<void> {
    const hub = this.hub;
    const p = job.payload;
    let m = hub.messages.get(p.messageId);
    if (!m) return; // deleted (inbox cleared)
    if (p.setStatus && job.attempts === 1) {
      m = hub.messages.updateStatus(m.id, { status: p.setStatus, statusDetail: null })!;
      hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: m });
    }
    if (p.markRead && job.attempts === 1 && !m.metadata.readReceiptAt) {
      m = hub.messages.updateStatus(m.id, { metadata: { readReceiptAt: new Date().toISOString() } })!;
      hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: m });
    }
    if (!p.callbackUrl) return;
    const project = hub.projects.get(m.projectId);
    const instance = m.providerInstanceId ? hub.providers.getById(m.providerInstanceId) : null;
    const adapter = instance ? getAdapter(instance.preset) : null;
    if (!project || !instance || !adapter) return;
    const call = adapter.statusCallback({ project, instance, baseUrl: '' }, m, p.status, p.error ?? null, p.callbackUrl);
    const res = await sendOutbound(hub.traffic, {
      projectId: project.id,
      runId: m.runId,
      parentLogId: p.parentLogId,
      method: call.method ?? 'POST',
      url: call.url,
      headers: call.headers,
      body: call.body,
      purpose: `status callback: ${p.status}`,
      resolved: { messageId: m.id, instance: instance.slug, status: p.status },
    });
    // Re-read after the await: other callbacks for this message may have recorded their reports meanwhile.
    const cur = hub.messages.get(m.id) ?? m;
    const reports = Array.isArray(cur.metadata.reports) ? (cur.metadata.reports as unknown[]) : [];
    const updated = hub.messages.updateStatus(m.id, {
      metadata: { reports: [...reports, { status: p.status, at: new Date().toISOString(), httpStatus: res.status, error: res.error, logId: res.logId }] },
    });
    if (updated) hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: updated });
    if (!res.ok && !res.blocked && (res.status === null || res.status >= 500)) throw new RetryLater(res.error ?? `HTTP ${res.status}`, 2000 * job.attempts);
  }

  /** WhatsApp Cloud API media: upload, info, delete, download (stored small in the DB). */
  private async handleMedia(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, adapter: ProviderAdapter, match: Exclude<MatchResult, null>, resolved: Record<string, unknown>) {
    const hub = this.hub;
    const out = (kind: Parameters<NonNullable<ProviderAdapter['mediaReply']>>[1], data: Record<string, unknown>) => {
      const r = adapter.mediaReply!(ctx, kind, data);
      return reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    };
    if (!adapter.mediaReply) return reply.status(404).send({ error: 'Not found' });
    const url = (id: string) => `${ctx.baseUrl}/mock/${ctx.project.slug}/${ctx.instance.slug}/whatsapp_business/attachments/?mid=${id}&ext=${Math.floor(Date.now() / 1000)}&hash=stubyard`;
    switch (match.kind) {
      case 'media-upload': {
        resolved.api = 'whatsapp-media';
        const fail = (message: string, details?: string, code = 131053) => ((req.trafficOutcome = 'invalid'), out('error', { status: 400, code, message, details }));
        const ct = String(req.headers['content-type'] ?? '');
        if (!/multipart\/form-data/i.test(ct) || !req.rawBody) return fail('The parameter file is required.', 'Send multipart/form-data with messaging_product, file and type.', 100);
        let fd: FormData;
        try {
          fd = await new Response(new Uint8Array(req.rawBody), { headers: { 'content-type': ct } }).formData();
        } catch {
          return fail('Invalid multipart body', undefined, 100);
        }
        if (fd.get('messaging_product') !== 'whatsapp') return fail('The parameter messaging_product is required.', undefined, 100);
        const file = fd.get('file');
        if (!file || typeof file === 'string') return fail('The parameter file is required.', undefined, 100);
        const mime = String(fd.get('type') ?? file.type ?? '').split(';')[0].trim().toLowerCase();
        const mtype = mediaTypeOf(mime);
        if (!mtype) return fail('Media upload error', `Unsupported file type ${mime || '(none)'}. Supported: ${MEDIA_TYPES.map((t) => MEDIA_LIMITS[t].mimes.join(', ')).join(', ')}`);
        const data = Buffer.from(await file.arrayBuffer());
        const max = Math.min(MEDIA_LIMITS[mtype].maxBytes, hub.config.maxMediaBytes);
        if (data.length > max) return fail('Media upload error', `File is ${data.length} bytes; the limit for ${mtype} here is ${max} bytes (Meta: ${MEDIA_LIMITS[mtype].maxBytes}; stubyard: STUBYARD_MAX_MEDIA_BYTES).`);
        const id = String(randomInt(1, 10)) + Array.from({ length: 15 }, () => randomInt(0, 10)).join('');
        hub.media.insert({ id, projectId: ctx.project.id, providerInstanceId: ctx.instance.id, mimeType: mime, filename: file.name || null, data });
        Object.assign(resolved, { mediaId: id, mimeType: mime, bytes: data.length });
        return out('uploaded', { id });
      }
      case 'media-get':
      case 'media-delete': {
        resolved.api = 'whatsapp-media';
        resolved.mediaId = match.id;
        const info = hub.media.info(ctx.instance.id, match.id);
        if (!info) return (req.trafficOutcome = 'unmatched'), out('not_found', { id: match.id });
        if (match.kind === 'media-delete') return hub.media.delete(ctx.instance.id, match.id), out('deleted', {});
        return out('info', { id: info.id, url: url(info.id), mime_type: info.mimeType, sha256: info.sha256, file_size: info.fileSize });
      }
      case 'media-download': {
        const info = hub.media.info(ctx.instance.id, match.id);
        const data = info ? hub.media.data(ctx.instance.id, match.id) : null;
        if (!info || !data) return (req.trafficOutcome = 'unmatched'), reply.status(404).send('Not found');
        return reply
          .status(200)
          .headers({ 'content-type': info.mimeType, 'content-length': String(data.length), ...(info.filename ? { 'content-disposition': `inline; filename="${info.filename.replace(/"/g, '')}"` } : {}) })
          .send(data);
      }
      case 'mark-read': {
        // The app marks a user's message as read: just acknowledge (and note it on the inbound message).
        const m = hub.messages.findByProviderId(ctx.project.id, match.id);
        if (m && m.direction === 'inbound') {
          const u = hub.messages.updateStatus(m.id, { metadata: { markedReadByApp: new Date().toISOString() } });
          if (u) hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: u });
        }
        resolved.markRead = match.id;
        return reply.status(200).send({ success: true });
      }
    }
  }

  /** "Mark as read" in the workspace: the test user read a WhatsApp message → "read" status callback now. */
  readReceipt(project: Project, messageId: string) {
    const hub = this.hub;
    const m = hub.messages.get(messageId);
    if (!m || m.projectId !== project.id) throw new HttpError(404, 'Message not found');
    if (m.channel !== 'whatsapp' || m.direction !== 'outbound') throw new HttpError(400, 'Read receipts are for outbound WhatsApp messages');
    if (!['delivered', 'complained'].includes(m.status)) throw new HttpError(409, `The message is ${m.status}; only delivered messages can be read`);
    const instance = m.providerInstanceId ? hub.providers.getById(m.providerInstanceId) : null;
    const cbUrl = str(m.metadata.statusCallbackUrl) ?? str(instance?.config.statusCallbackUrl);
    hub.scheduler.schedule('status', { messageId: m.id, status: 'read', callbackUrl: cbUrl, markRead: true } satisfies StatusJob as unknown as Record<string, unknown>, { projectId: project.id });
    return { messageId: m.id, callbackUrl: cbUrl, scheduled: true };
  }

  /** A test user "replies": store the inbound message and send the provider's inbound webhook to the app. */
  async reply(
    project: Project,
    user: TestUser,
    input: {
      channel: Channel;
      text: string;
      instance?: string | null;
      /** WhatsApp: tap a button / list row (id or title) of an earlier interactive message. */
      button?: string | null;
      /** Explicit reply payload (Twilio: ButtonPayload / ButtonText) when stubyard does not know the buttons. */
      buttonReply?: { id: string; title?: string | null } | null;
      /** The message replied to (stubyard id); default: the latest interactive message for button replies. */
      contextMessageId?: string | null;
      /** Email */
      subject?: string | null;
      html?: string | null;
      inReplyTo?: string | null;
      to?: string | null;
    },
  ) {
    const hub = this.hub;
    if (input.channel === 'email') return this.emailInbound.reply(project, user, input);
    const instance: ProviderInstance | null = input.instance ? hub.providers.require(project.id, input.instance) : hub.providers.defaultFor(project.id, input.channel);
    if (!instance) throw new HttpError(400, `Project "${project.slug}" has no ${input.channel} provider instance. Add one under Providers.`);
    const adapter = getAdapter(instance.preset);
    if (!adapter) throw new HttpError(400, `The "${instance.preset}" preset cannot send inbound messages`);
    const from = input.channel === 'whatsapp' ? user.whatsapp ?? user.phone : user.phone;
    if (!from) throw new HttpError(400, `${user.name} has no ${input.channel === 'whatsapp' ? 'WhatsApp' : 'phone'} number`);

    // Button / list replies refer to an earlier message.
    let tapped: InboundInput['reply'] = null;
    let context: Message | null = input.contextMessageId ? hub.messages.get(input.contextMessageId) : null;
    if (input.contextMessageId && (!context || context.projectId !== project.id)) throw new HttpError(404, 'contextMessageId: message not found');
    if (input.button || input.buttonReply) {
      if (input.channel !== 'whatsapp') throw new HttpError(400, 'Button replies are for WhatsApp');
      if (!context) {
        context =
          hub.messages
            .list(project.id, { testUserId: user.id, channel: 'whatsapp', providerInstanceId: instance.id, limit: 50 })
            .find((m) => m.direction === 'outbound' && replyOptions(m).length > 0) ?? null;
      }
      const options = context ? replyOptions(context) : [];
      if (input.button) {
        const want = input.button.trim();
        const hit = options.find((o) => o.id === want) ?? options.find((o) => o.title.toLowerCase() === want.toLowerCase());
        if (hit) tapped = { kind: hit.kind, id: hit.id, title: hit.title, description: hit.description ?? null };
        else if (!input.buttonReply)
          throw new HttpError(
            400,
            options.length
              ? `"${want}" is not a button of the last interactive message. Options: ${options.map((o) => `${o.title} (${o.id})`).join(', ')}`
              : `No interactive message with buttons for ${user.name}. Pass buttonReply {id, title} to send any payload.`,
          );
      }
      if (!tapped && input.buttonReply) tapped = { kind: 'button', id: String(input.buttonReply.id), title: String(input.buttonReply.title ?? input.buttonReply.id) };
    }
    const text = (tapped?.title ?? input.text).trim();
    if (!text) throw new HttpError(400, 'Reply text is required');
    // Reply to the number that last wrote to this user, like a real phone.
    const last = hub.messages.list(project.id, { testUserId: user.id, channel: input.channel, providerInstanceId: instance.id, limit: 1 })[0];
    const to = (last?.direction === 'outbound' ? last.from : null) ?? str(instance.config.fromNumber) ?? '+15550001234';
    const url = str(instance.config.inboundUrl) ?? (instance.preset === 'meta-whatsapp' ? str(instance.config.statusCallbackUrl) : null);
    const id = adapter.newMessageId();
    const ctxRef = context?.providerMessageId ? { id: context.providerMessageId, from: null } : null;
    let msg = hub.messageService.capture({
      project,
      instance,
      channel: input.channel,
      direction: 'inbound',
      testUserId: user.id,
      from,
      to,
      text,
      status: url ? 'sending' : 'received',
      statusDetail: url ? null : 'No inbound URL configured on this provider instance, so your app was not called',
      logId: null,
      providerMessageId: id,
      duplicateWindowSeconds: 0,
      metadata: tapped
        ? { wa: { type: tapped.kind === 'button' ? 'button' : 'interactive', text, reply: tapped, replyTo: context?.id ?? null } satisfies WaContent }
        : context
          ? { wa: { type: 'text', text, replyTo: context.id } satisfies WaContent }
          : undefined,
    });
    if (!url) return { message: msg, webhook: null };
    const call = adapter.inbound({ project, instance, baseUrl: '' }, { id, channel: input.channel, from, to, text, profileName: user.name, reply: tapped, context: ctxRef }, url);
    const res = await sendOutbound(hub.traffic, {
      projectId: project.id,
      runId: msg.runId,
      method: call.method ?? 'POST',
      url: call.url,
      headers: call.headers,
      body: call.body,
      purpose: `inbound ${input.channel} from ${user.name}${tapped ? ` (${tapped.kind}: ${tapped.title})` : ''}`,
      resolved: { messageId: msg.id, instance: instance.slug, user: user.name },
    });
    msg = hub.messages.updateStatus(msg.id, {
      status: res.ok ? 'received' : 'failed',
      statusDetail: res.ok ? null : `Your app did not accept the inbound webhook: ${res.error ?? `HTTP ${res.status}`}`,
    })!;
    hub.bus.publish({ type: 'message.updated', projectId: project.id, data: msg });
    return { message: msg, webhook: { ok: res.ok, status: res.status, error: res.error, logId: res.logId } };
  }
}

/** Buttons / list rows / template quick replies a user can tap on an outbound WhatsApp message. */
export function replyOptions(m: Message): { kind: 'button_reply' | 'list_reply' | 'button'; id: string; title: string; description?: string | null }[] {
  const wa = m.metadata.wa as WaContent | undefined;
  if (!wa) return [];
  if (wa.interactive?.buttons) return wa.interactive.buttons.filter((b: WaButton) => b.kind === 'reply').map((b) => ({ kind: 'button_reply' as const, id: b.id, title: b.title }));
  if (wa.interactive?.sections) return wa.interactive.sections.flatMap((s) => s.rows.map((r) => ({ kind: 'list_reply' as const, id: r.id, title: r.title, description: r.description ?? null })));
  if (wa.template?.buttons) return wa.template.buttons.filter((b) => b.kind === 'quick_reply').map((b) => ({ kind: 'button' as const, id: b.id, title: b.title }));
  return [];
}

/** "timeout" rule: never answer, close the socket after timeoutHoldMs and finish the traffic log entry ourselves. */
export async function holdTimeout(hub: Hub, req: FastifyRequest, reply: FastifyReply, resolved: Record<string, unknown>): Promise<void> {
  req.trafficOutcome = 'forced_error';
  reply.hijack();
  // We finish this log ourselves; stop the generic abort hook from overwriting it as "client_aborted".
  const logId = req.trafficLogId;
  req.trafficLogId = undefined;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, hub.config.timeoutHoldMs);
    req.raw.once('close', () => (clearTimeout(t), resolve()));
  });
  req.raw.socket?.destroy();
  if (logId) {
    hub.traffic.finish(logId, { outcome: 'forced_error', errorType: 'simulated_timeout', errorMessage: 'Rule: no response (timeout)', resStatus: null });
    hub.traffic.mergeResolved(logId, resolved);
  }
}

export function sendErrorKind(d: Decision, adapter: Pick<ProviderAdapter, 'blockedAt'>): SendError | null {
  if (d.level === 'opt_out') return 'opt_out';
  switch (d.action) {
    case 'reject':
    case 'bounce_hard':
      return 'reject';
    case 'rate_limit':
      return 'rate_limit';
    case 'down':
      return 'down';
    case 'blocked':
      return adapter.blockedAt === 'send' ? 'blocked' : null;
    default:
      return null;
  }
}

function errorLabel(k: SendError): string {
  return { reject: 'Rejected', blocked: 'Blocked', rate_limit: 'Rate limited', down: 'Provider down', opt_out: 'Opted out (DND)' }[k];
}

function str(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}

export function baseUrl(req: FastifyRequest): string {
  const proto = (req.raw.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}
