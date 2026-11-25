import crypto from 'node:crypto';
import { b64uJson } from '../jwt.js';
import { alnum, guid, randomToken, stdTokenResponse } from './common.js';
import type { Ctx, PresetDef } from './types.js';
import type { AuthProvider } from '../../repos/auth.js';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OIDC_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const GRAPH = '00000003-0000-0000-c000-000000000000';

export function tenantId(p: AuthProvider): string {
  return p.config.tenantId || guid(crypto.createHash('sha256').update('tenant:' + p.id).digest());
}
const optional = (c: Ctx, claim: string) => Array.isArray(c.cfg.optionalClaims) && c.cfg.optionalClaims.includes(claim);
const tenantOf = (c: Ctx) => c.params.tenant ?? tenantId(c.provider);
const oid = (sub: string) => guid(crypto.createHash('sha256').update('oid:' + sub).digest());

const AADSTS: Record<string, [number, string]> = {
  code_reused: [54005, 'OAuth2 Authorization code was already redeemed, please retry with a new valid code or use an existing refresh token.'],
  code_expired: [70008, 'The provided authorization code or refresh token has expired due to inactivity. Send a new interactive authorization request for this user and resource.'],
  code_unknown: [9002313, 'Invalid request. Request is malformed or invalid.'],
  redirect_mismatch: [50011, "The redirect URI specified in the request does not match the redirect URIs configured for the application."],
  pkce: [501481, 'The Code_Verifier does not match the code_challenge supplied in the authorization request.'],
  client_secret: [7000215, 'Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID.'],
  client_unknown: [700016, "Application was not found in the directory. This can happen if the application has not been installed by the administrator of the tenant."],
  refresh_reused: [70000, 'Provided grant is invalid or malformed.'],
  grant_type: [70003, 'The app requested an unsupported grant type.'],
  scope: [70011, 'The provided value for the input parameter \'scope\' is not valid.'],
};

