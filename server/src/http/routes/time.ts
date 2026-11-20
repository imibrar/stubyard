import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import type { Run } from '../../repos/runs.js';
import { HttpError } from '../../util.js';
import { TIME_FEATURES, cleanOffsets, formatOffset, isTimeFeature, parseOffset, type TimeOffsets } from '../../clock/clock.js';
import { runParam } from './runs.js';

type P = { slug: string };

/**
 * Per-feature time offsets (stubyard's clock only): GET / PUT / DELETE /api/projects/:slug/time.
 * ?run=<key> or X-Hub-Run targets that (active) run's override instead of the project setting.
 */
export async function registerTimeRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const view = (p: Project, run: Run | null) => {
    const clock = hub.clock;
    const offsets = clock ? clock.projectOffsets(p.id) : {};
    const runOffsets = run && clock ? clock.runOffsets(p.id, run.id) : {};
    const eff = clock ? clock.effective(p.id, run?.id) : ({} as Record<string, number>);
    const now = Date.now();
    const effective: Record<string, string> = {};
    const effectiveOffsets: Record<string, number> = {};
    const human: Record<string, string> = {};
    for (const f of TIME_FEATURES) {
      effectiveOffsets[f] = eff[f] ?? 0;
      effective[f] = new Date(now + (eff[f] ?? 0)).toISOString();
      if (eff[f]) human[f] = formatOffset(eff[f]);
    }
    return {
      serverTime: new Date(now).toISOString(),
      features: TIME_FEATURES,
      offsets,
      ...(run ? { run: { id: run.id, key: run.key, status: run.status, offsets: runOffsets } } : {}),
      effective,
      effectiveOffsets,
      active: human,
    };
  };

  /** Run named by ?run= / X-Hub-Run (must be active to change it). */
  const target = (req: FastifyRequest, p: Project, write: boolean) => runParam(hub, req, p, write ? { active: true } : {});

  const save = (p: Project, run: Run | null, offsets: TimeOffsets) => {
    const clean = cleanOffsets(offsets);
    const value = Object.keys(clean).length ? clean : undefined;
    if (run) {
      const updated = hub.runs.repo.update(run.id, { meta: { ...run.meta, timeOffsets: value } });
      hub.bus.publish({ type: 'runs.changed', projectId: p.id, data: hub.runs.view(updated) });
      return { project: p, run: updated };
    }
    const updated = hub.projects.update(p.slug, { settings: { timeOffsets: value } });
    hub.bus.publish({ type: 'project.updated', projectId: p.id, data: updated });
    return { project: updated, run: null };
  };

  app.get<{ Params: P }>('/api/projects/:slug/time', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return view(p, target(req, p, false));
  });

  /** Body { offsets: { auth: "+2h", totp: 0 } } (merged; 0 / null clears one) or { feature, offset }. */
  app.put<{ Params: P }>('/api/projects/:slug/time', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = target(req, p, true);
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    let patch: Record<string, unknown>;
    if (b.offsets && typeof b.offsets === 'object' && !Array.isArray(b.offsets)) patch = b.offsets as Record<string, unknown>;
    else if (typeof b.feature === 'string') patch = { [b.feature]: b.offset ?? null };
    else throw new HttpError(400, 'Pass { "offsets": { "auth": "+2h" } } or { "feature": "auth", "offset": "+2h" }');
    const cur: TimeOffsets = run ? cleanOffsets(run.meta?.timeOffsets) : cleanOffsets(p.settings.timeOffsets);
    for (const [k, v] of Object.entries(patch)) {
      if (!isTimeFeature(k)) throw new HttpError(400, `Unknown time feature "${k}" (one of ${TIME_FEATURES.join(', ')})`);
      const ms = parseOffset(v);
      if (ms) cur[k] = ms;
      else delete cur[k];
    }
    const out = save(p, run, cur);
    return view(out.project, out.run);
  });

  app.delete<{ Params: P }>('/api/projects/:slug/time', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = target(req, p, true);
    const out = save(p, run, {});
    return view(out.project, out.run);
  });
}
