import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { HttpError, newId } from '../util.js';
import { LoginLimiter } from './limiter.js';
import { hashPassword, hashPasswordAsync, MIN_PASSWORD_LENGTH, safeEqual, sha256, verifyPasswordAsync } from './password.js';
import { allows, ROLE_PERMISSIONS, type Permission, type Role } from './permissions.js';
import type { AuthStore, SessionRecord, TokenRecord } from './store.js';
import { PROJECT_ROLES, type AuditEntry, type AuditFilter, type InviteRecord, type PgAuthStore, type PgHealth, type ProjectRole, type UserRecord } from './pg-store.js';

/** "open": no sign-in (default). "single": one admin from the environment (T1). "teams": users in Postgres (T2). */
export type AuthMode = 'open' | 'single' | 'teams';

/** The signed-in account as the API shows it. */
export interface AuthUser {
  /** Stable key of the account ("admin:<email>" for the env admin in Single admin mode, the users.id in Teams mode). */
  id: string;
  email: string;
  name: string;
  /** Instance role; in Single admin mode always "admin". */
  role: 'admin' | 'member';
  /** Teams mode: the user signed in with a temporary password and must choose a new one before anything else. */
  mustChangePassword?: boolean;
  /** Teams mode: the admin from STUBYARD_ADMIN_EMAIL. */
  envAdmin?: boolean;
}

/**
 * What a principal may do. `admin`: the instance-level permissions (users, system, create / delete projects); `all`:
 * every project with the admin role; otherwise `projects` (slug → role). `cap` (a narrowed API token): never more than
 * this role's permissions.
 */
export interface Grants {
  admin: boolean;
  all: boolean;
  projects: ReadonlyMap<string, Role>;
  cap: Role | null;
}

/**
 * Who an internal call acts for (stubyard calling its own API for someone: MCP tools, scheduled actions, chat tools,
 * the MCP tester's "this server"). Always resolved afresh, so a disabled user or a revoked token stops working at once.
 */
export type Actor = { userKey: string; sessionId?: string; tokenId?: string } | { confine: { slug: string; role: Role } };

/** Who is making a request. */
export type Principal =
  | { kind: 'session'; user: AuthUser; sessionId: string; csrf: string; grants: Grants; actor: Actor }
  | { kind: 'token'; user: AuthUser; tokenId: string; grants: Grants; actor: Actor }
  /** Teams mode: stubyard's own call made for a user (or confined to one project); never more than that user may do. */
  | { kind: 'acting'; user: AuthUser | null; grants: Grants; actor: Actor }
  /** app.inject() calls made by stubyard itself with nobody to act for (Open / Single admin mode, system jobs). */
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
  /** Teams mode only: the narrowing (null = not narrowed). */
  projects?: string[] | null;
  maxRole?: string | null;
}

export interface TeamUserView {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  disabled: boolean;
  mustChangePassword: boolean;
  envAdmin: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  projects: { slug: string; role: ProjectRole }[];
}

export interface InviteView {
  id: string;
  email: string | null;
  name: string | null;
  role: 'admin' | 'member';
  project: string | null;
  projectRole: ProjectRole | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  createdBy: string | null;
}

export interface MemberView {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
  disabled: boolean;
  /** Still signs in with a temporary password. */
  mustChangePassword: boolean;
  addedAt: string;
  addedBy: string | null;
}

export interface Meta {
  ip: string;
  userAgent?: string;
}

/** Prefix of personal API tokens ("sy_" + 43 base64url characters = 256 random bits). */
export const TOKEN_PREFIX = 'sy_';
/** Prefix of invite tokens. */
export const INVITE_PREFIX = 'syinv_';
/** Password checks running at once; more answer 429 (Retry-After: 1). The libuv pool has 4 threads by default. */
export const MAX_CONCURRENT_VERIFICATIONS = 2;
/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * 86_400_000;
/** How many characters of a token the lists show. */
const SHOWN = TOKEN_PREFIX.length + 8;
const MAX_ACTIVE_TOKENS = 100;
/** last_seen / last_used are written at most this often per session / token. */
const TOUCH_MS = 60_000;
/** Lifetime of a single-use acting ticket (an app.inject() call made for someone starts right away). */
const ACTING_TTL_MS = 60_000;
const MAX_ACTING = 10_000;

export const SESSION_COOKIE = 'stubyard_session';
/** With Secure on, the cookie gets the __Host- prefix (no Domain, Path=/, Secure: it cannot be set by a subdomain). */
export const SECURE_SESSION_COOKIE = '__Host-stubyard_session';
export const CSRF_HEADER = 'x-stubyard-csrf';
/** Header of an app.inject() call made for someone (Teams mode); honoured on injected requests only. */
export const ACTING_HEADER = 'x-stubyard-acting';

export const ROLE_LABELS: Record<ProjectRole | 'admin', { label: string; description: string }> = {
  admin: { label: 'Instance admin', description: 'Everything: users, system settings, AI keys, every project.' },
  project_admin: { label: 'Project admin', description: 'Project settings and members, providers and secrets, reset.' },
  project_manager: { label: 'Project manager', description: 'Features board, storyboards, runs and walkthroughs.' },
  developer: { label: 'Developer', description: 'Providers, mocks, webhooks, payments config and secrets; board, storyboards, runs.' },
  designer: { label: 'Designer', description: 'Views everything; edits feature details and images.' },
  qa: { label: 'QA tester', description: 'Board, storyboards, runs, walkthroughs, test users and cleanup.' },
  viewer: { label: 'Viewer', description: 'Read only: inboxes, traffic, walkthroughs, recordings, board.' },
};

const FULL: Grants = Object.freeze({ admin: true, all: true, projects: new Map<string, Role>(), cap: null });
const BASE_PERMISSIONS: ReadonlySet<Permission> = new Set(['public', 'authenticated', 'self']);

const nowIso = (ms: number) => new Date(ms).toISOString();
const isProjectRole = (r: unknown): r is ProjectRole => typeof r === 'string' && (PROJECT_ROLES as readonly string[]).includes(r);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/**
 * Sign-in for the dashboard, the API, /mcp and the extension (docs/GUIDE.md "Sign-in" and "Teams"). Open mode has
 * no accounts and every method that needs one throws 404. Sessions and tokens are kept in an AuthStore (SQLite in
 * Single admin mode, Postgres in Teams mode, which also keeps users, memberships, invites and the audit log).
 */
