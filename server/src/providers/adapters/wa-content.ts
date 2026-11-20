/**
 * WhatsApp Cloud API message content: validation (limits as documented by Meta) and a structured form stubyard stores on
 * the message (`metadata.wa`) so the dashboard can render media, buttons, lists, locations, contacts and reactions.
 */

export interface WaButton {
  id: string;
  title: string;
  /** reply: interactive reply button; quick_reply: template quick-reply button; url: CTA URL button. */
  kind: 'reply' | 'quick_reply' | 'url';
  url?: string;
}

export interface WaListRow {
  id: string;
  title: string;
  description?: string | null;
}

export interface WaContent {
  type: string;
  text?: string | null;
  caption?: string | null;
  media?: { link: string | null; id: string | null; filename: string | null; mimeType?: string | null; fileSize?: number | null };
  location?: { latitude: number; longitude: number; name: string | null; address: string | null };
  contacts?: { name: string; phones: string[]; emails: string[] }[];
  interactive?: {
    type: string;
    header: string | null;
    body: string;
    footer: string | null;
    buttons?: WaButton[];
    listButton?: string;
    sections?: { title: string | null; rows: WaListRow[] }[];
  };
  reaction?: { messageId: string; emoji: string };
  /** params: the text parameters as sent (empty strings kept, for the content checks). */
  template?: { name: string; language: string | null; buttons: WaButton[]; params?: (string | null)[] };
  /** The message this one replies to (context.message_id). */
  replyTo?: string | null;
  /** Twilio MediaUrl list. */
  mediaUrls?: string[];
  /** Inbound: the button / list row the user tapped. */
  reply?: { kind: string; id: string; title: string; description?: string | null };
}

export interface WaError {
  code: number;
  message: string;
  details?: string;
}

export const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;
export const MESSAGE_TYPES = ['text', 'template', 'interactive', 'location', 'contacts', 'reaction', ...MEDIA_TYPES] as const;

