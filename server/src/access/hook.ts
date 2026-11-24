import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import http from 'node:http';
import type { Hub } from '../hub.js';
import { decodedPath } from '../http/guard.js';
import { ACTING_HEADER, CSRF_HEADER, type Principal } from './service.js';
import { safeEqual } from './password.js';
import { routeAccess, STORAGE_HUB_ACCESS, STORAGE_ROUTE, type RouteAccess } from './permissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who made the request (sign-in on): set by the access hook on protected routes; null when anonymous. */
    principal?: Principal | null;
  }
  interface FastifyContextConfig {
    /** Access rule per HTTP method, from the permission table (access/permissions.ts). */
    access?: Record<string, RouteAccess | 'open' | null>;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** What a user with a temporary password may still call (method + route pattern). */
const MUST_CHANGE_ALLOWED = new Set(['GET /api/auth/me', 'POST /api/auth/logout', 'POST /api/auth/password']);

const roleHint = (role: string | null) => (role ? `Your role in this project is "${role}"; ask a project admin for a role that includes it.` : undefined);
const routesOf = new WeakMap<FastifyInstance, { method: string; url: string }[]>();

/** Every route registered on the app (method + pattern), recorded by the access hook; used by the completeness test. */
export function registeredRoutes(app: FastifyInstance): { method: string; url: string }[] {
  return routesOf.get(app) ?? [];
}

/** Value of one cookie from a Cookie header (first match), or null. */
export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/** A Cookie header without the named cookies (for logs). Undefined when nothing is left. */
export function withoutCookies(header: string, names: string[]): string | undefined {
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !names.includes(p.slice(0, Math.max(0, p.indexOf('='))).trim()));
  return kept.length ? kept.join('; ') : undefined;
}

/** app.inject() requests (stubyard calling its own API: MCP tools, scheduled actions, chat tools) are not sockets. */
function isInjected(req: FastifyRequest): boolean {
  return !(req.raw instanceof http.IncomingMessage);
}


const isDashboardPath = (p: string) => p === '/api' || p.startsWith('/api/') || p === '/mcp' || p === '/mailpit' || p.startsWith('/mailpit/');

/**
 * Sign-in enforcement (only when sign-in is on). Every route carries its rule from the permission table, attached
 * when the route is registered, so the check follows the route that will actually run (not the raw URL):
 *   - "open" routes (app-facing: /mock, /hook, /auth, /storage, /pay, /llm, /push; static files) pass untouched,
 *     except the dashboard's storage upload (…/__hub/…);
 *   - "public" routes pass; a valid cookie or token still sets req.principal;
 *   - everything else needs a session cookie or Authorization: Bearer <API token> (401), the CSRF header for
 *     mutating cookie requests (403), and the route's permission (403; a route without a rule is refused).
 * Must be registered before any route.
 */
