import { nowSec } from '../jwt.js';
import { alnum, guid, hex, randomToken, standardClaims, stdTokenError, stdTokenResponse, bearerUnauthorized } from './common.js';
import type { Ctx, PresetDef } from './types.js';

const flavor = (c: Ctx | null) => c?.cfg.flavor ?? 'generic';

export const oidc: PresetDef = {
  id: 'oidc',
  name: 'Generic OIDC',
  protocol: 'oidc',
  description: 'Standards-based OpenID Connect provider. flavor = generic | auth0 | okta | keycloak | cognito changes the paths in discovery, the sub format and default claims (all aliases are always served).',
  realBase: 'https://idp.example.com',
  routes: [
    { method: 'GET', path: /^\/\.well-known\/(?:openid-configuration|oauth-authorization-server)$/, endpoint: 'discovery' },
    { method: 'ANY', path: /^\/(?:authorize|oauth2\/authorize|v1\/authorize|protocol\/openid-connect\/auth)$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/(?:token|oauth\/token|oauth2\/token|v1\/token|protocol\/openid-connect\/token)$/, endpoint: 'token' },
    { method: 'ANY', path: /^\/(?:userinfo|oauth2\/userInfo|v1\/userinfo|protocol\/openid-connect\/userinfo)$/, endpoint: 'userinfo' },
    { method: 'GET', path: /^\/(?:jwks|\.well-known\/jwks\.json|v1\/keys|protocol\/openid-connect\/certs)$/, endpoint: 'jwks' },
    { method: 'ANY', path: /^\/(?:logout|v2\/logout|v1\/logout|protocol\/openid-connect\/logout|oidc\/logout)$/, endpoint: 'logout' },
    { method: 'POST', path: /^\/(?:revoke|oauth\/revoke|oauth2\/revoke|v1\/revoke|protocol\/openid-connect\/revoke)$/, endpoint: 'revoke' },
    { method: 'POST', path: /^\/(?:introspect|v1\/introspect|protocol\/openid-connect\/token\/introspect)$/, endpoint: 'introspect' },
  ],
  paths: (c) => {
    switch (flavor(c)) {
      case 'auth0':
        return { discovery: '/.well-known/openid-configuration', authorize: '/authorize', token: '/oauth/token', userinfo: '/userinfo', jwks: '/.well-known/jwks.json', revoke: '/oauth/revoke', logout: '/oidc/logout' };
      case 'cognito':
        return { discovery: '/.well-known/openid-configuration', authorize: '/oauth2/authorize', token: '/oauth2/token', userinfo: '/oauth2/userInfo', jwks: '/.well-known/jwks.json', revoke: '/oauth2/revoke', logout: '/logout' };
      case 'keycloak':
        return {
          discovery: '/.well-known/openid-configuration',
          authorize: '/protocol/openid-connect/auth',
          token: '/protocol/openid-connect/token',
          userinfo: '/protocol/openid-connect/userinfo',
          jwks: '/protocol/openid-connect/certs',
          revoke: '/protocol/openid-connect/revoke',
          introspect: '/protocol/openid-connect/token/introspect',
          logout: '/protocol/openid-connect/logout',
        };
      case 'okta':
        return { discovery: '/.well-known/openid-configuration', authorize: '/v1/authorize', token: '/v1/token', userinfo: '/v1/userinfo', jwks: '/v1/keys', revoke: '/v1/revoke', introspect: '/v1/introspect', logout: '/v1/logout' };
      default:
        return { discovery: '/.well-known/openid-configuration', authorize: '/authorize', token: '/token', userinfo: '/userinfo', jwks: '/jwks', revoke: '/revoke', introspect: '/introspect', logout: '/logout' };
    }
  },
  issuerSuffix: (c) => (flavor(c) === 'auth0' ? '/' : ''),
  defaultScope: 'openid profile email offline_access',
  scopes: null,
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: (scopes) => scopes.includes('offline_access'),
  rotateRefresh: true,
  accessTokenTtl: 3600,
  responseModes: ['query', 'fragment', 'form_post'],
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials', 'implicit'],
  tokenAuthMethods: ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none'],
  sub: (h, p) => {
    switch (p.config.flavor) {
      case 'auth0':
        return `auth0|${hex(h, 24)}`;
      case 'okta':
        return '00u' + alnum(h, 17);
      default:
        return guid(h);
    }
  },
  accessToken: (c, t, sign) => {
    if ((c.cfg.accessTokenFormat ?? 'jwt') === 'opaque') return randomToken(32);
    const iat = nowSec();
    const fl = flavor(c);
    const p = t.profile;
    const aud = t.audience ?? c.cfg.audience ?? (fl === 'keycloak' ? 'account' : fl === 'okta' ? 'api://default' : t.clientId);
    return sign({
      iss: t.issuer,
      sub: p?.sub ?? t.clientId,
      aud: fl === 'auth0' && p ? [aud, `${t.issuer}userinfo`] : aud,
      iat,
      ...(t.expiresIn !== null ? { exp: iat + t.expiresIn } : {}),
      jti: t.random,
      client_id: t.clientId,
      azp: t.clientId,
      ...(fl === 'okta' ? { scp: t.scopes, ver: 1, cid: t.clientId, ...(p ? { uid: p.sub } : {}) } : { scope: t.scopes.join(' ') }),
      ...(fl === 'cognito' ? { token_use: 'access', username: p?.login ?? t.clientId, auth_time: iat } : {}),
      ...(fl === 'keycloak' ? { typ: 'Bearer', preferred_username: p?.login, email: p?.email ?? undefined, email_verified: p?.emailVerified } : {}),
    });
  },
  idTokenClaims: (c, p, t) => {
    const fl = flavor(c);
    return {
      ...standardClaims(p, t.scopes),
      ...(t.scopes.includes('profile') ? { preferred_username: p.login, nickname: p.login, updated_at: Math.floor(Date.parse(p.createdAt) / 1000) } : {}),
      ...(fl === 'cognito' ? { 'cognito:username': p.login, token_use: 'id', origin_jti: t.random, event_id: t.random } : {}),
      ...(fl === 'keycloak' ? { typ: 'ID', azp: t.clientId, session_state: t.random, sid: t.random, acr: '1' } : {}),
      ...(fl === 'okta' ? { ver: 1, idp: '00o' + t.random.slice(0, 17), amr: ['pwd'], preferred_username: p.email ?? p.login } : {}),
      ...(fl === 'auth0' ? { sid: t.random } : {}),
    };
  },
  tokenResponse: (c, t) => stdTokenResponse(c, { ...t, token_type: flavor(c) === 'keycloak' ? 'Bearer' : t.token_type }, flavor(c) === 'keycloak' ? { 'not-before-policy': 0, session_state: t.clientId, refresh_expires_in: t.refresh_token ? 1800 : 0 } : {}),
  tokenError: stdTokenError,
  unauthorized: bearerUnauthorized,
  userinfo: (c, p, g) => {
    const scopes = (g?.scope ?? 'openid profile email').split(' ');
    return { body: { ...standardClaims(p, scopes), ...(scopes.includes('profile') ? { preferred_username: p.login } : {}), ...(c.cfg.extraClaims ? {} : {}) } };
  },
  discovery: (c, d) => ({
    ...d,
    ...(flavor(c) === 'cognito' ? { introspection_endpoint: undefined } : {}),
    scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'phone', 'address'],
    request_uri_parameter_supported: false,
  }),
};
