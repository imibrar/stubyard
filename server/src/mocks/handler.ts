import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { MockExtension } from '../messages/simulator.js';
import type { ApiMock, MockScenario } from '../repos/mocks.js';
import { matchMock, renderTemplate, type MockRequestInfo, type TemplateContext } from './match.js';
import { tagLog } from '../runs/resolver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Req = FastifyRequest<{ Params: { project: string; instance: string; '*': string } }>;

/**
 * X-Hub-Scenario for API mocks: a scenario name of the matched mock, or a built-in:
 * "timeout", "drop", a status code ("503"), or "status:503".
 * Order: the header, then the test run's override (`runScenario`), then the mock's active scenario.
 */
export function pickScenario(
  mock: ApiMock,
  header: string | null,
  runScenario: string | null = null,
): { scenario: MockScenario; source: 'active' | 'header' | 'run'; unknownHeader?: string } {
  const global = mock.scenarios.find((s) => s.name === mock.activeScenario) ?? mock.scenarios[0];
  const override = runScenario ? mock.scenarios.find((s) => s.name.toLowerCase() === runScenario.toLowerCase()) : undefined;
  const active = override ?? global;
  const base = override ? 'run' : 'active';
  if (!header) return { scenario: active, source: base };
  const h = header.trim();
  const named = mock.scenarios.find((s) => s.name.toLowerCase() === h.toLowerCase());
  if (named) return { scenario: named, source: 'header' };
  const lower = h.toLowerCase();
  if (lower === 'timeout') return { scenario: { ...active, name: 'timeout (header)', behaviour: 'timeout' }, source: 'header' };
  if (lower === 'drop' || lower === 'drop-connection') return { scenario: { ...active, name: 'drop (header)', behaviour: 'drop' }, source: 'header' };
  const delay = /^(?:delay|slow):(\d+)$/.exec(lower);
  if (delay) return { scenario: { ...active, name: `${active.name} + delay ${delay[1]}ms (header)`, delayMs: Math.min(Number(delay[1]), 600_000) }, source: 'header' };
  const code = /^(?:status:)?(\d{3})$/.exec(lower);
  if (code) {
    const status = Number(code[1]);
    return {
      scenario: { name: `${status} (header)`, status, headers: {}, body: JSON.stringify({ error: `Forced status ${status} (X-Hub-Scenario)` }), delayMs: 0, behaviour: 'respond' },
      source: 'header',
    };
  }
  return { scenario: active, source: base, unknownHeader: h };
}

/** Handles /mock/<project>/api/… : find the first matching mock and play its scenario. */
export function createApiMockHandler(hub: Hub): MockExtension {
  return async (req: Req, reply: FastifyReply, { project }) => {
    const path = '/' + (req.params['*'] ?? '');
    const info: MockRequestInfo = {
      method: req.method,
      path,
      query: (req.query ?? {}) as Record<string, unknown>,
      headers: req.headers as Record<string, unknown>,
      rawBody: req.rawBody ? req.rawBody.toString('utf8') : typeof req.body === 'string' ? req.body : '',
      body: Buffer.isBuffer(req.body) ? undefined : req.body,
    };
    const mocks = hub.mocks.list(project.id);
    const resolved: Record<string, unknown> = { project: project.slug, kind: 'api-mock', path };
    req.trafficResolved = resolved;

    let mock: ApiMock | null = null;
    let params: Record<string, string> = {};
    const misses: { name: string; method: string; path: string; enabled: boolean; reason: string }[] = [];
    for (const m of mocks) {
      if (!m.enabled) {
        misses.push({ name: m.name, method: m.method, path: m.path, enabled: false, reason: 'disabled' });
        continue;
      }
      const r = matchMock(m, info);
      if (r.ok) {
        mock = m;
        params = r.params;
        break;
      }
      misses.push({ name: m.name, method: m.method, path: m.path, enabled: true, reason: r.reason ?? 'no match' });
    }

    if (!mock) {
      req.trafficOutcome = 'unmatched';
      resolved.mock = null;
      return reply.status(404).send({
        error: 'Not found',
        message: `No API mock in project "${project.slug}" matches ${req.method} ${path}`,
        hint: mocks.length
          ? 'Check the method, path and match conditions of your mocks (dashboard → API mocks). Mocks are checked top to bottom.'
          : `Project "${project.slug}" has no API mocks yet. Add one in the dashboard (API mocks) or POST /api/projects/${project.slug}/mocks.`,
        mocks: misses,
        requestId: req.trafficLogId,
      });
    }

    const attribution = hub.runs.resolver.forRequest(project.id, req);
    tagLog(hub, req.trafficLogId, attribution);
    const runScenario = attribution.run ? hub.runs.repo.mockOverride(attribution.run.id, mock.id) : null;
    const header = req.headers['x-hub-scenario'];
    const pick = pickScenario(mock, (Array.isArray(header) ? header[0] : header) ?? null, runScenario);
    const scenario = pick.scenario;
    hub.mocks.hit(mock.id);
    if (attribution.run && runScenario) hub.runs.repo.hitMockOverride(attribution.run.id, mock.id);
    Object.assign(resolved, {
      mock: mock.name,
      mockId: mock.id,
      scenario: scenario.name,
      scenarioSource: pick.source,
      behaviour: scenario.behaviour,
      ...(Object.keys(params).length ? { params } : {}),
      ...(pick.unknownHeader ? { unknownScenarioHeader: pick.unknownHeader } : {}),
    });

    if (scenario.behaviour === 'timeout' || scenario.behaviour === 'drop') {
      const logId = req.trafficLogId;
      // We finish the log entry ourselves; stop the generic onRequestAbort hook from marking it "client_aborted".
      req.trafficLogId = undefined;
      reply.hijack();
      if (scenario.behaviour === 'timeout') {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, hub.config.timeoutHoldMs);
          req.raw.once('close', () => (clearTimeout(t), resolve()));
        });
      }
      req.raw.socket?.destroy();
      if (logId) {
        const body = hub.traffic.clip(req.rawBody ?? null);
        hub.traffic.mergeResolved(logId, resolved);
        hub.traffic.finish(logId, {
          outcome: 'forced_error',
          errorType: scenario.behaviour === 'timeout' ? 'simulated_timeout' : 'simulated_drop',
          errorMessage: scenario.behaviour === 'timeout' ? `Mock "${mock.name}" → ${scenario.name}: no response (timeout)` : `Mock "${mock.name}" → ${scenario.name}: connection dropped`,
          resStatus: null,
          reqBody: body.text,
          reqBodySize: body.size,
          reqTruncated: body.truncated,
        });
      }
      return;
    }

    if (scenario.delayMs > 0) await sleep(scenario.delayMs);

    const ctx: TemplateContext = { params, query: info.query, headers: info.headers, body: info.body, method: req.method, path, nowMs: hub.clock.now(project.id, 'mocks', attribution.run?.id) };
    const body = renderTemplate(scenario.body, ctx);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(scenario.headers)) headers[k] = renderTemplate(v, ctx);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = looksLikeJson(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    }
    // A mock answering 4xx/5xx does so on purpose: "forced_error", never "unmatched" / "internal_error".
    req.trafficOutcome = scenario.status >= 400 ? 'forced_error' : 'ok';
    return reply.status(scenario.status).headers(headers).send(req.method === 'HEAD' ? undefined : body);
  };
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}
