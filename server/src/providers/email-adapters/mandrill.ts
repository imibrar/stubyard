import { createHmac, randomUUID } from 'node:crypto';
import { cfg, type Reply } from '../adapters/types.js';
import {
  EVENT_WEBHOOK_FIELD,
  bounceDetails,
  dataAsText,
  emailMeta,
  isEmail,
  renderVars,
  statusFromCode,
  subId,
  toAddresses,
  unix,
  type EmailAdapter,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

const SEND = /^\/api\/1\.\d+\/messages\/(send|send-template)(\.json)?\/?$/;
export const MANDRILL_DEFAULT_WEBHOOK_KEY = 'stubyard-webhook-key';

/** Mandrill's error body: { status: "error", code, name, message }. */
const err = (status: number, code: number, name: string, message: string): Reply => ({ status, body: { status: 'error', code, name, message } });
const validation = (message: string) => err(500, -2, 'ValidationError', message);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const mergeList = (v: unknown): Record<string, unknown> => Object.fromEntries((Array.isArray(v) ? (v as unknown[]).map(obj) : []).filter((x) => str(x.name)).map((x) => [String(x.name), x.content]));

/** Mandrill gives every recipient its own message (_id): 32 hex chars, derived so events can rebuild it. */
const rcptId = (id: string, index: number) => subId(id, index);

/** *|NAME|* (Mailchimp merge language, case-insensitive) or {{name}} (handlebars). */
function merge(s: string | null, vars: Record<string, unknown>, handlebars: boolean): string | null {
  if (!s || !Object.keys(vars).length) return s;
  if (handlebars) return renderVars(s, vars);
  const upper = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toUpperCase(), v]));
  return s.replace(/\*\|([\w:]+)\|\*/g, (all, k: string) => (upper[k.toUpperCase()] !== undefined ? String(upper[k.toUpperCase()]) : all));
}

