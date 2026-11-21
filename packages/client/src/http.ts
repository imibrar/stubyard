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
}

export const DEFAULT_API_URL = 'http://localhost:4000';

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

/** The API base without a trailing slash. */
export const apiBase = (t: { apiUrl?: string }): string => (t.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');

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
  t: Pick<HubTarget, 'apiUrl' | 'fetch'>,
  method: string,
  path: string,
  body?: unknown,
  init?: { signal?: AbortSignal; allow?: number[] },
): Promise<{ status: number; body: T }> {
  const f = t.fetch ?? globalThis.fetch;
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
export async function hubJson<T>(t: Pick<HubTarget, 'apiUrl' | 'fetch'>, method: string, path: string, body?: unknown, init?: { signal?: AbortSignal }): Promise<T> {
  return (await hubFetch<T>(t, method, path, body, init)).body;
}
