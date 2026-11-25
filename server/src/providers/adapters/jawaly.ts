import { randomUUID } from 'node:crypto';
import { smsSegments } from '../../messages/sms-segments.js';
import { BALANCE_FIELD, DLR_FIELD, SENDERS_FIELD, balanceOf, basicAuth, credentialOk, gccAlias, gccGate, intl, ksaPhone, list, stamp, type GccError } from './gcc.js';
import { INBOUND_FIELD, fields, randomHex, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

const SEND = /\/account\/area\/sms\/send\/?$/i;
const PACKAGES = /\/account\/area\/me\/packages\/?$/i;

/** 4Jawaly rejects a request with HTTP 4xx {code, message}; per-message problems also come as messages[0].err_text. */
const err = (status: number, message: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { code: status, message, ...extra } });
const msgErr = (status: number, message: string): Reply => err(status, message, { messages: [{ err_text: message }] });

// Wording is Arabic like the real API. Token errors are verified; the others are assumed.
const NAMED: Record<GccError, Reply> = {
  auth: err(400, 'التوكن منتهى او انة غير مفعل', { is_token_expired: true }),
  sender: msgErr(400, 'اسم المرسل غير مفعل'),
  balance: msgErr(400, 'الرصيد غير كافي'),
  number: msgErr(400, 'رقم الجوال غير صحيح'),
};

/** 4Jawaly SMS API (api-sms.4jawaly.com): POST /api/v1/account/area/sms/send with Basic auth (API key : API secret). */
export function jawalyAdapter(): ProviderAdapter {
  const auth = (req: MockRequest, ctx: Ctx): Reply | null => {
    const b = basicAuth(req);
    if (!b) return err(400, 'التوكن مطلوب');
    return credentialOk(ctx, 'apiKey', b.user) && credentialOk(ctx, 'apiSecret', b.pass) ? null : NAMED.auth;
  };

  return {
    preset: '4jawaly',
    blockedAt: 'send',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, Basic auth with another key gets the "token expired or not active" error. Empty: any key works.' },
      { key: 'apiSecret', label: 'API secret', hint: 'Optional, same as the API key.', secret: true },
      DLR_FIELD,
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'GET' && PACKAGES.test(req.path)) return { kind: 'account', what: 'packages' };
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      return null;
    },

    parse(req, ctx) {
      const denied = auth(req, ctx);
      if (denied) return { error: denied };
      const f = fields(req);
      const first = (Array.isArray(f.messages) ? f.messages[0] : null) as Record<string, unknown> | null;
      if (!first) return { error: err(422, 'The messages field is required.') };
      const text = str(first.text);
      if (!text) return { error: err(422, 'The messages.0.text field is required.') };
      const nums = list(first.numbers).map(ksaPhone);
      if (!nums.length || nums.some((n) => !n || n.length < 9)) return { error: NAMED.number };
      const sender = str(first.sender);
      const gate = sender ? gccGate(ctx, sender) : 'sender';
      if (gate) return { error: NAMED[gate] };
      return { channel: 'sms', to: nums[0]!, from: sender, body: text, extra: { recipients: nums } };
    },

    newMessageId: () => randomUUID(),

    accepted(_ctx, m) {
      const n = ((m.parsed.extra?.recipients as string[] | undefined) ?? [m.parsed.to]).length;
      return {
        status: 200,
        body: {
          code: 200,
          message: 'تم حفظ الرسائل بنجاح',
          messages: [{ job_id: m.id, success_count: n, error_count: 0, duplicated_count: 0, total_cost: smsSegments(m.parsed.body).segments * n }],
          job_id: m.id,
          request_id: 'req_' + randomHex(14),
        },
      };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const named = gccAlias(code);
      if (named) return message ? msgErr(NAMED[named].status, message) : NAMED[named];
      switch (kind) {
        case 'down':
          return err(503, message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(429, message ?? 'Too Many Attempts.');
        default:
          return msgErr(400, message ?? 'رقم الجوال غير صحيح');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'blocked', message: 'Recipient is blocked' } : { code: 'undelivered', message: 'Recipient unreachable' }),

    notFound: (req) => err(404, `The route ${req.path.replace(/^\//, '')} could not be found.`),

    account(ctx, _what, req) {
      const denied = auth(req, ctx);
      if (denied) return denied;
      const points = balanceOf(ctx);
      const expire = new Date(Date.now() + 365 * 86_400_000);
      return {
        status: 200,
        body: {
          code: 200,
          message: 'success',
          total_balance: points,
          items: [{ id: 1, package_points: points, current_points: points, expire_at: stamp(expire), is_active: 1 }],
        },
      };
    },

    // DLR shape from SDK webhook parsers (sms_message + numbers[], status 3 = delivered); other status values assumed.
    statusCallback(_ctx, m, status, e, url) {
      if (status !== 'delivered' && status !== 'failed') return null;
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sms_message: { job_id: m.providerMessageId, sender_name: m.from, text: m.bodyText },
          numbers: [
            {
              number: intl(m.to),
              msg_id: m.providerMessageId,
              status: status === 'delivered' ? 3 : 4,
              error_code_string: status === 'failed' ? e?.code ?? 'undelivered' : null,
              updated_at: stamp(),
            },
          ],
        }),
      };
    },

    inbound(_ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: m.id, number: intl(m.from), to: intl(m.to), text: m.text, created_at: stamp() }),
      };
    },
  };
}
