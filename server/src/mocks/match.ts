import { randomUUID } from 'node:crypto';

/** What a mock matches on, besides method and path. */
export interface MockMatch {
  /** Query parameters that must be present with this value ("*" = any value). */
  query?: Record<string, string>;
  /** Request headers (case-insensitive names) that must have this value ("*" = any value). */
  headers?: Record<string, string>;
  /** The raw request body must contain this text. */
  bodyContains?: string | null;
  /** JSON body fields (dot paths, e.g. "user.email" or "items.0.sku") that must equal these values ("*" = present). */
  bodyJson?: Record<string, unknown>;
}

/** The request as the matcher sees it. `path` is relative to /mock/<project>/api (always starts with "/"). */
export interface MockRequestInfo {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  rawBody: string;
  /** Parsed JSON / form body, or undefined. */
  body: unknown;
}

export interface MatchResult {
  ok: boolean;
  params: Record<string, string>;
  /** Why it did not match (for the 404 response and the dashboard). */
  reason?: string;
}

const patternCache = new Map<string, { re: RegExp; names: string[] }>();

/**
 * Path patterns: "/users/:id", "/files/*" ("*" matches the rest, available as params["*"]), "/v1/:a/items/:b".
 * A trailing slash is ignored on both sides.
 */
export function compilePath(pattern: string): { re: RegExp; names: string[] } {
  let c = patternCache.get(pattern);
  if (c) return c;
  const names: string[] = [];
  const norm = normalizePath(pattern);
  const src = norm
    .split('/')
    .map((seg) => {
      if (seg === '*') {
        names.push('*');
        return '(.*)';
      }
      if (seg.startsWith(':') && seg.length > 1) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      // Allow "*" inside a segment as a wildcard, e.g. "/files/*.png".
      return seg
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*');
    })
    .join('/')
    // "/files/*" should also match "/files"
    .replace(/\/\(\.\*\)$/, '(?:/(.*))?');
  c = { re: new RegExp(`^${src}$`, 'i'), names };
  patternCache.set(pattern, c);
  return c;
}

export function normalizePath(p: string): string {
  let s = '/' + String(p ?? '').trim().replace(/^\/+/, '');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const { re, names } = compilePath(pattern);
  const m = re.exec(normalizePath(path));
  if (!m) return null;
  const params: Record<string, string> = {};
  names.forEach((n, i) => {
    const v = m[i + 1];
    params[n] = v === undefined ? '' : safeDecode(v);
  });
  return params;
}

export function methodMatches(method: string, actual: string): boolean {
  const m = method.toUpperCase();
  if (m === 'ANY' || m === '*' || m === '') return true;
  return m.split(/[,\s|]+/).includes(actual.toUpperCase());
}

/** Does this mock accept the request? */
export function matchMock(mock: { method: string; path: string; match: MockMatch }, req: MockRequestInfo): MatchResult {
  const params = matchPath(mock.path, req.path);
  if (!params) return { ok: false, params: {}, reason: 'path differs' };
  if (!methodMatches(mock.method, req.method)) return { ok: false, params, reason: `method is ${mock.method}` };
  const m = mock.match ?? {};
  for (const [k, want] of Object.entries(m.query ?? {})) {
    const got = first(req.query[k]);
    if (got === undefined) return { ok: false, params, reason: `query "${k}" missing` };
    if (!valueEquals(want, got)) return { ok: false, params, reason: `query "${k}" is not "${want}"` };
  }
  for (const [k, want] of Object.entries(m.headers ?? {})) {
    const got = first(req.headers[k.toLowerCase()]);
    if (got === undefined) return { ok: false, params, reason: `header "${k}" missing` };
    if (!valueEquals(want, got)) return { ok: false, params, reason: `header "${k}" is not "${want}"` };
  }
  if (m.bodyContains && !req.rawBody.includes(m.bodyContains)) return { ok: false, params, reason: `body does not contain "${m.bodyContains}"` };
  for (const [p, want] of Object.entries(m.bodyJson ?? {})) {
    const got = getPath(req.body, p);
    if (got === undefined) return { ok: false, params, reason: `body.${p} missing` };
    if (!valueEquals(want, got)) return { ok: false, params, reason: `body.${p} is not ${JSON.stringify(want)}` };
  }
  return { ok: true, params };
}

/** "*" = any value; otherwise compare as JSON, falling back to string comparison ("42" equals 42). */
function valueEquals(want: unknown, got: unknown): boolean {
  if (want === '*') return true;
  if (JSON.stringify(want) === JSON.stringify(got)) return true;
  const a = typeof want === 'object' && want !== null ? JSON.stringify(want) : String(want);
  const b = typeof got === 'object' && got !== null ? JSON.stringify(got) : String(got);
  return a === b;
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** Read "a.b.0.c" (or "a[0].c") from an object. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface TemplateContext {
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  method: string;
  path: string;
  /** Clock for {{now}} / {{timestamp}} in ms (default: real time); the handler passes the "mocks" time offset. */
  nowMs?: number;
}

/**
 * Fill {{params.x}} {{query.x}} {{headers.x}} {{body.a.b}} {{body}} {{uuid}} {{now}} {{timestamp}} {{method}} {{path}}.
 * Missing values become an empty string; objects are inserted as JSON.
 */
export function renderTemplate(tpl: string, ctx: TemplateContext): string {
  if (!tpl || !tpl.includes('{{')) return tpl ?? '';
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_all, expr: string) => {
    const v = resolveExpr(expr, ctx);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function resolveExpr(expr: string, ctx: TemplateContext): unknown {
  switch (expr) {
    case 'uuid':
      return randomUUID();
    case 'now':
      return new Date(ctx.nowMs ?? Date.now()).toISOString();
    case 'timestamp':
      return Math.floor((ctx.nowMs ?? Date.now()) / 1000);
    case 'method':
      return ctx.method;
    case 'path':
      return ctx.path;
    case 'body':
      return ctx.body;
  }
  const dot = expr.indexOf('.');
  if (dot < 0) return undefined;
  const root = expr.slice(0, dot);
  const rest = expr.slice(dot + 1);
  switch (root) {
    case 'params':
      return ctx.params[rest];
    case 'query':
      return first(ctx.query[rest]);
    case 'headers':
      return first(ctx.headers[rest.toLowerCase()]);
    case 'body':
      return getPath(ctx.body, rest);
    default:
      return undefined;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
