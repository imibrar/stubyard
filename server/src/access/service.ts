import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { HttpError, newId } from '../util.js';
import { LoginLimiter } from './limiter.js';
import { safeEqual, sha256, verifyPassword } from './password.js';
import { allows, type Permission } from './permissions.js';
import type { AuthStore, SessionRecord, TokenRecord } from './store.js';

/** "open": no sign-in (default). "single": one admin from the environment (T1). T2 adds "teams". */
export type AuthMode = 'open' | 'single';

/** The signed-in account as the API shows it. */
export interface AuthUser {
  /** Stable key of the account ("admin:<email>" for the env admin). */
  id: string;
  email: string;
  name: string;
  /** Instance role; in Single admin mode always "admin". */
  role: 'admin';
}

/** Who is making a request. */
export type Principal =
  | { kind: 'session'; user: AuthUser; sessionId: string; csrf: string }
  | { kind: 'token'; user: AuthUser; tokenId: string }
  /** app.inject() calls made by stubyard itself (MCP tools, scheduled actions, chat tools), and the MCP tester's self target. */
  | { kind: 'internal'; user: null };

export interface TokenView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}

/** Prefix of personal API tokens ("sy_" + 43 base64url characters = 256 random bits). */
export const TOKEN_PREFIX = 'sy_';
/** How many characters of a token the lists show. */
const SHOWN = TOKEN_PREFIX.length + 8;
const MAX_ACTIVE_TOKENS = 100;
/** last_seen / last_used are written at most this often per session / token. */
const TOUCH_MS = 60_000;

export const SESSION_COOKIE = 'stubyard_session';
/** With Secure on, the cookie gets the __Host- prefix (no Domain, Path=/, Secure: it cannot be set by a subdomain). */
export const SECURE_SESSION_COOKIE = '__Host-stubyard_session';
export const CSRF_HEADER = 'x-stubyard-csrf';

const nowIso = (ms: number) => new Date(ms).toISOString();

/**
 * Sign-in for the dashboard, the API, /mcp and the extension (docs/GUIDE.md "Sign-in (single admin)"). Open mode has
 * no accounts and every method that needs one throws 404. Sessions and tokens are kept in an AuthStore.
 */
export class AccessService {
  readonly mode: AuthMode;
  readonly limiter: LoginLimiter;
  private readonly adminUser: AuthUser | null;
  private readonly cred: string;
  /** Bearer secret of stubyard's own HTTP calls to itself (MCP tester "this server"); accepted from loopback only. */
  private readonly selfSecret = `syi_${randomBytes(32).toString('base64url')}`;

  constructor(
    private config: Config,
    readonly store: AuthStore,
    private now: () => number = Date.now,
  ) {
    const admin = config.admin;
    this.mode = admin ? 'single' : 'open';
    this.limiter = new LoginLimiter(5, 15 * 60_000, now);
    this.adminUser = admin ? { id: `admin:${admin.email}`, email: admin.email, name: 'Admin', role: 'admin' } : null;
    this.cred = admin ? sha256(`cred:${admin.email}:${admin.passwordHash}`).slice(0, 32) : '';
  }

  get enabled(): boolean {
    return this.mode !== 'open';
  }

  get cookieName(): string {
    return this.config.cookieSecure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  }

  private requireEnabled(): AuthUser {
    if (!this.adminUser) throw new HttpError(404, 'Sign-in is not enabled on this stubyard (Open mode). Set STUBYARD_ADMIN_EMAIL and STUBYARD_ADMIN_PASSWORD to turn it on.');
    return this.adminUser;
  }

  /** The account for a user key, or null when it no longer exists (e.g. the admin e-mail changed). */
  private userOf(userKey: string): AuthUser | null {
    return this.adminUser && userKey === this.adminUser.id ? this.adminUser : null;
  }

  // ------------------------------------------------------------------ sign-in

