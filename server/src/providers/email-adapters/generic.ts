import { fillTemplate, getPath } from '../adapters/generic.js';
import { cfg, fields, randomHex, type Ctx, type Reply } from '../adapters/types.js';
import { EVENT_STATUS, EVENT_WEBHOOK_FIELD, emailMeta, isEmail, statusFromCode, toAddresses, type EmailAdapter } from './types.js';

export const GENERIC_EMAIL_DEFAULTS = {
  successStatus: '200',
  successTemplate: '{"id":"{{id}}","status":"queued","to":"{{to}}"}',
  errorTemplate: '{"error":{"code":"{{errorCode}}","message":"{{errorMessage}}"}}',
  eventTemplate: '{"id":"{{id}}","event":"{{event}}","email":"{{email}}","subject":"{{subject}}","reason":"{{reason}}","timestamp":"{{timestamp}}"}',
};

const KEYS = {
  to: ['to', 'recipient', 'recipients', 'email', 'toEmail', 'to_email'],
  cc: ['cc'],
  bcc: ['bcc'],
  from: ['from', 'sender', 'fromEmail', 'from_email'],
  subject: ['subject', 'title'],
  text: ['text', 'textBody', 'text_body', 'plain', 'body', 'content', 'message'],
  html: ['html', 'htmlBody', 'html_body'],
};

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Any HTTP email API, configured in the dashboard: field paths, response / error / event templates. */
export function genericEmailAdapter(): EmailAdapter {
  type K = keyof typeof GENERIC_EMAIL_DEFAULTS;
  const c = (ctx: Ctx, k: K) => cfg(ctx, k) ?? GENERIC_EMAIL_DEFAULTS[k];
  const error = (ctx: Ctx, status: number, code: string, message: string): Reply => ({
    status,
    body: parseBody(fillTemplate(c(ctx, 'errorTemplate'), { errorCode: code, errorMessage: message })),
  });
  const find = (f: Record<string, unknown>, ctx: Ctx, field: string, keys: string[]): unknown => {
    const configured = cfg(ctx, field);
    if (configured) return getPath(f, configured);
    for (const k of keys) if (f[k] !== undefined && f[k] !== null && f[k] !== '') return f[k];
    return undefined;
  };
  const text = (v: unknown) => (v === undefined || v === null || v === '' ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return {
    preset: 'generic-email',
    optOutAt: 'send',
    configFields: [
      { key: 'path', label: 'Send path', hint: 'Path after the instance URL, e.g. /v1/email. Empty = any path.', placeholder: '/v1/email' },
      { key: 'toField', label: '"To" field', hint: 'JSON path or form field: a string, "a@x, b@y", an array of strings or of {email,name}. Empty = to / recipient / email…', placeholder: 'to' },
      { key: 'ccField', label: '"Cc" field', placeholder: 'cc' },
      { key: 'bccField', label: '"Bcc" field', placeholder: 'bcc' },
      { key: 'fromField', label: '"From" field', placeholder: 'from' },
      { key: 'subjectField', label: 'Subject field', placeholder: 'subject' },
      { key: 'textField', label: 'Text body field', hint: 'Empty = text / body / content / message…', placeholder: 'text' },
      { key: 'htmlField', label: 'HTML body field', placeholder: 'html' },
      { key: 'successStatus', label: 'Success HTTP status', placeholder: '200' },
      { key: 'successTemplate', label: 'Success response', hint: 'Variables: {{id}} {{to}} {{from}} {{subject}} {{timestamp}}', multiline: true, placeholder: GENERIC_EMAIL_DEFAULTS.successTemplate },
      { key: 'errorTemplate', label: 'Error response', hint: 'Variables: {{errorCode}} {{errorMessage}}', multiline: true, placeholder: GENERIC_EMAIL_DEFAULTS.errorTemplate },
      {
        key: 'eventTemplate',
        label: 'Event webhook body',
        hint: '{{event}} is processed / delivered / deferred / bounced / dropped / complained. Also {{id}} {{email}} {{from}} {{subject}} {{reason}} {{bounceType}} {{timestamp}}',
        multiline: true,
        placeholder: GENERIC_EMAIL_DEFAULTS.eventTemplate,
      },
      EVENT_WEBHOOK_FIELD,
    ],

    match(req, ctx) {
      if (req.method === 'GET' || req.method === 'HEAD') return false;
      const path = cfg(ctx, 'path');
      if (!path) return true;
      const norm = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
      return norm(req.path) === norm(path);
    },

    async parse(req, ctx) {
      if (req.bodyError) return { error: error(ctx, 400, 'invalid_json', req.bodyError) };
      const f = fields(req);
      const to = toAddresses(find(f, ctx, 'toField', KEYS.to));
      if (!to.length) return { error: error(ctx, 400, 'missing_to', `No recipient found (looked for ${cfg(ctx, 'toField') ?? KEYS.to.join(', ')})`) };
      const cc = toAddresses(find(f, ctx, 'ccField', KEYS.cc));
      const bcc = toAddresses(find(f, ctx, 'bccField', KEYS.bcc));
      const invalid = [...to, ...cc, ...bcc].find((a) => !isEmail(a.email));
      if (invalid) return { error: error(ctx, 400, 'invalid_to', `Invalid recipient "${invalid.email}"`) };
      const from = toAddresses(find(f, ctx, 'fromField', KEYS.from))[0] ?? null;
      const html = text(find(f, ctx, 'htmlField', KEYS.html));
      const body = text(find(f, ctx, 'textField', KEYS.text));
      if (!body && !html) return { error: error(ctx, 400, 'missing_content', `No email body found (looked for ${cfg(ctx, 'textField') ?? KEYS.text.join(', ')} / ${cfg(ctx, 'htmlField') ?? KEYS.html.join(', ')})`) };
      return {
        emails: [
          {
            from,
            to,
            cc,
            bcc,
            replyTo: [],
            subject: text(find(f, ctx, 'subjectField', KEYS.subject)) ?? '(no subject)',
            text: body,
            html,
            attachments: [],
            headers: {},
            tags: [],
            vars: {},
          },
        ],
      };
    },

    newMessageId: () => 'msg_' + randomHex(24),

    messageIdHeader: (_ctx, id, index) => `<${id}.${index}@stubyard.local>`,

    accepted(ctx, m) {
      const e = m.request.emails[0];
      const body = fillTemplate(c(ctx, 'successTemplate'), {
        id: m.id,
        to: e?.to.map((a) => a.email).join(', '),
        from: e?.from?.email,
        subject: e?.subject,
        timestamp: new Date().toISOString(),
      });
      return { status: Number(c(ctx, 'successStatus')) || 200, body: parseBody(body) };
    },

    sendError(ctx, kind, code, message) {
      switch (kind) {
        case 'down':
          return error(ctx, statusFromCode(code, 503), code ?? 'service_unavailable', message ?? 'Service unavailable');
        case 'rate_limit':
          return error(ctx, statusFromCode(code, 429), code ?? 'rate_limited', message ?? 'Too many requests');
        case 'opt_out':
          return error(ctx, statusFromCode(code, 400), code ?? 'unsubscribed', message ?? 'Recipient unsubscribed from marketing email');
        case 'blocked':
          return error(ctx, statusFromCode(code, 400), code ?? 'blocked', message ?? 'Recipient is blocked');
        default:
          return error(ctx, statusFromCode(code, 400), code ?? 'rejected', message ?? 'Email rejected');
      }
    },

    notFound: (req) => ({ status: 404, body: { error: { code: 'not_found', message: `No send endpoint at ${req.method} ${req.path}` } } }),

    event(ctx, m, ev, url) {
      const meta = emailMeta(m);
      const name = EVENT_STATUS[ev.type];
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: fillTemplate(c(ctx, 'eventTemplate'), {
          id: m.providerMessageId,
          event: name,
          email: m.to,
          to: m.to,
          from: meta.sender ?? m.from,
          subject: m.subject,
          reason: ev.reason ? `${ev.smtpCode ?? ''} ${ev.status ?? ''} ${ev.reason}`.trim() : '',
          bounceType: ev.bounceType ?? '',
          timestamp: new Date().toISOString(),
        }),
        name,
      };
    },
  };
}
