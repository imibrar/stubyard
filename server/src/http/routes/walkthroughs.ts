import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import type { WalkthroughStatus } from '../../storyboards/schema.js';
import type { CleanupInput, CleanupListStatus, FinishInput, SignoffInput, StartWalkthroughInput, StepPatch, WalkthroughExecutor, WalkthroughListMode, WalkthroughPatch } from '../../storyboards/types.js';
import { HttpError } from '../../util.js';
import { headerJson, PLAYER_HTML, playerCsp, playerOrigins, RECORDING_CHUNK_BODY_LIMIT, type ByteRange } from '../../storyboards/recordings.js';

/**
 * A single "bytes=a-b" / "bytes=a-" / "bytes=-n" range of a file of size bytes: null (none, or several ranges: the
 * whole file is sent), 'invalid' (416) or the inclusive range.
 */
export function parseRange(header: string | string[] | undefined, size: number): ByteRange | null | 'invalid' {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return h.trim().startsWith('bytes=') && h.includes(',') ? null : 'invalid';
  if (m[1] === '' && m[2] === '') return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}
import { createGzip } from 'node:zlib';

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
    return svc.list(proj(req.params.slug), {
      storyboard: q.storyboard || undefined,
      status: (q.status || undefined) as WalkthroughStatus | undefined,
      mode: (q.mode || undefined) as WalkthroughListMode | undefined,
      executor: (q.executor || undefined) as WalkthroughExecutor | undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
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
  app.delete<{ Params: P; Querystring: Q }>(`${b}/:id`, async (req) =>
    svc.delete(proj(req.params.slug), req.params.id, { users: flag(req.query.users), force: flag(req.query.force), log: (err, msg) => req.log.warn({ err }, msg) }),
  );
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

  // Recording (storyboards/recordings.ts): chunks from the extension's service worker, the segment list, the events.
  const rec = hub.recordings;
  if (rec) {
    const masks = (slug: string, id: string) => svc.recordingMasks(proj(slug), id);
    app.get<{ Params: P }>(`${b}/:id/recording`, async (req) => rec.list(proj(req.params.slug), req.params.id, masks(req.params.slug, req.params.id)));
    // Pause / resume, or recording on / off for the rest of the run: answers the walkthrough view.
    app.patch<{ Params: P }>(`${b}/:id/recording`, async (req) => {
      const p = proj(req.params.slug);
      rec.setState(p, req.params.id, body(req.body));
      return svc.get(p, req.params.id);
    });
    app.delete<{ Params: P }>(`${b}/:id/recording`, async (req) => rec.delete(proj(req.params.slug), req.params.id));
    // The replay page the dashboard plays DOM segments in (recordings.ts playerCsp): nothing loads from other origins.
    app.get<{ Params: P }>(`${b}/:id/recording/player`, async (req, reply) => {
      const p = proj(req.params.slug);
      const v = svc.get(p, req.params.id);
      if (!v) throw new HttpError(404, `Walkthrough "${req.params.id}" not found`);
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', playerCsp(playerOrigins([v.origin, ...(p.settings.appOrigins ?? [])])))
        .header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff')
        .header('x-frame-options', 'SAMEORIGIN')
        .header('cross-origin-resource-policy', 'same-origin')
        .header('cache-control', 'no-store');
      return reply.send(PLAYER_HTML);
    });
    app.post<{ Params: P }>(`${b}/:id/recording/chunks`, { bodyLimit: RECORDING_CHUNK_BODY_LIMIT }, async (req, reply) => {
      const r = rec.addChunk(proj(req.params.slug), req.params.id, req.body);
      reply.status(r.stored ? 201 : 200);
      return r;
    });
    app.get<{ Params: P & { no: string } }>(`${b}/:id/recording/segments/:no`, async (req, reply) => {
      const no = Number(req.params.no);
      if (!Number.isInteger(no) || no < 1) throw new HttpError(400, 'The segment number is an integer from 1');
      const project = proj(req.params.slug);
      // A video segment (R2): one WebM file, with Range support so the <video> can seek and stream it.
      if (rec.segmentKind(project, req.params.id, no) === 'video') {
        const v = rec.videoFile(project, req.params.id, no);
        reply
          .header('content-type', v.mime)
          .header('accept-ranges', 'bytes')
          .header('cache-control', v.segment.status === 'recording' ? 'no-store' : 'private, max-age=60')
          .header('x-content-type-options', 'nosniff')
          .header('x-recording-segment', headerJson({ no: v.segment.no, kind: 'video', url: v.segment.url, stepId: v.segment.stepId, startedAt: v.segment.startedAt, endedAt: v.segment.endedAt, durationMs: v.segment.durationMs }));
        const range = parseRange(req.headers.range, v.size);
        if (range === 'invalid') {
          reply.status(416).header('content-range', `bytes */${v.size}`);
          return reply.send('');
        }
        if (range) {
          reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${v.size}`).header('content-length', range.end - range.start + 1);
          return reply.send(v.stream(range));
        }
        reply.header('content-length', v.size);
        return reply.send(v.size ? v.stream() : '');
      }
      const { segment, stream } = rec.segmentStream(project, req.params.id, no);
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
      reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('cache-control', segment.status === 'recording' ? 'no-store' : 'private, max-age=60')
        .header('x-content-type-options', 'nosniff')
        .header('x-recording-segment', headerJson({ no: segment.no, url: segment.url, stepId: segment.stepId, startedAt: segment.startedAt, endedAt: segment.endedAt, events: segment.events }));
      if (gzip) {
        reply.header('content-encoding', 'gzip').header('vary', 'accept-encoding');
        return reply.send(stream.pipe(createGzip()));
      }
      return reply.send(stream);
    });
  }

  app.post<{ Params: P }>(`${b}/:id/finish`, async (req) => svc.finish(proj(req.params.slug), req.params.id, body(req.body) as unknown as FinishInput));
  // A person signs off a finished agent run (the agent's finish gives a verdict only).
  app.post<{ Params: P }>(`${b}/:id/signoff`, async (req) => svc.signoff(proj(req.params.slug), req.params.id, body(req.body) as unknown as SignoffInput));
  app.post<{ Params: P }>(`${b}/:id/abandon`, async (req) => {
    const note = body(req.body).note;
    return svc.abandon(proj(req.params.slug), req.params.id, note === undefined ? undefined : (note as string));
  });
  app.post<{ Params: P }>(`${b}/:id/reopen`, async (req) => svc.reopen(proj(req.params.slug), req.params.id));

  // Cleanup of the test data runs created (storyboards/cleanup.ts).
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/cleanup', async (req) =>
    svc.listCleanup(proj(req.params.slug), {
      status: (req.query.status || undefined) as CleanupListStatus | undefined,
      mode: (req.query.mode || undefined) as WalkthroughListMode | undefined,
    }),
  );
  app.post<{ Params: P }>('/api/projects/:slug/cleanup', async (req, reply) => {
    try {
      return await svc.cleanup(proj(req.params.slug), body(req.body) as unknown as CleanupInput, { log: (err, msg) => req.log.warn({ err }, msg) });
    } catch (err) {
      // onConflict "ask": the conflicts are on the body itself ({error, conflicts}), not only under details.
      const details = err instanceof HttpError ? (err.details as { conflicts?: unknown } | undefined) : undefined;
      if (err instanceof HttpError && err.statusCode === 409 && details?.conflicts) return reply.status(409).send({ error: err.message, conflicts: details.conflicts, details, requestId: req.trafficLogId });
      throw err;
    }
  });
  app.get<{ Params: P }>(`${b}/:id/cleanup`, async (req) => svc.cleanupItem(proj(req.params.slug), req.params.id));
  app.post<{ Params: P }>(`${b}/:id/cleanup/dismiss`, async (req) => {
    const note = body(req.body).note;
    return svc.dismissCleanup(proj(req.params.slug), req.params.id, note === undefined ? undefined : (note as string));
  });
  app.post<{ Params: P }>(`${b}/:id/cleanup/reopen`, async (req) => svc.reopenCleanup(proj(req.params.slug), req.params.id));

  app.get<{ Params: P }>(`${b}/:id/summary`, async (req) => svc.summary(proj(req.params.slug), req.params.id));
  app.get<{ Params: P }>(`${b}/:id/summary.html`, async (req, reply) => {
    const html = svc.summaryHtml(proj(req.params.slug), req.params.id);
    reply.header('content-type', 'text/html; charset=utf-8').header('content-security-policy', SUMMARY_HTML_CSP).header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    return reply.send(html);
  });
}
