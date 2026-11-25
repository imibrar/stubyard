import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Json } from './gateway.js';

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function randomFrom(alphabet: string, n: number): string {
  const b = randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[b[i]! % alphabet.length];
  return s;
}
export const alnum = (n: number) => randomFrom(ALNUM, n);
export const upper = (n: number) => randomFrom(UPPER, n);
export const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(0, 10))).join('');

/** The instance's fixed browser base (config.browserBaseUrl as an http(s) URL), or null (unset or "request-host"). */
export function fixedBrowserBase(inst: { config: { browserBaseUrl?: string | null } }): string | null {
  const v = inst.config.browserBaseUrl;
  return v && v !== 'request-host' ? v : null;
}

/** Request body as an object: JSON as is; form bodies with Stripe-style bracket keys (a[b][0][c]=1) nested. */
export function bodyOf(req: FastifyRequest): Json {
  const b = req.body;
  if (!b || typeof b !== 'object' || Buffer.isBuffer(b)) return {};
  const ct = String(req.headers['content-type'] ?? '');
  if (/application\/x-www-form-urlencoded/i.test(ct)) return parseBracketForm(b as Record<string, string | string[]>);
  return Array.isArray(b) ? {} : (b as Json);
}

/**
 * Stripe form encoding → nested object. "line_items[0][price_data][unit_amount]=500" → { line_items: [{ price_data: { unit_amount: "500" } }] };
 * "expand[]=a&expand[]=b" → { expand: ["a", "b"] }. Numeric segments make arrays.
 */
export function parseBracketForm(flat: Record<string, string | string[]>): Json {
  const root: Json = {};
  for (const [key, raw] of Object.entries(flat)) {
    const values = Array.isArray(raw) ? raw : [raw];
    const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
    if (!m) {
      root[key] = values.length > 1 ? values : values[0];
      continue;
    }
    const path = [m[1]!, ...[...m[2]!.matchAll(/\[([^[\]]*)\]/g)].map((x) => x[1]!)];
    for (const v of values) setPath(root, path, v);
  }
  return compactArrays(root) as Json;
}

function setPath(obj: Json, path: string[], value: string): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const last = i === path.length - 1;
    const nextSeg = path[i + 1];
    if (seg === '') {
      // a[]=x: push onto an array held under a sentinel
      const arr = (cur.__push ??= []) as unknown[];
      if (last) arr.push(value);
      else {
        const o: Json = {};
        arr.push(o);
        cur = o;
      }
      continue;
    }
    if (last) {
      cur[seg] = value;
      return;
    }
    if (nextSeg === '') {
      const holder = (cur[seg] ??= {}) as Json;
      cur = holder;
      continue;
    }
    cur = (cur[seg] ??= {}) as Record<string, unknown>;
  }
}

/** Objects whose keys are all numbers (or a __push list) become arrays. */
function compactArrays(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return Array.isArray(v) ? v.map(compactArrays) : v;
  const o = v as Json;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === '__push') return (o.__push as unknown[]).map(compactArrays);
  if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
    return keys
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => compactArrays(o[String(k)]));
  }
  const out: Json = {};
  for (const k of keys) out[k] = compactArrays(o[k]);
  return out;
}

export const header = (req: FastifyRequest, name: string): string | null => {
  const v = req.headers[name.toLowerCase()];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === '' ? null : String(s);
};

export const asString = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]);

/** HTTP Basic credentials of a request (Moyasar: the API key as user name, empty password); null when absent or not Basic. */
export function basicAuth(req: FastifyRequest): { user: string; pass: string } | null {
  const h = header(req, 'authorization');
  const m = h ? /^Basic\s+(\S+)$/i.exec(h) : null;
  if (!m) return null;
  const raw = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return i < 0 ? { user: raw, pass: '' } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

/** The token of "Authorization: Bearer <token>" (null when absent or another scheme). */
export function bearerToken(req: FastifyRequest): string | null {
  const h = header(req, 'authorization');
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1]! : null;
}

/** A production-looking API key (sk_live_ / pk_live_ / rk_live_). */
export const isLiveKey = (k: string | null | undefined): boolean => !!k && /^(sk|pk|rk)_live_/i.test(k);

/** A random UUID v4 (Moyasar / Tabby / Tamara ids). */
export const uuid = (): string => randomUUID();

/** base64url of a string or buffer (JWTs). */
export const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

