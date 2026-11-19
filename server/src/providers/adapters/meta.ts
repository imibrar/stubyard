import { createHmac, randomBytes } from 'node:crypto';
import { normalizePhone } from '../../util.js';
import { INBOUND_FIELD, READ_RECEIPTS_FIELD, STATUS_CALLBACK_FIELD, WINDOW_FIELD, cfg, type Ctx, type ProviderAdapter, type Reply } from './types.js';
import { parseWaMessage } from './wa-content.js';

const SEND = /^\/(v\d+(?:\.\d+)?\/)?([^/]+)\/messages\/?$/;
const UPLOAD = /^\/(v\d+(?:\.\d+)?\/)?([^/]+)\/media\/?$/;
const MEDIA = /^\/(v\d+(?:\.\d+)?\/)?(\d{6,})\/?$/;
const DOWNLOAD = /^\/whatsapp_business\/attachments\/?$/;
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

/** Meta WhatsApp Cloud API (Graph API): POST /{version}/{phone-number-id}/messages. */
export function metaWhatsappAdapter(): ProviderAdapter {
  const phoneNumberId = (ctx: Ctx, fromPath?: string) => cfg(ctx, 'phoneNumberId') ?? fromPath ?? '100000000000001';
  const display = (ctx: Ctx) => cfg(ctx, 'displayPhoneNumber') ?? '15550001234';

  const envelope = (ctx: Ctx, value: Record<string, unknown>) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: cfg(ctx, 'wabaId') ?? '200000000000002',
          changes: [{ value: { messaging_product: 'whatsapp', metadata: { display_phone_number: display(ctx), phone_number_id: phoneNumberId(ctx) }, ...value }, field: 'messages' }],
        },
      ],
    });

  const sign = (ctx: Ctx, body: string): Record<string, string> => {
    const secret = cfg(ctx, 'appSecret');
    return secret ? { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') } : {};
  };

  return {
    preset: 'meta-whatsapp',
    blockedAt: 'delivery',
    configFields: [
      { key: 'phoneNumberId', label: 'Phone number ID', hint: 'Shown in webhooks; any value.', placeholder: '100000000000001' },
      { key: 'displayPhoneNumber', label: 'Display phone number', placeholder: '15550001234' },
      { key: 'appSecret', label: 'App secret', hint: 'Optional. When set, webhooks carry a valid X-Hub-Signature-256.', secret: true },
      { ...STATUS_CALLBACK_FIELD, label: 'Webhook URL (statuses)', hint: "Your app's WhatsApp webhook. Status updates (sent, delivered, failed) go here." },
      { ...INBOUND_FIELD, hint: 'Where replies go. Leave empty to use the webhook URL above (like Meta does).' },
      READ_RECEIPTS_FIELD,
      WINDOW_FIELD,
    ],

    match(req) {
      if (req.method === 'POST' && SEND.test(req.path)) {
        const b = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) as Record<string, unknown>;
        if (b.status === 'read' && b.message_id) return { kind: 'mark-read', id: String(b.message_id) };
        return { kind: 'send' };
      }
      if (req.method === 'POST' && UPLOAD.test(req.path)) return { kind: 'media-upload' };
      const m = MEDIA.exec(req.path);
      if (m && req.method === 'GET') return { kind: 'media-get', id: m[2] };
      if (m && req.method === 'DELETE') return { kind: 'media-delete', id: m[2] };
      if (req.method === 'GET' && DOWNLOAD.test(req.path) && req.query.mid) return { kind: 'media-download', id: String(req.query.mid) };
      return null;
    },

    windowError: { code: '131047', message: 'Re-engagement message' },
    isTemplate: (parsed) => parsed.extra?.type === 'template',

    mediaReply(_ctx, kind, data) {
      switch (kind) {
        case 'uploaded':
          return { status: 200, body: { id: data.id } };
        case 'info':
          return { status: 200, body: { messaging_product: 'whatsapp', url: data.url, mime_type: data.mime_type, sha256: data.sha256, file_size: data.file_size, id: data.id } };
        case 'deleted':
          return { status: 200, body: { success: true } };
        case 'not_found':
          return {
            status: 400,
            body: {
              error: {
                message: `Unsupported get request. Object with ID '${String(data.id)}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
                type: 'GraphMethodException',
                code: 100,
                error_subcode: 33,
                fbtrace_id: randomBytes(9).toString('base64url'),
              },
            },
          };
        default:
          return graphError(Number(data.status ?? 400), Number(data.code ?? 131053), String(data.message ?? 'Media upload error'), data.details ? String(data.details) : undefined);
      }
    },

    parse(req, ctx) {
      const b = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) as Record<string, unknown>;
      if (b.messaging_product !== 'whatsapp') return { error: graphError(400, 100, 'The parameter messaging_product is required.') };
      if (!b.to) return { error: graphError(400, 100, 'The parameter to is required.') };
      const to = normalizePhone(String(b.to));
      if (!to) return { error: graphError(400, 100, 'Invalid parameter', `Invalid "to" ${String(b.to)}`) };
      if (b.recipient_type !== undefined && b.recipient_type !== 'individual') return { error: graphError(400, 100, "Param recipient_type must be 'individual'.") };
      const r = parseWaMessage(b, (id) => ctx.media?.(id) ?? null);
      if ('error' in r) return { error: graphError(400, r.error.code, r.error.message, r.error.details) };
      const fromId = SEND.exec(req.path)?.[2];
      return { channel: 'whatsapp', to, from: fromId ? `id:${fromId}` : null, body: r.summary, extra: { type: r.content.type, phoneNumberId: fromId, wa: r.content } };
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

    notFound: (req) => graphError(404, 803, `Unsupported request - ${req.method} ${req.path} (use /{version}/{phone-number-id}/messages)`),

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
            ...(st === 'sent' || st === 'delivered' ? { conversation: { id: 'devhub-conv', origin: { type: 'utility' } }, pricing: { billable: true, pricing_model: 'CBP', category: 'utility' } } : {}),
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
