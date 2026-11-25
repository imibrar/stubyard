import { randomUUID } from 'node:crypto';
import { cfg, type Reply } from '../adapters/types.js';
import {
  EVENT_WEBHOOK_FIELD,
  asUuid,
  bounceDetails,
  dataAsText,
  emailMeta,
  headerValue,
  isEmail,
  renderVars,
  statusFromCode,
  subId,
  toAddresses,
  unix,
  webhookTarget,
  type EmailAdapter,
  type EmailAddress,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

interface MjError {
  ErrorIdentifier: string;
  ErrorCode: string;
  StatusCode: number;
  ErrorMessage: string;
  ErrorRelatedTo: string[];
}

const mjErr = (ErrorCode: string, ErrorMessage: string, ErrorRelatedTo: string[], StatusCode = 400): MjError => ({ ErrorIdentifier: randomUUID(), ErrorCode, StatusCode, ErrorMessage, ErrorRelatedTo });
/** Send API v3.1 validation errors: per message, { Messages: [{ Status: "error", Errors: [...] }] }. */
const messagesError = (status: number, perMessage: MjError[][]): Reply => ({ status, body: { Messages: perMessage.map((Errors) => (Errors.length ? { Status: 'error', Errors } : { Status: 'success' })) } });
/** Errors outside message validation (auth, rate limit, outage): { ErrorIdentifier, StatusCode, ErrorMessage }. */
const topErr = (StatusCode: number, ErrorMessage: string, headers?: Record<string, string>): Reply => ({ status: StatusCode, body: { ErrorIdentifier: randomUUID(), StatusCode, ErrorMessage }, headers });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const list = (v: unknown): EmailAddress[] => (Array.isArray(v) ? v.flatMap((x) => toAddresses(obj(x))) : []);

/** Per-recipient MessageUUID / MessageID (Mailjet ids are per recipient), stable so events can rebuild them. */
const rcptUuid = (id: string, email: string) => asUuid(subId(id, email.toLowerCase()));
const rcptId = (id: string, email: string) => Number('288230' + String(parseInt(subId(id, 'n' + email.toLowerCase(), 12), 16)).padStart(10, '0').slice(0, 10));

/** Mailjet Send API v3.1 (POST /v3.1/send) and its event webhooks. */
export function mailjetAdapter(): EmailAdapter {
  return {
    preset: 'mailjet',
    optOutAt: 'event',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set (with the secret key), requests must use HTTP Basic auth "<apiKey>:<secretKey>" (else 401, like Mailjet).', placeholder: 'stubyard-key', secret: true },
      { key: 'apiSecret', label: 'Secret key', hint: 'The Basic auth password that goes with the API key.', placeholder: 'stubyard-secret', secret: true },
      {
        ...EVENT_WEBHOOK_FIELD,
        hint: "Your app's event URL (sent, bounce, blocked, spam). Mailjet does not sign events: Basic auth in the URL (https://user:pass@host/…) is sent as an Authorization header.",
      },
      { key: 'eventGrouping', label: 'Group events', hint: '"true" = POST each event inside a JSON array (Mailjet event API version 2 / grouped). Default: one JSON object per POST.', placeholder: 'false' },
    ],

    match: (req) => req.method === 'POST' && /^\/v3\.1\/send\/?$/.test(req.path),

    authorize(req, ctx) {
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      const m = /^Basic\s+(.+)$/i.exec(headerValue(req, 'authorization') ?? '');
      const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
      if (decoded === `${key}:${cfg(ctx, 'apiSecret') ?? ''}`) return null;
      return topErr(
        401,
        'API key authentication/authorization failure. You may be unauthorized to access the API or your API key may be expired. Visit API keys management section to check your keys.',
      );
    },

    async parse(req) {
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body) || Array.isArray(req.body)) return { error: topErr(400, 'Malformed JSON, please review the syntax and properties types.') };
      const b = req.body as Record<string, unknown>;
      const msgs = Array.isArray(b.Messages) ? (b.Messages as unknown[]).map(obj) : [];
      if (!msgs.length) return { error: messagesError(400, [[mjErr('mj-0003', 'Missing mandatory property.', ['Messages'])]]) };
      const globals = obj(b.Globals);
      const all: MjError[][] = [];
      const emails: ParsedEmail[] = [];
      for (const m0 of msgs) {
        const m = { ...globals, ...m0 };
        const errs: MjError[] = [];
        const from = toAddresses(obj(m.From))[0] ?? null;
        if (!from) errs.push(mjErr('mj-0003', 'Missing mandatory property.', ['From']));
        else if (!isEmail(from.email)) errs.push(mjErr('mj-0013', `"${from.email}" is an invalid email address.`, ['From.Email']));
        const to = list(m.To);
        const cc = list(m.Cc);
        const bcc = list(m.Bcc);
        if (!to.length && !cc.length && !bcc.length) errs.push(mjErr('mj-0003', 'At least "To", "Cc" or "Bcc" must be provided.', ['To', 'Cc', 'Bcc']));
        for (const [k, l] of [['To', to], ['Cc', cc], ['Bcc', bcc]] as const) l.forEach((a, i) => !isEmail(a.email) && errs.push(mjErr('mj-0013', `"${a.email}" is an invalid email address.`, [`${k}[${i}].Email`])));
        const templateId = m.TemplateID !== undefined && m.TemplateID !== null ? String(m.TemplateID) : null;
        if (!templateId && !str(m.TextPart) && !str(m.HTMLPart)) errs.push(mjErr('mj-0003', 'At least "TemplateID", "HTMLPart" or "TextPart" is mandatory.', ['TemplateID', 'HTMLPart', 'TextPart']));
        all.push(errs);
        if (errs.length) continue;

        const variables = obj(m.Variables);
        const render = (s: string | null) => (s && m.TemplateLanguage === true ? renderVars(s.replace(/\{\{\s*var:([\w.]+)(?::"[^"]*")?\s*\}\}/g, '{{$1}}'), variables) : s);
        let text = render(str(m.TextPart));
        let html = render(str(m.HTMLPart));
        let subject = render(str(m.Subject));
        if (templateId) {
          // stubyard does not have your Mailjet templates: show the template id and its variables instead.
          text = [`[Mailjet template ${templateId}]`, ...dataAsText(variables)].join('\n');
          html = null;
          subject ??= `Template ${templateId}`;
        }
        const attachments: EmailAttachment[] = [];
        for (const [kind, arr] of [['attachment', m.Attachments], ['inline', m.InlinedAttachments]] as const)
          for (const [n, x] of (Array.isArray(arr) ? (arr as unknown[]) : []).entries()) {
            const a = obj(x);
            const cid = kind === 'inline' ? (str(a.ContentID) ?? undefined) : undefined;
            attachments.push({ filename: String(a.Filename ?? `attachment-${n + 1}`), content: Buffer.from(String(a.Base64Content ?? ''), 'base64'), contentType: str(a.ContentType) ?? undefined, cid, inline: kind === 'inline' });
          }
        const vars: Record<string, string> = {};
        if (str(m.CustomID)) vars.CustomID = String(m.CustomID);
        if (str(m.EventPayload)) vars.Payload = String(m.EventPayload);
        emails.push({
          from: from!,
          to,
          cc,
          bcc,
          replyTo: toAddresses(obj(m.ReplyTo)),
          subject: subject ?? '(no subject)',
          text,
          html,
          attachments,
          headers: Object.fromEntries(Object.entries(obj(m.Headers)).map(([k, v]) => [k, String(v)])),
          tags: str(m.CustomCampaign) ? [String(m.CustomCampaign)] : [],
          vars,
        });
      }
      if (all.some((e) => e.length)) return { error: messagesError(400, all) };
      return { emails, testMode: b.SandboxMode === true };
    },

    newMessageId: () => randomUUID(),

    messageIdHeader: (_ctx, id, index) => `<${asUuid(subId(id, `h${index}`))}@stubyard.mailjet.local>`,

    accepted(_ctx, m) {
      const rcpt = (a: EmailAddress) => ({ Email: a.email, MessageUUID: rcptUuid(m.id, a.email), MessageID: rcptId(m.id, a.email), MessageHref: `https://api.mailjet.com/v3/REST/message/${rcptId(m.id, a.email)}` });
      return {
        status: 200,
        body: { Messages: m.request.emails.map((e) => ({ Status: 'success', CustomID: e.vars.CustomID ?? '', To: e.to.map(rcpt), Cc: e.cc.map(rcpt), Bcc: e.bcc.map(rcpt) })) },
      };
    },

    sendError(_ctx, kind, code, message, refused) {
      switch (kind) {
        case 'down':
          return topErr(statusFromCode(code, 503), message ?? 'Service Unavailable');
        case 'rate_limit':
          return topErr(statusFromCode(code, 429), message ?? 'Too many requests. Please slow down.', { 'retry-after': '60' });
        default: {
          const who = refused?.length ? refused : [''];
          return messagesError(statusFromCode(code, 400), [who.map((a, i) => mjErr('mj-0013', message ?? `"${a}" is an invalid email address.`, [`To[${i}].Email`], statusFromCode(code, 400)))]);
        }
      }
    },

    notFound: (req) => topErr(404, `Not found: ${req.method} ${req.path}`),

    event(ctx, m, ev, url) {
      const meta = emailMeta(m);
      const id = m.providerMessageId ?? m.id;
      const base: Record<string, unknown> = {
        time: unix(),
        MessageID: rcptId(id, m.to),
        Message_GUID: rcptUuid(id, m.to),
        email: m.to,
        mj_campaign_id: 0,
        mj_contact_id: 0,
        customcampaign: meta.tags[0] ?? '',
        CustomID: meta.vars.CustomID ?? '',
        Payload: meta.vars.Payload ?? '',
      };
      let event: string;
      const extra: Record<string, unknown> = {};
      switch (ev.type) {
        case 'delivered':
          event = 'sent';
          Object.assign(extra, { mj_message_id: String(base.MessageID), smtp_reply: '250 2.0.0 OK stubyard' });
          break;
        case 'bounce': {
          const d = bounceDetails(null, null, { smtpCode: ev.smtpCode ?? 550, status: ev.status ?? '5.1.1', reason: ev.reason ?? 'User unknown' });
          event = 'bounce';
          Object.assign(extra, {
            blocked: false,
            hard_bounce: ev.bounceType !== 'soft' && ev.bounceType !== 'blocked',
            error_related_to: ev.bounceType === 'blocked' ? 'domain' : ev.bounceType === 'soft' ? 'mailbox' : 'recipient',
            error: ev.bounceType === 'blocked' ? 'spam' : ev.bounceType === 'soft' ? 'quota exceeded' : 'user unknown',
            comment: `${d.smtpCode} ${d.status} ${d.reason}`,
          });
          break;
        }
        case 'dropped':
          event = 'blocked';
          Object.assign(extra, { error_related_to: 'recipient', error: 'preblocked' });
          break;
        case 'complaint':
          event = 'spam';
          extra.source = 'JMRPP';
          break;
        default:
          // Mailjet has no "processed" or "deferred" event (it retries silently).
          return null;
      }
      const payload = { event, ...base, ...extra };
      const target = webhookTarget(url);
      return {
        url: target.url,
        headers: { 'content-type': 'application/json', 'user-agent': 'Mailjet-Event-API (stubyard)', ...target.headers },
        body: JSON.stringify(cfg(ctx, 'eventGrouping') === 'true' ? [payload] : payload),
        name: event,
      };
    },
  };
}
