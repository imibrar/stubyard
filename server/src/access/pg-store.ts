import pg from 'pg';
import type { AuthStore, SessionRecord, TokenRecord } from './store.js';

/**
 * Teams mode storage (docs/GUIDE.md "Teams"): identity and access data in Postgres, schema "stubyard". Project data
 * stays in SQLite; project_members links to a project by its slug (the delete hook keeps it in step).
 *
 * Its own migration list (PG_MIGRATIONS, table stubyard.schema_migrations), applied at start under an advisory lock so
 * two stubyard processes on one database cannot race. Timestamps are timestamptz and cross this interface as ISO
 * strings, like the SQLite store. Secrets are never stored: sessions.id, api_tokens.token_hash and invites.token_hash
 * are sha256 hashes, passwords are scrypt hashes.
 */

export const PG_SCHEMA = 'stubyard';

export const PROJECT_ROLES = ['project_admin', 'project_manager', 'developer', 'designer', 'qa', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export type InstanceRole = 'admin' | 'member';

export const PG_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  instance_role TEXT NOT NULL DEFAULT 'member' CHECK (instance_role IN ('admin','member')),
  disabled BOOLEAN NOT NULL DEFAULT false,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  env_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ);
CREATE UNIQUE INDEX users_email ON users (lower(email));

CREATE TABLE project_members (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('project_admin','project_manager','developer','designer','qa','viewer')),
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, project_slug));
CREATE INDEX project_members_slug ON project_members (project_slug);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cred TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '');
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope_projects TEXT[],
  scope_max_role TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ);
CREATE INDEX api_tokens_user ON api_tokens (user_id, created_at);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  instance_role TEXT NOT NULL DEFAULT 'member' CHECK (instance_role IN ('admin','member')),
  project_slug TEXT,
  role TEXT CHECK (role IS NULL OR role IN ('project_admin','project_manager','developer','designer','qa','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by TEXT,
  revoked_at TIMESTAMPTZ);
CREATE INDEX invites_project ON invites (project_slug) WHERE project_slug IS NOT NULL;

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  project_slug TEXT,
  target TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_user ON audit_log (user_id, at DESC);
CREATE INDEX audit_log_project ON audit_log (project_slug, at DESC);
`,
  },
];

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  role: InstanceRole;
  disabled: boolean;
  mustChangePassword: boolean;
  /** The admin from STUBYARD_ADMIN_EMAIL: signs in with the env password, cannot be disabled or demoted. */
  envAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface MemberRecord {
  userId: string;
  projectSlug: string;
  role: ProjectRole;
  addedBy: string | null;
  addedAt: string;
}

export interface InviteRecord {
  id: string;
  email: string | null;
  name: string | null;
  role: InstanceRole;
  projectSlug: string | null;
  projectRole: ProjectRole | null;
  tokenHash: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
}

export interface AuditRecord {
  userId: string | null;
  userEmail: string | null;
  action: string;
  projectSlug?: string | null;
  target?: string | null;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditEntry extends AuditRecord {
  id: number;
  at: string;
}

/** GET /api/audit filters (all optional). */
export interface AuditFilter {
  /** A user id or e-mail (case-insensitive). */
  user?: string | null;
  /** A project slug. */
  project?: string | null;
  /** Exact actions, or prefixes ending in "." (e.g. "member."). Any of them matches. */
  actions?: string[];
  /** ISO times: from (inclusive) and to (exclusive). */
  from?: string | null;
  to?: string | null;
  /** Free text in action, target, e-mail, project, address or details (case-insensitive). */
  text?: string | null;
  /** The id of the last row of the previous page. */
  before?: number | null;
  limit?: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function toAudit(r: Row): AuditEntry {
  return { id: Number(r.id), at: iso(r.at), userId: r.user_id, userEmail: r.user_email, action: r.action, projectSlug: r.project_slug, target: r.target, detail: r.detail ?? {}, ip: r.ip };
}

export interface PgHealth {
  ok: boolean;
  latencyMs?: number;
  serverVersion?: string;
  schemaVersion?: number;
  error?: string;
}

type Row = Record<string, any>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toUser = (r: Row): UserRecord => ({
  id: r.id,
  email: r.email,
  name: r.name,
  passwordHash: r.password_hash,
  role: r.instance_role,
  disabled: r.disabled,
  mustChangePassword: r.must_change_password,
  envAdmin: r.env_admin,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  lastLoginAt: isoOrNull(r.last_login_at),
});

const toMember = (r: Row): MemberRecord => ({ userId: r.user_id, projectSlug: r.project_slug, role: r.role, addedBy: r.added_by, addedAt: iso(r.added_at) });

const toSession = (r: Row): SessionRecord => ({
  id: r.id,
  userKey: r.user_id,
  cred: r.cred,
  csrf: r.csrf,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  lastSeenAt: iso(r.last_seen_at),
  userAgent: r.user_agent,
  ip: r.ip,
});

const toToken = (r: Row): TokenRecord => ({
  id: r.id,
  userKey: r.user_id,
  name: r.name,
  tokenHash: r.token_hash,
  prefix: r.prefix,
  createdAt: iso(r.created_at),
  lastUsedAt: isoOrNull(r.last_used_at),
  expiresAt: isoOrNull(r.expires_at),
  revokedAt: isoOrNull(r.revoked_at),
  scopeProjects: r.scope_projects ?? null,
  scopeMaxRole: r.scope_max_role ?? null,
});

const toInvite = (r: Row): InviteRecord => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.instance_role,
  projectSlug: r.project_slug,
  projectRole: r.role,
  tokenHash: r.token_hash,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  acceptedAt: isoOrNull(r.accepted_at),
  acceptedBy: r.accepted_by,
  revokedAt: isoOrNull(r.revoked_at),
});

/** "postgres://user:***@host:5432/db" → "host:5432/db" (for messages; never the password). */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
  } catch {
    return '(unparsable URL)';
  }
}

/** A pg error message without anything that could carry the connection string. */
function pgMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e.code ? `${e.code}: ` : ''}${String(e.message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://…')}`;
}

