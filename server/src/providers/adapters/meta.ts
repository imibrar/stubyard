import { createHmac, randomBytes, randomInt } from 'node:crypto';
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
import { parseWaMessage } from './wa-content.js';

const META = {
  send: /^\/(v\d+(?:\.\d+)?\/)?([^/]+)\/messages\/?$/,
  upload: /^\/(v\d+(?:\.\d+)?\/)?([^/]+)\/media\/?$/,
};
/** 360dialog (waba-v2.360dialog.io): the phone number is implied by the D360-API-KEY, so no id in the path. */
const D360 = {
  send: /^\/(v1\/)?()messages\/?$/,
  upload: /^\/(v1\/)?()media\/?$/,
};
const MEDIA = /^\/(v\d+(?:\.\d+)?\/)?(\d{6,})\/?$/;
const DOWNLOAD = /^\/whatsapp_business\/attachments\/?$/;
/** Meta: /{version}/{waba-id}/message_templates. 360dialog: /message_templates or the older /v1/configs/templates. */
const META_TEMPLATES = /^\/(v\d+(?:\.\d+)?\/)?([^/]+)\/message_templates\/?$/;
const D360_TEMPLATES = /^\/(?:message_templates|v1\/configs\/templates)\/?$/;
const D360_TEMPLATE = /^\/v1\/configs\/templates\/([^/]+)\/?$/;
const digits = (p: string | null) => (p ?? '').replace(/^\+/, '');

const graphError = (status: number, code: number, message: string, details?: string): Reply => ({
  status,
  body: {
    error: {
      message: `(#${code}) ${message}`,
      type: 'OAuthException',
      code,
      ...(details ? { error_data: { messaging_product: 'whatsapp', details } } : {}),
      fbtrace_id: randomBytes(9).toString('base64url'),
    },
  },
});

