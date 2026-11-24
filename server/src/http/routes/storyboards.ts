import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Hub } from '../../hub.js';
import { TEMPLATE_VARIABLE_HELP } from '../../storyboards/render.js';
import { FIELD_KINDS, STEP_KINDS, STORYBOARD_SCHEMAS } from '../../storyboards/schema.js';
import type { DataSetPatch, FromSnapshotInput, ImportMode } from '../../storyboards/types.js';
import { HttpError } from '../../util.js';

type P = { slug: string; key: string };
type Q = Record<string, string | undefined>;
type J = Record<string, unknown>;
const body = (b: unknown): J => (b && typeof b === 'object' && !Array.isArray(b) && !Buffer.isBuffer(b) ? (b as J) : {});
const flag = (v: unknown) => v === true || v === '1' || v === 'true' || v === 'yes';
const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));

let schemaCache: unknown = null;
/** GET /api/storyboard-schema: the zod contract as JSON Schema (input side), plus the variable help and enums. */
function schemaDoc(): unknown {
  if (!schemaCache) {
    const schemas: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(STORYBOARD_SCHEMAS)) schemas[k] = z.toJSONSchema(s, { io: 'input' });
    schemaCache = { schemas, variables: TEMPLATE_VARIABLE_HELP, fieldKinds: FIELD_KINDS, stepKinds: STEP_KINDS };
  }
  return schemaCache;
}

