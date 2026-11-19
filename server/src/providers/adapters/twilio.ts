import { createHmac } from 'node:crypto';
import type { Message } from '../../repos/messages.js';
import { normalizePhone } from '../../util.js';
import {
  INBOUND_FIELD,
  STATUS_CALLBACK_FIELD,
  cfg,
  fields,
  form,
  randomHex,
  str,
  type Ctx,
  type DeliveryStatus,
  type MockRequest,
  type ParsedSend,
  type ProviderAdapter,
  type Reply,
  type SendError,
} from './types.js';

const SEND = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages(?:\.json)?\/?$/;
const FETCH = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\/([^/.]+)(?:\.json)?$/;

const err = (status: number, code: number, message: string): Reply => ({
  status,
  body: { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status },
});

const rfc2822 = (iso: string) => new Date(iso).toUTCString().replace('GMT', '+0000');

/** Twilio Programmable Messaging: SMS, and WhatsApp with "whatsapp:" addresses. */
export function twilioAdapter(preset: 'twilio' | 'twilio-whatsapp'): ProviderAdapter {
  const accountSid = (ctx: Ctx) => cfg(ctx, 'accountSid') ?? 'AC' + 'd'.repeat(32);

  const messageJson = (ctx: Ctx, m: { id: string; to: string; from: string | null; body: string; status: string; createdAt: string; errorCode?: string | null; errorMessage?: string | null; whatsapp: boolean }) => {
    const sid = accountSid(ctx);
    const addr = (a: string | null) => (a && m.whatsapp && !a.startsWith('whatsapp:') ? `whatsapp:${a}` : a);
    return {
      account_sid: sid,
      api_version: '2010-04-01',
      body: m.body,
      date_created: rfc2822(m.createdAt),
      date_sent: m.status === 'queued' ? null : rfc2822(m.createdAt),
      date_updated: rfc2822(new Date().toISOString()),
      direction: 'outbound-api',
      error_code: m.errorCode ? Number(m.errorCode) || m.errorCode : null,
      error_message: m.errorMessage ?? null,
      from: addr(m.from),
      messaging_service_sid: null,
      num_media: '0',
      num_segments: String(Math.max(1, Math.ceil(m.body.length / 160))),
      price: null,
      price_unit: 'USD',
      sid: m.id,
      status: m.status,
      subresource_uris: { media: `/2010-04-01/Accounts/${sid}/Messages/${m.id}/Media.json` },
      to: addr(m.to),
      uri: `/2010-04-01/Accounts/${sid}/Messages/${m.id}.json`,
    };
  };

  const twilioStatus = (s: DeliveryStatus, code: string | null): string =>
    s === 'failed' ? (code && /^3000[3-7]$/.test(code) ? 'undelivered' : 'failed') : s;

  return {
    preset,
    blockedAt: 'send',
    configFields: [
      { key: 'accountSid', label: 'Account SID', hint: 'Any value; your app sends it in the URL.', placeholder: 'AC…' },
      { key: 'authToken', label: 'Auth token', hint: 'Optional. When set, callbacks carry a valid X-Twilio-Signature.', secret: true },
      STATUS_CALLBACK_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      const f = FETCH.exec(req.path);
      if (req.method === 'GET' && f) return { kind: 'fetch', id: f[2] };
      return null;
    },

    parse(req): ParsedSend | { error: Reply } {
      const f = fields(req);
      const rawTo = str(f.To);
      if (!rawTo) return { error: err(400, 21604, "A 'To' phone number is required.") };
      const whatsapp = rawTo.toLowerCase().startsWith('whatsapp:') || preset === 'twilio-whatsapp';
      const to = normalizePhone(rawTo);
      if (!to) return { error: err(400, 21211, `The 'To' number ${rawTo} is not a valid phone number.`) };
      let body = str(f.Body);
      if (!body && str(f.ContentSid)) body = `[content template ${str(f.ContentSid)}] ${str(f.ContentVariables) ?? ''}`.trim();
      if (!body && str(f.MediaUrl)) body = `[media] ${str(f.MediaUrl)}`;
      if (!body) return { error: err(400, 21602, 'Message body is required.') };
      const rawFrom = str(f.From) ?? (str(f.MessagingServiceSid) ? `service:${str(f.MessagingServiceSid)}` : null);
      if (!rawFrom) return { error: err(400, 21603, "A 'From' phone number is required.") };
      return {
        channel: whatsapp ? 'whatsapp' : 'sms',
        to,
        from: normalizePhone(rawFrom) ?? rawFrom,
        body,
        statusCallbackUrl: str(f.StatusCallback),
        extra: { whatsapp },
      };
    },

    newMessageId: () => (preset === 'twilio-whatsapp' ? 'MM' : 'SM') + randomHex(32),

    accepted(ctx, m) {
      return {
        status: 201,
        body: messageJson(ctx, { id: m.id, to: m.parsed.to, from: m.parsed.from, body: m.parsed.body, status: 'queued', createdAt: m.createdAt, whatsapp: m.parsed.channel === 'whatsapp' }),
      };
    },

    sendError(_ctx, kind: SendError, parsed, code, message) {
      const to = parsed?.to ?? '';
      switch (kind) {
        case 'down':
          return err(503, Number(code) || 20503, message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(429, Number(code) || 20429, message ?? 'Too Many Requests');
        case 'blocked':
        case 'opt_out':
          return err(400, Number(code) || 21610, message ?? 'Attempt to send to unsubscribed recipient');
        default:
          return err(400, Number(code) || 21211, message ?? `The 'To' number ${to} is not a valid phone number.`);
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: '30004', message: 'Message blocked' } : { code: '30003', message: 'Unreachable destination handset' }),

    notFound: (req) => err(404, 20404, `The requested resource ${req.path} was not found`),

    statusCallback(ctx, m: Message, status, e, url) {
      const whatsapp = m.channel === 'whatsapp';
      const wa = (a: string | null) => (a && whatsapp ? `whatsapp:${a}` : a);
      const s = twilioStatus(status, e?.code ?? null);
      const params: Record<string, string | null> = {
        AccountSid: accountSid(ctx),
        ApiVersion: '2010-04-01',
        MessageSid: m.providerMessageId,
        SmsSid: m.providerMessageId,
        MessageStatus: s,
        SmsStatus: s,
        To: wa(m.to),
        From: wa(m.from),
        ErrorCode: e?.code ?? null,
        ErrorMessage: e?.message ?? null,
      };
      return { url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...signature(ctx, url, params) }, body: form(params) };
    },

    inbound(ctx, m, url) {
      const whatsapp = m.channel === 'whatsapp';
      const wa = (a: string) => (whatsapp ? `whatsapp:${a}` : a);
      const params: Record<string, string | null> = {
        ToCountry: 'US',
        SmsMessageSid: m.id,
        NumMedia: '0',
        SmsSid: m.id,
        SmsStatus: 'received',
        Body: m.text,
        To: wa(m.to),
        NumSegments: '1',
        MessageSid: m.id,
        AccountSid: accountSid(ctx),
        From: wa(m.from),
        ApiVersion: '2010-04-01',
        ...(whatsapp ? { ProfileName: m.profileName, WaId: m.from.replace(/^\+/, '') } : {}),
      };
      return { url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...signature(ctx, url, params) }, body: form(params) };
    },

    fetch(ctx, m, id) {
      if (!m) return err(404, 20404, `The requested resource /2010-04-01/Accounts/${accountSid(ctx)}/Messages/${id}.json was not found`);
      const failed = m.status === 'failed';
      const code = failed ? String((m.metadata.errorCode as string) ?? '30003') : null;
      const status = failed ? twilioStatus('failed', code) : m.status === 'delivered' ? 'delivered' : m.status === 'scheduled' ? 'queued' : m.status === 'dropped' ? 'sent' : m.status;
      return {
        status: 200,
        body: messageJson(ctx, {
          id,
          to: m.to,
          from: m.from,
          body: m.bodyText ?? '',
          status,
          createdAt: m.createdAt,
          errorCode: code,
          errorMessage: failed ? m.statusDetail : null,
          whatsapp: m.channel === 'whatsapp',
        }),
      };
    },
  };
}

/** X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
function signature(ctx: Ctx, url: string, params: Record<string, string | null>): Record<string, string> {
  const token = cfg(ctx, 'authToken');
  if (!token) return {};
  const data =
    url +
    Object.keys(params)
      .filter((k) => params[k] !== null && params[k] !== undefined)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return { 'x-twilio-signature': createHmac('sha1', token).update(data).digest('base64') };
}
