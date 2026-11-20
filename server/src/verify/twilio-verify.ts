import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import { holdTimeout } from '../messages/simulator.js';
import { fields, str, type Ctx, type MockRequest, type Reply, type SendError } from '../providers/adapters/types.js';
import type { Verification, VerifyServiceRow } from '../repos/verify.js';
import { normalizeEmail, normalizePhone } from '../util.js';
import { deliverCode, flag, generateCode, hex, isoSeconds, type VerifyChannel } from './deliver.js';

/**
 * Twilio Verify v2 on a `twilio` / `twilio-whatsapp` instance (real host: verify.twilio.com, same /mock/<p>/<i> base in stubyard):
 * Services, Verifications (stubyard generates and delivers the code), VerificationCheck.
 */
const SERVICES = /^\/v2\/Services\/?$/;
const SERVICE = /^\/v2\/Services\/(VA[0-9a-zA-Z]+)\/?$/;
const VERIFICATIONS = /^\/v2\/Services\/(VA[0-9a-zA-Z]+)\/Verifications\/?$/;
const VERIFICATION = /^\/v2\/Services\/(VA[0-9a-zA-Z]+)\/Verifications\/([^/]+)\/?$/;
const CHECK = /^\/v2\/Services\/(VA[0-9a-zA-Z]+)\/VerificationCheck\/?$/;

export const TWILIO_VERIFY_HOST = 'https://verify.twilio.com';
export const MAX_SEND_ATTEMPTS = 5;
export const MAX_CHECK_ATTEMPTS = 5;
const CHANNELS = ['sms', 'whatsapp', 'email', 'call'] as const;

const twErr = (status: number, code: number, message: string): Reply => ({
  status,
  body: { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status },
});
const invalid = (param: string) => twErr(400, 60200, `Invalid parameter: ${param}`);
const notFound = (path: string) => twErr(404, 20404, `The requested resource ${path} was not found`);

export function isTwilioVerifyPath(path: string): boolean {
  return path.startsWith('/v2/Services');
}

function accountSid(ctx: Ctx, req: MockRequest): string {
  const auth = String(req.headers.authorization ?? '');
  if (/^basic /i.test(auth)) {
    const user = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':')[0];
    if (/^AC[0-9a-f]{32}$/i.test(user)) return user;
  }
  return str(ctx.instance.config.accountSid) ?? 'AC' + 'd'.repeat(32);
}

const bool = (v: unknown, dflt: boolean) => (v === undefined || v === null || v === '' ? dflt : /^true$/i.test(String(v)));

function serviceJson(s: VerifyServiceRow, account: string) {
  const url = `${TWILIO_VERIFY_HOST}/v2/Services/${s.id}`;
  const c = s.config;
  return {
    sid: s.id,
    account_sid: account,
    friendly_name: s.friendlyName,
    code_length: s.codeLength,
    lookup_enabled: bool(c.LookupEnabled, false),
    psd2_enabled: bool(c.Psd2Enabled, false),
    skip_sms_to_landlines: bool(c.SkipSmsToLandlines, false),
    dtmf_input_required: bool(c.DtmfInputRequired, true),
    tts_name: str(c.TtsName),
    do_not_share_warning_enabled: bool(c.DoNotShareWarningEnabled, false),
    custom_code_enabled: bool(c.CustomCodeEnabled, false),
    push: { include_date: false, apn_credential_sid: null, fcm_credential_sid: null },
    totp: { issuer: s.friendlyName, time_step: 30, code_length: 6, skew: 1 },
    whatsapp: { msg_service_sid: null, from: null },
    default_template_sid: str(c.DefaultTemplateSid),
    verify_event_subscription_enabled: false,
    date_created: isoSeconds(s.createdAt),
    date_updated: isoSeconds(s.updatedAt),
    url,
    links: {
      verification_checks: `${url}/VerificationCheck`,
      verifications: `${url}/Verifications`,
      access_tokens: `${url}/AccessTokens`,
      entities: `${url}/Entities`,
      messaging_configurations: `${url}/MessagingConfigurations`,
      rate_limits: `${url}/RateLimits`,
      webhooks: `${url}/Webhooks`,
    },
  };
}

