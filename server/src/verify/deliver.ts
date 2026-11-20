import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Hub } from '../hub.js';
import { sendErrorKind } from '../messages/simulator.js';
import type { Ctx, SendError } from '../providers/adapters/types.js';
import type { Channel } from '../providers/catalog.js';
import type { Message } from '../repos/messages.js';
import type { Decision } from '../rules/engine.js';
import { tagLog } from '../runs/resolver.js';

/** Channels a Verify API can deliver a code on. "voice" is stored as an SMS-channel entry marked as a call. */
export type VerifyChannel = 'sms' | 'whatsapp' | 'email' | 'voice';

export interface CodeDelivery {
  ctx: Ctx;
  req: FastifyRequest;
  channel: VerifyChannel;
  to: string;
  from: string | null;
  subject?: string | null;
  text: string;
  code: string;
  providerMessageId: string;
  metadata: Record<string, unknown>;
}

export type DeliveryResult =
  | { kind: 'send_error'; error: SendError; decision: Decision; message: Message }
  | { kind: 'timeout'; decision: Decision; message: Message }
  | { kind: 'accepted'; decision: Decision; message: Message; runId: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const storageChannel = (c: VerifyChannel): Channel => (c === 'voice' ? 'sms' : c);

/** Numeric code of `length` digits. */
export function generateCode(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String(randomInt(0, 10));
  // Avoid a leading zero that some apps strip when they parse the code as a number.
  return s[0] === '0' ? String(randomInt(1, 10)) + s.slice(1) : s;
}

/**
 * Deliver a code that stubyard generated (Verify APIs) to the recipient's timeline, applying scenario rules like any
 * other message: send-time errors, timeout, fail / drop / delay. "slow" waits here.
 */
export async function deliverCode(hub: Hub, d: CodeDelivery): Promise<DeliveryResult> {
  const { project, instance } = d.ctx;
  const channel = storageChannel(d.channel);
  const explicit = hub.runs.resolver.explicitOf(d.req);
  const attributed = hub.runs.resolver.forRecipient(project.id, channel, d.to, explicit);
  tagLog(hub, d.req.trafficLogId, attributed);
  const header = d.req.headers['x-hub-scenario'];
  let decision: Decision = !instance.enabled
    ? { action: 'down', errorCode: null, errorMessage: 'Provider instance is disabled in stubyard', delayMs: null, level: 'instance', rule: { id: null, position: null, action: 'down', label: 'Instance disabled' } }
    : hub.engine.evaluate({ projectId: project.id, channel, instance, user: attributed.user, header: Array.isArray(header) ? header[0] : header, runId: attributed.run?.id ?? null });
  if (decision.action === 'slow') {
    await sleep(decision.delayMs ?? 3000);
    decision = { ...decision, action: 'deliver' };
  }
  const runId = attributed.run?.id ?? null;
  const capture = async (status: string, detail: string | null, extra: Record<string, unknown> = {}) => {
    const mailpitId = d.channel === 'email' && (status === 'delivered' || status === 'scheduled') ? await relayEmail(hub, d) : null;
    return hub.messageService.capture({
      project,
      instance,
      channel,
      from: d.from,
      to: d.to,
      subject: d.subject ?? null,
      text: d.text,
      mailpitId,
      messageIdHeader: d.channel === 'email' ? `<${d.providerMessageId}@verify.stubyard.local>` : null,
      status,
      statusDetail: detail,
      appliedRule: decision.rule ? { ...decision.rule, level: decision.level } : { level: 'default', label: 'Default: deliver' },
      logId: d.req.trafficLogId ?? null,
      testUserId: attributed.user?.id ?? null,
      runId,
      providerMessageId: d.providerMessageId,
      otp: d.code,
      // A resend of the same code is expected, not a double send.
      duplicateWindowSeconds: 0,
      metadata: { preset: instance.preset, ...(d.channel === 'voice' ? { voice: true } : {}), ...d.metadata, ...extra },
    });
  };

  if (decision.action === 'timeout') return { kind: 'timeout', decision, message: await capture('timeout', 'Simulated timeout: stubyard never answered') };
  const err = sendErrorKind(decision, { blockedAt: 'send' });
  if (err) return { kind: 'send_error', error: err, decision, message: await capture('rejected', `${ERR[err]}${decision.errorMessage ? ` · ${decision.errorMessage}` : ''}`) };

  const failed = decision.action === 'fail' || decision.action === 'bounce_hard' || decision.action === 'bounce_soft' || decision.action === 'bounce_delayed';
  if (failed) {
    const code = decision.errorCode ?? (d.channel === 'email' ? '550' : '30003');
    const msg = decision.errorMessage ?? (d.channel === 'email' ? 'Mailbox unavailable' : 'Unreachable destination handset');
    return { kind: 'accepted', decision, runId, message: await capture('failed', `Delivery failed: ${code} ${msg}`, { errorCode: code, errorMessage: msg }) };
  }
  if (decision.action === 'drop') return { kind: 'accepted', decision, runId, message: await capture('dropped', 'Accepted, then silently dropped') };
  if (decision.action === 'delay' || decision.action === 'defer') {
    const ms = decision.delayMs ?? 5000;
    const m = await capture('scheduled', `Arrives in ${(ms / 1000).toFixed(1)}s`);
    hub.scheduler.schedule('status', { messageId: m.id, status: 'delivered', setStatus: 'delivered', callbackUrl: null }, { projectId: project.id, delayMs: ms });
    return { kind: 'accepted', decision, runId, message: m };
  }
  return { kind: 'accepted', decision, runId, message: await capture('delivered', null) };
}

const ERR: Record<SendError, string> = { reject: 'Rejected', blocked: 'Blocked', rate_limit: 'Rate limited', down: 'Provider down', opt_out: 'Opted out (DND)' };

async function relayEmail(hub: Hub, d: CodeDelivery): Promise<string | null> {
  if (!hub.mailpit) return null;
  const from = d.from && d.from.includes('@') ? d.from : 'no-reply@verify.stubyard.local';
  const raw = await new MailComposer({
    from,
    to: d.to,
    subject: d.subject ?? 'Verification code',
    text: d.text,
    messageId: `<${d.providerMessageId}@verify.stubyard.local>`,
    headers: { 'X-Tags': `project-${d.ctx.project.slug}, instance-${d.ctx.instance.slug}, verify`, 'X-Stubyard-Provider': d.ctx.instance.preset },
  })
    .compile()
    .build();
  try {
    return await hub.mailpit.relay(raw, { from, to: [d.to] });
  } catch {
    return null;
  }
}

export const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);

/** "2015-07-30T20:00:00Z" (Twilio Verify dates). */
export const isoSeconds = (iso: string | Date = new Date()) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Truthy instance config value ("true", "1", "yes", true). */
export function flag(v: unknown): boolean {
  return v === true || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v.trim()));
}
