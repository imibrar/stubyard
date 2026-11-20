import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import { LIMIT_DEFAULTS, LIMIT_MAX, THREAD_STATES } from '../../personas/types.js';
import { PERSONA_PRESETS } from '../../personas/service.js';
import type { Project } from '../../repos/projects.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});

function states(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(/[,|]/)).map((x) => String(x).trim()).filter(Boolean);
  for (const s of list) if (!(THREAD_STATES as string[]).includes(s)) throw new HttpError(400, `state "${s}" is not one of ${THREAD_STATES.join(', ')}`);
  return list;
}

/** AI personas (§AE): /api/projects/:slug/personas/… and /api/persona-presets. */
export async function registerPersonaRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.personas) return;
  const svc = hub.personas;
  const b = '/api/projects/:slug/personas';
  const proj = (slug: string) => hub.projects.require(slug);
  const runOf = (req: FastifyRequest, project: Project, active: boolean, b0: J = {}) =>
    b0.run ? (active ? hub.runs.requireActive(project.id, String(b0.run)) : hub.runs.require(project.id, String(b0.run))) : runParam(hub, req, project, { active });

  app.get('/api/persona-presets', async () => ({ presets: PERSONA_PRESETS, limits: { defaults: LIMIT_DEFAULTS, max: LIMIT_MAX }, states: THREAD_STATES }));

  app.get<{ Params: P; Querystring: Q }>(b, async (req) => {
    const project = proj(req.params.slug);
    const r = runOf(req, project, false);
    const list = r ? svc.repo.list(project.id, { runId: r.id }) : svc.repo.list(project.id, { all: req.query.all !== '0' });
    return list.map((p) => svc.view(p));
  });
  app.post<{ Params: P; Querystring: Q }>(b, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = runOf(req, project, true, b0);
    const { run: _run, ...input } = b0;
    reply.status(201);
    return svc.view(svc.create(project, input, r));
  });

  // threads (before /:id so "threads" is never read as a persona id)
  app.get<{ Params: P; Querystring: Q }>(`${b}/threads`, async (req) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const r = runOf(req, project, false);
    const persona = q.persona ? svc.require(project, q.persona) : null;
    const user = q.user ? hub.users.requireRef(project.id, q.user) : null;
    return svc.repo.threads(project.id, { personaId: persona?.id, testUserId: user?.id, state: states(q.state), runId: r?.id, limit: q.limit ? Number(q.limit) : 100 }).map((t) => svc.viewThread(t));
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/threads`, async (req) => {
    const project = proj(req.params.slug);
    const r = runOf(req, project, false);
    const persona = req.query.persona ? svc.require(project, req.query.persona) : null;
    return { deleted: svc.deleteThreads(project, { personaId: persona?.id, runId: r?.id }) };
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/threads/wait`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = runOf(req, project, false, b0);
    const persona = b0.persona ? svc.require(project, String(b0.persona)) : null;
    const user = b0.user ? hub.users.requireRef(project.id, String(b0.user), r?.id ?? null) : null;
    let goal: { id: string; is: string } | null = null;
    if (b0.goal !== undefined && b0.goal !== null) {
      const g = body(b0.goal);
      if (!g.id) throw new HttpError(400, 'goal must be {id, is: "reached" | "failed" | "open"}');
      const is = String(g.is ?? 'reached');
      if (!['reached', 'failed', 'open'].includes(is)) throw new HttpError(400, 'goal.is must be reached, failed or open');
      goal = { id: String(g.id), is };
    }
    const timeout = Math.min(60_000, Math.max(0, Number(b0.timeoutMs ?? 10_000) || 0));
    const t = await svc.waitThread(project, { personaId: persona?.id, testUserId: user?.id, state: states(b0.state), goal, after: b0.after ? String(b0.after) : undefined, runId: r?.id }, timeout);
    return { timedOut: !t, thread: t ? svc.viewThread(t) : null };
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/threads/stop`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = runOf(req, project, false, b0);
    const persona = b0.persona ? svc.require(project, String(b0.persona)) : null;
    const user = b0.user ? hub.users.requireRef(project.id, String(b0.user), r?.id ?? null) : null;
    return { stopped: svc.stopThreads(project, { personaId: persona?.id, runId: r?.id, testUserId: user?.id }) };
  });
  app.get<{ Params: P }>(`${b}/threads/:id`, async (req) => svc.threadDetail(proj(req.params.slug), req.params.id));
  app.post<{ Params: P }>(`${b}/threads/:id/stop`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewThread(svc.stopThread(project, req.params.id));
  });
  app.post<{ Params: P }>(`${b}/threads/:id/reset`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewThread(svc.resetThread(project, req.params.id));
  });

  // one persona
  app.get<{ Params: P }>(`${b}/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.view(svc.require(project, req.params.id));
  });
  const update = async (req: FastifyRequest<{ Params: P }>) => {
    const project = proj(req.params.slug);
    return svc.view(svc.update(project, req.params.id, body(req.body)));
  };
  app.patch<{ Params: P }>(`${b}/:id`, update);
  app.put<{ Params: P }>(`${b}/:id`, update);
  app.delete<{ Params: P }>(`${b}/:id`, async (req) => {
    const project = proj(req.params.slug);
    return { deleted: true, ...svc.delete(project, req.params.id) };
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/:id/assign`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = runOf(req, project, true, b0);
    reply.status(201);
    return hub.autoReplies.viewRule(svc.assign(project, req.params.id, b0, r));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/:id/start`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    return svc.start(project, req.params.id, b0, runOf(req, project, true, b0));
  });
  app.post<{ Params: P }>(`${b}/:id/test`, async (req) => svc.test(proj(req.params.slug), req.params.id, body(req.body)));
}