const publicStatus = (v: Verification) => v.status;

function verificationJson(v: Verification, account: string) {
  return {
    sid: v.id,
    service_sid: v.serviceId,
    account_sid: account,
    to: v.to,
    channel: v.channel,
    status: publicStatus(v),
    valid: v.status === 'approved',
    lookup: { carrier: null },
    amount: str(v.params.Amount),
    payee: str(v.params.Payee),
    send_code_attempts: v.sendAttempts.map((a) => ({ attempt_sid: a.attempt_sid, channel: a.channel, time: a.time })),
    sna: null,
    date_created: isoSeconds(v.createdAt),
    date_updated: isoSeconds(v.updatedAt),
    url: `${TWILIO_VERIFY_HOST}/v2/Services/${v.serviceId}/Verifications/${v.id}`,
  };
}

function checkJson(v: Verification, account: string) {
  return {
    sid: v.id,
    service_sid: v.serviceId,
    account_sid: account,
    to: v.to,
    channel: v.channel,
    status: v.status,
    valid: v.status === 'approved',
    amount: str(v.params.Amount),
    payee: str(v.params.Payee),
    sna_attempts_error_codes: [],
    date_created: isoSeconds(v.createdAt),
    date_updated: isoSeconds(v.updatedAt),
  };
}

function messageText(service: VerifyServiceRow, channel: VerifyChannel, code: string, f: Record<string, unknown>): { text: string; subject: string | null } {
  const name = str(f.CustomFriendlyName) ?? service.friendlyName;
  const custom = str(f.CustomMessage);
  if (custom) return { text: custom.includes(code) ? custom : `${custom} ${code}`, subject: null };
  switch (channel) {
    case 'whatsapp':
      return { text: `*${code}* is your verification code. For your security, do not share this code.`, subject: null };
    case 'email':
      return { text: `${name}\n\nYour verification code is: ${code}\n\nThis code expires in 10 minutes.`, subject: `${name} verification code` };
    case 'voice':
      return { text: `[Voice call] Your ${name} verification code is: ${code.split('').join(' ')}. Again, your code is ${code.split('').join(' ')}. (${code})`, subject: null };
    default:
      return { text: `Your ${name} verification code is: ${code}`, subject: null };
  }
}

export class TwilioVerify {
  constructor(private hub: Hub) {}

  private expirySeconds(ctx: Ctx): number {
    const n = Number(ctx.instance.config.verifyExpirySeconds);
    return Number.isFinite(n) && n > 0 ? n : 600;
  }

  /** Live, unexpired verification (expired ones are marked so on read). */
  private live(v: Verification | null): Verification | null {
    if (!v) return null;
    // stubyard's clock with the project's / run's "verify" offset (expiry is shifted on check only).
    const now = this.hub.clock?.now(v.projectId, 'verify', v.runId) ?? Date.now();
    if (v.status === 'pending' && Date.parse(v.expiresAt) <= now) {
      this.hub.verify.update(v.id, { status: 'expired' });
      return null;
    }
    return v.status === 'expired' || Date.parse(v.expiresAt) <= now ? null : v;
  }

  /** Service by sid; unknown VA sids are created on first use unless verifyAutoCreateServices is "false". */
  private service(ctx: Ctx, sid: string, autoCreate: boolean): VerifyServiceRow | null {
    const s = this.hub.verify.getService(ctx.instance.id, sid);
    if (s || !autoCreate) return s;
    if (ctx.instance.config.verifyAutoCreateServices !== undefined && !flag(ctx.instance.config.verifyAutoCreateServices)) return null;
    return this.hub.verify.createService({
      id: sid,
      projectId: ctx.project.id,
      providerInstanceId: ctx.instance.id,
      friendlyName: str(ctx.instance.config.verifyFriendlyName) ?? ctx.project.name,
      codeLength: 6,
      config: { autoCreated: true },
    });
  }