export class AccessService {
  readonly mode: AuthMode;
  readonly limiter: LoginLimiter;
  /** Failed invite look-ups per address (tokens are unguessable; this only stops floods). */
  readonly inviteLimiter: LoginLimiter;
  /** Membership, user, session and token changes ("changed"): open event streams re-check who they serve. */
  readonly events = new EventEmitter();
  /** scrypt runs in flight (see MAX_CONCURRENT_VERIFICATIONS). */
  private verifying = 0;
  private readonly adminUser: AuthUser | null;
  private readonly cred: string;
  /** Bearer secret of stubyard's own HTTP calls to itself (MCP tester "this server"); accepted from loopback only. */
  private readonly selfSecret = `syi_${randomBytes(32).toString('base64url')}`;
  /** Teams mode: the MCP tester's "this server" credential per project (confined to that project). */
  private readonly selfTickets = new Map<string, Actor>();
  private readonly selfTicketOf = new Map<string, string>();
  private readonly acting = new Map<string, { actor: Actor; exp: number }>();
  /** Teams mode: the env admin's users.id (after init). */
  private envAdminId: string | null = null;
  /** Hash checked for unknown e-mails (Teams mode), so they cost the same scrypt run as real ones. */
  private dummyHash = '';
  private projectExists: (slug: string) => boolean = () => false;
  private projectName: (slug: string) => string | null = () => null;
  private log: { warn: (o: unknown, msg?: string) => void; info?: (o: unknown, msg?: string) => void } = { warn: () => undefined };

  constructor(
    private config: Config,
    readonly store: AuthStore,
    private now: () => number = Date.now,
  ) {
    const admin = config.admin;
    this.mode = admin ? (config.databaseUrl ? 'teams' : 'single') : 'open';
    this.limiter = new LoginLimiter(5, 15 * 60_000, now);
    this.inviteLimiter = new LoginLimiter(10, 15 * 60_000, now, 10_000, 10);
    this.adminUser = admin ? { id: `admin:${admin.email}`, email: admin.email, name: 'Admin', role: 'admin' } : null;
    this.cred = admin ? sha256(`cred:${admin.email}:${admin.passwordHash}`).slice(0, 32) : '';
    this.events.setMaxListeners(0);
  }

  get enabled(): boolean {
    return this.mode !== 'open';
  }

  get teams(): boolean {
    return this.mode === 'teams';
  }

  get cookieName(): string {
    return this.config.cookieSecure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  }

  /** The Postgres store (Teams mode only). */
  private get pg(): PgAuthStore {
    if (!this.teams) throw new HttpError(404, 'Teams mode only: set STUBYARD_DATABASE_URL (with the env admin) to manage users and project members');
    return this.store as PgAuthStore;
  }

  /** Project lookups from the hub (membership checks need to know which slugs exist). */
  setProjectLookup(exists: (slug: string) => boolean, name: (slug: string) => string | null): void {
    this.projectExists = exists;
    this.projectName = name;
  }

  /** Teams mode: connect, migrate, make sure the env admin is an instance admin. No-op in the other modes. */
  async init(log?: { warn: (o: unknown, msg?: string) => void; info?: (o: unknown, msg?: string) => void }, waitMs?: number): Promise<void> {
    if (log) this.log = log;
    if (!this.teams) return;
    const r = await this.pg.init(waitMs);
    if (r.applied.length) this.log.info?.({ applied: r.applied }, `Teams mode: Postgres schema "stubyard" migrated (${this.pg.target})`);
    const admin = await this.pg.ensureEnvAdmin(this.config.admin!.email, `usr_${newId()}`);
    this.envAdminId = admin.id;
    for (const d of admin.demoted) {
      this.log.warn({ email: d.email }, 'Teams mode: STUBYARD_ADMIN_EMAIL changed; the previous instance admin is now a member and its sessions and API tokens were revoked');
      await this.audit(null, 'user.env_admin_replaced', { target: d.id, detail: { from: d.email, to: admin.email } });
    }
    this.dummyHash = hashPassword(randomBytes(16).toString('base64url'));
  }

  async close(): Promise<void> {
    if (this.teams) await this.pg.close();
  }

  async health(): Promise<PgHealth | null> {
    return this.teams ? this.pg.health() : null;
  }

  private changed(): void {
    this.events.emit('changed');
  }

  private requireEnabled(): AuthUser {
    if (!this.adminUser) throw new HttpError(404, 'Sign-in is not enabled on this stubyard (Open mode). Set STUBYARD_ADMIN_EMAIL and STUBYARD_ADMIN_PASSWORD to turn it on.');
    return this.adminUser;
  }

  private userView(u: UserRecord): AuthUser {
    return { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.envAdmin ? false : u.mustChangePassword, envAdmin: u.envAdmin };
  }

  private active(u: UserRecord | null): u is UserRecord {
    return !!u && (u.envAdmin || !u.disabled);
  }

  /** Fingerprint of a user's credential: a new password ends every session signed in with the old one. */
  private credOf(u: UserRecord): string {
    if (u.envAdmin) return this.cred;
    return sha256(`cred:${u.id}:${u.passwordHash ?? ''}`).slice(0, 32);
  }

  /** The account for a user key, or null when it no longer exists or may not sign in. */
  private async userOf(userKey: string): Promise<{ user: AuthUser; rec: UserRecord | null; cred: string } | null> {
    if (!this.teams) return this.adminUser && userKey === this.adminUser.id ? { user: this.adminUser, rec: null, cred: this.cred } : null;
    const u = await this.pg.getUser(userKey);
    if (!this.active(u)) return null;
    return { user: this.userView(u), rec: u, cred: this.credOf(u) };
  }

  /** The grants of a user (and of the token it signs in with). */
  private async grantsOf(user: AuthUser, token?: TokenRecord | null): Promise<Grants> {
    if (!this.teams) return FULL;
    let g: Grants;
    if (user.role === 'admin') g = FULL;
    else g = { admin: false, all: false, projects: new Map((await this.pg.membershipsOf(user.id)).map((m) => [m.projectSlug, m.role as Role])), cap: null };
    if (!token) return g;
    const list = token.scopeProjects ?? null;
    const cap = (token.scopeMaxRole as Role | null) ?? null;
    if (list) {
      const projects = new Map<string, Role>();
      for (const slug of list) {
        const role = g.all ? 'admin' : g.projects.get(slug);
        if (role) projects.set(slug, role);
      }
      g = { admin: false, all: false, projects, cap };
    } else g = { ...g, cap };
    return g;
  }

