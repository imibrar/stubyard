import { randomInt, randomUUID } from 'node:crypto';
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
 * Infobip WhatsApp API (<base>.api.infobip.com): POST /whatsapp/1/message/{text,image,…,template}, "App <key>" auth,
 * delivery reports, seen reports and inbound messages in Infobip's {results:[…]} format, and template management on
 * /whatsapp/2/senders/{sender}/templates. Research notes: docs/plans/research-whatsapp-bsps.md.
 */

const SEND = /^\/whatsapp\/1\/message\/(text|image|document|audio|video|sticker|location|contact|interactive\/buttons|interactive\/list|template)\/?$/;
const TEMPLATES = /^\/whatsapp\/[12]\/senders\/([^/]+)\/templates\/?$/;
const TEMPLATE = /^\/whatsapp\/[12]\/senders\/([^/]+)\/templates\/([^/]+)\/?$/;

const serviceError = (status: number, messageId: string, text: string, validationErrors?: Record<string, string[]>): Reply => ({
  status,
  body: { requestError: { serviceException: { messageId, text, ...(validationErrors ? { validationErrors } : {}) } } },
});
const badRequest = (field: string, problem: string) => serviceError(400, 'BAD_REQUEST', 'Bad request', { [field]: [problem] });

const intl = (p: string | null) => (p ?? '').replace(/^\+/, '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

const PENDING = { groupId: 1, groupName: 'PENDING', id: 7, name: 'PENDING_ENROUTE', description: 'Message sent to next instance' };

function authorized(req: MockRequest, ctx: Ctx): boolean {
  const v = req.headers.authorization;
  const h = str(Array.isArray(v) ? v[0] : v);
  const m = h ? /^(App|Basic|Bearer|IBSSO)\s+(.+)$/i.exec(h) : null;
  if (!m) return false;
  const want = cfg(ctx, 'apiKey');
  return !want || (m[1].toLowerCase() === 'app' && m[2].trim() === want);
}

/** Message content → stubyard's WhatsApp structure (so the dashboard shows buttons and replies can tap them). */
function content(kind: string, c: Record<string, unknown>): { wa: WaContent; summary: string } | { error: Reply } {
  switch (kind) {
    case 'text': {
      const text = str(c.text);
      if (!text) return { error: badRequest('content.text', 'must not be blank') };
      if (text.length > 4096) return { error: badRequest('content.text', 'size must be between 1 and 4096') };
      return { wa: { type: 'text', text }, summary: text };
    }
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      const link = str(c.mediaUrl);
      if (!link) return { error: badRequest('content.mediaUrl', 'must not be blank') };
      const caption = str(c.caption);
      const filename = str(c.filename);
      return { wa: { type: kind, caption, media: { link, id: null, filename } }, summary: [`[${kind}]`, caption, filename, link].filter(Boolean).join(' ') };
    }
    case 'location': {
      const lat = Number(c.latitude);
      const lng = Number(c.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: badRequest('content.latitude', 'must not be null') };
      const name = str(c.name);
      const address = str(c.address);
      return { wa: { type: 'location', location: { latitude: lat, longitude: lng, name, address } }, summary: `[location] ${[name, address].filter(Boolean).join(', ')} (${lat}, ${lng})` };
    }
    case 'interactive/buttons': {
      const body = str(obj(c.body).text);
      if (!body) return { error: badRequest('content.body.text', 'must not be blank') };
      const raw = arr(obj(c.action).buttons);
      if (raw.length < 1 || raw.length > 3) return { error: badRequest('content.action.buttons', 'size must be between 1 and 3') };
      const buttons: WaButton[] = raw.map((b) => ({ id: str(b.id) ?? '', title: str(b.title) ?? '', kind: 'reply' }));
      if (buttons.some((b) => !b.id || !b.title)) return { error: badRequest('content.action.buttons', 'id and title must not be blank') };
      return {
        wa: { type: 'interactive', interactive: { type: 'button', header: str(obj(c.header).text), body, footer: str(obj(c.footer).text), buttons } },
        summary: `${body}\n[buttons: ${buttons.map((b) => b.title).join(' | ')}]`,
      };
    }
    case 'interactive/list': {
      const body = str(obj(c.body).text);
      if (!body) return { error: badRequest('content.body.text', 'must not be blank') };
      const action = obj(c.action);
      const sections = arr(action.sections).map((s) => ({ title: str(s.title), rows: arr(s.rows).map((r) => ({ id: str(r.id) ?? '', title: str(r.title) ?? '', description: str(r.description) })) }));
      if (!sections.length || sections.some((s) => !s.rows.length)) return { error: badRequest('content.action.sections', 'must not be empty') };
      const button = str(action.title) ?? 'Choose';
      return {
        wa: { type: 'interactive', interactive: { type: 'list', header: str(obj(c.header).text), body, footer: str(obj(c.footer).text), listButton: button, sections } },
        summary: `${body}\n[list "${button}": ${sections.flatMap((s) => s.rows.map((r) => r.title)).join(' | ')}]`,
      };
    }
    case 'template': {
      const name = str(c.templateName);
      if (!name) return { error: badRequest('messages[0].content.templateName', 'must not be blank') };
      const language = str(c.language);
      if (!language) return { error: badRequest('messages[0].content.language', 'must not be blank') };
      const data = obj(c.templateData);
      const params = arr(obj(data.body).placeholders).map((p) => (p === null || p === undefined ? null : String(p)));
      const buttons: WaButton[] = arr(data.buttons)
        .filter((b) => String(b.type ?? '').toUpperCase() === 'QUICK_REPLY')
        .map((b) => ({ id: str(b.parameter) ?? '', title: str(b.parameter) ?? '', kind: 'quick_reply' as const }));
      return {
        wa: { type: 'template', template: { name, language, buttons, params }, text: params.join(' ') || null },
        summary: `[template ${name} · ${language}] ${params.join(' ')}`.trim(),
      };
    }
    default:
      return { wa: { type: kind }, summary: `[${kind}] ${JSON.stringify(c).slice(0, 200)}` };
  }
}

