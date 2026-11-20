import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import { handleLlmRequest, CORS } from '../../llmmocks/handler.js';
import { FAULT_HELP } from '../../llmmocks/match.js';
import { providerError } from '../../llmmocks/synth.js';
import { LLM_ENDPOINTS, type LlmProvider } from '../../llmmocks/types.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string; project: string; provider: string; '*': string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});

/**
 * LLM API mocks: the fake OpenAI / Anthropic APIs under /llm/<project>/<openai|anthropic>/… and the control API
 * under /api/projects/:slug/llm/… (mocks, fault rules, calls, recordings, settings, connect).
 */
export async function registerLlmRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.llm) return;
  const svc = hub.llm;
  const proj = (slug: string) => hub.projects.require(slug);
  const run = (req: FastifyRequest, project: ReturnType<typeof proj>, active = false) => runParam(hub, req, project, { active });

  // ---------------- the fake APIs ----------------
  const fake = async (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
    const provider = String(req.params.provider ?? '').toLowerCase();
    const path = '/' + (req.params['*'] ?? '');
    if (provider !== 'openai' && provider !== 'anthropic') {
      req.trafficOutcome = 'unmatched';
      return reply.status(404).send({ error: 'Not found', message: `Unknown LLM API "${provider}". Use /llm/<project>/openai/v1/… or /llm/<project>/anthropic/v1/…`, requestId: req.trafficLogId });
    }
    let slug = req.params.project;
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep */
    }
    const project = hub.projects.getBySlug(slug.toLowerCase());
    if (!project) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'llm', provider, unknownProject: slug };
      const e = providerError(provider as LlmProvider, 404, `stubyard has no project "${slug}". LLM base URLs look like /llm/<project>/openai/v1 or /llm/<project>/anthropic.`, { type: provider === 'anthropic' ? 'not_found_error' : 'invalid_request_error' });
      // No CORS: other web pages must not probe which projects exist.
      return reply.status(404).headers(e.headers).send(e.body);
    }
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });
    if (req.method === 'OPTIONS') {
      req.trafficResolved = { project: project.slug, kind: 'llm', provider, preflight: true };
      return reply
        .status(204)
        .headers({ ...CORS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '*'), 'access-control-max-age': '600' })
        .send();
    }
    return handleLlmRequest(hub, req, reply, project, provider, path);
  };
  app.route<{ Params: P }>({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/llm/:project/:provider/*', handler: fake });
  app.route<{ Params: P }>({ method: ['GET', 'HEAD', 'POST', 'OPTIONS'], url: '/llm/:project/:provider', handler: fake });

  // ---------------- control API ----------------
  const b = '/api/projects/:slug/llm';

  app.get(`/api/llm-reference`, async () => ({ endpoints: LLM_ENDPOINTS, faults: FAULT_HELP, modes: ['first', 'sequence', 'cycle'], fallbacks: ['error', 'echo', 'text'] }));

  // mocks
  app.get<{ Params: P; Querystring: Q }>(`${b}/mocks`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    const list = r ? svc.repo.listMocks(project.id, { runId: r.id }) : svc.repo.listMocks(project.id, { all: req.query.all !== '0' });
    return list.map((m) => svc.viewMock(m));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/mocks`, async (req, reply) => {
    const project = proj(req.params.slug);
    const r = runRef(req) ? run(req, project, true) : null;
    reply.status(201);
    return svc.viewMock(svc.createMock(project, body(req.body), r));
  });
  app.post<{ Params: P }>(`${b}/mocks/reorder`, async (req) => {
    const project = proj(req.params.slug);
    return svc.reorder(project, body(req.body).ids).map((m) => svc.viewMock(m));
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/mocks`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    return { deleted: svc.deleteMocks(project, { run: r, source: req.query.source || undefined }) };
  });
  app.get<{ Params: P }>(`${b}/mocks/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewMock(svc.requireMock(project, req.params.id));
  });
  app.patch<{ Params: P }>(`${b}/mocks/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewMock(svc.updateMock(project, req.params.id, body(req.body)));
  });
  app.put<{ Params: P }>(`${b}/mocks/:id`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewMock(svc.updateMock(project, req.params.id, body(req.body)));
  });
  app.delete<{ Params: P }>(`${b}/mocks/:id`, async (req, reply) => {
    const project = proj(req.params.slug);
    svc.deleteMock(project, req.params.id);
    return reply.status(204).send();
  });

  // fault rules (shorthand mocks without responses)
  app.get<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    return svc.repo
      .listMocks(project.id, { all: true })
      .filter((m) => m.fault && !m.responses.length)
      .map((m) => svc.viewMock(m));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : runRef(req) ? run(req, project, true) : null;
    reply.status(201);
    return svc.viewMock(svc.addFault(project, b0, r));
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    return { deleted: svc.clearFaults(project, run(req, project)) };
  });

  // calls
  app.get<{ Params: P; Querystring: Q }>(`${b}/calls`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    const q = req.query;
    return svc.repo
      .listCalls(project.id, { runId: r?.id, mode: q.mode, provider: q.provider, mockId: q.mock, after: q.after, limit: q.limit ? Number(q.limit) : 50 })
      .map((c) => svc.viewCall(c));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/calls/wait`, async (req) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.require(project.id, String(b0.run)) : run(req, project);
    const s = (k: string) => (b0[k] === undefined || b0[k] === null || b0[k] === '' ? undefined : String(b0[k]));
    const timeout = Math.min(60_000, Math.max(0, Number(b0.timeoutMs ?? 10_000)));
    const c = await svc.waitCall(project, { runId: r?.id, provider: s('provider'), endpoint: s('endpoint'), model: s('model'), contains: s('contains'), mode: s('mode'), after: s('after') }, timeout);
    return c ? { timedOut: false, call: svc.viewCall(c, true) } : { timedOut: true, call: null };
  });
  app.get<{ Params: P }>(`${b}/calls/:id`, async (req) => {
    const project = proj(req.params.slug);
    const c = svc.repo.getCall(project.id, req.params.id);
    if (!c) throw new HttpError(404, `LLM call "${req.params.id}" not found`);
    return svc.viewCall(c, true);
  });
  app.delete<{ Params: P }>(`${b}/calls`, async (req) => {
    const project = proj(req.params.slug);
    const n = svc.repo.deleteCalls(project.id);
    svc.changed(project.id, { callsCleared: n });
    return { deleted: n };
  });

  // recordings
  app.get<{ Params: P }>(`${b}/recordings`, async (req) => {
    const project = proj(req.params.slug);
    return svc.repo.listRecordings(project.id).map((r) => svc.viewRecording(r));
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/recordings`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : runRef(req) ? run(req, project, true) : null;
    reply.status(201);
    return svc.viewRecording(svc.startRecording(project, b0, r));
  });
  app.post<{ Params: P }>(`${b}/recordings/stop`, async (req) => {
    const project = proj(req.params.slug);
    return svc.stopRecording(project, null).map((r) => svc.viewRecording(r));
  });
  app.post<{ Params: P }>(`${b}/recordings/:id/stop`, async (req) => {
    const project = proj(req.params.slug);
    return svc.viewRecording(svc.stopRecording(project, req.params.id)[0]);
  });

  // settings
  app.get<{ Params: P }>(`${b}/settings`, async (req) => svc.settings(proj(req.params.slug).id));
  const saveSettings = async (req: FastifyRequest<{ Params: P }>) => svc.updateSettings(proj(req.params.slug), body(req.body));
  app.put<{ Params: P }>(`${b}/settings`, saveSettings);
  app.patch<{ Params: P }>(`${b}/settings`, saveSettings);

  // connect
  app.get<{ Params: P }>(`${b}/connect`, async (req) => {
    const project = proj(req.params.slug);
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${hub.config.httpPort}`);
    const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http');
    return svc.connect(project, `${proto}://${host}`);
  });

  // overview counts for the UI
  app.get<{ Params: P }>(`${b}`, async (req) => {
    const project = proj(req.params.slug);
    const mocks = svc.repo.listMocks(project.id, { all: true });
    return {
      mocks: mocks.filter((m) => m.responses.length).length,
      faults: mocks.filter((m) => m.fault && !m.responses.length).length,
      calls: svc.repo.listCalls(project.id, { limit: 500 }).length,
      recordings: svc.repo.listRecordings(project.id).filter((r) => r.status === 'active').map((r) => svc.viewRecording(r)),
      settings: svc.settings(project.id),
    };
  });
}

function runRef(req: FastifyRequest): string | null {
  const q = (req.query ?? {}) as Q;
  const h = req.headers['x-hub-run'];
  const v = (q.run || (Array.isArray(h) ? h[0] : h) || '').trim();
  return v || null;
}
