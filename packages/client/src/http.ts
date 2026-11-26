/**
 * Shared fetch layer of the browser-safe helpers (users, messages, authenticators, stream, storyboards,
 * walkthroughs). Only `fetch` is used: it runs in Node 18+, browsers and MV3 extension service workers.
 *
 *   import { hubFetch, StubyardError } from '@stubyard/client/http';
 *   const { body } = await hubFetch({ apiUrl: 'http://localhost:4000' }, 'GET', '/api/projects');
 */

export interface HubTarget {
  /** stubyard API base, default http://localhost:4000. */
  apiUrl?: string;
  project: string;
  /** Custom fetch; default globalThis.fetch. */
  fetch?: typeof fetch;
  /**
   * API token for a hub with sign-in on (dashboard → user menu → API tokens), sent as Authorization: Bearer. Default:
   * the STUBYARD_TOKEN environment variable in Node; '' sends none.
   */
  apiToken?: string;
}

export const DEFAULT_API_URL = 'http://localhost:4000';

/** The API token to send: `apiToken`, else STUBYARD_TOKEN (Node only; browsers and extensions have no env). */
export function apiTokenOf(o: { apiToken?: string }): string | undefined {
  if (o.apiToken !== undefined) return o.apiToken.trim() || undefined;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.STUBYARD_TOKEN;
  return env?.trim() || undefined;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

function headersObject(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (typeof Headers !== 'undefined' && h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

/**
 * The fetch to call the hub with: `o.fetch` (default globalThis.fetch), adding Authorization: Bearer <apiToken> to
 * requests for the hub's own origin when a token is set (other origins never get it). Without a token it is `o.fetch`
 * itself.
 */
export function hubFetchFn(o: { apiUrl?: string; fetch?: typeof fetch; apiToken?: string }): typeof fetch {
  const f = o.fetch ?? globalThis.fetch;
  const token = apiTokenOf(o);
  if (!token) return f;
  const hub = originOf(apiBase(o));
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!hub || originOf(url) !== hub) return f(input, init);
    const headers = headersObject(init?.headers);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) headers.authorization = `Bearer ${token}`;
    return f(input, { ...init, headers });
  }) as typeof fetch;
}

/** A non-2xx answer from the hub: `status`, the hub's `error` text as message, and its `details` (e.g. validation issues). */
export class StubyardError extends Error {
  status: number;
  details?: unknown;
  /** The parsed response body (JSON when it was JSON, else the text). */
  body?: unknown;
  constructor(status: number, message: string, details?: unknown, body?: unknown) {
    super(message);
    this.name = 'StubyardError';
    this.status = status;
    this.details = details;
    this.body = body;
  }
}

/** `s` without trailing "/" (a loop: /\/+$/ is quadratic on long runs of "/"). */
export function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

/** The API base without a trailing slash. */
export const apiBase = (t: { apiUrl?: string }): string => trimSlashes(t.apiUrl ?? DEFAULT_API_URL);

/** "/api/projects/<slug>" + suffix. */
export const projectPath = (t: { project: string }, suffix = ''): string => `/api/projects/${encodeURIComponent(t.project)}${suffix}`;

/** "?a=1&b=2" from the defined, non-empty values (arrays are joined with commas); "" when none. */
export const query = (o: Record<string, unknown>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Encode one path segment. */
export const seg = (s: string): string => encodeURIComponent(s);

/**
 * One JSON call to the hub. `path` is joined to the API base (a full http(s) URL is used as is).
 * A non-2xx status throws StubyardError unless it is listed in `init.allow`. The body is JSON-parsed when it
 * parses, else returned as text (undefined when empty).
 */
export async function hubFetch<T>(
  t: Pick<HubTarget, 'apiUrl' | 'fetch' | 'apiToken'>,
  method: string,
  path: string,
  body?: unknown,
  init?: { signal?: AbortSignal; allow?: number[] },
): Promise<{ status: number; body: T }> {
  const f = hubFetchFn(t);
  const url = /^https?:\/\//i.test(path) ? path : `${apiBase(t)}${path.startsWith('/') ? '' : '/'}${path}`;
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: init?.signal,
    });
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    throw new StubyardError(0, `stubyard is not reachable at ${apiBase(t)} (${method} ${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok && !init?.allow?.includes(res.status)) {
    const o = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown; details?: unknown }) : null;
    const msg = typeof o?.error === 'string' ? o.error : typeof parsed === 'string' ? parsed : res.statusText;
    throw new StubyardError(res.status, `stubyard answered ${res.status} for ${method} ${path}: ${msg}`, o?.details, parsed);
  }
  return { status: res.status, body: parsed as T };
}

/** hubFetch and return only the body. */
export async function hubJson<T>(t: Pick<HubTarget, 'apiUrl' | 'fetch' | 'apiToken'>, method: string, path: string, body?: unknown, init?: { signal?: AbortSignal }): Promise<T> {
  return (await hubFetch<T>(t, method, path, body, init)).body;
}
