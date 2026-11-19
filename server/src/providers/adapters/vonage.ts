import { normalizePhone } from '../../util.js';
import { INBOUND_FIELD, STATUS_CALLBACK_FIELD, cfg, fields, randomHex, str, type ProviderAdapter, type Reply } from './types.js';

const digits = (p: string | null) => (p ?? '').replace(/^\+/, '');
const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);
const scts = (d = new Date()) => d.toISOString().replace(/[-T:]/g, '').slice(2, 12);

const sendError = (status: string, text: string, httpStatus = 200): Reply => ({
  status: httpStatus,
  body: { 'message-count': '1', messages: [{ status, 'error-text': text }] },
});

/** Vonage (Nexmo) SMS API: POST /sms/json. Errors come back as HTTP 200 with a non-zero status, like the real API. */
export function vonageAdapter(): ProviderAdapter {
  return {
    preset: 'vonage',
    blockedAt: 'send',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Any value; included in delivery receipts as api-key.' },
      STATUS_CALLBACK_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if ((req.method === 'POST' || req.method === 'GET') && /^\/sms\/json\/?$/.test(req.path)) return { kind: 'send' };
      return null;
    },

    parse(req) {
      const f = fields(req);
      const rawTo = str(f.to);
      if (!rawTo) return { error: sendError('2', 'Missing to param') };
      const to = normalizePhone(rawTo);
      if (!to) return { error: sendError('3', 'Invalid to address') };
      const text = str(f.text);
      if (!text) return { error: sendError('2', 'Missing text param') };
      const from = str(f.from);
      if (!from) return { error: sendError('2', 'Missing from param') };
      return { channel: 'sms', to, from: normalizePhone(from) ?? from, body: text, statusCallbackUrl: str(f.callback), extra: { clientRef: str(f['client-ref']) } };
    },

    newMessageId: () => randomHex(16).toUpperCase(),

    accepted(_ctx, m) {
      return {
        status: 200,
        body: {
          'message-count': '1',
          messages: [
            {
              to: digits(m.parsed.to),
              'message-id': m.id,
              status: '0',
              'remaining-balance': '10.00000000',
              'message-price': '0.03330000',
              network: '12345',
              ...(m.parsed.extra?.clientRef ? { 'client-ref': m.parsed.extra.clientRef } : {}),
            },
          ],
        },
      };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      switch (kind) {
        case 'down':
          return { status: 503, body: { type: 'https://developer.vonage.com/api-errors#service-unavailable', title: message ?? 'Service Unavailable' } };
        case 'rate_limit':
          return sendError(code ?? '1', message ?? 'Throughput Rate Exceeded - please wait [ 1000 ] and retry');
        case 'blocked':
        case 'opt_out':
          return sendError(code ?? '7', message ?? 'Number barred.');
        default:
          return sendError(code ?? '3', message ?? 'Invalid to address');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: '4', message: 'Call barred by user' } : { code: '3', message: 'Absent subscriber - permanent' }),

    notFound: (req) => ({ status: 404, body: { type: 'https://developer.vonage.com/api-errors#not-found', title: 'Not Found', detail: `${req.path} is not a Vonage SMS endpoint (use /sms/json)` } }),

    statusCallback(ctx, m, status, e, url) {
      const now = new Date();
      const s = status === 'sent' ? 'accepted' : status === 'queued' ? 'buffered' : status;
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msisdn: digits(m.to),
          to: digits(m.from),
          'network-code': '12345',
          messageId: m.providerMessageId,
          price: '0.03330000',
          status: s,
          scts: scts(now),
          'err-code': status === 'failed' ? e?.code ?? '1' : '0',
          'api-key': cfg(ctx, 'apiKey') ?? 'devhub',
          'message-timestamp': stamp(now),
        }),
      };
    },

    inbound(ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msisdn: digits(m.from),
          to: digits(m.to),
          messageId: m.id,
          text: m.text,
          type: 'text',
          keyword: (m.text.trim().split(/\s+/)[0] ?? '').toUpperCase(),
          'api-key': cfg(ctx, 'apiKey') ?? 'devhub',
          'message-timestamp': stamp(),
        }),
      };
    },
  };
}
