import { createHmac, randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { htmlToText } from '../../messages/extract.js';
import { cfg, randomHex, type Reply } from '../adapters/types.js';
import {
  EVENT_WEBHOOK_FIELD,
  dataAsText,
  emailMeta,
  headerValue,
  isEmail,
  renderVars,
  statusFromCode,
  toAddresses,
  type EmailAdapter,
  type EmailAttachment,
  type EmailRequest,
  type ParsedEmail,
} from './types.js';

const SEND = /^\/v3\/([^/]+)\/messages(\.mime)?\/?$/;

const msg = (status: number, message: string): Reply => ({ status, body: { message } });

type FormValue = string | { filename: string; type: string; data: Buffer };

/** Mailgun sends multipart/form-data (mailgun.js, most SDKs) or urlencoded forms. */
async function readForm(req: EmailRequest): Promise<Map<string, FormValue[]>> {
  const out = new Map<string, FormValue[]>();
  const add = (k: string, v: FormValue) => out.set(k, [...(out.get(k) ?? []), v]);
  const ct = String(headerValue(req, 'content-type') ?? '');
  const raw = Buffer.isBuffer(req.body) ? req.body : req.rawBody;
  if (/multipart\/form-data/i.test(ct) && raw) {
    const fd = await new Response(new Uint8Array(raw), { headers: { 'content-type': ct } }).formData();
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') add(k, v);
      else add(k, { filename: v.name || 'attachment', type: v.type || 'application/octet-stream', data: Buffer.from(await v.arrayBuffer()) });
    }
  } else {
    const fields = { ...req.query, ...(req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as Record<string, unknown>) : {}) };
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) add(k, String(x));
  }
  return out;
}

const strings = (f: Map<string, FormValue[]>, k: string): string[] => (f.get(k) ?? []).filter((v): v is string => typeof v === 'string');
const first = (f: Map<string, FormValue[]>, k: string): string | null => strings(f, k).find((s) => s !== '') ?? null;