/** Mailchimp Transactional (Mandrill) messages/send and messages/send-template, and its signed webhooks. */
export function mandrillAdapter(): EmailAdapter {
  return {
    preset: 'mandrill',
    optOutAt: 'send',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, the "key" in the request body must match (else 401 Invalid_Key, like Mandrill).', placeholder: 'md-stubyard', secret: true },
      {
        ...EVENT_WEBHOOK_FIELD,
        hint: "Your app's webhook URL. stubyard POSTs mandrill_events (send, delivered, deferral, hard_bounce, soft_bounce, reject, spam) here, signed with X-Mandrill-Signature.",
      },
      {
        key: 'webhookKey',
        label: 'Webhook key',
        hint: `X-Mandrill-Signature = base64(HMAC-SHA1(key, webhook URL + "mandrill_events" + the JSON)). Defaults to "${MANDRILL_DEFAULT_WEBHOOK_KEY}".`,
        placeholder: MANDRILL_DEFAULT_WEBHOOK_KEY,
        secret: true,
      },
    ],

    match: (req) => req.method === 'POST' && SEND.test(req.path),

    authorize(req, ctx) {
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      if (obj(req.body).key === key) return null;
      return err(401, 401, 'Invalid_Key', 'Invalid API key');
    },

    async parse(req) {
      const template = SEND.exec(req.path)![1] === 'send-template';
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body) || Array.isArray(req.body)) return { error: validation('You must specify a key value') };
      const b = req.body as Record<string, unknown>;
      if (!str(b.key)) return { error: validation('You must specify a key value') };
      if (!b.message || typeof b.message !== 'object') return { error: validation('You must specify a message value') };
      const msg = obj(b.message);
      const templateName = template ? str(b.template_name) : null;
      if (template && !templateName) return { error: validation('You must specify a template_name value') };
      const fromEmail = str(msg.from_email);
      if (!fromEmail && !template) return { error: validation('Validation error: {"message":{"from_email":"You must specify a from_email value"}}') };
      if (fromEmail && !isEmail(fromEmail)) return { error: validation(`Validation error: {"message":{"from_email":"An email address must contain a single @"}}`) };
      const rcpts = (Array.isArray(msg.to) ? (msg.to as unknown[]).map(obj) : []).map((r) => ({ email: String(r.email ?? '').trim(), name: str(r.name), type: r.type === 'cc' || r.type === 'bcc' ? r.type : 'to' }));
      if (!rcpts.length) return { error: validation('Validation error: {"message":{"to":"Please enter an array"}}') };
      const badAt = rcpts.findIndex((r) => !isEmail(r.email));
      if (badAt >= 0) return { error: validation(`Validation error: {"message":{"to":[${'{},'.repeat(badAt)}{"email":"An email address must contain a single @"}]}}`) };

      const attachments: EmailAttachment[] = [];
      for (const [kind, arr] of [['attachment', msg.attachments], ['image', msg.images]] as const)
        for (const [n, x] of (Array.isArray(arr) ? (arr as unknown[]) : []).entries()) {
          const a = obj(x);
          const name = String(a.name ?? `${kind}-${n + 1}`);
          attachments.push({ filename: name, content: Buffer.from(String(a.content ?? ''), 'base64'), contentType: str(a.type) ?? undefined, cid: kind === 'image' ? name : undefined, inline: kind === 'image' });
        }
      const handlebars = msg.merge_language === 'handlebars';
      const globalVars = mergeList(msg.global_merge_vars);
      const perRcpt = new Map((Array.isArray(msg.merge_vars) ? (msg.merge_vars as unknown[]).map(obj) : []).map((x) => [String(x.rcpt ?? '').toLowerCase(), mergeList(x.vars)]));
      const metadata = Object.fromEntries(Object.entries(obj(msg.metadata)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
      const rcptMeta = new Map((Array.isArray(msg.recipient_metadata) ? (msg.recipient_metadata as unknown[]).map(obj) : []).map((x) => [String(x.rcpt ?? '').toLowerCase(), obj(x.values)]));
      const tags = Array.isArray(msg.tags) ? (msg.tags as unknown[]).map(String) : [];
      const headers = Object.fromEntries(Object.entries(obj(msg.headers)).map(([k, v]) => [k, String(v)]));
      const from = { email: fromEmail ?? 'template-sender@stubyard.local', name: str(msg.from_name) };
      const replyTo = toAddresses(headers['Reply-To'] ?? null);

      // One email per recipient, like Mandrill (each recipient gets its own message and _id).
      const emails: ParsedEmail[] = rcpts.map((r) => {
        const vars = { ...globalVars, ...(perRcpt.get(r.email.toLowerCase()) ?? {}) };
        let text = merge(str(msg.text), vars, handlebars);
        let html = merge(str(msg.html), vars, handlebars);
        if (templateName) {
          // stubyard does not have your Mandrill templates: show the template and its content and merge vars instead.
          text = [`[Mandrill template ${templateName}]`, ...dataAsText(mergeList(b.template_content)), ...dataAsText(vars)].join('\n');
          html = null;
        }
        const me = { email: r.email, name: r.name };
        const values = rcptMeta.get(r.email.toLowerCase()) ?? {};
        return {
          from,
          to: r.type === 'to' ? [me] : [],
          cc: r.type === 'cc' ? [me] : [],
          bcc: r.type === 'bcc' ? [me] : [],
          replyTo,
          subject: merge(str(msg.subject), vars, handlebars) ?? (templateName ? `Template ${templateName}` : '(no subject)'),
          text,
          html,
          attachments,
          headers,
          tags,
          vars: { ...metadata, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) },
        };
      });
      return { emails, extra: { rcpts: rcpts.map((r) => r.email) } };
    },

    newMessageId: () => randomUUID().replace(/-/g, ''),

    messageIdHeader: (_ctx, id, index) => `<${rcptId(id, index)}@stubyard.mandrill.local>`,

    accepted: (_ctx, m) => ({
      status: 200,
      body: m.request.emails.map((e, i) => ({ email: [...e.to, ...e.cc, ...e.bcc][0]?.email ?? '', status: 'sent', _id: rcptId(m.id, i), reject_reason: null, queued_reason: null })),
    }),

    sendError(_ctx, kind, code, message, refused) {
      // Mandrill answers refused recipients with 200 and a per-recipient status, not an HTTP error.
      const each = (status: string, reason: Record<string, string>) => ({ status: 200, body: (refused?.length ? refused : ['']).map((email) => ({ email, status, _id: randomUUID().replace(/-/g, ''), ...reason })) });
      const known = ['hard-bounce', 'soft-bounce', 'spam', 'unsub', 'custom', 'invalid-sender', 'invalid', 'test-mode-limit', 'unsigned', 'rule'];
      const reason = code && known.includes(code.trim()) ? code.trim() : null;
      switch (kind) {
        case 'down':
          return err(statusFromCode(code, 500), -1, 'GeneralError', message ?? 'An unexpected error occurred processing the request. Mandrill developers have been notified.');
        case 'rate_limit':
          // Over the hourly quota Mandrill queues the message instead of failing the call.
          return each('queued', { queued_reason: 'hourly-quota-exhausted' });
        case 'opt_out':
          return each('rejected', { reject_reason: reason ?? 'unsub' });
        case 'blocked':
          return each('rejected', { reject_reason: reason ?? 'custom' });
        default:
          return each('rejected', { reject_reason: reason ?? 'hard-bounce' });
      }
    },

    notFound: (req) => err(404, -1, 'Unknown_Method', `Unknown method "${req.path.replace(/^\/api\/1\.\d+\//, '').replace(/\.json$/, '')}"`),

    event(ctx, m, ev, url) {
      const meta = emailMeta(m);
      const id = m.providerMessageId ? rcptId(m.providerMessageId, meta.emailIndex) : m.id;
      const ts = unix();
      const msg: Record<string, unknown> = {
        ts: unix(new Date(m.createdAt)),
        _id: id,
        state: 'sent',
        subject: m.subject ?? '',
        email: m.to,
        sender: meta.sender ?? m.from ?? '',
        tags: meta.tags,
        opens: [],
        clicks: [],
        smtp_events: [],
        resends: [],
        metadata: meta.vars,
        _version: randomUUID().replace(/-/g, '').slice(0, 22),
      };
      let event: string;
      switch (ev.type) {
        case 'processed':
          event = 'send';
          break;
        case 'delivered':
          event = 'delivered';
          msg.smtp_events = [{ ts, type: 'sent', diag: '250 2.0.0 OK stubyard', source_ip: '127.0.0.1', destination_ip: '127.0.0.1', size: (m.bodyText ?? '').length }];
          break;
        case 'deferred': {
          event = 'deferral';
          msg.state = 'deferred';
          const diag = `${ev.smtpCode ?? 421} ${ev.status ?? '4.7.1'} ${ev.reason ?? 'Try again later'}`;
          msg.smtp_events = [{ ts, type: 'deferred', diag, source_ip: '127.0.0.1', destination_ip: '127.0.0.1', size: 0 }];
          break;
        }
        case 'bounce': {
          const d = bounceDetails(null, null, { smtpCode: ev.smtpCode ?? 550, status: ev.status ?? '5.1.1', reason: ev.reason ?? 'User unknown' });
          const soft = ev.bounceType === 'soft';
          event = soft ? 'soft_bounce' : 'hard_bounce';
          Object.assign(msg, { state: soft ? 'soft-bounced' : 'bounced', bounce_description: soft ? 'mailbox_full' : ev.bounceType === 'blocked' ? 'policy_related' : 'bad_mailbox', diag: `smtp;${d.smtpCode} ${d.status} ${d.reason}` });
          break;
        }
        case 'dropped':
          event = 'reject';
          Object.assign(msg, { state: 'rejected', reject: { reason: ev.dropReason === 'unsubscribe' ? 'unsub' : 'hard-bounce', detail: ev.reason ?? '' } });
          break;
        case 'complaint':
          event = 'spam';
          msg.state = 'spam';
          break;
      }
      const events = JSON.stringify([{ event, msg, _id: id, ts }]);
      const key = cfg(ctx, 'webhookKey') ?? MANDRILL_DEFAULT_WEBHOOK_KEY;
      return {
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mandrill-Webhook/1.0', 'x-mandrill-signature': mandrillSignature(key, url, { mandrill_events: events }) },
        body: new URLSearchParams({ mandrill_events: events }).toString(),
        name: event,
      };
    },
  };
}

/** base64(HMAC-SHA1(key, url + each POST key and value, keys sorted)). */
export function mandrillSignature(key: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac('sha1', key).update(data).digest('base64');
}