  async handle(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, mreq: MockRequest, resolved: Record<string, unknown>): Promise<unknown> {
    const send = (r: Reply) => reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    const f = fields(mreq);
    const account = accountSid(ctx, mreq);
    const p = mreq.path;
    const m = mreq.method;
    resolved.api = 'twilio-verify';
    let x: RegExpExecArray | null;

    if (SERVICES.test(p) && m === 'POST') {
      const name = str(f.FriendlyName);
      if (!name) return (req.trafficOutcome = 'invalid'), send(twErr(400, 20001, 'Missing required parameter FriendlyName in the post body'));
      const len = f.CodeLength === undefined ? 6 : Number(f.CodeLength);
      if (!Number.isInteger(len) || len < 4 || len > 10) return (req.trafficOutcome = 'invalid'), send(invalid('CodeLength'));
      const cfgKeys = ['LookupEnabled', 'SkipSmsToLandlines', 'DtmfInputRequired', 'TtsName', 'Psd2Enabled', 'DoNotShareWarningEnabled', 'CustomCodeEnabled', 'DefaultTemplateSid'];
      const s = this.hub.verify.createService({
        id: 'VA' + hex(32),
        projectId: ctx.project.id,
        providerInstanceId: ctx.instance.id,
        friendlyName: name,
        codeLength: len,
        config: Object.fromEntries(cfgKeys.filter((k) => f[k] !== undefined).map((k) => [k, str(f[k])])),
      });
      resolved.serviceSid = s.id;
      return reply.status(201).send(serviceJson(s, account));
    }
    if (SERVICES.test(p) && m === 'GET') {
      const list = this.hub.verify.listServices(ctx.instance.id).map((s) => serviceJson(s, account));
      const url = `${TWILIO_VERIFY_HOST}/v2/Services?PageSize=50&Page=0`;
      return send({ status: 200, body: { services: list, meta: { page: 0, page_size: 50, first_page_url: url, previous_page_url: null, url, next_page_url: null, key: 'services' } } });
    }
    if ((x = SERVICE.exec(p))) {
      const s = this.hub.verify.getService(ctx.instance.id, x[1]);
      if (!s) return (req.trafficOutcome = 'unmatched'), send(notFound(`/Services/${x[1]}`));
      if (m === 'GET') return send({ status: 200, body: serviceJson(s, account) });
      if (m === 'DELETE') return this.hub.verify.deleteService(ctx.instance.id, s.id), reply.status(204).send();
      if (m === 'POST') {
        const len = f.CodeLength === undefined ? undefined : Number(f.CodeLength);
        if (len !== undefined && (!Number.isInteger(len) || len < 4 || len > 10)) return (req.trafficOutcome = 'invalid'), send(invalid('CodeLength'));
        const u = this.hub.verify.updateService(ctx.instance.id, s.id, { friendlyName: str(f.FriendlyName) ?? undefined, codeLength: len });
        return send({ status: 200, body: serviceJson(u!, account) });
      }
    }
    if ((x = VERIFICATIONS.exec(p)) && m === 'POST') return this.create(req, reply, ctx, x[1], f, account, resolved);
    if ((x = VERIFICATION.exec(p)) && (m === 'GET' || m === 'POST')) {
      const s = this.hub.verify.getService(ctx.instance.id, x[1]);
      const raw = this.hub.verify.get(x[2]);
      const v = s && raw && raw.serviceId === s.id && raw.providerInstanceId === ctx.instance.id ? this.live(raw) : null;
      if (!v) return (req.trafficOutcome = 'unmatched'), send(notFound(`/Services/${x[1]}/Verifications/${x[2]}`));
      resolved.verificationSid = v.id;
      if (m === 'GET') return send({ status: 200, body: verificationJson(v, account) });
      const status = str(f.Status);
      if (status !== 'canceled' && status !== 'approved') return (req.trafficOutcome = 'invalid'), send(invalid('Status'));
      if (v.status !== 'pending') return (req.trafficOutcome = 'unmatched'), send(notFound(`/Services/${x[1]}/Verifications/${x[2]}`));
      const u = this.hub.verify.update(v.id, { status })!;
      this.publish(u);
      return send({ status: 200, body: verificationJson(u, account) });
    }
    if ((x = CHECK.exec(p)) && m === 'POST') return this.check(req, reply, ctx, x[1], f, account, resolved);

    req.trafficOutcome = 'unmatched';
    return send(notFound(p.replace(/^\/v2/, '')));
  }

