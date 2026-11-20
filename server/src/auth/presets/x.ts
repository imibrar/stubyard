import { digits, input, randomToken, stdTokenResponse } from './common.js';
import type { PresetDef } from './types.js';

const SCOPES = ['tweet.read', 'tweet.write', 'tweet.moderate.write', 'users.read', 'users.email', 'follows.read', 'follows.write', 'offline.access', 'space.read', 'mute.read', 'mute.write', 'like.read', 'like.write', 'list.read', 'list.write', 'block.read', 'block.write', 'bookmark.read', 'bookmark.write', 'dm.read', 'dm.write', 'media.write'];

export const x: PresetDef = {
  id: 'x',
  name: 'X (Twitter)',
  protocol: 'oauth2',
  description: 'X / Twitter OAuth 2.0 with PKCE: twitter.com/i/oauth2/authorize, api.x.com/2/oauth2/token (HTTP Basic), /2/users/me.',
  realBase: 'https://x.com',
  routes: [
    { method: 'GET', path: /^\/i\/oauth2\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/2\/oauth2\/token$/, endpoint: 'token' },
    { method: 'POST', path: /^\/2\/oauth2\/revoke$/, endpoint: 'revoke' },
    { method: 'GET', path: /^\/2\/users\/me$/, endpoint: 'userinfo' },
  ],
  paths: () => ({ authorize: '/i/oauth2/authorize', token: '/2/oauth2/token', userinfo: '/2/users/me', revoke: '/2/oauth2/revoke' }),
  defaultScope: 'tweet.read users.read offline.access',
  scopes: SCOPES,
  emailScopes: ['users.email'],
  pkce: 'required',
  refresh: (scopes) => scopes.includes('offline.access'),
  rotateRefresh: true,
  accessTokenTtl: 7200,
  responseModes: ['query'],
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
  tokenAuthMethods: ['client_secret_basic'],
  sub: (h) => '1' + digits(h, 18, false),
  accessToken: () => randomToken(68).slice(0, 91),
  tokenResponse: (c, t) => {
    const out = stdTokenResponse(c, t);
    const b = out.body as Record<string, unknown>;
    out.body = { token_type: 'bearer', expires_in: b.expires_in, access_token: b.access_token, scope: b.scope, ...(b.refresh_token ? { refresh_token: b.refresh_token } : {}) };
    return out;
  },
  tokenError: (_c, error, description, status, reason) => {
    if (reason?.startsWith('code') || reason === 'pkce' || reason === 'redirect_mismatch') return { status: 400, body: { error: 'invalid_request', error_description: `Value passed for the authorization code was invalid. (stubyard: ${description})` } };
    if (error === 'invalid_client') return { status: 401, body: { error: 'unauthorized_client', error_description: 'Missing valid authorization header' } };
    return { status, body: { error, error_description: description } };
  },
  unauthorized: () => ({ status: 401, body: { title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' } }),
  userinfo: (c, p, g) => {
    const want = (input(c)['user.fields'] ?? '').split(',').map((s) => s.trim());
    const scopes = (g?.scope ?? '').split(' ');
    const data: Record<string, unknown> = { id: p.sub, name: p.name, username: p.login };
    if (want.includes('profile_image_url')) data.profile_image_url = p.picture;
    if (want.includes('created_at')) data.created_at = p.createdAt;
    if (want.includes('description')) data.description = '';
    if (want.includes('verified')) data.verified = false;
    if (want.includes('protected')) data.protected = false;
    if (want.includes('confirmed_email')) {
      if (scopes.includes('users.email') && p.email) data.confirmed_email = p.email;
      else c.warnings.push('confirmed_email needs the users.email scope');
    }
    return { body: { data } };
  },
  revokeResponse: () => ({ status: 200, body: { revoked: true } }),
};
