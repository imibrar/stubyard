import { smsSegments } from '../../messages/sms-segments.js';
import { normalizePhone } from '../../util.js';
import { BALANCE_FIELD, DLR_FIELD, SENDERS_FIELD, balanceOf, basicAuth, credentialOk, gccAlias, gccGate, header, intl, type GccError } from './gcc.js';
import { INBOUND_FIELD, fields, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';

/** SMS API v3 (what the current SDKs call), v2 "advanced" and the old v1 single-text endpoint. */
const V3 = /^\/sms\/3\/messages\/?$/;
const V2 = /^\/sms\/2\/text\/advanced\/?$/;
const V1 = /^\/sms\/1\/text\/(?:single|multi)\/?$/;
const BALANCE = /^\/account\/1\/balance\/?$/;

type Version = 'v1' | 'v2' | 'v3';
const versionOf = (path: string): Version => (V3.test(path) ? 'v3' : V2.test(path) ? 'v2' : 'v1');

/** v3 and newer endpoints use the unified error model {errorCode, description, action, violations, resources}. */
const unified = (status: number, errorCode: string, description: string, action: string): Reply => ({
  status,
  body: { errorCode, description, action, violations: [], resources: [] },
});
/** v1 / v2 endpoints use the legacy model {requestError:{serviceException:{messageId, text}}}. */
const legacy = (status: number, messageId: string, text: string): Reply => ({ status, body: { requestError: { serviceException: { messageId, text } } } });

const authError = (v: Version) =>
  v === 'v3'
    ? unified(401, 'E401', 'The request lacks valid authentication credentials for the requested resource.', 'Check the resources and adjust credentials.')
    : legacy(401, 'UNAUTHORIZED', 'Invalid login details');

interface Status {
  groupId: number;
  groupName: string;
  id: number;
  name: string;
  description: string;
}
const PENDING: Status = { groupId: 1, groupName: 'PENDING', id: 26, name: 'PENDING_ACCEPTED', description: 'Message sent to next instance' };
const DELIVERED: Status = { groupId: 3, groupName: 'DELIVERED', id: 5, name: 'DELIVERED_TO_HANDSET', description: 'Message delivered to handset' };
const NOT_DELIVERED: Status = { groupId: 2, groupName: 'UNDELIVERABLE', id: 9, name: 'UNDELIVERABLE_NOT_DELIVERED', description: 'Message sent not delivered' };
const REJECTED_OPERATOR: Status = { groupId: 2, groupName: 'UNDELIVERABLE', id: 4, name: 'UNDELIVERABLE_REJECTED_OPERATOR', description: 'Message rejected by operator' };
/** Account-state rejections come back as HTTP 200 with a REJECTED status (no message is sent). */
const REJECTED: Record<Exclude<GccError, 'auth'>, Status> = {
  sender: { groupId: 5, groupName: 'REJECTED', id: 11, name: 'REJECTED_SOURCE', description: 'Invalid source address' },
  balance: { groupId: 5, groupName: 'REJECTED', id: 12, name: 'REJECTED_NOT_ENOUGH_CREDITS', description: 'Not enough credits' },
  number: { groupId: 5, groupName: 'REJECTED', id: 52, name: 'REJECTED_DESTINATION', description: 'Invalid destination address' },
};

const digits = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10))).join('');
const newId = () => digits(19);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** The send response: one entry per destination, in the shape of the endpoint version that was called. */
function sendResponse(v: Version, bulkId: string | null, rows: { to: string; id: string; status: Status; parts: number }[]): Reply {
  const messages = rows.map((r) =>
    v === 'v3'
      ? { messageId: r.id, status: r.status, destination: intl(r.to), details: { messageCount: r.parts } }
      : { to: intl(r.to), status: r.status, messageId: r.id, smsCount: r.parts },
  );
  return { status: 200, body: v === 'v1' ? { messages } : { bulkId: bulkId ?? newId(), messages } };
}

function rejected(v: Version, parsed: { to: string; extra?: Record<string, unknown> } | null, kind: Exclude<GccError, 'auth'>, description?: string | null): Reply {
  const status = description ? { ...REJECTED[kind], description } : REJECTED[kind];
  const tos = (parsed?.extra?.recipients as string[] | undefined) ?? (parsed ? [parsed.to] : ['']);
  return sendResponse(v, (parsed?.extra?.bulkId as string | null) ?? null, tos.map((to) => ({ to, id: newId(), status, parts: 0 })));
}

