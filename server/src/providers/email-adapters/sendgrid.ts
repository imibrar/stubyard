import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { cfg, type Ctx, type Reply } from '../adapters/types.js';
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
  type EmailAdapter,
  type EmailAddress,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

const HELP = 'http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html';

interface SgError {
  message: string;
  field: string | null;
  help: string | null;
}

const errors = (status: number, list: SgError[], headers?: Record<string, string>): Reply => ({ status, body: { errors: list }, headers });
const e = (message: string, field: string | null, anchor?: string): SgError => ({ message, field, help: anchor ? `${HELP}#${anchor}` : null });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const strMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]));

/** SendGrid v3 Mail Send (POST /v3/mail/send) and the Event Webhook. */
export function sendgridAdapter(): EmailAdapter {
  return {
    preset: 'sendgrid',
    optOutAt: 'event',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, requests must send "Authorization: Bearer <key>" (else 401, like SendGrid).', placeholder: 'SG.devhub', secret: true },
      EVENT_WEBHOOK_FIELD,
      {
        key: 'eventWebhookPrivateKey',
        label: 'Signed event webhook: private key (PEM)',
        hint: 'Optional ECDSA P-256 key. When set, events carry X-Twilio-Email-Event-Webhook-Signature / -Timestamp. Create one: openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt; verify with its public key.',
        multiline: true,
        secret: true,
      },
    ],

    match: (req) => req.method === 'POST' && /^\/v3\/mail\/send\/?$/.test(req.path),

    authorize(req, ctx) {
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      const auth = headerValue(req, 'authorization');
      if (auth === `Bearer ${key}`) return null;
      return errors(401, [{ field: null, message: 'The provided authorization grant is invalid, expired, or revoked', help: null }]);
    },

    async parse(req) {
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return { error: errors(400, [e('Bad Request', null)]) };
      const b = req.body as Record<string, unknown>;
      const errs: SgError[] = [];
      const from = toAddresses(b.from)[0] ?? null;
      if (!from) errs.push(e('The from object must be provided for every email send. It is an object that requires the email parameter, but may also contain a name parameter.', 'from.email', 'message.from'));
      else if (!isEmail(from.email)) errs.push(e('The from email does not contain a valid address.', 'from.email', 'message.from'));
      const templateId = typeof b.template_id === 'string' && b.template_id ? b.template_id : null;
      const content = Array.isArray(b.content) ? (b.content as unknown[]).map(obj) : [];
      if (!templateId && !content.length)
        errs.push(
          e(
            'Unless a valid template_id is provided, the content parameter is required. There must be at least one defined content block. We typically suggest both text/plain and text/html blocks are included, but only one block is required.',
            'content',
            'message.content',
          ),
        );
      content.forEach((c, i) => {
        if (typeof c.value !== 'string' || !c.value) errs.push(e('The content value must be a string at least one character in length.', `content.${i}.value`, 'message.content.value'));
      });
      const pers = Array.isArray(b.personalizations) ? (b.personalizations as unknown[]).map(obj) : [];
      if (!pers.length) errs.push(e('The personalizations field is required and must have at least one personalization.', 'personalizations', '-Personalizations-Errors'));
      pers.forEach((p, i) => {
        const to = toAddresses(p.to);
        if (!to.length) errs.push(e('The to array is required for all personalization objects, and must have at least one email object with a valid email address.', `personalizations.${i}.to`, 'message.personalizations.to'));
        for (const kind of ['to', 'cc', 'bcc'] as const)
          toAddresses(p[kind]).forEach((a, j) => {
            if (!isEmail(a.email)) errs.push(e('Does not contain a valid address.', `personalizations.${i}.${kind}.${j}.email`, `message.personalizations.${kind}`));
          });
        if (!templateId && !p.subject && !b.subject)
          errs.push(
            e(
              'The subject is required. You can get around this requirement if you use a template with a subject defined or if every personalization has a subject defined.',
              'subject',
              'message.subject',
            ),
          );
      });
      if (errs.length) return { error: errors(400, dedupe(errs)) };

      const attachments: EmailAttachment[] = (Array.isArray(b.attachments) ? (b.attachments as unknown[]) : []).map((x, i) => {
        const a = obj(x);
        return {
          filename: String(a.filename ?? `attachment-${i + 1}`),
          content: Buffer.from(String(a.content ?? ''), 'base64'),
          contentType: a.type ? String(a.type) : undefined,
          inline: a.disposition === 'inline',
          cid: a.content_id ? String(a.content_id) : undefined,
        };
      });
      const categories = Array.isArray(b.categories) ? (b.categories as unknown[]).map(String) : [];
      const replyTo: EmailAddress[] = [...toAddresses(b.reply_to), ...toAddresses(b.reply_to_list)];
      const text0 = content.find((c) => String(c.type ?? '').toLowerCase() === 'text/plain')?.value as string | undefined;
      const html0 = content.find((c) => String(c.type ?? '').toLowerCase() === 'text/html')?.value as string | undefined;

      const emails: ParsedEmail[] = pers.map((p) => {
        const data = obj(p.dynamic_template_data);
        const subs = strMap(p.substitutions);
        const sub = (s: string | undefined | null) => {
          if (!s) return null;
          let out = s;
          for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v);
          return Object.keys(data).length ? renderVars(out, data) : out;
        };
        let subject = sub(String(p.subject ?? b.subject ?? '')) || null;
        let text = sub(text0);
        let html = sub(html0);
        if (templateId && !text && !html) {
          // devhub does not have your SendGrid templates: show the template id and its data instead.
          text = [`[SendGrid dynamic template ${templateId}]`, ...dataAsText(data)].join('\n');
        }
        if (!subject) subject = typeof data.subject === 'string' ? data.subject : templateId ? `Template ${templateId}` : '(no subject)';
        return {
          from,
          to: toAddresses(p.to),
          cc: toAddresses(p.cc),
          bcc: toAddresses(p.bcc),
          replyTo,
          subject,
          text,
          html,
          attachments,
          headers: { ...strMap(b.headers), ...strMap(p.headers) },
          tags: categories,
          vars: { ...strMap(b.custom_args), ...strMap(p.custom_args) },
        };
      });
      const sandbox = obj(obj(obj(b.mail_settings).sandbox_mode)).enable === true;
      return { emails, testMode: sandbox };
    },

    newMessageId: () => randomBytes(16).toString('base64url').slice(0, 22),

    messageIdHeader: (_ctx, id, index) => `<${id}.${index}@devhub.sendgrid.local>`,

    accepted: (_ctx, m) => (m.request.testMode ? { status: 200, body: undefined } : { status: 202, body: undefined, headers: { 'x-message-id': m.id } }),

    sendError(_ctx, kind, code, message) {
      switch (kind) {
        case 'down':
          return errors(statusFromCode(code, 503), [{ field: null, message: message ?? 'Service Unavailable', help: null }]);
        case 'rate_limit':
          return errors(statusFromCode(code, 429), [{ field: null, message: message ?? 'too many requests', help: null }], {
            'x-ratelimit-limit': '600',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(unix() + 60),
          });
        case 'opt_out':
        case 'blocked':
          return errors(statusFromCode(code, 400), [e(message ?? 'The recipient has unsubscribed from this type of email.', 'personalizations.0.to.0.email')]);
        default:
          return errors(statusFromCode(code, 400), [e(message ?? 'Does not contain a valid address.', 'personalizations.0.to.0.email', 'message.personalizations.to')]);
      }
    },

    notFound: () => errors(404, [{ field: null, message: 'resource not found', help: null }]),

    event(ctx: Ctx, m, ev, url) {
      const meta = emailMeta(m);
      const ts = unix();
      const base: Record<string, unknown> = {
        email: m.to,
        timestamp: ts,
        'smtp-id': m.messageIdHeader,
        sg_event_id: randomBytes(16).toString('base64url').slice(0, 22),
        sg_message_id: `${m.providerMessageId}.filterdrecv-devhub-${meta.emailIndex}-${meta.recipientIndex}.0`,
        ...(meta.tags.length ? { category: meta.tags } : {}),
        ...meta.vars,
      };
      let event: string;
      const extra: Record<string, unknown> = {};
      switch (ev.type) {
        case 'processed':
          event = 'processed';
          break;
        case 'delivered':
          event = 'delivered';
          Object.assign(extra, { response: '250 2.0.0 OK devhub', ip: '127.0.0.1', tls: 1 });
          break;
        case 'deferred':
          event = 'deferred';
          Object.assign(extra, { response: `${ev.smtpCode ?? 421} ${ev.status ?? '4.7.1'} ${ev.reason ?? 'Try again later'}`, attempt: String(ev.attempt ?? 1), ip: '127.0.0.1', tls: 1 });
          break;
        case 'bounce': {
          event = 'bounce';
          const d = bounceDetails(null, null, { smtpCode: ev.smtpCode ?? 550, status: ev.status ?? '5.1.1', reason: ev.reason ?? 'User unknown' });
          Object.assign(extra, {
            type: ev.bounceType === 'blocked' || ev.bounceType === 'soft' ? 'blocked' : 'bounce',
            bounce_classification: ev.bounceType === 'blocked' ? 'Reputation' : ev.bounceType === 'soft' ? 'Mailbox Unavailable' : 'Invalid Address',
            reason: `${d.smtpCode} ${d.status} ${d.reason}`,
            status: d.status,
            ip: '127.0.0.1',
            tls: 1,
          });
          break;
        }
        case 'dropped':
          event = 'dropped';
          extra.reason = ev.reason ?? (ev.dropReason === 'unsubscribe' ? 'Unsubscribed Address' : 'Bounced Address');
          break;
        case 'complaint':
          event = 'spamreport';
          break;
      }
      const body = JSON.stringify([{ ...base, event, ...extra }]);
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'SendGrid Event API' };
      const pem = cfg(ctx, 'eventWebhookPrivateKey');
      if (pem) {
        const timestamp = String(ts);
        const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
        headers['x-twilio-email-event-webhook-timestamp'] = timestamp;
        headers['x-twilio-email-event-webhook-signature'] = sign('sha256', Buffer.from(timestamp + body), key).toString('base64');
      }
      return { url, headers, body, name: event };
    },
  };
}

function dedupe(list: SgError[]): SgError[] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = x.field + '|' + x.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
