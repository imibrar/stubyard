/**
 * stubyard login-provider helpers for end-to-end tests (Playwright or anything with a fetch).
 *
 *   import { loginAs, getTokens } from '@stubyard/client/auth';
 *   await loginAs(page.context(), { baseUrl: 'https://localhost:4443', project: 'hyper', provider: 'google', user: 'admin' });
 *   await page.click('text=Sign in with Google');   // stubyard skips its account picker and signs in as "admin"
 *
 * Without the cookie the picker is shown; it exposes data-testid="stubyard-user-<id>" buttons and "stubyard-deny".
 */

/** The part of a Playwright BrowserContext the helpers need (no dependency on @playwright/test). */
export interface CookieContext {
  addCookies(cookies: { name: string; value: string; domain?: string; path?: string; url?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }[]): Promise<void>;
  clearCookies?(filter?: { name?: string; domain?: string; path?: string }): Promise<void>;
}

export interface LoginAsOptions {
  /** Browser base of stubyard (STUBYARD_PUBLIC_URL), default https://localhost:4443. */
  baseUrl?: string;
  project: string;
  /** Login provider slug; omit to apply to every provider of the project. */
  provider?: string;
  /** Test user: id, email, name or role. */
  user: string;
}

export const LOGIN_AS_COOKIE = 'stubyard_login_as';

function cookieTarget(o: { baseUrl?: string; project: string; provider?: string }) {
  const base = new URL(o.baseUrl ?? 'https://localhost:4443');
  return { domain: base.hostname, path: `/auth/${encodeURIComponent(o.project)}${o.provider ? `/${encodeURIComponent(o.provider)}` : ''}`, secure: base.protocol === 'https:' };
}

/** Make the next authorize request at the fake provider sign in as `user` without showing the picker. */
export async function loginAs(context: CookieContext, o: LoginAsOptions): Promise<void> {
  const t = cookieTarget(o);
  await context.addCookies([{ name: LOGIN_AS_COOKIE, value: encodeURIComponent(o.user), domain: t.domain, path: t.path, httpOnly: false, secure: t.secure, sameSite: 'Lax' }]);
}

/** Remove the cookie set by loginAs (Playwright ≥ 1.43 supports filtered clearCookies). */
export async function clearLoginAs(context: CookieContext, o: Omit<LoginAsOptions, 'user'>): Promise<void> {
  const t = cookieTarget(o);
  await context.clearCookies?.({ name: LOGIN_AS_COOKIE, domain: t.domain, path: t.path });
}

export interface TokenOptions {
  /** stubyard API base (dashboard / control API), default http://localhost:4000. */
  apiUrl?: string;
  project: string;
  provider: string;
  user: string;
  clientId?: string;
  scope?: string;
  nonce?: string;
  audience?: string;
  expiresIn?: number;
  /** Extra claims merged into the id_token (and JWT access tokens). */
  claims?: Record<string, unknown>;
  /** Scenario effects, e.g. "no_email", "wrong_aud", "short_lived=5". */
  scenario?: string;
  refresh?: boolean;
  /** Base used for `iss` (default: the browser base). Use the URL your backend validates against, e.g. https://stubyard:4443. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface Tokens {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number | null;
  scope: string;
  sub: string;
  claims: Record<string, unknown> | null;
  issuer: string;
}

async function post<T>(o: { apiUrl?: string; fetch?: typeof fetch }, path: string, body: unknown): Promise<T> {
  const f = o.fetch ?? fetch;
  const res = await f(`${(o.apiUrl ?? 'http://localhost:4000').replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`stubyard ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Tokens for a test user, exactly as the provider's token endpoint would issue them — no browser involved. */
export function getTokens(o: TokenOptions): Promise<Tokens> {
  const { apiUrl, project, provider, fetch: f, ...body } = o;
  return post<Tokens>({ apiUrl, fetch: f }, `/api/projects/${encodeURIComponent(project)}/auth/${encodeURIComponent(provider)}/token`, body);
}

export interface CodeOptions {
  apiUrl?: string;
  project: string;
  provider: string;
  user: string;
  clientId?: string;
  redirectUri: string;
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  scope?: string;
  scenario?: string;
  fetch?: typeof fetch;
}

/** An authorization code plus the callback URL to open, so the app performs the real code exchange. */
export function getAuthorizationCode(o: CodeOptions): Promise<{ code: string; redirectTo: string; expiresAt: string | null }> {
  const { apiUrl, project, provider, fetch: f, ...body } = o;
  return post({ apiUrl, fetch: f }, `/api/projects/${encodeURIComponent(project)}/auth/${encodeURIComponent(provider)}/code`, body);
}
