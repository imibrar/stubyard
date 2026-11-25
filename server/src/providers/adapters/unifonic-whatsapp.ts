import { randomUUID } from 'node:crypto';
import { normalizePhone } from '../../util.js';
import { INBOUND_FIELD, READ_RECEIPTS_FIELD, STATUS_CALLBACK_FIELD, TEMPLATE_FIELDS, WINDOW_FIELD, cfg, str, type Ctx, type MockRequest, type ProviderAdapter, type Reply } from './types.js';
import { parseWaMessage, type WaContent } from './wa-content.js';

/**
 * Unifonic WhatsApp (Conversations API, apis.unifonic.com): POST /v1/messages with PublicId / Secret headers and
 * {recipient:{contact, channel:"whatsapp"}, content:{type, …}}. The SMS preset (unifonic.ts) is separate.
 * Unifonic does not publish the full payloads; shapes marked "assumed" in docs/plans/research-whatsapp-bsps.md.
 */

const SEND = /^\/v1\/messages\/?$/;

const err = (status: number, code: string, message: string): Reply => ({ status, body: { success: false, code, message } });

const intl = (p: string | null) => '+' + (p ?? '').replace(/^\+/, '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function header(req: MockRequest, ...names: string[]): string | null {
  for (const n of names) {
    const v = req.headers[n];
    const s = str(Array.isArray(v) ? v[0] : v);
    if (s) return s;
  }
  return null;
}

/** Unifonic content → a Cloud API message body (same rules as Meta). */
function toCloud(c: Record<string, unknown>): Record<string, unknown> {
  const type = str(c.type) ?? 'text';
  switch (type) {
    case 'text':
      return { type, text: { body: c.text } };
    case 'template':
      return { type, template: { name: c.name, language: typeof c.language === 'string' ? { code: c.language } : c.language, components: c.components } };
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker':
      return { type, [type]: { link: c.url ?? c.link, caption: c.caption, filename: c.filename } };
    case 'location':
      return { type, location: c.location ?? c };
    case 'interactive':
      return { type, interactive: c.interactive ?? c };
    default:
      return { type, [type]: c[type] ?? c };
  }
}

