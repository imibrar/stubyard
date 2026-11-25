import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson, slugify, SLUG_RE } from '../util.js';

/** Login providers (fake OAuth 2.0 / OpenID Connect identity providers), migration 9. */

export interface AuthClient {
  clientId: string;
  clientSecret?: string | null;
  redirectUris?: string[];
  name?: string;
}

export interface AuthProviderConfig {
  /** Turn "would fail in production" warnings into the provider's real errors. */
  strict?: boolean;
  /** request-host (default): issuer from the Host of each backend call; fixed: `issuer` everywhere. */
  issuerMode?: 'request-host' | 'fixed';
  /** fixed mode: base URL that replaces https://<host>/auth/<project>/<provider> in every URL and in `iss`. */
  issuer?: string | null;
  /** Literal `iss` (e.g. https://accounts.google.com) for apps that hardcode it. */
  issOverride?: string | null;
  /** Base the browser is sent to (authorize / logout). Default STUBYARD_PUBLIC_URL. */
  browserBaseUrl?: string | null;
  /** Skip the picker and log in as this user (id, email, name or role). */
  autoLogin?: string | null;
  /** Registered clients. Empty = any client_id is accepted (lax) / rejected (strict). */
  clients?: AuthClient[];
  codeTtlSeconds?: number;
  accessTokenTtl?: number;
  idTokenTtl?: number;
  /** auto = the preset's real behaviour (e.g. Google only with access_type=offline). */
  refresh?: 'auto' | 'always' | 'never';
  rotateRefresh?: boolean;
  // Generic OIDC
  flavor?: 'generic' | 'auth0' | 'okta' | 'keycloak' | 'cognito';
  accessTokenFormat?: 'jwt' | 'opaque';
  audience?: string | null;
  extraClaims?: Record<string, unknown> | null;
  // Microsoft
  tenantId?: string | null;
  includeEmail?: boolean;
  /** Entra optional claims on the ID token: 'email', 'xms_edov' (email domain owner verified). Unknown values are ignored. */
  optionalClaims?: string[] | null;
  // Google
  hostedDomain?: string | null;
  // Apple
  teamId?: string | null;
  clientPublicKey?: string | null;
  // Slack
  teamName?: string | null;
  [key: string]: unknown;
}