export const microsoft: PresetDef = {
  id: 'microsoft',
  name: 'Microsoft',
  protocol: 'oidc',
  description: 'Microsoft identity platform v2.0 (Entra ID / personal accounts) with Graph /me. Tenants: common, organizations, consumers or a GUID.',
  realBase: 'https://login.microsoftonline.com',
  routes: [
    { method: 'GET', path: /^\/(?<tenant>[^/]+)\/v2\.0\/\.well-known\/openid-configuration$/, endpoint: 'discovery' },
    { method: 'ANY', path: /^\/(?<tenant>[^/]+)\/oauth2\/v2\.0\/authorize$/, endpoint: 'authorize' },
    { method: 'POST', path: /^\/(?<tenant>[^/]+)\/oauth2\/v2\.0\/token$/, endpoint: 'token' },
    { method: 'ANY', path: /^\/(?<tenant>[^/]+)\/oauth2\/v2\.0\/logout$/, endpoint: 'logout' },
    { method: 'GET', path: /^\/(?<tenant>[^/]+)\/discovery\/v2\.0\/keys$/, endpoint: 'jwks' },
    { method: 'GET', path: /^\/common\/discovery\/instance$/, endpoint: 'instance_discovery', extra: true },
    { method: 'ANY', path: /^\/graph\/v1\.0\/me$/, endpoint: 'userinfo', variant: 'graph' },
    { method: 'ANY', path: /^\/graph\/oidc\/userinfo$/, endpoint: 'userinfo', variant: 'oidc' },
    // Real Graph paths, for clients that point both login and graph hosts at one base URL.
    { method: 'ANY', path: /^\/v1\.0\/me$/, endpoint: 'userinfo', variant: 'graph' },
    { method: 'ANY', path: /^\/oidc\/userinfo$/, endpoint: 'userinfo', variant: 'oidc' },
  ],
  paths: (c) => {
    const t = c ? tenantOf(c) : 'common';
    return {
      discovery: `/${t}/v2.0/.well-known/openid-configuration`,
      authorize: `/${t}/oauth2/v2.0/authorize`,
      token: `/${t}/oauth2/v2.0/token`,
      userinfo: '/graph/oidc/userinfo',
      jwks: `/${t}/discovery/v2.0/keys`,
      logout: `/${t}/oauth2/v2.0/logout`,
    };
  },
  issuerSuffix: (c) => `/${tenantId(c.provider)}/v2.0`,
  defaultScope: 'openid profile email offline_access User.Read',
  scopes: null,
  emailScopes: ['email'],
  pkce: 'optional',
  refresh: (scopes) => scopes.includes('offline_access'),
  rotateRefresh: true,
  accessTokenTtl: 3600,
  responseModes: ['query', 'fragment', 'form_post'],
  grantTypes: ['authorization_code', 'refresh_token', 'client_credentials', 'implicit'],
  tokenAuthMethods: ['client_secret_post', 'client_secret_basic', 'private_key_jwt'],
  sub: (h) => alnum(h, 43, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
  accessToken: (c, t, sign) => {
    const iat = t.nowSec;
    const tid = tenantId(c.provider);
    const scp = t.scopes.filter((s) => !OIDC_SCOPES.includes(s)).map((s) => s.replace(/^.*\//, ''));
    const p = t.profile;
    return sign({
      aud: t.audience ?? c.cfg.audience ?? GRAPH,
      iss: t.issuer,
      iat,
      nbf: iat,
      exp: iat + (t.expiresIn ?? 3600),
      ...(p ? { name: p.name, oid: oid(p.sub), preferred_username: p.email ?? `${p.login}@contoso.onmicrosoft.com`, sub: p.sub, scp: scp.join(' ') || 'User.Read' } : { oid: guid(crypto.createHash('sha256').update(t.clientId).digest()), sub: t.clientId, roles: [] }),
      azp: t.clientId,
      appid: t.clientId,
      tid,
      uti: randomToken(16),
      ver: '2.0',
    });
  },
  idTokenClaims: (c, p, t) => ({
    ver: '2.0',
    tid: tenantId(c.provider),
    oid: oid(p.sub),
    preferred_username: p.email ?? `${p.login}@contoso.onmicrosoft.com`,
    name: p.name,
    ...((c.cfg.includeEmail || optional(c, 'email')) && p.email ? { email: p.email } : {}),
    ...(optional(c, 'xms_edov') && p.email ? { xms_edov: p.emailVerified } : {}),
    nbf: t.nowSec,
    aio: randomToken(24),
    rh: '0.' + randomToken(24),
    uti: randomToken(16),
  }),
  tokenResponse: (c, t) => {
    const out = stdTokenResponse(c, t, {
      ext_expires_in: t.expires_in ?? 3600,
      ...(t.profile ? { client_info: b64uJson({ uid: oid(t.profile.sub), utid: tenantId(c.provider) }) } : {}),
    });
    return out;
  },
  tokenError: (_c, error, description, status, reason) => {
    const [code, msg] = AADSTS[reason ?? ''] ?? [error === 'invalid_client' ? 7000215 : 900144, description];
    const trace = crypto.randomUUID();
    const corr = crypto.randomUUID();
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    return {
      status,
      body: {
        error,
        error_description: `AADSTS${code}: ${msg} (stubyard: ${description}) Trace ID: ${trace} Correlation ID: ${corr} Timestamp: ${ts}`,
        error_codes: [code],
        timestamp: ts,
        trace_id: trace,
        correlation_id: corr,
        error_uri: `https://login.microsoftonline.com/error?code=${code}`,
      },
      headers: { 'cache-control': 'no-store' },
    };
  },
  unauthorized: (_c, description) => ({
    status: 401,
    body: { error: { code: 'InvalidAuthenticationToken', message: description, innerError: { date: new Date().toISOString(), 'request-id': crypto.randomUUID(), 'client-request-id': crypto.randomUUID() } } },
    headers: { 'www-authenticate': 'Bearer realm="", authorization_uri="https://login.microsoftonline.com/common/oauth2/authorize", client_id="00000003-0000-0000-c000-000000000000"' },
  }),
  userinfo: (c, p) => {
    if (c.variant === 'graph') {
      return {
        body: {
          '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
          businessPhones: [],
          displayName: p.name,
          givenName: p.givenName,
          jobTitle: null,
          mail: p.email,
          mobilePhone: p.user.phone,
          officeLocation: null,
          preferredLanguage: null,
          surname: p.familyName,
          userPrincipalName: p.email ?? `${p.login}@contoso.onmicrosoft.com`,
          id: oid(p.sub),
        },
      };
    }
    return { body: { sub: p.sub, name: p.name, family_name: p.familyName, given_name: p.givenName, picture: p.picture, ...(p.email ? { email: p.email } : {}) } };
  },
  discovery: (c, d) => {
    const t = tenantOf(c);
    const multi = ['common', 'organizations', 'consumers'].includes(t.toLowerCase());
    const tid = tenantId(c.provider);
    if (!multi && GUID_RE.test(t) && t.toLowerCase() !== tid.toLowerCase()) c.warnings.push(`Tenant ${t} in the URL is not this provider's tenant (${tid}); tokens carry tid ${tid}`);
    const base = c.cfg.issOverride ? null : c.backend;
    return {
      ...d,
      issuer: c.cfg.issOverride ?? `${base}/${multi ? '{tenantid}' : tid}/v2.0`,
      response_modes_supported: ['query', 'fragment', 'form_post'],
      subject_types_supported: ['pairwise'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      claims_supported: ['sub', 'iss', 'cloud_instance_name', 'cloud_instance_host_name', 'cloud_graph_host_name', 'msgraph_host', 'aud', 'exp', 'iat', 'auth_time', 'acr', 'nonce', 'preferred_username', 'name', 'tid', 'ver', 'at_hash', 'c_hash', 'email'],
      tenant_region_scope: null,
      cloud_instance_name: 'microsoftonline.com',
      cloud_graph_host_name: 'graph.windows.net',
      msgraph_host: 'graph.microsoft.com',
      rbac_url: 'https://pas.windows.net',
      http_logout_supported: true,
      frontchannel_logout_supported: true,
      request_uri_parameter_supported: false,
      kerberos_endpoint: `${c.browser}/${t}/kerberos`,
      device_authorization_endpoint: `${c.backend}/${t}/oauth2/v2.0/devicecode`,
    };
  },
  extra: (c) => {
    const q = c.req.query as Record<string, string>;
    const host = new URL(c.backend).host;
    const tenant = (() => {
      try {
        return new URL(q.authorization_endpoint ?? '').pathname.split('/').filter(Boolean).slice(-4)[0] ?? 'common';
      } catch {
        return 'common';
      }
    })();
    return {
      body: {
        tenant_discovery_endpoint: `${c.backend}/${tenant}/v2.0/.well-known/openid-configuration`,
        'api-version': '1.1',
        metadata: [{ preferred_network: host, preferred_cache: host, aliases: [host] }],
      },
    };
  },
};
