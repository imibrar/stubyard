import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes for sign-in: scrypt from node:crypto, stored as
 *
 *   scrypt:<N>:<r>:<p>:<salt, base64url>:<64-byte key, base64url>
 *
 * e.g. "scrypt:16384:8:1:Qm9i…:x2Y…". No "$" in the format, so the value can go into a docker compose file or a
 * .env file without escaping. Make one with `npm run hash-password -w server` (or, in the image,
 * `node dist/access/hash-password.js`).
 */

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LEN = 64;
/** Parameters accepted from a stored hash (keeps a crafted hash from making every login burn memory or CPU). */
const MAX_N = 1 << 20;
export const MIN_PASSWORD_LENGTH = 8;

export interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function derive(password: string, salt: Buffer, N: number, r: number, p: number, len: number): Buffer {
  // maxmem: 128 * N * r bytes plus headroom (the default 32 MB is too small above N = 2^15).
  return scryptSync(password.normalize('NFC'), salt, len, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
}

/** A new hash with a random salt. */
export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  const key = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LEN);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join(':');
}

/** The parts of a stored hash, or null when it is not in the format above. */
export function parseHash(stored: string): ParsedHash | null {
  const m = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(stored.trim());
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!(N > 1 && N <= MAX_N && (N & (N - 1)) === 0) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16)) return null;
  const salt = Buffer.from(m[4], 'base64url');
  const key = Buffer.from(m[5], 'base64url');
  if (salt.length < 8 || key.length < 16) return null;
  return { N, r, p, salt, key };
}

/** Constant-time check of a password against a stored hash (false for a malformed hash). */
export function verifyPassword(password: string, stored: string): boolean {
  const h = parseHash(stored);
  if (!h) return false;
  const got = derive(password, h.salt, h.N, h.r, h.p, h.key.length);
  return got.length === h.key.length && timingSafeEqual(got, h.key);
}

/**
 * The admin's password hash from the environment: STUBYARD_ADMIN_PASSWORD_HASH as given (checked), or
 * STUBYARD_ADMIN_PASSWORD hashed here. The plain password is hashed with a salt derived from the e-mail address, so
 * the same settings give the same hash on every start (sessions survive a restart; a new password ends them).
 */
export function adminPasswordHash(email: string, password: string, hash: string): string {
  if (hash) {
    if (!parseHash(hash)) throw new Error('STUBYARD_ADMIN_PASSWORD_HASH is not a stubyard scrypt hash ("scrypt:N:r:p:salt:hash"); make one with "npm run hash-password -w server"');
    return hash;
  }
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`STUBYARD_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const salt = createHash('sha256').update(`stubyard-admin-salt:${email}`).digest().subarray(0, 16);
  return hashPassword(password, salt);
}

/** sha256 hex (session and token ids: only the hash of a secret is stored). */
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Constant-time string comparison (hashes both sides first, so lengths leak nothing either). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
