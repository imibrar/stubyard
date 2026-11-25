import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cfg, type Reply } from '../adapters/types.js';
import {
  EVENT_WEBHOOK_FIELD,
  asUuid,
  bounceDetails,
  dataAsText,
  emailMeta,
  headerValue,
  isEmail,
  statusFromCode,
  subId,
  toAddresses,
  unix,
  type EmailAdapter,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

const SEND = /^\/emails(\/batch)?\/?$/;
/** Used when no webhook secret is configured, so apps can still verify (svix needs a whsec_ secret). */
export const RESEND_DEFAULT_WEBHOOK_SECRET = 'whsec_' + Buffer.from('stubyard-resend-webhook-secret').toString('base64');

/** Resend's error body: { statusCode, name, message }. */
const err = (statusCode: number, name: string, message: string, headers?: Record<string, string>): Reply => ({ status: statusCode, body: { statusCode, name, message }, headers });
const FORMAT = 'The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.';

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Per-email id: the first email of a request keeps the request id (batch: one id per email). */
const emailId = (id: string, index: number) => (index === 0 ? id : asUuid(subId(id, index)));

function parseOne(b: Record<string, unknown>, i: number | null): ParsedEmail | { error: Reply } {
  const at = (field: string) => (i === null ? `\`${field}\`` : `\`${field}\` (email ${i})`);
  if (b.from === undefined || b.from === null || b.from === '') return { error: err(422, 'missing_required_field', `Missing ${at('from')} field.`) };
  if (b.to === undefined || b.to === null || (Array.isArray(b.to) && !b.to.length) || b.to === '') return { error: err(422, 'missing_required_field', `Missing ${at('to')} field.`) };
  if (!str(b.subject)) return { error: err(422, 'missing_required_field', `Missing ${at('subject')} field.`) };
  const from = toAddresses(b.from)[0] ?? null;
  if (!from || !isEmail(from.email)) return { error: err(422, 'validation_error', `Invalid ${at('from')} field. ${FORMAT}`) };
  const to = toAddresses(b.to);
  const cc = toAddresses(b.cc);
  const bcc = toAddresses(b.bcc);
  for (const [k, list] of [['to', to], ['cc', cc], ['bcc', bcc]] as const) if (list.some((a) => !isEmail(a.email))) return { error: err(422, 'validation_error', `Invalid ${at(k)} field. ${FORMAT}`) };
  if (to.length > 50) return { error: err(422, 'validation_error', `Too many recipients in ${at('to')}: the maximum is 50.`) };

  const template = obj(b.template);
  const templateId = str(template.id);
  if (templateId && (b.html || b.text)) return { error: err(422, 'validation_error', 'You cannot send `html` or `text` together with `template`.') };
  const vars = obj(template.variables);
  let text = str(b.text);
  let html = str(b.html);
  // stubyard does not have your Resend templates: show the template id and its variables instead.
  if (templateId) text = [`[Resend template ${templateId}]`, ...dataAsText(vars)].join('\n');

  const attachments: EmailAttachment[] = (Array.isArray(b.attachments) ? (b.attachments as unknown[]) : []).map((x, n) => {
    const a = obj(x);
    const content = a.content;
    const cid = str(a.content_id) ?? str(a.contentId);
    return {
      filename: String(a.filename ?? `attachment-${n + 1}`),
      // Buffers reach the API JSON-encoded ({type:'Buffer',data:[…]}) or as base64; a remote `path` is not fetched.
      content: typeof content === 'string' ? Buffer.from(content, 'base64') : Array.isArray(obj(content).data) ? Buffer.from(obj(content).data as number[]) : Buffer.from(a.path ? `Remote attachment (not fetched by stubyard): ${String(a.path)}` : ''),
      contentType: str(a.content_type) ?? str(a.contentType) ?? undefined,
      cid: cid ?? undefined,
      inline: !!cid,
    };
  });
  const tagList = Array.isArray(b.tags) ? (b.tags as unknown[]).map(obj).filter((t) => str(t.name)) : [];
  const tagMap = Object.fromEntries(tagList.map((t) => [String(t.name), String(t.value ?? '')]));
  const headers = Object.fromEntries(Object.entries(obj(b.headers)).map(([k, v]) => [k, String(v)]));
  return {
    from,
    to,
    cc,
    bcc,
    replyTo: toAddresses(b.reply_to ?? b.replyTo),
    subject: String(b.subject),
    text,
    html,
    attachments,
    headers,
    tags: Object.entries(tagMap).map(([k, v]) => `${k}:${v}`),
    vars: tagMap,
  };
}

/** Resend Emails API (POST /emails, POST /emails/batch) and its Svix-signed webhooks. */
export function resendAdapter(): EmailAdapter {
  return {
    preset: 'resend',
    optOutAt: 'event',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, requests must send "Authorization: Bearer <key>" (else 401 "API key is invalid", like Resend).', placeholder: 're_stubyard', secret: true },
      EVENT_WEBHOOK_FIELD,
      {
        key: 'webhookSecret',
        label: 'Webhook signing secret',
        hint: `Events carry svix-id / svix-timestamp / svix-signature, verifiable with resend.webhooks.verify() or the svix library. Defaults to ${RESEND_DEFAULT_WEBHOOK_SECRET}.`,
        placeholder: RESEND_DEFAULT_WEBHOOK_SECRET,
        secret: true,
      },
    ],

    match: (req) => req.method === 'POST' && SEND.test(req.path),

    authorize(req, ctx) {
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      const auth = headerValue(req, 'authorization');
      if (!auth) return err(401, 'missing_api_key', 'Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY');
      if (auth === `Bearer ${key}`) return null;
      return err(401, 'validation_error', 'API key is invalid');
    },

    async parse(req) {
      const batch = !!SEND.exec(req.path)![1];
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return { error: err(422, 'validation_error', 'Invalid JSON body.') };
      if (batch) {
        if (!Array.isArray(req.body) || !req.body.length) return { error: err(422, 'validation_error', 'The batch body must be an array of 1 to 100 emails.') };
        if (req.body.length > 100) return { error: err(422, 'validation_error', 'Too many emails in the batch: the maximum is 100.') };
        const emails: ParsedEmail[] = [];
        for (const [i, x] of (req.body as unknown[]).entries()) {
          const e = obj(x);
          if (e.attachments) return { error: err(422, 'validation_error', 'The `attachments` field is not supported for batch emails.') };
          const p = parseOne(e, i);
          if ('error' in p) return p;
          emails.push(p);
        }
        return { emails, extra: { batch: true } };
      }
      if (Array.isArray(req.body)) return { error: err(422, 'validation_error', 'Expected a single email object (use POST /emails/batch for an array).') };
      const p = parseOne(req.body as Record<string, unknown>, null);
      return 'error' in p ? p : { emails: [p] };
    },

    newMessageId: () => randomUUID(),

    messageIdHeader: (_ctx, id, index) => `<${emailId(id, index)}@stubyard.resend.local>`,

    accepted: (_ctx, m) => (m.request.extra?.batch ? { status: 200, body: { data: m.request.emails.map((_, i) => ({ id: emailId(m.id, i) })) } } : { status: 200, body: { id: m.id } }),

    sendError(_ctx, kind, code, message) {
      switch (kind) {
        case 'down': {
          const status = statusFromCode(code, 503);
          return status === 503 ? err(503, 'service_unavailable', message ?? 'API is temporarily unavailable.') : err(status, 'application_error', message ?? 'An unexpected error occurred.');
        }
        case 'rate_limit':
          return err(statusFromCode(code, 429), 'rate_limit_exceeded', message ?? 'Too many requests. You can only make 10 requests per second. See rate limit response headers for more information.', {
            'ratelimit-limit': '10',
            'ratelimit-remaining': '0',
            'ratelimit-reset': '1',
            'retry-after': '1',
          });
        default:
          return err(statusFromCode(code, 422), 'validation_error', message ?? `Invalid \`to\` field. ${FORMAT}`);
      }
    },

    notFound: () => err(404, 'not_found', 'The requested endpoint does not exist.'),

    event(ctx, m, ev, url) {
      const meta = emailMeta(m);
      const id = m.providerMessageId ? emailId(m.providerMessageId, meta.emailIndex) : m.id;
      const now = new Date();
      const data: Record<string, unknown> = {
        created_at: m.createdAt,
        email_id: id,
        from: meta.sender ?? m.from ?? '',
        to: meta.recipients,
        subject: m.subject ?? '',
        ...(Object.keys(meta.vars).length ? { tags: meta.vars } : {}),
      };
      let type: string;
      switch (ev.type) {
        case 'processed':
          type = 'email.sent';
          break;
        case 'delivered':
          type = 'email.delivered';
          break;
        case 'deferred':
          type = 'email.delivery_delayed';
          break;
        case 'bounce': {
          type = 'email.bounced';
          const d = bounceDetails(null, null, { smtpCode: ev.smtpCode ?? 550, status: ev.status ?? '5.1.1', reason: ev.reason ?? 'User unknown' });
          data.bounce =
            ev.bounceType === 'soft'
              ? { type: 'Transient', subType: 'MailboxFull', message: `${d.smtpCode} ${d.status} ${d.reason}` }
              : { type: 'Permanent', subType: 'General', message: `${d.smtpCode} ${d.status} ${d.reason}` };
          break;
        }
        case 'dropped':
          type = 'email.suppressed';
          data.suppressed = {
            type: ev.dropReason === 'unsubscribe' ? 'Unsubscribed' : 'Bounced',
            message: ev.reason ?? (ev.dropReason === 'unsubscribe' ? 'The recipient unsubscribed.' : "The recipient's email address is on the suppression list because it has a recent history of producing hard bounces."),
          };
          break;
        case 'complaint':
          type = 'email.complained';
          break;
      }
      const body = JSON.stringify({ type, created_at: now.toISOString(), data });
      const svixId = 'msg_' + randomBytes(18).toString('base64url');
      const ts = String(unix(now));
      const secret = cfg(ctx, 'webhookSecret') ?? RESEND_DEFAULT_WEBHOOK_SECRET;
      return {
        url,
        headers: { 'content-type': 'application/json', 'user-agent': 'Svix-Webhooks/1.0 (stubyard)', 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': svixSignature(secret, svixId, ts, body) },
        body,
        name: type,
      };
    },
  };
}

/** Svix scheme: v1,base64(HMAC-SHA256(base64-decoded secret after "whsec_", "<id>.<timestamp>.<body>")). */
export function svixSignature(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}
