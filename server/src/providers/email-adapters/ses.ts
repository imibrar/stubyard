import { randomUUID } from 'node:crypto';
import { simpleParser, type AddressObject } from 'mailparser';
import { htmlToText } from '../../messages/extract.js';
import { cfg, randomHex, type OutboundCall, type Reply } from '../adapters/types.js';
import {
  EVENT_WEBHOOK_FIELD,
  dataAsText,
  emailMeta,
  isEmail,
  renderVars,
  statusFromCode,
  toAddresses,
  type EmailAdapter,
  type EmailAddress,
  type EmailAttachment,
  type ParsedEmail,
} from './types.js';

const ACCOUNT = '123456789012';

const awsError = (status: number, type: string, message: string): Reply => ({
  status,
  body: { message },
  headers: { 'x-amzn-errortype': type, 'x-amzn-requestid': randomUUID(), 'content-type': 'application/json' },
});
const bad = (message: string) => awsError(400, 'BadRequestException', message);

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const addrs = (v: unknown): EmailAddress[] => (Array.isArray(v) ? v.flatMap((x) => toAddresses(String(x))) : []);
const flat = (a: AddressObject | AddressObject[] | undefined): EmailAddress[] =>
  !a ? [] : (Array.isArray(a) ? a : [a]).flatMap((o) => o.value.filter((v) => v.address).map((v) => ({ email: v.address!, name: v.name || null })));

