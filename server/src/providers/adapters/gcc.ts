import { normalizePhone } from '../../util.js';
import { cfg, type ConfigField, type Ctx, type MockRequest } from './types.js';

/**
 * Shared bits of the Saudi / GCC SMS presets (Unifonic, Taqnyat, Msegat, 4Jawaly, OurSMS).
 * Research notes and sources: docs/plans/research-sms-gcc.md.
 */

/** Vendor-specific failures a rule can ask for by name (errorCode "sender", "balance", …). */
export type GccError = 'auth' | 'sender' | 'balance' | 'number';

const ALIASES: Record<string, GccError> = {
  auth: 'auth',
  credentials: 'auth',
  invalid_credentials: 'auth',
  sender: 'sender',
  sender_not_approved: 'sender',
  sender_not_active: 'sender',
  balance: 'balance',
  insufficient_balance: 'balance',
  no_balance: 'balance',
  number: 'number',
  invalid_number: 'number',
};

/** A rule's errorCode as a named vendor failure ("sender", "balance", "auth", "number"), else null. */
export function gccAlias(code: string | null): GccError | null {
  return code ? ALIASES[code.trim().toLowerCase().replace(/-/g, '_')] ?? null : null;
}

export const BALANCE_FIELD: ConfigField = {
  key: 'balance',
  label: 'Account balance',
  hint: '"0": every send fails with the vendor\'s balance-exhausted error. Also what the balance endpoint reports. Empty: 1000.',
  placeholder: '1000',
};

export const SENDERS_FIELD: ConfigField = {
  key: 'approvedSenders',
  label: 'Approved sender IDs',
  hint: 'Comma-separated. When set, any other sender fails with the vendor\'s "sender not approved / not active" error. Empty: any sender works.',
  placeholder: 'MyBrand,MyBrand-AD',
};

export const DLR_FIELD: ConfigField = {
  key: 'statusCallbackUrl',
  label: 'Delivery report (DLR) URL',
  hint: "Your app's DLR webhook (set in the vendor's portal in real life). stubyard POSTs the final status (delivered / failed) in the vendor's format.",
  placeholder: 'http://host.docker.internal:3000/webhooks/sms/dlr',
};

/** Configured balance (default 1000). */
export function balanceOf(ctx: Ctx): number {
  const b = Number(cfg(ctx, 'balance') ?? '1000');
  return Number.isFinite(b) ? b : 1000;
}

export function approvedSenders(ctx: Ctx): string[] {
  return (cfg(ctx, 'approvedSenders') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Account-state failures configured on the instance: balance exhausted, sender not approved. */
export function gccGate(ctx: Ctx, sender: string | null): GccError | null {
  if (balanceOf(ctx) <= 0) return 'balance';
  const allowed = approvedSenders(ctx);
  if (allowed.length && !allowed.some((s) => s.toLowerCase() === (sender ?? '').toLowerCase())) return 'sender';
  return null;
}

/** A credential is accepted when it is present and, if the instance sets one, equal to it. */
export function credentialOk(ctx: Ctx, key: string, given: string | null): boolean {
  if (!given) return false;
  const want = cfg(ctx, key);
  return !want || want === given;
}

/**
 * Saudi apps send numbers as 9665…, 009665…, +9665… or local 05… / 5…: all become +9665….
 * Anything else goes through the usual normalisation.
 */
export function ksaPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.trim().replace(/[\s\-().]/g, '');
  if (/^05\d{8}$/.test(d)) return '+966' + d.slice(1);
  if (/^5\d{8}$/.test(d)) return '+966' + d;
  return normalizePhone(d);
}

/** International digits without "+" (how these vendors print numbers). */
export const intl = (p: string | null) => (p ?? '').replace(/^\+/, '');

export function header(req: MockRequest, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s ? String(s) : null;
}

export function bearerToken(req: MockRequest): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header(req, 'authorization') ?? '');
  return m ? m[1].trim() : null;
}

export function basicAuth(req: MockRequest): { user: string; pass: string } | null {
  const m = /^Basic\s+(.+)$/i.exec(header(req, 'authorization') ?? '');
  if (!m) return null;
  const s = Buffer.from(m[1].trim(), 'base64').toString('utf8');
  const i = s.indexOf(':');
  return i < 0 ? { user: s, pass: '' } : { user: s.slice(0, i), pass: s.slice(i + 1) };
}

/** Case-insensitive field lookup (AppSid / appSid / appsid). */
export function pick(f: Record<string, unknown>, name: string): unknown {
  if (name in f) return f[name];
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(f)) if (k.toLowerCase() === want) return v;
  return undefined;
}

/** Recipients given as an array or a comma-separated string. */
export function list(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : String(v).split(',');
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/** "2026-11-25 14:06:25" (local-style timestamps these vendors print). */
export const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);
