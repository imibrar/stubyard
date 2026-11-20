import type { Channel } from '../catalog.js';
import type { Message } from '../../repos/messages.js';
import type { Project } from '../../repos/projects.js';
import type { ProviderInstance } from '../../repos/providers.js';

export interface MockRequest {
  method: string;
  /** Path after /mock/<project>/<instance>, starting with "/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed body (JSON object, form fields, text or Buffer). */
  body: unknown;
  /** Full URL the app called, as seen by stubyard (for signatures). */
  url: string;
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ParsedSend {
  channel: Channel;
  to: string;
  from: string | null;
  body: string;
  /** Per-message status callback URL (e.g. Twilio StatusCallback, Vonage callback). */
  statusCallbackUrl?: string | null;
  extra?: Record<string, unknown>;
}

/** Normalised delivery statuses; adapters translate them to provider wording. "read": WhatsApp read receipt. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/** Errors that happen when the app calls the provider (the API answers with an error). */
export type SendError = 'reject' | 'blocked' | 'rate_limit' | 'down' | 'opt_out';

export interface Ctx {
  project: Project;
  instance: ProviderInstance;
  /** stubyard's base URL as the app reached it (http or https). */
  baseUrl: string;
  /** Uploaded WhatsApp media of this instance (Meta media ids). */
  media?: (id: string) => { mimeType: string; fileSize: number; filename: string | null } | null;
}

export interface OutboundCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: string;
}

export type MatchResult =
  | { kind: 'send' }
  | { kind: 'fetch'; id: string }
  /** WhatsApp Cloud API media endpoints. */
  | { kind: 'media-upload' }
  | { kind: 'media-get'; id: string }
  | { kind: 'media-delete'; id: string }
  | { kind: 'media-download'; id: string }
  /** The app marks an inbound WhatsApp message as read (POST …/messages {"status":"read"}). */
  | { kind: 'mark-read'; id: string }
  | null;

/** A test user's reply (inbound webhook input). */
export interface InboundInput {
  id: string;
  channel: Channel;
  from: string;
  to: string;
  text: string;
  profileName: string;
  /** Tapped button / list row of an earlier interactive message. */
  reply?: { kind: 'button_reply' | 'list_reply' | 'button'; id: string; title: string; description?: string | null } | null;
  /** The message replied to (provider id + sender). */
  context?: { id: string; from: string | null } | null;
}

/** Speaks one provider's API: request format, responses, error codes, callbacks and inbound webhooks. */
export interface ProviderAdapter {
  preset: string;
  /** Which endpoint of the provider API this is (null → 404 in the provider's style). */
  match(req: MockRequest, ctx: Ctx): MatchResult;
  parse(req: MockRequest, ctx: Ctx): ParsedSend | { error: Reply };
  newMessageId(): string;
  /** Errors that the real provider reports at send time vs. via a failed delivery report. */
  blockedAt: 'send' | 'delivery';
  accepted(ctx: Ctx, m: { id: string; parsed: ParsedSend; createdAt: string }): Reply;
  sendError(ctx: Ctx, kind: SendError, parsed: ParsedSend | null, code: string | null, message: string | null): Reply;
  /** Default delivery-failure code/message when a rule doesn't set one. */
  defaultFailure(kind: 'fail' | 'blocked'): { code: string; message: string };
  notFound(req: MockRequest): Reply;
  /** Status callback for a message, or null when no URL is known. */
  statusCallback(ctx: Ctx, m: Message, status: DeliveryStatus, err: { code: string; message: string } | null, url: string): OutboundCall;
  /** Webhook the provider would send when the user replies. */
  inbound(ctx: Ctx, m: InboundInput, url: string): OutboundCall;
  /** WhatsApp 24-hour customer service window: the failure for a free-form message outside it (null: not enforced). */
  windowError?: { code: string; message: string };
  /** Is this send a template (allowed outside the 24-hour window)? */
  isTemplate?(parsed: ParsedSend): boolean;
  /** WhatsApp media API replies (Meta). */
  mediaReply?(ctx: Ctx, kind: 'uploaded' | 'info' | 'deleted' | 'not_found' | 'error', data: Record<string, unknown>): Reply;
  /** Provider "fetch message" endpoint. */
  fetch?(ctx: Ctx, m: Message | null, id: string): Reply;
  /** Config keys this preset uses (shown in the dashboard). */
  configFields: ConfigField[];
}

export interface ConfigField {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
}

export const STATUS_CALLBACK_FIELD: ConfigField = {
  key: 'statusCallbackUrl',
  label: 'Status callback URL',
  hint: "Your app's delivery-report webhook. stubyard POSTs status updates here.",
  placeholder: 'http://host.docker.internal:3000/webhooks/sms/status',
};

export const INBOUND_FIELD: ConfigField = {
  key: 'inboundUrl',
  label: 'Inbound message URL',
  hint: 'Where stubyard sends replies from test users.',
  placeholder: 'http://host.docker.internal:3000/webhooks/sms/inbound',
};

export const READ_RECEIPTS_FIELD: ConfigField = {
  key: 'readReceipts',
  label: 'Read receipts',
  hint: '"true": after "delivered", stubyard also reports "read" (WhatsApp). The workspace has a "Mark as read" action either way.',
  placeholder: 'false',
};

export const WINDOW_FIELD: ConfigField = {
  key: 'enforce24hWindow',
  label: '24-hour window',
  hint: '"true": a free-form (non-template) WhatsApp message to a user who has not written in the last 24 h fails (Meta 131047, Twilio 63016).',
  placeholder: 'false',
};

export function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  const s = String(v);
  return s === '' ? null : s;
}

/** Body fields from JSON, form or query string, merged (body wins). */
export function fields(req: MockRequest): Record<string, unknown> {
  const b = req.body;
  const obj = b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {};
  return { ...req.query, ...obj };
}

export function randomHex(n: number): string {
  let s = '';
  while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function cfg(ctx: Ctx, key: string): string | null {
  return str(ctx.instance.config[key]);
}

export function form(o: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) p.set(k, v);
  return p.toString();
}
