import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { Hub } from '../hub.js';
import type { ConfigField, OutboundCall } from '../providers/adapters/types.js';
import type { Message } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import type { TestUser } from '../repos/users.js';
import { sendOutbound } from '../traffic/outbound.js';
import { HttpError, normalizeEmail } from '../util.js';
import { htmlToText } from './extract.js';

/**
 * Inbound email: a test user replies by email. stubyard builds the reply (threaded with In-Reply-To / References),
 * stores it in the user's timeline (and Mailpit) and POSTs it to the email instance's `inboundUrl` in the provider's
 * inbound format: SendGrid Inbound Parse (parsed or raw), Mailgun routes (signed), Amazon SES receipt (SNS), or JSON.
 */

export type InboundFormat = 'sendgrid' | 'sendgrid-raw' | 'mailgun' | 'ses' | 'json';

export const INBOUND_EMAIL_FIELDS: ConfigField[] = [
  {
    key: 'inboundUrl',
    label: 'Inbound email URL',
    hint: 'Where stubyard POSTs email replies from test users (SendGrid Inbound Parse / Mailgun route / SES receipt / JSON).',
    placeholder: 'http://host.docker.internal:3000/webhooks/email/inbound',
  },
  { key: 'inboundAddress', label: 'Inbound address', hint: 'The address replies go to when the user replies to nothing in particular (default: the sender of the last email).', placeholder: 'reply@parse.example.com' },
];

const FORMAT_FIELD: Record<string, ConfigField> = {
  sendgrid: { key: 'inboundFormat', label: 'Inbound Parse format', hint: '"parsed" (default: text, html, headers… fields) or "raw" (the full MIME message in "email", like "POST the raw, full MIME message").', placeholder: 'parsed' },
  smtp: { key: 'inboundFormat', label: 'Inbound format', hint: '"json" (default), "sendgrid" (Inbound Parse, parsed) or "sendgrid-raw".', placeholder: 'json' },
  'generic-email': {
    key: 'inboundTemplate',
    label: 'Inbound JSON template',
    hint: 'Optional. Variables: {{from}} {{fromName}} {{to}} {{subject}} {{text}} {{html}} {{messageId}} {{inReplyTo}} {{references}} {{receivedAt}} (JSON-escaped).',
    multiline: true,
    placeholder: '{"from":"{{from}}","subject":"{{subject}}","text":"{{text}}"}',
  },
};

/** Inbound config fields of an email preset (shown in the dashboard). */
export function inboundEmailFields(preset: string): ConfigField[] {
  return [...INBOUND_EMAIL_FIELDS, ...(FORMAT_FIELD[preset] ? [FORMAT_FIELD[preset]] : [])];
}

export function inboundFormat(instance: ProviderInstance): InboundFormat {
  const f = String(instance.config.inboundFormat ?? '').toLowerCase().trim();
  switch (instance.preset) {
    case 'sendgrid':
      return f === 'raw' ? 'sendgrid-raw' : 'sendgrid';
    case 'mailgun':
      return 'mailgun';
    case 'ses':
      return 'ses';
    case 'smtp':
      return f === 'sendgrid' || f === 'parsed' ? 'sendgrid' : f === 'sendgrid-raw' || f === 'raw' ? 'sendgrid-raw' : 'json';
    default:
      return 'json';
  }
}

/** A file attached to a test user's email reply. */
export interface ReplyAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** Most files / total decoded bytes in one reply (the dashboard and API share the limit). */
export const MAX_REPLY_ATTACHMENTS = 10;
export const MAX_REPLY_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Reply attachments from the API: [{ filename, contentType?, contentBase64 }] → decoded files.
 * 400 on a malformed entry, 413 over 10 files or 5 MB in total.
 */
