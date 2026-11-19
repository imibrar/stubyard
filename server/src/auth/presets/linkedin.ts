import { alnum, bearerUnauthorized, stdTokenError, stdTokenResponse } from './common.js';
import type { PresetDef } from './types.js';

export const linkedin: PresetDef = {
  id: 'linkedin',
  name: 'LinkedIn',
  protocol: 'oidc',
  description: 'Sign In with LinkedIn using OpenID Connect: www.linkedin.com/oauth/v2/*, api.linkedin.com/v2/userinfo.',
  realBase: 'https://www.linkedin.com',
  routes: [
    { method: 'GET', path: /^\/oauth\/\.well-known\/openid-configuration$/, endpoint: 'discovery' },
    { method: 'GET', path: /^\/oauth\/v2\/authorization$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/oauth\/v2\/accessToken$/, endpoint: 'token' },
    { method: 'POST', path: /^\/oauth\/v2\/revoke$/, endpoint: 'revoke' },
    { method: 'POST', path: /^\/oauth\/v2\/introspectToken$/, endpoint: 'introspect' },
    { method: 'GET', path: /^\/v2\/userinfo$/, endpoint: 'userinfo' },
    { method: 'GET', path: /^\/oauth\/openid\/jwks$/, endpoint: 'jwks' },
  ],
  paths: () => ({ discovery: '/oauth/.well-known/openid-configuration', authorize: '/oauth/v2/authorization', token: '/oauth/v2/accessToken', userinfo: '/v2/userinfo', jwks: '/oauth/openid/jwks', revoke: '/oauth/v2/revoke', introspect: '/oauth/v2/introspectToken' }),
  issuerSuffix: () => '/oauth',
  defaultScope: 'openid profile email',
  scopes: ['openid', 'profile', 'email', 'w_member_social', 'r_liteprofile', 'r_emailaddress', 'r_basicprofile'],
  emailScopes: ['email', 'r_emailaddress'],
  pkce: 'optional',
  refresh: () => false,
  rotateRefresh: false,
  accessTokenTtl: 5183999,
  responseModes: ['query'],
  grantTypes: ['authorization_code'],
  tokenAuthMethods: ['client_secret_post'],
  sub: (h) => alnum(h, 10),
  accessToken: (_c, t) => 'AQ' + alnum(Buffer.from(t.random + Math.random()), 150, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
  idTokenClaims: (_c, p, t) => ({
    ...(t.scopes.includes('profile') ? { name: p.name, given_name: p.givenName, family_name: p.familyName, picture: p.picture, locale: 'en_US' } : {}),
    ...(p.email && t.scopes.includes('email') ? { email: p.email, email_verified: p.emailVerified } : {}),
  }),
  tokenResponse: (c, t) => {
    const out = stdTokenResponse(c, { ...t, scope: t.scope.split(' ').join(',') });
    delete (out.body as Record<string, unknown>).refresh_token;
    return out;
  },
  tokenError: stdTokenError,
  unauthorized: (c, d) => ({ ...bearerUnauthorized(c, d), body: { serviceErrorCode: 65600, message: 'Invalid access token', status: 401 } }),
  userinfo: (_c, p, g) => {
    const scopes = (g?.scope ?? '').split(' ');
    return {
      body: {
        sub: p.sub,
        ...(p.email && scopes.includes('email') ? { email_verified: p.emailVerified } : {}),
        ...(scopes.includes('profile') ? { name: p.name, locale: { country: 'US', language: 'en' }, given_name: p.givenName, family_name: p.familyName, picture: p.picture } : {}),
        ...(p.email && scopes.includes('email') ? { email: p.email } : {}),
      },
    };
  },
  discovery: (_c, d) => ({
    ...d,
    response_modes_supported: undefined,
    grant_types_supported: undefined,
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['iss', 'aud', 'iat', 'exp', 'sub', 'name', 'given_name', 'family_name', 'picture', 'email', 'email_verified', 'locale'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  }),
};