  // ------------------------------------------------------------------ permission checks

  private grantsFor(p: Principal): Grants {
    return p.kind === 'internal' ? FULL : p.grants;
  }

  /** The role a principal has in a project (before a token cap), or null. */
  roleIn(p: Principal, slug: string): Role | null {
    const g = this.grantsFor(p);
    return g.all ? 'admin' : (g.projects.get(slug) ?? null);
  }

  /**
   * Whether the principal holds the permission: in the project `slug`, or instance-wide when slug is null. "public",
   * "authenticated" and "self" need only a signed-in account.
   */
  can(p: Principal, permission: Permission, slug: string | null): boolean {
    if (BASE_PERMISSIONS.has(permission)) return true;
    if (p.kind === 'internal') return true;
    const g = p.grants;
    if (g.cap && !allows(g.cap, permission)) return false;
    if (slug === null) return g.admin && allows('admin', permission);
    const role = g.all ? 'admin' : g.projects.get(slug);
    return !!role && allows(role, permission);
  }

  /** Whether the principal holds the permission in at least one project (or instance-wide). */
  canAnywhere(p: Principal, permission: Permission): boolean {
    if (BASE_PERMISSIONS.has(permission) || p.kind === 'internal') return true;
    const g = p.grants;
    if (g.cap && !allows(g.cap, permission)) return false;
    if (g.all || g.admin) return allows('admin', permission);
    for (const role of g.projects.values()) if (allows(role, permission)) return true;
    return false;
  }

  /** Project slugs the principal may see, or null for every project (and project-less data). */
  visibleSlugs(p: Principal | null | undefined): Set<string> | null {
    if (!this.enabled || !p || p.kind === 'internal') return null;
    const g = p.grants;
    if (g.all && (!g.cap || allows(g.cap, 'project.view'))) return null;
    const out = new Set<string>();
    if (g.cap && !allows(g.cap, 'project.view')) return out;
    for (const [slug, role] of g.projects) if (allows(role, 'project.view')) out.add(slug);
    return out;
  }

  /** Whether a request may see data of this project (null: project-less data, instance admins only). Open mode: yes. */
  sees(p: Principal | null | undefined, slug: string | null): boolean {
    const v = this.visibleSlugs(p);
    if (v === null) return true;
    return slug !== null && v.has(slug);
  }

  /** Kept for T1 callers: an instance-wide check. */
  allows(principal: Principal, permission: Permission): boolean {
    return this.can(principal, permission, null);
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
    const emailOk = safeEqual(e, admin.email);
    const wait = this.limiter.retryAfter(e, meta.ip, emailOk);
    if (wait > 0) throw Object.assign(new HttpError(429, wait < 120 ? `Too many failed sign-ins. Try again in ${wait} s.` : `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60)} minute(s).`), { retryAfter: wait });
    // scrypt runs in the thread pool, a few at a time: a burst of sign-ins cannot starve the app-facing endpoints.
    if (this.verifying >= MAX_CONCURRENT_VERIFICATIONS) throw Object.assign(new HttpError(429, 'Too many sign-ins at once. Try again in a moment.'), { retryAfter: 1 });
    this.verifying++;
    let passwordOk: boolean;
    let account: { user: AuthUser; cred: string } | null = null;
    try {
      if (this.teams) {
        // The env admin always signs in with the env password; everyone else with their stored hash. An unknown or
        // disabled account still costs one scrypt run (no timing difference).
        const rec = await this.pg.getUserByEmail(e);
        const usable = this.active(rec) && (rec.envAdmin ? emailOk : !!rec.passwordHash);
        const hash = emailOk ? this.config.admin!.passwordHash : usable ? rec!.passwordHash! : this.dummyHash;
        passwordOk = (await verifyPasswordAsync(p, hash)) && usable && (emailOk ? !!rec?.envAdmin : true);
        if (passwordOk && rec) account = { user: this.userView(rec), cred: this.credOf(rec) };
      } else {
        // Always run scrypt, also for an unknown e-mail (no timing difference between the two).
        passwordOk = (await verifyPasswordAsync(p, this.config.admin!.passwordHash)) && emailOk;
        if (passwordOk) account = { user: admin, cred: this.cred };
      }
    } finally {
      this.verifying--;
    }
    if (!passwordOk || !account) {
      this.limiter.fail(e, meta.ip);
      void this.audit(null, 'auth.login_failed', { target: e, ip: meta.ip });
      throw new HttpError(401, 'Wrong e-mail or password');
    }
    this.limiter.succeed(e, meta.ip);
    const r = await this.openSession(account.user, account.cred, meta);
    if (this.teams) await this.pg.updateUser(account.user.id, { lastLoginAt: nowIso(this.now()) });
    void this.audit(r.user, 'auth.login', { ip: meta.ip, detail: { userAgent: meta.userAgent.slice(0, 200) } });
    return r;
  }

