import crypto from 'node:crypto';

/** Minimal JWS (RS256) helpers on node:crypto — no runtime dependency. */

export const b64u = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export function b64uJson(value: unknown): string {
  return b64u(JSON.stringify(value));
}

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signingInput: string;
}

export function signJwt(payload: Record<string, unknown>, key: { kid: string; privatePem: string }, extraHeader: Record<string, unknown> = {}): string {
  const header = { alg: 'RS256', kid: key.kid, typ: 'JWT', ...extraHeader };
  const input = `${b64uJson(header)}.${b64uJson(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), key.privatePem);
  return `${input}.${b64u(sig)}`;
}

/** Decode without verifying. Returns null for anything that is not a three-part JWS with JSON header/payload. */
export function decodeJwt(token: string): JwtParts | null {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return null;
    return { header, payload, signature: Buffer.from(parts[2], 'base64url'), signingInput: `${parts[0]}.${parts[1]}` };
  } catch {
    return null;
  }
}

/** Verify an RS256 / ES256 JWS against a PEM or JWK public key. */
export function verifyJwt(token: string, publicKey: crypto.KeyObject | string | Record<string, unknown>): JwtParts | null {
  const d = decodeJwt(token);
  if (!d) return null;
  const key = typeof publicKey === 'object' && !(publicKey instanceof crypto.KeyObject) ? crypto.createPublicKey({ key: publicKey as never, format: 'jwk' }) : publicKey;
  const alg = String(d.header.alg);
  let ok = false;
  try {
    if (alg === 'RS256') ok = crypto.verify('RSA-SHA256', Buffer.from(d.signingInput), key, d.signature);
    else if (alg === 'ES256') ok = crypto.verify('sha256', Buffer.from(d.signingInput), { key: key as crypto.KeyObject, dsaEncoding: 'ieee-p1363' }, d.signature);
  } catch {
    ok = false;
  }
  return ok ? d : null;
}

/** OIDC at_hash / c_hash: left half of SHA-256, base64url. */
export function halfHash(value: string): string {
  const h = crypto.createHash('sha256').update(value).digest();
  return b64u(h.subarray(0, h.length / 2));
}

/** PKCE S256 transform. */
export function pkceS256(verifier: string): string {
  return b64u(crypto.createHash('sha256').update(verifier).digest());
}

/** Flip bits in the signature so verification fails (scenario "bad_signature"). */
export function corruptSignature(token: string): string {
  const parts = token.split('.');
  const sig = Buffer.from(parts[2], 'base64url');
  for (let i = 0; i < Math.min(8, sig.length); i++) sig[i] ^= 0xff;
  return `${parts[0]}.${parts[1]}.${b64u(sig)}`;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
