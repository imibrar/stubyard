import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import type { Run } from '../../repos/runs.js';
import { jwks } from '../../nafath/claims.js';
import { FAULT_HELP, NAFATH_FAULTS } from '../../nafath/faults.js';
import type { RequestFilter } from '../../nafath/repo.js';
import { AUTO_DECISIONS, NAFATH_ERRORS, NAFATH_STATUSES, NafathError, type NafathInstance, type NafathRequest } from '../../nafath/types.js';
import { tagLog, type Attribution, type RunVia } from '../../runs/resolver.js';
import { HttpError } from '../../util.js';
import { runParam } from './runs.js';

type P = { slug: string; id: string; project: string; instance: string; '*': string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});

/** Real Nafath's answer for a path it does not serve (also an unknown environment prefix). */
const NO_MAPPING = { message: 'No Mapping Rule matched' };
/** Environment prefixes of the real hosts (sandbox, staging): accepted in front of /api/v1/…. */
const ENV_PREFIX_RE = /^\/(?:nafath-sandbox|stg)(?=\/)/;

const originOf = (hub: Hub, req: FastifyRequest) => {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${hub.config.httpPort}`);
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http');
  return `${proto}://${host}`;
};

const header = (req: FastifyRequest, name: string): string | null => {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined ? null : String(s);
};

/** The app-facing URLs of an instance. */
export function nafathUrls(origin: string, project: { slug: string }, inst: { slug: string }) {
  const base = `${origin}/nafath/${project.slug}/${inst.slug}`;
  return {
    base,
    request: `${base}/api/v1/mfa/request`,
    status: `${base}/api/v1/mfa/request/status`,
    info: `${base}/api/v1/mfa/request/info`,
    jwk: `${base}/api/v1/mfa/jwk`,
    sandboxBase: `${base}/nafath-sandbox`,
    stagingBase: `${base}/stg`,
  };
}

/**
 * Fake Nafath (B5): the MFA API under /nafath/<project>/<instance>/… (also behind /nafath-sandbox and /stg) and the
 * control API under /api/projects/:slug/nafath/…. Callbacks and auto-decisions are nafath/callbacks.ts (S2c).
 */
