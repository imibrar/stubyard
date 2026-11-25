import { randomInt } from 'node:crypto';
import { cfg, type Reply } from '../adapters/types.js';
import {
  EVENT_WEBHOOK_FIELD,
  bounceDetails,
  dataAsText,
  emailMeta,
  headerValue,
  isEmail,
  renderVars,
  statusFromCode,
  toAddresses,
  unix,
  webhookTarget,
  type EmailAdapter,
  type EmailAddress,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

/** Brevo's error body: { code, message }. */
const err = (status: number, code: string, message: string, headers?: Record<string, string>): Reply => ({ status, body: { code, message }, headers });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const list = (v: unknown): EmailAddress[] => (Array.isArray(v) ? v.flatMap((x) => toAddresses(obj(x))) : []);

const stamp = (d = new Date()) => d.toISOString().replace(/\D/g, '').slice(0, 12);
/** Per-email message id: <YYYYMMDDhhmm.NNNNNNNNNNN@smtp-relay.mailin.fr>; each messageVersion gets its own. */
const emailId = (id: string, index: number) => (index === 0 ? id : id.replace('@', `.${index}@`));
/** Brevo's webhook "date" is Paris local time: "YYYY-MM-DD HH:mm:ss" (stubyard uses UTC). */
const date = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Brevo transactional email API (POST /v3/smtp/email) and its transactional webhooks. */
export function brevoAdapter(): EmailAdapter {
  return {
    preset: 'brevo',
    optOutAt: 'event',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, requests must send "api-key: <key>" (else 401 unauthorized, like Brevo).', placeholder: 'xkeysib-stubyard', secret: true },
      {
        ...EVENT_WEBHOOK_FIELD,
        hint: "Your app's transactional webhook (request, delivered, deferred, soft_bounce, hard_bounce, blocked, spam). Brevo does not sign webhooks: Basic auth in the URL (https://user:pass@host/…) is sent as an Authorization header.",
      },
      { key: 'webhookBearerToken', label: 'Webhook bearer token', hint: 'Optional. Brevo\'s webhook "auth": {"type":"bearer"}: events carry "Authorization: Bearer <token>".', secret: true },
    ],

    match: (req) => req.method === 'POST' && /^\/v3\/smtp\/email\/?$/.test(req.path),

    authorize(req, ctx) {
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      if (headerValue(req, 'api-key') === key) return null;
      return err(401, 'unauthorized', 'Key not found');
    },

    async parse(req) {
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body) || Array.isArray(req.body)) return { error: err(400, 'bad_request', 'Input must be a valid JSON object') };
      const b = req.body as Record<string, unknown>;
      const templateId = b.templateId !== undefined && b.templateId !== null ? String(b.templateId) : null;
      const sender = obj(b.sender);
      const from = str(sender.email) ? { email: String(sender.email).trim(), name: str(sender.name) } : null;
      if (!from && !templateId) return { error: err(400, 'missing_parameter', 'sender is missing') };
      if (from && !isEmail(from.email)) return { error: err(400, 'invalid_parameter', 'valid sender email required') };
      const versions = Array.isArray(b.messageVersions) ? (b.messageVersions as unknown[]).map(obj) : [];
      if (!versions.length && !list(b.to).length) return { error: err(400, 'missing_parameter', 'to is missing') };
      if (!templateId && !str(b.subject) && !versions.every((v) => str(v.subject))) return { error: err(400, 'missing_parameter', 'subject is missing') };
      if (!templateId && !str(b.htmlContent) && !str(b.textContent)) return { error: err(400, 'missing_parameter', 'htmlContent is missing') };

      const attachments: EmailAttachment[] = [];
      for (const [n, x] of (Array.isArray(b.attachment) ? (b.attachment as unknown[]) : []).entries()) {
        const a = obj(x);
        if (str(a.content) && !str(a.name)) return { error: err(400, 'invalid_parameter', 'attachment name is required when content is used') };
        const name = str(a.name) ?? String(a.url ?? `attachment-${n + 1}`).split('/').pop() ?? `attachment-${n + 1}`;
        // A remote url is not fetched: stubyard attaches a note in its place.
        attachments.push({ filename: name, content: str(a.content) ? Buffer.from(String(a.content), 'base64') : Buffer.from(`Remote attachment (not fetched by stubyard): ${String(a.url ?? '')}`) });
      }
      const headers = Object.fromEntries(Object.entries(obj(b.headers)).map(([k, v]) => [k, String(v)]));
      const tags = Array.isArray(b.tags) ? (b.tags as unknown[]).map(String) : [];
      // X-Mailin-custom comes back in every webhook.
      const vars: Record<string, string> = headers['X-Mailin-custom'] ? { 'X-Mailin-custom': headers['X-Mailin-custom'] } : {};

      const build = (v: Record<string, unknown>): ParsedEmail | { error: Reply } => {
        const to = list(v.to ?? b.to);
        const cc = list(v.cc ?? b.cc);
        const bcc = list(v.bcc ?? b.bcc);
        if (!to.length) return { error: err(400, 'missing_parameter', 'to is missing') };
        for (const [k, l] of [['to', to], ['cc', cc], ['bcc', bcc]] as const) if (l.some((a) => !isEmail(a.email))) return { error: err(400, 'invalid_parameter', `email is not valid in ${k}`) };
        const params = { ...obj(b.params), ...obj(v.params) };
        const render = (s: string | null) => (s ? renderVars(s, { params, contact: {} }) : s);
        let text = render(str(v.textContent) ?? str(b.textContent));
        let html = render(str(v.htmlContent) ?? str(b.htmlContent));
        let subject = render(str(v.subject) ?? str(b.subject));
        if (templateId) {
          // stubyard does not have your Brevo templates: show the template id and its params instead.
          text = [`[Brevo template ${templateId}]`, ...dataAsText(params)].join('\n');
          html = null;
          subject ??= typeof params.subject === 'string' ? params.subject : `Template ${templateId}`;
        }
        const replyTo = toAddresses(obj(v.replyTo ?? b.replyTo));
        return { from: from ?? { email: 'template-sender@stubyard.local', name: null }, to, cc, bcc, replyTo, subject: subject ?? '(no subject)', text, html, attachments, headers, tags, vars };
      };
      const emails: ParsedEmail[] = [];
      for (const v of versions.length ? versions : [{}]) {
        const e = build(v);
        if ('error' in e) return e;
        emails.push(e);
      }
      return { emails, extra: { versions: versions.length > 0, templateId } };
    },

    newMessageId: () => `<${stamp()}.${String(randomInt(1e10, 1e11))}@smtp-relay.mailin.fr>`,

    messageIdHeader: (_ctx, id, index) => emailId(id, index),

    accepted: (_ctx, m) => (m.request.extra?.versions ? { status: 201, body: { messageIds: m.request.emails.map((_, i) => emailId(m.id, i)) } } : { status: 201, body: { messageId: m.id } }),

    sendError(_ctx, kind, code, message) {
      switch (kind) {
        case 'down':
          return err(statusFromCode(code, 503), 'internal_error', message ?? 'Service temporarily unavailable');
        case 'rate_limit':
          return err(statusFromCode(code, 429), 'too_many_requests', message ?? 'Too many requests', { 'x-sib-ratelimit-limit': '1000', 'x-sib-ratelimit-remaining': '0', 'x-sib-ratelimit-reset': '1' });
        default:
          return err(statusFromCode(code, 400), 'invalid_parameter', message ?? 'email is not valid in to');
      }
    },

    notFound: () => err(404, 'not_found', 'Invalid route'),

    event(ctx, m, ev, url) {
      const meta = emailMeta(m);
      const now = new Date();
      const msgId = (m.providerMessageId ? emailId(m.providerMessageId, meta.emailIndex) : (m.messageIdHeader ?? m.id)).replace(/^<|>$/g, '');
      const sent = new Date(m.createdAt);
      const base: Record<string, unknown> = {
        email: m.to,
        id: 1,
        date: date(now),
        ts: unix(sent),
        'message-id': msgId,
        ts_event: unix(now),
        subject: m.subject ?? '',
        ...meta.vars,
        tags: meta.tags,
        ...(meta.extra?.templateId ? { template_id: Number(meta.extra.templateId) || meta.extra.templateId } : {}),
      };
      let event: string;
      const extra: Record<string, unknown> = {};
      switch (ev.type) {
        case 'processed':
          event = 'request';
          extra.sending_ip = '127.0.0.1';
          break;
        case 'delivered':
          event = 'delivered';
          extra.sending_ip = '127.0.0.1';
          break;
        case 'deferred':
          event = 'deferred';
          Object.assign(extra, { sending_ip: '127.0.0.1', ts_epoch: now.getTime(), reason: `${ev.smtpCode ?? 421} ${ev.status ?? '4.7.1'} ${ev.reason ?? 'Try again later'}` });
          break;
        case 'bounce': {
          const d = bounceDetails(null, null, { smtpCode: ev.smtpCode ?? 550, status: ev.status ?? '5.1.1', reason: ev.reason ?? 'User unknown' });
          event = ev.bounceType === 'soft' ? 'soft_bounce' : 'hard_bounce';
          Object.assign(extra, { sending_ip: '127.0.0.1', ts_epoch: now.getTime(), reason: `${d.smtpCode} ${d.status} ${d.reason}` });
          break;
        }
        case 'dropped':
          event = 'blocked';
          Object.assign(extra, { ts_epoch: now.getTime(), reason: ev.reason ?? (ev.dropReason === 'unsubscribe' ? 'unsubscribed' : 'hard bounced previously') });
          break;
        case 'complaint':
          event = 'spam';
          break;
      }
      const target = webhookTarget(url);
      const token = cfg(ctx, 'webhookBearerToken');
      return {
        url: target.url,
        headers: { 'content-type': 'application/json', 'user-agent': 'Brevo-Webhook (stubyard)', ...target.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ event, ...base, ...extra }),
        name: event,
      };
    },
  };
}
