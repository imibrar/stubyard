import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Principal } from '../../access/service.js';
import { requireProjectVisible } from '../../access/scope.js';

/** How often an open stream re-checks its caller (session ended, user disabled, membership changed). */
const RECHECK_MS = 60_000;

/**
 * Server-Sent Events: GET /api/stream?project=<slug>
 * Without ?project the client receives events for all projects (and project-less logs). Teams mode: only events of
 * the caller's projects (project-less events for instance admins only); the stream re-checks the caller when
 * memberships or accounts change and ends when the caller has no access any more.
 */
export async function registerStream(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get<{ Querystring: { project?: string; run?: string } }>('/api/stream', async (req, reply) => {
    if (req.query.project) requireProjectVisible(hub, req, req.query.project);
    const project = req.query.project ? hub.projects.require(req.query.project) : null;
    const projectId = project?.id ?? null;
    // ?run=<key|id> (needs ?project= for a key): only that run's messages / logs, plus run events.
    const runRef = req.query.run || (req.headers['x-hub-run'] as string | undefined);
    const run = runRef ? (project ? hub.runs.require(project.id, runRef) : hub.runs.repo.get(runRef)) : null;
    if (runRef && (!run || !hub.access.sees(req.principal, hub.projects.get(run.projectId)?.slug ?? null))) {
      return reply.status(404).send({ error: `Unknown run "${runRef}"` });
    }

    // Which projects this caller may see (null = all). Re-computed when access changes.
    let principal: Principal | null | undefined = req.principal;
    const filtered = hub.access.teams && !!principal && principal.kind !== 'internal';
    let visible = filtered ? hub.access.visibleSlugs(principal) : null;
    const slugs = new Map<string, string | null>();
    const slugOf = (id: string) => {
      if (!slugs.has(id)) slugs.set(id, hub.projects.get(id)?.slug ?? null);
      return slugs.get(id)!;
    };

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`event: ready\ndata: {}\n\n`);

    let ended = false;
    const unsubscribe = hub.bus.subscribe((ev) => {
      if (ended) return;
      if (projectId && ev.projectId !== projectId) return;
      if (run && !inRun(ev.type, ev.data, run.id)) return;
      if (visible) {
        if (!ev.projectId) return; // project-less events: instance admins only
        const slug = ev.type === 'project.deleted' ? ((ev.data as { slug?: string } | null)?.slug ?? slugOf(ev.projectId)) : slugOf(ev.projectId);
        if (!slug || !visible.has(slug)) return;
      }
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ projectId: ev.projectId, data: ev.data })}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);

    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      clearInterval(recheckTimer);
      hub.access.events.off('changed', onChange);
      unsubscribe();
    };
    let checking = false;
    const recheck = async () => {
      if (!filtered || !principal || principal.kind === 'internal' || checking || ended) return;
      checking = true;
      try {
        const fresh = await hub.access.resolveActor(principal.actor);
        if (!fresh || (project && !hub.access.sees(fresh, project.slug))) {
          finish();
          res.end();
          return;
        }
        principal = fresh;
        visible = hub.access.visibleSlugs(fresh);
        slugs.clear();
      } catch {
        /* Postgres hiccup: keep the last known access until the next check */
      } finally {
        checking = false;
      }
    };
    const onChange = () => void recheck();
    if (filtered) hub.access.events.on('changed', onChange);
    const recheckTimer = filtered ? setInterval(() => void recheck(), RECHECK_MS) : undefined;
    recheckTimer?.unref();
    req.raw.on('close', finish);
  });
}

/** Run filter for the stream: messages and logs of the run, and run lifecycle events. */
function inRun(type: string, data: unknown, runId: string): boolean {
  if (type === 'runs.changed') return true;
  if (type.startsWith('message.') || type.startsWith('log.')) return !!data && typeof data === 'object' && (data as { runId?: unknown }).runId === runId;
  return false;
}