export function registerAccess(app: FastifyInstance, hub: Hub): void {
  const routes: { method: string; url: string }[] = [];
  routesOf.set(app, routes);
  app.addHook('onRoute', (opts) => {
    const methods = (Array.isArray(opts.method) ? opts.method : [opts.method]).map((m) => String(m).toUpperCase());
    const access: Record<string, RouteAccess | 'open' | null> = { ...(opts.config?.access ?? {}) };
    for (const m of methods) {
      access[m] = routeAccess(m, opts.url);
      routes.push({ method: m, url: opts.url });
    }
    opts.config = { ...(opts.config ?? {}), access };
  });

  const access = hub.access;
  if (!access.enabled) return;

  const deny = (reply: FastifyReply, status: number, error: string, hint?: string) => {
    if (status === 401) reply.header('www-authenticate', 'Bearer realm="stubyard"');
    return reply.status(status).send({ error, ...(hint ? { hint } : {}) });
  };

  app.addHook('onRequest', async (req, reply) => {
    req.principal = null;
    let rule: RouteAccess | 'open' | null;
    if (req.is404) {
      // No route: only the dashboard paths ask for sign-in (an anonymous caller learns nothing about which exist).
      if (!isDashboardPath(decodedPath(req.url))) return;
      rule = { permission: 'authenticated', scope: 'none' };
    } else {
      const url = req.routeOptions.url ?? '';
      const map = req.routeOptions.config?.access;
      const found = map?.[req.method] ?? (req.method === 'HEAD' ? map?.GET : undefined);
      rule = found !== undefined ? found : routeAccess(req.method, url);
      if (rule === 'open') {
        const rest = String((req.params as Record<string, unknown> | undefined)?.['*'] ?? '');
        if (url === STORAGE_ROUTE && rest.split('/')[0] === '__hub') rule = STORAGE_HUB_ACCESS;
        else return;
      }
    }

    let principal: Principal | null = null;
    const injected = isInjected(req);
    if (injected) {
      // stubyard calling its own API. With an acting ticket (Teams mode) the call runs for that user, with their
      // grants; without one it is stubyard itself (Open / Single admin mode, system jobs), as in T1.
      const ticket = req.headers[ACTING_HEADER];
      if (typeof ticket !== 'string' || !ticket) {
        req.principal = { kind: 'internal', user: null };
        return;
      }
      principal = await access.redeemActing(ticket);
      if (!principal) return deny(reply, 401, 'The account this call was made for has no access any more (signed out, disabled or token revoked)');
    } else {
      const authz = req.headers.authorization;
      if (typeof authz === 'string' && authz.trim()) {
        const m = /^Bearer\s+(\S+)\s*$/i.exec(authz.trim());
        principal = m ? await access.bearerPrincipal(m[1], req.socket?.remoteAddress) : null;
        if (!principal && rule?.permission !== 'public') {
          return deny(reply, 401, m ? 'This API token is not valid (unknown, revoked or expired)' : 'Use Authorization: Bearer <API token>', 'Create an API token in the dashboard: user menu → API tokens.');
        }
      } else {
        const token = readCookie(req.headers.cookie, access.cookieName);
        if (token) principal = await access.sessionPrincipal(token);
      }
    }
    req.principal = principal;

    if (rule?.permission === 'public') return;
    if (!principal) return deny(reply, 401, 'Sign in required', 'Sign in on the dashboard, or send Authorization: Bearer <API token> (dashboard → user menu → API tokens).');
    if (principal.kind === 'session' && MUTATING.has(req.method)) {
      const sent = req.headers[CSRF_HEADER];
      if (typeof sent !== 'string' || !safeEqual(sent, principal.csrf)) {
        return deny(reply, 403, 'Missing or wrong X-Stubyard-CSRF header', 'Dashboard calls send the token from GET /api/auth/me; scripts should use an API token (Authorization: Bearer) instead of the cookie.');
      }
    }
    // Teams mode: a temporary password must be replaced before anything else (sessions and tokens alike).
    // Sessions only: a temporary password gates the dashboard; API tokens are separate credentials.
    if (principal.kind === 'session' && principal.user?.mustChangePassword && !MUST_CHANGE_ALLOWED.has(`${req.method === 'HEAD' ? 'GET' : req.method} ${req.routeOptions.url}`)) {
      return reply.status(403).send({ error: 'Choose a new password first: you signed in with a temporary password', code: 'must_change_password', hint: 'POST /api/auth/password { "currentPassword": "…", "newPassword": "…" } (the dashboard asks for it).' });
    }
    if (rule === null) return deny(reply, 403, `No permission is defined for ${req.method} ${req.routeOptions.url}; refused while sign-in is on`);
    if (rule.scope === 'path') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const slug = String(params.slug ?? params.project ?? '');
      if (!access.can(principal, rule.permission, slug)) {
        // Not a member: the project does not exist as far as this caller can tell (same answer as an unknown slug).
        if (!access.can(principal, 'project.view', slug)) return reply.status(404).send({ error: `Project "${slug}" not found` });
        return deny(reply, 403, `You do not have the "${rule.permission}" permission in project "${slug}"`, roleHint(access.roleIn(principal, slug)));
      }
      return;
    }
    if (rule.scope === 'record') {
      // The handler checks the record's own project (access.sees / access.can); here: the permission somewhere.
      if (!access.canAnywhere(principal, rule.permission)) return deny(reply, 403, `You do not have the "${rule.permission}" permission`);
      return;
    }
    if (!access.can(principal, rule.permission, null)) return deny(reply, 403, `You do not have the "${rule.permission}" permission`);
  });
}
