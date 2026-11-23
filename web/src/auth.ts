/**
 * Sign-in (Single admin mode, docs/GUIDE.md "Sign-in"). In Open mode (no admin configured) none of this shows.
 *
 * - The session is an HttpOnly cookie; the dashboard never sees it. GET /api/auth/me tells the mode, the user and the
 *   CSRF token, which every mutating request to the hub must send as X-Stubyard-CSRF.
 * - installAuthFetch() wraps window.fetch once, so every call (api.ts, uploads, raw fetches) gets the header, and a 401
 *   from the hub (the session ended) brings back the sign-in page.
 */
import { useSyncExternalStore } from 'react';

export type AuthMode = 'open' | 'single';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
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
}

export const CSRF_HEADER = 'X-Stubyard-CSRF';

let state: AuthState = { loaded: false, mode: 'open', user: null, csrf: null, notice: null, error: null };
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
    if (!path || !SIGNED_IN_PATHS.test(path) || state.mode !== 'single') return base(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let next = init;
    if (MUTATING.has(method) && state.csrf) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (!headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, state.csrf);
      next = { ...init, headers };
    }
    const res = await base(input, next);
    if (res.status === 401 && !AUTH_PUBLIC.has(path) && state.user) set({ user: null, csrf: null, notice: 'Your session ended. Sign in again.' });
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
    const me = await json<{ mode: AuthMode; user: AuthUser | null; csrf: string | null }>(await fetch('/api/auth/me', { cache: 'no-store' }));
    set({ loaded: true, mode: me.mode, user: me.user, csrf: me.csrf, error: null });
  } catch (e) {
    set({ loaded: true, error: (e as Error).message });
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const r = await json<{ user: AuthUser; csrf: string }>(
    await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }),
  );
  set({ user: r.user, csrf: r.csrf, notice: null });
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
  set({ user: null, csrf: null, notice: 'You are signed out.' });
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
}

export const tokensApi = {
  list: async () => (await json<{ tokens: ApiToken[] }>(await fetch('/api/auth/tokens'))).tokens,
  create: async (name: string, expiresInDays?: number) =>
    json<{ token: ApiToken; secret: string }>(await fetch('/api/auth/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expiresInDays }) })),
  revoke: async (id: string) => (await json<{ token: ApiToken }>(await fetch(`/api/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }))).token,
};