/** Amazon SES v2 SendEmail (POST /v2/email/outbound-emails) and SNS notifications. */
export function sesAdapter(): EmailAdapter {
  return {
    preset: 'ses',
    optOutAt: 'event',
    configFields: [
      { key: 'region', label: 'Region', hint: 'Shown in ARNs and notifications.', placeholder: 'us-east-1' },
      {
        key: 'eventWebhookUrl',
        label: 'SNS notification endpoint',
        hint: "Your app's HTTP(S) endpoint subscribed to the SNS topic. stubyard POSTs SNS Notification messages (Delivery, Bounce, Complaint) here.",
        placeholder: EVENT_WEBHOOK_FIELD.placeholder,
      },
      { key: 'topicArn', label: 'SNS topic ARN', placeholder: `arn:aws:sns:us-east-1:${ACCOUNT}:ses-notifications` },
      {
        key: 'notificationFormat',
        label: 'Notification format',
        hint: '"notification" (identity notifications: Delivery, Bounce, Complaint; default) or "event" (configuration-set event publishing: also Send, DeliveryDelay, Reject).',
        placeholder: 'notification',
      },
      { key: 'rawMessageDelivery', label: 'Raw message delivery', hint: '"true" = POST the SES JSON itself, without the SNS envelope.', placeholder: 'false' },
    ],

    match: (req) => req.method === 'POST' && /^\/v2\/email\/outbound-emails\/?$/.test(req.path),

    async parse(req) {
      if (req.bodyError || !req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return { error: awsError(400, 'SerializationException', 'Request body is not valid JSON') };
      const b = req.body as Record<string, unknown>;
      const dest = obj(b.Destination);
      const content = obj(b.Content);
      let to = addrs(dest.ToAddresses);
      let cc = addrs(dest.CcAddresses);
      let bcc = addrs(dest.BccAddresses);
      const tagList = Array.isArray(b.EmailTags) ? (b.EmailTags as unknown[]).map(obj) : [];
      const vars = Object.fromEntries(tagList.filter((t) => s(t.Name)).map((t) => [String(t.Name), String(t.Value ?? '')]));
      const tags = Object.entries(vars).map(([k, v]) => `${k}:${v}`);
      const replyTo = addrs(b.ReplyToAddresses);
      let from = toAddresses(s(b.FromEmailAddress))[0] ?? null;
      if (!content.Simple && !content.Raw && !content.Template) return { error: bad('Content is required: provide one of Simple, Raw or Template') };
      const checkAddresses = () => {
        for (const a of [...to, ...cc, ...bcc, ...(from ? [from] : [])]) if (!isEmail(a.email)) return bad(`Illegal address: ${a.email}`);
        if (!to.length && !cc.length && !bcc.length) return bad('Destination is required: provide at least one recipient address');
        return null;
      };

      if (content.Raw) {
        const data = s(obj(content.Raw).Data);
        if (!data) return { error: bad('Content.Raw.Data is required') };
        const raw = Buffer.from(data, 'base64');
        const p = await simpleParser(raw);
        if (!to.length && !cc.length && !bcc.length) {
          to = flat(p.to);
          cc = flat(p.cc);
          bcc = flat(p.bcc);
        }
        from = from ?? flat(p.from)[0] ?? null;
        const err = checkAddresses();
        if (err) return { error: err };
        if (!from) return { error: bad('Missing a From address: set FromEmailAddress or a From header') };
        const html = typeof p.html === 'string' ? p.html : null;
        const email: ParsedEmail = {
          from,
          to,
          cc,
          bcc,
          replyTo,
          subject: p.subject ?? '(no subject)',
          text: p.text?.trim() || (html ? htmlToText(html) : null),
          html,
          attachments: [],
          headers: {},
          tags,
          vars,
          raw,
        };
        return { emails: [email] };
      }

      if (!from) return { error: bad('FromEmailAddress is required for Simple and Template content') };
      const err = checkAddresses();
      if (err) return { error: err };
      let subject: string;
      let text: string | null = null;
      let html: string | null = null;
      const headers: Record<string, string> = {};
      const attachments: EmailAttachment[] = [];
      if (content.Simple) {
        const simple = obj(content.Simple);
        subject = s(obj(simple.Subject).Data) ?? '';
        if (!subject) return { error: bad('Content.Simple.Subject.Data is required') };
        const body = obj(simple.Body);
        text = s(obj(body.Text).Data);
        html = s(obj(body.Html).Data);
        if (!text && !html) return { error: bad('Content.Simple.Body needs Text or Html') };
        for (const h of Array.isArray(simple.Headers) ? (simple.Headers as unknown[]).map(obj) : []) if (s(h.Name)) headers[String(h.Name)] = String(h.Value ?? '');
        for (const a of Array.isArray(simple.Attachments) ? (simple.Attachments as unknown[]).map(obj) : [])
          attachments.push({
            filename: s(a.FileName) ?? 'attachment',
            content: Buffer.from(s(a.RawContent) ?? '', 'base64'),
            contentType: s(a.ContentType) ?? undefined,
            inline: a.ContentDisposition === 'INLINE',
            cid: s(a.ContentId) ?? undefined,
          });
      } else {
        const t = obj(content.Template);
        const name = s(t.TemplateName) ?? s(t.TemplateArn);
        const inline = obj(t.TemplateContent);
        if (!name && !Object.keys(inline).length) return { error: bad('Content.Template needs TemplateName, TemplateArn or TemplateContent') };
        let data: Record<string, unknown> = {};
        try {
          data = obj(JSON.parse(s(t.TemplateData) ?? '{}'));
        } catch {
          return { error: bad('Content.Template.TemplateData is not valid JSON') };
        }
        if (Object.keys(inline).length) {
          subject = renderVars(s(inline.Subject) ?? '', data) || '(no subject)';
          text = s(inline.Text) ? renderVars(String(inline.Text), data) : null;
          html = s(inline.Html) ? renderVars(String(inline.Html), data) : null;
        } else {
          // stubyard does not have your SES templates: show the template name and its data instead.
          subject = typeof data.subject === 'string' ? data.subject : `Template ${name}`;
          text = [`[SES template ${name}]`, ...dataAsText(data)].join('\n');
        }
      }
      return { emails: [{ from, to, cc, bcc, replyTo, subject, text, html, attachments, headers, tags, vars }] };
    },

    newMessageId: () => `0100019${randomHex(9)}-${randomUUID()}-000000`,

    messageIdHeader: (ctx, id) => `<${id}@${cfg(ctx, 'region') ?? 'us-east-1'}.amazonses.com>`,

    accepted: (_ctx, m) => ({ status: 200, body: { MessageId: m.id }, headers: { 'x-amzn-requestid': randomUUID() } }),

    sendError(_ctx, kind, code, message) {
      switch (kind) {
        case 'down':
          return awsError(statusFromCode(code, 503), 'ServiceUnavailable', message ?? 'Service is unavailable. Try again later.');
        case 'rate_limit':
          return awsError(statusFromCode(code, 429), 'TooManyRequestsException', message ?? 'Maximum sending rate exceeded.');
        case 'opt_out':
        case 'blocked':
          return awsError(statusFromCode(code, 400), 'MessageRejected', message ?? 'Recipient is on the account-level suppression list.');
        default:
          return awsError(statusFromCode(code, 400), 'MessageRejected', message ?? 'Email address is not verified. The following identities failed the check in region US-EAST-1: recipient');
      }
    },

    notFound: (req) => awsError(404, 'NotFoundException', `No operation at ${req.method} ${req.path}`),

    event(ctx, m, ev, url): (OutboundCall & { name: string }) | null {
      const meta = emailMeta(m);
      const region = cfg(ctx, 'region') ?? 'us-east-1';
      const eventFormat = (cfg(ctx, 'notificationFormat') ?? 'notification').toLowerCase().startsWith('event');
      const now = new Date().toISOString();
      const sender = meta.sender ?? m.from ?? '';
      const mail: Record<string, unknown> = {
        timestamp: m.createdAt,
        source: sender,
        sourceArn: `arn:aws:ses:${region}:${ACCOUNT}:identity/${sender.split('@')[1] ?? sender}`,
        sourceIp: '127.0.0.1',
        sendingAccountId: ACCOUNT,
        messageId: m.providerMessageId,
        destination: meta.recipients,
        headersTruncated: false,
        headers: [
          { name: 'From', value: m.from ?? '' },
          { name: 'To', value: m.to },
          { name: 'Subject', value: m.subject ?? '' },
          { name: 'Message-ID', value: m.messageIdHeader ?? '' },
        ],
        commonHeaders: { from: [m.from ?? ''], to: [m.to], messageId: m.providerMessageId, subject: m.subject ?? '' },
        ...(eventFormat ? { tags: Object.fromEntries(Object.entries(meta.vars).map(([k, v]) => [k, [v]])) } : {}),
      };
      const mta = `a8-70.smtp-out.${region}.amazonses.com`;
      let type: string;
      let detail: Record<string, unknown>;
      switch (ev.type) {
        case 'processed':
          if (!eventFormat) return null;
          type = 'Send';
          detail = { send: {} };
          break;
        case 'delivered':
          type = 'Delivery';
          detail = { delivery: { timestamp: now, processingTimeMillis: Date.now() - Date.parse(m.createdAt), recipients: [m.to], smtpResponse: '250 2.0.0 OK stubyard', reportingMTA: mta, remoteMtaIp: '127.0.0.1' } };
          break;
        case 'deferred':
          if (!eventFormat) return null;
          type = 'DeliveryDelay';
          detail = {
            deliveryDelay: {
              timestamp: now,
              delayType: 'TransientCommunicationFailure',
              expirationTime: new Date(Date.now() + 86_400_000).toISOString(),
              delayedRecipients: [{ emailAddress: m.to, status: ev.status ?? '4.7.1', diagnosticCode: `smtp; ${ev.smtpCode ?? 421} ${ev.status ?? '4.7.1'} ${ev.reason ?? 'Try again later'}` }],
              reportingMTA: mta,
            },
          };
          break;
        case 'bounce':
          type = 'Bounce';
          detail = {
            bounce: {
              bounceType: ev.bounceType === 'soft' ? 'Transient' : 'Permanent',
              bounceSubType: ev.bounceType === 'soft' ? 'MailboxFull' : ev.bounceType === 'blocked' ? 'Suppressed' : 'General',
              bouncedRecipients: [{ emailAddress: m.to, action: 'failed', status: ev.status ?? '5.1.1', diagnosticCode: `smtp; ${ev.smtpCode ?? 550} ${ev.status ?? '5.1.1'} ${ev.reason ?? 'User unknown'}` }],
              timestamp: now,
              feedbackId: `0100019${randomHex(9)}-${randomUUID()}-000000`,
              remoteMtaIp: '127.0.0.1',
              reportingMTA: `dns; ${mta}`,
            },
          };
          break;
        case 'dropped':
          if (!eventFormat) return null;
          type = 'Reject';
          detail = { reject: { reason: ev.reason ?? (ev.dropReason === 'unsubscribe' ? 'Recipient unsubscribed' : 'Bad content') } };
          break;
        case 'complaint':
          type = 'Complaint';
          detail = {
            complaint: {
              complainedRecipients: [{ emailAddress: m.to }],
              timestamp: now,
              feedbackId: `0100019${randomHex(9)}-${randomUUID()}-000000`,
              userAgent: 'stubyard',
              complaintFeedbackType: 'abuse',
              arrivalDate: m.createdAt,
            },
          };
          break;
      }
      const sesEvent = { [eventFormat ? 'eventType' : 'notificationType']: type, mail, ...detail };
      const topicArn = cfg(ctx, 'topicArn') ?? `arn:aws:sns:${region}:${ACCOUNT}:stubyard-${ctx.instance.slug}`;
      if ((cfg(ctx, 'rawMessageDelivery') ?? '').toLowerCase() === 'true') {
        return { url, headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-topic-arn': topicArn, 'x-amz-sns-rawdelivery': 'true' }, body: JSON.stringify(sesEvent), name: type };
      }
      const snsId = randomUUID();
      const envelope = {
        Type: 'Notification',
        MessageId: snsId,
        TopicArn: topicArn,
        Message: JSON.stringify(sesEvent),
        Timestamp: now,
        SignatureVersion: '1',
        Signature: 'ZGV2aHViLXVuc2lnbmVk', // stubyard does not sign SNS messages: skip signature checks in development
        SigningCertURL: `https://sns.${region}.amazonaws.com/SimpleNotificationService-stubyard.pem`,
        UnsubscribeURL: `https://sns.${region}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${topicArn}:${randomUUID()}`,
      };
      return {
        url,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'x-amz-sns-message-type': 'Notification',
          'x-amz-sns-message-id': snsId,
          'x-amz-sns-topic-arn': topicArn,
          'user-agent': 'Amazon Simple Notification Service Agent',
        },
        body: JSON.stringify(envelope),
        name: type,
      };
    },
  };
}
