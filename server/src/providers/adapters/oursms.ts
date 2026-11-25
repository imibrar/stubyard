import { randomUUID } from 'node:crypto';
import { smsSegments } from '../../messages/sms-segments.js';
import { BALANCE_FIELD, SENDERS_FIELD, balanceOf, bearerToken, credentialOk, gccAlias, gccGate, intl, ksaPhone, list, pick, stamp, type GccError } from './gcc.js';
import { INBOUND_FIELD, fields, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

/** REST (POST /msgs/sms, bearer) and the legacy query API (/api-a/msgs?username&token…). */
const SEND = /\/msgs\/sms\/?$/i;
const LEGACY_SEND = /\/api-a\/msgs\/?$/i;
const CREDITS = /\/billing\/credits\/?$/i;

/** OurSMS error envelope: {status, errorCode, message, value}. */
const err = (status: number, errorCode: string, message: string): Reply => ({ status, body: { status, errorCode, message, value: null } });

// 401 / 2003 is verified; the 400 texts are assumed (errorCode left empty rather than invented).
const NAMED: Record<GccError, Reply> = {
  auth: err(401, '2003', 'Invalid credentials'),
  sender: err(400, '', 'Sender name is not active'),
  balance: err(400, '', 'Insufficient credits'),
  number: err(400, '', 'Invalid destination number(s)'),
};

/** OurSMS (api.oursms.com): POST /msgs/sms with a bearer token. No documented DLR webhook. */
export function oursmsAdapter(): ProviderAdapter {
  const token = (req: MockRequest) => bearerToken(req) ?? str(pick(fields(req), 'token'));
  const auth = (req: MockRequest, ctx: Ctx): Reply | null => {
    const t = token(req);
    if (!t) return err(401, '', 'Invalid credentials');
    return credentialOk(ctx, 'token', t) ? null : NAMED.auth;
  };

  return {
    preset: 'oursms',
    blockedAt: 'send',
    configFields: [
      { key: 'token', label: 'API token', hint: 'Optional. When set, any other token gets 401 errorCode 2003 "Invalid credentials". Empty: any token works.', secret: true },
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'GET' && CREDITS.test(req.path)) return { kind: 'account', what: 'credits' };
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      if ((req.method === 'GET' || req.method === 'POST') && LEGACY_SEND.test(req.path)) return { kind: 'send' };
      return null;
    },

    parse(req, ctx) {
      const denied = auth(req, ctx);
      if (denied) return { error: denied };
      const f = fields(req);
      const nums = list(f.dests).map(ksaPhone);
      if (!nums.length || nums.some((n) => !n || n.length < 9)) return { error: NAMED.number };
      const body = str(f.body);
      if (!body) return { error: err(400, '', 'Message body is required') };
      const src = str(f.src);
      const gate = src ? gccGate(ctx, src) : 'sender';
      if (gate) return { error: NAMED[gate] };
      return { channel: 'sms', to: nums[0]!, from: src, body, extra: { recipients: nums } };
    },

    newMessageId: () => randomUUID(),

    accepted(_ctx, m) {
      const n = ((m.parsed.extra?.recipients as string[] | undefined) ?? [m.parsed.to]).length;
      const parts = smsSegments(m.parsed.body).segments;
      return { status: 200, body: { jobId: m.id, accepted: n, rejected: 0, duplicates: 0, msgParts: parts, cost: parts * n } };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const named = gccAlias(code);
      if (named) {
        const b = NAMED[named].body as { status: number; errorCode: string; message: string };
        return message ? err(b.status, b.errorCode, message) : NAMED[named];
      }
      switch (kind) {
        case 'down':
          return err(503, code ?? '', message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(429, code ?? '', message ?? 'Too Many Requests');
        default:
          return err(400, code ?? '', message ?? 'Invalid destination number(s)');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'blocked', message: 'Recipient is blocked' } : { code: 'undelivered', message: 'Recipient unreachable' }),

    notFound: (req) => err(404, '', `${req.method} ${req.path} is not an OurSMS endpoint (use POST /msgs/sms)`),

    account(ctx, _what, req) {
      const denied = auth(req, ctx);
      if (denied) return denied;
      return { status: 200, body: { credits: balanceOf(ctx) } };
    },

    // No documented delivery-report webhook.
    statusCallback: () => null,

    inbound(_ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgId: m.id, src: intl(m.from), dest: intl(m.to), body: m.text, time: stamp() }),
      };
    },
  };
}
