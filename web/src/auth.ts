/**
 * Sign-in (Single admin and Teams modes, docs/GUIDE.md "Sign-in"). In Open mode (no admin configured) none of this shows.
 *
 * - The session is an HttpOnly cookie; the dashboard never sees it. GET /api/auth/me tells the mode, the user and the
 *   CSRF token, which every mutating request to the hub must send as X-Stubyard-CSRF.
 * - installAuthFetch() wraps window.fetch once, so every call (api.ts, uploads, raw fetches) gets the header, and a 401
 *   from the hub (the session ended) brings back the sign-in page.
 */
import { useSyncExternalStore } from 'react';

export type AuthMode = 'open' | 'single' | 'teams';

/** Any mode with sign-in (Single admin or Teams). */
export const signInMode = (mode: AuthMode) => mode !== 'open';

export type ProjectRole = 'project_admin' | 'project_manager' | 'developer' | 'designer' | 'qa' | 'viewer';
export type InstanceRole = 'admin' | 'member';

/** Permission ids of the server's permission table (server/src/access/permissions.ts). */
export type Permission =
  | 'public'
  | 'authenticated'
  | 'self'
  | 'instance.admin'
  | 'project.settings'
  | 'project.providers'
  | 'features.edit'
  | 'features.details'
  | 'storyboards.edit'
  | 'walkthroughs.run'
  | 'project.view'
  | 'project.reset';

export interface RoleDef {
  id: ProjectRole;
  label: string;
  description: string;
  permissions: Permission[];
}

/** Fallback labels (the hub sends the authoritative list in /api/auth/me). */
export const ROLE_LABEL: Record<ProjectRole, string> = {
  project_admin: 'Project admin',
  project_manager: 'Project manager',
  developer: 'Developer',
  designer: 'Designer',
  qa: 'QA tester',
  viewer: 'Viewer',
};
export const PROJECT_ROLES = Object.keys(ROLE_LABEL) as ProjectRole[];

/** Used only if /api/auth/me sent no role list; mirrors server/src/access/permissions.ts ROLE_PERMISSIONS. */
const FALLBACK_PERMISSIONS: Record<ProjectRole, Permission[]> = {
  project_admin: ['project.settings', 'project.providers', 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view', 'project.reset'],
  project_manager: ['features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view'],
  developer: ['project.providers', 'features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view'],
  designer: ['features.details', 'project.view'],
  qa: ['features.edit', 'features.details', 'storyboards.edit', 'walkthroughs.run', 'project.view'],
  viewer: ['project.view'],
};

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  /** Teams: the account still has a temporary password and must choose a new one first. */
  mustChangePassword?: boolean;
  /** Teams: the admin from the environment (its password and role come from there). */
  envAdmin?: boolean;
}

export interface AuthState {
  /** false until GET /api/auth/me answered. */
  loaded: boolean;
  mode: AuthMode;
  user: AuthUser | null;
  csrf: string | null;
  /** Why the sign-in page shows again (session ended), if it does. */
  notice: string | null;
  /** GET /api/auth/me failed (hub not reachable). */
  error: string | null;
  /** Teams: the user's project memberships; null for an instance admin (every project) and in the other modes. */
  projects: Record<string, ProjectRole> | null;
  /** Teams: the project roles, in display order. */
  roles: RoleDef[];
  /** Teams: what an instance admin may do. */
  adminPermissions: Permission[];
}

export const CSRF_HEADER = 'X-Stubyard-CSRF';

let state: AuthState = { loaded: false, mode: 'open', user: null, csrf: null, notice: null, error: null, projects: null, roles: [], adminPermissions: [] };
const subs = new Set<() => void>();
const set = (patch: Partial<AuthState>) => {
  state = { ...state, ...patch };
  for (const f of subs) f();
};

export const getAuth = (): AuthState => state;

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

