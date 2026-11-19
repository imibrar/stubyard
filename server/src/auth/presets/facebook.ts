import { alnum, digits, input, randomToken } from './common.js';
import type { Ctx, Out, PresetDef, Profile } from './types.js';

const V = '(?:\\/v\\d+\\.\\d+)?';
const fbtrace = () => randomToken(8).replace(/[-_]/g, 'A');
const oauthErr = (message: string, code: number, status = 400, subcode?: number): Out => ({
  status,
  body: { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: fbtrace() } },
  headers: { 'www-authenticate': `OAuth "Facebook Platform" "invalid_token" "${message.replace(/"/g, "'")}"` },
});

const MESSAGES: Record<string, [string, number, number?]> = {
  code_unknown: ['Invalid verification code format.', 100],
  code_reused: ['This authorization code has been used.', 100, 36009],
  code_expired: ['This authorization code has expired.', 100, 36007],
  redirect_mismatch: ['Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request', 100, 36008],
  client_secret: ['Error validating client secret.', 1],
  client_unknown: ['Error validating application. Invalid application ID.', 101],
};

function fields(c: Ctx, p: Profile, scopes: string[]): Record<string, unknown> {
  const raw = input(c).fields ?? 'id,name';
  const out: Record<string, unknown> = {};
  for (const f of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const name = f.replace(/[.{(].*$/, '');
    switch (name) {
      case 'id':
        out.id = p.sub;
        break;
      case 'name':
        out.name = p.name;
        break;
      case 'first_name':
        out.first_name = p.givenName;
        break;
      case 'last_name':
        out.last_name = p.familyName;
        break;
      case 'middle_name':
        break;
      case 'short_name':
        out.short_name = p.givenName;
        break;
      case 'name_format':
        out.name_format = '{first} {last}';
        break;
      case 'email':
        if (p.email && !p.privateEmail && scopes.includes('email')) out.email = p.email;
        else if (p.email && !scopes.includes('email')) c.warnings.push('Would be missing in production: "email" needs the email permission (scope)');
        break;
      case 'picture': {
        const size = /width\((\d+)\)/.exec(f)?.[1] ?? (/type\(large\)/.test(f) ? '200' : '50');
        out.picture = { data: { height: Number(size), is_silhouette: false, url: p.picture, width: Number(size) } };
        break;
      }
      case 'locale':
        out.locale = 'en_US';
        break;
      default:
        break;
    }
  }
  if (!out.id) out.id = p.sub;
  return out;
}

export const facebook: PresetDef = {
  id: 'facebook',
  name: 'Facebook',
  protocol: 'oauth2',
  description: 'Facebook Login (Graph API): www.facebook.com/vN.N/dialog/oauth, graph.facebook.com/vN.N/oauth/access_token, /me?fields=…, /debug_token.',
  realBase: 'https://www.facebook.com',
  routes: [
    { method: 'GET', path: new RegExp(`^${V}\\/dialog\\/oauth$`), endpoint: 'authorize' },
    { method: 'ANY', path: new RegExp(`^${V}\\/oauth\\/access_token$`), endpoint: 'token' },
    { method: 'GET', path: new RegExp(`^${V}\\/me$`), endpoint: 'userinfo' },
    { method: 'GET', path: new RegExp(`^${V}\\/debug_token$`), endpoint: 'debug_token', extra: true },
    { method: 'ANY', path: new RegExp(`^${V}\\/me\\/permissions$`), endpoint: 'revoke', variant: 'permissions', extra: true },
  ],
  paths: () => ({ authorize: '/v19.0/dialog/oauth', token: '/v19.0/oauth/access_token', userinfo: '/v19.0/me' }),
  defaultScope: 'public_profile,email',
  scopes: ['public_profile', 'email', 'user_friends', 'user_birthday', 'user_gender', 'user_link', 'user_location', 'user_photos', 'user_posts', 'pages_show_list', 'pages_read_engagement', 'business_management', 'openid'],
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: () => false,
  rotateRefresh: false,
  accessTokenTtl: 5183944,
  responseModes: ['query', 'fragment'],
  grantTypes: ['authorization_code', 'client_credentials'],
  tokenAuthMethods: ['client_secret_post'],
  sub: (h) => '10' + digits(h, 15, false),
  accessToken: (_c, t) => 'EAA' + alnum(Buffer.from(t.random + Math.random()), 180),
  tokenResponse: (_c, t) => ({ body: { access_token: t.access_token, token_type: 'bearer', ...(t.expires_in !== null ? { expires_in: t.expires_in } : {}) } }),
  tokenError: (_c, error, description, status, reason) => {
    const m = MESSAGES[reason ?? ''];
    if (m) return oauthErr(m[0], m[1], status === 401 ? 400 : status, m[2]);
    return oauthErr(`${description}`, error === 'invalid_client' ? 1 : 100, 400);
  },
  unauthorized: (_c, description) => oauthErr(description.includes('expired') ? 'Error validating access token: Session has expired.' : 'Invalid OAuth access token - Cannot parse access token', 190, 400, description.includes('expired') ? 463 : undefined),
  userinfo: (c, p, g) => ({ body: fields(c, p, (g?.scope ?? '').split(' ')) }),
  extra: (c, h) => {
    const q = input(c);
    if (c.endpoint === 'revoke') {
      const r = h.bearer();
      if ('error' in r) return r.error;
      c.hub.auth.repo.revokeFamily(r.grant.familyId ?? r.grant.id);
      return { body: { success: true } };
    }
    // /debug_token?input_token=…&access_token=<app token>
    const found = q.input_token ? h.lookup(q.input_token) : null;
    if (!found || found.grant.kind !== 'access') {
      return { body: { data: { error: { code: 190, message: 'Invalid OAuth access token.' }, is_valid: false, scopes: [] } } };
    }
    const g = found.grant;
    const exp = g.expiresAt ? Math.floor(Date.parse(g.expiresAt) / 1000) : 0;
    const valid = g.status === 'active' && (!exp || exp > Date.now() / 1000);
    return {
      body: {
        data: {
          app_id: g.clientId,
          type: 'USER',
          application: c.provider.name,
          data_access_expires_at: exp + 90 * 86400,
          expires_at: exp,
          is_valid: valid,
          issued_at: Math.floor(Date.parse(g.createdAt) / 1000),
          scopes: (g.scope ?? '').split(' ').filter(Boolean),
          user_id: found.profile?.sub,
        },
      },
    };
  },
};
