import { createHmac, randomUUID } from 'node:crypto';
import { smsSegments } from '../../messages/sms-segments.js';
import { normalizePhone } from '../../util.js';
import { BALANCE_FIELD, SENDERS_FIELD, balanceOf, basicAuth, credentialOk, gccAlias, gccGate, intl, pick, type GccError } from './gcc.js';
import { INBOUND_FIELD, STATUS_CALLBACK_FIELD, cfg, fields, form, str, type Ctx, type MockRequest, type OutboundCall, type ProviderAdapter, type Reply } from './types.js';

const SEND = /^\/v1\/Account\/([^/]+)\/Message\/?$/;
const FETCH = /^\/v1\/Account\/([^/]+)\/Message\/([^/]+)\/?$/;
const ACCOUNT = /^\/v1\/Account\/([^/]+)\/?$/;

/** Plivo answers {api_id, error} with a meaningful HTTP status. */
const err = (status: number, error: string): Reply => ({ status, body: { api_id: randomUUID(), error } });

const NAMED: Record<GccError, Reply> = {
  auth: err(401, 'Authentication failed'),
  sender: err(400, 'src is not a valid Plivo number or registered sender ID'),
  balance: err(402, 'insufficient credit'),
  number: err(400, 'invalid destination number'),
};
const named = (k: GccError, message: string | null) => (message ? err(NAMED[k].status, message) : NAMED[k]);

function authed(req: MockRequest, ctx: Ctx, pathAuthId: string): boolean {
  const b = basicAuth(req);
  if (!b || b.user !== pathAuthId) return false;
  return credentialOk(ctx, 'authId', b.user) && credentialOk(ctx, 'authToken', b.pass);
}

/** X-Plivo-Signature-V2: base64(HMAC-SHA256(auth token, URL without query + nonce)), as plivo.utils.validate_signature checks it. */
function signed(ctx: Ctx, url: string): Record<string, string> {
  const token = cfg(ctx, 'authToken');
  if (!token) return {};
  const nonce = String(Math.floor(Math.random() * 1e20)).padStart(20, '0');
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  return { 'x-plivo-signature-v2': createHmac('sha256', token).update(base + nonce).digest('base64'), 'x-plivo-signature-v2-nonce': nonce };
}

/** Callback in Plivo's style: form POST, or a query string when the send asked for method=GET. */
function callback(ctx: Ctx, url: string, method: string, params: Record<string, string | null>): OutboundCall {
  if (method === 'GET') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
    return { url: u.toString(), method: 'GET', headers: signed(ctx, u.toString()), body: '' };
  }
  return { url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(ctx, url) }, body: form(params) };
}

const time = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19) + '+00:00';

