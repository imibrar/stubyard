import type { Channel } from '../catalog.js';
import { normalizePhone } from '../../util.js';
import { INBOUND_FIELD, STATUS_CALLBACK_FIELD, cfg, fields, randomHex, str, type Ctx, type ProviderAdapter, type Reply } from './types.js';

const TO_KEYS = ['to', 'recipient', 'phone', 'msisdn', 'number', 'destination', 'mobile'];
const FROM_KEYS = ['from', 'sender', 'sender_id', 'senderId', 'source'];
const BODY_KEYS = ['message', 'text', 'body', 'content', 'msg', 'sms'];

export const GENERIC_DEFAULTS = {
  path: '',
  successStatus: '200',
  successTemplate: '{"id":"{{id}}","status":"queued","to":"{{to}}"}',
  errorTemplate: '{"error":{"code":"{{errorCode}}","message":"{{errorMessage}}"}}',
  callbackTemplate: '{"id":"{{id}}","status":"{{status}}","to":"{{to}}","errorCode":"{{errorCode}}","errorMessage":"{{errorMessage}}","timestamp":"{{timestamp}}"}',
  inboundTemplate: '{"id":"{{id}}","from":"{{from}}","to":"{{to}}","message":"{{body}}","timestamp":"{{timestamp}}"}',
};

/** Read "a.b.0.c" from an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Fill {{var}} placeholders; values are JSON-escaped so the result stays valid JSON. */
export function fillTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => JSON.stringify(vars[k] ?? '').slice(1, -1));
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Any HTTP SMS/WhatsApp API, configured in the dashboard: which fields hold to/from/message,
 * and templates for the responses, status callbacks and inbound messages.
 */
export function genericAdapter(preset: 'generic-sms' | 'generic-whatsapp'): ProviderAdapter {
  const channel: Channel = preset === 'generic-whatsapp' ? 'whatsapp' : 'sms';
  const c = (ctx: Ctx, k: keyof typeof GENERIC_DEFAULTS) => cfg(ctx, k) ?? GENERIC_DEFAULTS[k];

  const find = (f: Record<string, unknown>, configured: string | null, keys: string[]) => {
    if (configured) return str(getPath(f, configured));
    for (const k of keys) {
      const v = str(f[k]);
      if (v) return v;
    }
    return null;
  };

  const error = (ctx: Ctx, status: number, code: string, message: string): Reply => ({
    status,
    body: parseBody(fillTemplate(c(ctx, 'errorTemplate'), { errorCode: code, errorMessage: message })),
  });

  return {
    preset,
    blockedAt: 'send',
    configFields: [
      { key: 'path', label: 'Send path', hint: 'Path after the instance URL, e.g. /api/send. Empty = any path.', placeholder: '/api/send' },
      { key: 'toField', label: '"To" field', hint: 'JSON path or form field. Empty = to / recipient / phone / msisdn…', placeholder: 'to' },
      { key: 'fromField', label: '"From" field', placeholder: 'from' },
      { key: 'bodyField', label: 'Message field', hint: 'Empty = message / text / body / content…', placeholder: 'message' },
      { key: 'successStatus', label: 'Success HTTP status', placeholder: '200' },
      { key: 'successTemplate', label: 'Success response', hint: 'Variables: {{id}} {{to}} {{from}} {{body}} {{timestamp}}', multiline: true, placeholder: GENERIC_DEFAULTS.successTemplate },
      { key: 'errorTemplate', label: 'Error response', hint: 'Variables: {{errorCode}} {{errorMessage}}', multiline: true, placeholder: GENERIC_DEFAULTS.errorTemplate },
      { key: 'callbackTemplate', label: 'Status callback body', hint: '{{status}} is queued / sent / delivered / failed', multiline: true, placeholder: GENERIC_DEFAULTS.callbackTemplate },
      { key: 'inboundTemplate', label: 'Inbound message body', multiline: true, placeholder: GENERIC_DEFAULTS.inboundTemplate },
      STATUS_CALLBACK_FIELD,
      INBOUND_FIELD,
    ],

    match(req, ctx) {
      if (req.method === 'GET' || req.method === 'HEAD') return null;
      const path = cfg(ctx, 'path');
      if (!path) return { kind: 'send' };
      const norm = (p: string) => '/' + p.replace(/^\/+|\/+$/g, '');
      return norm(req.path) === norm(path) ? { kind: 'send' } : null;
    },

    parse(req, ctx) {
      const f = fields(req);
      const rawTo = find(f, cfg(ctx, 'toField'), TO_KEYS);
      if (!rawTo) return { error: error(ctx, 400, 'missing_to', `No recipient found (looked for ${cfg(ctx, 'toField') ?? TO_KEYS.join(', ')})`) };
      const to = normalizePhone(rawTo);
      if (!to) return { error: error(ctx, 400, 'invalid_to', `Invalid recipient "${rawTo}"`) };
      const body = find(f, cfg(ctx, 'bodyField'), BODY_KEYS);
      if (!body) return { error: error(ctx, 400, 'missing_message', `No message text found (looked for ${cfg(ctx, 'bodyField') ?? BODY_KEYS.join(', ')})`) };
      const from = find(f, cfg(ctx, 'fromField'), FROM_KEYS);
      return { channel, to, from: from ? normalizePhone(from) ?? from : null, body };
    },

    newMessageId: () => 'msg_' + randomHex(20),

    accepted(ctx, m) {
      const text = fillTemplate(c(ctx, 'successTemplate'), { id: m.id, to: m.parsed.to, from: m.parsed.from, body: m.parsed.body, timestamp: m.createdAt });
      return { status: Number(c(ctx, 'successStatus')) || 200, body: parseBody(text) };
    },

    sendError(ctx, kind, _parsed, code, message) {
      switch (kind) {
        case 'down':
          return error(ctx, 503, code ?? 'service_unavailable', message ?? 'Service unavailable');
        case 'rate_limit':
          return error(ctx, 429, code ?? 'rate_limited', message ?? 'Too many requests');
        case 'blocked':
          return error(ctx, 400, code ?? 'blocked', message ?? 'Recipient is blocked');
        case 'opt_out':
          return error(ctx, 400, code ?? 'opted_out', message ?? 'Recipient opted out of marketing messages');
        default:
          return error(ctx, 400, code ?? 'rejected', message ?? 'Message rejected');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: 'blocked', message: 'Recipient is blocked' } : { code: 'undeliverable', message: 'Recipient unreachable' }),

    notFound: (req) => ({ status: 404, body: { error: { code: 'not_found', message: `No send endpoint at ${req.method} ${req.path}` } } }),

    statusCallback(ctx, m, status, e, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: fillTemplate(c(ctx, 'callbackTemplate'), {
          id: m.providerMessageId,
          status,
          to: m.to,
          from: m.from,
          errorCode: e?.code,
          errorMessage: e?.message,
          timestamp: new Date().toISOString(),
        }),
      };
    },

    inbound(ctx, m, url) {
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: fillTemplate(c(ctx, 'inboundTemplate'), { id: m.id, from: m.from, to: m.to, body: m.text, timestamp: new Date().toISOString(), name: m.profileName }),
      };
    },
  };
}
