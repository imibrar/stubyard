import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { HttpError } from '../../util.js';
import type { AuthenticatorInput } from '../../repos/authenticators.js';
import { runParam } from './runs.js';

type Params = { slug: string; id: string };

/**
 * Authenticator (TOTP) keys per project. Codes are computed on the server so automated
 * tests can fetch them too:  GET /api/projects/hyper/authenticators/code?label=Admin%202FA
 */
export async function registerAuthenticatorRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const input = (b: unknown): AuthenticatorInput => {
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return {
      label: o.label !== undefined ? String(o.label) : undefined,
      secret: o.secret !== undefined ? String(o.secret) : undefined,
      testUserId: o.testUserId === undefined ? undefined : o.testUserId ? String(o.testUserId) : null,
      issuer: o.issuer === undefined ? undefined : o.issuer === null ? null : String(o.issuer),
      account: o.account === undefined ? undefined : o.account === null ? null : String(o.account),
      algorithm: o.algorithm !== undefined ? String(o.algorithm) : undefined,
      digits: o.digits !== undefined ? Number(o.digits) : undefined,
      period: o.period !== undefined ? Number(o.period) : undefined,
    };
  };
  const totpOffset = (projectId: string, runId: string | null) => hub.clock?.offsetMs(projectId, 'totp', runId) ?? 0;
  const changed = (projectId: string, data: unknown) => hub.bus.publish({ type: 'authenticator.changed', projectId, data });

  /** All keys with their current codes. */
  app.get<{ Params: Params }>('/api/projects/:slug/authenticators', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const now = Date.now();
    const runId = runParam(hub, req, p)?.id ?? null;
    // Codes follow devhub's clock offset for "totp" (a run override applies to that run's keys); serverTime stays real.
    const offsetMs = hub.clock?.offsetMs(p.id, 'totp', runId) ?? 0;
    const items = hub.authenticators.list(p.id, runId).map((a) => ({ ...a, current: hub.authenticators.code(p.id, a.id, now + totpOffset(p.id, runId ?? a.runId)) }));
    return { serverTime: now, offsetMs, items };
  });

  /** Current code by label (handy for automated tests). */
  app.get<{ Params: Params; Querystring: { label?: string; user?: string } }>('/api/projects/:slug/authenticators/code', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const runId = runParam(hub, req, p)?.id ?? null;
    let a;
    if (req.query.user && !req.query.label) {
      const u = hub.users.requireRef(p.id, req.query.user, runId);
      a = hub.authenticators.list(p.id, runId ?? u.runId).find((x) => x.testUserId === u.id);
      if (!a) throw new HttpError(404, `No authenticator key is linked to "${u.name}"`);
    } else {
      a = hub.authenticators.findByLabel(p.id, String(req.query.label ?? ''), runId);
    }
    const offsetMs = totpOffset(p.id, runId ?? a.runId);
    return { id: a.id, label: a.label, ...hub.authenticators.code(p.id, a.id, Date.now() + offsetMs), ...(offsetMs ? { offsetMs } : {}) };
  });

  app.get<{ Params: Params }>('/api/projects/:slug/authenticators/:id/code', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const a = hub.authenticators.require(p.id, req.params.id);
    const offsetMs = totpOffset(p.id, runParam(hub, req, p)?.id ?? a.runId);
    return { id: a.id, label: a.label, ...hub.authenticators.code(p.id, a.id, Date.now() + offsetMs), ...(offsetMs ? { offsetMs } : {}) };
  });

  /** Includes the secret and an otpauth:// link (to add the same key to a phone or another tool). */
  app.get<{ Params: Params }>('/api/projects/:slug/authenticators/:id/secret', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.authenticators.withSecret(p.id, req.params.id);
  });

  app.post<{ Params: Params }>('/api/projects/:slug/authenticators', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p, { active: true });
    const a = hub.authenticators.create(p.id, { ...input(req.body), ...(run ? { runId: run.id } : {}) });
    changed(p.id, a);
    return reply.status(201).send({ ...a, current: hub.authenticators.code(p.id, a.id, Date.now() + totpOffset(p.id, a.runId)) });
  });

  app.patch<{ Params: Params }>('/api/projects/:slug/authenticators/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const a = hub.authenticators.update(p.id, req.params.id, input(req.body));
    changed(p.id, a);
    return a;
  });

  app.delete<{ Params: Params }>('/api/projects/:slug/authenticators/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const a = hub.authenticators.delete(p.id, req.params.id);
    changed(p.id, { deleted: a.id });
    return { deleted: a.id };
  });
}