const objectNotFound = (id: string): Reply => ({
  status: 400,
  body: {
    error: {
      message: `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      type: 'GraphMethodException',
      code: 100,
      error_subcode: 33,
      fbtrace_id: randomBytes(9).toString('base64url'),
    },
  },
});

const header = (req: MockRequest, name: string): string | null => {
  const v = req.headers[name];
  return str(Array.isArray(v) ? v[0] : v);
};

/** Graph API template object. */
const graphTemplate = (t: WaTemplate) => ({
  name: t.name,
  parameter_format: 'POSITIONAL',
  components: t.components,
  language: t.language,
  status: t.status,
  category: t.category,
  ...(t.status === 'REJECTED' && t.reason ? { rejected_reason: t.reason } : {}),
  quality_score: { score: t.quality },
  id: t.id,
});

/**
 * Meta WhatsApp Cloud API (Graph API): POST /{version}/{phone-number-id}/messages, media, message templates.
 * The "360dialog" variant speaks the same Cloud API on waba-v2.360dialog.io (POST /messages) with a D360-API-KEY header.
 */
export function metaWhatsappAdapter(variant: 'meta' | '360dialog' = 'meta'): ProviderAdapter {
  const d360 = variant === '360dialog';
  const P = d360 ? D360 : META;
  const phoneNumberId = (ctx: Ctx, fromPath?: string) => cfg(ctx, 'phoneNumberId') ?? (fromPath || undefined) ?? '100000000000001';
  const display = (ctx: Ctx) => cfg(ctx, 'displayPhoneNumber') ?? '15550001234';
  const wabaId = (ctx: Ctx) => cfg(ctx, 'wabaId') ?? '200000000000002';

  const envelope = (ctx: Ctx, value: Record<string, unknown>, field = 'messages') =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: wabaId(ctx),
          ...(field === 'messages' ? {} : { time: Math.floor(Date.now() / 1000) }),
          changes: [
            {
              value: field === 'messages' ? { messaging_product: 'whatsapp', metadata: { display_phone_number: display(ctx), phone_number_id: phoneNumberId(ctx) }, ...value } : value,
              field,
            },
          ],
        },
      ],
    });

  const sign = (ctx: Ctx, body: string): Record<string, string> => {
    const secret = d360 ? null : cfg(ctx, 'appSecret');
    return secret ? { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } : {};
  };

  // 360dialog's key check. The response shape is the one apps see from waba-v2 (unverified, see docs/plans/research-whatsapp-bsps.md).
  const unauthorized: Reply = { status: 401, body: { meta: { success: false, http_code: 401, developer_message: 'Invalid api key' } } };

  const body = (req: MockRequest) => (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) as Record<string, unknown>;

  const templates: TemplateApi = {
    // Meta template ids are 15-16 digit numbers.
    newId: () => String(randomInt(1, 10)) + Array.from({ length: 15 }, () => randomInt(0, 10)).join(''),

    parseCreate(req) {
      const b = fields(req);
      const name = str(b.name);
      const language = str(b.language);
      const category = str(b.category);
      if (!name) return { error: graphError(400, 100, 'The parameter name is required.') };
      if (!/^[a-z0-9_]{1,512}$/.test(name)) return { error: graphError(400, 100, 'Invalid parameter', 'Template names can only contain lowercase alphanumeric characters and underscores.') };
      if (!language) return { error: graphError(400, 100, 'The parameter language is required.') };
      if (!category) return { error: graphError(400, 100, 'The parameter category is required.') };
      if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category.toUpperCase())) return { error: graphError(400, 100, 'Param category must be one of {AUTHENTICATION, MARKETING, UTILITY}') };
      let components = b.components;
      if (typeof components === 'string') {
        try {
          components = JSON.parse(components);
        } catch {
          components = null;
        }
      }
      if (!Array.isArray(components) || !components.length) return { error: graphError(400, 100, 'The parameter components is required.') };
      return { name, language, category: category.toUpperCase(), components };
    },

    created: (_ctx, t) => ({ status: 200, body: { id: t.id, status: t.status, category: t.category } }),

    list(_ctx, list, req) {
      const name = str(req.query.name);
      const status = str(req.query.status)?.toUpperCase();
      const hits = list.filter((t) => (!name || t.name.includes(name)) && (!status || t.status === status));
      // 360dialog's older /v1/configs/templates answers its own list envelope.
      if (d360 && /configs\/templates/.test(req.path))
        return {
          status: 200,
          body: {
            count: hits.length,
            filters: {},
            limit: 1000,
            offset: 0,
            sort: ['id'],
            total: hits.length,
            waba_templates: hits.map((t) => ({ id: t.id, external_id: t.id, name: t.name, language: t.language, category: t.category, components: t.components, status: t.status.toLowerCase() === 'approved' ? 'approved' : t.status.toLowerCase(), rejected_reason: t.reason ?? 'NONE', namespace: 'stubyard', quality_score: { score: t.quality } })),
          },
        };
      return { status: 200, body: { data: hits.map(graphTemplate), paging: { cursors: { before: 'MAZDZD', after: 'MjQZD' } } } };
    },

    get: (_ctx, t, id) => (t ? { status: 200, body: graphTemplate(t) } : objectNotFound(id)),

    deleted: (_ctx, n, name) =>
      n
        ? { status: 200, body: { success: true } }
        : graphError(404, 100, 'Invalid parameter', `Message template "${name}" not found`),

    statusWebhook(ctx, t, change, url) {
      const base = { message_template_id: Number(t.id) || t.id, message_template_name: t.name, message_template_language: t.language };
      const body =
        change.kind === 'quality'
          ? envelope(ctx, { previous_quality_score: change.previous, new_quality_score: t.quality, ...base }, 'message_template_quality_update')
          : envelope(
              ctx,
              {
                event: t.status,
                ...base,
                reason: t.status === 'REJECTED' ? (t.reason ?? 'INVALID_FORMAT') : 'NONE',
                message_template_category: t.category,
                ...(t.status === 'REJECTED' ? { rejection_info: { reason: `Rejected in stubyard (${t.reason ?? 'INVALID_FORMAT'}).`, recommendation: 'Edit the template and submit it again.' } } : {}),
              },
              'message_template_status_update',
            );
      return { url, headers: { 'content-type': 'application/json', ...sign(ctx, body) }, body };
    },
  };

  return {
    preset: d360 ? '360dialog' : 'meta-whatsapp',
    blockedAt: 'delivery',
    singleWebhook: true,
    configFields: [
      ...(d360
        ? [{ key: 'apiKey', label: 'D360-API-KEY', hint: 'Optional. When set, any other key gets 401. Empty: any non-empty key works.', secret: true }]
        : [{ key: 'phoneNumberId', label: 'Phone number ID', hint: 'Shown in webhooks; any value.', placeholder: '100000000000001' }]),
      { key: 'displayPhoneNumber', label: 'Display phone number', placeholder: '15550001234' },
      { key: 'wabaId', label: 'WhatsApp Business Account ID', hint: 'Shown in webhooks (entry[0].id); any value.', placeholder: '200000000000002' },
      ...(d360 ? [] : [{ key: 'appSecret', label: 'App secret', hint: 'Optional. When set, webhooks carry a valid X-Hub-Signature-256.', secret: true }]),
      { ...STATUS_CALLBACK_FIELD, label: 'Webhook URL', hint: "Your app's WhatsApp webhook. Status updates (sent, delivered, failed), template status updates and (without an inbound URL) replies go here." },
      { ...INBOUND_FIELD, hint: d360 ? 'Where replies go. Leave empty to use the webhook URL above (like 360dialog does).' : 'Where replies go. Leave empty to use the webhook URL above (like Meta does).' },
      READ_RECEIPTS_FIELD,
      WINDOW_FIELD,
      ...TEMPLATE_FIELDS,
    ],

    match(req, ctx) {
      if (d360) {
        const key = header(req, 'd360-api-key');
        const want = cfg(ctx, 'apiKey');
        if (!key || (want && key !== want)) return { kind: 'account', what: 'unauthorized' };
        if (req.method === 'POST' && /^\/v1\/configs\/webhook\/?$/.test(req.path)) return { kind: 'account', what: 'webhook' };
        if (D360_TEMPLATES.test(req.path)) {
          if (req.method === 'POST') return { kind: 'template', op: 'create' };
          if (req.method === 'GET') return { kind: 'template', op: 'list' };
          if (req.method === 'DELETE') return { kind: 'template', op: 'delete', name: str(req.query.name), id: str(req.query.hsm_id) };
        }
        const one = D360_TEMPLATE.exec(req.path);
        if (one && req.method === 'DELETE') return { kind: 'template', op: 'delete', name: decodeURIComponent(one[1]) };
      } else {
        const tm = META_TEMPLATES.exec(req.path);
        if (tm) {
          if (req.method === 'POST') return { kind: 'template', op: 'create' };
          if (req.method === 'GET') return { kind: 'template', op: 'list' };
          if (req.method === 'DELETE') return { kind: 'template', op: 'delete', name: str(req.query.name), id: str(req.query.hsm_id) };
        }
      }
      if (req.method === 'POST' && P.send.test(req.path)) {
        const b = body(req);
        if (b.status === 'read' && b.message_id) return { kind: 'mark-read', id: String(b.message_id) };
        return { kind: 'send' };
      }
      if (req.method === 'POST' && P.upload.test(req.path)) return { kind: 'media-upload' };
      const m = MEDIA.exec(req.path);
      // GET /{id}: media or a message template (the simulator checks which one exists).
      if (m && req.method === 'GET') return { kind: 'media-get', id: m[2] };
      if (m && req.method === 'DELETE') return { kind: 'media-delete', id: m[2] };
      if (req.method === 'GET' && DOWNLOAD.test(req.path) && req.query.mid) return { kind: 'media-download', id: String(req.query.mid) };
      return null;
    },

    account(_ctx, what, req) {
      if (what === 'webhook') return { status: 200, body: { url: str(body(req).url) ?? '' } };
      return unauthorized;
    },

    windowError: { code: '131047', message: 'Re-engagement message' },
    isTemplate: (parsed) => parsed.extra?.type === 'template',
    templateRef(parsed) {
      const t = (parsed.extra?.wa as { template?: { name: string; language: string | null } } | undefined)?.template;
      return t ? { name: t.name, language: t.language } : null;
    },
    templateRefused(_ctx, problem, ref) {
      if (problem === 'paused') return { reply: graphError(400, 132015, 'Template is Paused', 'Template is paused due to low quality so it cannot be sent in a template message.') };
      if (problem === 'disabled') return { reply: graphError(400, 132016, 'Template is Disabled', 'Template has been paused too many times due to low quality and is now permanently disabled.') };
      return { reply: graphError(404, 132001, 'Template name does not exist in the translation', `template name (${ref.name ?? ref.id}) does not exist in ${ref.language ?? 'the requested language'}`) };
    },
    templates,

    mediaReply(_ctx, kind, data) {
      switch (kind) {
        case 'uploaded':
          return { status: 200, body: { id: data.id } };
        case 'info':
          return { status: 200, body: { messaging_product: 'whatsapp', url: data.url, mime_type: data.mime_type, sha256: data.sha256, file_size: data.file_size, id: data.id } };
        case 'deleted':
          return { status: 200, body: { success: true } };
        case 'not_found':
          return objectNotFound(String(data.id));
        default:
          return graphError(Number(data.status ?? 400), Number(data.code ?? 131053), String(data.message ?? 'Media upload error'), data.details ? String(data.details) : undefined);
      }
    },

    parse(req, ctx) {
      const b = body(req);
      if (b.messaging_product !== 'whatsapp') return { error: graphError(400, 100, 'The parameter messaging_product is required.') };
      if (!b.to) return { error: graphError(400, 100, 'The parameter to is required.') };
      const to = normalizePhone(String(b.to));
      if (!to) return { error: graphError(400, 100, 'Invalid parameter', `Invalid "to" ${String(b.to)}`) };
      if (b.recipient_type !== undefined && b.recipient_type !== 'individual') return { error: graphError(400, 100, "Param recipient_type must be 'individual'.") };
      const r = parseWaMessage(b, (id) => ctx.media?.(id) ?? null);
      if ('error' in r) return { error: graphError(400, r.error.code, r.error.message, r.error.details) };
      const fromId = d360 ? cfg(ctx, 'phoneNumberId') : P.send.exec(req.path)?.[2];
      const from = d360 ? (cfg(ctx, 'displayPhoneNumber') ? '+' + digits(cfg(ctx, 'displayPhoneNumber')) : null) : fromId ? `id:${fromId}` : null;
      return { channel: 'whatsapp', to, from, body: r.summary, extra: { type: r.content.type, phoneNumberId: fromId, wa: r.content } };
    },

    newMessageId: () => 'wamid.' + randomBytes(24).toString('base64'),

    accepted(_ctx, m) {
      const tmpl = m.parsed.extra?.type === 'template';
      return {
        status: 200,
        body: {
          messaging_product: 'whatsapp',
          contacts: [{ input: digits(m.parsed.to), wa_id: digits(m.parsed.to) }],
          messages: [{ id: m.id, ...(tmpl ? { message_status: 'accepted' } : {}) }],
        },
      };
    },

    sendError(_ctx, kind, _parsed, code, message) {
      switch (kind) {
        case 'down':
          return graphError(503, Number(code) || 2, message ?? 'Service temporarily unavailable');
        case 'rate_limit':
          return graphError(429, Number(code) || 130429, message ?? 'Rate limit hit', 'Cloud API message throughput has been reached.');
        case 'opt_out':
          return graphError(400, Number(code) || 131050, message ?? 'Unable to deliver the message. This recipient has chosen to stop receiving marketing messages on WhatsApp from your business.');
        case 'blocked':
          return graphError(400, Number(code) || 131026, message ?? 'Message undeliverable');
        default:
          return graphError(400, Number(code) || 131030, message ?? 'Recipient phone number not in allowed list', 'Add recipient phone number to recipient list and try again.');
      }
    },

    defaultFailure: (kind) => (kind === 'blocked' ? { code: '131026', message: 'Message undeliverable' } : { code: '131026', message: 'Message undeliverable' }),

    notFound: (req) => graphError(404, 803, `Unsupported request - ${req.method} ${req.path} (use ${d360 ? '/messages' : '/{version}/{phone-number-id}/messages'})`),

    statusCallback(ctx, m, status, e, url) {
      const st = status === 'queued' ? 'sent' : status;
      const body = envelope(ctx, {
        statuses: [
          {
            id: m.providerMessageId,
            status: st,
            timestamp: String(Math.floor(Date.now() / 1000)),
            recipient_id: digits(m.to),
            ...(st === 'failed' ? { errors: [{ code: Number(e?.code) || 131026, title: e?.message ?? 'Message undeliverable', message: e?.message ?? 'Message undeliverable', error_data: { details: e?.message ?? 'Message undeliverable' } }] } : {}),
            ...(st === 'sent' || st === 'delivered' ? { conversation: { id: 'stubyard-conv', origin: { type: 'utility' } }, pricing: { billable: true, pricing_model: 'CBP', category: 'utility' } } : {}),
          },
        ],
      });
      return { url, headers: { 'content-type': 'application/json', ...sign(ctx, body) }, body };
    },

    inbound(ctx, m, url) {
      const body = envelope(ctx, {
        contacts: [{ profile: { name: m.profileName }, wa_id: digits(m.from) }],
        messages: [
          {
            ...(m.context ? { context: { from: digits(m.context.from ?? display(ctx)), id: m.context.id } } : {}),
            from: digits(m.from),
            id: m.id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            ...(m.reply?.kind === 'button'
              ? { type: 'button', button: { payload: m.reply.id, text: m.reply.title } }
              : m.reply
                ? {
                    type: 'interactive',
                    interactive:
                      m.reply.kind === 'list_reply'
                        ? { type: 'list_reply', list_reply: { id: m.reply.id, title: m.reply.title, ...(m.reply.description ? { description: m.reply.description } : {}) } }
                        : { type: 'button_reply', button_reply: { id: m.reply.id, title: m.reply.title } },
                  }
                : { type: 'text', text: { body: m.text } }),
          },
        ],
      });
      return { url, headers: { 'content-type': 'application/json', ...sign(ctx, body) }, body };
    },
  };
}