export class PgAuthStore implements AuthStore {
  readonly pool: pg.Pool;
  private closed = false;

  constructor(
    readonly url: string,
    private log: { warn: (o: unknown, msg?: string) => void } = { warn: () => undefined },
  ) {
    // Every connection works in the stubyard schema, with a statement timeout so a stuck query cannot hang sign-in
    // (startup options: set before the first query, no extra round trip).
    this.pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: 'stubyard', options: `-c search_path=${PG_SCHEMA} -c statement_timeout=15000` });
    this.pool.on('error', (err) => this.log.warn({ err: pgMessage(err) }, 'Postgres connection error (idle client)'));
  }

  get target(): string {
    return describeDatabaseUrl(this.url);
  }

  /** Connects (retrying for up to `waitMs`, e.g. while a compose Postgres starts) and applies the migrations. */
  async init(waitMs = 30_000): Promise<{ applied: number[] }> {
    const until = Date.now() + waitMs;
    let lastErr: unknown;
    for (;;) {
      try {
        await this.pool.query('SELECT 1');
        break;
      } catch (err) {
        lastErr = err;
        if (Date.now() >= until) throw new Error(`Teams mode: cannot reach Postgres at ${this.target} (STUBYARD_DATABASE_URL): ${pgMessage(lastErr)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return this.migrate();
  }

  async migrate(): Promise<{ applied: number[] }> {
    const client = await this.pool.connect();
    const applied: number[] = [];
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stubyard.migrations'))");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${PG_SCHEMA}`);
      await client.query(`SET LOCAL search_path TO ${PG_SCHEMA}`);
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r: Row) => Number(r.version)));
      for (const m of PG_MIGRATIONS) {
        if (done.has(m.version)) continue;
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
        applied.push(m.version);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Teams mode: Postgres migration failed: ${pgMessage(err)}`);
    } finally {
      client.release();
    }
    return { applied };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end().catch(() => undefined);
  }

  async health(): Promise<PgHealth> {
    const t0 = Date.now();
    try {
      const v = await this.pool.query("SELECT current_setting('server_version') AS v, (SELECT max(version) FROM schema_migrations) AS s");
      return { ok: true, latencyMs: Date.now() - t0, serverVersion: String(v.rows[0].v), schemaVersion: Number(v.rows[0].s ?? 0) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: pgMessage(err) };
    }
  }

  private async q(sql: string, args: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, args)).rows;
  }

  /** Runs fn in one transaction. */
  async tx<T>(fn: (q: (sql: string, args?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(async (sql, args = []) => (await client.query(sql, args)).rows);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ AuthStore: sessions

  async createSession(s: SessionRecord): Promise<void> {
    await this.q('INSERT INTO sessions (id, user_id, cred, csrf, created_at, expires_at, last_seen_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      s.id, s.userKey, s.cred, s.csrf, s.createdAt, s.expiresAt, s.lastSeenAt, s.userAgent, s.ip,
    ]);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const r = await this.q('SELECT * FROM sessions WHERE id = $1', [id]);
    return r[0] ? toSession(r[0]) : null;
  }

  async touchSession(id: string, at: string): Promise<void> {
    await this.q('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [id, at]);
  }

  /** A password change keeps the session it was made from: its credential fingerprint moves with it. */
  async updateSessionCred(id: string, cred: string): Promise<void> {
    await this.q('UPDATE sessions SET cred = $2 WHERE id = $1', [id, cred]);
  }

  async deleteSession(id: string): Promise<void> {
    await this.q('DELETE FROM sessions WHERE id = $1', [id]);
  }

  async deleteSessionsOf(userKey: string, exceptId?: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userKey, exceptId ?? '']);
    return r.rowCount ?? 0;
  }

  async purgeExpiredSessions(now: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
    return r.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ AuthStore: API tokens

  async createToken(t: TokenRecord): Promise<void> {
    await this.q(
      'INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope_projects, scope_max_role, created_at, last_used_at, expires_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [t.id, t.userKey, t.name, t.tokenHash, t.prefix, t.scopeProjects ?? null, t.scopeMaxRole ?? null, t.createdAt, t.lastUsedAt, t.expiresAt, t.revokedAt],
    );
  }

  async getTokenByHash(tokenHash: string): Promise<TokenRecord | null> {
    const r = await this.q('SELECT * FROM api_tokens WHERE token_hash = $1', [tokenHash]);
    return r[0] ? toToken(r[0]) : null;
  }

  async getToken(id: string): Promise<TokenRecord | null> {
    const r = await this.q('SELECT * FROM api_tokens WHERE id = $1', [id]);
    return r[0] ? toToken(r[0]) : null;
  }

  async listTokens(userKey: string): Promise<TokenRecord[]> {
    return (await this.q('SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [userKey])).map(toToken);
  }

  async touchToken(id: string, at: string): Promise<void> {
    await this.q('UPDATE api_tokens SET last_used_at = $2 WHERE id = $1', [id, at]);
  }

  async revokeToken(id: string, at: string): Promise<void> {
    await this.q('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [id, at]);
  }

  async revokeTokensOf(userKey: string, at: string): Promise<number> {
    const r = await this.pool.query('UPDATE api_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [userKey, at]);
    return r.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ users

  async getUser(id: string): Promise<UserRecord | null> {
    const r = await this.q('SELECT * FROM users WHERE id = $1', [id]);
    return r[0] ? toUser(r[0]) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.q('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    return r[0] ? toUser(r[0]) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return (await this.q('SELECT * FROM users ORDER BY lower(email)')).map(toUser);
  }

  async createUser(u: { id: string; email: string; name: string; passwordHash: string | null; role: InstanceRole; mustChangePassword: boolean }, q = this.q.bind(this)): Promise<UserRecord> {
    const r = await q('INSERT INTO users (id, email, name, password_hash, instance_role, must_change_password) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [
      u.id, u.email, u.name, u.passwordHash, u.role, u.mustChangePassword,
    ]);
    return toUser(r[0]);
  }

  async updateUser(id: string, patch: { name?: string; role?: InstanceRole; disabled?: boolean; passwordHash?: string; mustChangePassword?: boolean; lastLoginAt?: string }): Promise<UserRecord | null> {
    const cols: Record<string, string> = { name: 'name', role: 'instance_role', disabled: 'disabled', passwordHash: 'password_hash', mustChangePassword: 'must_change_password', lastLoginAt: 'last_login_at' };
    const sets: string[] = [];
    const args: unknown[] = [id];
    for (const [k, col] of Object.entries(cols)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v === undefined) continue;
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    }
    if (patch.lastLoginAt === undefined) sets.push('updated_at = now()');
    if (!sets.length) return this.getUser(id);
    const r = await this.q(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, args);
    return r[0] ? toUser(r[0]) : null;
  }

  /**
   * The env admin (STUBYARD_ADMIN_EMAIL) as a user row: created or taken over by e-mail, always an enabled instance
   * admin with no stored password (it signs in with the env password). A previous env admin with another e-mail keeps
   * its row but loses the flag.
   */
  /**
   * Makes the STUBYARD_ADMIN_EMAIL account the env admin. When that e-mail changed, the previous env admin is demoted to
   * a member (it has no password of its own, so it cannot sign in) and loses its sessions and tokens.
   */
  async ensureEnvAdmin(email: string, newId: string): Promise<UserRecord & { demoted: { id: string; email: string }[] }> {
    return this.tx(async (q) => {
      const old = await q("UPDATE users SET env_admin = false, instance_role = 'member', updated_at = now() WHERE env_admin AND lower(email) <> lower($1) RETURNING id, email", [email]);
      for (const o of old) {
        await q('DELETE FROM sessions WHERE user_id = $1', [o.id]);
        await q('UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [o.id]);
      }
      const existing = await q('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
      const r = existing[0]
        ? await q("UPDATE users SET env_admin = true, instance_role = 'admin', disabled = false, must_change_password = false, password_hash = NULL, updated_at = now() WHERE id = $1 RETURNING *", [existing[0].id])
        : await q("INSERT INTO users (id, email, name, instance_role, env_admin) VALUES ($1, $2, 'Admin', 'admin', true) RETURNING *", [newId, email]);
      return { ...toUser(r[0]), demoted: old.map((o) => ({ id: String(o.id), email: String(o.email) })) };
    });
  }

  // ------------------------------------------------------------------ project members

  async membershipsOf(userId: string): Promise<MemberRecord[]> {
    return (await this.q('SELECT * FROM project_members WHERE user_id = $1 ORDER BY project_slug', [userId])).map(toMember);
  }

  async allMemberships(): Promise<MemberRecord[]> {
    return (await this.q('SELECT * FROM project_members ORDER BY project_slug')).map(toMember);
  }

  async membersOf(slug: string): Promise<(MemberRecord & { user: UserRecord })[]> {
    const rows = await this.q('SELECT m.*, u.id AS u_id, u.email, u.name, u.password_hash, u.instance_role, u.disabled, u.must_change_password, u.env_admin, u.created_at AS u_created_at, u.updated_at, u.last_login_at FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_slug = $1 ORDER BY lower(u.email)', [slug]);
    return rows.map((r) => ({ ...toMember(r), user: toUser({ ...r, id: r.u_id, created_at: r.u_created_at }) }));
  }

  async getMember(userId: string, slug: string): Promise<MemberRecord | null> {
    const r = await this.q('SELECT * FROM project_members WHERE user_id = $1 AND project_slug = $2', [userId, slug]);
    return r[0] ? toMember(r[0]) : null;
  }

  async setMember(userId: string, slug: string, role: ProjectRole, addedBy: string | null, q = this.q.bind(this)): Promise<MemberRecord> {
    const r = await q(
      'INSERT INTO project_members (user_id, project_slug, role, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, project_slug) DO UPDATE SET role = EXCLUDED.role RETURNING *',
      [userId, slug, role, addedBy],
    );
    return toMember(r[0]);
  }

  async removeMember(userId: string, slug: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM project_members WHERE user_id = $1 AND project_slug = $2', [userId, slug]);
    return (r.rowCount ?? 0) > 0;
  }

  /** A project was deleted: its memberships go, and pending invites no longer add anyone to it. */
  async forgetProject(slug: string): Promise<number> {
    return this.tx(async (q) => {
      const n = (await q('DELETE FROM project_members WHERE project_slug = $1 RETURNING user_id', [slug])).length;
      await q('UPDATE invites SET project_slug = NULL, role = NULL WHERE project_slug = $1 AND accepted_at IS NULL', [slug]);
      return n;
    });
  }

  /** A project's slug changed: memberships and pending invites follow it. */
  async renameProject(from: string, to: string): Promise<number> {
    return this.tx(async (q) => {
      const n = (await q('UPDATE project_members SET project_slug = $2 WHERE project_slug = $1 RETURNING user_id', [from, to])).length;
      await q('UPDATE invites SET project_slug = $2 WHERE project_slug = $1 AND accepted_at IS NULL', [from, to]);
      return n;
    });
  }

  /** Factory reset: every project is gone, so every membership goes (users stay). */
  async forgetAllProjects(): Promise<number> {
    return this.tx(async (q) => {
      const n = (await q('DELETE FROM project_members RETURNING user_id')).length;
      await q('UPDATE invites SET project_slug = NULL, role = NULL WHERE accepted_at IS NULL');
      return n;
    });
  }

  // ------------------------------------------------------------------ invites

  async createInvite(i: Omit<InviteRecord, 'createdAt' | 'acceptedAt' | 'acceptedBy' | 'revokedAt'>): Promise<InviteRecord> {
    const r = await this.q(
      'INSERT INTO invites (id, email, name, instance_role, project_slug, role, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [i.id, i.email, i.name, i.role, i.projectSlug, i.projectRole, i.tokenHash, i.createdBy, i.expiresAt],
    );
    return toInvite(r[0]);
  }

  async getInviteByHash(tokenHash: string): Promise<InviteRecord | null> {
    const r = await this.q('SELECT * FROM invites WHERE token_hash = $1', [tokenHash]);
    return r[0] ? toInvite(r[0]) : null;
  }

  async getInvite(id: string): Promise<InviteRecord | null> {
    const r = await this.q('SELECT * FROM invites WHERE id = $1', [id]);
    return r[0] ? toInvite(r[0]) : null;
  }

  async listInvites(): Promise<InviteRecord[]> {
    return (await this.q('SELECT * FROM invites ORDER BY created_at DESC LIMIT 500')).map(toInvite);
  }

  async revokeInvite(id: string): Promise<InviteRecord | null> {
    const r = await this.q('UPDATE invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *', [id]);
    return r[0] ? toInvite(r[0]) : this.getInvite(id);
  }

  /**
   * Accepts a pending invite in one transaction: claims it (single use, not expired, not revoked), creates the user and
   * the membership. Returns null when the invite is no longer pending; throws "email_taken" when the e-mail exists.
   */
  async acceptInvite(
    tokenHash: string,
    user: { id: string; email: string; name: string; passwordHash: string },
    projectExists: (slug: string) => boolean,
  ): Promise<{ invite: InviteRecord; user: UserRecord } | null> {
    return this.tx(async (q) => {
      const claimed = await q('UPDATE invites SET accepted_at = now(), accepted_by = $2 WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *', [tokenHash, user.id]);
      if (!claimed[0]) return null;
      const invite = toInvite(claimed[0]);
      if ((await q('SELECT 1 FROM users WHERE lower(email) = lower($1)', [user.email])).length) throw Object.assign(new Error('email_taken'), { code: 'email_taken' });
      const created = await this.createUser({ ...user, role: invite.role, mustChangePassword: false }, q);
      if (invite.projectSlug && invite.projectRole && projectExists(invite.projectSlug)) await this.setMember(created.id, invite.projectSlug, invite.projectRole, invite.createdBy, q);
      return { invite, user: created };
    });
  }

  // ------------------------------------------------------------------ audit log

  async audit(a: AuditRecord): Promise<void> {
    await this.q('INSERT INTO audit_log (user_id, user_email, action, project_slug, target, detail, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      a.userId, a.userEmail, a.action, a.projectSlug ?? null, a.target ?? null, JSON.stringify(a.detail ?? {}), a.ip ?? null,
    ]);
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    return (await this.queryAudit({ limit })).entries;
  }

  /**
   * Audit rows, newest first (by id), with filters. Paged by id: `before` is the last id of the previous page; the
   * answer's `nextBefore` is set when there may be more.
   */
  async queryAudit(f: AuditFilter): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
    const where: string[] = [];
    const args: unknown[] = [];
    const arg = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    if (f.before !== undefined && f.before !== null) where.push(`id < ${arg(f.before)}`);
    if (f.project !== undefined && f.project !== null) where.push(`project_slug = ${arg(f.project)}`);
    if (f.user) where.push(`(user_id = ${arg(f.user)} OR lower(user_email) = lower(${arg(f.user)}))`);
    if (f.actions?.length) {
      const parts = f.actions.map((a) => (a.endsWith('.') ? `action LIKE ${arg(likeEscape(a) + '%')}` : `action = ${arg(a)}`));
      where.push(`(${parts.join(' OR ')})`);
    }
    if (f.from) where.push(`at >= ${arg(f.from)}`);
    if (f.to) where.push(`at < ${arg(f.to)}`);
    if (f.text) {
      const p = arg('%' + likeEscape(f.text) + '%');
      where.push(`(action ILIKE ${p} OR target ILIKE ${p} OR user_email ILIKE ${p} OR project_slug ILIKE ${p} OR ip ILIKE ${p} OR detail::text ILIKE ${p})`);
    }
    const limit = Math.min(Math.max(1, Math.trunc(f.limit ?? 100)), 1000);
    const rows = await this.q(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${arg(limit + 1)}`, args);
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map(toAudit);
    return { entries, nextBefore: more && entries.length ? entries[entries.length - 1].id : null };
  }

  /** The distinct actions in the log (of one project, or all), sorted. */
  async auditActions(project: string | null): Promise<string[]> {
    const rows = project === null ? await this.q('SELECT DISTINCT action FROM audit_log ORDER BY action') : await this.q('SELECT DISTINCT action FROM audit_log WHERE project_slug = $1 ORDER BY action', [project]);
    return rows.map((r) => String(r.action));
  }

  /** Deletes audit rows older than the cutoff (retention). Returns the number deleted. */
  async pruneAudit(cutoffIso: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM audit_log WHERE at < $1', [cutoffIso]);
    return r.rowCount ?? 0;
  }
}
