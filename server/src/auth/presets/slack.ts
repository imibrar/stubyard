import crypto from 'node:crypto';
import { alnum, digits, hex } from './common.js';
import type { Ctx, Out, PresetDef, Profile } from './types.js';

const team = (c: Ctx) => 'T' + alnum(crypto.createHash('sha256').update('team:' + c.provider.id).digest(), 10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
const teamName = (c: Ctx) => c.cfg.teamName || c.project.name;
const ok = (body: Record<string, unknown>): Out => ({ body: { ok: true, ...body } });

const slackClaims = (c: Ctx, p: Profile, scopes: string[]) => ({
  'https://slack.com/user_id': p.sub,
  'https://slack.com/team_id': team(c),
  ...(p.email && scopes.includes('email') ? { email: p.email, email_verified: p.emailVerified, date_email_verified: Math.floor(Date.parse(p.createdAt) / 1000) } : {}),
  ...(scopes.includes('profile')
    ? {
        name: p.name,
        picture: p.picture,
        given_name: p.givenName,
        family_name: p.familyName,
        locale: 'en-US',
        'https://slack.com/team_name': teamName(c),
        'https://slack.com/team_domain': c.project.slug,
        'https://slack.com/user_image_24': p.picture,
        'https://slack.com/user_image_192': p.picture,
        'https://slack.com/team_image_default': true,
      }
    : {}),
});

const ERRORS: Record<string, string> = {
  code_unknown: 'invalid_code',
  code_expired: 'invalid_code',
  code_reused: 'invalid_code',
  pkce: 'invalid_code_verifier',
  redirect_mismatch: 'bad_redirect_uri',
  client_secret: 'bad_client_secret',
  client_unknown: 'invalid_client_id',
  refresh_reused: 'invalid_refresh_token',
  refresh_unknown: 'invalid_refresh_token',
  refresh_revoked: 'invalid_refresh_token',
  grant_type: 'invalid_grant_type',
};

export const slack: PresetDef = {
  id: 'slack',
  name: 'Slack',
  protocol: 'oidc',
  description: 'Sign in with Slack (OpenID Connect): slack.com/openid/connect/authorize, /api/openid.connect.token, /api/openid.connect.userInfo.',
  realBase: 'https://slack.com',
  routes: [
    { method: 'GET', path: /^\/\.well-known\/openid-configuration$/, endpoint: 'discovery' },
    { method: 'GET', path: /^\/openid\/connect\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/api\/openid\.connect\.token$/, endpoint: 'token' },
    { method: 'ANY', path: /^\/api\/openid\.connect\.userInfo$/, endpoint: 'userinfo' },
    { method: 'GET', path: /^\/openid\/connect\/keys$/, endpoint: 'jwks' },
    { method: 'ANY', path: /^\/api\/auth\.revoke$/, endpoint: 'revoke' },
  ],
  paths: () => ({ discovery: '/.well-known/openid-configuration', authorize: '/openid/connect/authorize', token: '/api/openid.connect.token', userinfo: '/api/openid.connect.userInfo', jwks: '/openid/connect/keys' }),
  defaultScope: 'openid profile email',
  scopes: ['openid', 'profile', 'email'],
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: () => false,
  rotateRefresh: true,
  accessTokenTtl: null,
  responseModes: ['query', 'form_post'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenAuthMethods: ['client_secret_post', 'client_secret_basic'],
  sub: (h) => 'U' + alnum(h, 10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  accessToken: (_c, t) => {
    const h = crypto.createHash('sha256').update(t.random + Math.random()).digest();
    return `xoxp-${digits(h, 12)}-${digits(h.subarray(4), 13)}-${digits(h.subarray(8), 13)}-${hex(h, 32)}`;
  },
  idTokenClaims: (c, p, t) => ({ ...slackClaims(c, p, t.scopes) }),
  tokenResponse: (_c, t) =>
    ok({
      access_token: t.access_token,
      token_type: 'Bearer',
      ...(t.id_token ? { id_token: t.id_token } : {}),
      ...(t.refresh_token ? { refresh_token: t.refresh_token, expires_in: t.expires_in ?? 43200 } : t.expires_in !== null ? { expires_in: t.expires_in } : {}),
    }),
  tokenError: (_c, error, description, _status, reason) => ({ status: 200, body: { ok: false, error: ERRORS[reason ?? ''] ?? (error === 'invalid_client' ? 'invalid_client_id' : error), warning: `devhub: ${description}` } }),
  unauthorized: () => ({ status: 200, body: { ok: false, error: 'invalid_auth' } }),
  userinfo: (c, p, g) => ok({ sub: p.sub, ...slackClaims(c, p, (g?.scope ?? '').split(' ')) }),
  revokeResponse: (_c, found) => ({ body: found ? { ok: true, revoked: true } : { ok: false, error: 'invalid_auth' } }),
  discovery: (_c, d) => ({
    ...d,
    response_types_supported: ['code'],
    response_modes_supported: ['form_post'],
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['sub', 'auth_time', 'iss', 'name', 'given_name', 'family_name', 'email', 'email_verified', 'locale', 'picture', 'https://slack.com/user_id', 'https://slack.com/team_id'],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  }),
};
