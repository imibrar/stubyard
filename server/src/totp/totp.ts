import { createHmac } from 'node:crypto';
import { HttpError } from '../util.js';

/**
 * TOTP (RFC 6238) / HOTP (RFC 4226) — the same algorithm Google Authenticator,
 * Microsoft Authenticator, Authy etc. use. Secrets are base32 (RFC 4648).
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpParams {
  secret: string; // base32
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Normalize user input: strip spaces/dashes, uppercase, drop padding. */
export function normalizeSecret(input: string): string {
  return input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
}

export function base32Decode(input: string): Buffer {
  const s = normalizeSecret(input);
  if (!s) throw new HttpError(400, 'Secret key is empty');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new HttpError(400, `Secret key is not valid base32 (unexpected "${ch}"). Use the key exactly as your app shows it.`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(key: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export interface TotpCode {
  code: string;
  nextCode: string;
  period: number;
  /** Seconds until `code` expires. */
  remaining: number;
  /** Unix ms when the current code started being valid. */
  validFrom: number;
  validUntil: number;
}

export function totp(p: TotpParams, nowMs = Date.now()): TotpCode {
  const key = base32Decode(p.secret);
  const counter = Math.floor(nowMs / 1000 / p.period);
  const validFrom = counter * p.period * 1000;
  const validUntil = validFrom + p.period * 1000;
  return {
    code: hotp(key, counter, p.digits, p.algorithm),
    nextCode: hotp(key, counter + 1, p.digits, p.algorithm),
    period: p.period,
    remaining: Math.max(0, Math.ceil((validUntil - nowMs) / 1000)),
    validFrom,
    validUntil,
  };
}

export interface ParsedOtpauth {
  secret: string;
  issuer: string | null;
  account: string | null;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

/** Parse otpauth://totp/Issuer:account?secret=…&issuer=…&algorithm=…&digits=…&period=… */
export function parseOtpauth(uri: string): ParsedOtpauth {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new HttpError(400, 'Not a valid otpauth:// link');
  }
  if (url.protocol !== 'otpauth:') throw new HttpError(400, 'Link must start with otpauth://');
  if (url.hostname.toLowerCase() !== 'totp') {
    throw new HttpError(400, `Only time-based codes (otpauth://totp) are supported, got otpauth://${url.hostname}`);
  }
  const secret = url.searchParams.get('secret');
  if (!secret) throw new HttpError(400, 'The otpauth link has no secret= parameter');
  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [labelIssuer, labelAccount] = label.includes(':') ? label.split(/:(.*)/s, 2) : [null, label || null];
  return {
    secret: normalizeSecret(secret),
    issuer: url.searchParams.get('issuer') ?? labelIssuer?.trim() ?? null,
    account: labelAccount?.trim() || null,
    algorithm: checkAlgorithm(url.searchParams.get('algorithm') ?? 'SHA1'),
    digits: checkDigits(Number(url.searchParams.get('digits') ?? 6)),
    period: checkPeriod(Number(url.searchParams.get('period') ?? 30)),
  };
}

export function checkAlgorithm(a: string): TotpAlgorithm {
  const up = a.toUpperCase().replace('-', '');
  if (up === 'SHA1' || up === 'SHA256' || up === 'SHA512') return up;
  throw new HttpError(400, `Unsupported algorithm "${a}" (use SHA1, SHA256 or SHA512)`);
}

export function checkDigits(d: number): number {
  if (!Number.isInteger(d) || d < 6 || d > 10) throw new HttpError(400, 'Digits must be between 6 and 10');
  return d;
}

export function checkPeriod(p: number): number {
  if (!Number.isInteger(p) || p < 10 || p > 300) throw new HttpError(400, 'Period must be between 10 and 300 seconds');
  return p;
}
