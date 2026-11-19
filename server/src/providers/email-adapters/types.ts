import addressparser from 'nodemailer/lib/addressparser';
import type { Message } from '../../repos/messages.js';
import type { ConfigField, Ctx, MockRequest, OutboundCall, Reply, SendError } from '../adapters/types.js';

export interface EmailAddress {
  email: string;
  name?: string | null;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Content-ID for inline images. */
  cid?: string;
  inline?: boolean;
}

/** One email as the provider understood it (SendGrid: one per personalization). */
export interface ParsedEmail {
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  subject: string;
  text: string | null;
  html: string | null;
  attachments: EmailAttachment[];
  headers: Record<string, string>;
  /** Categories / o:tag / EmailTags. */
  tags: string[];
  /** custom_args / v: variables / EmailTags as key → value: echoed in events. */
  vars: Record<string, string>;
  /** Ready-made MIME (SES Raw, Mailgun messages.mime): relayed as is. */
  raw?: Buffer | null;
}

export interface EmailSendRequest {
  emails: ParsedEmail[];
  /** SendGrid sandbox_mode / Mailgun o:testmode: validated and answered, never delivered. */
  testMode?: boolean;
  /** Provider-specific values (e.g. Mailgun domain). */
  extra?: Record<string, unknown>;
}

/** Normalised email events; adapters translate them to the provider's webhook format. */
export type EmailEventType = 'processed' | 'delivered' | 'deferred' | 'bounce' | 'dropped' | 'complaint';

export interface EmailEvent {
  type: EmailEventType;
  /** bounce: hard (unknown mailbox), soft (mailbox full, given up), blocked (policy/reputation). */
  bounceType?: 'hard' | 'soft' | 'blocked';
  /** SMTP reply code, e.g. 550. */
  smtpCode?: number;
  /** Enhanced status code, e.g. "5.1.1". */
  status?: string;
  reason?: string;
  /** dropped: why (suppressed bounce, unsubscribed…). */
  dropReason?: 'bounce' | 'unsubscribe' | 'other';
  attempt?: number;
}

/** What devhub calls the event in reports and the viewer. */
export const EVENT_STATUS: Record<EmailEventType, string> = {
  processed: 'processed',
  delivered: 'delivered',
  deferred: 'deferred',
  bounce: 'bounced',
  dropped: 'dropped',
  complaint: 'complained',
};

export type EmailRequest = MockRequest & { rawBody?: Buffer | null; bodyError?: string | null };

/** Speaks one email API: request format, responses, errors and event webhooks. */
export interface EmailAdapter {
  preset: string;
  configFields: ConfigField[];
  /** Marketing opt-out: the real provider answers with an error (send) or drops the email and reports it (event). */
  optOutAt: 'send' | 'event';
  /** Is this the provider's send endpoint? */
  match(req: EmailRequest, ctx: Ctx): boolean;
  /** API key check (only when an API key is configured). Returns the error reply or null. */
  authorize?(req: EmailRequest, ctx: Ctx): Reply | null;
  parse(req: EmailRequest, ctx: Ctx): Promise<EmailSendRequest | { error: Reply }>;
  newMessageId(ctx: Ctx, r: EmailSendRequest): string;
  /** RFC 5322 Message-ID for email number `index` of the request. */
  messageIdHeader(ctx: Ctx, id: string, index: number, r: EmailSendRequest): string;
  accepted(ctx: Ctx, m: { id: string; request: EmailSendRequest }): Reply;
  sendError(ctx: Ctx, kind: SendError, code: string | null, message: string | null): Reply;
  notFound(req: EmailRequest): Reply;
  /** Event webhook for one message, or null when the provider does not report this event. */
  event(ctx: Ctx, m: Message, ev: EmailEvent, url: string): (OutboundCall & { name: string }) | null;
}

export const EVENT_WEBHOOK_FIELD: ConfigField = {
  key: 'eventWebhookUrl',
  label: 'Event webhook URL',
  hint: "Your app's webhook for delivery events (delivered, bounce, complaint…). devhub POSTs them here in the provider's format.",
  placeholder: 'http://host.docker.internal:3000/webhooks/email/events',
};

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function isEmail(s: string | null | undefined): boolean {
  return !!s && EMAIL_RE.test(s.trim());
}

/** "A <a@x>, b@y" / ["a@x", {email,name}] / {email} → addresses (invalid ones keep their raw text in email). */
export function toAddresses(v: unknown): EmailAddress[] {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.flatMap(toAddresses);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const email = o.email ?? o.address ?? o.Email ?? o.Address;
    if (email === undefined || email === null) return [];
    return [{ email: String(email).trim(), name: o.name !== undefined && o.name !== null ? String(o.name) : null }];
  }
  const s = String(v);
  const parsed = addressparser(s, { flatten: true }).filter((a) => a.address);
  if (!parsed.length) return [{ email: s.trim(), name: null }];
  return parsed.map((a) => ({ email: a.address.trim(), name: a.name || null }));
}

export function formatAddress(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/"/g, "'")}" <${a.email}>` : a.email;
}

export function unix(d = new Date()): number {
  return Math.floor(d.getTime() / 1000);
}

/** Replace {{var}} / {{{var}}} / {{ var.path }} with values from data (Handlebars-ish, no logic). */
export function renderVars(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (all, key: string) => {
    let cur: unknown = data;
    for (const k of key.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return all;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur === undefined || cur === null ? '' : typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
  });
}

/** Template data as readable text lines (so OTPs and links in it are extracted). */
export function dataAsText(data: unknown, prefix = ''): string[] {
  if (data === null || data === undefined) return [];
  if (typeof data !== 'object') return [`${prefix}: ${String(data)}`];
  return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? dataAsText(v, prefix ? `${prefix}.${k}` : k) : [`${prefix ? `${prefix}.${k}` : k}: ${String(v)}`]));
}

/** HTTP status from a rule's error code when it is one (e.g. "403"). */
export function statusFromCode(code: string | null, fallback: number): number {
  return code && /^[45]\d\d$/.test(code.trim()) ? Number(code.trim()) : fallback;
}

/** Rule error code/message → SMTP code, enhanced status and text for bounce events. */
export function bounceDetails(code: string | null, message: string | null, defaults: { smtpCode: number; status: string; reason: string }) {
  const c = code?.trim() ?? '';
  return {
    smtpCode: /^[245]\d\d$/.test(c) ? Number(c) : defaults.smtpCode,
    status: /^[245]\.\d{1,3}\.\d{1,3}$/.test(c) ? c : defaults.status,
    reason: message ?? defaults.reason,
  };
}

export function headerValue(req: MockRequest, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  return v === undefined ? null : Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Metadata devhub keeps on email API messages (used to build events). */
export interface EmailApiMeta {
  preset: string;
  sender: string | null;
  recipients: string[];
  tags: string[];
  vars: Record<string, string>;
  recipientIndex: number;
  emailIndex: number;
  extra?: Record<string, unknown>;
}

export function emailMeta(m: Message): EmailApiMeta {
  const e = (m.metadata.emailApi ?? {}) as Partial<EmailApiMeta>;
  return {
    preset: e.preset ?? '',
    sender: e.sender ?? m.from,
    recipients: e.recipients ?? [m.to],
    tags: e.tags ?? [],
    vars: e.vars ?? {},
    recipientIndex: e.recipientIndex ?? 0,
    emailIndex: e.emailIndex ?? 0,
    extra: e.extra,
  };
}
