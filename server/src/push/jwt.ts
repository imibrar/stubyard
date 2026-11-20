import crypto from 'node:crypto';
import { decodeJwt, verifyJwt, type JwtParts } from '../auth/jwt.js';

/** Key material and JWT checks for the fake FCM OAuth flow (RS256 service account) and APNs provider tokens (ES256). */

export function rsaKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** P-256 key as an Apple .p8 file (PKCS#8 PEM). */
export function p256KeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** A public key PEM from an uploaded PEM / .p8 (private keys are reduced to their public half). */
export function publicPemOf(pem: string): string {
  const text = pem.trim();
  try {
    const key = /PRIVATE KEY/.test(text) ? crypto.createPublicKey(crypto.createPrivateKey(text)) : crypto.createPublicKey(text);
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new Error('Not a PEM public or private key');
  }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const randomId = (n: number, alphabet = ALNUM) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
const URLSAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** APNs device token: 32 bytes as 64 lowercase hex characters. */
export const apnsDeviceToken = () => crypto.randomBytes(32).toString('hex');
/** FCM registration token look-alike: "<22 chars>:APA91b<134 url-safe chars>" (shape only, 163 characters). */
export const fcmRegistrationToken = () => `${randomId(22, URLSAFE)}:APA91b${randomId(134, URLSAFE)}`;

export interface CheckedJwt {
  parts: JwtParts | null;
  verified: boolean;
  /** Problems found; the caller decides whether they reject (strict) or only warn (lax). */
  problems: { code: string; message: string }[];
}

const GOOGLE_AUDIENCES = ['https://oauth2.googleapis.com/token', 'https://www.googleapis.com/oauth2/v4/token', 'https://accounts.google.com/o/oauth2/token'];
export const FCM_SCOPES = ['https://www.googleapis.com/auth/firebase.messaging', 'https://www.googleapis.com/auth/cloud-platform'];

/** Service-account assertion (grant_type jwt-bearer): RS256 signature, iss, aud, iat / exp. */
export function checkAssertion(assertion: string, o: { publicKeyPem: string; clientEmail: string; tokenUri: string }): CheckedJwt & { scopes: string[] } {
  const parts = decodeJwt(assertion);
  if (!parts) return { parts: null, verified: false, problems: [{ code: 'malformed', message: 'Invalid JWT: the assertion is not a signed JWT (header.payload.signature).' }], scopes: [] };
  const problems: CheckedJwt['problems'] = [];
  const verified = String(parts.header.alg) === 'RS256' && !!verifyJwt(assertion, o.publicKeyPem);
  if (!verified) problems.push({ code: 'signature', message: 'Invalid JWT Signature.' });
  const p = parts.payload;
  if (String(p.iss ?? '') !== o.clientEmail) problems.push({ code: 'iss', message: 'Invalid email or User ID' });
  const aud = String(p.aud ?? '');
  // token_uri of the downloaded service account: any origin (http://localhost:4000, https://localhost:4443, a proxy) with this path.
  if (aud !== o.tokenUri && !(o.tokenUri.startsWith('/') && aud.endsWith(o.tokenUri)) && !GOOGLE_AUDIENCES.includes(aud)) problems.push({ code: 'aud', message: `Invalid JWT: Failed audience check. The audience must be ${o.tokenUri} (or https://oauth2.googleapis.com/token).` });
  const now = Math.floor(Date.now() / 1000);
  const iat = Number(p.iat);
  const exp = Number(p.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat || exp - iat > 3900 || exp < now - 60 || iat > now + 300) {
    problems.push({
      code: 'exp',
      message: "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your 'iat' and 'exp' values and use a clock with skew to account for clock differences between systems.",
    });
  }
  const scopes = String(p.scope ?? '').split(/\s+/).filter(Boolean);
  return { parts, verified, problems, scopes };
}

/** APNs provider token: ES256, kid = key id, iss = team id, iat not older than one hour. */
export function checkProviderToken(jwt: string, o: { publicKeyPem: string; keyId: string; teamId: string }): CheckedJwt & { reason: string | null; iat: number | null } {
  const parts = decodeJwt(jwt);
  if (!parts) return { parts: null, verified: false, problems: [{ code: 'malformed', message: 'The provider token is not a JWT' }], reason: 'InvalidProviderToken', iat: null };
  const problems: CheckedJwt['problems'] = [];
  let reason: string | null = null;
  if (String(parts.header.alg) !== 'ES256') (problems.push({ code: 'alg', message: `alg must be ES256 (got ${String(parts.header.alg)})` }), (reason ??= 'InvalidProviderToken'));
  if (String(parts.header.kid ?? '') !== o.keyId) (problems.push({ code: 'kid', message: `kid "${String(parts.header.kid ?? '')}" is not this instance's key id ${o.keyId}` }), (reason ??= 'InvalidProviderToken'));
  if (String(parts.payload.iss ?? '') !== o.teamId) (problems.push({ code: 'iss', message: `iss "${String(parts.payload.iss ?? '')}" is not the team id ${o.teamId}` }), (reason ??= 'InvalidProviderToken'));
  const verified = !!verifyJwt(jwt, o.publicKeyPem);
  if (!verified) (problems.push({ code: 'signature', message: 'The provider token signature cannot be verified with the instance key' }), (reason ??= 'InvalidProviderToken'));
  const iat = Number(parts.payload.iat);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(iat)) (problems.push({ code: 'iat', message: 'iat claim missing' }), (reason ??= 'InvalidProviderToken'));
  else if (now - iat > 3600) (problems.push({ code: 'expired', message: `The provider token was issued ${Math.round((now - iat) / 60)} minutes ago (more than 60)` }), (reason ??= 'ExpiredProviderToken'));
  return { parts, verified, problems, reason, iat: Number.isFinite(iat) ? iat : null };
}
