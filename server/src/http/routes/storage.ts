import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import { BUCKET_NAME_RE, type BucketCors } from '../../repos/storage.js';
import { STORAGE_RULE_PRESETS, type StorageRuleInput } from '../../storage/rules.js';
import { parseRange } from '../../storage/s3/common.js';
import { STORAGE_ACTIONS, STORAGE_OPS } from '../../storage/types.js';
import { HttpError } from '../../util.js';

type P = { slug: string; instance: string; bucket: string; rule: string; id: string };
type Q = Record<string, string | undefined>;

const DATA_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'] as const;

/**
 * File storage simulator.
 *  - Data plane: /storage/<project>/<instance>/… in an encapsulated plugin whose only content-type parser hands the
 *    raw stream through, so the global buffering parser (and its body limit) never sees object bytes.
 *  - Control API: /api/projects/:slug/storage/… (JSON only, like the rest of /api).
 */
export async function registerStorageRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const svc = hub.storage;
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});
  const changed = (projectId: string, data: unknown) => hub.bus.publish({ type: 'storage.changed', projectId, data });
  const load = (req: FastifyRequest<{ Params: P }>) => {
    const project = hub.projects.require(req.params.slug);
    const instance = svc.repo.requireInstance(project.id, req.params.instance);
    return { project, instance };
  };
  const loadBucket = (req: FastifyRequest<{ Params: P }>) => {
    const o = load(req);
    const bucket = svc.repo.getBucket(o.instance.id, req.params.bucket);
    if (!bucket) throw new HttpError(404, `Bucket "${req.params.bucket}" not found`);
    return { ...o, bucket };
  };
  const runOf = (req: FastifyRequest, projectId: string) => {
    const q = (req.query ?? {}) as Q;
    const raw = q.run ?? (req.headers['x-hub-run'] as string | undefined);
    if (!raw) return null;
    const run = hub.runs.resolver.explicit(projectId, raw);
    if (!run) throw new HttpError(404, `No active test run "${raw}"`);
    return run;
  };

  // ---------------------------------------------------------------- data plane
  await app.register(async (s) => {
    s.removeAllContentTypeParsers();
    s.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    const handler = (req: FastifyRequest, reply: Parameters<typeof svc.handle>[1]) => svc.handle(req, reply);
    const bodyLimit = Number.MAX_SAFE_INTEGER; // per-object limits are enforced while streaming
    s.route({ method: [...DATA_METHODS], url: '/storage/:project/:instance', handler, bodyLimit, exposeHeadRoute: false });
    s.route({ method: [...DATA_METHODS], url: '/storage/:project/:instance/*', handler, bodyLimit, exposeHeadRoute: false });
  });

  // ---------------------------------------------------------------- presets
  app.get('/api/storage-presets', async () => ({ presets: svc.presets(), actions: STORAGE_ACTIONS, ops: STORAGE_OPS, rulePresets: STORAGE_RULE_PRESETS }));

  // ---------------------------------------------------------------- instances
  app.get<{ Params: P }>('/api/projects/:slug/storage', async (req) => {
    const project = hub.projects.require(req.params.slug);
    return svc.repo.listInstances(project.id).map((i) => svc.view(project, i));
  });

  app.post<{ Params: P }>('/api/projects/:slug/storage', async (req, reply) => {
    const project = hub.projects.require(req.params.slug);
    const i = svc.create(project, body(req.body));
    changed(project.id, { created: i.slug });
    return reply.status(201).send(svc.view(project, i));
  });

  app.get<{ Params: P }>('/api/projects/:slug/storage/:instance', async (req) => {
    const { project, instance } = load(req);
    return { ...svc.view(project, instance), rules: svc.repo.listRules(instance.id, { runId: 'all' }) };
  });

  app.patch<{ Params: P }>('/api/projects/:slug/storage/:instance', async (req) => {
    const { project, instance } = load(req);
    const i = svc.update(instance, body(req.body));
    changed(project.id, { updated: i.slug });
    return svc.view(project, i);
  });

  app.delete<{ Params: P }>('/api/projects/:slug/storage/:instance', async (req) => {
    const { project, instance } = load(req);
    svc.repo.deleteInstance(instance);
    fs.rmSync(path.join(svc.root, project.id, instance.id), { recursive: true, force: true });
    changed(project.id, { deleted: instance.slug });
    return { deleted: instance.slug };
  });

  // ---------------------------------------------------------------- buckets
  app.get<{ Params: P }>('/api/projects/:slug/storage/:instance/buckets', async (req) => {
    const { instance } = load(req);
    return svc.repo.listBuckets(instance.id).map((b) => svc.bucketView(b));
  });

  app.post<{ Params: P }>('/api/projects/:slug/storage/:instance/buckets', async (req, reply) => {
    const { project, instance } = load(req);
    const b = body(req.body);
    const name = String(b.name ?? '');
    if (!BUCKET_NAME_RE.test(name)) throw new HttpError(400, `Invalid bucket name "${name}" (3-63 characters: lower-case letters, digits, dots, dashes, underscores)`);
    if (svc.repo.getBucket(instance.id, name)) throw new HttpError(409, `Bucket "${name}" already exists`);
    const bucket = svc.repo.createBucket(instance, { name, region: b.region ? String(b.region) : svc.region(instance), public: b.public === true, cors: b.cors as BucketCors | undefined });
    changed(project.id, { instance: instance.slug, bucket: name, created: true });
    return reply.status(201).send(svc.bucketView(bucket));
  });

  app.patch<{ Params: P }>('/api/projects/:slug/storage/:instance/buckets/:bucket', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const b = body(req.body);
    if (b.cors !== undefined) {
      const c = b.cors as BucketCors;
      if (!c || !['permissive', 'rules', 'none'].includes(c.mode)) throw new HttpError(400, '"cors.mode" must be permissive, rules or none');
      if (c.mode === 'rules' && (!Array.isArray(c.rules) || c.rules.some((r) => !Array.isArray(r.AllowedOrigins) || !Array.isArray(r.AllowedMethods)))) throw new HttpError(400, '"cors.rules" must be S3 CORSRule objects ({ AllowedOrigins, AllowedMethods, AllowedHeaders?, ExposeHeaders?, MaxAgeSeconds? })');
    }
    const out = svc.repo.updateBucket(bucket, { public: typeof b.public === 'boolean' ? b.public : undefined, cors: b.cors as BucketCors | undefined, region: b.region !== undefined ? (b.region as string | null) : undefined });
    changed(project.id, { instance: instance.slug, bucket: bucket.name, updated: true });
    return svc.bucketView(out);
  });

  app.delete<{ Params: P; Querystring: Q }>('/api/projects/:slug/storage/:instance/buckets/:bucket', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const stats = svc.repo.bucketStats(bucket.id);
    if (stats.objects && !['1', 'true'].includes(String(req.query.force))) throw new HttpError(409, `Bucket "${bucket.name}" has ${stats.objects} objects; pass ?force=1 to delete them too`);
    svc.store(instance).empty(bucket);
    svc.repo.deleteBucket(bucket);
    changed(project.id, { instance: instance.slug, bucket: bucket.name, deleted: true });
    return { deleted: bucket.name, objects: stats.objects };
  });

  app.post<{ Params: P }>('/api/projects/:slug/storage/:instance/buckets/:bucket/empty', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const n = svc.store(instance).empty(bucket);
    changed(project.id, { instance: instance.slug, bucket: bucket.name, emptied: n });
    return { deleted: n };
  });

  // ---------------------------------------------------------------- objects
  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/storage/:instance/buckets/:bucket/objects', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const q = req.query;
    const limit = Math.min(Math.max(Number(q.limit ?? 200) || 200, 1), 1000);
    const run = q.run ? runOf(req, project.id) : null;
    if (q.search || run) {
      const rows = svc.repo.searchObjects(bucket.id, q.search ?? '', { runId: run?.id ?? null, limit: limit + 1, after: q.cursor });
      const page = rows.slice(0, limit);
      return { objects: page.map((o) => svc.objectView(project, instance, bucket, o)), prefixes: [], truncated: rows.length > limit, cursor: rows.length > limit ? page[page.length - 1].key : null };
    }
    const r = svc.store(instance).list(bucket, { prefix: q.prefix ?? '', delimiter: q.delimiter || undefined, after: q.cursor || undefined, limit });
    return { objects: r.objects.map((o) => svc.objectView(project, instance, bucket, o)), prefixes: r.prefixes, truncated: r.truncated, cursor: r.truncated ? r.last : null };
  });

  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/storage/:instance/buckets/:bucket/objects/wait', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const q = req.query;
    const prefix = q.prefix ?? '';
    const count = Math.max(1, Number(q.count ?? 1) || 1);
    const timeoutMs = Math.min(Math.max(Number(q.timeoutMs ?? 10_000) || 0, 0), 120_000);
    const after = q.after ?? new Date(Date.now() - 1).toISOString();
    const check = () => svc.repo.objectsSince(bucket.id, prefix, after, 100);
    let found = check();
    if (found.length < count && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, timeoutMs);
        const unsub = hub.bus.subscribe((e) => {
          if (e.type !== 'storage.changed' || e.projectId !== project.id) return;
          found = check();
          if (found.length >= count) done();
        });
        req.raw.once('close', done);
        function done() {
          clearTimeout(t);
          unsub();
          resolve();
        }
      });
    }
    const objects = found.map((o) => svc.objectView(project, instance, bucket, o));
    return { objects, timedOut: found.length < count, cursor: found.length ? found[found.length - 1].updatedAt : after };
  });

  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/storage/:instance/buckets/:bucket/object', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const o = svc.repo.getObject(bucket.id, String(req.query.key ?? ''));
    if (!o) throw new HttpError(404, `Object "${req.query.key}" not found`);
    return svc.objectView(project, instance, bucket, o);
  });

  app.delete<{ Params: P; Querystring: Q }>('/api/projects/:slug/storage/:instance/buckets/:bucket/object', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const key = String(req.query.key ?? '');
    const ok = svc.store(instance).remove(bucket, key);
    if (!ok) throw new HttpError(404, `Object "${key}" not found`);
    changed(project.id, { instance: instance.slug, bucket: bucket.name, key, deleted: true });
    return { deleted: key };
  });

  app.get<{ Params: P; Querystring: Q }>('/api/projects/:slug/storage/:instance/buckets/:bucket/object/content', async (req, reply) => {
    const { instance, bucket } = loadBucket(req);
    const o = svc.repo.getObject(bucket.id, String(req.query.key ?? ''));
    if (!o) throw new HttpError(404, `Object "${req.query.key}" not found`);
    const range = parseRange(req.headers.range, o.size);
    if (range === 'invalid') return reply.status(416).header('content-range', `bytes */${o.size}`).send({ error: 'Range not satisfiable' });
    reply.header('content-type', o.contentType || 'application/octet-stream');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('accept-ranges', 'bytes');
    // Always sandboxed here: the dashboard origin must never run uploaded HTML / SVG.
    reply.header('content-security-policy', 'sandbox');
    const name = o.key.split('/').pop() || 'download';
    reply.header('content-disposition', `${['1', 'true'].includes(String(req.query.download)) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    const len = range ? range.end - range.start + 1 : o.size;
    reply.header('content-length', String(len));
    if (range) reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${o.size}`);
    return reply.send(svc.store(instance).open(o, range));
  });

  app.post<{ Params: P }>('/api/projects/:slug/storage/:instance/buckets/:bucket/objects/delete', async (req) => {
    const { project, instance, bucket } = loadBucket(req);
    const b = body(req.body);
    const st = svc.store(instance);
    let keys: string[] = [];
    if (Array.isArray(b.keys)) keys = b.keys.map(String);
    else if (typeof b.prefix === 'string') keys = svc.repo.objectsForBucket(bucket.id).filter((o) => o.key.startsWith(String(b.prefix))).map((o) => o.key);
    else throw new HttpError(400, 'Send { "keys": [...] } or { "prefix": "..." }');
    let n = 0;
    for (const k of keys) if (st.remove(bucket, k)) n++;
    changed(project.id, { instance: instance.slug, bucket: bucket.name, deleted: n });
    return { deleted: n };
  });

  // ---------------------------------------------------------------- presign
  app.post<{ Params: P }>('/api/projects/:slug/storage/:instance/presign', async (req) => {
    const { project, instance } = load(req);
    const b = body(req.body);
    if (!b.bucket || !b.key) throw new HttpError(400, '"bucket" and "key" are required');
    const method = String(b.method ?? 'GET').toUpperCase();
    if (!['GET', 'PUT', 'HEAD', 'DELETE'].includes(method)) throw new HttpError(400, '"method" must be GET, PUT, HEAD or DELETE');
    const expiresIn = Number(b.expiresIn ?? 900);
    if (!(expiresIn > 0 && expiresIn <= 604800)) throw new HttpError(400, '"expiresIn" must be 1..604800 seconds');
    return svc.presign(project, instance, { bucket: String(b.bucket), key: String(b.key), method: method as 'GET', expiresIn, contentType: b.contentType ? String(b.contentType) : undefined, scenario: b.scenario ? String(b.scenario) : undefined });
  });

  // ---------------------------------------------------------------- rules
  const rulesUrl = '/api/projects/:slug/storage/:instance/rules';
  app.get<{ Params: P; Querystring: Q }>(rulesUrl, async (req) => {
    const { project, instance } = load(req);
    const run = runOf(req, project.id);
    return svc.repo.listRules(instance.id, { runId: run ? run.id : req.query.all ? 'all' : null });
  });
  app.post<{ Params: P }>(rulesUrl, async (req, reply) => {
    const { project, instance } = load(req);
    const run = runOf(req, project.id);
    const r = svc.addRule(project, instance, body(req.body) as unknown as StorageRuleInput, run?.id ?? null);
    changed(project.id, { instance: instance.slug, rule: r.id });
    return reply.status(201).send(r);
  });
  app.put<{ Params: P }>(rulesUrl, async (req) => {
    const { project, instance } = load(req);
    const run = runOf(req, project.id);
    const b = req.body;
    const list = Array.isArray(b) ? b : Array.isArray(body(b).rules) ? (body(b).rules as unknown[]) : null;
    if (!list) throw new HttpError(400, 'Send an array of rules (or { "rules": [...] })');
    const out = hub.db.transaction(() => {
      svc.repo.clearRules(instance.id, run?.id ?? null);
      return list.map((i) => svc.addRule(project, instance, i as StorageRuleInput, run?.id ?? null));
    })();
    changed(project.id, { instance: instance.slug, rules: out.length });
    return out;
  });
  app.delete<{ Params: P; Querystring: Q }>(rulesUrl, async (req) => {
    const { project, instance } = load(req);
    const run = runOf(req, project.id);
    const n = svc.repo.clearRules(instance.id, run ? run.id : req.query.all ? 'all' : null);
    changed(project.id, { instance: instance.slug, cleared: n });
    return { deleted: n };
  });
  app.patch<{ Params: P }>(`${rulesUrl}/:rule`, async (req) => {
    const { project, instance } = load(req);
    const r = svc.repo.getRule(req.params.rule);
    if (!r || r.instanceId !== instance.id) throw new HttpError(404, `Rule "${req.params.rule}" not found`);
    const b = body(req.body);
    const out = svc.repo.updateRule(r.id, { enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, label: b.label !== undefined ? (b.label as string | null) : undefined });
    changed(project.id, { instance: instance.slug, rule: r.id });
    return out;
  });
  app.delete<{ Params: P }>(`${rulesUrl}/:rule`, async (req) => {
    const { project, instance } = load(req);
    const r = svc.repo.getRule(req.params.rule);
    if (!r || r.instanceId !== instance.id) throw new HttpError(404, `Rule "${req.params.rule}" not found`);
    svc.repo.deleteRule(r.id);
    changed(project.id, { instance: instance.slug, rule: r.id });
    return { deleted: r.id };
  });

  // ---------------------------------------------------------------- uploads in progress
  app.get<{ Params: P }>('/api/projects/:slug/storage/:instance/uploads', async (req) => {
    const { instance } = load(req);
    return svc.repo.uploadsForInstance(instance.id);
  });
  app.delete<{ Params: P }>('/api/projects/:slug/storage/:instance/uploads/:id', async (req) => {
    const { project, instance } = load(req);
    const u = svc.repo.getUpload(req.params.id);
    const b = u ? svc.repo.bucketById(u.bucketId) : null;
    if (!u || !b || b.instanceId !== instance.id) throw new HttpError(404, `Upload "${req.params.id}" not found`);
    svc.store(instance).uploads.abort(u);
    changed(project.id, { instance: instance.slug, aborted: u.id });
    return { deleted: u.id };
  });
}