/** Storyboards authoring (docs/design/storyboards.md §3.1–3.6): /api/projects/:slug/{login-recipes,data-sets,storyboards,page-snapshots}. */
export async function registerStoryboardRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  if (!hub.storyboards) return;
  const svc = hub.storyboards;
  const b = '/api/projects/:slug';
  const proj = (slug: string) => hub.projects.require(slug);

  // ------------------------------------------------------------ discovery (§3.1)
  app.get<{ Querystring: Q }>('/api/storyboards/match', async (req) => {
    if (!req.query.origin) throw new HttpError(400, 'Pass ?origin=<origin of the app>, e.g. http://localhost:3183');
    const m = svc.matchOrigin(req.query.origin);
    return { ...m, projects: m.projects.filter((p) => hub.access.sees(req.principal, p.slug)) };
  });
  app.get('/api/storyboard-schema', async () => schemaDoc());

  // ------------------------------------------------------------ login recipes (§3.2)
  app.get<{ Params: P }>(`${b}/login-recipes`, async (req) => svc.listLoginRecipes(proj(req.params.slug)));
  app.get<{ Params: P }>(`${b}/login-recipes/:key`, async (req) => {
    const r = svc.getLoginRecipe(proj(req.params.slug), req.params.key);
    if (!r) throw new HttpError(404, `Login recipe for role "${req.params.key}" not found`);
    return r;
  });
  app.put<{ Params: P }>(`${b}/login-recipes/:key`, async (req, reply) => {
    const r = svc.upsertLoginRecipe(proj(req.params.slug), req.params.key, req.body);
    reply.status(r.created ? 201 : 200);
    return r.view;
  });
  app.delete<{ Params: P; Querystring: Q }>(`${b}/login-recipes/:key`, async (req) => {
    svc.deleteLoginRecipe(proj(req.params.slug), req.params.key, { force: flag(req.query.force) });
    return { deleted: req.params.key };
  });

  // ------------------------------------------------------------ data sets (§3.3)
  app.get<{ Params: P; Querystring: Q }>(`${b}/data-sets`, async (req) => svc.listDataSets(proj(req.params.slug), { url: str(req.query.url) }));
  app.post<{ Params: P }>(`${b}/data-sets/from-snapshot`, async (req, reply) => {
    const v = svc.dataSetFromSnapshot(proj(req.params.slug), body(req.body) as unknown as FromSnapshotInput);
    reply.status(201);
    return v;
  });
  app.get<{ Params: P }>(`${b}/data-sets/:key`, async (req) => {
    const d = svc.getDataSet(proj(req.params.slug), req.params.key);
    if (!d) throw new HttpError(404, `Data set "${req.params.key}" not found`);
    return d;
  });
  app.put<{ Params: P }>(`${b}/data-sets/:key`, async (req, reply) => {
    const r = svc.upsertDataSet(proj(req.params.slug), req.params.key, req.body);
    reply.status(r.created ? 201 : 200);
    return r.view;
  });
  app.patch<{ Params: P }>(`${b}/data-sets/:key`, async (req) => svc.patchDataSet(proj(req.params.slug), req.params.key, body(req.body) as DataSetPatch));
  app.delete<{ Params: P; Querystring: Q }>(`${b}/data-sets/:key`, async (req) => {
    svc.deleteDataSet(proj(req.params.slug), req.params.key, { force: flag(req.query.force) });
    return { deleted: req.params.key };
  });
  app.post<{ Params: P }>(`${b}/data-sets/:key/preview`, async (req) => {
    const o = body(req.body);
    return svc.previewDataSet(proj(req.params.slug), req.params.key, { storyboard: str(o.storyboard), actor: str(o.actor), walkthrough: str(o.walkthrough) });
  });

  // ------------------------------------------------------------ storyboards (§3.4) and bundles (§3.6)
  app.get<{ Params: P; Querystring: Q }>(`${b}/storyboards`, async (req) => svc.listStoryboards(proj(req.params.slug), { tag: str(req.query.tag) }));
  app.get<{ Params: P; Querystring: Q }>(`${b}/storyboards/export`, async (req) => {
    const names = str(req.query.storyboards)?.split(',').map((s) => s.trim()).filter(Boolean);
    return svc.exportBundle(proj(req.params.slug), { storyboards: names, secrets: flag(req.query.secrets) });
  });
  app.post<{ Params: P }>(`${b}/storyboards/import`, async (req) => {
    const o = body(req.body);
    if (o.bundle === undefined) throw new HttpError(400, 'Send {"bundle": {...}, "mode"?: "upsert" | "create-only" | "replace", "dryRun"?: true}');
    return svc.importBundle(proj(req.params.slug), o.bundle, { mode: str(o.mode) as ImportMode | undefined, dryRun: flag(o.dryRun ?? o.dry_run) });
  });
  app.post<{ Params: P }>(`${b}/storyboards/validate`, async (req) => {
    const o = body(req.body);
    return svc.validateStoryboard(proj(req.params.slug), { storyboard: o.storyboard, slug: str(o.slug) });
  });
  app.get<{ Params: P }>(`${b}/storyboards/:key`, async (req) => {
    const s = svc.getStoryboard(proj(req.params.slug), req.params.key);
    if (!s) throw new HttpError(404, `Storyboard "${req.params.key}" not found`);
    return s;
  });
  app.put<{ Params: P }>(`${b}/storyboards/:key`, async (req, reply) => {
    const r = svc.upsertStoryboard(proj(req.params.slug), req.params.key, req.body);
    reply.status(r.created ? 201 : 200);
    return r.view;
  });
  app.delete<{ Params: P }>(`${b}/storyboards/:key`, async (req) => {
    svc.deleteStoryboard(proj(req.params.slug), req.params.key);
    return { deleted: req.params.key };
  });
  app.post<{ Params: P }>(`${b}/storyboards/:key/duplicate`, async (req, reply) => {
    const o = body(req.body);
    const v = svc.duplicateStoryboard(proj(req.params.slug), req.params.key, { slug: String(o.slug ?? ''), name: str(o.name) });
    reply.status(201);
    return v;
  });

  // ------------------------------------------------------------ page snapshots (§3.5)
  app.post<{ Params: P }>(`${b}/page-snapshots`, async (req, reply) => {
    const s = svc.savePageSnapshot(proj(req.params.slug), req.body);
    reply.status(201);
    return s;
  });
  app.get<{ Params: P; Querystring: Q }>(`${b}/page-snapshots`, async (req) =>
    svc.listPageSnapshots(proj(req.params.slug), { url: str(req.query.url), limit: req.query.limit ? Number(req.query.limit) : undefined }),
  );
  app.get<{ Params: P }>(`${b}/page-snapshots/:key`, async (req) => {
    const s = svc.getPageSnapshot(proj(req.params.slug), req.params.key);
    if (!s) throw new HttpError(404, `Page snapshot "${req.params.key}" not found`);
    return s;
  });
  app.delete<{ Params: P }>(`${b}/page-snapshots/:key`, async (req) => {
    svc.deletePageSnapshot(proj(req.params.slug), req.params.key);
    return { deleted: req.params.key };
  });
}
