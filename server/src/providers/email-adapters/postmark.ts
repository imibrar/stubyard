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
  webhookTarget,
  type EmailAdapter,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

const SEND = /^\/email(\/batch|\/withTemplate|\/batchWithTemplates)?\/?$/;
/** Postmark's documented test token: validated and answered, never delivered. */
const TEST_TOKEN = 'POSTMARK_API_TEST';

/** Postmark's error body: { ErrorCode, Message } (422 for send validation). */
const err = (status: number, ErrorCode: number, Message: string): Reply => ({ status, body: { ErrorCode, Message } });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Per-email MessageID: the first email keeps the request id (batch: one per message). */
const emailId = (id: string, index: number) => (index === 0 ? id : asUuid(subId(id, index)));
const submittedAt = () => new Date().toISOString().replace('Z', '+00:00');

function parseOne(b: Record<string, unknown>, withTemplate: boolean): ParsedEmail | { error: Reply } {
  const from = toAddresses(str(b.From))[0] ?? null;
  if (!from || !isEmail(from.email)) return { error: err(422, 300, `Invalid 'From' address: '${String(b.From ?? '')}'.`) };
  const to = toAddresses(str(b.To));
  const cc = toAddresses(str(b.Cc));
  const bcc = toAddresses(str(b.Bcc));
  if (!to.length && !cc.length && !bcc.length) return { error: err(422, 300, 'Zero recipients specified') };
  for (const [k, list] of [['To', to], ['Cc', cc], ['Bcc', bcc]] as const) {
    const bad = list.find((a) => !isEmail(a.email));
    if (bad) return { error: err(422, 300, `Invalid '${k}' address: '${bad.email}'.`) };
  }
  if (to.length + cc.length + bcc.length > 50) return { error: err(422, 300, 'Maximum of 50 recipients allowed per message.') };

  const templateRef = withTemplate ? (b.TemplateId !== undefined && b.TemplateId !== null ? String(b.TemplateId) : str(b.TemplateAlias)) : null;
  if (withTemplate && !templateRef) return { error: err(422, 1101, "Either 'TemplateId' or 'TemplateAlias' must be specified.") };
  const model = obj(b.TemplateModel);
  let text = str(b.TextBody);
  let html = str(b.HtmlBody);
  let subject = str(b.Subject);
  if (templateRef) {
    // stubyard does not have your Postmark templates: show the template and its model instead.
    text = [`[Postmark template ${templateRef}]`, ...dataAsText(model)].join('\n');
    html = null;
    subject = typeof model.subject === 'string' ? renderVars(model.subject, model) : `Template ${templateRef}`;
  } else if (!text && !html) return { error: err(422, 300, 'Provide either email TextBody or HtmlBody or both.') };

  const attachments: EmailAttachment[] = (Array.isArray(b.Attachments) ? (b.Attachments as unknown[]) : []).map((x, n) => {
    const a = obj(x);
    const cid = str(a.ContentID)?.replace(/^cid:/i, '');
    return { filename: String(a.Name ?? `attachment-${n + 1}`), content: Buffer.from(String(a.Content ?? ''), 'base64'), contentType: str(a.ContentType) ?? undefined, cid, inline: !!cid };
  });
  const headers: Record<string, string> = {};
  for (const h of Array.isArray(b.Headers) ? (b.Headers as unknown[]).map(obj) : []) if (str(h.Name)) headers[String(h.Name)] = String(h.Value ?? '');
  const vars = Object.fromEntries(Object.entries(obj(b.Metadata)).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    from,
    to,
    cc,
    bcc,
    replyTo: toAddresses(str(b.ReplyTo)),
    subject: subject ?? '(no subject)',
    text,
    html,
    attachments,
    headers,
    tags: str(b.Tag) ? [String(b.Tag)] : [],
    vars,
  };
}

