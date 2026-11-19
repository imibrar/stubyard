import crypto from 'node:crypto';
import { alnum, digits, hasScope, hex, stdTokenError, stdTokenResponse } from './common.js';
import type { PresetDef } from './types.js';

export const discord: PresetDef = {
  id: 'discord',
  name: 'Discord',
  protocol: 'oauth2',
  description: 'Discord OAuth2: discord.com/oauth2/authorize, /api/oauth2/token, /api/v10/users/@me.',
  realBase: 'https://discord.com',
  routes: [
    { method: 'GET', path: /^(?:\/api(?:\/v\d+)?)?\/oauth2\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/api(?:\/v\d+)?\/oauth2\/token$/, endpoint: 'token' },
    { method: 'POST', path: /^\/api(?:\/v\d+)?\/oauth2\/token\/revoke$/, endpoint: 'revoke' },
    { method: 'GET', path: /^\/api(?:\/v\d+)?\/users\/@me$/, endpoint: 'userinfo' },
  ],
  paths: () => ({ authorize: '/oauth2/authorize', token: '/api/oauth2/token', userinfo: '/api/users/@me', revoke: '/api/oauth2/token/revoke' }),
  defaultScope: 'identify email',
  scopes: ['identify', 'email', 'guilds', 'guilds.join', 'guilds.members.read', 'connections', 'openid', 'bot', 'applications.commands', 'role_connections.write', 'messages.read', 'gdm.join', 'rpc'],
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: () => true,
  rotateRefresh: true,
  accessTokenTtl: 604800,
  responseModes: ['query'],
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
  tokenAuthMethods: ['client_secret_basic', 'client_secret_post'],
  sub: (h) => '1' + digits(h, 17, false),
  accessToken: (_c, t) => alnum(Buffer.from(t.random + Math.random()), 30),
  tokenResponse: (c, t) => stdTokenResponse(c, t),
  tokenError: (c, error, description, status, reason) => stdTokenError(c, error, reason?.startsWith('code') ? `Invalid "code" in request. (devhub: ${description})` : description, status),
  unauthorized: () => ({ status: 401, body: { message: '401: Unauthorized', code: 0 } }),
  userinfo: (c, p, g) => {
    const scopes = (g?.scope ?? '').split(' ');
    if (!scopes.includes('identify')) c.warnings.push('Would fail in production: /users/@me needs the identify scope');
    return {
      body: {
        id: p.sub,
        username: p.login.toLowerCase(),
        avatar: hex(crypto.createHash('md5').update(p.sub).digest(), 32),
        discriminator: '0',
        public_flags: 0,
        flags: 0,
        banner: null,
        accent_color: null,
        global_name: p.name,
        avatar_decoration_data: null,
        banner_color: null,
        clan: null,
        mfa_enabled: false,
        locale: 'en-US',
        premium_type: 0,
        ...(hasScope(scopes, ['email']) ? { email: p.email, verified: p.emailVerified } : {}),
      },
    };
  },
};
