import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { FEATURE_PRIORITIES, FEATURE_STATUSES, type FeatureStatus } from '../../features/service.js';
import { HttpError } from '../../util.js';

type P = { slug: string; ref: string; taskId: string; imageId: string };
type Q = Record<string, string | undefined>;

const isJsonBody = (b: unknown) => !!b && typeof b === 'object' && !Buffer.isBuffer(b);

/**
 * Features board under /api/projects/:slug/features (features/service.ts). :ref is a feature id or its key (F-3).
 * Images: POST the raw bytes with an image/* content type (?name=), or JSON {dataUrl, name}; at most 5 MB each.
 */
export async function registerFeatureRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const svc = hub.features;
  if (!svc) return;
  const base = '/api/projects/:slug/features';
  const proj = (slug: string) => hub.projects.require(slug);

  app.get('/api/features/reference', async () => ({ statuses: FEATURE_STATUSES, priorities: FEATURE_PRIORITIES, limits: svc.limits, imageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }));

  /** ?status=idea,planned &q=words &full=1 (details, tasks and images too) */
  app.get<{ Params: P; Querystring: Q }>(base, async (req) => {
    const p = proj(req.params.slug);
    const raw = (req.query.status ?? '').trim();
    const status = raw ? (raw.split(',').map((x) => x.trim()) as FeatureStatus[]) : undefined;
    const bad = status?.find((x) => !FEATURE_STATUSES.includes(x));
    if (bad) throw new HttpError(400, `Unknown status "${bad}". Use ${FEATURE_STATUSES.join(', ')}`);
    const full = req.query.full === '1' || req.query.full === 'true';
    return { features: svc.list(p, { status, q: req.query.q, full }), counts: svc.counts(p) };
  });
  app.post<{ Params: P }>(base, async (req, reply) => reply.status(201).send(svc.create(proj(req.params.slug), req.body)));
  app.post<{ Params: P }>(`${base}/reorder`, async (req) => ({ features: svc.reorder(proj(req.params.slug), req.body) }));

  app.get<{ Params: P }>(`${base}/:ref`, async (req) => svc.get(proj(req.params.slug), req.params.ref));
  app.patch<{ Params: P }>(`${base}/:ref`, async (req) => {
    const p = proj(req.params.slug);
    // The Designer role (features.details without features.edit) may change a feature's details only.
    if (req.principal && !hub.access.can(req.principal, 'features.edit', p.slug)) {
      const keys = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body as object) : [];
      const other = keys.filter((k) => k !== 'details');
      if (other.length) throw new HttpError(403, `Your role may only edit a feature's details and images, not ${other.join(', ')}`);
    }
    return svc.update(p, req.params.ref, req.body);
  });
  app.delete<{ Params: P }>(`${base}/:ref`, async (req) => svc.delete(proj(req.params.slug), req.params.ref));

  // Tasks and subtasks
  app.get<{ Params: P }>(`${base}/:ref/tasks`, async (req) => svc.get(proj(req.params.slug), req.params.ref).tasks);
  app.post<{ Params: P }>(`${base}/:ref/tasks`, async (req, reply) => reply.status(201).send(svc.addTask(proj(req.params.slug), req.params.ref, req.body)));
  app.post<{ Params: P }>(`${base}/:ref/tasks/reorder`, async (req) => svc.reorderTasks(proj(req.params.slug), req.params.ref, req.body));
  app.patch<{ Params: P }>(`${base}/:ref/tasks/:taskId`, async (req) => svc.updateTask(proj(req.params.slug), req.params.ref, req.params.taskId, req.body));
  app.post<{ Params: P }>(`${base}/:ref/tasks/:taskId/toggle`, async (req) => svc.toggleTask(proj(req.params.slug), req.params.ref, req.params.taskId, req.body));
  app.delete<{ Params: P }>(`${base}/:ref/tasks/:taskId`, async (req) => svc.deleteTask(proj(req.params.slug), req.params.ref, req.params.taskId));

  // Images. The limit leaves room for a 5 MB image as base64 JSON, so the service answers with its own 413 text.
  app.get<{ Params: P }>(`${base}/:ref/images`, async (req) => svc.listImages(proj(req.params.slug), req.params.ref));
  app.post<{ Params: P; Querystring: Q }>(`${base}/:ref/images`, { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const p = proj(req.params.slug);
    const ct = String(req.headers['content-type'] ?? '');
    let out;
    if (Buffer.isBuffer(req.body)) out = svc.addImage(p, req.params.ref, { data: req.body, declaredType: ct, name: req.query.name });
    else if (isJsonBody(req.body)) {
      const b = req.body as { dataUrl?: unknown; name?: unknown };
      out = svc.addImageDataUrl(p, req.params.ref, b.dataUrl, b.name);
    } else if (req.body === undefined) throw new HttpError(400, 'Send the image bytes (content-type image/png, image/jpeg, image/webp or image/gif) or JSON {"dataUrl": "data:image/png;base64,…", "name"?}');
    else throw new HttpError(415, 'Only PNG, JPEG, WebP or GIF images can be uploaded');
    return reply.status(201).send(out);
  });
  app.get<{ Params: P; Querystring: Q }>(`${base}/:ref/images/:imageId`, async (req, reply) => {
    const f = svc.imageFile(proj(req.params.slug), req.params.ref, req.params.imageId);
    const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    reply
      .header('content-type', f.mime)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=3600')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(f.data);
  });
  app.delete<{ Params: P }>(`${base}/:ref/images/:imageId`, async (req) => svc.deleteImage(proj(req.params.slug), req.params.ref, req.params.imageId));
}