  private async openSession(user: AuthUser, cred: string, meta: { ip: string; userAgent?: string }): Promise<{ token: string; session: SessionRecord; user: AuthUser }> {
    const now = this.now();
    await this.store.purgeExpiredSessions(nowIso(now));
    const token = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      id: sha256(token),
      userKey: user.id,
      cred,
      csrf: randomBytes(24).toString('base64url'),
      createdAt: nowIso(now),
      expiresAt: nowIso(now + this.config.sessionTtlHours * 3600_000),
      lastSeenAt: nowIso(now),
      userAgent: (meta.userAgent ?? '').slice(0, 300),
      ip: meta.ip.slice(0, 100),
    };
    await this.store.createSession(session);
    return { token, session, user };
  }

  async logout(sessionId: string, p?: Principal | null): Promise<void> {
    await this.store.deleteSession(sessionId);
    if (p?.user) void this.audit(p.user, 'auth.logout', {});
    this.changed();
  }

  /** A live session record for a principal's session id (not expired, credential still current), with its user. */
  private async liveSession(id: string): Promise<{ s: SessionRecord; user: AuthUser } | null> {
    const s = await this.store.getSession(id);
    if (!s) return null;
    const acc = await this.userOf(s.userKey);
    if (!acc || !safeEqual(s.cred, acc.cred) || Date.parse(s.expiresAt) <= this.now()) {
      await this.store.deleteSession(s.id);
      return null;
    }
    return { s, user: acc.user };
  }

  /** The principal of a session cookie value, or null (unknown, expired, or signed in with an older password). */
  async sessionPrincipal(cookieToken: string): Promise<Extract<Principal, { kind: 'session' }> | null> {
    if (!this.enabled || !cookieToken || cookieToken.length > 200) return null;
    const live = await this.liveSession(sha256(cookieToken));
    if (!live) return null;
    const { s, user } = live;
    const now = this.now();
    if (now - Date.parse(s.lastSeenAt) > TOUCH_MS) await this.store.touchSession(s.id, nowIso(now));
    return { kind: 'session', user, sessionId: s.id, csrf: s.csrf, grants: await this.grantsOf(user), actor: { userKey: user.id, sessionId: s.id } };
  }

  /** A usable token record (not revoked, not expired) with its user. */
  private async liveToken(t: TokenRecord | null): Promise<{ t: TokenRecord; user: AuthUser } | null> {
    if (!t || t.revokedAt) return null;
    if (t.expiresAt && Date.parse(t.expiresAt) <= this.now()) return null;
    const acc = await this.userOf(t.userKey);
    return acc ? { t, user: acc.user } : null;
  }

  /**
   * The principal of an Authorization: Bearer value: a personal API token, or the self credential from a loopback
   * address. null when it is not valid (unknown, revoked, expired).
   */
  async bearerPrincipal(token: string, remoteAddress: string | undefined): Promise<Principal | null> {
    if (!this.enabled || !token || token.length > 200) return null;
    if (token.startsWith('syi_')) {
      if (!isLoopback(remoteAddress)) return null;
      const actor = this.selfTickets.get(token);
      if (actor) return this.resolveActor(actor);
      return safeEqual(token, this.selfSecret) ? { kind: 'internal', user: null } : null;
    }
    const live = await this.liveToken(await this.store.getTokenByHash(sha256(token)));
    if (!live) return null;
    const { t, user } = live;
    const now = this.now();
    if (!t.lastUsedAt || now - Date.parse(t.lastUsedAt) > TOUCH_MS) await this.store.touchToken(t.id, nowIso(now));
    return { kind: 'token', user, tokenId: t.id, grants: await this.grantsOf(user, t), actor: { userKey: user.id, tokenId: t.id } };
  }

  /** An actor resolved afresh (null when its session, token or user no longer works). */
  async resolveActor(actor: Actor): Promise<Extract<Principal, { kind: 'acting' }> | null> {
    if ('confine' in actor) return { kind: 'acting', user: null, grants: { admin: false, all: false, projects: new Map([[actor.confine.slug, actor.confine.role]]), cap: null }, actor };
    if (actor.sessionId) {
      const live = await this.liveSession(actor.sessionId);
      if (!live || live.user.id !== actor.userKey) return null;
      return { kind: 'acting', user: live.user, grants: await this.grantsOf(live.user), actor };
    }
    if (actor.tokenId) {
      const live = await this.liveToken(await this.store.getToken(actor.tokenId));
      if (!live || live.user.id !== actor.userKey) return null;
      return { kind: 'acting', user: live.user, grants: await this.grantsOf(live.user, live.t), actor };
    }
    const acc = await this.userOf(actor.userKey);
    return acc ? { kind: 'acting', user: acc.user, grants: await this.grantsOf(acc.user), actor } : null;
  }

  /**
   * Headers for an app.inject() call made for this principal (Teams mode): a single-use ticket the access hook turns
   * back into the same user with the same grants. {} otherwise (the call runs as stubyard itself, as in T1).
   */
  actingHeaders(p: Principal | null | undefined): Record<string, string> {
    if (!this.teams || !p || p.kind === 'internal') return {};
    return this.actingHeadersFor(p.actor);
  }

  /** actingHeaders for an actor (e.g. a scheduled action's creator, a chat confined to its project). */
  actingHeadersFor(actor: Actor | null): Record<string, string> {
    if (!this.teams || !actor) return {};
    const now = this.now();
    if (this.acting.size >= MAX_ACTING) for (const [k, v] of this.acting) if (v.exp <= now || this.acting.size >= MAX_ACTING) this.acting.delete(k);
    const ticket = randomBytes(32).toString('base64url');
    this.acting.set(ticket, { actor, exp: now + ACTING_TTL_MS });
    return { [ACTING_HEADER]: ticket };
  }

  /** The principal of an acting ticket (single use), or null. */
  async redeemActing(ticket: string): Promise<Principal | null> {
    const e = this.acting.get(ticket);
    if (!e) return null;
    this.acting.delete(ticket);
    if (e.exp <= this.now()) return null;
    return this.resolveActor(e.actor);
  }

  /** The user key to remember with something done for later (a scheduled action), Teams mode only. */
  actorKey(p: Principal | null | undefined): string | null {
    if (!this.teams || !p || p.kind === 'internal' || !p.user) return null;
    return p.user.id;
  }

  /**
   * Headers for stubyard's own HTTP calls to its /mcp (none in Open mode). Teams mode: confined to the project (as a
   * developer), so an MCP tester session cannot reach other projects. Never store or show them.
   */
  selfAuthHeaders(projectSlug?: string): Record<string, string> {
    if (!this.enabled) return {};
    if (!this.teams || !projectSlug) return this.teams ? {} : { authorization: `Bearer ${this.selfSecret}` };
    let t = this.selfTicketOf.get(projectSlug);
    if (!t) {
      t = `syi_${randomBytes(32).toString('base64url')}`;
      this.selfTicketOf.set(projectSlug, t);
      this.selfTickets.set(t, { confine: { slug: projectSlug, role: 'developer' } });
    }
    return { authorization: `Bearer ${t}` };
  }

  // ------------------------------------------------------------------ API tokens

  async listTokens(user: AuthUser): Promise<TokenView[]> {
    return (await this.store.listTokens(user.id)).map((t) => this.tokenView(t));
  }

  /** A new token; the secret is returned this once and only its hash is kept. */
  async createToken(user: AuthUser, input: { name?: unknown; expiresInDays?: unknown; projects?: unknown; maxRole?: unknown }, p?: Principal): Promise<{ token: TokenView; secret: string }> {
    this.requireEnabled();
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw new HttpError(400, 'name is required (1–80 characters), e.g. "Chrome extension" or "Claude Code"');
    let expiresAt: string | null = null;
    if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== '') {
      const d = Number(input.expiresInDays);
      if (!Number.isInteger(d) || d < 1 || d > 3650) throw new HttpError(400, 'expiresInDays must be a whole number of days from 1 to 3650 (or null for no expiry)');
      expiresAt = nowIso(this.now() + d * 86_400_000);
    }
    let scopeProjects: string[] | null = null;
    let scopeMaxRole: string | null = null;
    const hasProjects = input.projects !== undefined && input.projects !== null;
    const hasRole = input.maxRole !== undefined && input.maxRole !== null && input.maxRole !== '';
    if ((hasProjects || hasRole) && !this.teams) throw new HttpError(400, 'projects and maxRole narrow a token in Teams mode only');
    if (hasProjects) {
      if (!Array.isArray(input.projects) || !input.projects.length || input.projects.length > 200 || input.projects.some((s) => typeof s !== 'string')) throw new HttpError(400, 'projects must be a non-empty list of project slugs (or null for all your projects)');
      const own = p ? p : null;
      for (const slug of input.projects as string[]) {
        if (!this.projectExists(slug) || (own && !this.sees(own, slug))) throw new HttpError(400, `You are not a member of project "${slug}"`);
      }
      scopeProjects = [...new Set(input.projects as string[])];
    }
    if (hasRole) {
      const r = input.maxRole;
      if (!(r === 'admin' || isProjectRole(r))) throw new HttpError(400, `maxRole must be one of ${PROJECT_ROLES.join(', ')} (or admin)`);
      if (r === 'admin' && user.role !== 'admin') throw new HttpError(400, 'Only instance admins can create a token with maxRole "admin"');
      scopeMaxRole = r as string;
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
      ...(this.teams ? { scopeProjects, scopeMaxRole } : {}),
    };
    await this.store.createToken(rec);
    void this.audit(user, 'token.create', { target: rec.id, detail: { name, expiresAt, projects: scopeProjects, maxRole: scopeMaxRole } });
    return { token: this.tokenView(rec), secret };
  }

  async revokeToken(user: AuthUser, id: string): Promise<TokenView> {
    const t = await this.store.getToken(id);
    if (!t || t.userKey !== user.id) throw new HttpError(404, `API token "${id}" not found`);
    await this.store.revokeToken(t.id, nowIso(this.now()));
    void this.audit(user, 'token.revoke', { target: t.id, detail: { name: t.name } });
    this.changed();
    return this.tokenView((await this.store.getToken(id))!);
  }

  private tokenView(t: TokenRecord): TokenView {
    const status = t.revokedAt ? 'revoked' : t.expiresAt && Date.parse(t.expiresAt) <= this.now() ? 'expired' : 'active';
    const base: TokenView = { id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt, status };
    return this.teams ? { ...base, projects: t.scopeProjects ?? null, maxRole: t.scopeMaxRole ?? null } : base;
  }

  // ------------------------------------------------------------------ passwords (Teams mode)

  private checkNewPassword(v: unknown, field = 'password'): string {
    if (typeof v !== 'string' || v.length < MIN_PASSWORD_LENGTH || v.length > 1024) throw new HttpError(400, `${field} must be ${MIN_PASSWORD_LENGTH} to 1024 characters`);
    return v;
  }

  private async hashGated(password: string): Promise<string> {
    if (this.verifying >= MAX_CONCURRENT_VERIFICATIONS) throw Object.assign(new HttpError(429, 'Too many password checks at once. Try again in a moment.'), { retryAfter: 1 });
    this.verifying++;
    try {
      return await hashPasswordAsync(password);
    } finally {
      this.verifying--;
    }
  }

  private async verifyGated(password: string, hash: string): Promise<boolean> {
    if (this.verifying >= MAX_CONCURRENT_VERIFICATIONS) throw Object.assign(new HttpError(429, 'Too many password checks at once. Try again in a moment.'), { retryAfter: 1 });
    this.verifying++;
    try {
      return await verifyPasswordAsync(password, hash);
    } finally {
      this.verifying--;
    }
  }

  /** A readable random temporary password (16 characters). */
  private tempPassword(): string {
    return randomBytes(12).toString('base64url');
  }

  /**
   * Changes the signed-in user's own password (session only). Ends the user's other sessions and keeps this one;
   * clears must_change_password.
   */
  async changeOwnPassword(p: Principal, input: { currentPassword?: unknown; newPassword?: unknown }, meta: Meta): Promise<void> {
    const pg = this.pg;
    if (p.kind !== 'session') throw new HttpError(403, 'Change your password from the dashboard (signed in with your password)');
    const rec = await pg.getUser(p.user.id);
    if (!rec) throw new HttpError(401, 'Sign in required');
    if (rec.envAdmin) throw new HttpError(409, 'The instance admin from STUBYARD_ADMIN_EMAIL signs in with STUBYARD_ADMIN_PASSWORD(_HASH); change it in the environment');
    const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    const next = this.checkNewPassword(input.newPassword, 'newPassword');
    const wait = this.limiter.retryAfter(`pw:${rec.id}`, meta.ip);
    if (wait > 0) throw Object.assign(new HttpError(429, `Too many wrong passwords. Try again in ${wait} s.`), { retryAfter: wait });
    if (!current || !rec.passwordHash || !(await this.verifyGated(current, rec.passwordHash))) {
      this.limiter.fail(`pw:${rec.id}`, meta.ip);
      throw new HttpError(400, 'The current password is wrong');
    }
    if (current === next) throw new HttpError(400, 'Choose a password different from the current one');
    const hash = await this.hashGated(next);
    const updated = (await pg.updateUser(rec.id, { passwordHash: hash, mustChangePassword: false }))!;
    await pg.updateSessionCred(p.sessionId, this.credOf(updated));
    await pg.deleteSessionsOf(rec.id, p.sessionId);
    void this.audit(p.user, 'user.password_change', { target: rec.id, ip: meta.ip });
    this.changed();
  }

  // ------------------------------------------------------------------ users (Teams mode, instance admins)

  private teamUserView(u: UserRecord, projects: { slug: string; role: ProjectRole }[]): TeamUserView {
    return { id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.envAdmin ? false : u.disabled, mustChangePassword: u.envAdmin ? false : u.mustChangePassword, envAdmin: u.envAdmin, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, projects };
  }

  async listUsers(): Promise<TeamUserView[]> {
    const pg = this.pg;
    const [users, members] = await Promise.all([pg.listUsers(), pg.allMemberships()]);
    const by = new Map<string, { slug: string; role: ProjectRole }[]>();
    for (const m of members) by.set(m.userId, [...(by.get(m.userId) ?? []), { slug: m.projectSlug, role: m.role }]);
    return users.map((u) => this.teamUserView(u, by.get(u.id) ?? []));
  }

  async getTeamUser(id: string): Promise<TeamUserView> {
    const u = await this.pg.getUser(id);
    if (!u) throw new HttpError(404, `User "${id}" not found`);
    return this.teamUserView(u, (await this.pg.membershipsOf(id)).map((m) => ({ slug: m.projectSlug, role: m.role })));
  }

  private checkEmail(v: unknown): string {
    const e = str(v).toLowerCase();
    if (!e || e.length > 320 || !EMAIL_RE.test(e)) throw new HttpError(400, 'email must be an e-mail address');
    return e;
  }

  private checkName(v: unknown, fallback = ''): string {
    const n = v === undefined || v === null ? fallback : str(v);
    if (n.length > 100) throw new HttpError(400, 'name must be at most 100 characters');
    return n;
  }

  private checkInstanceRole(v: unknown): 'admin' | 'member' {
    if (v === undefined || v === null || v === '') return 'member';
    if (v !== 'admin' && v !== 'member') throw new HttpError(400, 'role must be "admin" (instance admin) or "member"');
    return v;
  }

  checkProjectRole(v: unknown): ProjectRole {
    if (!isProjectRole(v)) throw new HttpError(400, `role must be one of ${PROJECT_ROLES.join(', ')}`);
    return v;
  }

  private checkProjects(v: unknown): { slug: string; role: ProjectRole }[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 200) throw new HttpError(400, 'projects must be a list of { slug, role }');
    return v.map((x) => {
      const o = (x ?? {}) as { slug?: unknown; role?: unknown };
      const slug = str(o.slug);
      if (!this.projectExists(slug)) throw new HttpError(400, `Project "${slug}" not found`);
      return { slug, role: this.checkProjectRole(o.role) };
    });
  }

  /** Creates a user with a temporary password (given, or generated and returned once); must change it at sign-in. */
  async createUser(by: Principal, input: Record<string, unknown>, meta: Meta): Promise<{ user: TeamUserView; temporaryPassword?: string }> {
    const pg = this.pg;
    const email = this.checkEmail(input.email);
    const name = this.checkName(input.name, email.split('@')[0]);
    const role = this.checkInstanceRole(input.role);
    const projects = this.checkProjects(input.projects);
    const given = input.password !== undefined && input.password !== null && input.password !== '';
    const password = given ? this.checkNewPassword(input.password) : this.tempPassword();
    if (await pg.getUserByEmail(email)) throw new HttpError(409, `A user with e-mail ${email} already exists`);
    const hash = await this.hashGated(password);
    let u: UserRecord;
    try {
      u = await pg.createUser({ id: `usr_${newId()}`, email, name, passwordHash: hash, role, mustChangePassword: true });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, `A user with e-mail ${email} already exists`);
      throw err;
    }
    for (const m of projects) await pg.setMember(u.id, m.slug, m.role, by.user?.id ?? null);
    void this.audit(by.user, 'user.create', { target: u.id, ip: meta.ip, detail: { email, role, projects } });
    for (const m of projects) void this.audit(by.user, 'member.add', { projectSlug: m.slug, target: u.id, ip: meta.ip, detail: { role: m.role, email } });
    this.changed();
    return { user: await this.getTeamUser(u.id), ...(given ? {} : { temporaryPassword: password }) };
  }

  /** Name, instance role, disabled. The env admin cannot be demoted or disabled; nobody can demote / disable themselves. */
  async updateUser(by: Principal, id: string, input: Record<string, unknown>, meta: Meta): Promise<TeamUserView> {
    const pg = this.pg;
    const u = await pg.getUser(id);
    if (!u) throw new HttpError(404, `User "${id}" not found`);
    const patch: { name?: string; role?: 'admin' | 'member'; disabled?: boolean } = {};
    if (input.name !== undefined) patch.name = this.checkName(input.name);
    if (input.role !== undefined) patch.role = this.checkInstanceRole(input.role);
    if (input.disabled !== undefined) {
      if (typeof input.disabled !== 'boolean') throw new HttpError(400, 'disabled must be true or false');
      patch.disabled = input.disabled;
    }
    const demote = patch.role !== undefined && patch.role !== u.role;
    const disable = patch.disabled === true && !u.disabled;
    if ((demote || patch.disabled === true) && u.envAdmin) throw new HttpError(409, 'The instance admin from STUBYARD_ADMIN_EMAIL cannot be demoted or disabled');
    if ((demote && patch.role === 'member' || patch.disabled === true) && by.user?.id === u.id) throw new HttpError(409, 'You cannot remove your own admin role or disable yourself');
    const updated = (await pg.updateUser(id, patch))!;
    if (disable) {
      // A disabled user loses every way in at once: sessions end, tokens are revoked.
      await pg.deleteSessionsOf(id);
      await pg.revokeTokensOf(id, nowIso(this.now()));
    }
    if (demote) void this.audit(by.user, 'user.role', { target: id, ip: meta.ip, detail: { from: u.role, to: patch.role } });
    if (patch.disabled !== undefined && patch.disabled !== u.disabled) void this.audit(by.user, patch.disabled ? 'user.disable' : 'user.enable', { target: id, ip: meta.ip, detail: { email: u.email } });
    if (patch.name !== undefined && patch.name !== u.name) void this.audit(by.user, 'user.update', { target: id, ip: meta.ip, detail: { name: patch.name } });
    this.changed();
    return this.getTeamUser(updated.id);
  }

  /** Sets a temporary password (given, or generated and returned once): must change at sign-in; sessions end and API tokens are revoked. */
  async resetPassword(by: Principal, id: string, input: Record<string, unknown>, meta: Meta): Promise<{ user: TeamUserView; temporaryPassword?: string }> {
    const pg = this.pg;
    const u = await pg.getUser(id);
    if (!u) throw new HttpError(404, `User "${id}" not found`);
    if (u.envAdmin) throw new HttpError(409, 'The instance admin from STUBYARD_ADMIN_EMAIL signs in with STUBYARD_ADMIN_PASSWORD(_HASH); change it in the environment');
    const given = input.password !== undefined && input.password !== null && input.password !== '';
    const password = given ? this.checkNewPassword(input.password) : this.tempPassword();
    await pg.updateUser(id, { passwordHash: await this.hashGated(password), mustChangePassword: true });
    // A reset usually means the account may be compromised: every session ends and every API token is revoked.
    const sessions = await pg.deleteSessionsOf(id);
    const tokens = await pg.revokeTokensOf(id, nowIso(this.now()));
    void this.audit(by.user, 'user.password_reset', { target: id, ip: meta.ip, detail: { email: u.email, sessionsEnded: sessions, tokensRevoked: tokens } });
    this.changed();
    return { user: await this.getTeamUser(id), ...(given ? {} : { temporaryPassword: password }) };
  }

  // ------------------------------------------------------------------ invites (Teams mode)

  private inviteView(i: InviteRecord): InviteView {
    const status = i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : Date.parse(i.expiresAt) <= this.now() ? 'expired' : 'pending';
    return { id: i.id, email: i.email, name: i.name, role: i.role, project: i.projectSlug, projectRole: i.projectRole, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt, revokedAt: i.revokedAt, status, createdBy: i.createdBy };
  }

  async listInvites(): Promise<InviteView[]> {
    return (await this.pg.listInvites()).map((i) => this.inviteView(i));
  }

  /** A single-use invite link valid for 7 days; the token is returned once and only its hash is kept. */
  async createInvite(by: Principal, input: Record<string, unknown>, meta: Meta): Promise<{ invite: InviteView; token: string; path: string }> {
    const pg = this.pg;
    const email = input.email === undefined || input.email === null || input.email === '' ? null : this.checkEmail(input.email);
    const name = this.checkName(input.name) || null;
    const role = this.checkInstanceRole(input.role);
    let project: string | null = null;
    let projectRole: ProjectRole | null = null;
    if (input.project !== undefined && input.project !== null && input.project !== '') {
      project = str(input.project);
      if (!this.projectExists(project)) throw new HttpError(400, `Project "${project}" not found`);
      projectRole = this.checkProjectRole(input.projectRole ?? 'viewer');
    }
    if (email && (await pg.getUserByEmail(email))) throw new HttpError(409, `A user with e-mail ${email} already exists`);
    const token = `${INVITE_PREFIX}${randomBytes(32).toString('base64url')}`;
    const rec = await pg.createInvite({ id: `inv_${newId()}`, email, name, role, projectSlug: project, projectRole, tokenHash: sha256(token), createdBy: by.user?.id ?? null, expiresAt: nowIso(this.now() + INVITE_TTL_MS) });
    void this.audit(by.user, 'invite.create', { target: rec.id, projectSlug: project, ip: meta.ip, detail: { email, role, projectRole } });
    return { invite: this.inviteView(rec), token, path: `/invite#${token}` };
  }

  async revokeInvite(by: Principal, id: string, meta: Meta): Promise<InviteView> {
    const r = await this.pg.revokeInvite(id);
    if (!r) throw new HttpError(404, `Invite "${id}" not found`);
    void this.audit(by.user, 'invite.revoke', { target: id, ip: meta.ip });
    return this.inviteView(r);
  }

  private async pendingInvite(token: unknown, ip: string): Promise<InviteRecord> {
    const pg = this.pg;
    const t = typeof token === 'string' ? token.trim() : '';
    const wait = this.inviteLimiter.retryAfter('invite', ip);
    if (wait > 0) throw Object.assign(new HttpError(429, `Too many invalid invite links. Try again in ${wait} s.`), { retryAfter: wait });
    const rec = t.startsWith(INVITE_PREFIX) && t.length < 200 ? await pg.getInviteByHash(sha256(t)) : null;
    if (!rec || this.inviteView(rec).status !== 'pending') {
      this.inviteLimiter.fail('invite', ip);
      throw new HttpError(404, 'This invite link is not valid: it was used, revoked or has expired. Ask your admin for a new one.');
    }
    return rec;
  }

  /** What an invite link offers (public; the token is the secret). */
  async checkInvite(token: unknown, meta: Meta): Promise<{ email: string | null; name: string | null; role: 'admin' | 'member'; project: { slug: string; name: string } | null; projectRole: ProjectRole | null; expiresAt: string }> {
    const i = await this.pendingInvite(token, meta.ip);
    const pname = i.projectSlug ? this.projectName(i.projectSlug) : null;
    return { email: i.email, name: i.name, role: i.role, project: i.projectSlug && pname !== null ? { slug: i.projectSlug, name: pname } : null, projectRole: pname !== null ? i.projectRole : null, expiresAt: i.expiresAt };
  }

  /** Accepts an invite: creates the account with the chosen password and signs it in. */
  async acceptInvite(input: Record<string, unknown>, meta: Meta): Promise<{ token: string; session: SessionRecord; user: AuthUser }> {
    const pg = this.pg;
    const inv = await this.pendingInvite(input.token, meta.ip);
    const email = inv.email ?? this.checkEmail(input.email);
    const name = this.checkName(input.name, inv.name ?? email.split('@')[0]) || email.split('@')[0];
    const password = this.checkNewPassword(input.password);
    if (await pg.getUserByEmail(email)) throw new HttpError(409, `A user with e-mail ${email} already exists: sign in instead`);
    const hash = await this.hashGated(password);
    let r: Awaited<ReturnType<PgAuthStore['acceptInvite']>>;
    try {
      r = await pg.acceptInvite(inv.tokenHash, { id: `usr_${newId()}`, email, name, passwordHash: hash }, (s) => this.projectExists(s));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'email_taken' || code === '23505') throw new HttpError(409, `A user with e-mail ${email} already exists: sign in instead`);
      throw err;
    }
    if (!r) throw new HttpError(404, 'This invite link is not valid: it was used, revoked or has expired. Ask your admin for a new one.');
    const user = this.userView(r.user);
    void this.audit(user, 'invite.accept', { target: inv.id, projectSlug: inv.projectSlug, ip: meta.ip, detail: { email, role: inv.role, projectRole: inv.projectRole } });
    this.changed();
    const s = await this.openSession(user, this.credOf(r.user), meta);
    await pg.updateUser(user.id, { lastLoginAt: nowIso(this.now()) });
    return s;
  }

  // ------------------------------------------------------------------ project members (Teams mode)

  async listMembers(slug: string): Promise<MemberView[]> {
    return (await this.pg.membersOf(slug)).map((m) => ({ userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, disabled: m.user.envAdmin ? false : m.user.disabled, mustChangePassword: m.user.envAdmin ? false : m.user.mustChangePassword, addedAt: m.addedAt, addedBy: m.addedBy }));
  }

  /** Users who could be added to the project: active, not yet members, not instance admins (they see every project). */
  async memberCandidates(slug: string): Promise<{ id: string; email: string; name: string }[]> {
    const pg = this.pg;
    const [users, members] = await Promise.all([pg.listUsers(), pg.membersOf(slug)]);
    const taken = new Set(members.map((m) => m.userId));
    return users.filter((u) => !u.disabled && u.role !== 'admin' && !taken.has(u.id)).map((u) => ({ id: u.id, email: u.email, name: u.name }));
  }

  async setMember(by: Principal, slug: string, input: { userId?: unknown; email?: unknown; role?: unknown }, meta: Meta, mode: 'add' | 'update'): Promise<MemberView> {
    const pg = this.pg;
    if (!this.projectExists(slug)) throw new HttpError(404, `Project "${slug}" not found`);
    const role = this.checkProjectRole(input.role);
    const u = input.userId ? await pg.getUser(str(input.userId)) : input.email ? await pg.getUserByEmail(str(input.email)) : null;
    if (!u) throw new HttpError(input.userId || input.email ? 404 : 400, input.userId || input.email ? 'User not found' : 'Send { "userId": "…", "role": "…" }');
    const before = await pg.getMember(u.id, slug);
    if (mode === 'update' && !before) throw new HttpError(404, `${u.email} is not a member of project "${slug}"`);
    if (mode === 'add' && before) throw new HttpError(409, `${u.email} is already a member of project "${slug}" (as ${before.role})`);
    await pg.setMember(u.id, slug, role, by.user?.id ?? null);
    void this.audit(by.user, before ? 'member.role' : 'member.add', { projectSlug: slug, target: u.id, ip: meta.ip, detail: { email: u.email, role, ...(before ? { from: before.role } : {}) } });
    this.changed();
    return (await this.listMembers(slug)).find((m) => m.userId === u.id)!;
  }

  async removeMember(by: Principal, slug: string, userId: string, meta: Meta): Promise<void> {
    const pg = this.pg;
    const before = await pg.getMember(userId, slug);
    if (!before) throw new HttpError(404, `User "${userId}" is not a member of project "${slug}"`);
    await pg.removeMember(userId, slug);
    void this.audit(by.user, 'member.remove', { projectSlug: slug, target: userId, ip: meta.ip, detail: { role: before.role } });
    this.changed();
  }

  // ------------------------------------------------------------------ project hooks (Teams mode)

  /** A project was deleted: its memberships go (a later project with the same slug starts with no members). */
  async onProjectDeleted(slug: string): Promise<void> {
    if (!this.teams) return;
    await this.pg.forgetProject(slug);
    for (const [s, t] of this.selfTicketOf) if (s === slug) (this.selfTicketOf.delete(s), this.selfTickets.delete(t));
    this.changed();
  }

  /** A project's slug changed: memberships follow it. */
  async onProjectRenamed(from: string, to: string): Promise<void> {
    if (!this.teams || from === to) return;
    await this.pg.renameProject(from, to);
    this.changed();
  }

  /** Factory reset: every project is gone; users stay, memberships go. */
  async onFactoryReset(): Promise<void> {
    if (!this.teams) return;
    await this.pg.forgetAllProjects();
    this.selfTicketOf.clear();
    this.selfTickets.clear();
    this.changed();
  }

  // ------------------------------------------------------------------ audit log (Teams mode)

  /** Writes an audit row (Teams mode; never throws: a failed write is logged). */
  async audit(user: AuthUser | null | undefined, action: string, o: { projectSlug?: string | null; target?: string | null; detail?: Record<string, unknown>; ip?: string | null }): Promise<void> {
    if (!this.teams) return;
    try {
      await this.pg.audit({ userId: user?.id ?? null, userEmail: user?.email ?? null, action, projectSlug: o.projectSlug ?? null, target: o.target ?? null, detail: o.detail ?? {}, ip: o.ip ?? null });
    } catch (err) {
      this.log.warn({ err: (err as Error).message, action }, 'could not write an audit log row');
    }
  }

  /** Audit rows, newest first, with filters (Teams mode; GET /api/audit and /api/projects/:slug/audit). */
  async queryAudit(f: AuditFilter): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
    return this.pg.queryAudit(f);
  }

  /** The actions that occur in the audit log (of one project, or all), for the filter list. */
  async auditActions(project: string | null): Promise<string[]> {
    return this.pg.auditActions(project);
  }

  /** Retention (STUBYARD_AUDIT_RETENTION_DAYS, maintenance job): deletes rows older than the cutoff. 0 outside Teams mode. */
  async pruneAudit(cutoffIso: string): Promise<number> {
    if (!this.teams) return 0;
    return this.pg.pruneAudit(cutoffIso);
  }

  /** What GET /api/auth/me adds in Teams mode. */
  teamsInfo(p: Principal | null): Record<string, unknown> {
    if (!this.teams) return {};
    const projects = p && p.kind !== 'internal' && !p.grants.all ? Object.fromEntries(p.grants.projects) : null;
    return {
      projects: p && p.kind !== 'internal' ? projects : null,
      roles: PROJECT_ROLES.map((id) => ({ id, ...ROLE_LABELS[id], permissions: [...ROLE_PERMISSIONS[id]] })),
      adminPermissions: [...ROLE_PERMISSIONS.admin],
      ...(p && p.kind === 'token' ? { tokenCap: p.grants.cap } : {}),
    };
  }

  get envAdminUserId(): string | null {
    return this.envAdminId;
  }
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

/**
 * Startup warnings for sign-in: sign-in over plain HTTP to another machine sends the password and the session
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
