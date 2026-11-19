import crypto from 'node:crypto';
import { decodeJwt, nowSec, verifyJwt } from '../jwt.js';
import { digits, hex, stdTokenError, stdTokenResponse } from './common.js';
import type { PresetDef } from './types.js';

export const apple: PresetDef = {
  id: 'apple',
  name: 'Apple',
  protocol: 'oidc',
  description: 'Sign in with Apple: appleid.apple.com/auth/*, form_post callback with the one-time `user` JSON, Hide My Email relay addresses, client_secret JWT.',
  realBase: 'https://appleid.apple.com',
  routes: [
    { method: 'GET', path: /^\/\.well-known\/openid-configuration$/, endpoint: 'discovery' },
    { method: 'ANY', path: /^\/auth\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/auth\/token$/, endpoint: 'token' },
    { method: 'GET', path: /^\/auth\/keys$/, endpoint: 'jwks' },
    { method: 'POST', path: /^\/auth\/revoke$/, endpoint: 'revoke' },
  ],
  paths: () => ({ discovery: '/.well-known/openid-configuration', authorize: '/auth/authorize', token: '/auth/token', jwks: '/auth/keys', revoke: '/auth/revoke' }),
  defaultScope: 'name email',
  scopes: ['name', 'email', 'openid'],
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: () => true,
  rotateRefresh: false,
  accessTokenTtl: 3600,
  responseModes: ['query', 'fragment', 'form_post'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenAuthMethods: ['client_secret_post'],
  formPostUser: true,
  sub: (h) => `00${digits(h, 4, false)}.${hex(crypto.createHash('sha256').update(h).digest(), 32)}.${digits(crypto.createHash('sha1').update(h).digest(), 4, false)}`,
  accessToken: (_c, t) => 'a' + hex(crypto.createHash('sha256').update(t.random + Math.random()).digest(), 31) + '.0.' + 'srtq.' + crypto.randomBytes(16).toString('base64url'),
  idTokenClaims: (_c, p, t) => ({
    ...(p.email && t.scopes.includes('email') ? { email: p.email, email_verified: p.emailVerified, ...(p.privateEmail ? { is_private_email: true } : {}) } : {}),
    nonce_supported: true,
    real_user_status: 2,
  }),
  tokenResponse: (c, t) => {
    const out = stdTokenResponse(c, t);
    delete (out.body as Record<string, unknown>).scope;
    return out;
  },
  tokenError: (c, error, description, status) => {
    const out = stdTokenError(c, error, error === 'invalid_grant' ? `The code has expired or has been revoked. (devhub: ${description})` : description, status);
    return out;
  },
  unauthorized: () => ({ status: 404, body: { error: 'Apple has no userinfo endpoint: read the id_token' } }),
  userinfo: () => ({ status: 404, body: { error: 'Apple has no userinfo endpoint: read the id_token' } }),
  revokeResponse: () => ({ status: 200, body: '' , type: 'text/plain' }),
  checkAuthorize: (_c, q, scopes) => {
    const warnings: string[] = [];
    let responseMode: string | undefined;
    if ((scopes.includes('name') || scopes.includes('email')) && q.response_mode !== 'form_post') {
      warnings.push('Apple requires response_mode=form_post when the name or email scope is requested');
      responseMode = 'form_post';
    }
    return { warnings, responseMode };
  },
  verifyClientSecret: (c, clientId, secret) => {
    if (!secret) return ['client_secret (a JWT signed with your Sign in with Apple key) is missing'];
    const d = decodeJwt(secret);
    if (!d) return ['client_secret must be a JWT (ES256, signed with your .p8 key), not a plain string'];
    const problems: string[] = [];
    const now = nowSec();
    if (d.header.alg !== 'ES256') problems.push(`client_secret JWT must use alg ES256 (got ${d.header.alg})`);
    if (!d.header.kid) problems.push('client_secret JWT has no kid (your key id)');
    if (c.cfg.teamId && d.payload.iss !== c.cfg.teamId) problems.push(`client_secret iss must be your Team ID "${c.cfg.teamId}" (got "${d.payload.iss}")`);
    if (!d.payload.iss) problems.push('client_secret has no iss (Team ID)');
    if (d.payload.sub !== clientId) problems.push(`client_secret sub must be the client_id "${clientId}" (got "${d.payload.sub}")`);
    const aud = Array.isArray(d.payload.aud) ? d.payload.aud : [d.payload.aud];
    if (!aud.includes('https://appleid.apple.com')) problems.push(`client_secret aud must be "https://appleid.apple.com" (got "${d.payload.aud}")`);
    if (!(Number(d.payload.exp) > now)) problems.push('client_secret JWT has expired');
    if (Number(d.payload.exp) - Number(d.payload.iat ?? now) > 15777000) problems.push('client_secret JWT may be valid for at most 6 months');
    if (c.cfg.clientPublicKey) {
      let ok = false;
      try {
        ok = !!verifyJwt(secret, crypto.createPublicKey(String(c.cfg.clientPublicKey)));
      } catch {
        ok = false;
      }
      if (!ok) problems.push('client_secret signature does not verify with the configured clientPublicKey');
    }
    return problems;
  },
  discovery: (_c, d) => ({
    ...d,
    response_types_supported: ['code', 'code id_token'],
    response_modes_supported: ['query', 'fragment', 'form_post'],
    scopes_supported: ['openid', 'email', 'name'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    claims_supported: ['aud', 'email', 'email_verified', 'exp', 'iat', 'is_private_email', 'iss', 'nonce', 'nonce_supported', 'real_user_status', 'sub', 'transfer_sub'],
    grant_types_supported: undefined,
    code_challenge_methods_supported: undefined,
  }),
};