export function parseReplyAttachments(v: unknown): ReplyAttachment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'attachments must be an array of { filename, contentType, contentBase64 }');
  if (v.length > MAX_REPLY_ATTACHMENTS) throw new HttpError(413, `At most ${MAX_REPLY_ATTACHMENTS} attachments per reply`);
  let total = 0;
  return v.map((a, i) => {
    if (!a || typeof a !== 'object') throw new HttpError(400, `attachments[${i}] must be an object`);
    const o = a as Record<string, unknown>;
    const filename = String(o.filename ?? o.name ?? '')
      .replace(/[\\/\r\n"]+/g, '_')
      .trim()
      .slice(0, 200);
    if (!filename) throw new HttpError(400, `attachments[${i}].filename is required`);
    const contentType = String(o.contentType ?? o.type ?? 'application/octet-stream').trim().toLowerCase();
    if (!/^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(contentType)) throw new HttpError(400, `attachments[${i}].contentType "${contentType}" is not a MIME type`);
    const b64 = String(o.contentBase64 ?? o.content ?? '').replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new HttpError(400, `attachments[${i}].contentBase64 is not valid base64`);
    const content = Buffer.from(b64, 'base64');
    total += content.length;
    if (total > MAX_REPLY_ATTACHMENT_BYTES) throw new HttpError(413, `Attachments are limited to ${MAX_REPLY_ATTACHMENT_BYTES / 1024 / 1024} MB per reply`);
    return { filename, contentType, content };
  });
}

interface Built {
  raw: string;
  headers: [string, string][];
  from: string;
  fromHeader: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
  date: string;
  attachments: ReplyAttachment[];
}

/** An inbound call whose body may be binary (multipart with files). */
type InboundCall = Omit<OutboundCall, 'body'> & { body: string | Buffer };

export class EmailInbound {
  constructor(private hub: Hub) {}

  async reply(
    project: Project,
    user: TestUser,
    input: { text: string; instance?: string | null; subject?: string | null; html?: string | null; inReplyTo?: string | null; to?: string | null; attachments?: ReplyAttachment[] },
  ) {
    const hub = this.hub;
    if (!user.email) throw new HttpError(400, `${user.name} has no email address`);
    const instance = input.instance ? hub.providers.require(project.id, input.instance) : hub.providers.defaultFor(project.id, 'email');
    if (!instance || instance.channel !== 'email') throw new HttpError(400, `Project "${project.slug}" has no email provider instance${input.instance ? ` "${input.instance}"` : ''}.`);
    let original: Message | null = null;
    if (input.inReplyTo) {
      original = hub.messages.get(input.inReplyTo) ?? hub.messages.list(project.id, { q: input.inReplyTo, channel: 'email', limit: 1 }).find((m) => m.messageIdHeader === input.inReplyTo) ?? null;
      if (!original || original.projectId !== project.id || original.channel !== 'email') throw new HttpError(404, 'inReplyTo: email message not found (use a stubyard message id)');
    }
    const lastOut = original ?? hub.messages.list(project.id, { testUserId: user.id, channel: 'email', limit: 20 }).find((m) => m.direction === 'outbound') ?? null;
    const to = normalizeEmail(input.to) ?? (original?.from ? normalizeEmail(original.from) : null) ?? (typeof instance.config.inboundAddress === 'string' && instance.config.inboundAddress ? instance.config.inboundAddress : null) ?? (lastOut?.from ? normalizeEmail(lastOut.from) : null) ?? `inbound@${project.slug}.test`;
    const attachments = input.attachments ?? [];
    const text = (input.text ?? '').trim() || (input.html ? htmlToText(input.html) : '') || (attachments.length ? `(${attachments.map((a) => a.filename).join(', ')})` : '');
    if (!text) throw new HttpError(400, 'Reply text is required');
    const baseSubject = original?.subject ?? null;
    const subject = input.subject?.trim() || (baseSubject ? (/^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`) : '(no subject)');
    const built = await build({ user, to, subject, text, html: input.html ?? null, original, project, instance, attachments });
    let mailpitId: string | null = null;
    if (hub.mailpit) {
      try {
        mailpitId = await hub.mailpit.relay(Buffer.from(built.raw), { from: user.email, to: [to] });
      } catch {
        mailpitId = null;
      }
    }
    const url = typeof instance.config.inboundUrl === 'string' && instance.config.inboundUrl ? instance.config.inboundUrl : null;
    const format = inboundFormat(instance);
    let msg = hub.messageService.capture({
      project,
      instance,
      channel: 'email',
      direction: 'inbound',
      testUserId: user.id,
      from: user.email,
      to,
      subject,
      text,
      html: input.html ?? null,
      mailpitId,
      attachments: attachments.length,
      messageIdHeader: built.messageId,
      status: url ? 'sending' : 'received',
      statusDetail: url ? null : 'No inbound URL configured on this email provider instance, so your app was not called',
      logId: null,
      duplicateWindowSeconds: 0,
      metadata: {
        preset: instance.preset,
        inbound: { format, inReplyTo: original?.id ?? null, inReplyToHeader: built.inReplyTo, references: built.references },
        ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })) } : {}),
      },
    });
    if (!url) return { message: msg, webhook: null };
    const call = await payload(format, built, instance, url, user);
    const res = await sendOutbound(hub.traffic, {
      projectId: project.id,
      runId: msg.runId,
      method: 'POST',
      url: call.url,
      headers: call.headers,
      body: call.body,
      purpose: `inbound email from ${user.name} (${format})`,
      resolved: { messageId: msg.id, instance: instance.slug, user: user.name, format },
    });
    msg = hub.messages.updateStatus(msg.id, {
      status: res.ok ? 'received' : 'failed',
      statusDetail: res.ok ? null : `Your app did not accept the inbound email: ${res.error ?? `HTTP ${res.status}`}`,
    })!;
    hub.bus.publish({ type: 'message.updated', projectId: project.id, data: msg });
    return { message: msg, webhook: { ok: res.ok, status: res.status, error: res.error, logId: res.logId } };
  }
}

async function build(i: { user: TestUser; to: string; subject: string; text: string; html: string | null; original: Message | null; project: Project; instance: ProviderInstance; attachments: ReplyAttachment[] }): Promise<Built> {
  const domain = i.user.email!.split('@')[1] ?? 'stubyard.local';
  const messageId = `<${randomBytes(12).toString('hex')}@${domain}>`;
  const parentId = i.original?.messageIdHeader ?? null;
  const parentRefs = typeof (i.original?.metadata.inbound as { references?: string } | undefined)?.references === 'string' ? (i.original!.metadata.inbound as { references: string }).references : null;
  const references = parentId ? [parentRefs, parentId].filter(Boolean).join(' ') : null;
  const fromHeader = `"${i.user.name.replace(/"/g, "'")}" <${i.user.email}>`;
  const date = new Date();
  const raw = (
    await new MailComposer({
      from: fromHeader,
      to: i.to,
      subject: i.subject,
      text: i.text,
      html: i.html ?? undefined,
      messageId,
      date,
      inReplyTo: parentId ?? undefined,
      references: references ?? undefined,
      attachments: i.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
      headers: { 'X-Tags': `project-${i.project.slug}, instance-${i.instance.slug}, inbound`, 'X-Stubyard-Inbound': 'reply' },
    })
      .compile()
      .build()
  ).toString('utf8');
  return { raw, headers: headerList(raw), from: i.user.email!, fromHeader, to: i.to, subject: i.subject, text: i.text, html: i.html, messageId, inReplyTo: parentId, references, date: date.toUTCString().replace('GMT', '+0000'), attachments: i.attachments };
}

/** Header block of a MIME message as [name, value] pairs (folded lines joined). */
function headerList(raw: string): [string, string][] {
  const end = raw.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? raw.slice(0, end) : raw).replace(/\r?\n[ \t]+/g, ' ');
  return block
    .split(/\r?\n/)
    .map((l) => {
      const c = l.indexOf(':');
      return c > 0 ? ([l.slice(0, c).trim(), l.slice(c + 1).trim()] as [string, string]) : null;
    })
    .filter((x): x is [string, string] => !!x);
}

const headerBlock = (raw: string) => {
  const end = raw.search(/\r?\n\r?\n/);
  return (end >= 0 ? raw.slice(0, end) : raw) + '\n';
};

/** Reply text without the quoted part ("> …", "On … wrote:"), like Mailgun's stripped-text. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** multipart/form-data with text fields and file parts; binary-safe (a Buffer when files are present). */
async function multipart(fields: Record<string, string>, files: Record<string, ReplyAttachment> = {}): Promise<{ body: string | Buffer; contentType: string }> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([new Uint8Array(f.content)], { type: f.contentType }), f.filename);
  const r = new Request('http://stubyard.local/', { method: 'POST', body: fd });
  const contentType = r.headers.get('content-type') ?? 'multipart/form-data';
  return { body: Object.keys(files).length ? Buffer.from(await r.arrayBuffer()) : await r.text(), contentType };
}