export const unix = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** Small LRU of idempotent responses per instance (Stripe Idempotency-Key, PayPal-Request-Id). In memory only. */
export class IdempotencyCache {
  private map = new Map<string, { hash: string; status: number; body: unknown; at: number }>();
  constructor(private max = 1000) {}
  get(key: string) {
    return this.map.get(key) ?? null;
  }
  set(key: string, hash: string, status: number, body: unknown): void {
    this.map.delete(key);
    this.map.set(key, { hash, status, body, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** In-memory values (card tokens) that expire after ttlMs; at most max entries, the oldest dropped first. */
export class ExpiringStore<T> {
  private map = new Map<string, { v: T; exp: number }>();
  constructor(
    private ttlMs = 15 * 60_000,
    private max = 1000,
  ) {}
  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }
  set(key: string, v: T): void {
    const now = Date.now();
    this.map.delete(key);
    this.map.set(key, { v, exp: now + this.ttlMs });
    for (const [k, e] of this.map) {
      if (this.map.size <= this.max && e.exp > now) break;
      this.map.delete(k);
    }
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
}

/** Constant-time string compare (signatures, hashes). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** decodeURIComponent for path / query ids; malformed percent-encoding stays as is (then simply not found). */
export function decodeRef(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** PHP urlencode (spaces as +), used by PayTabs' return signature. */
export function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

// ---------------- privacy: card fields and credential headers ----------------

const CARD_SECRET = new Set(['cvv', 'cvc', 'cvv2', 'cvc2', 'security_code', 'securitycode']);
const CARD_PAN = new Set(['pan', 'card_number', 'cardnumber']);
const MASK = '••••';
const digitsOf = (v: string) => v.replace(/\D/g, '');
const looksLikePan = (v: string) => /^[\d\s-]+$/.test(v) && digitsOf(v).length >= 12 && digitsOf(v).length <= 19;
const maskPan = (v: string) => (digitsOf(v).length >= 4 ? `${MASK}${digitsOf(v).slice(-4)}` : MASK);

/** Masked value for a card field (undefined: not a card field). "number" counts only when it looks like a PAN. */
function maskCardValue(key: string, v: unknown): string | undefined {
  if (v === undefined || v === null || v === '' || typeof v === 'object') return undefined;
  const k = key.toLowerCase();
  const s = String(v);
  if (CARD_SECRET.has(k)) return MASK;
  if (CARD_PAN.has(k) || (k === 'number' && looksLikePan(s))) return maskPan(s);
  return undefined;
}

/** Deep copy with pan / number / card_number (last 4 kept) and cvv / cvc / security_code masked. */
export function maskCardFields<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => maskCardFields(x)) as unknown as T;
  if (!v || typeof v !== 'object' || Buffer.isBuffer(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = maskCardValue(k, x) ?? maskCardFields(x);
  return out as T;
}

/** The same for a raw request body (JSON or form; Stripe bracket keys such as card[number]). Unchanged when nothing matched. */
export function maskCardText(text: string | null, contentType: string): string | null {
  if (!text) return text;
  if (/[/+]json\b/i.test(contentType)) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const masked = maskCardFields(parsed);
      return JSON.stringify(masked) === JSON.stringify(parsed) ? text : JSON.stringify(masked);
    } catch {
      return text;
    }
  }
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const params = new URLSearchParams(text);
    let changed = false;
    const out = new URLSearchParams();
    for (const [k, v] of params) {
      const leaf = /([^[\]]+)\]?$/.exec(k)?.[1] ?? k;
      const m = maskCardValue(leaf, v);
      if (m !== undefined) changed = true;
      out.append(k, m ?? v);
    }
    return changed ? out.toString() : text;
  }
  return text;
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'paypal-auth-assertion']);

/** "Bearer sk_test_51Ab…wxyz" → "Bearer sk_test_••••wxyz": the scheme, a short prefix and the last 4 characters. */
export function redactCredential(value: string): string {
  const m = /^(\S+\s+)?(\S.*)$/.exec(value.trim());
  if (!m) return MASK;
  const scheme = m[1] && /^(bearer|basic|token|digest)\s+$/i.test(m[1]) ? m[1] : '';
  const cred = scheme ? m[2]! : value.trim();
  const known = /^(sk|rk|pk)_(test|live)_/.exec(cred)?.[0];
  const prefix = known ?? (cred.length >= 16 ? cred.slice(0, 4) : '');
  const last = cred.length >= 12 ? cred.slice(-4) : '';
  return `${scheme}${prefix}${MASK}${last}`;
}

/** Request headers for the traffic log of gateway calls: credential headers redacted. */
export function redactCredentialHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (!CREDENTIAL_HEADERS.has(k.toLowerCase()) || v === undefined) out[k] = v;
    else out[k] = Array.isArray(v) ? v.map((x) => redactCredential(String(x))) : redactCredential(String(v));
  }
  return out;
}
