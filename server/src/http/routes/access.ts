import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { AuthUser, Principal } from '../../access/service.js';
import { HttpError } from '../../util.js';

/**
 * Sign-in API (docs/GUIDE.md "Sign-in (single admin)"):
 *   POST /api/auth/login {email, password} → session cookie (+ csrf for the X-Stubyard-CSRF header)
 *   POST /api/auth/logout
 *   GET  /api/auth/me → { mode, user, csrf, via }
 *   GET/POST /api/auth/tokens, DELETE /api/auth/tokens/:id → personal API tokens (cookie session only)
 * In Open mode only /api/auth/me answers ({ mode: "open", user: null }); the rest is 404.
 */
export async function registerAccessRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const access = hub.access;
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});

  const cookie = (value: string, maxAgeSeconds: number) =>
    [`${access.cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, ...(hub.config.cookieSecure ? ['Secure'] : [])].join('; ');

  const userView = (u: AuthUser) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

  /** The signed-in account of a request (any kind but internal), else 401. */
  const userOf = (req: FastifyRequest): { user: AuthUser; principal: Exclude<Principal, { kind: 'internal' }> } => {
    if (!access.enabled) throw new HttpError(404, 'Sign-in is not enabled on this stubyard (Open mode)');
    const p = req.principal;
    if (!p || p.kind === 'internal') throw new HttpError(401, 'Sign in required');
    return { user: p.user, principal: p };
  };

  /** API tokens are managed from a dashboard session only, so a leaked token cannot mint more tokens. */
  const sessionUser = (req: FastifyRequest): AuthUser => {
    const { user, principal } = userOf(req);
    if (principal.kind !== 'session') throw new HttpError(403, 'Manage API tokens from the dashboard (signed in with your password), not with an API token');
    return user;
  };

  app.post('/api/auth/login', async (req, reply: FastifyReply) => {
    const b = body(req.body);
    try {
      const { token, session, user } = await access.login(b.email, b.password, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      const maxAge = Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
      reply.header('set-cookie', cookie(token, maxAge)).header('cache-control', 'no-store');
      return { user: userView(user), csrf: session.csrf, expiresAt: session.expiresAt };
    } catch (err) {
      const retry = (err as { retryAfter?: number }).retryAfter;
      if (retry) reply.header('retry-after', String(retry));
      throw err;
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const { principal } = userOf(req);
    if (principal.kind === 'session') await access.logout(principal.sessionId);
    reply.header('set-cookie', cookie('', 0));
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const p = req.principal;
    const signedIn = p && p.kind !== 'internal' ? p : null;
    return {
      mode: access.mode,
      user: signedIn ? userView(signedIn.user) : null,
      csrf: signedIn?.kind === 'session' ? signedIn.csrf : null,
      via: signedIn?.kind ?? null,
    };
  });

  app.get('/api/auth/tokens', async (req) => ({ tokens: await access.listTokens(sessionUser(req)) }));

  app.post('/api/auth/tokens', async (req, reply) => {
    const user = sessionUser(req);
    const r = await access.createToken(user, body(req.body));
    reply.header('cache-control', 'no-store');
    return reply.status(201).send(r);
  });

  app.delete<{ Params: { id: string } }>('/api/auth/tokens/:id', async (req) => ({ token: await access.revokeToken(sessionUser(req), req.params.id) }));
}