async function payload(format: InboundFormat, b: Built, instance: ProviderInstance, url: string, user: TestUser): Promise<InboundCall> {
  const cfg = (k: string) => (typeof instance.config[k] === 'string' && instance.config[k] ? String(instance.config[k]) : null);
  const domain = b.from.split('@')[1] ?? 'stubyard.local';
  const envelope = JSON.stringify({ to: [b.to], from: b.from });
  const charsets = JSON.stringify({ to: 'UTF-8', from: 'UTF-8', subject: 'UTF-8', text: 'UTF-8', ...(b.html ? { html: 'UTF-8' } : {}) });
  const n = b.attachments.length;
  switch (format) {
    case 'sendgrid': {
      // Inbound Parse: "attachments" is the count, files are attachment1…N, "attachment-info" describes them.
      const files = Object.fromEntries(b.attachments.map((a, i) => [`attachment${i + 1}`, a]));
      const info = Object.fromEntries(b.attachments.map((a, i) => [`attachment${i + 1}`, { filename: a.filename, name: a.filename, type: a.contentType }]));
      const m = await multipart({
        headers: headerBlock(b.raw),
        dkim: `{@${domain} : pass}`,
        to: b.to,
        from: b.fromHeader,
        text: b.text,
        ...(b.html ? { html: b.html } : {}),
        sender_ip: '127.0.0.1',
        spam_report: '',
        envelope,
        attachments: String(n),
        ...(n ? { 'attachment-info': JSON.stringify(info) } : {}),
        subject: b.subject,
        spam_score: '0.0',
        charsets,
        SPF: 'pass',
      }, files);
      return { url, headers: { 'content-type': m.contentType, 'user-agent': 'Sendlib/1.0 (stubyard Inbound Parse)' }, body: m.body };
    }
    case 'sendgrid-raw': {
      const m = await multipart({ dkim: `{@${domain} : pass}`, email: b.raw, to: b.to, from: b.fromHeader, sender_ip: '127.0.0.1', spam_report: '', envelope, subject: b.subject, spam_score: '0.0', charsets, SPF: 'pass' });
      return { url, headers: { 'content-type': m.contentType, 'user-agent': 'Sendlib/1.0 (stubyard Inbound Parse)' }, body: m.body };
    }
    case 'mailgun': {
      const key = cfg('webhookSigningKey') ?? cfg('apiKey') ?? 'stubyard-signing-key';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const token = randomBytes(25).toString('hex');
      const signature = createHmac('sha256', key).update(timestamp + token).digest('hex');
      const hv = (n: string) => b.headers.find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1] ?? '';
      const fields: Record<string, string> = {
        recipient: b.to,
        sender: b.from,
        from: b.fromHeader,
        subject: b.subject,
        'body-plain': b.text,
        'stripped-text': stripQuoted(b.text),
        'stripped-signature': '',
        ...(b.html ? { 'body-html': b.html, 'stripped-html': b.html } : {}),
        'attachment-count': String(n),
        timestamp,
        token,
        signature,
        'message-headers': JSON.stringify(b.headers),
        'Message-Id': b.messageId,
        From: b.fromHeader,
        To: b.to,
        Subject: b.subject,
        Date: hv('Date') || b.date,
        'Mime-Version': hv('MIME-Version') || '1.0',
        'Content-Type': hv('Content-Type'),
        ...(b.inReplyTo ? { 'In-Reply-To': b.inReplyTo } : {}),
        ...(b.references ? { References: b.references } : {}),
      };
      if (n) {
        // With files Mailgun forwards multipart/form-data: attachment-1…N as file parts.
        const m = await multipart(fields, Object.fromEntries(b.attachments.map((a, i) => [`attachment-${i + 1}`, a])));
        return { url, headers: { 'content-type': m.contentType, 'user-agent': 'mailgun/treq-stubyard' }, body: m.body };
      }
      return { url, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'mailgun/treq-stubyard' }, body: new URLSearchParams(fields).toString() };
    }
    case 'ses': {
      const region = cfg('region') ?? 'us-east-1';
      const topicArn = cfg('inboundTopicArn') ?? cfg('topicArn') ?? `arn:aws:sns:${region}:123456789012:stubyard-${instance.slug}-inbound`;
      const now = new Date().toISOString();
      const sesId = randomBytes(16).toString('hex');
      const event = {
        notificationType: 'Received',
        mail: {
          timestamp: now,
          source: b.from,
          messageId: sesId,
          destination: [b.to],
          headersTruncated: false,
          headers: b.headers.map(([name, value]) => ({ name, value })),
          commonHeaders: { returnPath: b.from, from: [b.fromHeader], date: b.date, to: [b.to], messageId: b.messageId, subject: b.subject },
        },
        receipt: {
          timestamp: now,
          processingTimeMillis: 420,
          recipients: [b.to],
          spamVerdict: { status: 'PASS' },
          virusVerdict: { status: 'PASS' },
          spfVerdict: { status: 'PASS' },
          dkimVerdict: { status: 'PASS' },
          dmarcVerdict: { status: 'PASS' },
          action: { type: 'SNS', topicArn, encoding: 'UTF8' },
        },
        content: b.raw,
      };
      if ((cfg('rawMessageDelivery') ?? '').toLowerCase() === 'true') {
        return { url, headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-topic-arn': topicArn, 'x-amz-sns-rawdelivery': 'true' }, body: JSON.stringify(event) };
      }
      const snsId = randomUUID();
      return {
        url,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'x-amz-sns-message-type': 'Notification',
          'x-amz-sns-message-id': snsId,
          'x-amz-sns-topic-arn': topicArn,
          'user-agent': 'Amazon Simple Notification Service Agent',
        },
        body: JSON.stringify({
          Type: 'Notification',
          MessageId: snsId,
          TopicArn: topicArn,
          Subject: 'Amazon SES Email Receipt Notification',
          Message: JSON.stringify(event),
          Timestamp: now,
          SignatureVersion: '1',
          Signature: 'ZGV2aHViLXVuc2lnbmVk', // not signed: skip SNS signature checks in development
          SigningCertURL: `https://sns.${region}.amazonaws.com/SimpleNotificationService-stubyard.pem`,
          UnsubscribeURL: `https://sns.${region}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${topicArn}:${randomUUID()}`,
        }),
      };
    }
    default: {
      const data = {
        from: b.from,
        fromName: user.name,
        to: b.to,
        subject: b.subject,
        text: b.text,
        html: b.html,
        messageId: b.messageId,
        inReplyTo: b.inReplyTo,
        references: b.references,
        receivedAt: new Date().toISOString(),
        headers: Object.fromEntries(b.headers),
        attachments: b.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length, contentBase64: a.content.toString('base64') })),
      };
      const tpl = cfg('inboundTemplate');
      const body = tpl
        ? tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => {
            const v = (data as Record<string, unknown>)[k];
            if (v === undefined) return all;
            return v === null ? '' : JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v)).slice(1, -1);
          })
        : JSON.stringify(data);
      return { url, headers: { 'content-type': 'application/json' }, body };
    }
  }
}
