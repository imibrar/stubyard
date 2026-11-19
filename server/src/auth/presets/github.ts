import { alnum, digits, hasScope } from './common.js';
import type { Ctx, Out, PresetDef } from './types.js';

const wantsJson = (c: Ctx) => /json/i.test(String(c.req.headers.accept ?? ''));
const form = (c: Ctx, body: Record<string, string>, status = 200): Out =>
  wantsJson(c) ? { status, body } : { status, body: new URLSearchParams(body).toString(), type: 'application/x-www-form-urlencoded; charset=utf-8' };

const ERRORS: Record<string, [string, string]> = {
  code_unknown: ['bad_verification_code', 'The code passed is incorrect or expired.'],
  code_expired: ['bad_verification_code', 'The code passed is incorrect or expired.'],
  code_reused: ['bad_verification_code', 'The code passed is incorrect or expired.'],
  redirect_mismatch: ['redirect_uri_mismatch', 'The redirect_uri MUST match the registered callback URL for this application.'],
  client_secret: ['incorrect_client_credentials', 'The client_id and/or client_secret passed are incorrect.'],
  client_unknown: ['incorrect_client_credentials', 'The client_id and/or client_secret passed are incorrect.'],
  pkce: ['bad_verification_code', 'The code_verifier does not match the code_challenge supplied in the authorization request for PKCE.'],
};

const SCOPES = ['repo', 'repo:status', 'repo_deployment', 'public_repo', 'repo:invite', 'security_events', 'admin:repo_hook', 'write:repo_hook', 'read:repo_hook', 'admin:org', 'write:org', 'read:org', 'admin:public_key', 'write:public_key', 'read:public_key', 'admin:org_hook', 'gist', 'notifications', 'user', 'read:user', 'user:email', 'user:follow', 'project', 'read:project', 'delete_repo', 'write:packages', 'read:packages', 'delete:packages', 'admin:gpg_key', 'write:gpg_key', 'read:gpg_key', 'codespace', 'workflow'];

function scopeHeaders(scope: string | null) {
  return { 'x-oauth-scopes': (scope ?? '').split(' ').filter(Boolean).join(', '), 'x-accepted-oauth-scopes': '', 'x-github-media-type': 'github.v3; format=json' };
}

export const github: PresetDef = {
  id: 'github',
  name: 'GitHub',
  protocol: 'oauth2',
  description: 'GitHub OAuth apps: github.com/login/oauth/* and api.github.com /user, /user/emails (also /api/v3/… like GitHub Enterprise).',
  realBase: 'https://github.com',
  routes: [
    { method: 'GET', path: /^\/login\/oauth\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/login\/oauth\/access_token$/, endpoint: 'token' },
    { method: 'GET', path: /^(?:\/api\/v3)?\/user$/, endpoint: 'userinfo' },
    { method: 'GET', path: /^(?:\/api\/v3)?\/user\/emails$/, endpoint: 'emails', extra: true },
  ],
  paths: () => ({ authorize: '/login/oauth/authorize', token: '/login/oauth/access_token', userinfo: '/user' }),
  defaultScope: 'read:user user:email',
  scopes: SCOPES,
  emailScopes: null,
  pkce: 'optional',
  refresh: () => false,
  rotateRefresh: true,
  accessTokenTtl: null,
  responseModes: ['query'],
  grantTypes: ['authorization_code', 'refresh_token'],
  tokenAuthMethods: ['client_secret_post', 'client_secret_basic'],
  loginHintParam: 'login',
  sub: (h) => digits(h, 8),
  accessToken: (_c, t) => 'gho_' + alnum(Buffer.from(t.random + Math.random()), 36),
  tokenResponse: (c, t) =>
    form(c, {
      access_token: t.access_token,
      ...(t.expires_in !== null ? { expires_in: String(t.expires_in) } : {}),
      ...(t.refresh_token ? { refresh_token: t.refresh_token, refresh_token_expires_in: '15897600' } : {}),
      scope: t.scope.split(' ').filter(Boolean).join(','),
      token_type: 'bearer',
    }),
  tokenError: (c, error, description, _status, reason) => {
    const [code, msg] = ERRORS[reason ?? ''] ?? [error, description];
    return form(c, { error: code, error_description: `${msg}${msg === description ? '' : ` (devhub: ${description})`}`, error_uri: `https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#${code.replace(/_/g, '-')}` });
  },
  unauthorized: () => ({ status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' } }),
  userinfo: (c, p, g) => ({
    headers: scopeHeaders(g?.scope ?? null),
    body: {
      login: p.login,
      id: p.numericId,
      node_id: 'U_kgDO' + Buffer.from(String(p.numericId)).toString('base64').replace(/=+$/, ''),
      avatar_url: p.picture,
      gravatar_id: '',
      url: `${c.backend}/users/${p.login}`,
      html_url: `https://github.com/${p.login}`,
      type: 'User',
      site_admin: false,
      name: p.name,
      company: null,
      blog: '',
      location: null,
      email: p.privateEmail ? null : p.email,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: 0,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: p.createdAt.replace(/\.\d+Z$/, 'Z'),
      updated_at: p.createdAt.replace(/\.\d+Z$/, 'Z'),
    },
  }),
  extra: (c, h) => {
    const r = h.bearer();
    if ('error' in r) return r.error;
    const scopes = (r.grant.scope ?? '').split(' ');
    if (!hasScope(scopes, ['user:email', 'user'])) {
      if (c.strict) return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/users/emails#list-email-addresses-for-the-authenticated-user', status: '404' }, headers: scopeHeaders(r.grant.scope) };
      c.warnings.push('Would fail in production: /user/emails needs the user:email (or user) scope');
    }
    const p = r.profile;
    const list: Record<string, unknown>[] = [];
    if (p.email) list.push({ email: p.email, primary: true, verified: p.emailVerified, visibility: p.privateEmail ? 'private' : 'public' });
    list.push({ email: `${p.numericId}+${p.login}@users.noreply.github.com`, primary: !p.email, verified: true, visibility: null });
    return { body: list, headers: { ...scopeHeaders(r.grant.scope), 'x-accepted-oauth-scopes': 'user, user:email' } };
  },
};
