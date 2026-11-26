import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import type { Run } from '../../repos/runs.js';
import { ttlToExpiry } from '../../repos/runs.js';
import { parseExpectations } from '../../runs/expectations.js';
import { HttpError } from '../../util.js';
import { renderRunReportHtml } from '../../runs/report-html.js';
import { renderVerdictJunit } from '../../runs/junit.js';
import { SETTLE_MAX_MS, type RunVerdict } from '../../runs/verdict.js';
import fs from 'node:fs';

type P = { slug: string; run: string };
type Q = Record<string, string | undefined>;

/**
 * The run a control call is scoped to: `?run=<key|id>` or the X-Hub-Run header (null = no run).
 * Unknown runs are a 404. Stopped runs are accepted for reading (their data stays readable).
 */
export function runParam(hub: Hub, req: FastifyRequest, project: Project, opts: { active?: boolean } = {}): Run | null {
  const q = (req.query ?? {}) as Q;
  const h = req.headers['x-hub-run'];
  const ref = (q.run || (Array.isArray(h) ? h[0] : h) || '').trim();
  if (!ref) return null;
  return opts.active ? hub.runs.requireActive(project.id, ref) : hub.runs.require(project.id, ref);
}

/** stubyard version for the HTML report footer (server/package.json; same depth from src/ and dist/). */
let version: string | null = null;
function hubVersion(): string {
  if (version === null) {
    try {
      version = String((JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'dev');
    } catch {
      version = 'dev';
    }
  }
  return version;
}

const flag = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';

/** `settle` in seconds (query or body) as milliseconds, capped at SETTLE_MAX_MS; 400 when it is not a number ≥ 0. */
function settleMs(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'settle must be a number of seconds (0 to 60)');
  return Math.min(Math.round(n * 1000), SETTLE_MAX_MS);
}