export async function registerNafathRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.nafath) return;
  const svc = hub.nafath;
  const proj = (slug: string) => hub.projects.require(slug);

  // ---------------- the fake MFA API ----------------
  const fake = async (req: FastifyRequest<{ Params: P }>, reply: FastifyReply) => {
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    const project = hub.projects.getBySlug(dec(req.params.project).toLowerCase());
    if (!project) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'nafath', unknownProject: req.params.project };
      return reply.status(404).send({ ...NO_MAPPING, hint: `stubyard has no project "${req.params.project}". Nafath URLs look like /nafath/<project>/<instance>/api/v1/mfa/request` });
    }
    if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { projectId: project.id });
    const inst = svc.repo.instanceBySlug(project.id, dec(req.params.instance).toLowerCase());
    if (!inst) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { kind: 'nafath', project: project.slug, unknownInstance: req.params.instance };
      return reply.status(404).send({ ...NO_MAPPING, hint: `Project "${project.slug}" has no Nafath instance "${req.params.instance}" (Providers → Nafath).` });
    }
    // Explicit run: X-Hub-Run or /run/<key>/nafath/… (rewritten to the header in http/app.ts). Unknown or stopped → 404.
    const key = header(req, 'x-hub-run')?.trim();
    let explicit: { run: Run; via: RunVia } | null = null;
    if (key) {
      const run = hub.runs.resolver.explicit(project.id, key);
      if (!run) {
        req.trafficOutcome = 'unmatched';
        req.trafficResolved = { kind: 'nafath', project: project.slug, instance: inst.slug, unknownRun: key };
        return reply.status(404).send({
          error: 'Unknown run',
          run: key,
          message: `Project "${project.slug}" has no active test run "${key}" (unknown, stopped or expired). Start it with POST /api/projects/${project.slug}/runs.`,
          requestId: req.trafficLogId,
        });
      }
      explicit = { run, via: (req.originalUrl ?? req.url).startsWith('/run/') ? 'prefix' : 'header' };
    }
    const path = ('/' + (req.params['*'] ?? '')).split('?')[0].replace(ENV_PREFIX_RE, '');
    return dispatch(req, reply, project, inst, path, explicit);
  };

  const dispatch = async (req: FastifyRequest, reply: FastifyReply, project: Project, inst: NafathInstance, path: string, explicit: { run: Run; via: RunVia } | null) => {
    const q = (req.query ?? {}) as Q;
    const resolved: J = { kind: 'nafath', project: project.slug, instance: inst.slug };
    const creds = { appId: header(req, 'app-id'), appKey: header(req, 'app-key') };
    // A claim or the default run, when POST /request had neither an explicit run nor a user in a run.
    let implicit: Attribution | null = null;
    // The request's run on the traffic log row (explicit run, the user's run, a claim or the default run).
    const tag = (r: NafathRequest) => {
      if (explicit) return tagLog(hub, req.trafficLogId, explicit);
      const run = r.runId ? hub.runs.resolver.activeById(r.runId) : null;
      if (run) tagLog(hub, req.trafficLogId, implicit?.run?.id === run.id ? implicit : { run, via: 'user' });
    };
    const ok = async (op: string, r: NafathRequest, out: J, extra: { warnings?: string[]; delayMs?: number; fault?: string | null }) => {
      tag(r);
      req.trafficResolved = {
        ...resolved,
        op,
        transId: r.transId,
        status: out.status ?? r.status,
        user: r.testUserId,
        nationalId: r.nationalId,
        ...(extra.fault ? { fault: extra.fault } : {}),
        ...(extra.warnings?.length ? { warnings: extra.warnings } : {}),
      };
      if (extra.delayMs) await new Promise((res) => setTimeout(res, extra.delayMs));
      return reply.status(200).send(out);
    };

    try {
      if (path === '/api/v1/mfa/request' && req.method === 'POST') {
        const b = body(req.body);
        const strictHeadersWarnings = inst.strict && !header(req, 'x-forwarded-for') ? ["No X-Forwarded-For header (real Nafath expects the end user's IP)"] : [];
        const nationalId = String(b.nationalId ?? '').trim();
        const owner = nationalId ? hub.users.findByNationalId(project.id, nationalId) : null;
        // Without an explicit run, a user's own run wins (the service reads it); otherwise a claim or the default run.
        if (!explicit && !owner?.runId) implicit = hub.runs.resolver.forRequest(project.id, req);
        const runId = explicit?.run.id ?? implicit?.run?.id ?? null;
        const r = svc.startRequest(inst, { nationalId: b.nationalId, service: b.service, locale: q.local ?? null, requestId: q.requestId ?? null, runId, ...creds, strictHeadersWarnings, logId: req.trafficLogId ?? null });
        return ok('request', r.request, { transId: r.transId, random: r.random }, r);
      }
      if (path === '/api/v1/mfa/request/status' && req.method === 'POST') {
        const b = body(req.body);
        const r = svc.status(inst, { nationalId: b.nationalId, transId: b.transId, random: b.random, ...creds });
        return ok('status', r.request, { status: r.status }, r);
      }
      if (path === '/api/v1/mfa/request/info' && (req.method === 'GET' || req.method === 'HEAD')) {
        const r = svc.info(inst, { nationalId: q.nationalId, transId: q.transId, random: q.random, ...creds });
        return ok('info', r.request, { status: r.status, transId: r.transId, person: r.person }, r);
      }
      if (path === '/api/v1/mfa/jwk' && (req.method === 'GET' || req.method === 'HEAD')) {
        req.trafficResolved = { ...resolved, op: 'jwk' };
        return reply.status(200).send(jwks(inst));
      }
    } catch (err) {
      if (!(err instanceof NafathError)) throw err;
      req.trafficResolved = { ...resolved, op: opOf(path), error: err.code, ...(err.hold ? { fault: 'timeout' } : {}) };
      if (err.hold) return holdThenClose(req, reply);
      if (err.status === 429 || err.status >= 500) req.trafficOutcome = 'forced_error';
      return reply.status(err.status).send(err.body());
    }
    req.trafficOutcome = 'unmatched';
    req.trafficResolved = { ...resolved, unknownPath: `${req.method} ${path}` };
    return reply.status(404).send(NO_MAPPING);
  };

  const holdThenClose = async (req: FastifyRequest, reply: FastifyReply) => {
    req.trafficOutcome = 'forced_error';
    await new Promise((r) => {
      const t = setTimeout(r, hub.config.timeoutHoldMs);
      req.raw.once('close', () => (clearTimeout(t), r(null)));
    });
    reply.raw.destroy();
    return reply;
  };

  app.route<{ Params: P }>({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'], url: '/nafath/:project/:instance/*', handler: fake });

  // ---------------- control API ----------------
  const b = '/api/projects/:slug/nafath';
  const run = (req: FastifyRequest, project: Project, active = false) => runParam(hub, req, project, { active });
  const view = (req: FastifyRequest, project: Project, i: NafathInstance) => ({ ...svc.viewInstance(i), urls: nafathUrls(originOf(hub, req), project, i) });

  app.get<{ Params: P }>(b, async (req) => {
    const project = proj(req.params.slug);
    return {
      instances: svc.listInstances(project.id).map((i) => view(req, project, i)),
      waiting: svc.listRequests(project.id, { status: ['WAITING'], limit: 500 }).filter((r) => r.status === 'WAITING').length,
      faults: svc.listFaults(project.id).filter((r) => r.remaining !== 0).length,
      reference: { faults: FAULT_HELP, faultKinds: NAFATH_FAULTS, statuses: NAFATH_STATUSES, errors: NAFATH_ERRORS, autoDecisions: AUTO_DECISIONS },
    };
  });

  // instances
  app.get<{ Params: P }>(`${b}/instances`, async (req) => {
    const project = proj(req.params.slug);
    return svc.listInstances(project.id).map((i) => view(req, project, i));
  });
  app.post<{ Params: P }>(`${b}/instances`, async (req, reply) => {
    const project = proj(req.params.slug);
    reply.status(201);
    return view(req, project, svc.createInstance(project, body(req.body)));
  });
  app.get<{ Params: P }>(`${b}/instances/:instance`, async (req) => {
    const project = proj(req.params.slug);
    return view(req, project, svc.requireInstance(project, req.params.instance));
  });
  const patchInstance = async (req: FastifyRequest<{ Params: P }>) => {
    const project = proj(req.params.slug);
    return view(req, project, svc.updateInstance(project, req.params.instance, body(req.body)));
  };
  app.patch<{ Params: P }>(`${b}/instances/:instance`, patchInstance);
  app.put<{ Params: P }>(`${b}/instances/:instance`, patchInstance);
  app.delete<{ Params: P }>(`${b}/instances/:instance`, async (req, reply) => {
    svc.deleteInstance(proj(req.params.slug), req.params.instance);
    return reply.status(204).send();
  });
  app.post<{ Params: P }>(`${b}/instances/:instance/keys/rotate`, async (req) => {
    const project = proj(req.params.slug);
    return view(req, project, svc.rotateKeys(project, req.params.instance, { dropOld: body(req.body).dropOld === true }));
  });

  // requests
  app.get<{ Params: P; Querystring: Q }>(`${b}/requests`, async (req) => {
    const project = proj(req.params.slug);
    const q = req.query;
    const r = run(req, project);
    const f: RequestFilter = { runId: r?.id };
    if (q.user === 'unassigned') f.unassigned = true;
    else if (q.user) f.testUserId = hub.users.requireRef(project.id, q.user, r?.id).id;
    if (q.status) f.status = q.status.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (q.instance) f.instanceId = svc.requireInstance(project, q.instance).id;
    if (q.nationalId) f.nationalId = q.nationalId.trim();
    if (q.limit !== undefined && q.limit !== '') {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a whole number ≥ 1');
      f.limit = Math.min(n, 500);
    } else f.limit = 100;
    // Lazy expiry may have changed a status the filter matched on.
    return svc.listRequests(project.id, f).filter((x) => !f.status || f.status.includes(x.status));
  });
  /** Starts a request without the app ({user, instance?, service?}): the credentials are not checked. */
  app.post<{ Params: P }>(`${b}/requests`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : run(req, project, true);
    if (!b0.user) throw new HttpError(400, 'user is required (id, email, national ID, phone, name or role)');
    const user = hub.users.requireRef(project.id, String(b0.user), r?.id);
    if (!user.nationalId) throw new HttpError(400, `Test user "${user.name}" has no national ID`);
    const insts = svc.listInstances(project.id);
    const inst = b0.instance ? svc.requireInstance(project, String(b0.instance)) : insts[0];
    if (!inst) throw new HttpError(400, `Project ${project.slug} has no Nafath instance (POST /api/projects/${project.slug}/nafath/instances)`);
    try {
      const out = svc.startRequest(inst, { nationalId: user.nationalId, service: b0.service, runId: r?.id ?? null });
      reply.status(201);
      return { ...out.request, warnings: out.warnings };
    } catch (err) {
      if (err instanceof NafathError) throw new HttpError(err.code === NAFATH_ERRORS.alreadyActive.code ? 409 : err.status, `${err.code}: ${err.message}`, { code: err.code });
      throw err;
    }
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/requests`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    const user = req.query.user ? hub.users.requireRef(project.id, req.query.user, r?.id) : null;
    return { deleted: svc.resetRequests(project, { testUserId: user?.id, runId: r?.id }) };
  });
  app.get<{ Params: P }>(`${b}/requests/:id`, async (req) => svc.requireRequest(proj(req.params.slug), req.params.id));
  app.post<{ Params: P }>(`${b}/requests/:id/choose`, async (req) => {
    const project = proj(req.params.slug);
    return svc.choose(svc.requireRequest(project, req.params.id), body(req.body).number);
  });
  app.post<{ Params: P }>(`${b}/requests/:id/approve`, async (req) => {
    const project = proj(req.params.slug);
    return svc.approve(svc.requireRequest(project, req.params.id));
  });
  app.post<{ Params: P }>(`${b}/requests/:id/reject`, async (req) => {
    const project = proj(req.params.slug);
    return svc.reject(svc.requireRequest(project, req.params.id));
  });

  // faults
  app.get<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    return svc.listFaults(project.id, run(req, project)?.id);
  });
  app.post<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req, reply) => {
    const project = proj(req.params.slug);
    const b0 = body(req.body);
    const r = b0.run ? hub.runs.requireActive(project.id, String(b0.run)) : run(req, project, true);
    const rule = svc.addFault(project, b0, r?.id ?? null);
    if (!rule) return { cleared: true };
    reply.status(201);
    return rule;
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/faults`, async (req) => {
    const project = proj(req.params.slug);
    const r = run(req, project);
    const user = req.query.user ? hub.users.requireRef(project.id, req.query.user, r?.id) : null;
    return { deleted: svc.clearFaults(project, { runId: r?.id, testUserId: user?.id }) };
  });
  app.delete<{ Params: P }>(`${b}/faults/:id`, async (req, reply) => {
    svc.deleteFault(proj(req.params.slug), req.params.id);
    return reply.status(204).send();
  });
}

function opOf(path: string): string {
  if (path === '/api/v1/mfa/request') return 'request';
  if (path === '/api/v1/mfa/request/status') return 'status';
  if (path === '/api/v1/mfa/request/info') return 'info';
  return 'jwk';
}
