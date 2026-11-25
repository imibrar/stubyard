import { randomUUID } from 'node:crypto';
import { normalizePhone } from '../../util.js';
import {
  INBOUND_FIELD,
  READ_RECEIPTS_FIELD,
  STATUS_CALLBACK_FIELD,
  TEMPLATE_FIELDS,
  WINDOW_FIELD,
  cfg,
  fields,
  str,
  type Ctx,
  type MockRequest,
  type ProviderAdapter,
  type Reply,
  type TemplateApi,
  type WaTemplate,
} from './types.js';
import type { WaButton, WaContent } from './wa-content.js';

/**
 * Gupshup WhatsApp API (api.gupshup.io): form-encoded POST /wa/api/v1/msg (also the older /sm/api/v1/msg) and
 * /wa/api/v1/template/msg with an "apikey" header; message-event / message / template-event callbacks in Gupshup's
 * v2 format; template management on /partner/app/{appId}/templates (also /wa/app/{appId}/template).
 * Research notes: docs/plans/research-whatsapp-bsps.md.
 */

const SEND = /^\/(wa|sm)\/api\/v1\/msg\/?$/;
const TEMPLATE_SEND = /^\/wa\/api\/v1\/template\/msg\/?$/;
const TEMPLATES = /^\/(?:partner|wa)\/app\/([^/]+)\/templates?\/?$/;
const TEMPLATE = /^\/(?:partner|wa)\/app\/([^/]+)\/templates?\/([^/]+)\/?$/;

const gsError = (status: number, message: string): Reply => ({ status, body: { status: 'error', message } });

