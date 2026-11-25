import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { smsSegments } from '../../messages/sms-segments.js';
import { normalizePhone } from '../../util.js';
import { BALANCE_FIELD, SENDERS_FIELD, balanceOf, bearerToken, credentialOk, gccAlias, gccGate, type GccError } from './gcc.js';
import { INBOUND_FIELD, STATUS_CALLBACK_FIELD, fields, str, type Ctx, type ProviderAdapter, type Reply } from './types.js';

const SEND = /^\/v2\/messages(?:\/(?:long_code|number_pool|short_code|alphanumeric_sender_id))?\/?$/;
const FETCH = /^\/v2\/messages\/([0-9a-f-]{36})\/?$/i;
const BALANCE = /^\/v2\/balance\/?$/;

/** Telnyx answers {errors:[{code, title, detail, meta:{url}}]}. */
const err = (status: number, code: string, title: string, detail: string, pointer?: string): Reply => ({
  status,
  body: { errors: [{ code, title, detail, ...(pointer ? { source: { pointer } } : {}), meta: { url: `https://developers.telnyx.com/docs/overview/errors/${code}` } }] },
});

const NAMED: Record<GccError, Reply> = {
  auth: err(401, '10009', 'Authentication failed', 'The required authentication headers were either invalid or not included in the request.'),
  sender: err(400, '40305', "Invalid 'from' address", "The 'from' address should be a phone number in +E.164 format, a short code or an alphanumeric sender ID enabled on your account.", '/from'),
  balance: err(403, '20100', 'Insufficient Funds', 'The account does not have sufficient funds to complete this request.'),
  number: err(400, '40310', "Invalid 'to' address", "The 'to' address should be a single valid number.", '/to'),
};
const named = (k: GccError, message: string | null) => {
  if (!message) return NAMED[k];
  const e = (NAMED[k].body as { errors: { code: string; title: string }[] }).errors[0]!;
  return err(NAMED[k].status, e.code, e.title, message);
};

/**
 * Webhook signing key of an instance: an Ed25519 key derived from the instance id, so it is stable without storage.
 * Its public key (base64 of the raw 32 bytes, like the one in the Telnyx portal) goes into TELNYX_PUBLIC_KEY.
 */
function signingKey(instanceId: string): KeyObject {
  const seed = createHash('sha256').update(`stubyard-telnyx-webhook:${instanceId}`).digest();
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}

/** The public key an app verifies stubyard's Telnyx webhooks with (base64, 32 bytes). */
export function telnyxPublicKey(instanceId: string): string {
  const der = createPublicKey(signingKey(instanceId)).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

function signedPost(ctx: Pick<Ctx, 'instance'>, url: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(null, Buffer.from(`${ts}|${body}`), signingKey(ctx.instance.id)).toString('base64');
  return { url, headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts, 'user-agent': 'telnyx-webhooks' }, body };
}

const PROFILE = '400174d8-d2a2-4d5d-9b3c-000000000000';
const ORG = 'b1f2e3d4-0000-4000-8000-000000000000';

interface MsgView {
  id: string;
  from: string | null;
  to: string;
  text: string;
  status: string;
  createdAt: string;
  sentAt?: string | null;
  completedAt?: string | null;
  profile?: string | null;
  webhookUrl?: string | null;
  errors?: unknown[];
  direction?: 'outbound' | 'inbound';
}

/** A Telnyx message record (send response, GET /v2/messages/{id} and webhook payloads). */
function record(v: MsgView) {
  const seg = smsSegments(v.text);
  const alpha = v.from && !/^\+?\d+$/.test(v.from);
  return {
    record_type: 'message',
    direction: v.direction ?? 'outbound',
    id: v.id,
    type: 'SMS',
    messaging_profile_id: v.profile ?? PROFILE,
    organization_id: ORG,
    from: { phone_number: v.from, carrier: alpha ? '' : 'Telnyx', line_type: alpha ? 'AlphanumericSenderID' : 'Wireless' },
    to: [{ phone_number: v.to, status: v.status, carrier: 'T-MOBILE USA, INC.', line_type: 'Wireless' }],
    cc: [],
    text: v.text,
    subject: null,
    media: [],
    webhook_url: v.webhookUrl ?? null,
    webhook_failover_url: null,
    encoding: seg.encoding,
    parts: seg.segments,
    tags: [],
    cost: v.status === 'queued' ? null : { amount: (0.004 * seg.segments).toFixed(4), currency: 'USD' },
    received_at: v.createdAt,
    sent_at: v.sentAt ?? null,
    completed_at: v.completedAt ?? null,
    valid_until: new Date(Date.parse(v.createdAt) + 3600_000).toISOString(),
    errors: v.errors ?? [],
  };
}

const event = (type: string, payload: unknown, url: string) =>
  JSON.stringify({ data: { event_type: type, id: randomUUID(), occurred_at: new Date().toISOString(), payload, record_type: 'event' }, meta: { attempt: 1, delivered_to: url } });