function authed(req: MockRequest, ctx: Ctx): boolean {
  const h = header(req, 'authorization') ?? '';
  const app = /^App\s+(.+)$/i.exec(h);
  if (app) return credentialOk(ctx, 'apiKey', app[1].trim());
  const ib = /^(?:IBSSO|Bearer)\s+(.+)$/i.exec(h);
  if (ib) return credentialOk(ctx, 'apiKey', ib[1].trim());
  const basic = basicAuth(req);
  return basic ? credentialOk(ctx, 'username', basic.user) && credentialOk(ctx, 'password', basic.pass) : false;
}

/** Infobip SMS API (<subdomain>.api.infobip.com): POST /sms/3/messages (also v2 /sms/2/text/advanced) with "Authorization: App <key>". */
export function infobipAdapter(): ProviderAdapter {
  return {
    preset: 'infobip',
    blockedAt: 'delivery',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, any other "Authorization: App <key>" gets 401. Empty: any key works.', secret: true },
      DLR_FIELD,
      BALANCE_FIELD,
      SENDERS_FIELD,
      INBOUND_FIELD,
    ],

    match(req) {
      if (req.method === 'GET' && BALANCE.test(req.path)) return { kind: 'account', what: 'balance' };
      if (req.method === 'POST' && (V3.test(req.path) || V2.test(req.path) || V1.test(req.path))) return { kind: 'send' };
      return null;
    },

    parse(req, ctx) {
      const v = versionOf(req.path);
      if (!authed(req, ctx)) return { error: authError(v) };
      const f = fields(req);
      let sender: string | null;
      let text: string | null;
      let tos: string[];
      let notifyUrl: string | null = null;
      let notify = true;
      let callbackData: string | null = null;
      let bulkId: string | null = str(f.bulkId);
      if (v === 'v1') {
        sender = str(f.from);
        text = str(f.text);
        tos = arr(f.to).map(String);
      } else {
        const m = obj(arr(f.messages)[0]);
        tos = arr(m.destinations).map((d) => String(obj(d).to ?? ''));
        if (v === 'v3') {
          sender = str(m.sender);
          text = str(obj(m.content).text);
          const hooks = obj(m.webhooks);
          const delivery = obj(hooks.delivery);
          notifyUrl = str(delivery.url);
          notify = delivery.notify !== false;
          callbackData = str(hooks.callbackData);
          bulkId = bulkId ?? str(obj(f.options).bulkId);
        } else {
          sender = str(m.from);
          text = str(m.text);
          notifyUrl = str(m.notifyUrl);
          notify = m.notify !== false;
          callbackData = str(m.callbackData);
        }
      }
      if (!tos.length || !text)
        return {
          error:
            v === 'v3'
              ? { status: 400, body: { errorCode: 'E400', description: 'Request cannot be processed.', action: 'Check the syntax, violations and adjust the request.', violations: [{ property: !tos.length ? 'messages[0].destinations' : 'messages[0].content.text', violation: 'must not be empty' }], resources: [] } }
              : legacy(400, 'BAD_REQUEST', 'Bad request'),
        };
      const recipients = tos.map((t) => normalizePhone(t));
      const extra = { version: v, bulkId, recipients: recipients.map((r, i) => r ?? tos[i]!) };
      if (recipients.some((r) => !r || r.length < 8)) return { error: rejected(v, { to: tos[0]!, extra }, 'number') };
      const gate = gccGate(ctx, sender);
      if (gate && gate !== 'auth') return { error: rejected(v, { to: recipients[0]!, extra }, gate) };
      return {
        channel: 'sms',
        to: recipients[0]!,
        from: sender,
        body: text,
        statusCallbackUrl: notifyUrl && /^https?:\/\//i.test(notifyUrl) ? notifyUrl : null,
        extra: { ...extra, metadata: { infobipVersion: v, infobipNotify: notify, callbackData, bulkId } },
      };
    },

    newMessageId: newId,

    accepted(_ctx, m) {
      const parts = smsSegments(m.parsed.body).segments;
      const tos = (m.parsed.extra?.recipients as string[] | undefined) ?? [m.parsed.to];
      const v = (m.parsed.extra?.version as Version | undefined) ?? 'v3';
      const bulkId = (m.parsed.extra?.bulkId as string | null) ?? newId();
      // The first destination is the tracked message; further ones get their own ids.
      return sendResponse(v, bulkId, tos.map((to, i) => ({ to, id: i === 0 ? m.id : newId(), status: PENDING, parts })));
    },

    sendError(_ctx, kind, parsed, code, message) {
      const v = (parsed?.extra?.version as Version | undefined) ?? 'v3';
      const named = gccAlias(code);
      if (named === 'auth') return authError(v);
      if (named) return rejected(v, parsed, named, message);
      switch (kind) {
        case 'down':
          return v === 'v3' ? unified(503, code ?? 'E503', message ?? 'Service unavailable.', 'Retry the request later.') : legacy(503, code ?? 'SERVICE_UNAVAILABLE', message ?? 'Service unavailable');
        case 'rate_limit':
          return v === 'v3' ? unified(429, code ?? 'E429', message ?? 'Too many requests.', 'Reduce the request rate and retry.') : legacy(429, code ?? 'TOO_MANY_REQUESTS', message ?? 'Too many requests');
        default:
          return rejected(v, parsed, 'number', message);
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'EC_CALL_BARRED', message: 'Call Barred' } : { code: 'EC_ABSENT_SUBSCRIBER', message: 'Absent Subscriber' }),

    notFound: (req) =>
      unified(404, 'E404', `${req.method} ${req.path} is not an Infobip SMS endpoint (use POST /sms/3/messages or /sms/2/text/advanced).`, 'Check the request URL.'),

    account(ctx, _what, req) {
      if (!authed(req, ctx)) return authError('v2');
      return { status: 200, body: { balance: balanceOf(ctx), currency: 'EUR' } };
    },

    // Infobip pushes one delivery report per message, with the final status only.
    statusCallback(_ctx, m, status, e, url) {
      if (status !== 'delivered' && status !== 'failed') return null;
      if (m.metadata.infobipNotify === false) return null;
      const v = String(m.metadata.infobipVersion ?? 'v3');
      const parts = smsSegments(m.bodyText ?? '').segments;
      const blocked = e?.code === 'EC_CALL_BARRED';
      const result = {
        bulkId: m.metadata.bulkId ?? null,
        messageId: m.providerMessageId,
        to: intl(m.to),
        ...(v === 'v3' ? { sender: m.from } : {}),
        sentAt: new Date(m.createdAt).toISOString().replace('Z', '+0000'),
        doneAt: new Date().toISOString().replace('Z', '+0000'),
        ...(v === 'v3' ? { messageCount: parts } : { smsCount: parts }),
        mccMnc: null,
        price: { pricePerMessage: 0.01, currency: 'EUR' },
        status: status === 'delivered' ? DELIVERED : blocked ? REJECTED_OPERATOR : NOT_DELIVERED,
        error:
          status === 'delivered'
            ? { groupId: 0, groupName: 'OK', id: 0, name: 'NO_ERROR', description: 'No Error', permanent: false }
            : { groupId: 1, groupName: 'HANDSET_ERRORS', id: blocked ? 13 : 27, name: e?.code ?? 'EC_ABSENT_SUBSCRIBER', description: e?.message ?? 'Absent Subscriber', permanent: blocked },
        ...(m.metadata.callbackData ? { callbackData: m.metadata.callbackData } : {}),
      };
      return { url, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [result] }) };
    },

    inbound(_ctx, m, url) {
      const keyword = (m.text.trim().split(/\s+/)[0] ?? '').toUpperCase();
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            {
              messageId: m.id,
              from: intl(m.from),
              to: intl(m.to),
              text: m.text,
              cleanText: m.text.trim().slice(keyword.length).trim(),
              keyword,
              receivedAt: new Date().toISOString().replace('Z', '+0000'),
              smsCount: 1,
              price: { pricePerMessage: 0, currency: 'EUR' },
              callbackData: null,
            },
          ],
          messageCount: 1,
          pendingMessageCount: 0,
        }),
      };
    },
  };
}
