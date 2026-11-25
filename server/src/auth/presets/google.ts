import { verifyJwt } from '../jwt.js';
import { digits, input, stdTokenError, stdTokenResponse } from './common.js';
import type { PresetDef } from './types.js';

const LONG: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
};
const norm = (s: string) => (s === LONG.email ? 'email' : s === LONG.profile ? 'profile' : s);

export const google: PresetDef = {
  id: 'google',
  name: 'Google',
  protocol: 'oidc',
  description: 'Sign in with Google (OpenID Connect): accounts.google.com, oauth2.googleapis.com, www.googleapis.com paths.',
  realBase: 'https://accounts.google.com',
  routes: [
    { method: 'GET', path: /^\/\.well-known\/openid-configuration$/, endpoint: 'discovery' },
    { method: 'ANY', path: /^\/o\/oauth2(?:\/v2)?\/auth$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/(?:token|oauth2\/v4\/token)$/, endpoint: 'token' },
    { method: 'GET', path: /^\/oauth2\/v3\/certs$/, endpoint: 'jwks' },
    { method: 'GET', path: /^\/oauth2\/v1\/certs$/, endpoint: 'certs_pem' },
    { method: 'ANY', path: /^\/(?:oauth2\/v3\/userinfo|v1\/userinfo|openidconnect\/v1\/userinfo)$/, endpoint: 'userinfo', variant: 'oidc' },
    { method: 'ANY', path: /^\/oauth2\/v[12]\/userinfo$/, endpoint: 'userinfo', variant: 'legacy' },
    { method: 'ANY', path: /^\/(?:oauth2\/v[13]\/)?tokeninfo$/, endpoint: 'tokeninfo', extra: true },
    { method: 'ANY', path: /^\/(?:revoke|o\/oauth2\/revoke)$/, endpoint: 'revoke' },
    // accounts.google.com/Logout (takes continue=); not in discovery, which has no end_session_endpoint
    { method: 'ANY', path: /^\/Logout$/, endpoint: 'logout' },
  ],
  paths: () => ({
    discovery: '/.well-known/openid-configuration',
    authorize: '/o/oauth2/v2/auth',
    token: '/token',
    userinfo: '/v1/userinfo',
    jwks: '/oauth2/v3/certs',
    revoke: '/revoke',
  }),
  defaultScope: 'openid email profile',
  scopes: ['openid', 'email', 'profile', LONG.email, LONG.profile, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/gmail.readonly'],
  emailScopes: ['email', LONG.email],
  pkce: 'optional',
  refresh: (_scopes, p) => p.access_type === 'offline',
  rotateRefresh: false,
  accessTokenTtl: 3599,
  responseModes: ['query', 'fragment', 'form_post'],
  grantTypes: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
  tokenAuthMethods: ['client_secret_post', 'client_secret_basic'],
  sub: (h) => '1' + digits(h, 20, false),
  opaquePrefix: 'ya29.a0',
  idTokenClaims: (_c, p, t) => {
    const scopes = t.scopes.map(norm);
    return {
      azp: t.clientId,
      ...(p.email && scopes.includes('email') ? { email: p.email, email_verified: p.emailVerified } : {}),
      ...(p.hd ? { hd: p.hd } : {}),
      ...(scopes.includes('profile') ? { name: p.name, picture: p.picture, given_name: p.givenName, family_name: p.familyName } : {}),
    };
  },
  tokenResponse: (c, t) => {
    const scope = t.scope
      .split(' ')
      .map((s) => LONG[s] ?? s)
      .join(' ');
    return stdTokenResponse(c, { ...t, scope });
  },
  tokenError: (c, error, description, status) =>
    stdTokenError(c, error, error === 'invalid_client' ? 'Unauthorized' : error === 'invalid_grant' ? `Bad Request (${description})` : description, status),
  unauthorized: () => ({ status: 401, body: { error: 'invalid_request', error_description: 'Invalid Credentials' }, headers: { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' } }),
  userinfo: (c, p, g) => {
    const scopes = (g?.scope ?? '').split(' ').map(norm);
    const email = p.email && scopes.includes('email');
    const profile = scopes.includes('profile');
    if (c.variant === 'legacy') {
      return {
        body: {
          id: p.sub,
          ...(email ? { email: p.email, verified_email: p.emailVerified } : {}),
          ...(profile ? { name: p.name, given_name: p.givenName, family_name: p.familyName, picture: p.picture } : {}),
          ...(p.hd ? { hd: p.hd } : {}),
        },
      };
    }
    return {
      body: {
        sub: p.sub,
        ...(profile ? { name: p.name, given_name: p.givenName, family_name: p.familyName, picture: p.picture } : {}),
        ...(email ? { email: p.email, email_verified: p.emailVerified } : {}),
        ...(p.hd ? { hd: p.hd } : {}),
      },
    };
  },
  revokeResponse: (_c, found) => (found ? { status: 200, body: {} } : { status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } }),
  discovery: (_c, d) => ({
    ...d,
    response_modes_supported: undefined,
    device_authorization_endpoint: undefined,
    scopes_supported: ['openid', 'email', 'profile'],
    claims_supported: ['aud', 'email', 'email_verified', 'exp', 'family_name', 'given_name', 'iat', 'iss', 'name', 'picture', 'sub', 'hd', 'azp', 'at_hash', 'nonce'],
  }),
  extra: (c, h) => {
    // /tokeninfo?id_token=… | ?access_token=…  (values are strings, like Google's)
    const q = input(c);
    const bad = { status: 400, body: { error: 'invalid_token', error_description: 'Invalid Value' } };
    if (q.id_token) {
      for (const k of c.hub.auth.repo.listKeys(c.provider.id)) {
        const v = verifyJwt(q.id_token, k.publicJwk as never);
        if (v) {
          if (Number(v.payload.exp) < Date.now() / 1000) return bad;
          return { body: { ...Object.fromEntries(Object.entries(v.payload).map(([key, val]) => [key, typeof val === 'object' ? val : String(val)])), alg: 'RS256', kid: k.kid, typ: 'JWT' } };
        }
      }
      return bad;
    }
    const token = q.access_token ?? String(c.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const found = token ? h.lookup(token) : null;
    if (!found || found.grant.kind !== 'access' || found.grant.status !== 'active' || (found.grant.expiresAt && found.grant.expiresAt < new Date().toISOString())) return bad;
    const exp = found.grant.expiresAt ? Math.floor(Date.parse(found.grant.expiresAt) / 1000) : 0;
    const p = found.profile;
    return {
      body: {
        azp: found.grant.clientId,
        aud: found.grant.clientId,
        ...(p ? { sub: p.sub } : {}),
        scope: (found.grant.scope ?? '').split(' ').map((s) => LONG[s] ?? s).join(' '),
        exp: String(exp),
        expires_in: String(Math.max(0, exp - Math.floor(Date.now() / 1000))),
        ...(p?.email ? { email: p.email, email_verified: String(p.emailVerified) } : {}),
        access_type: 'online',
      },
    };
  },
};
