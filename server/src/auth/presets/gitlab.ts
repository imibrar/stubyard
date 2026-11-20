import crypto from 'node:crypto';
import { digits, hex, oidcScopes, randomToken, stdTokenError, stdTokenResponse } from './common.js';
import type { PresetDef, Profile } from './types.js';

const claims = (p: Profile, scopes: string[], withEmail: boolean) => ({
  sub: p.sub,
  sub_legacy: hex(crypto.createHash('sha256').update('legacy' + p.sub).digest(), 64),
  ...(scopes.includes('profile') || scopes.includes('openid')
    ? { name: p.name, nickname: p.login, preferred_username: p.login, website: '', profile: `https://gitlab.com/${p.login}`, picture: p.picture }
    : {}),
  ...(withEmail && p.email ? { email: p.email, email_verified: p.emailVerified } : {}),
});

export const gitlab: PresetDef = {
  id: 'gitlab',
  name: 'GitLab',
  protocol: 'oidc',
  description: 'GitLab (gitlab.com or self-managed) OAuth 2 / OpenID Connect: /oauth/*, /api/v4/user.',
  realBase: 'https://gitlab.com',
  routes: [
    { method: 'GET', path: /^\/\.well-known\/openid-configuration$/, endpoint: 'discovery' },
    { method: 'GET', path: /^\/oauth\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/oauth\/token$/, endpoint: 'token' },
    { method: 'ANY', path: /^\/oauth\/userinfo$/, endpoint: 'userinfo', variant: 'oidc' },
    { method: 'POST', path: /^\/oauth\/revoke$/, endpoint: 'revoke' },
    { method: 'GET', path: /^\/oauth\/discovery\/keys$/, endpoint: 'jwks' },
    { method: 'GET', path: /^\/api\/v4\/user$/, endpoint: 'userinfo', variant: 'api' },
  ],
  paths: () => ({ discovery: '/.well-known/openid-configuration', authorize: '/oauth/authorize', token: '/oauth/token', userinfo: '/oauth/userinfo', jwks: '/oauth/discovery/keys', revoke: '/oauth/revoke' }),
  defaultScope: 'openid profile email read_user',
  scopes: [...oidcScopes, 'api', 'read_api', 'read_user', 'read_repository', 'write_repository', 'read_registry', 'write_registry', 'sudo', 'admin_mode', 'create_runner', 'manage_runner', 'ai_features', 'k8s_proxy', 'read_service_ping'],
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: () => true,
  rotateRefresh: true,
  accessTokenTtl: 7200,
  responseModes: ['query'],
  grantTypes: ['authorization_code', 'refresh_token', 'password', 'client_credentials'],
  tokenAuthMethods: ['client_secret_basic', 'client_secret_post'],
  sub: (h) => digits(h, 8),
  accessToken: () => hex(Buffer.from(randomToken(48)), 64),
  idTokenClaims: (_c, p, t) => {
    const c = claims(p, t.scopes, t.scopes.includes('email'));
    delete (c as Record<string, unknown>).sub;
    return { ...c, groups_direct: [] };
  },
  tokenResponse: (c, t) => stdTokenResponse(c, t, { created_at: Math.floor(Date.now() / 1000) }),
  tokenError: (c, error, description, status) =>
    stdTokenError(c, error, error === 'invalid_grant' ? `The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client. (stubyard: ${description})` : description, status),
  unauthorized: (c, d) => (c.variant === 'api' ? { status: 401, body: { message: '401 Unauthorized' } } : { status: 401, body: { error: 'invalid_token', error_description: d }, headers: { 'www-authenticate': 'Bearer realm="Doorkeeper", error="invalid_token"' } }),
  userinfo: (c, p, g) => {
    const scopes = (g?.scope ?? '').split(' ');
    if (c.variant === 'api') {
      if (!scopes.some((s) => ['read_user', 'api', 'read_api'].includes(s))) c.warnings.push('Would fail in production: /api/v4/user needs read_user, read_api or api');
      return {
        body: {
          id: p.numericId,
          username: p.login,
          name: p.name,
          state: 'active',
          locked: false,
          avatar_url: p.picture,
          web_url: `https://gitlab.com/${p.login}`,
          created_at: p.createdAt,
          bio: '',
          location: '',
          public_email: p.privateEmail ? '' : (p.email ?? ''),
          email: p.email,
          commit_email: p.email,
          confirmed_at: p.emailVerified ? p.createdAt : null,
          last_sign_in_at: new Date().toISOString(),
          current_sign_in_at: new Date().toISOString(),
          two_factor_enabled: false,
          external: false,
          private_profile: false,
          is_admin: p.user.role === 'admin',
        },
      };
    }
    return { body: { ...claims(p, scopes, scopes.includes('email')), groups: [] } };
  },
};
