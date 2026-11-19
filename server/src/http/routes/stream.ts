import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';

/**
 * Server-Sent Events: GET /api/stream?project=<slug>
 * Without ?project the client receives events for all projects (and project-less logs).
 */
export async function registerStream(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get<{ Querystring: { project?: string; run?: string } }>('/api/stream', (req, reply) => {
    const project = req.query.project ? hub.projects.require(req.query.project) : null;
    const projectId = project?.id ?? null;
    // ?run=<key|id> (needs ?project= for a key): only that run's messages / logs, plus run events.
    const runRef = req.query.run || (req.headers['x-hub-run'] as string | undefined);
    const run = runRef ? (project ? hub.runs.require(project.id, runRef) : hub.runs.repo.get(runRef)) : null;
    if (runRef && !run) {
      return reply.status(404).send({ error: `Unknown run "${runRef}"` });
    }
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

    const unsubscribe = hub.bus.subscribe((ev) => {
      if (projectId && ev.projectId !== projectId) return;
      if (run && !inRun(ev.type, ev.data, run.id)) return;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ projectId: ev.projectId, data: ev.data })}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}

/** Run filter for the stream: messages and logs of the run, and run lifecycle events. */
function inRun(type: string, data: unknown, runId: string): boolean {
  if (type === 'runs.changed') return true;
  if (type.startsWith('message.') || type.startsWith('log.')) return !!data && typeof data === 'object' && (data as { runId?: unknown }).runId === runId;
  return false;
}
