import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import type { WalkthroughStatus } from '../../storyboards/schema.js';
import type { FinishInput, StartWalkthroughInput, StepPatch, WalkthroughPatch } from '../../storyboards/types.js';
import { HttpError } from '../../util.js';

type P = { slug: string; id: string; stepId: string; shotId: string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});
const flag = (v: string | undefined) => v === '1' || v === 'true' || v === 'yes';

/** The CSP of summary.html: inline styles and data: images only (no scripts, no network). */
export const SUMMARY_HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

/** Walkthroughs (docs/design/storyboards.md §3.7): /api/projects/:slug/walkthroughs/… */
export async function registerWalkthroughRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.walkthroughs) return;
  const svc = hub.walkthroughs;
  const b = '/api/projects/:slug/walkthroughs';
  const proj = (slug: string) => hub.projects.require(slug);

  app.get<{ Params: P; Querystring: Q }>(b, async (req) => {
    const q = req.query;
    return svc.list(proj(req.params.slug), { storyboard: q.storyboard || undefined, status: (q.status || undefined) as WalkthroughStatus | undefined, limit: q.limit ? Number(q.limit) : undefined });
  });
  app.post<{ Params: P }>(b, async (req, reply) => {
    const v = svc.start(proj(req.params.slug), body(req.body) as unknown as StartWalkthroughInput);
    reply.status(201);
    return v;
  });
  app.get<{ Params: P }>(`${b}/:id`, async (req) => {
    const v = svc.get(proj(req.params.slug), req.params.id);
    if (!v) throw new HttpError(404, `Walkthrough "${req.params.id}" not found`);
    return v;
  });
  app.patch<{ Params: P }>(`${b}/:id`, async (req) => svc.patch(proj(req.params.slug), req.params.id, body(req.body) as WalkthroughPatch));
  app.delete<{ Params: P; Querystring: Q }>(`${b}/:id`, async (req) => svc.delete(proj(req.params.slug), req.params.id, { users: flag(req.query.users) }));
  app.post<{ Params: P }>(`${b}/:id/refresh`, async (req) => svc.refresh(proj(req.params.slug), req.params.id));

  app.post<{ Params: P }>(`${b}/:id/steps/:stepId/resolve`, async (req) => svc.resolveStep(proj(req.params.slug), req.params.id, req.params.stepId));
  app.patch<{ Params: P }>(`${b}/:id/steps/:stepId`, async (req) => svc.updateStep(proj(req.params.slug), req.params.id, req.params.stepId, body(req.body) as StepPatch));

  // A 600 KB JPEG is ~820 KB as base64: room above that so the cap answers with its own 413 message.
  app.post<{ Params: P }>(`${b}/:id/steps/:stepId/shots`, { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const dataUrl = body(req.body).dataUrl;
    if (typeof dataUrl !== 'string') throw new HttpError(400, 'dataUrl is required ("data:image/jpeg;base64,…")');
    const r = svc.addShot(proj(req.params.slug), req.params.id, req.params.stepId, dataUrl);
    reply.status(201);
    return r;
  });
  app.get<{ Params: P }>(`${b}/:id/shots/:shotId`, async (req, reply) => {
    const s = svc.getShot(proj(req.params.slug), req.params.id, req.params.shotId);
    if (!s) throw new HttpError(404, `Screenshot "${req.params.shotId}" not found`);
    reply.header('content-type', s.mime).header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff');
    return reply.send(s.data);
  });
  app.delete<{ Params: P }>(`${b}/:id/shots/:shotId`, async (req) => {
    svc.deleteShot(proj(req.params.slug), req.params.id, req.params.shotId);
    return { deleted: req.params.shotId };
  });

  app.post<{ Params: P }>(`${b}/:id/finish`, async (req) => svc.finish(proj(req.params.slug), req.params.id, body(req.body) as unknown as FinishInput));
  app.post<{ Params: P }>(`${b}/:id/abandon`, async (req) => {
    const note = body(req.body).note;
    return svc.abandon(proj(req.params.slug), req.params.id, note === undefined ? undefined : (note as string));
  });
  app.post<{ Params: P }>(`${b}/:id/reopen`, async (req) => svc.reopen(proj(req.params.slug), req.params.id));

  app.get<{ Params: P }>(`${b}/:id/summary`, async (req) => svc.summary(proj(req.params.slug), req.params.id));
  app.get<{ Params: P }>(`${b}/:id/summary.html`, async (req, reply) => {
    const html = svc.summaryHtml(proj(req.params.slug), req.params.id);
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', SUMMARY_HTML_CSP).header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    return reply.send(html);
  });
}
