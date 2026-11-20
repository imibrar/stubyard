import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AUTO_REPLY_PRESETS, FIRE_STATUSES, LOOP_LIMIT, LOOP_WINDOW_MS, TEMPLATE_VARIABLES, TRIGGER_STATUSES } from '../../autoreplies/service.js';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});

function statuses(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const list = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  for (const s of list) if (!(FIRE_STATUSES as string[]).includes(s)) throw new HttpError(400, `status "${s}" is not one of ${FIRE_STATUSES.join(', ')}`);
  return list;
}

/** Scripted auto-replies: /api/projects/:slug/auto-replies/… (rules, fires, dry run, flush) and /api/auto-reply-presets. */
export async function registerAutoReplyRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.autoReplies) return;
  const svc = hub.autoReplies;
  const b = '/api/projects/:slug/auto-replies';
  const proj = (slug: string) => hub.projects.require(slug);
  /** Run from ?run= / X-Hub-Run, or from a body field "run". */
  const runOf = (req: FastifyRequest, project: Project, active: boolean, b0: J = {}) =>
    b0.run ? (active ? hub.runs.requireActive(project.id, String(b0.run)) : hub.runs.require(project.id, String(b0.run))) : runParam(hub, req, project, { active });

  app.get('/api/auto-reply-presets', async () => ({
    presets: AUTO_REPLY_PRESETS,
    variables: TEMPLATE_VARIABLES,
    triggerStatuses: TRIGGER_STATUSES,
    loopGuard: { fires: LOOP_LIMIT, windowSeconds: LOOP_WINDOW_MS / 1000 },
  }));

  // rules
  app.get<{ Params: P; Querystring: Q }>(b, async (req) => {
    const project = proj(req.params.slug);
    const r = runOf(req, project, false);
    const list = r ? svc.repo.listRules(project.id, { runId: r.id }) : svc.repo.listRules(project.id, { all: req.query.all !== '0' });
    return list.map((x) => svc.viewRule(x));
  });
  app.post<{ Params: P; Querystring: Q }>(b, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = runOf(req, project, true, b0);
    const { run: _run, ...input } = b0;
    reply.status(201);
    return svc.viewRule(svc.createRule(project, input, r));
  });
  app.delete<{ Params: P; Querystring: Q }>(b, async (req) => {
    const project = proj(req.params.slug);
    return { deleted: svc.deleteRules(project, runOf(req, project, false)) };
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/reorder`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    return svc.reorder(project, b0.ids, runOf(req, project, false, b0)).map((x) => svc.viewRule(x));
  });

  // dry run
  app.post<{ Params: P }>(`${b}/test`, async (req) => svc.test(proj(req.params.slug), body(req.body)));

  // fires
  app.get<{ Params: P; Querystring: Q }>(`${b}/fires`, async (req) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const r = runOf(req, project, false);
    const user = q.user ? hub.users.requireRef(project.id, q.user) : null;
    return svc.repo
      .listFires(project.id, { ruleId: q.rule || undefined, runId: r?.id, status: statuses(q.status), testUserId: user?.id, after: q.after || undefined, limit: q.limit ? Number(q.limit) : 50 })
      .map((f) => svc.viewFire(f));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/fires/wait`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = runOf(req, project, false, b0);
    const user = b0.user ? hub.users.requireRef(project.id, String(b0.user)) : null;
    const timeout = Math.min(60_000, Math.max(0, Number(b0.timeoutMs ?? 10_000) || 0));
    const after = b0.after ? String(b0.after) : undefined;
    const f = await svc.waitFire(project, { ruleId: b0.rule ? String(b0.rule) : undefined, status: statuses(b0.status), after, runId: r?.id, testUserId: user?.id }, timeout);
    const newest = svc.repo.listFires(project.id, { limit: 1 })[0]?.id ?? null;
    return { timedOut: !f, fire: f ? svc.viewFire(f) : null, cursor: f?.id ?? newest ?? after ?? null };
  });
  app.get<{ Params: P }>(`${b}/fires/:id`, async (req) => {
    const project = proj(req.params.slug);
    const f = svc.repo.getFire(project.id, req.params.id);
    if (!f) throw new HttpError(404, `Auto-reply fire "${req.params.id}" not found`);
    return svc.viewFire(f);
  });
  app.delete<{ Params: P }>(`${b}/fires/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewFire(svc.cancelFire(project, req.params.id));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/flush`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const fired = await svc.flush(project, runOf(req, project, false, b0));
    return { fired: fired.map((f) => svc.viewFire(f)) };
  });

  // one rule
  app.get<{ Params: P }>(`${b}/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewRule(svc.requireRule(project, req.params.id));
  });
  const update = async (req: FastifyRequest<{ Params: P }>) => {
    const project = proj(req.params.slug);
    return svc.viewRule(svc.updateRule(project, req.params.id, body(req.body)));
  };
  app.patch<{ Params: P }>(`${b}/:id`, update);
  app.put<{ Params: P }>(`${b}/:id`, update);
  app.delete<{ Params: P }>(`${b}/:id`, async (req, reply) => {
    const project = proj(req.params.slug);
    svc.deleteRule(project, req.params.id);
    return reply.status(204).send();
  });
}
