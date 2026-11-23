import type { DB } from '../db/index.js';

/**
 * Where sessions and API tokens live. Single admin mode keeps them in SQLite (SqliteAuthStore, migration 29); Teams
 * mode (T2) will put users, sessions and tokens in Postgres behind this same interface, which is why every method is
 * async. Secrets are never stored: `id` of a session and `tokenHash` of a token are sha256 hashes.
 */
export interface AuthStore {
  createSession(s: SessionRecord): Promise<void>;
  /** The session with this id (sha256 of the cookie token), expired or not; null when unknown. */
  getSession(id: string): Promise<SessionRecord | null>;
  touchSession(id: string, at: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsOf(userKey: string): Promise<number>;
  /** Removes sessions that expired before `now`; returns how many. */
  purgeExpiredSessions(now: string): Promise<number>;

  createToken(t: TokenRecord): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<TokenRecord | null>;
  getToken(id: string): Promise<TokenRecord | null>;
  listTokens(userKey: string): Promise<TokenRecord[]>;
  touchToken(id: string, at: string): Promise<void>;
  revokeToken(id: string, at: string): Promise<void>;
}

export interface SessionRecord {
  id: string;
  userKey: string;
  /** Fingerprint of the credential at sign-in; a session whose cred no longer matches is dead. */
  cred: string;
  /** The per-session CSRF token the dashboard sends in X-Stubyard-CSRF. */
  csrf: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
}

export interface TokenRecord {
  id: string;
  userKey: string;
  name: string;
  tokenHash: string;
  /** The first characters of the token, shown in lists so people can tell their tokens apart. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Teams mode: the token only works on these project slugs (null: every project of its user). */
  scopeProjects?: string[] | null;
  /** Teams mode: the token never has more than this role's permissions (null: the user's own roles). */
  scopeMaxRole?: string | null;
}

interface SessionRow {
  id: string;
  user_key: string;
  cred: string;
  csrf: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string;
  ip: string;
}

interface TokenRow {
  id: string;
  user_key: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  userKey: r.user_key,
  cred: r.cred,
  csrf: r.csrf,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  userAgent: r.user_agent,
  ip: r.ip,
});

const toToken = (r: TokenRow): TokenRecord => ({
  id: r.id,
  userKey: r.user_key,
  name: r.name,
  tokenHash: r.token_hash,
  prefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
});

/** AuthStore on the hub's SQLite database (tables auth_sessions and api_tokens, migration 29). */
export class SqliteAuthStore implements AuthStore {
  constructor(private db: DB) {}

  async createSession(s: SessionRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO auth_sessions (id, user_key, cred, csrf, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(s.id, s.userKey, s.cred, s.csrf, s.createdAt, s.expiresAt, s.lastSeenAt, s.userAgent, s.ip);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const r = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? toSession(r) : null;
  }

  async touchSession(id: string, at: string): Promise<void> {
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  async deleteSession(id: string): Promise<void> {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
  }

  async deleteSessionsOf(userKey: string): Promise<number> {
    return this.db.prepare('DELETE FROM auth_sessions WHERE user_key = ?').run(userKey).changes;
  }

  async purgeExpiredSessions(now: string): Promise<number> {
    return this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;
  }

  async createToken(t: TokenRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO api_tokens (id, user_key, name, token_hash, prefix, created_at, last_used_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.userKey, t.name, t.tokenHash, t.prefix, t.createdAt, t.lastUsedAt, t.expiresAt, t.revokedAt);
  }

  async getTokenByHash(tokenHash: string): Promise<TokenRecord | null> {
    const r = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as TokenRow | undefined;
    return r ? toToken(r) : null;
  }

  async getToken(id: string): Promise<TokenRecord | null> {
    const r = this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow | undefined;
    return r ? toToken(r) : null;
  }

  async listTokens(userKey: string): Promise<TokenRecord[]> {
    return (this.db.prepare('SELECT * FROM api_tokens WHERE user_key = ? ORDER BY created_at DESC, id DESC').all(userKey) as unknown as TokenRow[]).map(toToken);
  }

  async touchToken(id: string, at: string): Promise<void> {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  async revokeToken(id: string, at: string): Promise<void> {
    this.db.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(at, id);
  }
}
