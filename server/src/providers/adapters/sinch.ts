import { normalizePhone } from '../../util.js';
import { BALANCE_FIELD, DLR_FIELD, SENDERS_FIELD, bearerToken, credentialOk, gccAlias, gccGate, intl, list, type GccError } from './gcc.js';
import { INBOUND_FIELD, cfg, fields, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

const SEND = /^\/xms\/v1\/([^/]+)\/batches\/?$/;
const FETCH = /^\/xms\/v1\/([^/]+)\/batches\/([^/]+)\/?$/;

/** Sinch answers {code, text}. */
const err = (status: number, code: string, text: string): Reply => ({ status, body: { code, text } });

const NAMED: Record<GccError, Reply> = {
  auth: err(401, 'unauthorized', 'Authentication token is invalid for this service plan.'),
  sender: err(400, 'syntax_invalid_parameter_format', 'Invalid sender address.'),
  balance: err(403, 'blocked_account', 'Account is blocked: not enough credit.'),
  number: err(400, 'syntax_invalid_parameter_format', 'Unable to parse recipient address.'),
};
const named = (k: GccError, message: string | null) => (message ? err(NAMED[k].status, (NAMED[k].body as { code: string }).code, message) : NAMED[k]);

const REPORTS = ['none', 'summary', 'full', 'per_recipient', 'per_recipient_final'];

/** Batch ids are 26-character ULIDs (Crockford base32). */
const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => {
  let t = Date.now();
  let s = '';
  for (let i = 0; i < 10; i++) {
    s = ULID[t % 32] + s;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) s += ULID[Math.floor(Math.random() * 32)];
  return s;
};

function authed(req: MockRequest, ctx: Ctx, plan: string): boolean {
  return credentialOk(ctx, 'servicePlanId', plan) && credentialOk(ctx, 'apiToken', bearerToken(req));
}

/** Sinch SMS REST API (<region>.sms.api.sinch.com): POST /xms/v1/{service_plan_id}/batches with a bearer token. */
export function sinchAdapter(): ProviderAdapter {
  return {
    preset: 'sinch',
    blockedAt: 'delivery',
    configFields: [
      { key: 'servicePlanId', label: 'Service plan ID', hint: 'Optional. When set, any other service plan ID in the path gets 401. Empty: any works.' },
      { key: 'apiToken', label: 'API token', hint: 'Optional. When set, any other bearer token gets 401. Empty: any token works.', secret: true },
      {
        ...DLR_FIELD,
        hint: "Your app's delivery report webhook (the default callback URL of the service plan). A batch's callback_url wins. Sinch sends reports only when the batch asks for them (delivery_report other than \"none\").",
      },
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      const f = FETCH.exec(req.path);
      if (req.method === 'GET' && f) return { kind: 'fetch', id: f[2]! };
      return null;
    },

    parse(req, ctx) {
      if (!authed(req, ctx, SEND.exec(req.path)![1]!)) return { error: NAMED.auth };
      if (req.body === undefined || Buffer.isBuffer(req.body) || typeof req.body !== 'object') return { error: err(400, 'syntax_invalid_json', 'The JSON input is invalid.') };
      const f = fields(req);
      const to = list(f.to);
      if (!to.length) return { error: err(400, 'syntax_constraint_violation', 'to: must contain at least one recipient') };
      const body = str(f.body);
      if (body === null) return { error: err(400, 'syntax_constraint_violation', 'body: may not be null') };
      const from = str(f.from);
      const report = str(f.delivery_report) ?? 'none';
      if (!REPORTS.includes(report)) return { error: err(400, 'syntax_invalid_parameter_format', `Invalid delivery_report: ${report}`) };
      const callbackUrl = str(f.callback_url);
      if (report !== 'none' && !callbackUrl && !cfg(ctx, 'statusCallbackUrl')) return { error: err(403, 'missing_callback_url', 'Requesting delivery report without any callback URL.') };
      const nums = to.map((t) => normalizePhone(t));
      if (nums.some((n) => !n || n.length < 8)) return { error: NAMED.number };
      const gate = gccGate(ctx, from);
      if (gate) return { error: NAMED[gate] };
      const clientReference = str(f.client_reference);
      return {
        channel: 'sms',
        to: nums[0]!,
        from: from ? (normalizePhone(from) ?? from) : null,
        body,
        statusCallbackUrl: callbackUrl && /^https?:\/\//i.test(callbackUrl) ? callbackUrl : null,
        extra: {
          recipients: nums,
          sender: from,
          batch: { type: str(f.type) ?? 'mt_text', flash_message: f.flash_message === true, feedback_enabled: f.feedback_enabled === true, callback_url: callbackUrl },
          metadata: { sinchDeliveryReport: report, ...(clientReference ? { clientReference } : {}) },
        },
      };
    },

    newMessageId: ulid,

    accepted(_ctx, m) {
      const nums = (m.parsed.extra?.recipients as string[] | undefined) ?? [m.parsed.to];
      const batch = (m.parsed.extra?.batch as Record<string, unknown> | undefined) ?? {};
      const meta = (m.parsed.extra?.metadata as Record<string, unknown> | undefined) ?? {};
      const created = new Date(m.createdAt);
      return {
        status: 201,
        body: {
          id: m.id,
          to: nums.map(intl),
          from: (m.parsed.extra?.sender as string | null) ?? '',
          canceled: false,
          body: m.parsed.body,
          type: batch.type ?? 'mt_text',
          created_at: created.toISOString(),
          modified_at: created.toISOString(),
          delivery_report: meta.sinchDeliveryReport ?? 'none',
          expire_at: new Date(created.getTime() + 3 * 86_400_000).toISOString(),
          flash_message: batch.flash_message ?? false,
          feedback_enabled: batch.feedback_enabled ?? false,
          ...(batch.callback_url ? { callback_url: batch.callback_url } : {}),
          ...(meta.clientReference ? { client_reference: meta.clientReference } : {}),
        },
      };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const n = gccAlias(code);
      if (n) return named(n, message);
      switch (kind) {
        case 'down':
          return err(503, code ?? 'service_unavailable', message ?? 'Service temporarily unavailable.');
        case 'rate_limit':
          return err(429, code ?? 'too_many_requests', message ?? 'Too many requests.');
        case 'blocked':
        case 'opt_out':
          return err(403, code ?? 'forbidden', message ?? 'Recipient is blocked.');
        default:
          return named('number', message);
      }
    },

    // Delivery report codes: 402 "Message unroutable", 413 "Blocked" (Sinch delivery report error codes).
    defaultFailure: (kind) => (kind === 'blocked' ? { code: '413', message: 'Blocked' } : { code: '402', message: 'Message unroutable' }),

    notFound: (req) => err(404, 'not_found', `${req.method} ${req.path} is not a Sinch SMS endpoint (use POST /xms/v1/{service_plan_id}/batches).`),

    fetch(_ctx, m, id) {
      if (!m) return err(404, 'not_found', `Batch ${id} not found.`);
      return {
        status: 200,
        body: {
          id,
          to: [intl(m.to)],
          from: m.from ?? '',
          canceled: false,
          body: m.bodyText ?? '',
          type: 'mt_text',
          created_at: m.createdAt,
          modified_at: m.createdAt,
          delivery_report: m.metadata.sinchDeliveryReport ?? 'none',
          expire_at: new Date(Date.parse(m.createdAt) + 3 * 86_400_000).toISOString(),
          flash_message: false,
          feedback_enabled: false,
        },
      };
    },

    // Reports follow the batch's delivery_report: none (no callback), summary / full (one summary at the end),
    // per_recipient (Dispatched, then the final status), per_recipient_final (final status only).
    statusCallback(_ctx, m, status, e, url) {
      const mode = String(m.metadata.sinchDeliveryReport ?? 'none');
      if (mode === 'none' || status === 'read' || status === 'queued') return null;
      const final = status === 'delivered' || status === 'failed';
      if (!final && mode !== 'per_recipient') return null;
      const st =
        status === 'sent' ? { status: 'Dispatched', code: 401 } : status === 'delivered' ? { status: 'Delivered', code: 0 } : { status: e?.code === '413' ? 'Rejected' : 'Failed', code: Number(e?.code) || 402 };
      const ref = m.metadata.clientReference ? { client_reference: m.metadata.clientReference } : {};
      const now = new Date().toISOString();
      const body =
        mode === 'per_recipient' || mode === 'per_recipient_final'
          ? { type: 'recipient_delivery_report_sms', batch_id: m.providerMessageId, recipient: intl(m.to), code: st.code, status: st.status, at: now, operator_status_at: now, ...ref }
          : {
              type: 'delivery_report_sms',
              batch_id: m.providerMessageId,
              total_message_count: 1,
              statuses: [{ code: st.code, status: st.status, count: 1, ...(mode === 'full' ? { recipients: [intl(m.to)] } : {}) }],
              ...ref,
            };
      return { url, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    },

    inbound(_ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'mo_text', id: m.id, from: intl(m.from), to: intl(m.to), body: m.text, received_at: new Date().toISOString(), operator_id: '31000' }),
      };
    },
  };
}
