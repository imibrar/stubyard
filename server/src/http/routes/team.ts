import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Principal } from '../../access/service.js';
import { HttpError } from '../../util.js';

type Json = Record<string, unknown>;
const body = (b: unknown): Json => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as Json) : {});

/**
 * Teams mode (docs/GUIDE.md "Teams"): users and invite links (instance admins, /api/team), and project members
 * (/api/projects/:slug/members: any member reads, project admins change). The permission table guards every route;
 * the service validates the rest. In Open and Single admin mode they answer 404.
 */
export async function registerTeamRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const access = hub.access;
  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
  const who = (req: FastifyRequest): Principal => {
    if (!access.teams) throw new HttpError(404, 'Teams mode only: set STUBYARD_DATABASE_URL (with the env admin) to manage users and project members');
    if (!req.principal) throw new HttpError(401, 'Sign in required');
    return req.principal;
  };

  // ---------------------------------------------------------------- users
  app.get('/api/team/users', async (req) => {
    who(req);
    return { users: await access.listUsers() };
  });

  app.post('/api/team/users', async (req, reply) => {
    const r = await access.createUser(who(req), body(req.body), meta(req));
    reply.header('cache-control', 'no-store');
    return reply.status(201).send(r);
  });

  app.get<{ Params: { id: string } }>('/api/team/users/:id', async (req) => {
    who(req);
    return { user: await access.getTeamUser(req.params.id) };
  });

  app.patch<{ Params: { id: string } }>('/api/team/users/:id', async (req) => ({ user: await access.updateUser(who(req), req.params.id, body(req.body), meta(req)) }));

  app.post<{ Params: { id: string } }>('/api/team/users/:id/reset-password', async (req, reply) => {
    const r = await access.resetPassword(who(req), req.params.id, body(req.body), meta(req));
    reply.header('cache-control', 'no-store');
    return r;
  });

  // ---------------------------------------------------------------- invite links
  app.get('/api/team/invites', async (req) => {
    who(req);
    return { invites: await access.listInvites() };
  });

  app.post('/api/team/invites', async (req, reply) => {
    const r = await access.createInvite(who(req), body(req.body), meta(req));
    reply.header('cache-control', 'no-store');
    return reply.status(201).send(r);
  });

  app.delete<{ Params: { id: string } }>('/api/team/invites/:id', async (req) => ({ invite: await access.revokeInvite(who(req), req.params.id, meta(req)) }));

  // ---------------------------------------------------------------- project members
  const B = '/api/projects/:slug/members';
  type P = { slug: string; userId: string };
  const proj = (slug: string) => hub.projects.require(slug).slug;

  app.get<{ Params: P }>(B, async (req) => {
    const p = who(req);
    const slug = proj(req.params.slug);
    return { members: await access.listMembers(slug), canManage: access.can(p, 'project.settings', slug) };
  });

  app.get<{ Params: P }>(`${B}/candidates`, async (req) => {
    who(req);
    return { users: await access.memberCandidates(proj(req.params.slug)) };
  });

  app.post<{ Params: P }>(B, async (req, reply) => {
    const member = await access.setMember(who(req), proj(req.params.slug), body(req.body), meta(req), 'add');
    return reply.status(201).send({ member });
  });

  app.patch<{ Params: P }>(`${B}/:userId`, async (req) => {
    const b = body(req.body);
    return { member: await access.setMember(who(req), proj(req.params.slug), { userId: req.params.userId, role: b.role }, meta(req), 'update') };
  });

  app.delete<{ Params: P }>(`${B}/:userId`, async (req) => {
    await access.removeMember(who(req), proj(req.params.slug), req.params.userId, meta(req));
    return { removed: req.params.userId };
  });
}
