import { LEGACY_NAME } from '../legacy.js';
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import { AuthRepo, type AuthGrant, type AuthIdentity, type AuthProvider, type AuthProviderConfig } from '../repos/auth.js';
import type { Project } from '../repos/projects.js';
import type { TestUser } from '../repos/users.js';
import { HttpError, newId, nowIso, slugify, trimEnd } from '../util.js';
import { corruptSignature, decodeJwt, halfHash, pkceS256, signJwt } from './jwt.js';
import { certJwkFields, generateSigningKey } from './keys.js';
import { avatarSvg, renderError, renderFormPost, renderPicker, renderSignedOut, type PickerUser } from './pages.js';
import { getPreset, PRESET_LIST } from './presets/index.js';
import { alnum, input, randomToken } from './presets/common.js';
import type { Ctx, Issued, Out, PresetDef, Profile, ProviderUrls, TokenContext } from './presets/types.js';
import {
  AUTHORIZE_ACTIONS,
  CLAIM_ACTIONS,
  DEFECT_ACTIONS,
  TOKEN_ACTIONS,
  TRANSPORT_ACTIONS,
  effectsFromJson,
  effectsFromRule,
  effectsToJson,
  hasAny,
  mergeEffects,
  parseScenario,
  pickRule,
  type Effects,
} from './rules.js';
import { renderTemplateClaims } from './claims.js';
import { buildSnippets } from './snippets.js';
import { hostHttpBase, hostHttpsBase } from '../config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PENDING_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 3600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const AUTHORIZE_ERRORS: Record<string, string> = {
  access_denied: 'The user denied the request',
  login_required: 'The user is not signed in',
  interaction_required: 'User interaction is required',
  consent_required: 'The user has not consented to this application',
  mfa_required: 'Multi-factor authentication is required',
  server_error: 'The identity provider had an internal error',
  temporarily_unavailable: 'The identity provider is temporarily unavailable',
};

interface AuthRequest {
  clientId: string;
  redirectUri: string;
  responseType: string[];
  responseMode: 'query' | 'fragment' | 'form_post';
  scopes: string[];
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  prompt: string[];
  loginHint: string | null;
  accessType: string | null;
  audience: string | null;
  /** iss for implicit / hybrid id_tokens: the base the browser used. */
  backend: string;
}

export interface TokenRequestInput {
  user: string;
  clientId?: string;
  scope?: string;
  nonce?: string;
  audience?: string;
  expiresIn?: number;
  claims?: Record<string, unknown>;
  scenario?: string;
  refresh?: boolean;
  baseUrl?: string;
}

/** Fake OAuth 2.0 / OpenID Connect identity providers (Google, Microsoft, GitHub, …) under /auth/<project>/<provider>/. */
export class AuthService {
  readonly repo: AuthRepo;

  constructor(private hub: Hub) {
    this.repo = new AuthRepo(hub.db);
  }