  private async create(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, sid: string, f: Record<string, unknown>, account: string, resolved: Record<string, unknown>) {
    const hub = this.hub;
    const send = (r: Reply) => reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    const bad = (r: Reply) => ((req.trafficOutcome = 'invalid'), send(r));
    const service = this.service(ctx, sid, true);
    if (!service) return (req.trafficOutcome = 'unmatched'), send(notFound(`/Services/${sid}`));
    const rawTo = str(f.To);
    if (!rawTo) return bad(twErr(400, 20001, 'Missing required parameter To in the post body'));
    const ch = str(f.Channel);
    if (!ch) return bad(twErr(400, 20001, 'Missing required parameter Channel in the post body'));
    if (!(CHANNELS as readonly string[]).includes(ch)) return bad(invalid('Channel'));
    const channel: VerifyChannel = ch === 'call' ? 'voice' : (ch as VerifyChannel);
    const to = channel === 'email' ? normalizeEmail(rawTo) : normalizePhone(rawTo.replace(/^whatsapp:/i, ''));
    if (!to || (channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))) return bad(invalid('To'));
    const custom = str(f.CustomCode);
    if (custom && !/^[0-9A-Za-z]{4,10}$/.test(custom)) return bad(invalid('CustomCode'));
    const locale = str(f.Locale);
    if (locale && !/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(locale)) return bad(invalid('Locale'));
    Object.assign(resolved, { serviceSid: service.id, channel: ch, to });

