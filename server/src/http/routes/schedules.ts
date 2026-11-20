import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { ALLOWED_CALLS, SCHEDULE_ACTIONS } from '../../schedules/actions.js';
import type { ScheduleStatus } from '../../schedules/repo.js';
import type { InjectFn, ScheduleInput } from '../../schedules/service.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string };
type Q = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const STATUSES: ScheduleStatus[] = ['pending', 'paused', 'done', 'failed', 'cancelled', 'missed'];
const body = (req: { body?: unknown }): Json => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && !Buffer.isBuffer(req.body) ? (req.body as Json) : {});

/** Scheduled actions under /api/projects/:slug/schedules. */
export async function registerScheduleRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const svc = hub.schedules;
  if (!svc) return;
  svc.attach(((o) => app.inject({ method: o.method as 'POST', url: o.url, payload: o.payload, headers: o.headers })) as InjectFn);
  const base = '/api/projects/:slug/schedules';
  const proj = (slug: string) => hub.projects.require(slug);

  app.get('/api/schedules/reference', async () => ({ actions: SCHEDULE_ACTIONS, allowed: ALLOWED_CALLS, statuses: STATUSES, graceMs: svc.graceMs }));

  /** ?status=pending,paused (or "active" / "finished") &run=<key> */
  app.get<{ Params: P; Querystring: Q }>(base, async (req) => {
    const p = proj(req.params.slug);
    const run = runParam(hub, req, p);
    let status: ScheduleStatus[] | undefined;
    const raw = (req.query.status ?? '').trim();
    if (raw === 'active') status = ['pending', 'paused'];
    else if (raw === 'finished') status = ['done', 'failed', 'cancelled', 'missed'];
    else if (raw) {
      status = raw.split(',').map((x) => x.trim()) as ScheduleStatus[];
      const bad = status.find((x) => !STATUSES.includes(x));
      if (bad) throw new HttpError(400, `Unknown status "${bad}". Use ${STATUSES.join(', ')}, active or finished`);
    }
    return svc.repo.list(p.id, { status, runId: run?.id }).map((s) => svc.view(s));
  });

  app.post<{ Params: P }>(base, async (req, reply) => {
    const p = proj(req.params.slug);
    const run = runParam(hub, req, p, { active: true });
    const s = svc.create(p, body(req) as ScheduleInput, run);
    return reply.status(201).send(svc.view(s));
  });

  app.post<{ Params: P }>(`${base}/flush`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const ref = b.run ? String(b.run) : '';
    const run = ref ? hub.runs.require(p.id, ref) : runParam(hub, req, p);
    return svc.flush(p, run);
  });

  app.get<{ Params: P }>(`${base}/:id`, async (req) => svc.view(svc.repo.require(proj(req.params.slug).id, req.params.id)));

  app.patch<{ Params: P }>(`${base}/:id`, async (req) => {
    const p = proj(req.params.slug);
    return svc.view(svc.update(p, req.params.id, body(req) as ScheduleInput));
  });

  app.post<{ Params: P }>(`${base}/:id/run-now`, async (req) => {
    const p = proj(req.params.slug);
    const r = await svc.runNow(p, req.params.id);
    return { schedule: svc.view(r.schedule), fire: r.fire };
  });
  app.post<{ Params: P }>(`${base}/:id/pause`, async (req) => svc.view(svc.pause(proj(req.params.slug), req.params.id)));
  app.post<{ Params: P }>(`${base}/:id/resume`, async (req) => svc.view(svc.resume(proj(req.params.slug), req.params.id)));

  /** Cancels a pending / paused schedule (returns it); deletes a finished one. */
  app.delete<{ Params: P }>(`${base}/:id`, async (req) => {
    const r = svc.remove(proj(req.params.slug), req.params.id);
    return r.cancelled ? { cancelled: true, schedule: svc.view(r.cancelled) } : { deleted: r.deleted };
  });
}