  presets() {
    return PRESET_LIST.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      description: p.description,
      realBase: p.realBase,
      defaultScope: p.defaultScope,
      pkce: p.pkce,
      endpoints: p.routes.map((r) => ({ method: r.method, path: r.path.source, endpoint: r.endpoint })),
    }));
  }

  // ---------------------------------------------------------------- management

  create(project: Project, b: { preset?: unknown; slug?: unknown; name?: unknown; config?: unknown; enabled?: unknown }): AuthProvider {
    const preset = getPreset(String(b.preset ?? ''));
    if (!preset) throw new HttpError(400, `Unknown login preset "${b.preset}". Use one of: ${PRESET_LIST.map((p) => p.id).join(', ')}`);
    const config = { ...(preset.defaultConfig ?? {}), ...this.cleanConfig(b.config) };
    const p = this.repo.createProvider(project.id, {
      preset: preset.id,
      slug: b.slug ? String(b.slug) : preset.id,
      name: b.name ? String(b.name) : preset.name,
      config,
      enabled: b.enabled !== false,
    });
    this.signingKey(p);
    return p;
  }

  update(p: AuthProvider, b: { name?: unknown; slug?: unknown; config?: unknown; enabled?: unknown; replaceConfig?: unknown }): AuthProvider {
    const patch = this.cleanConfig(b.config);
    let config: AuthProviderConfig = b.replaceConfig === true ? patch : { ...p.config, ...patch };
    // null removes a key
    config = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== null)) as AuthProviderConfig;
    return this.repo.updateProvider(p, {
      name: b.name !== undefined ? String(b.name) : undefined,
      slug: b.slug !== undefined ? String(b.slug) : undefined,
      config: b.config !== undefined ? config : undefined,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    });
  }

  private cleanConfig(v: unknown): AuthProviderConfig {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, '"config" must be an object');
    const c = { ...(v as AuthProviderConfig) };
    if (c.issuerMode !== undefined && c.issuerMode !== null && !['request-host', 'fixed'].includes(c.issuerMode)) throw new HttpError(400, 'issuerMode must be "request-host" or "fixed"');
    if (c.issuerMode === 'fixed' && !c.issuer) throw new HttpError(400, 'issuerMode "fixed" needs "issuer" (e.g. https://host.docker.internal:4443)');
    for (const k of ['issuer', 'browserBaseUrl', 'issOverride'] as const) {
      const val = c[k];
      if (val) {
        try {
          new URL(String(val));
        } catch {
          throw new HttpError(400, `${k} must be an absolute URL`);
        }
        c[k] = trimEnd(String(val), '/');
      }
    }
    if (c.clients !== undefined && c.clients !== null) {
      if (!Array.isArray(c.clients)) throw new HttpError(400, '"clients" must be an array of { clientId, clientSecret?, redirectUris? }');
      c.clients = c.clients.map((x) => {
        if (!x || !x.clientId) throw new HttpError(400, 'Every client needs a clientId');
        return {
          clientId: String(x.clientId),
          clientSecret: x.clientSecret ? String(x.clientSecret) : null,
          redirectUris: Array.isArray(x.redirectUris) ? x.redirectUris.map(String).filter(Boolean) : [],
          ...(x.name ? { name: String(x.name) } : {}),
        };
      });
    }
    if (c.flavor && !['generic', 'auth0', 'okta', 'keycloak', 'cognito'].includes(c.flavor)) throw new HttpError(400, 'flavor must be generic, auth0, okta, keycloak or cognito');
    if (c.accessTokenFormat && !['jwt', 'opaque'].includes(c.accessTokenFormat)) throw new HttpError(400, 'accessTokenFormat must be jwt or opaque');
    if (c.refresh && !['auto', 'always', 'never'].includes(c.refresh)) throw new HttpError(400, 'refresh must be auto, always or never');
    return c;
  }

  /** Provider as shown by the API / dashboard: URLs for browser and backend, snippets, keys. */
  view(project: Project, p: AuthProvider) {
    const preset = this.presetOf(p);
    const browser = this.publicBase(p, project);
    const backendDocker = this.fixedBase(p, project) ?? `https://stubyard:${this.hub.config.httpsPort}${this.path(project, p)}`;
    const backendLocal = this.fixedBase(p, project) ?? `${hostHttpBase(this.hub.config)}${this.path(project, p)}`;
    const urls = {
      browser: this.urls(project, p, browser, browser),
      backend: this.urls(project, p, backendDocker, browser),
      backendLocal: this.urls(project, p, backendLocal, browser),
    };
    const clientId = p.config.clients?.[0]?.clientId ?? 'stubyard-client';
    return {
      ...p,
      presetName: preset.name,
      protocol: preset.protocol,
      urls,
      snippets: buildSnippets(preset, p, urls, { clientId, clientSecret: p.config.clients?.[0]?.clientSecret ?? 'stubyard-secret', hostHttpPort: this.hub.config.hostHttpPort }),
      keys: this.repo.listKeys(p.id).map((k) => ({ kid: k.kid, alg: k.alg, status: k.status, createdAt: k.createdAt, retiredAt: k.retiredAt })),
      rules: this.repo.allRules(p.id),
      signedIn: this.repo.countSignedIn(p.id),
    };
  }

  urls(project: Project, p: AuthProvider, base: string, browser: string): ProviderUrls {
    const preset = this.presetOf(p);
    const c = this.staticCtx(project, p, base, browser);
    const paths = preset.paths(c);
    const u = (b: string, x?: string) => (x ? b + x : null);
    return {
      base,
      issuer: this.issuer(c),
      discovery: u(base, paths.discovery),
      authorize: browser + paths.authorize,
      token: base + paths.token,
      userinfo: u(base, paths.userinfo),
      jwks: u(base, paths.jwks),
      revoke: u(base, paths.revoke),
      // Every preset answers /__hub/logout; presets with a real logout path list that one instead.
      logout: browser + (paths.logout ?? '/__hub/logout'),
    };
  }

  presetOf(p: AuthProvider): PresetDef {
    const preset = getPreset(p.preset);
    if (!preset) throw new HttpError(500, `Login provider "${p.slug}" uses unknown preset "${p.preset}"`);
    return preset;
  }

  // ---------------------------------------------------------------- keys / identities

  signingKey(p: AuthProvider) {
    return this.repo.activeKey(p.id) ?? this.newKey(p);
  }

  private newKey(p: AuthProvider) {
    const k = generateSigningKey(`stubyard ${p.preset} ${p.slug}`);
    return this.repo.insertKey(p.id, k);
  }

  rotateKey(p: AuthProvider, dropOld: boolean) {
    this.repo.retireKeys(p.id, dropOld);
    const k = this.newKey(p);
    return { kid: k.kid, dropped: dropOld, keys: this.repo.listKeys(p.id).map((x) => ({ kid: x.kid, status: x.status })) };
  }

  jwks(p: AuthProvider) {
    this.signingKey(p);
    const withCert = p.preset === 'microsoft';
    return { keys: this.repo.listKeys(p.id).map((k) => ({ ...k.publicJwk, ...(withCert ? certJwkFields(k.certPem) : {}) })) };
  }

  ensureIdentity(p: AuthProvider, user: TestUser): AuthIdentity {
    const existing = this.repo.getIdentity(p.id, user.id);
    if (existing) return existing;
    const preset = this.presetOf(p);
    for (let i = 0; i < 20; i++) {
      const hash = crypto.createHash('sha256').update(p.slug + user.id + (i ? `#${i}` : '')).digest();
      const sub = preset.sub(hash, p);
      if (!this.repo.identityBySub(p.id, sub)) return this.repo.insertIdentity(p.id, user.id, sub);
    }
    throw new HttpError(500, 'Could not derive a unique sub');
  }

  identityView(p: AuthProvider, user: TestUser) {
    const identity = this.ensureIdentity(p, user);
    return { ...identity, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  /** Test users with a live SSO session at a provider, newest sign-in first (one entry per user). */
  signedInUsers(project: Project, p: AuthProvider) {
    const out = new Map<string, { userId: string; name: string; email: string | null; role: string | null; sessions: number; signedInAt: string; expiresAt: string | null }>();
    for (const g of this.repo.listSessions(p.id)) {
      if (!g.testUserId) continue;
      const seen = out.get(g.testUserId);
      if (seen) {
        seen.sessions++;
        if (seen.expiresAt && (!g.expiresAt || g.expiresAt > seen.expiresAt)) seen.expiresAt = g.expiresAt;
        continue;
      }
      const user = this.hub.users.get(project.id, g.testUserId);
      out.set(g.testUserId, { userId: g.testUserId, name: user?.name ?? g.testUserId, email: user?.email ?? null, role: user?.role ?? null, sessions: 1, signedInAt: g.createdAt, expiresAt: g.expiresAt });
    }
    return [...out.values()];
  }

  // ---------------------------------------------------------------- bases / issuer

  private path(project: Project, p: AuthProvider) {
    return `/auth/${project.slug}/${p.slug}`;
  }

  private withPath(urlStr: string, project: Project, p: AuthProvider): string {
    const u = new URL(urlStr);
    return u.pathname === '/' || u.pathname === '' ? `${u.origin}${this.path(project, p)}` : trimEnd(urlStr, '/');
  }

  private fixedBase(p: AuthProvider, project: Project): string | null {
    return p.config.issuerMode === 'fixed' && p.config.issuer ? this.withPath(p.config.issuer, project, p) : null;
  }

  private publicBase(p: AuthProvider, project: Project): string {
    const fixed = this.fixedBase(p, project);
    if (fixed) return fixed;
    const cfgUrl = p.config.browserBaseUrl || this.hub.config.publicUrl || (this.hub.tls ? hostHttpsBase(this.hub.config) : hostHttpBase(this.hub.config));
    return this.withPath(cfgUrl, project, p);
  }

  private requestBase(req: FastifyRequest, project: Project, p: AuthProvider): string {
    const fixed = this.fixedBase(p, project);
    if (fixed) return fixed;
    const host = String(req.headers.host ?? `localhost:${this.hub.config.hostHttpPort}`);
    return `${req.protocol}://${host}${this.path(project, p)}`;
  }

  issuer(c: Ctx, base = c.backend): string {
    if (c.cfg.issOverride) return c.cfg.issOverride;
    return base + (c.preset.issuerSuffix?.(c) ?? '');
  }

  private staticCtx(project: Project, p: AuthProvider, backend: string, browser: string, req?: FastifyRequest): Ctx {
    return {
      hub: this.hub,
      project,
      provider: p,
      preset: this.presetOf(p),
      cfg: p.config,
      req: req ?? ({ headers: {}, query: {}, body: undefined } as unknown as FastifyRequest),
      endpoint: 'token',
      params: {},
      backend,
      browser,
      warnings: [],
      strict: p.config.strict === true,
    };
  }

  // ---------------------------------------------------------------- profile / tokens

  profile(c: Ctx, user: TestUser, identity: AuthIdentity, effects: Effects | null): Profile {
    const cl = identity.claims;
    const pick = <T>(k: string, fallback: T): T => (cl[k] !== undefined ? (cl[k] as T) : fallback);
    let email: string | null = pick<string | null>('email', user.email);
    let emailVerified = pick<boolean>('email_verified', true) !== false;
    let privateEmail = false;
    const name = pick<string>('name', user.name) || user.name;
    const parts = name.trim().split(/\s+/);
    const hash = crypto.createHash('sha256').update(identity.sub).digest();
    if (c.preset.id === 'apple' && email && (cl.hideEmail === true || effects?.actions.has('private_email'))) {
      email = `${alnum(hash, 10, 'abcdefghijklmnopqrstuvwxyz0123456789')}@privaterelay.appleid.com`;
      privateEmail = true;
    } else if (effects?.actions.has('private_email') || cl.privateEmail === true) {
      privateEmail = true;
    }
    if (effects?.actions.has('no_email')) email = null;
    if (effects?.actions.has('email_unverified')) emailVerified = false;
    const login = String(pick<string>('login', (email ?? user.email)?.split('@')[0] ?? slugify(name)) || slugify(name) || 'user')
      .replace(/[^A-Za-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';
    const hosted = c.cfg.hostedDomain && email?.toLowerCase().endsWith('@' + c.cfg.hostedDomain.toLowerCase()) ? c.cfg.hostedDomain : null;
    const numericId = /^\d{1,15}$/.test(identity.sub) ? Number(identity.sub) : 10_000_000 + (hash.readUInt32BE(0) % 89_999_999);
    return {
      sub: identity.sub,
      user,
      identity,
      email,
      emailVerified,
      privateEmail,
      name,
      givenName: pick<string>('given_name', parts[0] ?? name),
      familyName: pick<string>('family_name', parts.slice(1).join(' ')),
      picture: pick<string>('picture', `${c.browser}/__hub/avatar/${encodeURIComponent(identity.sub)}.svg`),
      locale: pick<string>('locale', 'en'),
      login,
      hd: pick<string | null>('hd', hosted),
      numericId,
      createdAt: user.createdAt,
    };
  }

  private refreshPolicy(c: Ctx, scopes: string[], authParams: Record<string, unknown>): boolean {
    const mode = c.cfg.refresh ?? 'auto';
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return c.preset.refresh(scopes, authParams);
  }

  private wantsIdToken(c: Ctx, scopes: string[]): boolean {
    if (c.preset.protocol !== 'oidc') return false;
    return c.preset.id === 'apple' || scopes.includes('openid');
  }

  issueTokens(
    c: Ctx,
    o: {
      user: TestUser | null;
      clientId: string;
      scopes: string[];
      nonce?: string | null;
      authTime?: number;
      familyId?: string | null;
      parentId?: string | null;
      effects: Effects | null;
      includeRefresh: boolean;
      includeIdToken: boolean;
      audience?: string | null;
      expiresIn?: number | null;
      extraClaims?: Record<string, unknown> | null;
      grantType: string;
      issuer: string;
    },
  ): Issued {
    const identity = o.user ? this.ensureIdentity(c.provider, o.user) : null;
    const profile = o.user && identity ? this.profile(c, o.user, identity, o.effects) : null;
    const presetTtl = c.cfg.accessTokenTtl ?? c.preset.accessTokenTtl;
    const ttl = o.effects?.actions.has('short_lived') ? (o.effects.ttl ?? 5) : (o.expiresIn ?? presetTtl);
    const key = this.signingKey(c.provider);
    const sign = (claims: Record<string, unknown>) => signJwt(claims, key);
    const now = this.now(c.project.id, c.req, o.user?.id);
    const tctx: TokenContext = { profile, clientId: o.clientId, scopes: o.scopes, issuer: o.issuer, expiresIn: ttl, audience: o.audience ?? null, random: newId(), nowSec: Math.floor(now / 1000) };
    const extra = { ...renderTemplateClaims(c, profile), ...(o.extraClaims ?? {}) };
    let access: string;
    if (c.preset.accessToken) access = c.preset.accessToken(c, tctx, (claims) => sign({ ...claims, ...(profile ? extra : {}) }));
    else access = (c.preset.opaquePrefix ?? '') + randomToken(32);
    const familyId = o.familyId ?? newId();
    this.repo.createGrant({
      projectId: c.project.id,
      providerId: c.provider.id,
      testUserId: o.user?.id ?? null,
      kind: 'access',
      token: access,
      clientId: o.clientId,
      scope: o.scopes.join(' '),
      familyId,
      parentId: o.parentId ?? null,
      params: { effects: effectsToJson(o.effects), sub: profile?.sub ?? o.clientId, grantType: o.grantType, audience: o.audience ?? null },
      expiresAt: ttl !== null ? new Date(now + ttl * 1000).toISOString() : null,
      logId: c.req.trafficLogId ?? null,
    });
    let refresh: string | undefined;
    if (o.includeRefresh && !o.effects?.actions.has('no_refresh_token')) {
      refresh = (c.preset.id === 'google' ? '1//' : '') + randomToken(40);
      this.repo.createGrant({
        projectId: c.project.id,
        providerId: c.provider.id,
        testUserId: o.user?.id ?? null,
        kind: 'refresh',
        token: refresh,
        clientId: o.clientId,
        scope: o.scopes.join(' '),
        familyId,
        parentId: o.parentId ?? null,
        params: { authTime: o.authTime ?? Math.floor(now / 1000), nonce: null, audience: o.audience ?? null },
        expiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
        logId: c.req.trafficLogId ?? null,
      });
    }
    let idToken: string | undefined;
    let claims: Record<string, unknown> | null = null;
    if (o.includeIdToken && profile) {
      const iat = Math.floor(now / 1000);
      const idTtl = c.cfg.idTokenTtl ?? 3600;
      claims = {
        iss: o.issuer,
        aud: o.clientId,
        sub: profile.sub,
        iat,
        exp: iat + idTtl,
        ...(o.nonce ? { nonce: o.nonce } : {}),
        ...(o.authTime ? { auth_time: o.authTime } : {}),
        at_hash: halfHash(access),
        ...(c.preset.idTokenClaims?.(c, profile, tctx) ?? {}),
        ...extra,
      };
      const e = o.effects;
      if (e?.actions.has('wrong_aud')) claims.aud = 'wrong-audience.stubyard.invalid';
      if (e?.actions.has('wrong_iss')) claims.iss = 'https://wrong-issuer.stubyard.invalid';
      if (e?.actions.has('wrong_nonce')) claims.nonce = 'wrong-nonce-' + randomToken(6);
      if (e?.actions.has('expired_id_token')) {
        claims.iat = iat - 7200;
        claims.exp = iat - 3600;
        if (claims.nbf !== undefined) claims.nbf = iat - 7200;
      }
      idToken = signJwt(claims, key, e?.actions.has('unknown_kid') ? { kid: 'unknown-' + randomToken(6) } : {});
      if (e?.actions.has('bad_signature')) idToken = corruptSignature(idToken);
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: o.scopes.join(' '),
      ...(refresh ? { refresh_token: refresh } : {}),
      ...(idToken ? { id_token: idToken } : {}),
      sub: profile?.sub ?? o.clientId,
      claims,
      profile,
      clientId: o.clientId,
      grantType: o.grantType,
    };
  }

  // ---------------------------------------------------------------- control API helpers

  apiToken(req: FastifyRequest, project: Project, p: AuthProvider, b: TokenRequestInput) {
    const user = this.hub.users.requireRef(project.id, String(b.user ?? ''));
    const base = b.baseUrl ? this.withPath(b.baseUrl, project, p) : this.publicBase(p, project);
    const c = this.staticCtx(project, p, base, this.publicBase(p, project), req);
    const scopes = splitScope(b.scope ?? c.preset.defaultScope);
    const effects = b.scenario ? parseScenario(b.scenario, 'header').effects : null;
    const issued = this.issueTokens(c, {
      user,
      clientId: b.clientId ?? p.config.clients?.[0]?.clientId ?? 'stubyard-client',
      scopes,
      nonce: b.nonce ?? null,
      authTime: Math.floor(this.now(project.id, req, user.id) / 1000),
      effects,
      includeRefresh: b.refresh ?? this.refreshPolicy(c, scopes, { access_type: 'offline' }),
      includeIdToken: this.wantsIdToken(c, scopes),
      audience: b.audience ?? null,
      expiresIn: b.expiresIn ?? null,
      extraClaims: b.claims ?? null,
      grantType: 'stubyard_api',
      issuer: this.issuer(c),
    });
    return {
      access_token: issued.access_token,
      ...(issued.id_token ? { id_token: issued.id_token } : {}),
      ...(issued.refresh_token ? { refresh_token: issued.refresh_token } : {}),
      token_type: issued.token_type,
      expires_in: issued.expires_in,
      scope: issued.scope,
      sub: issued.sub,
      claims: issued.claims,
      issuer: this.issuer(c),
    };
  }

  apiCode(project: Project, p: AuthProvider, b: { user: string; clientId?: string; redirectUri?: string; state?: string; nonce?: string; codeChallenge?: string; codeChallengeMethod?: string; scope?: string; scenario?: string }) {
    const user = this.hub.users.requireRef(project.id, String(b.user ?? ''));
    if (!b.redirectUri) throw new HttpError(400, 'redirectUri is required');
    const preset = this.presetOf(p);
    const identity = this.ensureIdentity(p, user);
    const code = this.createCode(project, p, user, {
      clientId: b.clientId ?? p.config.clients?.[0]?.clientId ?? 'stubyard-client',
      redirectUri: b.redirectUri,
      scopes: splitScope(b.scope ?? preset.defaultScope),
      nonce: b.nonce ?? null,
      state: b.state ?? null,
      codeChallenge: b.codeChallenge ?? null,
      codeChallengeMethod: b.codeChallenge ? (b.codeChallengeMethod ?? 'S256') : null,
      accessType: 'offline',
      audience: null,
      scenario: b.scenario ? effectsToJson(parseScenario(b.scenario, 'header').effects) : null,
      appleUser: null,
    });
    void identity;
    const params = new URLSearchParams({ code: code.token, ...(b.state ? { state: b.state } : {}) });
    return { code: code.token, redirectTo: appendParams(b.redirectUri, params, 'query'), expiresAt: code.expiresAt };
  }

  private createCode(
    project: Project,
    p: AuthProvider,
    user: TestUser,
    o: {
      clientId: string;
      redirectUri: string;
      scopes: string[];
      nonce: string | null;
      state: string | null;
      codeChallenge: string | null;
      codeChallengeMethod: string | null;
      accessType: string | null;
      audience: string | null;
      scenario: unknown;
      appleUser: unknown;
    },
  ): AuthGrant {
    const ttl = (p.config.codeTtlSeconds ?? 60) * 1000;
    return this.repo.createGrant({
      projectId: project.id,
      providerId: p.id,
      testUserId: user.id,
      kind: 'code',
      token: (p.preset === 'google' ? '4/0' : '') + randomToken(24),
      clientId: o.clientId,
      redirectUri: o.redirectUri,
      scope: o.scopes.join(' '),
      nonce: o.nonce,
      codeChallenge: o.codeChallenge,
      codeChallengeMethod: o.codeChallengeMethod,
      params: { state: o.state, authTime: Math.floor(this.now(project.id, null, user.id) / 1000), access_type: o.accessType, audience: o.audience, scenario: o.scenario ?? null },
      expiresAt: new Date(this.now(project.id, null, user.id) + ttl).toISOString(),
    });
  }

  /** Sections for the project setup guide (GET /api/projects/:slug/setup). */
  guideSections(project: Project) {
    return this.repo.listProviders(project.id).map((p) => {
      const v = this.view(project, p);
      const u = v.urls;
      const lines = [
        `Issuer (backend, Docker)  ${u.backend.issuer}`,
        `Issuer (browser / host)   ${u.browser.issuer}`,
        u.backend.discovery ? `Discovery                 ${u.backend.discovery}` : null,
        `Authorize (browser)       ${u.browser.authorize}`,
        `Token                     ${u.backend.token}`,
        u.backend.userinfo ? `Userinfo / profile        ${u.backend.userinfo}` : null,
        u.backend.jwks ? `JWKS                      ${u.backend.jwks}` : null,
      ].filter(Boolean);
      return {
        id: `auth-${p.slug}`,
        title: `Login provider — ${p.name} (fake ${v.presetName})`,
        description:
          'Point the app\'s OAuth / OIDC library at these URLs instead of the real provider. Discovery, token, userinfo and JWKS URLs follow the Host the app uses; ' +
          'the authorize URL always points at the browser base (STUBYARD_PUBLIC_URL). HTTPS uses the stubyard CA: trust it in the app (snippet below).',
        instance: p.slug,
        snippets: [{ title: 'URLs', language: 'text', code: lines.join('\n') }, ...v.snippets],
      };
    });
  }

  /** Recent warnings for a provider, from the traffic log. */
  warnings(project: Project, p: AuthProvider, limit = 50) {
    const rows = this.hub.db
      .prepare(
        `SELECT id, received_at, method, url, resolved FROM traffic_logs
         WHERE project_id = ? AND json_extract(resolved, '$.kind') = 'auth' AND json_extract(resolved, '$.provider') = ?
           AND json_array_length(json_extract(resolved, '$.warnings')) > 0
         ORDER BY id DESC LIMIT ?`,
      )
      .all(project.id, p.slug, limit) as { id: string; received_at: string; method: string; url: string; resolved: string }[];
    return rows.map((r) => {
      const res = JSON.parse(r.resolved) as { endpoint?: string; warnings?: string[]; clientId?: string };
      return { logId: r.id, at: r.received_at, method: r.method, url: r.url, endpoint: res.endpoint ?? null, clientId: res.clientId ?? null, warnings: res.warnings ?? [] };
    });
  }

  /**
   * stubyard's clock for login providers (ms): real time + the project's / run's "auth" offset (PUT /api/projects/:slug/time).
   * The run is the request's explicit run (X-Hub-Run, /run/<key>/) or the test user's run.
   */
  private now(projectId: string, req?: FastifyRequest | null, userId?: string | null): number {
    const runId = req?.hubRun?.id ?? (userId ? this.hub.users.get(projectId, userId)?.runId : null) ?? null;
    return this.hub.clock?.now(projectId, 'auth', runId) ?? Date.now();
  }

  private nowIsoFor(c: Ctx, userId?: string | null): string {
    return new Date(this.now(c.project.id, c.req, userId)).toISOString();
  }

  purgeExpired(now = Date.now()): number {
    return this.repo.purgeExpired(now);
  }

  // ---------------------------------------------------------------- HTTP entry point

  async handle(req: FastifyRequest<{ Params: { project: string; provider: string; '*'?: string } }>, reply: FastifyReply): Promise<unknown> {
    const projectSlug = decodeURIComponent(req.params.project).toLowerCase();
    const project = this.hub.projects.getBySlug(projectSlug);
    const resolved: Record<string, unknown> = { kind: 'auth', project: project?.slug ?? null };
    req.trafficResolved = resolved;
    if (!project) {
      resolved.unknownProject = req.params.project;
      return reply.status(404).send({ error: 'Not found', message: `stubyard has no project "${req.params.project}"`, hint: 'Login provider URLs look like /auth/<project>/<provider>/… (Providers tab → Login providers).' });
    }
    if (req.trafficLogId) this.hub.traffic.update(req.trafficLogId, { projectId: project.id });
    const p = this.repo.getProvider(project.id, decodeURIComponent(req.params.provider));
    if (!p) {
      resolved.unknownProvider = req.params.provider;
      return reply.status(404).send({
        error: 'Not found',
        message: `Project "${project.slug}" has no login provider "${req.params.provider}"`,
        hint: `Create one with POST /api/projects/${project.slug}/auth {"preset":"google"} or in the dashboard (Providers → Login providers). Existing: ${this.repo.listProviders(project.id).map((x) => x.slug).join(', ') || 'none'}`,
      });
    }
    const preset = this.presetOf(p);
    Object.assign(resolved, { provider: p.slug, preset: p.preset });
    let rest = '/' + (req.params['*'] ?? '');
    rest = rest.split('?')[0];
    if (rest.length > 1) rest = trimEnd(rest, '/');
    const c: Ctx = {
      ...this.staticCtx(project, p, this.requestBase(req, project, p), this.publicBase(p, project), req),
      endpoint: 'token',
    };

    const cors = () => {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-expose-headers', 'www-authenticate, x-hub-request-id');
    };
    if (req.method === 'OPTIONS') {
      cors();
      resolved.endpoint = 'preflight';
      return reply
        .status(204)
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', String(req.headers['access-control-request-headers'] ?? 'authorization, content-type'))
        .header('access-control-max-age', '600')
        .send();
    }

    const finish = () => {
      if (c.warnings.length) resolved.warnings = [...new Set(c.warnings)];
    };

    try {
      if (rest === '/__hub/continue' && req.method === 'POST') {
        c.endpoint = 'continue';
        resolved.endpoint = 'continue';
        return await this.continue(c, reply, resolved);
      }
      if (rest === '/__hub/logout' && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST')) {
        c.endpoint = 'logout';
        resolved.endpoint = 'logout';
        return this.logout(c, reply);
      }
      const av = /^\/__hub\/avatar\/(.+)\.svg$/.exec(rest);
      if (av && req.method === 'GET') {
        c.endpoint = 'avatar';
        resolved.endpoint = 'avatar';
        const ident = this.repo.identityBySub(p.id, decodeURIComponent(av[1]));
        const u = ident ? this.hub.users.get(project.id, ident.testUserId) : null;
        return reply.type('image/svg+xml').header('cache-control', 'public, max-age=3600').send(avatarSvg(u?.name ?? '?', av[1]));
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let route = null;
      let m: RegExpExecArray | null = null;
      for (const r of preset.routes) {
        if (r.method !== 'ANY' && r.method !== method) continue;
        m = r.path.exec(rest);
        if (m) {
          route = r;
          break;
        }
      }
      if (!route || !m) {
        resolved.endpoint = 'unknown';
        req.trafficOutcome = 'unmatched';
        return reply.status(404).send({
          error: 'Not found',
          message: `The fake ${preset.name} has no endpoint ${req.method} ${rest}`,
          endpoints: preset.routes.map((r) => `${r.method} ${r.path.source}`),
          discovery: preset.paths(c).discovery ? c.backend + preset.paths(c).discovery : null,
        });
      }
      c.endpoint = route.endpoint;
      c.variant = route.variant;
      c.params = { ...(m.groups ?? {}) };
      resolved.endpoint = route.variant ? `${route.endpoint}:${route.variant}` : route.endpoint;
      if (!['authorize', 'logout'].includes(route.endpoint)) cors();
      if (!p.enabled) {
        req.trafficOutcome = 'rejected';
        return this.send(reply, { status: 503, body: { error: 'temporarily_unavailable', error_description: `Login provider "${p.slug}" is disabled in stubyard` } });
      }
      if (route.extra && preset.extra) {
        const out = await preset.extra(c, this.extraHelpers(c));
        return this.send(reply, out);
      }
      switch (route.endpoint) {
        case 'discovery':
          return this.send(reply, { body: this.discovery(c), headers: { 'cache-control': 'public, max-age=60' } });
        case 'authorize':
          return await this.authorize(c, reply, resolved);
        case 'token':
          return await this.token(c, reply, resolved);
        case 'userinfo':
          return await this.userinfo(c, reply, resolved);
        case 'jwks': {
          if (await this.transport(c, reply, resolved, 'jwks', null)) return reply;
          return this.send(reply, { body: this.jwks(p), headers: { 'cache-control': 'public, max-age=60' } });
        }
        case 'certs_pem': {
          if (await this.transport(c, reply, resolved, 'jwks', null)) return reply;
          this.signingKey(p);
          return this.send(reply, { body: Object.fromEntries(this.repo.listKeys(p.id).map((k) => [k.kid, k.certPem])), headers: { 'cache-control': 'public, max-age=60' } });
        }
        case 'revoke':
          return this.revoke(c, reply);
        case 'introspect':
          return this.introspect(c, reply);
        case 'logout':
          return this.logout(c, reply);
        default:
          return reply.status(404).send({ error: 'Not found' });
      }
    } finally {
      finish();
    }
  }

  private send(reply: FastifyReply, out: Out) {
    reply.status(out.status ?? 200);
    for (const [k, v] of Object.entries(out.headers ?? {})) reply.header(k, v);
    if (out.type) reply.type(out.type);
    if (out.body === undefined || out.body === null) return reply.send(out.type ? '' : out.status === 204 ? undefined : '');
    if (typeof out.body === 'string' || Buffer.isBuffer(out.body)) return reply.send(out.body);
    if (!out.type) reply.type('application/json; charset=utf-8');
    return reply.send(JSON.stringify(out.body));
  }

  private html(reply: FastifyReply, status: number, htmlText: string) {
    return reply.status(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(htmlText);
  }

  private dashboardUrl(c: Ctx) {
    // The dashboard is served on the browser-facing base as well (HTTP and HTTPS ports serve the same app), so keep its
    // scheme and port as-is: that respects STUBYARD_PUBLIC_URL (e.g. https://localhost:14443 behind an SSH tunnel).
    return `${new URL(c.browser).origin}/p/${c.project.slug}/providers`;
  }

  // ---------------------------------------------------------------- scenario plumbing

  /** X-Hub-Scenario header / hub_scenario parameter. */
  private explicit(c: Ctx, resolved: Record<string, unknown>): Effects | null {
    const h = c.req.headers['x-hub-scenario'];
    const q = input(c).hub_scenario;
    const raw = (Array.isArray(h) ? h[0] : h) ?? q;
    if (!raw) return null;
    const { effects, unknown } = parseScenario(String(raw), h ? 'header' : 'query');
    if (unknown.length) c.warnings.push(`Unknown scenario ${unknown.map((u) => `"${u}"`).join(', ')} ignored`);
    if (effects) resolved.scenario = { source: effects.source, actions: [...effects.actions] };
    return effects;
  }

  private fromRule(c: Ctx, resolved: Record<string, unknown>, stage: Parameters<typeof pickRule>[3], userId: string | null, allowed: readonly string[]): Effects | null {
    const r = pickRule(this.repo, c.provider, userId, stage, allowed);
    if (!r) return null;
    resolved.scenario = { source: 'rule', ruleId: r.id, action: r.action, scope: r.testUserId ? 'user' : 'provider', label: r.label };
    resolved.rule = r.id;
    return effectsFromRule(r);
  }

  /** slow / timeout / down / rate_limit. Returns true when the response was already handled. */
  private async transport(c: Ctx, reply: FastifyReply, resolved: Record<string, unknown>, stage: Parameters<typeof pickRule>[3], userId: string | null, given?: Effects | null): Promise<boolean> {
    const e = given !== undefined ? given : (this.explicit(c, resolved) ?? this.fromRule(c, resolved, stage, userId, TRANSPORT_ACTIONS));
    if (!e || !hasAny(e, TRANSPORT_ACTIONS)) return false;
    const req = c.req;
    if (e.actions.has('slow')) {
      await sleep(Math.min(e.delayMs ?? 2000, 600_000));
      return false;
    }
    if (e.actions.has('timeout')) {
      const logId = req.trafficLogId;
      req.trafficLogId = undefined;
      reply.hijack();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.hub.config.timeoutHoldMs);
        req.raw.once('close', () => (clearTimeout(t), resolve()));
      });
      req.raw.socket?.destroy();
      if (logId) {
        this.hub.traffic.mergeResolved(logId, resolved);
        this.hub.traffic.finish(logId, { outcome: 'forced_error', errorType: 'simulated_timeout', errorMessage: 'Login scenario: no response (timeout)', resStatus: null });
      }
      return true;
    }
    req.trafficOutcome = 'forced_error';
    if (e.actions.has('down')) {
      this.send(reply, { status: 503, body: { error: 'temporarily_unavailable', error_description: 'stubyard scenario "down": the identity provider is unavailable' }, headers: { 'retry-after': '30' } });
      return true;
    }
    this.send(reply, { status: 429, body: { error: 'rate_limited', error_description: 'stubyard scenario "rate_limit": too many requests' }, headers: { 'retry-after': '60' } });
    return true;
  }

  // ---------------------------------------------------------------- discovery

  discovery(c: Ctx): Record<string, unknown> {
    const paths = c.preset.paths(c);
    const scopes = c.preset.scopes?.filter((s) => !s.startsWith('https://')) ?? ['openid', 'profile', 'email', 'offline_access'];
    const doc: Record<string, unknown> = {
      issuer: this.issuer(c),
      authorization_endpoint: c.browser + paths.authorize,
      token_endpoint: c.backend + paths.token,
      ...(paths.userinfo ? { userinfo_endpoint: c.backend + paths.userinfo } : {}),
      ...(paths.jwks ? { jwks_uri: c.backend + paths.jwks } : {}),
      ...(paths.revoke ? { revocation_endpoint: c.backend + paths.revoke } : {}),
      ...(paths.introspect ? { introspection_endpoint: c.backend + paths.introspect } : {}),
      ...(paths.logout ? { end_session_endpoint: c.browser + paths.logout } : {}),
      response_types_supported: ['code', 'id_token', 'code id_token', 'token id_token', 'code token', 'code token id_token', 'token'],
      response_modes_supported: c.preset.responseModes,
      grant_types_supported: c.preset.grantTypes,
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: scopes,
      token_endpoint_auth_methods_supported: c.preset.tokenAuthMethods,
      claims_supported: ['aud', 'email', 'email_verified', 'exp', 'family_name', 'given_name', 'iat', 'iss', 'name', 'picture', 'sub', 'nonce', 'auth_time', 'at_hash'],
      code_challenge_methods_supported: ['S256', 'plain'],
      request_parameter_supported: false,
      claims_parameter_supported: false,
      authorization_response_iss_parameter_supported: false,
    };
    return c.preset.discovery ? c.preset.discovery(c, doc) : doc;
  }

  // ---------------------------------------------------------------- authorize

  private clientOf(c: Ctx, clientId: string | null) {
    const clients = c.cfg.clients ?? [];
    return clientId ? (clients.find((x) => x.clientId === clientId) ?? null) : null;
  }

  private async authorize(c: Ctx, reply: FastifyReply, resolved: Record<string, unknown>) {
    const q = input(c);
    const explicit = this.explicit(c, resolved);
    if (await this.transport(c, reply, resolved, 'authorize', null, explicit ?? this.fromRule(c, resolved, 'authorize', null, TRANSPORT_ACTIONS))) return reply;
    const strictErrors: string[] = [];
    const warn = (msg: string) => (c.strict ? strictErrors.push(msg) : c.warnings.push(`Would fail in production: ${msg}`));

    // --- client / redirect: problems here cannot be redirected back to the app ---
    const clientId = q.client_id ?? '';
    resolved.clientId = clientId || null;
    const clients = c.cfg.clients ?? [];
    const client = this.clientOf(c, clientId);
    if (!clientId) return this.html(reply, 400, renderError('Missing client_id', 'The authorization request has no client_id parameter.', [], this.dashboardUrl(c)));
    if (clients.length && !client) {
      if (c.strict) return this.html(reply, 400, renderError('Unknown client', `client_id "${clientId}" is not registered for this provider (strict mode).`, [`Registered: ${clients.map((x) => x.clientId).join(', ')}`], this.dashboardUrl(c)));
      c.warnings.push(`Would fail in production: unknown client_id "${clientId}" (registered: ${clients.map((x) => x.clientId).join(', ')})`);
    } else if (!clients.length && c.strict) {
      return this.html(reply, 400, renderError('No clients registered', 'Strict mode needs at least one registered client (Login providers → Clients).', [], this.dashboardUrl(c)));
    }
    let redirectUri = q.redirect_uri ?? '';
    if (!redirectUri) {
      const only = client?.redirectUris?.length === 1 ? client.redirectUris[0] : null;
      if (only && (c.preset.id === 'github' || c.preset.id === 'facebook')) redirectUri = only;
      else return this.html(reply, 400, renderError('Missing redirect_uri', 'The authorization request has no redirect_uri parameter.', [], this.dashboardUrl(c)));
    }
    try {
      new URL(redirectUri);
    } catch {
      return this.html(reply, 400, renderError('Invalid redirect_uri', `"${redirectUri}" is not an absolute URL.`, [], this.dashboardUrl(c)));
    }
    if (client?.redirectUris?.length && !client.redirectUris.includes(redirectUri)) {
      if (c.strict) return this.html(reply, 400, renderError('redirect_uri_mismatch', `The redirect URI "${redirectUri}" is not registered for client "${clientId}".`, [`Registered: ${client.redirectUris.join(', ')}`], this.dashboardUrl(c)));
      c.warnings.push(`Would fail in production: redirect_uri "${redirectUri}" is not registered for client "${clientId}"`);
    }

    const responseType = (q.response_type ?? (['github', 'facebook'].includes(c.preset.id) ? 'code' : '')).split(/\s+/).filter(Boolean).sort();
    const scopes = splitScope(q.scope ?? (c.preset.id === 'github' || c.preset.id === 'facebook' ? '' : ''));
    let responseMode = (q.response_mode as AuthRequest['responseMode']) || (responseType.some((t) => t === 'id_token' || t === 'token') ? 'fragment' : 'query');
    const ar: AuthRequest = {
      clientId,
      redirectUri,
      responseType,
      responseMode,
      scopes,
      state: q.state ?? null,
      nonce: q.nonce ?? null,
      codeChallenge: q.code_challenge ?? null,
      codeChallengeMethod: q.code_challenge ? (q.code_challenge_method ?? 'plain') : null,
      prompt: (q.prompt ?? '').split(/\s+/).filter(Boolean),
      loginHint: q[c.preset.loginHintParam ?? 'login_hint'] ?? q.login_hint ?? null,
      accessType: q.access_type ?? null,
      audience: q.audience ?? q.resource ?? null,
      backend: c.backend,
    };
    const fail = (error: string, description: string) => this.deliver(c, reply, ar, { error, error_description: description, ...(ar.state ? { state: ar.state } : {}) });

    if (!responseType.length) return fail('invalid_request', 'Missing response_type');
    const allowedRt = c.preset.protocol === 'oidc' ? ['code', 'id_token', 'token'] : ['code', 'token'];
    if (!responseType.every((t) => allowedRt.includes(t))) return fail('unsupported_response_type', `response_type "${q.response_type}" is not supported by ${c.preset.name}`);
    if (!['query', 'fragment', 'form_post'].includes(ar.responseMode)) return fail('invalid_request', `Unsupported response_mode "${q.response_mode}"`);
    if (!c.preset.responseModes.includes(ar.responseMode)) warn(`${c.preset.name} does not support response_mode=${ar.responseMode}`);
    if (ar.responseMode === 'query' && responseType.some((t) => t !== 'code')) warn('response_mode=query must not be used with id_token / token response types');
    if (ar.codeChallenge && !['S256', 'plain'].includes(ar.codeChallengeMethod ?? '')) return fail('invalid_request', `Unsupported code_challenge_method "${ar.codeChallengeMethod}"`);

    if (!ar.state) warn('the request has no state parameter (CSRF protection)');
    if (c.preset.protocol === 'oidc' && (scopes.includes('openid') || c.preset.id === 'apple') && !ar.nonce && responseType.includes('id_token')) warn('nonce is required when an id_token is returned from the authorization endpoint');
    else if (c.preset.protocol === 'oidc' && scopes.includes('openid') && !ar.nonce) warn('the request has no nonce (replay protection)');
    if (c.preset.pkce === 'required' && !ar.codeChallenge) warn(`${c.preset.name} requires PKCE (code_challenge with S256)`);
    if (ar.codeChallengeMethod === 'plain' && c.preset.pkce === 'required') warn(`${c.preset.name} only accepts code_challenge_method=S256`);
    const known = c.preset.scopes;
    if (known) {
      const bad = scopes.filter((s) => !known.includes(s));
      if (bad.length) warn(`invalid scope ${bad.map((s) => `"${s}"`).join(', ')} for ${c.preset.name}`);
    }
    if (c.preset.checkAuthorize) {
      const r = c.preset.checkAuthorize(c, q, scopes);
      for (const w of r.warnings) warn(w);
      if (r.responseMode) ar.responseMode = responseMode = r.responseMode as AuthRequest['responseMode'];
    }
    if (strictErrors.length) {
      const scopeErr = strictErrors.find((e) => e.startsWith('invalid scope'));
      return fail(scopeErr ? 'invalid_scope' : 'invalid_request', `${strictErrors.join('; ')} (stubyard strict mode)`);
    }

    const pending = this.repo.createGrant({
      projectId: c.project.id,
      providerId: c.provider.id,
      kind: 'pending',
      token: randomToken(18),
      clientId,
      redirectUri,
      scope: scopes.join(' '),
      nonce: ar.nonce,
      codeChallenge: ar.codeChallenge,
      codeChallengeMethod: ar.codeChallengeMethod,
      params: { req: ar, warnings: c.warnings, scenario: effectsToJson(explicit) },
      expiresAt: new Date(this.now(c.project.id, c.req) + PENDING_TTL_MS).toISOString(),
      logId: c.req.trafficLogId ?? null,
    });

    // --- skip the picker ---
    const users = this.hub.users;
    const forcePicker = ar.prompt.includes('login') || ar.prompt.includes('select_account');
    let user: TestUser | null = null;
    let via: string | null = null;
    if (ar.loginHint) {
      user = users.resolve(c.project.id, ar.loginHint);
      if (user) via = 'login_hint';
      else c.warnings.push(`login_hint "${ar.loginHint}" matches no test user`);
    }
    const cookies = parseCookies(c.req.headers.cookie);
    const loginAs = cookies.stubyard_login_as ?? cookies[`${LEGACY_NAME}_login_as`];
    if (!user && loginAs) {
      const ref = loginAs;
      const scoped = /^([^:]+):(.+)$/.exec(ref);
      const target = scoped && scoped[1] === c.provider.slug ? scoped[2] : scoped ? null : ref;
      if (target) {
        user = users.resolve(c.project.id, target);
        if (user) via = 'cookie';
      }
    }
    if (!user && c.cfg.autoLogin) {
      user = users.resolve(c.project.id, c.cfg.autoLogin);
      if (user) via = 'autoLogin';
    }
    if (!user && !forcePicker) {
      const sid = cookies[sessionCookie(c.provider)];
      const s = sid ? this.repo.grantByToken(c.provider.id, sid, 'session') : null;
      if (s && s.status === 'active' && (!s.expiresAt || s.expiresAt > nowIso()) && s.testUserId) {
        user = users.get(c.project.id, s.testUserId);
        if (user) via = 'session';
      }
    }
    if (user) {
      resolved.loginVia = via;
      return this.complete(c, reply, resolved, pending, user, {});
    }
    if (ar.prompt.includes('none')) {
      this.repo.markUsed(pending.id);
      return fail('login_required', 'prompt=none was requested but no user is signed in (no login_hint, stubyard_login_as cookie, autoLogin or session)');
    }
    return this.picker(c, reply, pending, ar, null);
  }

  private picker(c: Ctx, reply: FastifyReply, pending: AuthGrant, ar: AuthRequest, notice: string | null) {
    const client = this.clientOf(c, ar.clientId);
    const warnings = (pending.params.warnings as string[] | undefined) ?? c.warnings;
    const users: PickerUser[] = this.hub.users.list(c.project.id).map((u) => {
      const ident = this.repo.getIdentity(c.provider.id, u.id);
      const badges: PickerUser['badges'] = [];
      const email = ident?.claims.email !== undefined ? (ident.claims.email as string | null) : u.email;
      if (!email) badges.push({ text: 'no email', kind: 'warn' });
      if (ident?.claims.email_verified === false) badges.push({ text: 'unverified', kind: 'warn' });
      const rules = this.repo.listRules(c.provider.id, u.id).filter((r) => r.active);
      if (rules.length) badges.push({ text: rules.map((r) => r.action).join(', '), kind: 'bad' });
      return { id: u.id, name: u.name, role: u.role, email, badges };
    });
    return this.html(
      reply,
      200,
      renderPicker({
        presetName: c.preset.name,
        providerName: c.provider.name,
        projectName: c.project.name,
        clientId: ar.clientId,
        clientName: client?.name ?? null,
        redirectUri: ar.redirectUri,
        scopes: ar.scopes,
        warnings,
        users,
        reqId: pending.token,
        action: `${new URL(c.backend).pathname}/__hub/continue`,
        apple: c.preset.id === 'apple' && ar.scopes.includes('email'),
        outcomes: AUTHORIZE_ACTIONS.filter((a) => a !== 'access_denied'),
        dashboardUrl: this.dashboardUrl(c),
        notice,
      }),
    );
  }

  private async continue(c: Ctx, reply: FastifyReply, resolved: Record<string, unknown>) {
    const f = input(c);
    const pending = f.req ? this.repo.grantByToken(c.provider.id, f.req, 'pending') : null;
    if (!pending) return this.html(reply, 400, renderError('Login request not found', 'This sign-in request does not exist (or belongs to another provider). Start the login again from the app.', [], this.dashboardUrl(c)));
    const ar = pending.params.req as AuthRequest;
    resolved.clientId = ar.clientId;
    if (pending.status !== 'active') return this.html(reply, 400, renderError('Already used', 'This sign-in request was already completed. Start the login again from the app.', [], this.dashboardUrl(c)));
    if (pending.expiresAt && pending.expiresAt < this.nowIsoFor(c)) return this.html(reply, 400, renderError('Expired', 'This sign-in request expired (10 minutes). Start the login again from the app.', [], this.dashboardUrl(c)));
    c.warnings.push(...((pending.params.warnings as string[]) ?? []));
    if (f.outcome) {
      const outcome = f.outcome.toLowerCase();
      if (!AUTHORIZE_ACTIONS.includes(outcome)) return this.html(reply, 400, renderError('Unknown outcome', `"${f.outcome}" is not a login outcome.`));
      this.repo.markUsed(pending.id);
      resolved.outcome = outcome;
      return this.authorizeError(c, reply, ar, outcome);
    }
    const user = f.user ? this.hub.users.get(c.project.id, f.user) : null;
    if (!user) return this.picker(c, reply, pending, ar, 'Pick a test user (the one you chose no longer exists).');
    resolved.loginVia = 'picker';
    return this.complete(c, reply, resolved, pending, user, { appleEmail: f.apple_email === 'hide' ? 'hide' : f.apple_email === 'share' ? 'share' : undefined });
  }

  private authorizeError(c: Ctx, reply: FastifyReply, ar: AuthRequest, action: string) {
    const error = action === 'mfa_required' ? 'interaction_required' : action;
    return this.deliver(c, reply, ar, { error, error_description: `${AUTHORIZE_ERRORS[action] ?? action} (stubyard scenario "${action}")`, ...(ar.state ? { state: ar.state } : {}) });
  }

  private async complete(c: Ctx, reply: FastifyReply, resolved: Record<string, unknown>, pending: AuthGrant, user: TestUser, opts: { appleEmail?: 'share' | 'hide' }) {
    const ar = pending.params.req as AuthRequest;
    if (!this.repo.markUsed(pending.id)) return this.html(reply, 400, renderError('Already used', 'This sign-in request was already completed.'));
    resolved.user = user.id;
    resolved.testUserIds = [user.id];
    resolved.clientId = ar.clientId;
    const carried = effectsFromJson(pending.params.scenario, 'authorize');
    const eff = carried ?? this.fromRule(c, resolved, 'authorize', user.id, AUTHORIZE_ACTIONS);
    if (eff && hasAny(eff, AUTHORIZE_ACTIONS.filter((a) => a !== 'state_mismatch'))) {
      const action = AUTHORIZE_ACTIONS.find((a) => a !== 'state_mismatch' && eff.actions.has(a))!;
      c.req.trafficOutcome = 'forced_error';
      return this.authorizeError(c, reply, ar, action);
    }
    let identity = this.ensureIdentity(c.provider, user);
    if (opts.appleEmail) identity = this.repo.updateIdentity(identity, { claims: { ...identity.claims, hideEmail: opts.appleEmail === 'hide' } });
    const first = !identity.consented;
    if (first) identity = this.repo.updateIdentity(identity, { consented: true });

    // SSO session (skips the picker next time unless prompt=login / select_account). A live session for the same
    // user is reused and extended; one for another user (switched in the picker) is ended and replaced.
    const sessionExpires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const sid = parseCookies(c.req.headers.cookie)[sessionCookie(c.provider)];
    const prev = sid ? this.repo.grantByToken(c.provider.id, sid, 'session') : null;
    const live = prev && prev.status === 'active' && (!prev.expiresAt || prev.expiresAt > nowIso()) ? prev : null;
    let session: AuthGrant;
    if (live && live.testUserId === user.id) {
      this.repo.touchSession(live.id, sessionExpires);
      session = live;
    } else {
      if (live) this.repo.revoke(live.id);
      session = this.repo.createGrant({
        projectId: c.project.id,
        providerId: c.provider.id,
        testUserId: user.id,
        kind: 'session',
        token: randomToken(24),
        expiresAt: sessionExpires,
      });
      this.hub.bus.publish({ type: 'auth.changed', projectId: c.project.id, data: { signedIn: user.id, provider: c.provider.slug } });
    }
    const cookiePath = new URL(c.browser).pathname || '/';
    reply.header('set-cookie', `${sessionCookie(c.provider)}=${session.token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);

    const out: Record<string, string> = {};
    const tokenEffects = eff && !hasAny(eff, AUTHORIZE_ACTIONS.filter((a) => a !== 'state_mismatch')) ? eff : null;
    let familyId: string | null = null;
    if (ar.responseType.includes('code')) {
      const code = this.createCode(c.project, c.provider, user, {
        clientId: ar.clientId,
        redirectUri: ar.redirectUri,
        scopes: ar.scopes,
        nonce: ar.nonce,
        state: ar.state,
        codeChallenge: ar.codeChallenge,
        codeChallengeMethod: ar.codeChallengeMethod,
        accessType: ar.accessType,
        audience: ar.audience,
        scenario: effectsToJson(tokenEffects),
        appleUser: null,
      });
      familyId = code.familyId;
      out.code = code.token;
    }
    if (ar.responseType.includes('id_token') || ar.responseType.includes('token')) {
      const issued = this.issueTokens(c, {
        user,
        clientId: ar.clientId,
        scopes: ar.scopes,
        nonce: ar.nonce,
        authTime: Math.floor(this.now(c.project.id, c.req, user.id) / 1000),
        familyId,
        effects: tokenEffects,
        includeRefresh: false,
        includeIdToken: ar.responseType.includes('id_token'),
        audience: ar.audience,
        grantType: 'implicit',
        issuer: this.issuer(c, ar.backend),
      });
      if (ar.responseType.includes('token')) Object.assign(out, { access_token: issued.access_token, token_type: issued.token_type, ...(issued.expires_in !== null ? { expires_in: String(issued.expires_in) } : {}) });
      if (issued.id_token) out.id_token = issued.id_token;
    }
    if (c.preset.formPostUser && first && (ar.scopes.includes('name') || ar.scopes.includes('email'))) {
      const prof = this.profile(c, user, identity, tokenEffects);
      out.user = JSON.stringify({
        ...(ar.scopes.includes('name') ? { name: { firstName: prof.givenName, lastName: prof.familyName } } : {}),
        ...(ar.scopes.includes('email') && prof.email ? { email: prof.email } : {}),
      });
    }
    if (ar.state) out.state = eff?.actions.has('state_mismatch') ? `${ar.state}-tampered-${randomToken(4)}` : ar.state;
    else if (eff?.actions.has('state_mismatch')) out.state = 'unexpected-' + randomToken(4);
    return this.deliver(c, reply, ar, out);
  }

  private deliver(_c: Ctx, reply: FastifyReply, ar: AuthRequest, params: Record<string, string>) {
    if (ar.responseMode === 'form_post') return this.html(reply, 200, renderFormPost(ar.redirectUri, params));
    const location = appendParams(ar.redirectUri, new URLSearchParams(params), ar.responseMode);
    return reply.status(302).header('location', location).header('cache-control', 'no-store').send();
  }

  // ---------------------------------------------------------------- token endpoint

  private clientAuth(c: Ctx, q: Record<string, string>) {
    const h = String(c.req.headers.authorization ?? '');
    const m = /^Basic\s+(.+)$/i.exec(h);
    if (m) {
      const dec = Buffer.from(m[1], 'base64').toString('utf8');
      const i = dec.indexOf(':');
      const id = decodeURIComponent((i >= 0 ? dec.slice(0, i) : dec).replace(/\+/g, ' '));
      const secret = i >= 0 ? decodeURIComponent(dec.slice(i + 1).replace(/\+/g, ' ')) : '';
      return { clientId: id, secret, method: 'client_secret_basic' };
    }
    if (q.client_assertion) {
      const d = decodeJwt(q.client_assertion);
      return { clientId: q.client_id ?? String(d?.payload.sub ?? ''), secret: null, method: 'private_key_jwt' };
    }
    if (q.client_secret !== undefined) return { clientId: q.client_id ?? '', secret: q.client_secret, method: 'client_secret_post' };
    return { clientId: q.client_id ?? '', secret: null, method: 'none' };
  }

  private async token(c: Ctx, reply: FastifyReply, resolved: Record<string, unknown>) {
    const q = input(c);
    const preset = c.preset;
    const grantType = q.grant_type || (q.code ? 'authorization_code' : q.refresh_token ? 'refresh_token' : '');
    resolved.grantType = grantType || null;
    const auth = this.clientAuth(c, q);
    const err = (error: string, description: string, status = 400, reason?: string) => {
      if (!c.req.trafficOutcome) c.req.trafficOutcome = 'rejected';
      resolved.error = error;
      return this.send(reply, preset.tokenError(c, error, description, status, reason));
    };

    // Grants first (needed to know the user for rules); validated below.
    const code = grantType === 'authorization_code' && q.code ? this.repo.grantByToken(c.provider.id, q.code, 'code') : null;
    const refresh = grantType === 'refresh_token' && q.refresh_token ? this.repo.grantByToken(c.provider.id, q.refresh_token, 'refresh') : null;
    const userId = code?.testUserId ?? refresh?.testUserId ?? null;
    if (userId) {
      resolved.user = userId;
      resolved.testUserIds = [userId];
    }
    const stage = grantType === 'refresh_token' ? 'refresh' : 'token';
    const explicit = this.explicit(c, resolved);
    let eff = explicit ?? this.fromRule(c, resolved, stage, userId, [...TRANSPORT_ACTIONS, ...TOKEN_ACTIONS, ...CLAIM_ACTIONS, ...DEFECT_ACTIONS]);
    if (await this.transport(c, reply, resolved, stage, userId, eff)) return reply;
    if (code) eff = mergeEffects(eff, effectsFromJson(code.params.scenario, 'authorize'));

    if (eff?.actions.has('invalid_client')) {
      c.req.trafficOutcome = 'forced_error';
      return err('invalid_client', 'Client authentication failed (stubyard scenario "invalid_client")', 401, 'scenario');
    }
    if (eff?.actions.has('invalid_grant')) {
      c.req.trafficOutcome = 'forced_error';
      return err('invalid_grant', 'The grant is invalid (stubyard scenario "invalid_grant")', 400, 'scenario');
    }
    if (eff?.actions.has('expired_code') && grantType === 'authorization_code') {
      c.req.trafficOutcome = 'forced_error';
      return err('invalid_grant', 'The authorization code has expired (stubyard scenario "expired_code")', 400, 'code_expired');
    }

    // --- client authentication (lax: warnings) ---
    const clientId = auth.clientId || code?.clientId || refresh?.clientId || '';
    resolved.clientId = clientId || null;
    const clients = c.cfg.clients ?? [];
    const client = this.clientOf(c, clientId);
    const problems: string[] = [];
    if (!auth.clientId) problems.push('the token request does not identify the client (client_id / HTTP Basic)');
    if (clients.length && clientId && !client) problems.push(`unknown client_id "${clientId}"`);
    if (!clients.length && c.strict) problems.push('no clients are registered for this provider');
    if (client?.clientSecret && auth.method !== 'none' && auth.method !== 'private_key_jwt' && auth.secret !== client.clientSecret && !preset.verifyClientSecret) problems.push('wrong client_secret');
    if (client?.clientSecret && auth.method === 'none' && grantType !== 'refresh_token') problems.push('client_secret missing (confidential client)');
    if (auth.method !== 'none' && !preset.tokenAuthMethods.includes(auth.method)) problems.push(`${preset.name} does not accept ${auth.method} at the token endpoint (use ${preset.tokenAuthMethods.join(' or ')})`);
    if (preset.verifyClientSecret) problems.push(...preset.verifyClientSecret(c, clientId, auth.secret));
    if (problems.length) {
      if (c.strict) return err('invalid_client', `Client authentication failed: ${problems.join('; ')} (stubyard strict mode)`, 401, problems.some((p) => p.startsWith('unknown')) ? 'client_unknown' : 'client_secret');
      for (const p of problems) c.warnings.push(`Would fail in production: ${p}`);
    }

    const issuer = this.issuer(c);
    if (grantType === 'authorization_code') {
      if (!q.code) return err('invalid_request', 'Missing code', 400, 'code_missing');
      if (!code) return err('invalid_grant', 'The authorization code is invalid', 400, 'code_unknown');
      if (code.status !== 'active') {
        const revoked = this.repo.revokeFamily(code.familyId ?? code.id);
        resolved.reuse = { kind: 'code', revoked };
        return err('invalid_grant', 'The authorization code was already redeemed; tokens issued with it were revoked', 400, 'code_reused');
      }
      if (code.expiresAt && code.expiresAt < this.nowIsoFor(c, code.testUserId)) return err('invalid_grant', 'The authorization code has expired', 400, 'code_expired');
      if (auth.clientId && code.clientId && auth.clientId !== code.clientId) return err('invalid_grant', `The code was issued to client "${code.clientId}", not "${auth.clientId}"`, 400, 'client_mismatch');
      if (q.redirect_uri && code.redirectUri && q.redirect_uri !== code.redirectUri) return err('invalid_grant', `redirect_uri does not match the one used in the authorization request (${code.redirectUri})`, 400, 'redirect_mismatch');
      if (!q.redirect_uri && code.redirectUri && preset.id !== 'github') {
        if (c.strict) return err('invalid_request', 'Missing redirect_uri (stubyard strict mode)', 400, 'redirect_mismatch');
        c.warnings.push('Would fail in production: the token request has no redirect_uri');
      }
      if (code.codeChallenge) {
        if (!q.code_verifier) return err('invalid_grant', 'Missing code_verifier (the authorization request used PKCE)', 400, 'pkce');
        const expected = code.codeChallengeMethod === 'plain' ? q.code_verifier : pkceS256(q.code_verifier);
        if (expected !== code.codeChallenge) return err('invalid_grant', 'code_verifier does not match code_challenge', 400, 'pkce');
      } else if (preset.pkce === 'required' && !c.strict) {
        c.warnings.push(`Would fail in production: ${preset.name} requires PKCE`);
      }
      if (!this.repo.markUsed(code.id)) {
        this.repo.revokeFamily(code.familyId ?? code.id);
        return err('invalid_grant', 'The authorization code was already redeemed', 400, 'code_reused');
      }
      const user = this.hub.users.get(c.project.id, code.testUserId ?? '');
      if (!user) return err('invalid_grant', 'The test user of this code was deleted', 400, 'code_unknown');
      const scopes = splitScope(code.scope ?? '');
      const issued = this.issueTokens(c, {
        user,
        clientId: code.clientId ?? clientId,
        scopes,
        nonce: code.nonce,
        authTime: Number(code.params.authTime) || Math.floor(this.now(c.project.id, c.req, code.testUserId) / 1000),
        familyId: code.familyId,
        parentId: code.id,
        effects: eff,
        includeRefresh: this.refreshPolicy(c, scopes, code.params),
        includeIdToken: this.wantsIdToken(c, scopes),
        audience: (code.params.audience as string | null) ?? null,
        grantType,
        issuer,
      });
      this.tokenResolved(resolved, issued, eff);
      return this.send(reply, preset.tokenResponse(c, issued));
    }

    if (grantType === 'refresh_token') {
      if (!q.refresh_token) return err('invalid_request', 'Missing refresh_token', 400, 'refresh_missing');
      if (!refresh) return err('invalid_grant', 'The refresh token is invalid', 400, 'refresh_unknown');
      if (refresh.status === 'used') {
        const revoked = this.repo.revokeFamily(refresh.familyId ?? refresh.id);
        resolved.reuse = { kind: 'refresh', revoked };
        return err('invalid_grant', 'The refresh token was already used (rotated); the whole token family was revoked', 400, 'refresh_reused');
      }
      if (refresh.status === 'revoked') return err('invalid_grant', 'The refresh token was revoked', 400, 'refresh_revoked');
      if (refresh.expiresAt && refresh.expiresAt < this.nowIsoFor(c, refresh.testUserId)) return err('invalid_grant', 'The refresh token has expired', 400, 'refresh_expired');
      if (auth.clientId && refresh.clientId && auth.clientId !== refresh.clientId) return err('invalid_grant', `The refresh token was issued to client "${refresh.clientId}"`, 400, 'client_mismatch');
      const rotate = c.cfg.rotateRefresh ?? preset.rotateRefresh;
      if (rotate && !this.repo.markUsed(refresh.id)) return err('invalid_grant', 'The refresh token was already used', 400, 'refresh_reused');
      const user = this.hub.users.get(c.project.id, refresh.testUserId ?? '');
      if (!user) return err('invalid_grant', 'The test user of this token was deleted', 400, 'refresh_unknown');
      const granted = splitScope(refresh.scope ?? '');
      let scopes = granted;
      if (q.scope) {
        const asked = splitScope(q.scope);
        const extra = asked.filter((s) => !granted.includes(s));
        if (extra.length) return err('invalid_scope', `Scope ${extra.join(' ')} was not granted originally`, 400, 'scope');
        scopes = asked;
      }
      const issued = this.issueTokens(c, {
        user,
        clientId: refresh.clientId ?? clientId,
        scopes,
        authTime: Number(refresh.params.authTime) || undefined,
        familyId: refresh.familyId,
        parentId: refresh.id,
        effects: eff,
        includeRefresh: rotate,
        includeIdToken: this.wantsIdToken(c, scopes) && preset.id !== 'linkedin',
        audience: (refresh.params.audience as string | null) ?? null,
        grantType,
        issuer,
      });
      this.tokenResolved(resolved, issued, eff);
      return this.send(reply, preset.tokenResponse(c, issued));
    }

    if (grantType === 'client_credentials' && preset.grantTypes.includes('client_credentials')) {
      if (!clientId) return err('invalid_client', 'client_credentials needs client authentication', 401, 'client_unknown');
      const scopes = splitScope(q.scope ?? '');
      const issued = this.issueTokens(c, {
        user: null,
        clientId,
        scopes,
        effects: eff,
        includeRefresh: false,
        includeIdToken: false,
        audience: q.audience ?? q.resource ?? c.cfg.audience ?? null,
        grantType,
        issuer,
      });
      this.tokenResolved(resolved, issued, eff);
      return this.send(reply, preset.tokenResponse(c, issued));
    }

    return err('unsupported_grant_type', `grant_type "${grantType || '(missing)'}" is not supported by ${preset.name}`, 400, 'grant_type');
  }

  private tokenResolved(resolved: Record<string, unknown>, issued: Issued, eff: Effects | null) {
    resolved.sub = issued.sub;
    resolved.issued = { idToken: !!issued.id_token, refreshToken: !!issued.refresh_token, expiresIn: issued.expires_in, scope: issued.scope };
    if (eff && !resolved.scenario) resolved.scenario = { source: eff.source, actions: [...eff.actions] };
  }

  // ---------------------------------------------------------------- resource endpoints

  private bearerToken(c: Ctx): string | null {
    const h = String(c.req.headers.authorization ?? '');
    const m = /^(?:Bearer|token|OAuth)\s+(.+)$/i.exec(h);
    if (m) return m[1].trim();
    const q = input(c);
    return q.access_token ?? q.token ?? q.oauth_token ?? null;
  }

  private extraHelpers(c: Ctx) {
    return {
      bearer: () => this.resolveBearer(c),
      lookup: (token: string) => {
        const g = this.repo.grantByToken(c.provider.id, token, ['access', 'refresh']);
        if (!g) return null;
        const user = g.testUserId ? this.hub.users.get(c.project.id, g.testUserId) : null;
        const profile = user ? this.profile(c, user, this.ensureIdentity(c.provider, user), effectsFromJson(g.params.effects, 'grant')) : null;
        return { grant: g, profile };
      },
      issuer: () => this.issuer(c),
    };
  }

  private resolveBearer(c: Ctx): { grant: AuthGrant; profile: Profile } | { error: Out } {
    const token = this.bearerToken(c);
    if (!token) return { error: c.preset.unauthorized(c, 'Missing access token') };
    const g = this.repo.grantByToken(c.provider.id, token, 'access');
    if (!g) return { error: c.preset.unauthorized(c, 'Invalid access token') };
    if (g.status !== 'active') return { error: c.preset.unauthorized(c, 'The access token was revoked') };
    if (g.expiresAt && g.expiresAt < this.nowIsoFor(c, g.testUserId)) return { error: c.preset.unauthorized(c, 'The access token expired') };
    const user = g.testUserId ? this.hub.users.get(c.project.id, g.testUserId) : null;
    if (!user) return { error: c.preset.unauthorized(c, 'This token has no user (client credentials) or the user was deleted') };
    const profile = this.profile(c, user, this.ensureIdentity(c.provider, user), effectsFromJson(g.params.effects, 'grant'));
    return { grant: g, profile };
  }

  private async userinfo(c: Ctx, reply: FastifyReply, resolved: Record<string, unknown>) {
    const token = this.bearerToken(c);
    const g0 = token ? this.repo.grantByToken(c.provider.id, token, 'access') : null;
    const userId = g0?.testUserId ?? null;
    if (userId) {
      resolved.user = userId;
      resolved.testUserIds = [userId];
      resolved.clientId = g0?.clientId ?? null;
    }
    const eff = this.explicit(c, resolved) ?? this.fromRule(c, resolved, 'userinfo', userId, [...TRANSPORT_ACTIONS, ...CLAIM_ACTIONS]);
    if (await this.transport(c, reply, resolved, 'userinfo', userId, eff)) return reply;
    const r = this.resolveBearer(c);
    if ('error' in r) {
      c.req.trafficOutcome = 'rejected';
      return this.send(reply, r.error);
    }
    let profile = r.profile;
    if (eff && hasAny(eff, CLAIM_ACTIONS)) {
      const merged = mergeEffects(eff, effectsFromJson(r.grant.params.effects, 'grant'));
      profile = this.profile(c, profile.user, profile.identity, merged);
    }
    return this.send(reply, c.preset.userinfo(c, profile, r.grant));
  }

  private revoke(c: Ctx, reply: FastifyReply) {
    const q = input(c);
    const token = q.token ?? q.access_token ?? this.bearerToken(c) ?? '';
    const g = token ? this.repo.grantByToken(c.provider.id, token, ['access', 'refresh']) : null;
    if (g) {
      if (g.kind === 'refresh') this.repo.revokeFamily(g.familyId ?? g.id);
      else this.repo.revoke(g.id);
    }
    return this.send(reply, c.preset.revokeResponse ? c.preset.revokeResponse(c, !!g) : { status: 200, body: {} });
  }

  private introspect(c: Ctx, reply: FastifyReply) {
    const q = input(c);
    const g = q.token ? this.repo.grantByToken(c.provider.id, q.token, ['access', 'refresh']) : null;
    const active = !!g && g.status === 'active' && (!g.expiresAt || g.expiresAt > this.nowIsoFor(c, g.testUserId));
    if (!g || !active) return this.send(reply, { body: { active: false } });
    const user = g.testUserId ? this.hub.users.get(c.project.id, g.testUserId) : null;
    const ident = user ? this.ensureIdentity(c.provider, user) : null;
    return this.send(reply, {
      body: {
        active: true,
        scope: g.scope,
        client_id: g.clientId,
        username: user?.email ?? user?.name ?? null,
        token_type: g.kind === 'access' ? 'Bearer' : 'refresh_token',
        exp: g.expiresAt ? Math.floor(Date.parse(g.expiresAt) / 1000) : undefined,
        iat: Math.floor(Date.parse(g.createdAt) / 1000),
        sub: ident?.sub ?? g.clientId,
        aud: (g.params.audience as string | null) ?? g.clientId,
        iss: this.issuer(c),
      },
    });
  }

  private logout(c: Ctx, reply: FastifyReply) {
    const q = input(c);
    const cookies = parseCookies(c.req.headers.cookie);
    const sid = cookies[sessionCookie(c.provider)];
    if (sid) {
      const s = this.repo.grantByToken(c.provider.id, sid, 'session');
      if (s && s.status === 'active') {
        this.repo.revoke(s.id);
        this.hub.bus.publish({ type: 'auth.changed', projectId: c.project.id, data: { sessionsRevoked: 1, provider: c.provider.slug } });
      }
    }
    const cookiePath = new URL(c.browser).pathname || '/';
    reply.header('set-cookie', `${sessionCookie(c.provider)}=; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0`);
    const target = q.post_logout_redirect_uri ?? q.returnTo ?? q.continue ?? q.logout_uri ?? q.redirect_uri ?? null;
    if (target) {
      try {
        new URL(target);
      } catch {
        return this.html(reply, 400, renderError('Invalid logout redirect', `"${target}" is not an absolute URL.`));
      }
      const params = new URLSearchParams(q.state ? { state: q.state } : {});
      return reply.status(302).header('location', appendParams(target, params, 'query')).send();
    }
    return this.html(reply, 200, renderSignedOut(c.preset.name));
  }
}

// ---------------------------------------------------------------- helpers

export function splitScope(s: string): string[] {
  return [...new Set(String(s ?? '').split(/[\s,]+/).filter(Boolean))];
}

function sessionCookie(p: AuthProvider) {
  return `stubyard_sso_${p.id}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function appendParams(uri: string, params: URLSearchParams, mode: 'query' | 'fragment' | 'form_post'): string {
  const str = params.toString();
  if (!str) return uri;
  if (mode === 'fragment') return `${uri.split('#')[0]}#${str}`;
  const [base, hash] = uri.split('#');
  return `${base}${base.includes('?') ? '&' : '?'}${str}${hash !== undefined ? `#${hash}` : ''}`;
}