/** Postmark Email API (POST /email, /email/batch, /email/withTemplate, /email/batchWithTemplates) and its webhooks. */
export function postmarkAdapter(): EmailAdapter {
  return {
    preset: 'postmark',
    optOutAt: 'send',
    configFields: [
      {
        key: 'apiKey',
        label: 'Server token',
        hint: `Optional. When set, requests must send "X-Postmark-Server-Token: <token>" (else 401, ErrorCode 10). "${TEST_TOKEN}" is always accepted and never delivered, like Postmark.`,
        placeholder: 'stubyard-server-token',
        secret: true,
      },
      {
        ...EVENT_WEBHOOK_FIELD,
        hint: "Your app's webhook for Delivery, Bounce and SpamComplaint events. Postmark does not sign webhooks: put Basic auth in the URL (https://user:pass@host/…) and stubyard sends it as an Authorization header.",
      },
    ],

    match: (req) => req.method === 'POST' && SEND.test(req.path),

    authorize(req, ctx) {
      const token = headerValue(req, 'x-postmark-server-token');
      if (token === TEST_TOKEN) return null;
      const key = cfg(ctx, 'apiKey');
      if (!key) return null;
      if (!token) return err(401, 10, 'No Account or Server API tokens were supplied in the HTTP headers. Please add a header for either X-Postmark-Server-Token or X-Postmark-Account-Token.');
      if (token === key) return null;
      return err(401, 10, 'The Server Token you provided in the X-Postmark-Server-Token request header was invalid. Please verify that you are using a valid token.');
    },

    async parse(req) {
      const kind = SEND.exec(req.path)![1] ?? '';
      const testMode = headerValue(req, 'x-postmark-server-token') === TEST_TOKEN;
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return { error: err(422, 402, 'Received invalid JSON input.') };
      const batch = kind === '/batch' || kind === '/batchWithTemplates';
      const withTemplate = kind === '/withTemplate' || kind === '/batchWithTemplates';
      const list: unknown[] = kind === '/batchWithTemplates' ? (Array.isArray(obj(req.body).Messages) ? (obj(req.body).Messages as unknown[]) : []) : batch ? (Array.isArray(req.body) ? req.body : []) : [req.body];
      if (batch && !list.length) return { error: err(422, 300, 'The batch must contain at least one message.') };
      if (list.length > 500) return { error: err(422, 300, 'The batch must contain at most 500 messages.') };
      const emails: ParsedEmail[] = [];
      const streams: string[] = [];
      for (const x of list) {
        const p = parseOne(obj(x), withTemplate);
        if ('error' in p) return p;
        emails.push(p);
        streams.push(str(obj(x).MessageStream) ?? 'outbound');
      }
      return { emails, testMode, extra: { batch, streams } };
    },

    newMessageId: () => randomUUID(),

    messageIdHeader: (_ctx, id, index) => `<${emailId(id, index)}@stubyard.postmark.local>`,

    accepted(_ctx, m) {
      const at = submittedAt();
      const results = m.request.emails.map((e, i) => ({ To: e.to.map((a) => a.email).join(', '), SubmittedAt: at, MessageID: emailId(m.id, i), ErrorCode: 0, Message: m.request.testMode ? 'Test job accepted' : 'OK' }));
      return { status: 200, body: m.request.extra?.batch ? results : results[0] };
    },

    sendError(_ctx, kind, code, message, refused) {
      const who = refused?.join(', ') ?? '';
      switch (kind) {
        case 'down':
          return err(statusFromCode(code, 503), 0, message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(statusFromCode(code, 429), 0, message ?? 'Rate limit exceeded. Please reduce the rate of your requests.');
        case 'opt_out':
        case 'blocked':
          return err(
            statusFromCode(code, 422),
            406,
            message ?? `You tried to send to recipient(s) that have been marked as inactive. Found inactive addresses: ${who}. Inactive recipients are ones that have generated a hard bounce, a spam complaint, or a manual suppression.`,
          );
        default:
          return err(statusFromCode(code, 422), 300, message ?? `Invalid 'To' address: '${who}'.`);
      }
    },

    notFound: () => err(404, 0, 'Not Found'),

    event(_ctx, m, ev, url) {
      const meta = emailMeta(m);
      const streams = Array.isArray(meta.extra?.streams) ? (meta.extra.streams as string[]) : [];
      const common = {
        ServerID: 1,
        MessageStream: streams[meta.emailIndex] ?? 'outbound',
        MessageID: m.providerMessageId ? emailId(m.providerMessageId, meta.emailIndex) : m.id,
        Tag: meta.tags[0] ?? '',
        Metadata: meta.vars,
      };
      const now = new Date().toISOString();
      const bounce = (Type: string, TypeCode: number, Name: string, Description: string, Details: string, Inactive: boolean, RecordType = 'Bounce') => ({
        RecordType,
        ID: Math.floor(Math.random() * 1e9),
        Type,
        TypeCode,
        Name,
        ...common,
        Description,
        Details,
        Email: m.to,
        From: meta.sender ?? m.from ?? '',
        BouncedAt: now,
        DumpAvailable: false,
        Inactive,
        CanActivate: Inactive,
        Subject: m.subject ?? '',
        Content: '',
      });
      let payload: Record<string, unknown>;
      let name: string;
      switch (ev.type) {
        case 'delivered':
          name = 'Delivery';
          payload = { RecordType: 'Delivery', ...common, Recipient: m.to, DeliveredAt: now, Details: 'smtp;250 2.0.0 OK stubyard' };
          break;
        case 'deferred':
          name = 'Bounce (Transient)';
          payload = bounce('Transient', 2, 'Message delayed', 'The server could not temporarily deliver your message (ex: Message is delayed due to network troubles).', `smtp;${ev.smtpCode ?? 421} ${ev.status ?? '4.7.1'} ${ev.reason ?? 'Try again later'}`, false);
          break;
        case 'bounce': {
          const d = bounceDetails(null, null, { smtpCode: ev.smtpCode ?? 550, status: ev.status ?? '5.1.1', reason: ev.reason ?? 'User unknown' });
          const details = `smtp;${d.smtpCode} ${d.status} ${d.reason}`;
          if (ev.bounceType === 'soft') {
            name = 'Bounce (SoftBounce)';
            payload = bounce('SoftBounce', 4096, 'Soft bounce', 'Unable to temporarily deliver this email.', details, false);
          } else if (ev.bounceType === 'blocked') {
            name = 'Bounce (Blocked)';
            payload = bounce('Blocked', 100006, 'ISP block', 'The ISP has blocked the message, usually because of the content or the sending IP.', details, false);
          } else {
            name = 'Bounce (HardBounce)';
            payload = bounce('HardBounce', 1, 'Hard bounce', 'The server was unable to deliver your message (ex: unknown user, mailbox not found).', details, true);
          }
          break;
        }
        case 'complaint':
          name = 'SpamComplaint';
          payload = bounce('SpamComplaint', 100001, 'Spam complaint', 'The subscriber explicitly marked this message as spam.', 'Test spam complaint details', true, 'SpamComplaint');
          payload.CanActivate = false;
          break;
        default:
          // Postmark has no "sent" webhook, and suppressed recipients are refused at send time (ErrorCode 406).
          return null;
      }
      const target = webhookTarget(url);
      return { url: target.url, headers: { 'content-type': 'application/json', 'user-agent': 'Postmark', ...target.headers }, body: JSON.stringify(payload), name };
    },
  };
}