const infobipTemplate = (t: WaTemplate) => ({
  id: t.id,
  businessAccountId: 200000000000002,
  name: t.name,
  language: t.language,
  status: t.status,
  category: t.category,
  structure: t.components[0] ?? {},
  quality: t.quality,
  ...(t.reason && t.status === 'REJECTED' ? { rejectionReason: t.reason } : {}),
});

export function infobipWhatsappAdapter(): ProviderAdapter {
  const templates: TemplateApi = {
    newId: () => String(randomInt(1, 10)) + Array.from({ length: 15 }, () => randomInt(0, 10)).join(''),
    parseCreate(req) {
      const b = fields(req);
      const name = str(b.name);
      const language = str(b.language);
      const category = str(b.category);
      if (!name) return { error: badRequest('name', 'must not be blank') };
      if (!/^[a-z0-9_]{1,512}$/.test(name)) return { error: badRequest('name', 'must contain only lowercase alphanumeric characters and underscores') };
      if (!language) return { error: badRequest('language', 'must not be null') };
      if (!category || !['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category.toUpperCase())) return { error: badRequest('category', 'must be one of [MARKETING, UTILITY, AUTHENTICATION]') };
      const structure = obj(b.structure);
      if (!str(obj(structure.body).text) && category.toUpperCase() !== 'AUTHENTICATION') return { error: badRequest('structure.body', 'must not be null') };
      return { name, language, category: category.toUpperCase(), components: [structure] };
    },
    created: (_ctx, t) => ({ status: 201, body: infobipTemplate(t) }),
    list: (_ctx, list) => ({ status: 200, body: { templates: list.map(infobipTemplate) } }),
    get: (_ctx, t) => (t ? { status: 200, body: infobipTemplate(t) } : serviceError(404, 'NOT_FOUND', 'Template not found')),
    deleted: (_ctx, n) => (n ? { status: 204, body: '' } : serviceError(404, 'NOT_FOUND', 'Template not found')),
    // Infobip shows template status in its portal; no documented template webhook.
    statusWebhook: () => null,
  };

  return {
    preset: 'infobip-whatsapp',
    blockedAt: 'delivery',
    configFields: [
      { key: 'apiKey', label: 'API key', hint: 'Optional. When set, requests need "Authorization: App <this key>" (else 401). Empty: any App / Basic / Bearer credential works.', secret: true },
      { key: 'fromNumber', label: 'WhatsApp sender', hint: 'Your registered sender number (used as "to" in inbound messages).', placeholder: '441134960000' },
      { ...STATUS_CALLBACK_FIELD, label: 'Delivery report URL', hint: "Your app's delivery-report webhook (notifyUrl in the request wins). Seen reports go here too." },
      INBOUND_FIELD,
      READ_RECEIPTS_FIELD,
      WINDOW_FIELD,
      ...TEMPLATE_FIELDS,
    ],

    match(req, ctx) {
      if (!authorized(req, ctx)) return { kind: 'account', what: 'unauthorized' };
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      if (TEMPLATES.test(req.path)) {
        if (req.method === 'POST') return { kind: 'template', op: 'create' };
        if (req.method === 'GET') return { kind: 'template', op: 'list' };
      }
      const one = TEMPLATE.exec(req.path);
      if (one && req.method === 'GET') return { kind: 'template', op: 'get', id: decodeURIComponent(one[2]) };
      if (one && req.method === 'DELETE') return { kind: 'template', op: 'delete', name: decodeURIComponent(one[2]) };
      return null;
    },

    account: () => serviceError(401, 'UNAUTHORIZED', 'Invalid login details'),

    parse(req) {
      const kind = SEND.exec(req.path)![1];
      const f = fields(req);
      // The template endpoint takes {messages:[…]}; stubyard handles the first message of the batch.
      const msg = kind === 'template' ? arr(f.messages)[0] : f;
      if (!msg) return { error: badRequest('messages', 'must not be empty') };
      const from = str(msg.from);
      if (!from) return { error: badRequest(kind === 'template' ? 'messages[0].from' : 'from', 'must not be blank') };
      const rawTo = str(msg.to);
      const to = rawTo ? normalizePhone(rawTo) : null;
      if (!to) return { error: badRequest(kind === 'template' ? 'messages[0].to' : 'to', 'size must be between 1 and 30') };
      const c = content(kind, obj(msg.content));
      if ('error' in c) return { error: c.error };
      const notify = str(msg.notifyUrl);
      const callbackData = str(msg.callbackData);
      const bulkId = kind === 'template' ? (str(f.bulkId) ?? randomUUID()) : null;
      return {
        channel: 'whatsapp',
        to,
        from: '+' + intl(from),
        body: c.summary,
        statusCallbackUrl: notify && /^https?:\/\//i.test(notify) ? notify : null,
        extra: {
          type: c.wa.type,
          wa: { ...c.wa, replyTo: str(msg.context && obj(msg.context).messageId) },
          bulkId,
          metadata: { callbackData, ...(bulkId ? { bulkId } : {}) },
        },
      };
    },

    windowError: { code: '131047', message: 'Re-engagement message' },
    isTemplate: (parsed) => parsed.extra?.type === 'template',
    templateRef(parsed) {
      const t = (parsed.extra?.wa as WaContent | undefined)?.template;
      return t ? { name: t.name, language: t.language } : null;
    },
    // Infobip accepts the message; the delivery report carries WhatsApp's template error.
    templateRefused: (_ctx, problem) => ({
      failure:
        problem === 'paused'
          ? { code: '132015', message: 'Template is paused due to low quality' }
          : problem === 'disabled'
            ? { code: '132016', message: 'Template is disabled' }
            : { code: '132001', message: 'Template name does not exist in the translation' },
    }),
    templates,

    // Infobip uses the client's messageId when given.
    newMessageId: () => randomUUID(),

    accepted(_ctx, m) {
      const one = { to: intl(m.parsed.to), messageCount: 1, messageId: m.id, status: PENDING };
      if (m.parsed.extra?.type === 'template') return { status: 200, body: { messages: [one], bulkId: m.parsed.extra.bulkId } };
      return { status: 200, body: one };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      switch (kind) {
        case 'down':
          return serviceError(503, code ?? 'SERVICE_UNAVAILABLE', message ?? 'Service temporarily unavailable');
        case 'rate_limit':
          return serviceError(429, code ?? 'TOO_MANY_REQUESTS', message ?? 'Too many requests');
        default:
          return badRequest('to', message ?? 'invalid destination address');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: '131026', message: 'Message undeliverable' } : { code: '1', message: 'EC_UNKNOWN_SUBSCRIBER' }),

    notFound: (req) => serviceError(404, 'NOT_FOUND', `${req.method} ${req.path} is not an Infobip WhatsApp endpoint (use POST /whatsapp/1/message/text)`),

    // Delivery reports carry the final status only; "read" is a separate seen report.
    statusCallback(_ctx, m, status, e, url) {
      const now = new Date().toISOString().replace('Z', '+0000');
      const sentAt = new Date(m.createdAt).toISOString().replace('Z', '+0000');
      if (status === 'read') {
        return { url, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [{ messageId: m.providerMessageId, to: intl(m.to), from: intl(m.from), sentAt, seenAt: now, channel: 'WHATSAPP' }] }) };
      }
      if (status !== 'delivered' && status !== 'failed') return null;
      const ok = status === 'delivered';
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            {
              bulkId: str(m.metadata.bulkId) ?? undefined,
              price: { pricePerMessage: 0, currency: 'EUR' },
              status: ok
                ? { groupId: 3, groupName: 'DELIVERED', id: 5, name: 'DELIVERED_TO_HANDSET', description: 'Message delivered to handset' }
                : { groupId: 2, groupName: 'UNDELIVERABLE', id: 9, name: 'UNDELIVERABLE_NOT_DELIVERED', description: 'Message sent not delivered' },
              error: ok
                ? { groupId: 0, groupName: 'OK', id: 0, name: 'NO_ERROR', description: 'No Error', permanent: false }
                : { groupId: 1, groupName: 'HANDSET_ERRORS', id: Number(e?.code) || 1, name: e?.message ?? 'EC_UNKNOWN_SUBSCRIBER', description: e?.message ?? 'Unknown subscriber', permanent: true },
              messageId: m.providerMessageId,
              doneAt: now,
              messageCount: 1,
              sentAt,
              to: intl(m.to),
              callbackData: str(m.metadata.callbackData) ?? undefined,
              channel: 'WHATSAPP',
            },
          ],
        }),
      };
    },

    inbound(ctx, m, url) {
      const message = m.reply
        ? m.reply.kind === 'button'
          ? { type: 'BUTTON', text: m.reply.title, payload: m.reply.id }
          : m.reply.kind === 'list_reply'
            ? { type: 'INTERACTIVE_LIST_REPLY', id: m.reply.id, title: m.reply.title, ...(m.reply.description ? { description: m.reply.description } : {}) }
            : { type: 'INTERACTIVE_BUTTON_REPLY', id: m.reply.id, title: m.reply.title }
        : { type: 'TEXT', text: m.text };
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          results: [
            {
              from: intl(m.from),
              to: intl(cfg(ctx, 'fromNumber') ?? m.to),
              integrationType: 'WHATSAPP',
              receivedAt: new Date().toISOString().replace('Z', '+0000'),
              messageId: m.id,
              pairedMessageId: null,
              callbackData: null,
              message: { ...message, ...(m.context ? { context: { from: intl(m.context.from ?? cfg(ctx, 'fromNumber') ?? m.to), id: m.context.id } } : {}) },
              contact: { name: m.profileName },
              price: { pricePerMessage: 0, currency: 'EUR' },
            },
          ],
          messageCount: 1,
          pendingMessageCount: 0,
        }),
      };
    },
  };
}
