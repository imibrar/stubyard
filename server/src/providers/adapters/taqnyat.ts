import { smsSegments } from '../../messages/sms-segments.js';
import { BALANCE_FIELD, DLR_FIELD, SENDERS_FIELD, approvedSenders, balanceOf, bearerToken, credentialOk, gccAlias, gccGate, intl, ksaPhone, list, stamp, type GccError } from './gcc.js';
import { INBOUND_FIELD, cfg, fields, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

const SEND = /\/v1\/messages\/?$/i;
const SENDERS = /\/v1\/messages\/senders\/?$/i;
const BALANCE = /\/account\/balance\/?$/i;

/** Taqnyat answers {statusCode, message} with the same HTTP status. */
const err = (status: number, message: string): Reply => ({ status, body: { statusCode: status, message } });

const NAMED: Record<GccError, Reply> = {
  auth: err(401, 'invalid credentials information'),
  sender: err(400, 'Sender Name not active'),
  balance: err(400, 'Your balance is 0'),
  number: err(400, 'Mobile(s) number(s) is not specified or incorrect'),
};

/** Recipient list as Taqnyat prints it: "[966500000000,]". */
const printed = (nums: string[]) => `[${nums.map((n) => intl(n) + ',').join('')}]`;

/** Taqnyat SMS API (api.taqnyat.sa): POST /v1/messages with a bearer token. */
export function taqnyatAdapter(): ProviderAdapter {
  const authed = (req: MockRequest, ctx: Ctx) => credentialOk(ctx, 'bearerToken', bearerToken(req) ?? str(req.query.bearerTokens));

  return {
    preset: 'taqnyat',
    blockedAt: 'send',
    configFields: [
      { key: 'bearerToken', label: 'Bearer token', hint: 'Optional. When set, any other token gets 401 "invalid credentials information". Empty: any token works.', secret: true },
      DLR_FIELD,
      { key: 'webhookPassPhrase', label: 'Webhook pass phrase', hint: 'Sent as passPhrase in each DLR, like the pass phrase set in the Taqnyat portal.', placeholder: 'stubyard' },
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'GET' && SENDERS.test(req.path)) return { kind: 'account', what: 'senders' };
      if (req.method === 'GET' && BALANCE.test(req.path)) return { kind: 'account', what: 'balance' };
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      return null;
    },

    parse(req, ctx) {
      if (!authed(req, ctx)) return { error: NAMED.auth };
      const f = fields(req);
      const nums = list(f.recipients).map(ksaPhone);
      if (!nums.length || nums.some((n) => !n || n.length < 9)) return { error: NAMED.number };
      const sender = str(f.sender);
      if (!sender) return { error: err(400, 'Sender name is missing') };
      const template = str(f.templateName);
      let body = str(f.body);
      if (!body && template) body = `[template ${template}] ${JSON.stringify(f.variables ?? {})}`;
      if (!body) return { error: err(400, 'Message text is missing') };
      const gate = gccGate(ctx, sender);
      if (gate) return { error: NAMED[gate] };
      return { channel: 'sms', to: nums[0]!, from: sender, body, extra: { recipients: nums } };
    },

    newMessageId: () => String(5_000_000_000 + Math.floor(Math.random() * 999_999_999)),

    accepted(_ctx, m) {
      const nums = (m.parsed.extra?.recipients as string[] | undefined) ?? [m.parsed.to];
      const parts = smsSegments(m.parsed.body).segments;
      return {
        status: 201,
        body: {
          statusCode: 201,
          messageId: Number(m.id),
          cost: Number((0.026 * parts * nums.length).toFixed(3)),
          currency: 'SAR',
          totalCount: nums.length,
          msgLength: parts,
          accepted: printed(nums),
          rejected: '[]',
        },
      };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const named = gccAlias(code);
      if (named) return message ? err(NAMED[named].status, message) : NAMED[named];
      switch (kind) {
        case 'down':
          return err(503, message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(429, message ?? 'Too Many Requests');
        case 'blocked':
        case 'opt_out':
          return err(400, message ?? 'Sending stopped by support');
        default:
          return err(400, message ?? 'Mobile(s) number(s) is not specified or incorrect');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'blocked', message: 'Recipient is blocked' } : { code: 'undelivered', message: 'Recipient unreachable' }),

    notFound: () => err(404, 'Not Found'),

    account(ctx, what, req) {
      if (!authed(req, ctx)) return NAMED.auth;
      if (what === 'balance') {
        const expiry = new Date(Date.now() + 365 * 86_400_000);
        return {
          status: 200,
          body: {
            statusCode: 200,
            accountStatus: 'active',
            accountExpiryDate: `${String(expiry.getUTCDate()).padStart(2, '0')}-${String(expiry.getUTCMonth() + 1).padStart(2, '0')}-${expiry.getUTCFullYear()}`,
            balance: balanceOf(ctx).toFixed(3),
            currency: 'SAR',
          },
        };
      }
      const names = approvedSenders(ctx);
      return {
        status: 201,
        body: { statusCode: 201, senders: (names.length ? names : ['Stubyard']).map((senderName) => ({ senderName, status: 'active', destination: 'KSA' })) },
      };
    },

    // Taqnyat posts status updates to the webhook set in the portal. Payload fields are not documented publicly (assumed).
    statusCallback(ctx, m, status, e, url) {
      if (status !== 'delivered' && status !== 'failed') return null;
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: Number(m.providerMessageId),
          mobile: intl(m.to),
          sender: m.from,
          status: status === 'delivered' ? 'delivered' : 'undelivered',
          errorCode: status === 'failed' ? e?.code ?? '' : '',
          errorMessage: status === 'failed' ? e?.message ?? '' : '',
          dateTime: stamp(),
          passPhrase: cfg(ctx, 'webhookPassPhrase') ?? 'stubyard',
        }),
      };
    },

    inbound(_ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: m.id, mobile: intl(m.from), to: intl(m.to), body: m.text, dateTime: stamp() }),
      };
    },
  };
}