/** MIME types and size limits Meta accepts per media type. */
export const MEDIA_LIMITS: Record<(typeof MEDIA_TYPES)[number], { mimes: string[]; maxBytes: number }> = {
  image: { mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * 1024 * 1024 },
  sticker: { mimes: ['image/webp'], maxBytes: 500 * 1024 },
  audio: { mimes: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'], maxBytes: 16 * 1024 * 1024 },
  video: { mimes: ['video/mp4', 'video/3gpp'], maxBytes: 16 * 1024 * 1024 },
  document: {
    mimes: [
      'text/plain',
      'application/pdf',
      'application/vnd.ms-powerpoint',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    maxBytes: 100 * 1024 * 1024,
  },
};

/** Media type for a MIME type (upload endpoint). */
export function mediaTypeOf(mime: string): (typeof MEDIA_TYPES)[number] | null {
  const m = mime.toLowerCase().split(';')[0].trim();
  for (const t of MEDIA_TYPES) if (MEDIA_LIMITS[t].mimes.includes(m)) return t;
  return null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const isUrl = (v: string) => /^https?:\/\/[^\s]+$/i.test(v);

const bad = (message: string, details?: string): { error: WaError } => ({ error: { code: 100, message, ...(details ? { details } : {}) } });
const tooLong = (param: string, max: number) => bad(`Param ${param} must be at most ${max} characters long.`);

/** Validate a Cloud API message body (already known to have messaging_product and to). */
export function parseWaMessage(b: Record<string, unknown>, media: (id: string) => { mimeType: string; fileSize: number; filename: string | null } | null): { content: WaContent; summary: string } | { error: WaError } {
  const type = s(b.type) ?? 'text';
  if (!(MESSAGE_TYPES as readonly string[]).includes(type)) return bad(`Param type must be one of {${MESSAGE_TYPES.join(', ')}} - got "${type}".`);
  const o = type === 'contacts' ? {} : obj(b[type]);
  if (!o) return bad(`The parameter ${type} is required.`);
  const replyTo = s(obj(b.context)?.message_id);
  const done = (content: WaContent, summary: string) => ({ content: { ...content, replyTo }, summary });

  switch (type) {
    case 'text': {
      const body = s(o.body);
      if (!body) return bad('The parameter text[body] is required.');
      if (body.length > 4096) return tooLong("text['body']", 4096);
      return done({ type, text: body }, body);
    }
    case 'template': {
      const name = s(o.name);
      if (!name) return bad('The parameter template[name] is required.');
      const lang = s(obj(o.language)?.code);
      if (!lang) return bad('The parameter template[language][code] is required.');
      const comps = (Array.isArray(o.components) ? o.components : []) as Record<string, unknown>[];
      const params = comps
        .filter((c) => c.type !== 'button')
        .flatMap((c) => ((Array.isArray(c.parameters) ? c.parameters : []) as Record<string, unknown>[]).map((p) => s(p.text) ?? `[${s(p.type) ?? '?'}]`));
      const buttons: WaButton[] = comps
        .filter((c) => c.type === 'button')
        .map((c) => {
          const p = ((Array.isArray(c.parameters) ? c.parameters : []) as Record<string, unknown>[])[0] ?? {};
          const sub = s(c.sub_type) ?? 'quick_reply';
          const payload = s(p.payload) ?? s(p.text) ?? `button-${s(c.index) ?? '0'}`;
          return sub === 'url' ? { id: payload, title: `URL button ${s(c.index) ?? ''}`.trim(), kind: 'url' as const } : { id: payload, title: payload, kind: 'quick_reply' as const };
        });
      const textParams = comps
        .filter((c) => c.type !== 'button')
        .flatMap((c) => (Array.isArray(c.parameters) ? c.parameters : []) as Record<string, unknown>[])
        .filter((p) => (s(p.type) ?? 'text') === 'text')
        .map((p) => (typeof p.text === 'string' ? p.text : null));
      const summary = `[template ${name} · ${lang}] ${params.join(' ')}`.trim();
      return done({ type, template: { name, language: lang, buttons, params: textParams }, text: params.join(' ') || null }, summary);
    }
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      const link = s(o.link);
      const id = s(o.id);
      if (!link && !id) return bad(`Param ${type} must contain either 'id' or 'link'.`);
      if (link && id) return bad(`Param ${type} must contain only one of 'id' or 'link'.`);
      if (link && !isUrl(link)) return bad(`Param ${type}['link'] is not a valid URI.`);
      let info: ReturnType<typeof media> = null;
      if (id) {
        info = media(id);
        if (!info) return { error: { code: 131053, message: 'Media upload error', details: `Media ID ${id} was not found. Upload it first with POST /<version>/<phone-number-id>/media.` } };
        const want = MEDIA_LIMITS[type as (typeof MEDIA_TYPES)[number]];
        if (!want.mimes.includes(info.mimeType)) return { error: { code: 131053, message: 'Media upload error', details: `Media ${id} is ${info.mimeType}, which cannot be sent as ${type}.` } };
      }
      const caption = s(o.caption);
      if (caption && (type === 'audio' || type === 'sticker')) return bad(`Param ${type}['caption'] is not supported for ${type} messages.`);
      if (caption && caption.length > 1024) return tooLong(`${type}['caption']`, 1024);
      const filename = type === 'document' ? (s(o.filename) ?? info?.filename ?? null) : null;
      const summary = [`[${type}]`, caption, filename, link ?? `media:${id}`].filter(Boolean).join(' ');
      return done({ type, caption, media: { link, id, filename, mimeType: info?.mimeType ?? null, fileSize: info?.fileSize ?? null } }, summary);
    }
    case 'location': {
      const lat = Number(o.latitude);
      const lng = Number(o.longitude);
      if (o.latitude === undefined || !Number.isFinite(lat) || lat < -90 || lat > 90) return bad("Param location['latitude'] is required and must be a number between -90 and 90.");
      if (o.longitude === undefined || !Number.isFinite(lng) || lng < -180 || lng > 180) return bad("Param location['longitude'] is required and must be a number between -180 and 180.");
      const name = s(o.name);
      const address = s(o.address);
      return done({ type, location: { latitude: lat, longitude: lng, name, address } }, `[location] ${[name, address].filter(Boolean).join(', ')} (${lat}, ${lng})`.replace('  ', ' '));
    }
    case 'contacts': {
      const list = b.contacts;
      if (!Array.isArray(list) || !list.length) return bad('The parameter contacts is required and must be a non-empty array.');
      const contacts: NonNullable<WaContent['contacts']> = [];
      for (const [i, c] of (list as unknown[]).entries()) {
        const co = obj(c) ?? {};
        const name = s(obj(co.name)?.formatted_name);
        if (!name) return bad(`Param contacts[${i}]['name']['formatted_name'] is required.`);
        const phones = ((Array.isArray(co.phones) ? co.phones : []) as Record<string, unknown>[]).map((p) => s(p.phone)).filter((x): x is string => !!x);
        const emails = ((Array.isArray(co.emails) ? co.emails : []) as Record<string, unknown>[]).map((p) => s(p.email)).filter((x): x is string => !!x);
        contacts.push({ name, phones, emails });
      }
      return done({ type, contacts }, `[contacts] ${contacts.map((c) => [c.name, ...c.phones].join(' ')).join('; ')}`);
    }
    case 'reaction': {
      const id = s(o.message_id);
      if (!id) return bad("Param reaction['message_id'] is required.");
      const emoji = o.emoji === undefined || o.emoji === null ? '' : String(o.emoji);
      return done({ type, reaction: { messageId: id, emoji } }, emoji ? `[reaction] ${emoji}` : '[reaction removed]');
    }
    case 'interactive':
      return parseInteractive(o, replyTo);
  }
  return bad(`Unsupported message type ${type}`);
}

function parseInteractive(o: Record<string, unknown>, replyTo: string | null): { content: WaContent; summary: string } | { error: WaError } {
  const itype = s(o.type);
  const allowed = ['button', 'list', 'cta_url', 'product', 'product_list', 'flow', 'location_request_message', 'address_message'];
  if (!itype || !allowed.includes(itype)) return bad(`Param interactive['type'] must be one of {${allowed.join(', ')}}.`);
  const body = s(obj(o.body)?.text);
  if (!body && itype !== 'product') return bad("The parameter interactive['body']['text'] is required.");
  if (body && body.length > (itype === 'cta_url' ? 1024 : 4096)) return tooLong("interactive['body']['text']", itype === 'cta_url' ? 1024 : 4096);
  const h = obj(o.header);
  const header = h ? (s(h.text) ?? (s(h.type) ? `[${s(h.type)}]` : null)) : null;
  if (h && s(h.type) === 'text' && (s(h.text)?.length ?? 0) > 60) return tooLong("interactive['header']['text']", 60);
  const footer = s(obj(o.footer)?.text);
  if (footer && footer.length > 60) return tooLong("interactive['footer']['text']", 60);
  const action = obj(o.action);
  if (!action) return bad("The parameter interactive['action'] is required.");
  const base = { type: itype, header, body: body ?? '', footer };

  if (itype === 'button') {
    const raw = action.buttons;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) return bad("Param interactive['action']['buttons'] must have between 1 and 3 elements.");
    const buttons: WaButton[] = [];
    for (const [i, x] of (raw as unknown[]).entries()) {
      const r = obj(obj(x)?.reply);
      if (s(obj(x)?.type) !== 'reply' || !r) return bad(`Param interactive['action']['buttons'][${i}]['type'] must be "reply".`);
      const id = s(r.id);
      const title = s(r.title);
      if (!id) return bad(`Param interactive['action']['buttons'][${i}]['reply']['id'] is required.`);
      if (id.length > 256) return tooLong(`interactive['action']['buttons'][${i}]['reply']['id']`, 256);
      if (!title) return bad(`Param interactive['action']['buttons'][${i}]['reply']['title'] is required.`);
      if (title.length > 20) return tooLong(`interactive['action']['buttons'][${i}]['reply']['title']`, 20);
      if (buttons.some((b) => b.id === id || b.title === title)) return bad('Button ids and titles must be unique.', `Duplicate button "${title}"`);
      buttons.push({ id, title, kind: 'reply' });
    }
    return { content: { type: 'interactive', interactive: { ...base, buttons }, replyTo }, summary: `${body}\n[buttons: ${buttons.map((b) => b.title).join(' | ')}]` };
  }
  if (itype === 'list') {
    const button = s(action.button);
    if (!button) return bad("The parameter interactive['action']['button'] is required.");
    if (button.length > 20) return tooLong("interactive['action']['button']", 20);
    const raw = action.sections;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) return bad("Param interactive['action']['sections'] must have between 1 and 10 elements.");
    const sections: NonNullable<NonNullable<WaContent['interactive']>['sections']> = [];
    const ids = new Set<string>();
    let total = 0;
    for (const [i, x] of (raw as unknown[]).entries()) {
      const so = obj(x) ?? {};
      const title = s(so.title);
      if (raw.length > 1 && !title) return bad(`Param interactive['action']['sections'][${i}]['title'] is required when there is more than one section.`);
      if (title && title.length > 24) return tooLong(`interactive['action']['sections'][${i}]['title']`, 24);
      const rows: WaListRow[] = [];
      const rr = Array.isArray(so.rows) ? (so.rows as unknown[]) : [];
      if (!rr.length) return bad(`Param interactive['action']['sections'][${i}]['rows'] must not be empty.`);
      for (const [j, y] of rr.entries()) {
        const ro = obj(y) ?? {};
        const id = s(ro.id);
        const rt = s(ro.title);
        const desc = s(ro.description);
        const p = `interactive['action']['sections'][${i}]['rows'][${j}]`;
        if (!id) return bad(`Param ${p}['id'] is required.`);
        if (id.length > 200) return tooLong(`${p}['id']`, 200);
        if (ids.has(id)) return bad('Row ids must be unique across all sections.', `Duplicate row id "${id}"`);
        if (!rt) return bad(`Param ${p}['title'] is required.`);
        if (rt.length > 24) return tooLong(`${p}['title']`, 24);
        if (desc && desc.length > 72) return tooLong(`${p}['description']`, 72);
        ids.add(id);
        rows.push({ id, title: rt, description: desc });
      }
      total += rows.length;
      sections.push({ title, rows });
    }
    if (total > 10) return bad('A list message can have at most 10 rows in total.', `Got ${total} rows`);
    const summary = `${body}\n[list "${button}": ${sections.flatMap((x) => x.rows.map((r) => r.title)).join(' | ')}]`;
    return { content: { type: 'interactive', interactive: { ...base, listButton: button, sections }, replyTo }, summary };
  }
  if (itype === 'cta_url') {
    const p = obj(action.parameters);
    const text = s(p?.display_text);
    const url = s(p?.url);
    if (s(action.name) !== 'cta_url') return bad("Param interactive['action']['name'] must be \"cta_url\".");
    if (!text) return bad("Param interactive['action']['parameters']['display_text'] is required.");
    if (text.length > 20) return tooLong("interactive['action']['parameters']['display_text']", 20);
    if (!url || !isUrl(url)) return bad("Param interactive['action']['parameters']['url'] must be a valid URL.");
    return { content: { type: 'interactive', interactive: { ...base, buttons: [{ id: url, title: text, kind: 'url', url }] }, replyTo }, summary: `${body}\n[button] ${text}: ${url}` };
  }
  return { content: { type: 'interactive', interactive: base, replyTo }, summary: `[interactive ${itype}] ${body ?? ''}`.trim() };
}
