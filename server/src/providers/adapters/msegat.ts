import { BALANCE_FIELD, SENDERS_FIELD, balanceOf, credentialOk, gccAlias, gccGate, intl, ksaPhone, list, pick, stamp, type GccError } from './gcc.js';
import { INBOUND_FIELD, fields, randomHex, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

const SEND = /\/gw\/sendsms\.php$/i;
const CREDITS = /\/gw\/Credits\.php$/i;

/** Msegat answers HTTP 200 with {code, message} for successes and errors alike. */
const res = (code: string, message: string): Reply => ({ status: 200, body: { code, message } });

const NAMED: Record<GccError, Reply> = {
  auth: res('M0002', 'Invalid login info'),
  sender: res('1110', 'Sender name is missing or incorrect'),
  balance: res('1060', 'Balance is not enough'),
  number: res('1120', 'Mobile numbers is not correct or international messaging is not enabled'),
};

/** Msegat (www.msegat.com): POST /gw/sendsms.php with userName + apiKey in the body. No DLR push (apps poll getMessages.php). */
export function msegatAdapter(): ProviderAdapter {
  const authed = (f: Record<string, unknown>, ctx: Ctx) =>
    credentialOk(ctx, 'userName', str(pick(f, 'userName'))) && credentialOk(ctx, 'apiKey', str(pick(f, 'apiKey')));

  return {
    preset: 'msegat',
    blockedAt: 'send',
    configFields: [
      { key: 'userName', label: 'userName', hint: 'Optional. When set, any other userName gets M0002 "Invalid login info". Empty: any value works.' },
      { key: 'apiKey', label: 'apiKey', hint: 'Optional, same as userName.', secret: true },
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if ((req.method === 'GET' || req.method === 'POST') && CREDITS.test(req.path)) return { kind: 'account', what: 'credits' };
      if (SEND.test(req.path)) {
        // Msegat refuses GET: answered by parse() as M0034.
        if (req.method === 'POST' || req.method === 'GET') return { kind: 'send' };
      }
      return null;
    },

    parse(req: MockRequest, ctx) {
      if (req.method !== 'POST') return { error: res('M0034', 'Please Use POST Method') };
      const f = fields(req);
      const rawTo = list(pick(f, 'numbers'))[0] ?? null;
      const msg = str(pick(f, 'msg'));
      if (!str(pick(f, 'userName')) || !rawTo || !msg) return { error: res('M0002', 'Missing required fields: userName, numbers, or msg') };
      if (!authed(f, ctx)) return { error: NAMED.auth };
      const to = ksaPhone(rawTo);
      if (!to || to.length < 9) return { error: NAMED.number };
      const sender = str(pick(f, 'userSender'));
      if (!sender) return { error: NAMED.sender };
      const gate = gccGate(ctx, sender);
      if (gate) return { error: NAMED[gate] };
      return { channel: 'sms', to, from: sender, body: msg, extra: { bulkId: !!str(pick(f, 'reqBulkId')) } };
    },

    newMessageId: () => randomHex(24),

    accepted(_ctx, m) {
      return { status: 200, body: { code: '1', message: 'Success', ...(m.parsed.extra?.bulkId ? { bulk_id: m.id } : {}) } };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const named = gccAlias(code);
      if (named) return message ? res((NAMED[named].body as { code: string }).code, message) : NAMED[named];
      switch (kind) {
        case 'down':
          return { status: 503, body: { code: code ?? '503', message: message ?? 'Service Unavailable' } };
        case 'rate_limit':
          return { status: 429, body: { code: code ?? '429', message: message ?? 'Too Many Requests' } };
        default:
          return res(code ?? '1120', message ?? 'Mobile numbers is not correct or international messaging is not enabled');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'blocked', message: 'Recipient is blocked' } : { code: 'undelivered', message: 'Recipient unreachable' }),

    notFound: (req) => ({ status: 404, body: { code: '404', message: `${req.path} is not a Msegat endpoint (use POST /gw/sendsms.php)` } }),

    account(ctx, _what, req) {
      const f = fields(req);
      if (!authed(f, ctx)) return NAMED.auth;
      // Credits.php answers with the bare balance as text, e.g. "272.6".
      return { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: String(balanceOf(ctx)) };
    },

    // Msegat has no delivery-report webhook.
    statusCallback: () => null,

    inbound(_ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: m.id, from: intl(m.from), to: intl(m.to), msg: m.text, date: stamp() }),
      };
    },
  };
}