const intl = (p: string | null) => (p ?? '').replace(/^\+/, '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** Form fields carry JSON as strings ("message", "template"). */
function json(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function headerKey(req: MockRequest): string | null {
  for (const k of ['apikey', 'api_key', 'api-key']) {
    const v = req.headers[k];
    const s = str(Array.isArray(v) ? v[0] : v);
    if (s) return s;
  }
  return null;
}

/** A Gupshup "message" object → stubyard's WhatsApp structure. */
function message(raw: unknown): { wa: WaContent; summary: string } | { error: Reply } {
  const m = json(raw);
  if (typeof m === 'string') return m.trim() ? { wa: { type: 'text', text: m }, summary: m } : { error: gsError(400, 'Invalid Message') };
  const o = obj(m);
  const type = str(o.type) ?? 'text';
  switch (type) {
    case 'text': {
      const text = str(o.text);
      if (!text) return { error: gsError(400, 'Invalid Message') };
      if (text.length > 4096) return { error: gsError(400, 'Message too long') };
      return { wa: { type: 'text', text }, summary: text };
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'sticker': {
      const link = str(o.originalUrl) ?? str(o.url);
      if (!link) return { error: gsError(400, 'Invalid Media Url') };
      const kind = type === 'file' ? 'document' : type;
      const caption = str(o.caption);
      const filename = str(o.filename);
      return { wa: { type: kind, caption, media: { link, id: null, filename } }, summary: [`[${kind}]`, caption, filename, link].filter(Boolean).join(' ') };
    }
    case 'location': {
      const lat = Number(o.latitude);
      const lng = Number(o.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: gsError(400, 'Invalid Location') };
      return { wa: { type: 'location', location: { latitude: lat, longitude: lng, name: str(o.name), address: str(o.address) } }, summary: `[location] ${[str(o.name), str(o.address)].filter(Boolean).join(', ')} (${lat}, ${lng})` };
    }
    case 'quick_reply': {
      const c = obj(o.content);
      const body = str(c.text) ?? '';
      const buttons: WaButton[] = arr(o.options).map((x) => ({ id: str(x.postbackText) ?? str(x.title) ?? '', title: str(x.title) ?? '', kind: 'reply' }));
      if (!buttons.length || buttons.length > 3) return { error: gsError(400, 'Quick reply options must have 1 to 3 items') };
      return { wa: { type: 'interactive', interactive: { type: 'button', header: str(c.header), body, footer: str(c.caption), buttons } }, summary: `${body}\n[buttons: ${buttons.map((b) => b.title).join(' | ')}]` };
    }
    case 'list': {
      const body = str(o.body) ?? '';
      const sections = arr(o.items).map((s) => ({
        title: str(s.title),
        rows: arr(s.options).map((r) => ({ id: str(r.postbackText) ?? str(r.title) ?? '', title: str(r.title) ?? '', description: str(r.description) })),
      }));
      if (!sections.length || sections.some((s) => !s.rows.length)) return { error: gsError(400, 'List items must not be empty') };
      const button = str(obj(arr(o.globalButtons)[0]).title) ?? 'Choose';
      return {
        wa: { type: 'interactive', interactive: { type: 'list', header: str(o.title), body, footer: null, listButton: button, sections } },
        summary: `${body}\n[list "${button}": ${sections.flatMap((s) => s.rows.map((r) => r.title)).join(' | ')}]`,
      };
    }
    default:
      return { wa: { type }, summary: `[${type}] ${JSON.stringify(o).slice(0, 200)}` };
  }
}

const gsTemplate = (ctx: Ctx, t: WaTemplate) => {
  const c = obj(t.components[0]);
  return {
    appId: cfg(ctx, 'appId') ?? 'stubyard-app',
    category: t.category,
    createdOn: Date.parse(t.createdAt),
    data: str(c.content) ?? '',
    elementName: t.name,
    id: t.id,
    languageCode: t.language,
    languagePolicy: 'deterministic',
    meta: JSON.stringify({ example: str(c.example) ?? '' }),
    modifiedOn: Date.parse(t.updatedAt),
    namespace: 'stubyard',
    status: t.status,
    templateType: str(c.templateType) ?? 'TEXT',
    vertical: str(c.vertical) ?? '',
    quality: t.quality,
    ...(t.status === 'REJECTED' ? { reason: t.reason ?? 'INVALID_FORMAT' } : {}),
  };
};

export function gupshupAdapter(): ProviderAdapter {
  const event = (ctx: Ctx, type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ app: cfg(ctx, 'appName') ?? 'stubyard', timestamp: Date.now(), version: 2, type, payload });

  const templates: TemplateApi = {
    newId: () => randomUUID(),
    parseCreate(req) {
      const f = fields(req);
      const name = str(f.elementName);
      const language = str(f.languageCode);
      const category = str(f.category);
      const contentText = str(f.content);
      if (!name) return { error: gsError(400, 'elementName is required') };
      if (!/^[a-z0-9_]{1,512}$/.test(name)) return { error: gsError(400, 'Invalid elementName: use lowercase letters, numbers and underscores') };
      if (!language) return { error: gsError(400, 'languageCode is required') };
      if (!category || !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category.toUpperCase())) return { error: gsError(400, 'Invalid category') };
      if (!contentText && category.toUpperCase() !== 'AUTHENTICATION') return { error: gsError(400, 'content is required') };
      return { name, language, category: category.toUpperCase(), components: [{ content: contentText, example: str(f.example), templateType: str(f.templateType) ?? 'TEXT', vertical: str(f.vertical), buttons: json(f.buttons) ?? null }] };
    },
    created: (ctx, t) => ({ status: 200, body: { status: 'success', template: gsTemplate(ctx, t) } }),
    list: (ctx, list) => ({ status: 200, body: { status: 'success', templates: list.map((t) => gsTemplate(ctx, t)) } }),
    get: (ctx, t) => (t ? { status: 200, body: { status: 'success', template: gsTemplate(ctx, t) } } : gsError(404, 'Template not found')),
    deleted: (_ctx, n) => (n ? { status: 200, body: { status: 'success' } } : gsError(400, 'Template does not exist')),
    statusWebhook(ctx, t, change, url) {
      const body =
        change.kind === 'quality'
          ? event(ctx, 'template-event', { id: t.id, elementName: t.name, languageCode: t.language, status: t.status.toLowerCase(), quality: t.quality, previousQuality: change.previous })
          : event(ctx, 'template-event', { id: t.id, elementName: t.name, languageCode: t.language, status: t.status.toLowerCase(), ...(t.status === 'REJECTED' ? { rejectedReason: t.reason ?? 'INVALID_FORMAT' } : {}) });
      return { url, headers: { 'content-type': 'application/json' }, body };
    },
  };

  return {
    preset: 'gupshup',
    blockedAt: 'delivery',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, any other "apikey" header gets 401 "Authentication Failed". Empty: any key works.', secret: true },
      { key: 'appName', label: 'App name (src.name)', hint: 'Shown as "app" in callbacks.', placeholder: 'MyGupshupApp' },
      { key: 'fromNumber', label: 'Source number', hint: 'Your WhatsApp Business number (where replies are addressed).', placeholder: '917834811114' },
      { ...STATUS_CALLBACK_FIELD, label: 'Callback URL', hint: "Your app's Gupshup callback URL: message events (enqueued / sent / delivered / read / failed) and template events go here." },
      { ...INBOUND_FIELD, hint: 'Where replies go (type "message"). Empty: the callback URL above, like Gupshup (one callback URL per app).' },
      READ_RECEIPTS_FIELD,
      WINDOW_FIELD,
      ...TEMPLATE_FIELDS,
    ],
    singleWebhook: true,

    match(req, ctx) {
      const key = headerKey(req);
      const want = cfg(ctx, 'apiKey');
      if (!key || (want && key !== want)) return { kind: 'account', what: 'unauthorized' };
      if (req.method === 'POST' && (SEND.test(req.path) || TEMPLATE_SEND.test(req.path))) return { kind: 'send' };
      if (TEMPLATES.test(req.path)) {
        if (req.method === 'POST') return { kind: 'template', op: 'create' };
        if (req.method === 'GET') return { kind: 'template', op: 'list' };
      }
      const one = TEMPLATE.exec(req.path);
      if (one && req.method === 'GET') return { kind: 'template', op: 'get', id: decodeURIComponent(one[2]) };
      if (one && req.method === 'DELETE') return { kind: 'template', op: 'delete', name: decodeURIComponent(one[2]) };
      return null;
    },

    // Gupshup answers a bad or missing key with 401 and this text.
    account: () => gsError(401, 'Authentication Failed'),

    parse(req) {
      const f = fields(req);
      const source = str(f.source);
      if (!source) return { error: gsError(400, 'Invalid Source') };
      const rawTo = str(f.destination);
      const to = rawTo ? normalizePhone(rawTo) : null;
      if (!to) return { error: gsError(400, 'Invalid Destination') };
      let c: { wa: WaContent; summary: string } | { error: Reply };
      let templateId: string | null = null;
      if (TEMPLATE_SEND.test(req.path)) {
        const t = obj(json(f.template));
        templateId = str(t.id);
        if (!templateId) return { error: gsError(400, 'Invalid Template') };
        const params = (Array.isArray(t.params) ? t.params : []).map((p) => (p === null || p === undefined ? null : String(p)));
        c = { wa: { type: 'template', template: { name: templateId, language: null, buttons: [], params }, text: params.join(' ') || null }, summary: `[template ${templateId}] ${params.join(' ')}`.trim() };
      } else {
        if (f.message === undefined || f.message === null || f.message === '') return { error: gsError(400, 'Invalid Message') };
        c = message(f.message);
      }
      if ('error' in c) return { error: c.error };
      return {
        channel: 'whatsapp',
        to,
        from: '+' + intl(source),
        body: c.summary,
        extra: { type: c.wa.type, wa: c.wa, templateRef: templateId ? { id: templateId } : null },
      };
    },

    windowError: { code: '470', message: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number' },
    isTemplate: (parsed) => parsed.extra?.type === 'template',
    // The template is sent by id; Gupshup reports an unknown / unapproved template as a failed message event.
    templateRefused: (_ctx, problem) => ({
      failure:
        problem === 'paused'
          ? { code: '132015', message: 'Template is paused due to low quality' }
          : problem === 'disabled'
            ? { code: '132016', message: 'Template is disabled' }
            : { code: '132001', message: 'Template does not exist or is not approved' },
    }),
    templates,

    newMessageId: () => randomUUID(),

    accepted: (_ctx, m) => ({ status: 202, body: { status: 'submitted', messageId: m.id } }),

    sendError(_ctx, kind, _parsed, _code, message) {
      switch (kind) {
        case 'down':
          return gsError(503, message ?? 'Service Unavailable');
        case 'rate_limit':
          return gsError(429, message ?? 'Too Many Requests');
        default:
          return gsError(400, message ?? 'Invalid Destination');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: '1002', message: 'Number Does Not Exists On WhatsApp' } : { code: '1002', message: 'Number Does Not Exists On WhatsApp' }),

    notFound: (req) => gsError(404, `${req.method} ${req.path} is not a Gupshup endpoint (use POST /wa/api/v1/msg)`),

    statusCallback(ctx, m, status, e, url) {
      const st = status === 'queued' ? 'enqueued' : status;
      const inner =
        st === 'failed'
          ? { code: Number(e?.code) || 1002, reason: e?.message ?? 'Number Does Not Exists On WhatsApp' }
          : st === 'enqueued' || st === 'sent'
            ? { ts: Math.floor(Date.now() / 1000), whatsappMessageId: `gBEGkZ${m.id.replace(/-/g, '').slice(0, 20)}`, type: m.metadata.wa && (m.metadata.wa as WaContent).type === 'template' ? 'template' : 'session' }
            : { ts: Math.floor(Date.now() / 1000) };
      const body = event(ctx, 'message-event', { id: m.providerMessageId, gsId: m.providerMessageId, type: st, destination: intl(m.to), payload: inner });
      return { url, headers: { 'content-type': 'application/json' }, body };
    },

    inbound(ctx, m, url) {
      const phone = intl(m.from);
      const payload = m.reply
        ? m.reply.kind === 'list_reply'
          ? { type: 'list_reply', payload: { title: m.reply.title, id: m.reply.id, reply: m.reply.title, postbackText: m.reply.id, ...(m.reply.description ? { description: m.reply.description } : {}) } }
          : m.reply.kind === 'button'
            ? { type: 'quick_reply', payload: { text: m.reply.title, type: 'button' } }
            : { type: 'button_reply', payload: { title: m.reply.title, id: m.reply.id, reply: m.reply.title, postbackText: m.reply.id } }
        : { type: 'text', payload: { text: m.text } };
      const body = event(ctx, 'message', {
        id: m.id,
        source: phone,
        ...payload,
        sender: { phone, name: m.profileName, country_code: '', dial_code: phone },
        ...(m.context ? { context: { id: m.context.id, gsId: m.context.id } } : {}),
      });
      return { url, headers: { 'content-type': 'application/json' }, body };
    },
  };
}
