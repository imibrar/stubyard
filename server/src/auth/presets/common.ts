import crypto from 'node:crypto';
import type { Ctx, Issued, Out, Profile } from './types.js';

/** Request parameters: query string merged with a form / JSON body. */
export function input(c: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (o: unknown) => {
    if (!o || typeof o !== 'object' || Buffer.isBuffer(o)) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[k] = Array.isArray(v) ? String(v[0]) : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  };
  add(c.req.query);
  add(c.req.body);
  return out;
}

// ---- deterministic id formats (from sha256(provider slug + user id)) ----
export function digits(hash: Buffer, n: number, firstNonZero = true): string {
  let v = BigInt('0x' + hash.toString('hex'));
  let s = '';
  for (let i = 0; i < n; i++) {
    s += String(v % 10n);
    v /= 10n;
  }
  if (firstNonZero && s[0] === '0') s = String(1 + (Number(hash[0]) % 9)) + s.slice(1);
  return s;
}

export function hex(hash: Buffer, n: number): string {
  let h = hash.toString('hex');
  while (h.length < n) h += crypto.createHash('sha256').update(h).digest('hex');
  return h.slice(0, n);
}

export function guid(hash: Buffer, salt = ''): string {
  const h = salt ? crypto.createHash('sha256').update(hash).update(salt).digest('hex') : hash.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function alnum(hash: Buffer, n: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'): string {
  let v = BigInt('0x' + hash.toString('hex'));
  let s = '';
  const base = BigInt(alphabet.length);
  for (let i = 0; i < n; i++) {
    s += alphabet[Number(v % base)];
    v /= base;
    if (v === 0n) v = BigInt('0x' + crypto.createHash('sha256').update(hash).update(String(i)).digest('hex'));
  }
  return s;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

// ---- standard OAuth / OIDC shapes ----
export const stdTokenError = (_c: Ctx, error: string, description: string, status: number): Out => ({
  status,
  body: { error, error_description: description },
  headers: { 'cache-control': 'no-store', ...(status === 401 ? { 'www-authenticate': 'Basic realm="stubyard"' } : {}) },
});

export const bearerUnauthorized = (_c: Ctx, description: string): Out => ({
  status: 401,
  body: { error: 'invalid_token', error_description: description },
  headers: { 'www-authenticate': `Bearer error="invalid_token", error_description="${description.replace(/"/g, "'")}"` },
});

export function stdTokenResponse(_c: Ctx, t: Issued, extra: Record<string, unknown> = {}): Out {
  return {
    body: {
      access_token: t.access_token,
      token_type: t.token_type,
      ...(t.expires_in !== null ? { expires_in: t.expires_in } : {}),
      ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
      scope: t.scope,
      ...(t.id_token ? { id_token: t.id_token } : {}),
      ...extra,
    },
    headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
  };
}

export function hasScope(scopes: string[], any: string[] | null): boolean {
  return any === null || any.some((s) => scopes.includes(s));
}

/** OIDC standard claims for a profile, filtered by the profile / email scopes. */
export function standardClaims(p: Profile, scopes: string[], opts: { emailScopes?: string[] | null; profileAlways?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { sub: p.sub };
  if (opts.profileAlways || scopes.includes('profile')) {
    Object.assign(out, { name: p.name, given_name: p.givenName, family_name: p.familyName, picture: p.picture });
  }
  if (p.email && hasScope(scopes, opts.emailScopes === undefined ? ['email'] : opts.emailScopes)) {
    Object.assign(out, { email: p.email, email_verified: p.emailVerified });
  }
  return out;
}

export const oidcScopes = ['openid', 'profile', 'email', 'offline_access', 'address', 'phone'];

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Out => ({ status, body, headers });
