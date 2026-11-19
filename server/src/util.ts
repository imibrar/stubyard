import { randomBytes } from 'node:crypto';

/** Time-sortable unique id: 9 chars of ms timestamp (base36) + 10 random chars. */
export function newId(): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(8).toString('base64url').replace(/[-_]/g, '').slice(0, 10).toLowerCase();
  return t + r.padEnd(10, '0');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Normalize a phone / WhatsApp number to "+<digits>". Accepts "whatsapp:+92…", spaces, dashes, "00" prefix. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let p = String(phone).trim().replace(/^whatsapp:/i, '');
  p = p.replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  const digits = p.replace(/[^\d]/g, '');
  if (digits === '') return null;
  return '+' + digits;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function truncateBuffer(buf: Buffer, max: number): { text: string; size: number; truncated: boolean } {
  const size = buf.length;
  const slice = size > max ? buf.subarray(0, max) : buf;
  return { text: slice.toString('utf8'), size, truncated: size > max };
}
