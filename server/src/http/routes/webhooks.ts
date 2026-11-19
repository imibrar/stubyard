import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import type { Project } from '../../repos/projects.js';
import { HOOK_METHODS, type WebhookEndpoint } from '../../repos/webhooks.js';
import { HttpError } from '../../util.js';
import { inferSchema } from '../../webhooks/schema.js';
import { SIGNING_PRESETS } from '../../webhooks/signing.js';
import { TEMPLATE_VARIABLES } from '../../webhooks/template.js';

type P = { slug: string; id: string };
type HookP = { project: string; '*'?: string };
type Q = { limit?: string };

/** Webhooks: inbound /hook/<project>/<path>, endpoint/template/sequence CRUD, send, sequences, inference, replay. */
export async function registerWebhookRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
  const changed = (projectId: string, data: unknown) => hub.bus.publish({ type: 'webhooks.changed', projectId, data });
  const svc = () => hub.webhookService;

  // ---------- inbound traffic ----------
  app.all<{ Params: HookP }>('/hook/:project', (req, reply) => svc().handleInbound(req, reply));
  app.all<{ Params: HookP }>('/hook/:project/*', (req, reply) => svc().handleInbound(req, reply));

  // ---------- reference ----------
  app.get('/api/webhooks/reference', async () => ({ methods: HOOK_METHODS, signing: SIGNING_PRESETS, variables: TEMPLATE_VARIABLES }));

  // ---------- schema inference ----------
  app.post<{ Params: P }>('/api/projects/:slug/schemas/infer', async (req) => {
    hub.projects.require(req.params.slug);
    const b = body(req.body);
    let sample = 'sample' in b ? b.sample : req.body;
    if (typeof sample === 'string') {
      try {
        sample = JSON.parse(sample);
      } catch (err) {
        throw new HttpError(400, `sample is not valid JSON: ${(err as Error).message}`);
      }
    }
    if (sample === undefined) throw new HttpError(400, 'Send { "sample": <example payload> }');
    return inferSchema(sample, typeof b.title === 'string' ? b.title : undefined);
  });

  // ---------- endpoints ----------
  const urls = (p: Project, e: WebhookEndpoint) => {
    const path = `/hook/${p.slug}${e.path ? `/${e.path}` : ''}`;
    return { http: `http://localhost:${hub.config.httpPort}${path}`, https: `https://localhost:${hub.config.httpsPort}${path}` };
  };
  const withMeta = (p: Project, e: WebhookEndpoint, stats?: Map<string, { hits: number; invalid: number; lastHitAt: string | null }>) => ({
    ...e,
    urls: urls(p, e),
    stats: (stats ?? hub.webhooks.endpointStats(p.id)).get(e.id) ?? { hits: 0, invalid: 0, lastHitAt: null },
  });

  app.get<{ Params: P }>('/api/projects/:slug/webhook-endpoints', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const stats = hub.webhooks.endpointStats(p.id);
    return hub.webhooks.listEndpoints(p.id).map((e) => withMeta(p, e, stats));
  });
  app.post<{ Params: P }>('/api/projects/:slug/webhook-endpoints', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const e = hub.webhooks.createEndpoint(p.id, body(req.body));
    changed(p.id, { endpoint: e.id });
    return reply.status(201).send(withMeta(p, e));
  });
  app.get<{ Params: P }>('/api/projects/:slug/webhook-endpoints/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return withMeta(p, hub.webhooks.requireEndpoint(p.id, req.params.id));
  });
  app.patch<{ Params: P }>('/api/projects/:slug/webhook-endpoints/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const e = hub.webhooks.updateEndpoint(p.id, req.params.id, body(req.body));
    changed(p.id, { endpoint: e.id });
    return withMeta(p, e);
  });
  app.delete<{ Params: P }>('/api/projects/:slug/webhook-endpoints/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const e = hub.webhooks.deleteEndpoint(p.id, req.params.id);
    changed(p.id, { endpoint: e.id, deleted: true });
    return { deleted: e.id };
  });
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/webhook-endpoints/:id/hits', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const e = hub.webhooks.requireEndpoint(p.id, req.params.id);
    return hub.webhookService.recent(p.id, 'endpointId', e.id, num(req.query.limit, 25));
  });

  // ---------- templates ----------
  app.get<{ Params: P }>('/api/projects/:slug/webhook-templates', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.webhooks.listTemplates(p.id);
  });
  app.post<{ Params: P }>('/api/projects/:slug/webhook-templates', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const t = hub.webhooks.createTemplate(p.id, body(req.body));
    changed(p.id, { template: t.id });
    return reply.status(201).send(t);
  });
  app.get<{ Params: P }>('/api/projects/:slug/webhook-templates/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.webhooks.requireTemplate(p.id, req.params.id);
  });
  app.patch<{ Params: P }>('/api/projects/:slug/webhook-templates/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const t = hub.webhooks.updateTemplate(p.id, req.params.id, body(req.body));
    changed(p.id, { template: t.id });
    return t;
  });
  app.delete<{ Params: P }>('/api/projects/:slug/webhook-templates/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const t = hub.webhooks.deleteTemplate(p.id, req.params.id);
    changed(p.id, { template: t.id, deleted: true });
    return { deleted: t.id };
  });
  const sendOpts = (p: Project, b: Record<string, unknown>) => {
    const ref = b.asUser ?? b.user;
    return { user: ref ? hub.users.requireRef(p.id, String(ref)) : null, data: b.data ?? {} };
  };
  app.post<{ Params: P }>('/api/projects/:slug/webhook-templates/:id/send', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const t = hub.webhooks.requireTemplate(p.id, req.params.id);
    const r = await hub.webhookService.send(p, t, sendOpts(p, body(req.body)));
    changed(p.id, { template: t.id, sent: r.logId });
    return r;
  });
  app.post<{ Params: P }>('/api/projects/:slug/webhook-templates/:id/preview', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const t = hub.webhooks.requireTemplate(p.id, req.params.id);
    return hub.webhookService.preview(t, sendOpts(p, body(req.body)));
  });
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/webhook-templates/:id/results', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const t = hub.webhooks.requireTemplate(p.id, req.params.id);
    return hub.webhookService.recent(p.id, 'templateId', t.id, num(req.query.limit, 25));
  });

  // ---------- sequences ----------
  app.get<{ Params: P }>('/api/projects/:slug/webhook-sequences', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.webhooks.listSequences(p.id);
  });
  app.post<{ Params: P }>('/api/projects/:slug/webhook-sequences', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const q = hub.webhooks.createSequence(p.id, body(req.body));
    changed(p.id, { sequence: q.id });
    return reply.status(201).send(q);
  });
  app.get<{ Params: P }>('/api/projects/:slug/webhook-sequences/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.webhooks.requireSequence(p.id, req.params.id);
  });
  app.patch<{ Params: P }>('/api/projects/:slug/webhook-sequences/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const q = hub.webhooks.updateSequence(p.id, req.params.id, body(req.body));
    changed(p.id, { sequence: q.id });
    return q;
  });
  app.delete<{ Params: P }>('/api/projects/:slug/webhook-sequences/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const q = hub.webhooks.deleteSequence(p.id, req.params.id);
    changed(p.id, { sequence: q.id, deleted: true });
    return { deleted: q.id };
  });
  app.post<{ Params: P }>('/api/projects/:slug/webhook-sequences/:id/run', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const q = hub.webhooks.requireSequence(p.id, req.params.id);
    const run = hub.webhookService.startSequence(p, q, sendOpts(p, body(req.body)));
    changed(p.id, { sequence: q.id, run: run.runId });
    return reply.status(202).send(run);
  });
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/webhook-sequences/:id/results', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const q = hub.webhooks.requireSequence(p.id, req.params.id);
    return hub.webhookService.recent(p.id, 'sequenceId', q.id, num(req.query.limit, 50));
  });

  // ---------- replay ----------
  app.post<{ Params: P }>('/api/logs/:id/replay', async (req) => {
    const b = body(req.body);
    const headers = b.headers === undefined ? undefined : body(b.headers);
    const r = await hub.webhookService.replay(req.params.id, {
      url: typeof b.url === 'string' ? b.url : undefined,
      method: typeof b.method === 'string' ? b.method : undefined,
      headers: headers as Record<string, string | null> | undefined,
      body: b.body,
      resign: typeof b.resign === 'boolean' ? b.resign : undefined,
    });
    const log = hub.logs.get(r.logId);
    if (log?.projectId) changed(log.projectId, { replay: r.logId });
    return r;
  });
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