/** Whether the request goes to this hub (same origin) on a path that needs sign-in. */
function hubPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let u: URL;
  try {
    u = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (u.origin !== window.location.origin) return null;
  return u.pathname;
}

const SIGNED_IN_PATHS = /^\/(api|mcp|mailpit)(\/|$)|^\/storage\/[^/]+\/[^/]+\/__hub(\/|$)/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_PUBLIC = new Set(['/api/auth/login', '/api/auth/me']);

let installed = false;

/** Wrap window.fetch: CSRF header on mutating hub calls; a 401 from the hub ends the session in the UI. */
export function installAuthFetch(): void {
  if (installed) return;
  installed = true;
  const base = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = hubPath(input);
    if (!path || !SIGNED_IN_PATHS.test(path) || !signInMode(state.mode)) return base(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let next = init;
    if (MUTATING.has(method) && state.csrf) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, state.csrf);
      next = { ...init, headers };
    }
    const res = await base(input, next);
    if (res.status === 401 && !AUTH_PUBLIC.has(path) && state.user) set({ user: null, csrf: null, notice: 'Your session ended. Sign in again.' });
    // Teams: a temporary password blocks everything else until it is changed.
    if (res.status === 403 && state.user && !state.user.mustChangePassword) {
      void res
        .clone()
        .json()
        .then((d: { code?: string } | null) => {
          if (d?.code === 'must_change_password' && state.user) set({ user: { ...state.user, mustChangePassword: true } });
        })
        .catch(() => undefined);
    }
    return res;
  };
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    const err = new Error(d?.error ?? d?.message ?? `HTTP ${res.status}`) as Error & { status: number; retryAfter?: number };
    err.status = res.status;
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) err.retryAfter = ra;
    throw err;
  }
  return data as T;
}

/** Ask the hub who we are (on start and after sign-in / sign-out). */
export async function loadAuth(): Promise<void> {
  try {
    const me = await json<{ mode: AuthMode; user: AuthUser | null; csrf: string | null; projects?: Record<string, ProjectRole> | null; roles?: RoleDef[]; adminPermissions?: Permission[] }>(
      await fetch('/api/auth/me', { cache: 'no-store' }),
    );
    set({ loaded: true, mode: me.mode, user: me.user, csrf: me.csrf, error: null, projects: me.projects ?? null, roles: me.roles ?? [], adminPermissions: me.adminPermissions ?? [] });
  } catch (e) {
    set({ loaded: true, error: (e as Error).message });
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const r = await json<{ user: AuthUser; csrf: string }>(
    await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }),
  );
  // Remembered in memory only, so the forced "Choose a new password" form can prefill the temporary password.
  lastPassword = r.user.mustChangePassword ? password : null;
  set({ user: r.user, csrf: r.csrf, notice: null });
  // Teams: memberships and roles come with /api/auth/me.
  if (state.mode === 'teams') await loadAuth();
}

let lastPassword: string | null = null;
/** The password just typed on the sign-in page when it was a temporary one (read once). */
export function takeLastPassword(): string {
  const p = lastPassword ?? '';
  lastPassword = null;
  return p;
}

/** POST /api/auth/password: change the signed-in user's own password (Teams), then reload who we are. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await json<{ ok: true }>(await fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) }));
  await loadAuth();
}

// ---------- permissions ----------

/**
 * Whether the signed-in user may do `permission` (in project `slug`, if given). Open and Single admin modes allow
 * everything; Teams: instance admins everything, members per the role of their membership. Instance-level
 * permissions (no slug) are for instance admins only. The hub enforces the same rule; this only hides buttons.
 */
export function canIn(s: AuthState, permission: Permission, slug?: string | null): boolean {
  if (s.mode !== 'teams') return true;
  if (!s.user) return false;
  if (s.user.role === 'admin') return true;
  if (permission === 'public' || permission === 'authenticated' || permission === 'self') return true;
  if (!slug) return false;
  const role = s.projects?.[slug];
  if (!role) return false;
  const perms = s.roles.find((r) => r.id === role)?.permissions ?? FALLBACK_PERMISSIONS[role];
  return !!perms?.includes(permission);
}