export interface AuthProvider {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  preset: string;
  config: AuthProviderConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProviderRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  preset: string;
  config: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const toProvider = (r: ProviderRow): AuthProvider => ({
  id: r.id,
  projectId: r.project_id,
  slug: r.slug,
  name: r.name,
  preset: r.preset,
  config: parseJson<AuthProviderConfig>(r.config, {}),
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface AuthKey {
  id: string;
  providerId: string;
  kid: string;
  alg: string;
  privatePem: string;
  publicJwk: Record<string, unknown>;
  certPem: string | null;
  status: 'active' | 'retired';
  createdAt: string;
  retiredAt: string | null;
}

interface KeyRow {
  id: string;
  auth_provider_id: string;
  kid: string;
  alg: string;
  private_pem: string;
  public_jwk: string;
  cert_pem: string | null;
  status: 'active' | 'retired';
  created_at: string;
  retired_at: string | null;
}

const toKey = (r: KeyRow): AuthKey => ({
  id: r.id,
  providerId: r.auth_provider_id,
  kid: r.kid,
  alg: r.alg,
  privatePem: r.private_pem,
  publicJwk: parseJson(r.public_jwk, {}),
  certPem: r.cert_pem,
  status: r.status,
  createdAt: r.created_at,
  retiredAt: r.retired_at,
});

export interface AuthIdentity {
  id: string;
  providerId: string;
  testUserId: string;
  sub: string;
  /** Per-provider overrides: email, email_verified, picture, hd, login, name, hideEmail (Apple)… */
  claims: Record<string, unknown>;
  consented: boolean;
  createdAt: string;
}

interface IdentityRow {
  id: string;
  auth_provider_id: string;
  test_user_id: string;
  sub: string;
  claims: string;
  consented: number;
  created_at: string;
}

const toIdentity = (r: IdentityRow): AuthIdentity => ({
  id: r.id,
  providerId: r.auth_provider_id,
  testUserId: r.test_user_id,
  sub: r.sub,
  claims: parseJson(r.claims, {}),
  consented: r.consented === 1,
  createdAt: r.created_at,
});

export type GrantKind = 'pending' | 'code' | 'access' | 'refresh' | 'session';

export interface AuthGrant {
  id: string;
  projectId: string;
  providerId: string;
  testUserId: string | null;
  kind: GrantKind;
  token: string;
  clientId: string | null;
  redirectUri: string | null;
  scope: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  familyId: string | null;
  parentId: string | null;
  status: 'active' | 'used' | 'revoked';
  params: Record<string, unknown>;
  logId: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
}

interface GrantRow {
  id: string;
  project_id: string;
  auth_provider_id: string;
  test_user_id: string | null;
  kind: GrantKind;
  token: string;
  client_id: string | null;
  redirect_uri: string | null;
  scope: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  family_id: string | null;
  parent_id: string | null;
  status: 'active' | 'used' | 'revoked';
  params: string;
  log_id: string | null;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
}

const toGrant = (r: GrantRow): AuthGrant => ({
  id: r.id,
  projectId: r.project_id,
  providerId: r.auth_provider_id,
  testUserId: r.test_user_id,
  kind: r.kind,
  token: r.token,
  clientId: r.client_id,
  redirectUri: r.redirect_uri,
  scope: r.scope,
  nonce: r.nonce,
  codeChallenge: r.code_challenge,
  codeChallengeMethod: r.code_challenge_method,
  familyId: r.family_id,
  parentId: r.parent_id,
  status: r.status,
  params: parseJson(r.params, {}),
  logId: r.log_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
});

export type GrantInput = Partial<Omit<AuthGrant, 'id' | 'createdAt' | 'status' | 'usedAt'>> & {
  projectId: string;
  providerId: string;
  kind: GrantKind;
  token: string;
};

export const AUTH_STAGES = ['any', 'authorize', 'token', 'refresh', 'userinfo', 'jwks'] as const;
export type AuthStage = (typeof AUTH_STAGES)[number];

export const AUTH_ACTION_GROUPS = {
  authorize: ['access_denied', 'login_required', 'interaction_required', 'consent_required', 'mfa_required', 'server_error', 'temporarily_unavailable', 'state_mismatch'],
  token: ['invalid_grant', 'expired_code', 'invalid_client', 'no_refresh_token', 'short_lived'],
  claims: ['no_email', 'email_unverified', 'private_email'],
  defect: ['bad_signature', 'wrong_aud', 'wrong_iss', 'wrong_nonce', 'expired_id_token', 'unknown_kid'],
  transport: ['slow', 'timeout', 'down', 'rate_limit'],
} as const;
export const AUTH_ACTIONS: string[] = Object.values(AUTH_ACTION_GROUPS).flat();

export interface AuthRule {
  id: string;
  projectId: string;
  providerId: string;
  testUserId: string | null;
  stage: AuthStage;
  action: string;
  params: Record<string, unknown>;
  position: number;
  remainingCount: number | null;
  skipCount: number;
  expiresAt: string | null;
  label: string | null;
  hits: number;
  enabled: boolean;
  createdAt: string;
  active: boolean;
}

interface RuleRow {
  id: string;
  project_id: string;
  auth_provider_id: string;
  test_user_id: string | null;
  stage: AuthStage;
  action: string;
  params: string;
  position: number;
  remaining_count: number | null;
  skip_count: number;
  expires_at: string | null;
  label: string | null;
  hits: number;
  enabled: number;
  created_at: string;
}

const toRule = (r: RuleRow): AuthRule => {
  const expired = !!r.expires_at && r.expires_at <= nowIso();
  return {
    id: r.id,
    projectId: r.project_id,
    providerId: r.auth_provider_id,
    testUserId: r.test_user_id,
    stage: r.stage,
    action: r.action,
    params: parseJson(r.params, {}),
    position: r.position,
    remainingCount: r.remaining_count,
    skipCount: r.skip_count,
    expiresAt: r.expires_at,
    label: r.label,
    hits: r.hits,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    active: r.enabled === 1 && !expired && (r.remaining_count === null || r.remaining_count > 0),
  };
};

export interface AuthRuleInput {
  action: string;
  stage?: string;
  params?: Record<string, unknown>;
  /** Shorthands copied into params. */
  delayMs?: number;
  ttl?: number;
  count?: number | null;
  minutes?: number | null;
  until?: string | null;
  after?: number | null;
  label?: string | null;
  enabled?: boolean;
}

export class AuthRepo {
  constructor(private db: DB) {}

  // ---------- providers ----------
  listProviders(projectId: string): AuthProvider[] {
    return (this.db.prepare('SELECT * FROM auth_providers WHERE project_id = ? ORDER BY created_at').all(projectId) as ProviderRow[]).map(toProvider);
  }

  getProvider(projectId: string, slugOrId: string): AuthProvider | null {
    const r = this.db.prepare('SELECT * FROM auth_providers WHERE project_id = ? AND (slug = ? OR id = ?)').get(projectId, slugOrId.toLowerCase(), slugOrId) as ProviderRow | undefined;
    return r ? toProvider(r) : null;
  }

  requireProvider(projectId: string, slugOrId: string): AuthProvider {
    const p = this.getProvider(projectId, slugOrId);
    if (!p) throw new HttpError(404, `Login provider "${slugOrId}" not found`);
    return p;
  }

  createProvider(projectId: string, input: { preset: string; slug?: string | null; name: string; config?: AuthProviderConfig; enabled?: boolean }): AuthProvider {
    const slug = (input.slug ? String(input.slug).trim().toLowerCase() : slugify(input.preset)) || 'login';
    if (!SLUG_RE.test(slug)) throw new HttpError(400, `Invalid slug "${slug}" (lower-case letters, digits and dashes)`);
    if (slug === '__hub') throw new HttpError(400, 'Slug "__hub" is reserved');
    if (this.getProvider(projectId, slug)) throw new HttpError(409, `A login provider with slug "${slug}" already exists`);
    const id = newId();
    const now = nowIso();
    this.db
      .prepare('INSERT INTO auth_providers (id, project_id, slug, name, preset, config, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, slug, input.name, input.preset, JSON.stringify(input.config ?? {}), input.enabled === false ? 0 : 1, now, now);
    return this.getProvider(projectId, id)!;
  }

  updateProvider(p: AuthProvider, patch: { name?: string; slug?: string; config?: AuthProviderConfig; enabled?: boolean }): AuthProvider {
    let slug = p.slug;
    if (patch.slug !== undefined && patch.slug !== p.slug) {
      slug = String(patch.slug).trim().toLowerCase();
      if (!SLUG_RE.test(slug) || slug === '__hub') throw new HttpError(400, `Invalid slug "${slug}"`);
      if (this.getProvider(p.projectId, slug)) throw new HttpError(409, `A login provider with slug "${slug}" already exists`);
    }
    const config = patch.config !== undefined ? patch.config : p.config;
    this.db
      .prepare('UPDATE auth_providers SET name = ?, slug = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? p.name, slug, JSON.stringify(config), (patch.enabled ?? p.enabled) ? 1 : 0, nowIso(), p.id);
    return this.getProvider(p.projectId, p.id)!;
  }

  deleteProvider(p: AuthProvider): void {
    this.db.prepare('DELETE FROM auth_providers WHERE id = ?').run(p.id);
  }

  // ---------- keys ----------
  listKeys(providerId: string): AuthKey[] {
    return (this.db.prepare("SELECT * FROM auth_keys WHERE auth_provider_id = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC").all(providerId) as KeyRow[]).map(toKey);
  }

  activeKey(providerId: string): AuthKey | null {
    const r = this.db.prepare("SELECT * FROM auth_keys WHERE auth_provider_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(providerId) as KeyRow | undefined;
    return r ? toKey(r) : null;
  }

  insertKey(providerId: string, k: { kid: string; alg?: string; privatePem: string; publicJwk: unknown; certPem?: string | null; status?: 'active' | 'retired'; createdAt?: string; retiredAt?: string | null }): AuthKey {
    const id = newId();
    this.db
      .prepare('INSERT INTO auth_keys (id, auth_provider_id, kid, alg, private_pem, public_jwk, cert_pem, status, created_at, retired_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, providerId, k.kid, k.alg ?? 'RS256', k.privatePem, JSON.stringify(k.publicJwk), k.certPem ?? null, k.status ?? 'active', k.createdAt ?? nowIso(), k.retiredAt ?? null);
    return toKey(this.db.prepare('SELECT * FROM auth_keys WHERE id = ?').get(id) as KeyRow);
  }

  retireKeys(providerId: string, drop: boolean): number {
    if (drop) return this.db.prepare('DELETE FROM auth_keys WHERE auth_provider_id = ?').run(providerId).changes;
    return this.db.prepare("UPDATE auth_keys SET status = 'retired', retired_at = ? WHERE auth_provider_id = ? AND status = 'active'").run(nowIso(), providerId).changes;
  }

  // ---------- identities ----------
  getIdentity(providerId: string, testUserId: string): AuthIdentity | null {
    const r = this.db.prepare('SELECT * FROM auth_identities WHERE auth_provider_id = ? AND test_user_id = ?').get(providerId, testUserId) as IdentityRow | undefined;
    return r ? toIdentity(r) : null;
  }

  identityBySub(providerId: string, sub: string): AuthIdentity | null {
    const r = this.db.prepare('SELECT * FROM auth_identities WHERE auth_provider_id = ? AND sub = ?').get(providerId, sub) as IdentityRow | undefined;
    return r ? toIdentity(r) : null;
  }

  listIdentities(providerId: string): AuthIdentity[] {
    return (this.db.prepare('SELECT * FROM auth_identities WHERE auth_provider_id = ? ORDER BY created_at').all(providerId) as IdentityRow[]).map(toIdentity);
  }

  insertIdentity(providerId: string, testUserId: string, sub: string, claims: Record<string, unknown> = {}, consented = false): AuthIdentity {
    if (this.identityBySub(providerId, sub)) throw new HttpError(409, `Another user already has sub "${sub}" at this provider`);
    this.db
      .prepare('INSERT INTO auth_identities (id, auth_provider_id, test_user_id, sub, claims, consented, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId(), providerId, testUserId, sub, JSON.stringify(claims), consented ? 1 : 0, nowIso());
    return this.getIdentity(providerId, testUserId)!;
  }

  updateIdentity(i: AuthIdentity, patch: { sub?: string; claims?: Record<string, unknown>; consented?: boolean }): AuthIdentity {
    if (patch.sub !== undefined && patch.sub !== i.sub) {
      const other = this.identityBySub(i.providerId, patch.sub);
      if (other && other.id !== i.id) throw new HttpError(409, `Another user already has sub "${patch.sub}" at this provider`);
    }
    this.db
      .prepare('UPDATE auth_identities SET sub = ?, claims = ?, consented = ? WHERE id = ?')
      .run(patch.sub ?? i.sub, JSON.stringify(patch.claims ?? i.claims), (patch.consented ?? i.consented) ? 1 : 0, i.id);
    return this.getIdentity(i.providerId, i.testUserId)!;
  }

  // ---------- grants ----------
  createGrant(g: GrantInput): AuthGrant {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO auth_grants (id, project_id, auth_provider_id, test_user_id, kind, token, client_id, redirect_uri, scope, nonce,
           code_challenge, code_challenge_method, family_id, parent_id, status, params, log_id, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
      )
      .run(
        id, g.projectId, g.providerId, g.testUserId ?? null, g.kind, g.token, g.clientId ?? null, g.redirectUri ?? null, g.scope ?? null, g.nonce ?? null,
        g.codeChallenge ?? null, g.codeChallengeMethod ?? null, g.familyId ?? id, g.parentId ?? null, JSON.stringify(g.params ?? {}), g.logId ?? null, nowIso(), g.expiresAt ?? null,
      );
    return this.grantById(id)!;
  }

  grantById(id: string): AuthGrant | null {
    const r = this.db.prepare('SELECT * FROM auth_grants WHERE id = ?').get(id) as GrantRow | undefined;
    return r ? toGrant(r) : null;
  }

  grantByToken(providerId: string, token: string, kind?: GrantKind | GrantKind[]): AuthGrant | null {
    const r = this.db.prepare('SELECT * FROM auth_grants WHERE token = ? AND auth_provider_id = ?').get(token, providerId) as GrantRow | undefined;
    if (!r) return null;
    const kinds = kind === undefined ? null : Array.isArray(kind) ? kind : [kind];
    return kinds && !kinds.includes(r.kind) ? null : toGrant(r);
  }

  /** Atomically mark a grant used. Returns false if it was not active any more (lost a race / reused). */
  markUsed(id: string): boolean {
    return this.db.prepare("UPDATE auth_grants SET status = 'used', used_at = ? WHERE id = ? AND status = 'active'").run(nowIso(), id).changes === 1;
  }

  revoke(id: string): void {
    this.db.prepare("UPDATE auth_grants SET status = 'revoked' WHERE id = ?").run(id);
  }

  /** Revoke every grant of a family (the code and all tokens derived from it). */
  revokeFamily(familyId: string): number {
    return this.db.prepare("UPDATE auth_grants SET status = 'revoked' WHERE family_id = ? AND status != 'revoked'").run(familyId).changes;
  }

  /** End every live SSO session of the given providers (test users see the picker again); only one test user's with `testUserId`. */
  revokeSessions(providerIds: string[], testUserId?: string): number {
    if (!providerIds.length) return 0;
    const now = nowIso();
    const live = "auth_provider_id = ? AND kind = 'session' AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)";
    const stmt = testUserId
      ? this.db.prepare(`UPDATE auth_grants SET status = 'revoked' WHERE ${live} AND test_user_id = ?`)
      : this.db.prepare(`UPDATE auth_grants SET status = 'revoked' WHERE ${live}`);
    return providerIds.reduce((n, id) => n + (testUserId ? stmt.run(id, now, testUserId) : stmt.run(id, now)).changes, 0);
  }

  /** Live SSO sessions of a provider, newest first. */
  listSessions(providerId: string): AuthGrant[] {
    return (
      this.db
        .prepare("SELECT * FROM auth_grants WHERE auth_provider_id = ? AND kind = 'session' AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC, rowid DESC")
        .all(providerId, nowIso()) as GrantRow[]
    ).map(toGrant);
  }

  /** Number of test users with a live SSO session at a provider. */
  countSignedIn(providerId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(DISTINCT test_user_id) AS n FROM auth_grants WHERE auth_provider_id = ? AND kind = 'session' AND status = 'active' AND test_user_id IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)")
      .get(providerId, nowIso()) as { n: number };
    return r.n;
  }

  listGrants(providerId: string, kind: GrantKind, limit = 50): AuthGrant[] {
    return (this.db.prepare('SELECT * FROM auth_grants WHERE auth_provider_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?').all(providerId, kind, limit) as GrantRow[]).map(toGrant);
  }

  /** Retention: grants past their expiry (plus a grace period so reuse detection still works for a while). */
  purgeExpired(now = Date.now(), graceMs = 24 * 3600_000): number {
    const cutoff = new Date(now - graceMs).toISOString();
    return this.db.prepare('DELETE FROM auth_grants WHERE expires_at IS NOT NULL AND expires_at < ?').run(cutoff).changes;
  }

  // ---------- rules ----------
  listRules(providerId: string, testUserId: string | null): AuthRule[] {
    const rows = testUserId
      ? this.db.prepare('SELECT * FROM auth_rules WHERE auth_provider_id = ? AND test_user_id = ? ORDER BY position, created_at').all(providerId, testUserId)
      : this.db.prepare('SELECT * FROM auth_rules WHERE auth_provider_id = ? AND test_user_id IS NULL ORDER BY position, created_at').all(providerId);
    return (rows as RuleRow[]).map(toRule);
  }

  allRules(providerId: string): AuthRule[] {
    return (this.db.prepare('SELECT * FROM auth_rules WHERE auth_provider_id = ? ORDER BY test_user_id IS NOT NULL, position, created_at').all(providerId) as RuleRow[]).map(toRule);
  }

  getRule(id: string): AuthRule | null {
    const r = this.db.prepare('SELECT * FROM auth_rules WHERE id = ?').get(id) as RuleRow | undefined;
    return r ? toRule(r) : null;
  }

  addRule(p: AuthProvider, testUserId: string | null, input: AuthRuleInput): AuthRule {
    const v = validateRule(input);
    const pos =
      ((testUserId
        ? this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM auth_rules WHERE auth_provider_id = ? AND test_user_id = ?').get(p.id, testUserId)
        : this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM auth_rules WHERE auth_provider_id = ? AND test_user_id IS NULL').get(p.id)) as { m: number }).m + 1;
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO auth_rules (id, project_id, auth_provider_id, test_user_id, stage, action, params, position, remaining_count, skip_count, expires_at, label, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, p.projectId, p.id, testUserId, v.stage, v.action, JSON.stringify(v.params), pos, v.remainingCount, v.skipCount, v.expiresAt, v.label, v.enabled ? 1 : 0, nowIso());
    return this.getRule(id)!;
  }

  replaceRules(p: AuthProvider, testUserId: string | null, inputs: AuthRuleInput[]): AuthRule[] {
    return this.db.transaction(() => {
      this.clearRules(p.id, testUserId);
      for (const i of inputs) this.addRule(p, testUserId, i);
      return this.listRules(p.id, testUserId);
    })();
  }

  clearRules(providerId: string, testUserId: string | null | 'all'): number {
    if (testUserId === 'all') return this.db.prepare('DELETE FROM auth_rules WHERE auth_provider_id = ?').run(providerId).changes;
    return testUserId
      ? this.db.prepare('DELETE FROM auth_rules WHERE auth_provider_id = ? AND test_user_id = ?').run(providerId, testUserId).changes
      : this.db.prepare('DELETE FROM auth_rules WHERE auth_provider_id = ? AND test_user_id IS NULL').run(providerId).changes;
  }

  updateRule(id: string, patch: { enabled?: boolean; label?: string | null }): AuthRule {
    const r = this.getRule(id);
    if (!r) throw new HttpError(404, `Rule "${id}" not found`);
    if (patch.enabled !== undefined) this.db.prepare('UPDATE auth_rules SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.label !== undefined) this.db.prepare('UPDATE auth_rules SET label = ? WHERE id = ?').run(patch.label, id);
    return this.getRule(id)!;
  }

  deleteRule(id: string): AuthRule {
    const r = this.getRule(id);
    if (!r) throw new HttpError(404, `Rule "${id}" not found`);
    this.db.prepare('DELETE FROM auth_rules WHERE id = ?').run(id);
    return r;
  }

  consumeRule(id: string): void {
    this.db
      .prepare(
        `UPDATE auth_rules SET hits = hits + 1,
           remaining_count = CASE WHEN remaining_count IS NULL THEN NULL ELSE remaining_count - 1 END,
           enabled = CASE WHEN remaining_count IS NOT NULL AND remaining_count - 1 <= 0 THEN 0 ELSE enabled END
         WHERE id = ?`,
      )
      .run(id);
  }

  skipRule(id: string): void {
    this.db.prepare('UPDATE auth_rules SET skip_count = MAX(skip_count - 1, 0) WHERE id = ?').run(id);
  }
}

function validateRule(i: AuthRuleInput) {
  const action = String(i.action ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (!AUTH_ACTIONS.includes(action)) throw new HttpError(400, `Unknown login scenario "${i.action}". Use one of: ${AUTH_ACTIONS.join(', ')}`);
  const stage = String(i.stage ?? 'any').toLowerCase() as AuthStage;
  if (!AUTH_STAGES.includes(stage)) throw new HttpError(400, `Unknown stage "${i.stage}". Use one of: ${AUTH_STAGES.join(', ')}`);
  const params: Record<string, unknown> = { ...(i.params && typeof i.params === 'object' ? i.params : {}) };
  if (i.delayMs !== undefined) params.delayMs = Number(i.delayMs);
  if (i.ttl !== undefined) params.ttl = Number(i.ttl);
  if (action === 'slow' && !(Number(params.delayMs) >= 0)) throw new HttpError(400, '"slow" needs delayMs');
  if (Number(params.delayMs) > 600_000) throw new HttpError(400, 'delayMs can be at most 600000');
  if (action === 'short_lived' && params.ttl === undefined) params.ttl = 5;
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  const count = num(i.count);
  if (count !== null && !(count >= 1)) throw new HttpError(400, 'count must be at least 1 (omit it for "always")');
  let expiresAt: string | null = null;
  const minutes = num(i.minutes);
  if (minutes !== null) {
    if (!(minutes > 0)) throw new HttpError(400, 'minutes must be positive');
    expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  } else if (i.until) {
    const d = new Date(i.until);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid "until" time "${i.until}"`);
    expiresAt = d.toISOString();
  }
  return {
    action,
    stage,
    params,
    remainingCount: count === null ? null : Math.floor(count),
    skipCount: Math.max(0, Math.floor(num(i.after) ?? 0)),
    expiresAt,
    label: i.label ? String(i.label) : null,
    enabled: i.enabled !== false,
  };
}