/** Plivo Message API (api.plivo.com): POST /v1/Account/{auth_id}/Message/ with Basic auth_id:auth_token. */
export function plivoAdapter(): ProviderAdapter {
  return {
    preset: 'plivo',
    blockedAt: 'delivery',
    configFields: [
      { key: 'authId', label: 'Auth ID', hint: 'Optional. When set, any other auth ID gets 401. Empty: any works (it must match the one in the URL path).' },
      { key: 'authToken', label: 'Auth token', hint: 'Optional. When set: a wrong token gets 401, and callbacks carry X-Plivo-Signature-V2 signed with it.', secret: true },
      STATUS_CALLBACK_FIELD,
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      const f = FETCH.exec(req.path);
      if (req.method === 'GET' && f) return { kind: 'fetch', id: f[2]! };
      if (req.method === 'GET' && ACCOUNT.test(req.path)) return { kind: 'account', what: 'account' };
      return null;
    },

    parse(req, ctx) {
      const authId = SEND.exec(req.path)![1]!;
      if (!authed(req, ctx, authId)) return { error: NAMED.auth };
      const f = fields(req);
      const src = str(pick(f, 'src'));
      const powerpack = str(pick(f, 'powerpack_uuid'));
      if (!src && !powerpack) return { error: err(400, 'Either of src or powerpack_uuid parameter is required') };
      const dst = str(pick(f, 'dst'));
      if (!dst) return { error: err(400, 'Missing mandatory parameter: dst') };
      const text = str(pick(f, 'text'));
      if (!text) return { error: err(400, 'Missing mandatory parameter: text') };
      const nums = dst.split('<').map((d) => normalizePhone(d));
      if (nums.some((n) => !n || n.length < 8)) return { error: NAMED.number };
      const gate = gccGate(ctx, src);
      if (gate) return { error: NAMED[gate] };
      const url = str(pick(f, 'url'));
      const method = (str(pick(f, 'method')) ?? 'POST').toUpperCase();
      return {
        channel: 'sms',
        to: nums[0]!,
        from: src ? (normalizePhone(src) ?? src) : powerpack,
        body: text,
        statusCallbackUrl: url && /^https?:\/\//i.test(url) ? url : null,
        extra: { recipients: nums, metadata: { plivoAuthId: authId, plivoMethod: method === 'GET' ? 'GET' : 'POST',...(powerpack ? { powerpackUuid: powerpack } : {}) } },
      };
    },

    newMessageId: () => randomUUID(),

    accepted(_ctx, m) {
      const nums = (m.parsed.extra?.recipients as string[] | undefined) ?? [m.parsed.to];
      return { status: 202, body: { api_id: randomUUID(), message: 'message(s) queued', message_uuid: nums.map((_, i) => (i === 0 ? m.id : randomUUID())) } };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const n = gccAlias(code);
      if (n) return named(n, message);
      switch (kind) {
        case 'down':
          return err(503, message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(429, message ?? 'too many requests');
        case 'blocked':
        case 'opt_out':
          return err(400, message ?? 'destination number has opted out (STOP)');
        default:
          return named('number', message);
      }
    },

    // Plivo SMS error codes: 70 destination permanently unavailable, 200 blocked by STOP from the destination.
    defaultFailure: (kind) => (kind === 'blocked' ? { code: '200', message: 'Source number blocked by STOP from destination number' } : { code: '70', message: 'Destination Permanently Unavailable' }),

    notFound: () => err(404, 'not found'),

    account(ctx, _what, req) {
      const id = ACCOUNT.exec(req.path)![1]!;
      if (!authed(req, ctx, id)) return NAMED.auth;
      return {
        status: 200,
        body: {
          account_type: 'standard',
          address: '',
          api_id: randomUUID(),
          auth_id: id,
          auto_recharge: false,
          billing_mode: 'prepaid',
          cash_credits: balanceOf(ctx).toFixed(5),
          city: '',
          name: 'stubyard',
          resource_uri: `/v1/Account/${id}/`,
          state: '',
          timezone: 'UTC',
        },
      };
    },

    fetch(_ctx, m, id) {
      if (!m) return err(404, 'not found');
      const units = smsSegments(m.bodyText ?? '').segments;
      const failed = m.status === 'failed';
      return {
        status: 200,
        body: {
          api_id: randomUUID(),
          error_code: failed ? String(m.metadata.errorCode ?? '70') : '',
          from_number: intl(m.from),
          message_direction: 'outbound',
          message_state: failed ? 'undelivered' : m.status === 'delivered' ? 'delivered' : 'queued',
          message_time: time(new Date(m.createdAt)),
          message_type: 'sms',
          message_uuid: id,
          resource_uri: `/v1/Account/${m.metadata.plivoAuthId ?? 'MA'}/Message/${id}/`,
          to_number: intl(m.to),
          total_amount: (0.0035 * units).toFixed(5),
          total_rate: '0.00350',
          units,
        },
      };
    },

    statusCallback(ctx, m, status, e, url) {
      if (status === 'read') return null;
      const units = smsSegments(m.bodyText ?? '').segments;
      const blocked = e?.code === '200';
      const s = status === 'failed' ? (blocked ? 'failed' : 'undelivered') : status;
      return callback(ctx, url, String(m.metadata.plivoMethod ?? 'POST'), {
        From: intl(m.from),
        To: intl(m.to),
        Status: s,
        MessageUUID: m.providerMessageId,
        ParentMessageUUID: m.providerMessageId,
        PartInfo: '1 of 1',
        Sequence: '1',
        ErrorCode: status === 'failed' ? e?.code ?? '70' : '',
        Units: String(units),
        TotalRate: '0.0035',
        TotalAmount: (0.0035 * units).toFixed(4),
        MCC: '310',
        MNC: '260',
        MessageTime: time(),
        PowerpackUUID: m.metadata.powerpackUuid ? String(m.metadata.powerpackUuid) : null,
      });
    },

    inbound(ctx, m, url) {
      return callback(ctx, url, 'POST', {
        From: intl(m.from),
        To: intl(m.to),
        Text: m.text,
        Type: 'sms',
        MessageUUID: m.id,
        Units: '1',
        TotalRate: '0',
        TotalAmount: '0',
        MessageIntent: '',
      });
    },
  };
}