export const can = (permission: Permission, slug?: string | null) => canIn(state, permission, slug);

/** Reactive can(): re-renders when the sign-in state changes. */
export function useCan(): (permission: Permission, slug?: string | null) => boolean {
  const s = useAuth();
  return (permission, slug) => canIn(s, permission, slug);
}

/**
 * Props for a control the role may not use: `<button {...gate('project.settings')}>` is disabled with a title naming
 * the role that could. Empty when allowed (always in Open / Single admin mode).
 */
export function useGate(slug?: string | null): (permission: Permission) => { disabled?: true; title?: string } {
  const s = useAuth();
  return (permission) => (canIn(s, permission, slug) ? {} : { disabled: true, title: needRole(permission) });
}

/** Teams mode and the user is an instance admin. */
export const isTeamsAdmin = (s: AuthState) => s.mode === 'teams' && s.user?.role === 'admin';

/** The label of a project role (from the hub's list, or the built-in fallback). */
export function roleLabel(role: string | null | undefined, s: AuthState = state): string {
  if (!role) return '';
  if (role === 'admin') return 'Admin';
  return s.roles.find((r) => r.id === role)?.label ?? ROLE_LABEL[role as ProjectRole] ?? role;
}

/** The project roles to offer in pickers (the hub's list, or the built-in one before it answered). */
export function roleOptions(s: AuthState = state): { id: ProjectRole; label: string; description: string }[] {
  return s.roles.length ? s.roles : PROJECT_ROLES.map((id) => ({ id, label: ROLE_LABEL[id], description: '' }));
}

/** The title of a disabled control: which role would allow it. */
export function needRole(permission: Permission): string {
  if (permission === 'instance.admin') return 'Only an instance admin can do this';
  const allowed = state.roles.filter((r) => r.permissions.includes(permission)).map((r) => r.label);
  return allowed.length ? `Your role cannot do this (needs: ${allowed.join(', ')})` : 'Your role cannot do this';
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  set({ user: null, csrf: null, notice: 'You are signed out.', projects: null });
}

// ---------- API tokens (for the browser extension, @stubyard/client, MCP, CI) ----------

export interface ApiToken {
  id: string;
  name: string;
  /** The first characters of the secret, to recognise it. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
  /** Teams: the projects the token is narrowed to (null = all of the owner's projects). */
  projects?: string[] | null;
  /** Teams: the highest role the token acts with (null = the owner's own roles). */
  maxRole?: ProjectRole | 'admin' | null;
}

export interface TokenScope {
  projects?: string[];
  maxRole?: ProjectRole | 'admin';
}

export const tokensApi = {
  list: async () => (await json<{ tokens: ApiToken[] }>(await fetch('/api/auth/tokens'))).tokens,
  create: async (name: string, expiresInDays?: number, scope?: TokenScope) =>
    json<{ token: ApiToken; secret: string }>(
      await fetch('/api/auth/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expiresInDays, ...scope }) }),
    ),
  revoke: async (id: string) => (await json<{ token: ApiToken }>(await fetch(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }))).token,
};

// ---------- invites (public) ----------

export interface InviteInfo {
  email: string | null;
  name: string | null;
  role: InstanceRole;
  project: { slug: string; name: string } | null;
  projectRole: ProjectRole | null;
  expiresAt: string;
}

const post = async <T>(path: string, body: unknown) => json<T>(await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

export const inviteApi = {
  check: (token: string) => post<InviteInfo>('/api/auth/invite/check', { token }),
  /** Creates the account and signs in (sets the session cookie), then reloads who we are. */
  accept: async (body: { token: string; name: string; password: string; email?: string }) => {
    await post<{ user: AuthUser; csrf: string }>('/api/auth/invite/accept', body);
    await loadAuth();
  },
};