/** Telnyx Messaging API v2 (api.telnyx.com/v2): POST /v2/messages with a bearer API key; webhooks signed with Ed25519. */
export function telnyxAdapter(): ProviderAdapter {
  return {
    preset: 'telnyx',
    blockedAt: 'delivery',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, any other bearer key gets 401 (10009). Empty: any key works.', secret: true },
      {
        ...STATUS_CALLBACK_FIELD,
        label: 'Webhook URL',
        hint: "Your app's messaging webhook (the messaging profile's webhook in real life). A send's webhook_url wins. stubyard POSTs message.sent and message.finalized, signed with Ed25519: the public key (TELNYX_PUBLIC_KEY) is on the Connect tab.",
      },
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      const f = FETCH.exec(req.path);
      if (req.method === 'GET' && f) return { kind: 'fetch', id: f[1]! };
      if (req.method === 'GET' && BALANCE.test(req.path)) return { kind: 'account', what: 'balance' };
      return null;
    },

    parse(req, ctx) {
      if (!credentialOk(ctx, 'apiKey', bearerToken(req))) return { error: NAMED.auth };
      const f = fields(req);
      const rawTo = str(f.to);
      const to = normalizePhone(rawTo);
      if (!to || to.length < 8) return { error: NAMED.number };
      const from = str(f.from);
      const profile = str(f.messaging_profile_id);
      if (!from && !profile) return { error: err(400, '40305', "Invalid 'from' address", "The 'from' address or a messaging_profile_id is required.", '/from') };
      const text = str(f.text);
      if (!text) return { error: err(400, '40306', 'Invalid message body', 'The message body should not be empty.', '/text') };
      const gate = gccGate(ctx, from);
      if (gate) return { error: NAMED[gate] };
      const hook = str(f.webhook_url);
      const sender = from ? (/^\+?\d+$/.test(from) ? normalizePhone(from) : from) : `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      return {
        channel: 'sms',
        to,
        from: sender,
        body: text,
        statusCallbackUrl: hook && /^https?:\/\//i.test(hook) ? hook : null,
        extra: { metadata: { ...(profile ? { telnyxProfileId: profile } : {}), ...(hook ? { telnyxWebhookUrl: hook } : {}) } },
      };
    },

    newMessageId: () => randomUUID(),

    accepted(_ctx, m) {
      const meta = (m.parsed.extra?.metadata as Record<string, string> | undefined) ?? {};
      return {
        status: 200,
        body: { data: record({ id: m.id, from: m.parsed.from, to: m.parsed.to, text: m.parsed.body, status: 'queued', createdAt: m.createdAt, profile: meta.telnyxProfileId, webhookUrl: meta.telnyxWebhookUrl }) },
      };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      const n = gccAlias(code);
      if (n) return named(n, message);
      switch (kind) {
        case 'down':
          return err(503, code ?? '10037', 'Service unavailable', message ?? 'The service is temporarily unavailable. Please try again later.');
        case 'rate_limit':
          return err(429, code ?? '10011', 'Too many requests', message ?? 'You have exceeded the rate limit. Please slow down and retry.');
        case 'blocked':
        case 'opt_out':
          return err(400, code ?? '40300', 'Blocked due to STOP message', message ?? 'The destination number has opted out (STOP) from messages sent from this number.', '/to');
        default:
          return named('number', message);
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: '40300', message: 'Blocked due to STOP message' } : { code: '40008', message: 'Undeliverable' }),

    notFound: (req) => err(404, '10005', 'Resource not found', `${req.method} ${req.path} is not a Telnyx Messaging endpoint (use POST /v2/messages).`),

    account(ctx, _what, req) {
      if (!credentialOk(ctx, 'apiKey', bearerToken(req))) return NAMED.auth;
      const b = balanceOf(ctx);
      return { status: 200, body: { data: { record_type: 'balance', balance: b.toFixed(2), credit_limit: '0.00', available_credit: b.toFixed(2), pending: '0.00', currency: 'USD' } } };
    },

    fetch(_ctx, m, id) {
      if (!m) return err(404, '10005', 'Resource not found', `Message ${id} not found.`);
      const status = m.status === 'delivered' ? 'delivered' : m.status === 'failed' ? 'delivery_failed' : 'queued';
      return {
        status: 200,
        body: {
          data: record({
            id,
            from: m.from,
            to: m.to,
            text: m.bodyText ?? '',
            status,
            createdAt: m.createdAt,
            sentAt: status === 'queued' ? null : m.createdAt,
            profile: m.metadata.telnyxProfileId as string | undefined,
            webhookUrl: m.metadata.telnyxWebhookUrl as string | undefined,
            errors: status === 'delivery_failed' ? [{ code: String(m.metadata.errorCode ?? '40008'), title: String(m.metadata.errorMessage ?? 'Undeliverable') }] : [],
          }),
        },
      };
    },

    // message.sent when the carrier accepts it, then message.finalized with the final to[].status.
    statusCallback(ctx, m, status, e, url) {
      if (status !== 'sent' && status !== 'delivered' && status !== 'failed') return null;
      const now = new Date().toISOString();
      const payload = record({
        id: m.providerMessageId ?? m.id,
        from: m.from,
        to: m.to,
        text: m.bodyText ?? '',
        status: status === 'failed' ? 'delivery_failed' : status,
        createdAt: m.createdAt,
        sentAt: now,
        completedAt: status === 'sent' ? null : now,
        profile: m.metadata.telnyxProfileId as string | undefined,
        webhookUrl: m.metadata.telnyxWebhookUrl as string | undefined,
        errors: status === 'failed' ? [{ code: e?.code ?? '40008', title: e?.message ?? 'Undeliverable', detail: e?.message ?? 'Undeliverable', source: { pointer: '/to/0/phone_number' } }] : [],
      });
      return signedPost(ctx, url, event(status === 'sent' ? 'message.sent' : 'message.finalized', payload, url));
    },

    inbound(ctx, m, url) {
      const payload = { ...record({ id: m.id, from: m.from, to: m.to, text: m.text, status: 'webhook_delivered', createdAt: new Date().toISOString(), direction: 'inbound' }), cost: null };
      return signedPost(ctx, url, event('message.received', payload, url));
    },
  };
}