export function unifonicWhatsappAdapter(): ProviderAdapter {
  const sender = (ctx: Ctx) => cfg(ctx, 'fromNumber') ?? '+966110000000';
  return {
    preset: 'unifonic-whatsapp',
    blockedAt: 'delivery',
    configFields: [
      { key: 'publicId', label: 'Public ID', hint: 'Optional. When set, requests need this PublicId header (else 401). Empty: any non-empty PublicId + Secret work.' },
      { key: 'secret', label: 'Secret', hint: 'Optional. When set, the Secret header must match.', secret: true },
      { key: 'fromNumber', label: 'WhatsApp sender', hint: 'Your WhatsApp Business number (where replies are addressed).', placeholder: '+966110000000' },
      { ...STATUS_CALLBACK_FIELD, label: 'Status webhook URL', hint: "Your app's outbound status webhook (sent / delivered / read / failed)." },
      INBOUND_FIELD,
      READ_RECEIPTS_FIELD,
      WINDOW_FIELD,
      ...TEMPLATE_FIELDS,
    ],

    match(req, ctx) {
      const id = header(req, 'publicid', 'public-id', 'x-authenticate-app-id');
      const secret = header(req, 'secret', 'x-authenticate-app-secret');
      const wantId = cfg(ctx, 'publicId');
      const wantSecret = cfg(ctx, 'secret');
      if (!id || !secret || (wantId && id !== wantId) || (wantSecret && secret !== wantSecret)) return { kind: 'account', what: 'unauthorized' };
      if (req.method === 'POST' && SEND.test(req.path)) return { kind: 'send' };
      return null;
    },

    account: () => err(401, 'UNAUTHORIZED', 'Invalid PublicId or Secret'),

    parse(req, ctx) {
      const b = obj(req.body);
      const recipient = obj(b.recipient);
      const contact = str(recipient.contact);
      if (!contact) return { error: err(400, 'INVALID_REQUEST', 'recipient.contact is required') };
      const channel = str(recipient.channel) ?? 'whatsapp';
      if (channel.toLowerCase() !== 'whatsapp') return { error: err(400, 'INVALID_REQUEST', `recipient.channel "${channel}" is not supported by this preset (use "whatsapp")`) };
      const to = normalizePhone(contact);
      if (!to) return { error: err(400, 'INVALID_REQUEST', `Invalid recipient.contact ${contact}`) };
      const content = obj(b.content);
      if (!str(content.type)) return { error: err(400, 'INVALID_REQUEST', 'content.type is required') };
      const r = parseWaMessage({ messaging_product: 'whatsapp', to: contact, ...toCloud(content) }, (id) => ctx.media?.(id) ?? null);
      if ('error' in r) return { error: err(400, 'INVALID_REQUEST', r.error.details ? `${r.error.message} ${r.error.details}` : r.error.message) };
      return { channel: 'whatsapp', to, from: intl(sender(ctx)), body: r.summary, extra: { type: r.content.type, wa: r.content } };
    },

    windowError: { code: '131047', message: 'Re-engagement message' },
    isTemplate: (parsed) => parsed.extra?.type === 'template',
    templateRef(parsed) {
      const t = (parsed.extra?.wa as WaContent | undefined)?.template;
      return t ? { name: t.name, language: t.language } : null;
    },
    templateRefused: (_ctx, problem) => ({
      failure:
        problem === 'paused'
          ? { code: '132015', message: 'Template is paused due to low quality' }
          : problem === 'disabled'
            ? { code: '132016', message: 'Template is disabled' }
            : { code: '132001', message: 'Template name does not exist in the translation' },
    }),

    newMessageId: () => randomUUID(),

    accepted: (_ctx, m) => ({ status: 202, body: { messageId: m.id, status: 'queued', recipient: { contact: m.parsed.to, channel: 'whatsapp' } } }),

    sendError(_ctx, kind, _parsed, code, message) {
      switch (kind) {
        case 'down':
          return err(503, code ?? 'SERVICE_UNAVAILABLE', message ?? 'Service Unavailable');
        case 'rate_limit':
          return err(429, code ?? 'TOO_MANY_REQUESTS', message ?? 'Too many requests');
        default:
          return err(400, code ?? 'INVALID_REQUEST', message ?? 'Invalid recipient');
      }
    },

    defaultFailure: () => ({ code: '131026', message: 'Message undeliverable' }),

    notFound: (req) => err(404, 'NOT_FOUND', `${req.method} ${req.path} is not a Unifonic WhatsApp endpoint (use POST /v1/messages)`),

    statusCallback(_ctx, m, status, e, url) {
      const st = status === 'queued' ? 'sent' : status;
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'message.status',
          messageId: m.providerMessageId,
          status: st,
          channel: 'whatsapp',
          recipient: { contact: m.to, channel: 'whatsapp' },
          timestamp: new Date().toISOString(),
          ...(st === 'failed' ? { error: { code: e?.code ?? '131026', message: e?.message ?? 'Message undeliverable' } } : {}),
        }),
      };
    },

    inbound(ctx, m, url) {
      const content = m.reply
        ? m.reply.kind === 'button'
          ? { type: 'button', button: { payload: m.reply.id, text: m.reply.title } }
          : {
              type: 'interactive',
              interactive:
                m.reply.kind === 'list_reply'
                  ? { type: 'list_reply', list_reply: { id: m.reply.id, title: m.reply.title, ...(m.reply.description ? { description: m.reply.description } : {}) } }
                  : { type: 'button_reply', button_reply: { id: m.reply.id, title: m.reply.title } },
            }
        : { type: 'text', text: m.text };
      return {
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'message.inbound',
          messageId: m.id,
          channel: 'whatsapp',
          sender: { contact: intl(m.from), name: m.profileName },
          recipient: { contact: intl(cfg(ctx, 'fromNumber') ?? m.to) },
          content,
          ...(m.context ? { context: { messageId: m.context.id } } : {}),
          timestamp: new Date().toISOString(),
        }),
      };
    },
  };
}