    // Same To + service while pending: Twilio resends the same code on the same verification (max 5 sends).
    let v = this.live(hub.verify.findPending(ctx.instance.id, to, service.id));
    if (v && v.sendAttempts.length >= MAX_SEND_ATTEMPTS) {
      req.trafficOutcome = 'rejected';
      resolved.error = 'Max send attempts reached';
      return send(twErr(429, 60203, 'Max send attempts reached'));
    }
    const code = custom ?? v?.code ?? generateCode(service.codeLength);
    const vsid = v?.id ?? 'VE' + hex(32);
    const attempt = { attempt_sid: 'VL' + hex(32), channel: ch, time: isoSeconds() };
    const { text, subject } = messageText(service, channel, code, f);
    const from = channel === 'email' ? (str(ctx.instance.config.verifyEmailFrom) ?? `no-reply@${ctx.project.slug}.verify.test`) : (str(ctx.instance.config.fromNumber) ?? '+15005550006');
    const result = await deliverCode(hub, {
      ctx,
      req,
      channel,
      to,
      from,
      subject,
      text,
      code,
      providerMessageId: vsid,
      metadata: { verify: { api: 'twilio-verify', serviceSid: service.id, verificationSid: vsid, channel: ch, locale } },
    });
    Object.assign(resolved, { action: result.decision.action, rule: result.decision.rule?.label ?? null, messageIds: [result.message.id], testUserIds: [result.message.testUserId] });
    if (result.kind === 'timeout') return holdTimeout(hub, req, reply, resolved);
    if (result.kind === 'send_error') {
      req.trafficOutcome = 'forced_error';
      return send(sendError(result.error, result.decision.errorCode, result.decision.errorMessage, to));
    }
    const expiresAt = new Date(Date.now() + this.expirySeconds(ctx) * 1000).toISOString();
    const att = { ...attempt, messageId: result.message.id };
    v = v
      ? hub.verify.update(v.id, { sendAttempts: [...v.sendAttempts, att], messageIds: [...v.messageIds, result.message.id], channel: ch, code })!
      : hub.verify.insert({
          id: vsid,
          projectId: ctx.project.id,
          providerInstanceId: ctx.instance.id,
          kind: 'twilio',
          serviceId: service.id,
          to,
          channel: ch,
          code,
          status: 'pending',
          sendAttempts: [att],
          checkAttempts: 0,
          messageIds: [result.message.id],
          params: { Locale: locale, Amount: str(f.Amount), Payee: str(f.Payee), customCode: !!custom },
          runId: result.runId,
          logId: req.trafficLogId ?? null,
          expiresAt,
        });
    resolved.verificationSid = v.id;
    this.publish(v);
    return reply.status(201).send(verificationJson(v, account));
  }

  private async check(req: FastifyRequest, reply: FastifyReply, ctx: Ctx, sid: string, f: Record<string, unknown>, account: string, resolved: Record<string, unknown>) {
    const hub = this.hub;
    const send = (r: Reply) => reply.status(r.status).headers(r.headers ?? {}).send(r.body);
    const path = `/Services/${sid}/VerificationCheck`;
    const service = hub.verify.getService(ctx.instance.id, sid);
    if (!service) return (req.trafficOutcome = 'unmatched'), send(notFound(`/Services/${sid}`));
    const code = str(f.Code);
    if (!code) return (req.trafficOutcome = 'invalid'), send(twErr(400, 20001, 'Missing required parameter Code in the post body'));
    const vsid = str(f.VerificationSid);
    const rawTo = str(f.To);
    if (!vsid && !rawTo) return (req.trafficOutcome = 'invalid'), send(twErr(400, 60200, "Invalid parameter: Either a 'To' or a 'VerificationSid' must be specified"));
    let v: Verification | null;
    if (vsid) {
      const raw = hub.verify.get(vsid);
      v = raw && raw.serviceId === service.id && raw.providerInstanceId === ctx.instance.id ? raw : null;
    } else {
      const to = rawTo!.includes('@') ? normalizeEmail(rawTo) : normalizePhone(rawTo!.replace(/^whatsapp:/i, ''));
      v = to ? hub.verify.findPending(ctx.instance.id, to, service.id) : null;
    }
    v = this.live(v);
    // Approved / canceled verifications are gone, like in Twilio (20404).
    if (!v || (v.status !== 'pending' && v.status !== 'max_attempts_reached')) {
      req.trafficOutcome = 'unmatched';
      resolved.error = 'No pending verification (never created, expired, approved or canceled)';
      return send(notFound(path));
    }
    resolved.verificationSid = v.id;
    if (v.checkAttempts >= MAX_CHECK_ATTEMPTS) {
      if (v.status !== 'max_attempts_reached') this.publish(hub.verify.update(v.id, { status: 'max_attempts_reached' })!);
      req.trafficOutcome = 'rejected';
      return send(twErr(429, 60202, 'Max check attempts reached'));
    }
    const ok = code === v.code;
    const u = hub.verify.update(v.id, { checkAttempts: v.checkAttempts + 1, status: ok ? 'approved' : 'pending' })!;
    resolved.result = ok ? 'approved' : 'wrong code';
    this.publish(u);
    return send({ status: 200, body: checkJson(u, account) });
  }

  private publish(v: Verification) {
    this.hub.bus.publish({ type: 'verification.updated', projectId: v.projectId, data: { id: v.id, status: v.status, to: v.to, kind: v.kind } });
  }
}

function sendError(kind: SendError, code: string | null, message: string | null, to: string): Reply {
  const n = Number(code);
  switch (kind) {
    case 'down':
      return twErr(503, n || 20503, message ?? 'Service Unavailable');
    case 'rate_limit':
      return twErr(429, n || 60203, message ?? 'Max send attempts reached');
    case 'blocked':
    case 'opt_out':
      return twErr(403, n || 60410, message ?? 'Verification delivery attempt blocked');
    default:
      return twErr(400, n || 60200, message ?? `Invalid parameter \`To\`: ${to}`);
  }
}