function parseJsonObject(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const stamp = (d = new Date()) => d.toISOString().replace(/\D/g, '').slice(0, 14);

/** Mailgun Messages API (POST /v3/<domain>/messages) and its webhooks. */
export function mailgunAdapter(): EmailAdapter {
  return {
    preset: 'mailgun',
    optOutAt: 'event',
    configFields: [
      { key: 'domain', label: 'Sending domain', hint: 'Optional. When set, other domains in the URL get 404 "Domain not found", like Mailgun.', placeholder: 'mg.example.com' },
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, requests must use HTTP Basic auth "api:<key>" (else 401 Forbidden).', placeholder: 'key-devhub', secret: true },
      EVENT_WEBHOOK_FIELD,
      {
        key: 'webhookSigningKey',
        label: 'HTTP webhook signing key',
        hint: 'Webhooks carry signature = HMAC-SHA256(key, timestamp + token). Defaults to the API key, else "devhub-signing-key".',
        placeholder: 'devhub-signing-key',
        secret: true,
      },
    ],

    match: (req) => req.method === 'POST' && SEND.test(req.path),

    authorize(req, ctx) {
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      const auth = headerValue(req, 'authorization') ?? '';
      const m = /^Basic\s+(.+)$/i.exec(auth);
      const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
      if (decoded === `api:${key}`) return null;
      return { status: 401, body: 'Forbidden', headers: { 'content-type': 'text/plain; charset=utf-8' } };
    },

    async parse(req, ctx) {
      const [, domain, mime] = SEND.exec(req.path)!;
      const configured = cfg(ctx, 'domain');
      if (configured && configured.toLowerCase() !== domain.toLowerCase()) return { error: msg(404, `Domain not found: ${domain}`) };
      let f: Map<string, FormValue[]>;
      try {
        f = await readForm(req);
      } catch {
        return { error: msg(400, 'Invalid request: could not parse the form data') };
      }
      const to = strings(f, 'to').flatMap(toAddresses);
      if (!to.length) return { error: msg(400, 'to parameter is missing') };
      if (to.some((a) => !isEmail(a.email))) return { error: msg(400, 'to parameter is not a valid address. please check documentation') };
      const cc = strings(f, 'cc').flatMap(toAddresses);
      const bcc = strings(f, 'bcc').flatMap(toAddresses);
      if ([...cc, ...bcc].some((a) => !isEmail(a.email))) return { error: msg(400, 'cc parameter is not a valid address. please check documentation') };

      const tags = strings(f, 'o:tag');
      const vars: Record<string, string> = {};
      for (const [k, v] of Object.entries(parseJsonObject(first(f, 'h:X-Mailgun-Variables')))) vars[k] = typeof v === 'string' ? v : JSON.stringify(v);
      const headers: Record<string, string> = {};
      for (const [k, vals] of f) {
        const s = vals.find((x): x is string => typeof x === 'string');
        if (s === undefined) continue;
        if (k.startsWith('v:')) vars[k.slice(2)] = s;
        else if (k.startsWith('h:') && k !== 'h:X-Mailgun-Variables') headers[k.slice(2)] = s;
      }
      const testMode = ['yes', 'true', 'True'].includes(first(f, 'o:testmode') ?? '');

      if (mime) {
        const file = (f.get('message') ?? [])[0];
        const raw = !file ? null : typeof file === 'string' ? Buffer.from(file) : file.data;
        if (!raw) return { error: msg(400, 'message parameter is missing') };
        const p = await simpleParser(raw);
        const html = typeof p.html === 'string' ? p.html : null;
        const email: ParsedEmail = {
          from: toAddresses(p.from?.text ?? '')[0] ?? null,
          to,
          cc: [],
          bcc: [],
          replyTo: [],
          subject: p.subject ?? '(no subject)',
          text: p.text?.trim() || (html ? htmlToText(html) : null),
          html,
          attachments: [],
          headers,
          tags,
          vars,
          raw,
        };
        return { emails: [email], testMode, extra: { domain } };
      }

      const from = toAddresses(first(f, 'from'))[0] ?? null;
      if (!from) return { error: msg(400, 'from parameter is missing') };
      if (!isEmail(from.email)) return { error: msg(400, 'from parameter is not a valid address. please check documentation') };
      const template = first(f, 'template');
      const tvars = parseJsonObject(first(f, 't:variables') ?? first(f, 'h:X-Mailgun-Variables'));
      let text = first(f, 'text');
      let html = first(f, 'html');
      if (!text && !html && !template && !first(f, 'amp-html')) return { error: msg(400, "Need at least one of 'text', 'html' or 'template' parameters specified") };
      const subject0 = first(f, 'subject');
      if (!subject0 && !template) return { error: msg(400, 'subject parameter is missing') };
      if (template && !text && !html) text = [`[Mailgun template ${template}]`, ...dataAsText(tvars)].join('\n');
      if (Object.keys(tvars).length) {
        text = text ? renderVars(text, tvars) : text;
        html = html ? renderVars(html, tvars) : html;
      }
      const attachments: EmailAttachment[] = [];
      for (const kind of ['attachment', 'inline'] as const)
        for (const v of f.get(kind) ?? [])
          if (typeof v !== 'string') attachments.push({ filename: v.filename, content: v.data, contentType: v.type, inline: kind === 'inline', cid: kind === 'inline' ? v.filename : undefined });
      return {
        emails: [
          {
            from,
            to,
            cc,
            bcc,
            replyTo: toAddresses(first(f, 'h:Reply-To')),
            subject: subject0 ?? (typeof tvars.subject === 'string' ? tvars.subject : `Template ${template}`),
            text,
            html,
            attachments,
            headers,
            tags,
            vars,
          },
        ],
        testMode,
        extra: { domain },
      };
    },

    newMessageId: (_ctx, r) => `<${stamp()}.${randomHex(16).toUpperCase()}@${String(r.extra?.domain ?? 'devhub.local')}>`,

    messageIdHeader: (_ctx, id) => id,

    accepted: (_ctx, m) => ({ status: 200, body: { id: m.id, message: 'Queued. Thank you.' } }),

    sendError(_ctx, kind, code, message) {
      switch (kind) {
        case 'down':
          return msg(statusFromCode(code, 503), message ?? 'Service Unavailable');
        case 'rate_limit':
          return msg(statusFromCode(code, 429), message ?? 'Too many requests');
        case 'opt_out':
        case 'blocked':
          return msg(statusFromCode(code, 400), message ?? 'Recipient is suppressed');
        default:
          return msg(statusFromCode(code, 400), message ?? 'to parameter is not a valid address. please check documentation');
      }
    },

    notFound: (req) => msg(404, `Not Found: ${req.method} ${req.path}`),

    event(ctx, m, ev, url) {
      const meta = emailMeta(m);
      const now = Date.now() / 1000;
      const key = cfg(ctx, 'webhookSigningKey') ?? cfg(ctx, 'apiKey') ?? 'devhub-signing-key';
      const timestamp = String(Math.floor(now));
      const token = randomHex(50);
      const signature = createHmac('sha256', key).update(timestamp + token).digest('hex');
      const msgId = (m.providerMessageId ?? m.messageIdHeader ?? '').replace(/^<|>$/g, '');
      const data: Record<string, unknown> = {
        id: randomBytes(16).toString('base64url').slice(0, 22),
        timestamp: now,
        'log-level': 'info',
        recipient: m.to,
        'recipient-domain': m.to.split('@')[1] ?? '',
        tags: meta.tags,
        'user-variables': meta.vars,
        campaigns: [],
        envelope: { sender: meta.sender ?? '', targets: m.to, transport: 'smtp', 'sending-ip': '127.0.0.1' },
        message: {
          headers: { to: meta.recipients.join(', '), 'message-id': msgId, from: m.from ?? '', subject: m.subject ?? '' },
          attachments: [],
          size: (m.bodyText ?? '').length,
        },
        flags: { 'is-routed': false, 'is-authenticated': true, 'is-system-test': false, 'is-test-mode': false },
        storage: { url: `https://storage.devhub.local/v3/domains/${String(meta.extra?.domain ?? '')}/messages/${m.id}`, key: m.id },
      };
      const status = (code: number, message: string, extra: Record<string, unknown> = {}) => ({
        tls: true,
        'mx-host': `mx.${m.to.split('@')[1] ?? 'devhub.local'}`,
        code,
        description: code >= 400 ? message : '',
        'session-seconds': 0.1,
        utf8: true,
        'attempt-no': ev.attempt ?? 1,
        message,
        'certificate-verified': true,
        ...extra,
      });
      let name: string;
      switch (ev.type) {
        case 'processed':
          name = 'accepted';
          Object.assign(data, { event: 'accepted', method: 'HTTP' });
          break;
        case 'delivered':
          name = 'delivered';
          Object.assign(data, { event: 'delivered', 'delivery-status': status(250, 'OK') });
          break;
        case 'deferred':
          name = 'failed (temporary)';
          Object.assign(data, {
            event: 'failed',
            'log-level': 'warn',
            severity: 'temporary',
            reason: 'generic',
            'delivery-status': status(ev.smtpCode ?? 421, `${ev.status ?? '4.7.1'} ${ev.reason ?? 'Try again later'}`, { 'retry-seconds': 600 }),
          });
          break;
        case 'bounce':
          name = 'failed (permanent)';
          Object.assign(data, {
            event: 'failed',
            'log-level': 'error',
            severity: 'permanent',
            reason: ev.bounceType === 'soft' ? 'generic' : 'bounce',
            'delivery-status': status(ev.smtpCode ?? 550, `${ev.status ?? '5.1.1'} ${ev.reason ?? 'User unknown'}`, { 'bounce-code': ev.status ?? '5.1.1' }),
          });
          break;
        case 'dropped': {
          const unsub = ev.dropReason === 'unsubscribe';
          name = 'failed (suppressed)';
          Object.assign(data, {
            event: 'failed',
            'log-level': 'error',
            severity: 'permanent',
            reason: unsub ? 'suppress-unsubscribe' : 'suppress-bounce',
            'delivery-status': status(unsub ? 606 : 605, ev.reason ?? (unsub ? 'Not delivering to unsubscribed address' : 'Not delivering to previously bounced address')),
          });
          break;
        }
        case 'complaint':
          name = 'complained';
          Object.assign(data, { event: 'complained', 'log-level': 'warn' });
          break;
      }
      return {
        url,
        headers: { 'content-type': 'application/json', 'user-agent': 'mailgun/treq-devhub' },
        body: JSON.stringify({ signature: { timestamp, token, signature }, 'event-data': data }),
        name,
      };
    },
  };
}
