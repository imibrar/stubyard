import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';

/**
 * Server-Sent Events: GET /api/stream?project=<slug>
 * Without ?project the client receives events for all projects (and project-less logs).
 */
export async function registerStream(app: FastifyInstance, hub: Hub): Promise<void> {
  app.get<{ Querystring: { project?: string } }>('/api/stream', (req, reply) => {
    const projectId = req.query.project ? hub.projects.require(req.query.project).id : null;
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
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ projectId: ev.projectId, data: ev.data })}\n\n`);
    });
    const ping = setInterval(() => res.write(`: ping\n\n`), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