/** Test runs: start, mint users, stop / purge, report. */
export async function registerRunRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});

  app.post<{ Params: P }>('/api/projects/:slug/runs', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const { run, users } = await hub.runs.start(p, {
      key: b.key !== undefined && b.key !== null && b.key !== '' ? String(b.key) : undefined,
      label: b.label !== undefined ? String(b.label) : undefined,
      ttlMinutes: b.ttlMinutes as number | undefined,
      captureUnattributed: b.captureUnattributed === true,
      claims: Array.isArray(b.claims) ? b.claims.map(String) : undefined,
      meta: b.meta && typeof b.meta === 'object' && !Array.isArray(b.meta) ? (b.meta as Record<string, unknown>) : undefined,
      replace: b.replace === true,
      users: Array.isArray(b.users) ? (b.users as { role?: string; count?: number; name?: string }[]) : undefined,
      expectations: b.expectations,
    });
    return reply.status(201).send({ ...hub.runs.view(run), users: users.map((u) => hub.runs.withPassword(p, u)) });
  });

  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const status = req.query.status;
    if (status && status !== 'active' && status !== 'stopped') throw new HttpError(400, 'status must be "active" or "stopped"');
    return hub.runs.repo.list(p.id, status).map((r) => hub.runs.view(r));
  });

  app.get<{ Params: P }>('/api/projects/:slug/runs/:run', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    return { ...hub.runs.view(r), users: hub.users.listForRun(r.id).map((u) => hub.runs.withPassword(p, u)) };
  });

  app.patch<{ Params: P }>('/api/projects/:slug/runs/:run', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    const b = body(req.body);
    if ((b.ttlMinutes !== undefined || b.expectations !== undefined) && r.status !== 'active') throw new HttpError(409, `Run "${r.key}" is stopped`);
    // Validate before anything is written, so a 400 changes nothing.
    const expectations = b.expectations !== undefined ? parseExpectations(b.expectations) : undefined;
    let updated = hub.runs.repo.update(r.id, {
      label: b.label !== undefined ? String(b.label) : undefined,
      expiresAt: b.ttlMinutes !== undefined ? ttlToExpiry(b.ttlMinutes) : undefined,
      claims: Array.isArray(b.claims) ? b.claims.map(String) : undefined,
      meta: b.meta && typeof b.meta === 'object' && !Array.isArray(b.meta) ? (b.meta as Record<string, unknown>) : undefined,
    });
    if (expectations) updated = hub.runs.repo.setExpectations(r.id, expectations);
    hub.bus.publish({ type: 'runs.changed', projectId: p.id, data: updated });
    return hub.runs.view(updated);
  });

  /** The run's expectations document ({items, defaults}). */
  app.get<{ Params: P }>('/api/projects/:slug/runs/:run/expectations', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.runs.require(p.id, req.params.run).expectations;
  });

  /** Replace the expectations, or with ?append=1 add items and merge defaults; 409 once the run is stopped. */
  app.put<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/expectations', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    return hub.runs.setExpectations(r, Array.isArray(req.body) ? req.body : body(req.body), { append: flag(req.query.append) });
  });

  /** Mint ephemeral test users for the run. */
  app.post<{ Params: P }>('/api/projects/:slug/runs/:run/users', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.requireActive(p.id, req.params.run);
    const b = body(req.body);
    const users = hub.runs.mint(p, r, {
      role: b.role !== undefined ? String(b.role) : undefined,
      name: b.name !== undefined ? String(b.name) : undefined,
      count: b.count !== undefined ? Number(b.count) : undefined,
      email: b.email === false ? false : undefined,
      phone: b.phone === false ? false : undefined,
    });
    return reply.status(201).send(users.map((u) => hub.runs.withPassword(p, u)));
  });

  app.post<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/stop', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    const b = body(req.body);
    const out = await hub.runs.stop(r, { purge: flag(req.query.purge) || flag(b.purge), settleMs: settleMs(req.query.settle ?? b.settle) });
    const runUrl = `/api/projects/${encodeURIComponent(p.slug)}/runs/${encodeURIComponent(out.run.id)}`;
    return { run: hub.runs.view(out.run), report: out.report, reportHtmlUrl: `${runUrl}/report.html`, verdictUrl: `${runUrl}/verdict`, junitUrl: `${runUrl}/report.junit.xml` };
  });

  /** A verdict as JSON, or (format=junit) as JUnit XML; assert=1 answers 422 unless it passed. */
  const sendVerdict = (p: Project, r: Run, v: RunVerdict, q: Q, reply: FastifyReply) => {
    const status = flag(q.assert) && v.verdict !== 'pass' ? 422 : 200;
    if (q.format === 'junit') return sendJunit(p, r, v, q, reply.status(status));
    if (q.format && q.format !== 'json') throw new HttpError(400, 'format must be "json" or "junit"');
    return reply.status(status).send(v);
  };

  /** JUnit XML; ?download=1 sends it as an attachment. */
  const sendJunit = (p: Project, r: Run, v: RunVerdict, q: Q, reply: FastifyReply) => {
    reply.header('content-type', 'application/xml; charset=utf-8').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    if (flag(q.download)) reply.header('content-disposition', `attachment; filename="stubyard-run-${r.key}.junit.xml"`);
    return reply.send(renderVerdictJunit(v, { project: p.slug }));
  };

  /** Active run: evaluated live (after ?settle=<seconds>). Stopped run: the verdict frozen in its report. */
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/verdict', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    return sendVerdict(p, r, await hub.runs.verdict(r, { settleMs: settleMs(req.query.settle) }), req.query, reply);
  });

  /** Ad-hoc evaluation of other expectations ({items?, defaults?, settle?} or a bare array); nothing is saved. */
  app.post<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/verdict', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    const b = Array.isArray(req.body) ? { items: req.body } : body(req.body);
    const { settle, ...doc } = b;
    const expectations = parseExpectations(doc);
    return sendVerdict(p, r, await hub.runs.verdict(r, { settleMs: settleMs(req.query.settle ?? settle), expectations }), req.query, reply);
  });

  const junit = async (req: FastifyRequest<{ Params: P; Querystring: Q }>, reply: FastifyReply) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    return sendJunit(p, r, await hub.runs.verdict(r, { settleMs: settleMs(req.query.settle) }), req.query, reply);
  };
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/report.junit.xml', junit);
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/junit', junit);

  /** The report as one self-contained HTML page; ?download=1 sends it as an attachment. */
  const sendHtml = (p: Project, r: Run, q: Q, reply: FastifyReply) => {
    const html = renderRunReportHtml(hub.runs.report(r), { project: { slug: p.slug, name: p.name }, version: hubVersion(), generatedAt: new Date().toISOString() });
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    if (flag(q.download)) reply.header('content-disposition', `attachment; filename="stubyard-run-${r.key}.html"`);
    return reply.send(html);
  };

  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/report', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    if (req.query.format === 'html') return sendHtml(p, r, req.query, reply);
    if (req.query.format && req.query.format !== 'json') throw new HttpError(400, 'format must be "json" or "html"');
    return hub.runs.report(r);
  });

  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/runs/:run/report.html', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    return sendHtml(p, hub.runs.require(p.id, req.params.run), req.query, reply);
  });

  app.delete<{ Params: P }>('/api/projects/:slug/runs/:run', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const r = hub.runs.require(p.id, req.params.run);
    return { deleted: await hub.runs.delete(r) };
  });
}