  /**
   * Checks e-mail + password (rate-limited per e-mail + IP) and opens a session. Returns the cookie token (only its
   * hash is stored) and the session. Throws 401 for wrong credentials, 429 when blocked.
   */
  async login(email: unknown, password: unknown, meta: { ip: string; userAgent: string }): Promise<{ token: string; session: SessionRecord; user: AuthUser }> {
    const admin = this.requireEnabled();
    const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const p = typeof password === 'string' ? password : '';
    if (!e || !p || e.length > 320 || p.length > 1024) throw new HttpError(400, 'Send { "email": "…", "password": "…" }');
    const wait = this.limiter.retryAfter(e, meta.ip);
    if (wait > 0) throw Object.assign(new HttpError(429, `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`), { retryAfter: wait });
    // Always run scrypt, also for an unknown e-mail (no timing difference between the two).
    const passwordOk = verifyPassword(p, this.config.admin!.passwordHash);
    const emailOk = safeEqual(e, admin.email);
    if (!(passwordOk && emailOk)) {
      this.limiter.fail(e, meta.ip);
      throw new HttpError(401, 'Wrong e-mail or password');
    }
    this.limiter.succeed(e, meta.ip);
    const now = this.now();
    await this.store.purgeExpiredSessions(nowIso(now));
    const token = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      id: sha256(token),
      userKey: admin.id,
      cred: this.cred,
      csrf: randomBytes(24).toString('base64url'),
      createdAt: nowIso(now),
      expiresAt: nowIso(now + this.config.sessionTtlHours * 3600_000),
      lastSeenAt: nowIso(now),
      userAgent: meta.userAgent.slice(0, 300),
      ip: meta.ip.slice(0, 100),
    };
    await this.store.createSession(session);
    return { token, session, user: admin };
  }

  async logout(sessionId: string): Promise<void> {
    await this.store.deleteSession(sessionId);
  }

  /** The principal of a session cookie value, or null (unknown, expired, or signed in with an older password). */
  async sessionPrincipal(cookieToken: string): Promise<Extract<Principal, { kind: 'session' }> | null> {
    if (!this.enabled || !cookieToken || cookieToken.length > 200) return null;
    const s = await this.store.getSession(sha256(cookieToken));
    if (!s) return null;
    const now = this.now();
    const user = this.userOf(s.userKey);
    if (!user || !safeEqual(s.cred, this.cred) || Date.parse(s.expiresAt) <= now) {
      await this.store.deleteSession(s.id);
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) > TOUCH_MS) await this.store.touchSession(s.id, nowIso(now));
    return { kind: 'session', user, sessionId: s.id, csrf: s.csrf };
  }

  /**
   * The principal of an Authorization: Bearer value: a personal API token, or the self secret from a loopback address.
   * null when it is not valid (unknown, revoked, expired).
   */
  async bearerPrincipal(token: string, remoteAddress: string | undefined): Promise<Principal | null> {
    if (!this.enabled || !token || token.length > 200) return null;
    if (token.startsWith('syi_')) return safeEqual(token, this.selfSecret) && isLoopback(remoteAddress) ? { kind: 'internal', user: null } : null;
    const t = await this.store.getTokenByHash(sha256(token));
    if (!t || t.revokedAt) return null;
    const now = this.now();
    if (t.expiresAt && Date.parse(t.expiresAt) <= now) return null;
    const user = this.userOf(t.userKey);
    if (!user) return null;
    if (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > TOUCH_MS) await this.store.touchToken(t.id, nowIso(now));
    return { kind: 'token', user, tokenId: t.id };
  }

  /** Headers for stubyard's own HTTP calls to its /mcp (none in Open mode). Never store or show them. */
  selfAuthHeaders(): Record<string, string> {
    return this.enabled ? { authorization: `Bearer ${this.selfSecret}` } : {};
  }

  /** Whether the principal holds the permission. In Single admin mode the only account is the admin: all of them. */
  allows(principal: Principal, permission: Permission): boolean {
    return allows(principal.kind === 'internal' ? 'internal' : principal.user.role, permission);
  }

  // ------------------------------------------------------------------ API tokens

  async listTokens(user: AuthUser): Promise<TokenView[]> {
    return (await this.store.listTokens(user.id)).map((t) => this.tokenView(t));
  }

  /** A new token; the secret is returned this once and only its hash is kept. */
  async createToken(user: AuthUser, input: { name?: unknown; expiresInDays?: unknown }): Promise<{ token: TokenView; secret: string }> {
    this.requireEnabled();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw new HttpError(400, 'name is required (1–80 characters), e.g. "Chrome extension" or "Claude Code"');
    let expiresAt: string | null = null;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== '') {
      const d = Number(input.expiresInDays);
      if (!Number.isInteger(d) || d < 1 || d > 3650) throw new HttpError(400, 'expiresInDays must be a whole number of days from 1 to 3650 (or null for no expiry)');
      expiresAt = nowIso(this.now() + d * 86_400_000);
    }
    const active = (await this.store.listTokens(user.id)).filter((t) => this.tokenView(t).status === 'active');
    if (active.length >= MAX_ACTIVE_TOKENS) throw new HttpError(409, `You have ${MAX_ACTIVE_TOKENS} active tokens; revoke some first`);
    const secret = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const rec: TokenRecord = {
      id: `tok_${newId()}`,
      userKey: user.id,
      name,
      tokenHash: sha256(secret),
      prefix: secret.slice(0, SHOWN),
      createdAt: nowIso(this.now()),
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    };
    await this.store.createToken(rec);
    return { token: this.tokenView(rec), secret };
  }

  async revokeToken(user: AuthUser, id: string): Promise<TokenView> {
    const t = await this.store.getToken(id);
    if (!t || t.userKey !== user.id) throw new HttpError(404, `API token "${id}" not found`);
    await this.store.revokeToken(t.id, nowIso(this.now()));
    return this.tokenView((await this.store.getToken(id))!);
  }

  private tokenView(t: TokenRecord): TokenView {
    const status = t.revokedAt ? 'revoked' : t.expiresAt && Date.parse(t.expiresAt) <= this.now() ? 'expired' : 'active';
    return { id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt, status };
  }
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

/**
 * Startup warnings for Single admin mode: sign-in over plain HTTP to another machine sends the password and the session
 * cookie in clear text.
 */
export function authWarnings(config: Config): string[] {
  if (!config.admin) return [];
  const out: string[] = [];
  const local = (h: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(h) || h.endsWith('.localhost');
  if (config.publicUrl) {
    try {
      const u = new URL(config.publicUrl);
      if (u.protocol === 'http:' && !local(u.hostname)) out.push(`Sign-in is on but STUBYARD_PUBLIC_URL (${config.publicUrl}) is plain HTTP to another machine: passwords and session cookies travel unencrypted. Use https:// (the HTTPS port ${config.httpsPort}) or a TLS proxy.`);
    } catch {
      /* invalid URL: reported elsewhere */
    }
  }
  const remoteNames = config.allowedHosts.filter((h) => h !== '*' && !local(h.toLowerCase()));
  if (!config.publicUrl && remoteNames.length) out.push(`Sign-in is on and STUBYARD_ALLOWED_HOSTS lets other machines in (${remoteNames.join(', ')}), but STUBYARD_PUBLIC_URL is not set to an https:// address: over plain HTTP, passwords and session cookies travel unencrypted.`);
  if (config.publicUrl?.startsWith('https:') && !config.cookieSecure) out.push('STUBYARD_COOKIE_SECURE=0 with an https:// public URL: the session cookie may also be sent over plain HTTP.');
  return out;
}
