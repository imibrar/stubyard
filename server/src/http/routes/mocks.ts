import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import type { MockInput } from '../../repos/mocks.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; mock: string };

/** CRUD for API mocks (/mock/<project>/api/…), live scenario switching and recent hits. */
export async function registerMockRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});
  const changed = (projectId: string, data: unknown) => hub.bus.publish({ type: 'mocks.changed', projectId, data });
  const toInput = (b: Record<string, unknown>): MockInput => ({
    name: b.name as string | undefined,
    description: b.description as string | undefined,
    method: b.method as string | undefined,
    path: b.path as string | undefined,
    match: b.match as MockInput['match'],
    scenarios: b.scenarios as MockInput['scenarios'],
    activeScenario: (b.activeScenario ?? b.scenario) as string | undefined,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    position: typeof b.position === 'number' ? b.position : undefined,
  });

  app.get<{ Params: P }>('/api/projects/:slug/mocks', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p);
    // With ?run=: each mock also shows the run's override (runScenario, null = none).
    return run ? hub.mocks.list(p.id).map((m) => ({ ...m, runScenario: hub.runs.repo.mockOverride(run.id, m.id) })) : hub.mocks.list(p.id);
  });

  app.post<{ Params: P }>('/api/projects/:slug/mocks', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const m = hub.mocks.create(p.id, toInput(body(req.body)));
    changed(p.id, m);
    return reply.status(201).send(m);
  });

  app.get<{ Params: P }>('/api/projects/:slug/mocks/:mock', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.mocks.require(p.id, req.params.mock);
  });

  const update = async (req: { params: P; body: unknown }) => {
    const p = hub.projects.require(req.params.slug);
    const m = hub.mocks.update(p.id, req.params.mock, toInput(body(req.body)));
    changed(p.id, m);
    return m;
  };
  app.patch<{ Params: P }>('/api/projects/:slug/mocks/:mock', update);
  app.put<{ Params: P }>('/api/projects/:slug/mocks/:mock', update);

  app.delete<{ Params: P }>('/api/projects/:slug/mocks/:mock', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const m = hub.mocks.delete(p.id, req.params.mock);
    changed(p.id, { deleted: m.id });
    return { deleted: m.id, name: m.name };
  });

  /** Switch the scenario every request gets from now on: { "scenario": "Card declined" }. */
  app.patch<{ Params: P }>('/api/projects/:slug/mocks/:mock/active-scenario', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const name = b.scenario ?? b.activeScenario ?? b.name;
    if (!name) throw new HttpError(400, 'Send { "scenario": "<scenario name>" }');
    const run = runParam(hub, req, p, { active: true });
    if (run) {
      // Inside a run: only this run's requests get the scenario; everyone else keeps the mock's active one.
      const cur = hub.mocks.require(p.id, req.params.mock);
      const sc = cur.scenarios.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
      if (!sc) throw new HttpError(400, `Mock "${cur.name}" has no scenario "${name}". Scenarios: ${cur.scenarios.map((x) => x.name).join(', ')}`);
      hub.runs.repo.setMockOverride(run.id, cur.id, sc.name);
      changed(p.id, { mock: cur.id, run: run.key, scenario: sc.name });
      return { ...cur, runScenario: sc.name, run: run.key };
    }
    const m = hub.mocks.setActiveScenario(p.id, req.params.mock, String(name));
    changed(p.id, m);
    return m;
  });

  /** Recent calls answered by this mock (from the traffic log). */
  app.get<{ Params: P; Querystring: { limit?: string } }>('/api/projects/:slug/mocks/:mock/hits', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const m = hub.mocks.require(p.id, req.params.mock);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const ids = hub.db
      .prepare("SELECT id FROM traffic_logs WHERE project_id = ? AND json_extract(resolved, '$.mockId') = ? ORDER BY id DESC LIMIT ?")
      .all(p.id, m.id, limit) as { id: string }[];
    return ids.map((x) => {
      const l = hub.logs.get(x.id)!;
      return {
        id: l.id,
        method: l.method,
        url: l.url,
        resStatus: l.resStatus,
        outcome: l.outcome,
        scenario: l.resolved.scenario ?? null,
        scenarioSource: l.resolved.scenarioSource ?? null,
        receivedAt: l.receivedAt,
        durationMs: l.durationMs,
      };
    });
  });

  /** Set the hit counters of all mocks back to 0. */
  app.post<{ Params: P }>('/api/projects/:slug/mocks/reset-hits', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const n = hub.mocks.resetHits(p.id);
    changed(p.id, { resetHits: n });
    return { reset: n };
  });
}
