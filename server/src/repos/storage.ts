import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson, slugify, SLUG_RE } from '../util.js';

/** File storage simulator rows (migration 11). Bytes live on disk (storage/store.ts), never in the database. */

export interface StorageCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StorageInstanceConfig {
  /** Credentials accepted in strict mode (lax mode accepts any). Default: the preset's. */
  credentials?: StorageCredential[];
  /** Turn "would fail in production" warnings into the provider's errors. */
  strict?: boolean;
  /** Verify SigV4 signatures when the secret is known (also in lax mode, as errors instead of warnings). */
  verifySignatures?: boolean;
  /** Create a bucket on first write when it does not exist (default true). */
  autoCreateBuckets?: boolean;
  region?: string | null;
  browserBaseUrl?: string | null;
  quotaBytes?: number | null;
  maxObjectBytes?: number | null;
  /** Serve HTML / SVG / XML objects without Content-Security-Policy: sandbox. */
  allowActiveContent?: boolean;
  [key: string]: unknown;
}

export interface StorageInstance {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  preset: string;
  config: StorageInstanceConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CorsRule {
  AllowedOrigins: string[];
  AllowedMethods: string[];
  AllowedHeaders?: string[];
  ExposeHeaders?: string[];
  MaxAgeSeconds?: number;
  ID?: string;
}

export interface BucketCors {
  mode: 'permissive' | 'rules' | 'none';
  rules?: CorsRule[];
}

export interface StorageBucket {
  id: string;
  projectId: string;
  instanceId: string;
  name: string;
  region: string | null;
  public: boolean;
  cors: BucketCors;
  config: Record<string, unknown>;
  createdAt: string;
}

export interface StorageObject {
  id: string;
  projectId: string;
  bucketId: string;
  key: string;
  size: number;
  etag: string;
  md5: string | null;
  contentType: string | null;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  checksums: Record<string, string>;
  parts: number | null;
  acl: string | null;
  extra: Record<string, unknown>;
  source: string;
  runId: string | null;
  logId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageUpload {
  id: string;
  projectId: string;
  bucketId: string;
  kind: 's3-multipart' | 'azure-blocks' | 'gcs-resumable' | 'cloudinary-chunked' | 'supabase-signed';
  key: string;
  contentType: string | null;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  state: Record<string, unknown>;
  runId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface StoragePart {
  uploadId: string;
  partId: string;
  size: number;
  etag: string;
  md5: string;
  checksums: Record<string, string>;
  createdAt: string;
}

export interface StorageRule {
  id: string;
  projectId: string;
  instanceId: string;
  bucketId: string | null;
  runId: string | null;
  op: string;
  keyPrefix: string | null;
  action: string;
  params: Record<string, unknown>;
  position: number;
  remainingCount: number | null;
  skipCount: number;
  failRate: number | null;
  expiresAt: string | null;
  label: string | null;
  hits: number;
  enabled: boolean;
  createdAt: string;
  active: boolean;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

const toInstance = (r: Row): StorageInstance => ({
  id: String(r.id),
  projectId: String(r.project_id),
  slug: String(r.slug),
  name: String(r.name),
  preset: String(r.preset),
  config: parseJson(r.config as string, {}),
  enabled: r.enabled === 1,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toBucket = (r: Row): StorageBucket => ({
  id: String(r.id),
  projectId: String(r.project_id),
  instanceId: String(r.instance_id),
  name: String(r.name),
  region: str(r.region),
  public: r.public === 1,
  cors: parseJson(r.cors as string, { mode: 'permissive' }),
  config: parseJson(r.config as string, {}),
  createdAt: String(r.created_at),
});

export const toObject = (r: Row): StorageObject => ({
  id: String(r.id),
  projectId: String(r.project_id),
  bucketId: String(r.bucket_id),
  key: String(r.key),
  size: Number(r.size),
  etag: String(r.etag),
  md5: str(r.md5),
  contentType: str(r.content_type),
  headers: parseJson(r.headers as string, {}),
  metadata: parseJson(r.metadata as string, {}),
  checksums: parseJson(r.checksums as string, {}),
  parts: r.parts === null || r.parts === undefined ? null : Number(r.parts),
  acl: str(r.acl),
  extra: parseJson(r.extra as string, {}),
  source: String(r.source),
  runId: str(r.run_id),
  logId: str(r.log_id),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toUpload = (r: Row): StorageUpload => ({
  id: String(r.id),
  projectId: String(r.project_id),
  bucketId: String(r.bucket_id),
  kind: r.kind as StorageUpload['kind'],
  key: String(r.key),
  contentType: str(r.content_type),
  headers: parseJson(r.headers as string, {}),
  metadata: parseJson(r.metadata as string, {}),
  state: parseJson(r.state as string, {}),
  runId: str(r.run_id),
  createdAt: String(r.created_at),
  expiresAt: String(r.expires_at),
});

const toPart = (r: Row): StoragePart => ({
  uploadId: String(r.upload_id),
  partId: String(r.part_id),
  size: Number(r.size),
  etag: String(r.etag),
  md5: String(r.md5),
  checksums: parseJson(r.checksums as string, {}),
  createdAt: String(r.created_at),
});

const toRule = (r: Row): StorageRule => {
  const expired = !!r.expires_at && String(r.expires_at) <= nowIso();
  const remaining = r.remaining_count === null || r.remaining_count === undefined ? null : Number(r.remaining_count);
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    instanceId: String(r.instance_id),
    bucketId: str(r.bucket_id),
    runId: str(r.run_id),
    op: String(r.op),
    keyPrefix: str(r.key_prefix),
    action: String(r.action),
    params: parseJson(r.params as string, {}),
    position: Number(r.position),
    remainingCount: remaining,
    skipCount: Number(r.skip_count),
    failRate: r.fail_rate === null || r.fail_rate === undefined ? null : Number(r.fail_rate),
    expiresAt: str(r.expires_at),
    label: str(r.label),
    hits: Number(r.hits),
    enabled: r.enabled === 1,
    createdAt: String(r.created_at),
    active: r.enabled === 1 && !expired && (remaining === null || remaining > 0),
  };
};

/** Valid for every provider we simulate: S3 rules (3-63, lower-case, digits, dots, hyphens) plus "_" for Supabase / GCS. */
export const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

export interface ObjectRowInput {
  id: string;
  bucket: StorageBucket;
  key: string;
  size: number;
  etag: string;
  md5: string | null;
  contentType: string | null;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  checksums: Record<string, string>;
  parts: number | null;
  acl: string | null;
  extra: Record<string, unknown>;
  source: string;
  runId: string | null;
  logId: string | null;
}

export class StorageRepo {
  constructor(private db: DB) {}

  // ---------- instances ----------
  listInstances(projectId: string): StorageInstance[] {
    return (this.db.prepare('SELECT * FROM storage_instances WHERE project_id = ? ORDER BY created_at, slug').all(projectId) as Row[]).map(toInstance);
  }

  allInstances(): StorageInstance[] {
    return (this.db.prepare('SELECT * FROM storage_instances').all() as Row[]).map(toInstance);
  }

  getInstance(projectId: string, ref: string): StorageInstance | null {
    const r = (this.db.prepare('SELECT * FROM storage_instances WHERE project_id = ? AND (slug = ? OR id = ?)').get(projectId, ref.toLowerCase(), ref) as Row | undefined) ?? null;
    return r ? toInstance(r) : null;
  }

  requireInstance(projectId: string, ref: string): StorageInstance {
    const i = this.getInstance(projectId, ref);
    if (!i) throw new HttpError(404, `Storage instance "${ref}" not found`);
    return i;
  }

  createInstance(projectId: string, i: { preset: string; slug?: string; name: string; config?: StorageInstanceConfig; enabled?: boolean }): StorageInstance {
    const slug = i.slug ? String(i.slug).toLowerCase() : this.uniqueSlug(projectId, slugify(i.preset) || 'storage');
    if (!SLUG_RE.test(slug)) throw new HttpError(400, `Invalid slug "${slug}" (lower-case letters, digits and dashes)`);
    if (slug === '__hub') throw new HttpError(400, 'Slug "__hub" is reserved');
    if (this.getInstance(projectId, slug)) throw new HttpError(409, `Storage instance "${slug}" already exists`);
    const id = newId();
    const now = nowIso();
    this.db
      .prepare('INSERT INTO storage_instances (id, project_id, slug, name, preset, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, slug, i.name, i.preset, JSON.stringify(i.config ?? {}), i.enabled === false ? 0 : 1, now, now);
    return this.getInstance(projectId, id)!;
  }

  private uniqueSlug(projectId: string, base: string): string {
    if (!this.getInstance(projectId, base)) return base;
    for (let n = 2; ; n++) if (!this.getInstance(projectId, `${base}-${n}`)) return `${base}-${n}`;
  }

  updateInstance(inst: StorageInstance, patch: { name?: string; slug?: string; config?: StorageInstanceConfig; enabled?: boolean }): StorageInstance {
    if (patch.slug !== undefined && patch.slug !== inst.slug) {
      const s = patch.slug.toLowerCase();
      if (!SLUG_RE.test(s) || s === '__hub') throw new HttpError(400, `Invalid slug "${patch.slug}"`);
      if (this.getInstance(inst.projectId, s)) throw new HttpError(409, `Storage instance "${s}" already exists`);
    }
    this.db
      .prepare('UPDATE storage_instances SET name = ?, slug = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? inst.name, (patch.slug ?? inst.slug).toLowerCase(), JSON.stringify(patch.config ?? inst.config), (patch.enabled ?? inst.enabled) ? 1 : 0, nowIso(), inst.id);
    return this.getInstance(inst.projectId, inst.id)!;
  }

  deleteInstance(inst: StorageInstance): void {
    this.db.prepare('DELETE FROM storage_instances WHERE id = ?').run(inst.id);
  }

  // ---------- buckets ----------
  listBuckets(instanceId: string): StorageBucket[] {
    return (this.db.prepare('SELECT * FROM storage_buckets WHERE instance_id = ? ORDER BY name').all(instanceId) as Row[]).map(toBucket);
  }

  getBucket(instanceId: string, name: string): StorageBucket | null {
    const r = this.db.prepare('SELECT * FROM storage_buckets WHERE instance_id = ? AND name = ?').get(instanceId, name) as Row | undefined;
    return r ? toBucket(r) : null;
  }

  bucketById(id: string): StorageBucket | null {
    const r = this.db.prepare('SELECT * FROM storage_buckets WHERE id = ?').get(id) as Row | undefined;
    return r ? toBucket(r) : null;
  }

  createBucket(inst: StorageInstance, b: { name: string; region?: string | null; public?: boolean; cors?: BucketCors; config?: Record<string, unknown> }): StorageBucket {
    const id = newId();
    this.db
      .prepare('INSERT INTO storage_buckets (id, project_id, instance_id, name, region, public, cors, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, inst.projectId, inst.id, b.name, b.region ?? null, b.public ? 1 : 0, JSON.stringify(b.cors ?? { mode: 'permissive' }), JSON.stringify(b.config ?? {}), nowIso());
    return this.bucketById(id)!;
  }

  updateBucket(b: StorageBucket, patch: { public?: boolean; cors?: BucketCors; region?: string | null; config?: Record<string, unknown> }): StorageBucket {
    this.db
      .prepare('UPDATE storage_buckets SET public = ?, cors = ?, region = ?, config = ? WHERE id = ?')
      .run((patch.public ?? b.public) ? 1 : 0, JSON.stringify(patch.cors ?? b.cors), patch.region !== undefined ? patch.region : b.region, JSON.stringify(patch.config ?? b.config), b.id);
    return this.bucketById(b.id)!;
  }

  deleteBucket(b: StorageBucket): void {
    this.db.prepare('DELETE FROM storage_buckets WHERE id = ?').run(b.id);
  }

  bucketStats(bucketId: string): { objects: number; bytes: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM storage_objects WHERE bucket_id = ?').get(bucketId) as { n: number; b: number };
    return { objects: r.n, bytes: r.b };
  }

  // ---------- objects ----------
  getObject(bucketId: string, key: string): StorageObject | null {
    const r = this.db.prepare('SELECT * FROM storage_objects WHERE bucket_id = ? AND key = ?').get(bucketId, key) as Row | undefined;
    return r ? toObject(r) : null;
  }

  objectById(id: string): StorageObject | null {
    const r = this.db.prepare('SELECT * FROM storage_objects WHERE id = ?').get(id) as Row | undefined;
    return r ? toObject(r) : null;
  }

  /** Insert or replace (bucket, key). Returns the replaced row so the caller can unlink its file. */
  upsertObject(o: ObjectRowInput): { object: StorageObject; replaced: StorageObject | null } {
    return this.db.transaction(() => {
      const replaced = this.getObject(o.bucket.id, o.key);
      const now = nowIso();
      if (replaced) this.db.prepare('DELETE FROM storage_objects WHERE id = ?').run(replaced.id);
      this.db
        .prepare(
          `INSERT INTO storage_objects (id, project_id, bucket_id, key, size, etag, md5, content_type, headers, metadata, checksums, parts, acl, extra, source, run_id, log_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(o.id, o.bucket.projectId, o.bucket.id, o.key, o.size, o.etag, o.md5, o.contentType, JSON.stringify(o.headers), JSON.stringify(o.metadata), JSON.stringify(o.checksums), o.parts, o.acl, JSON.stringify(o.extra), o.source, o.runId, o.logId, replaced?.createdAt ?? now, now);
      return { object: this.objectById(o.id)!, replaced };
    })();
  }

  updateObjectMeta(o: StorageObject, patch: { acl?: string | null; metadata?: Record<string, string>; contentType?: string | null; headers?: Record<string, string>; extra?: Record<string, unknown> }): StorageObject {
    this.db
      .prepare('UPDATE storage_objects SET acl = ?, metadata = ?, content_type = ?, headers = ?, extra = ?, updated_at = ? WHERE id = ?')
      .run(patch.acl !== undefined ? patch.acl : o.acl, JSON.stringify(patch.metadata ?? o.metadata), patch.contentType !== undefined ? patch.contentType : o.contentType, JSON.stringify(patch.headers ?? o.headers), JSON.stringify(patch.extra ?? o.extra), nowIso(), o.id);
    return this.objectById(o.id)!;
  }

  deleteObjectRow(id: string): void {
    this.db.prepare('DELETE FROM storage_objects WHERE id = ?').run(id);
  }

  /** Rows in key order (BINARY = UTF-8 byte order, like S3) starting at `from`. */
  scanObjects(bucketId: string, from: { key: string; inclusive: boolean } | null, prefix: string, limit: number): StorageObject[] {
    const args: unknown[] = [bucketId];
    let where = 'bucket_id = ?';
    if (from) {
      where += from.inclusive ? ' AND key >= ?' : ' AND key > ?';
      args.push(from.key);
    }
    if (prefix) {
      where += ' AND key >= ? AND substr(key, 1, ?) = ?';
      args.push(prefix, prefix.length, prefix);
    }
    return (this.db.prepare(`SELECT * FROM storage_objects WHERE ${where} ORDER BY key LIMIT ?`).all(...args, limit) as Row[]).map(toObject);
  }

  /** Dashboard search: objects whose key contains `search` (case-insensitive). */
  searchObjects(bucketId: string, search: string, opts: { runId?: string | null; limit: number; after?: string }): StorageObject[] {
    const args: unknown[] = [bucketId, `%${search.replace(/[%_\\]/g, (c) => '\\' + c)}%`];
    let where = "bucket_id = ? AND key LIKE ? ESCAPE '\\'";
    if (opts.runId) {
      where += ' AND run_id = ?';
      args.push(opts.runId);
    }
    if (opts.after) {
      where += ' AND key > ?';
      args.push(opts.after);
    }
    return (this.db.prepare(`SELECT * FROM storage_objects WHERE ${where} ORDER BY key LIMIT ?`).all(...args, opts.limit) as Row[]).map(toObject);
  }

  /** Objects created / replaced after `afterId` (ids are time-sortable), for the wait endpoint. */
  objectsSince(bucketId: string, prefix: string, afterUpdatedAt: string, limit: number): StorageObject[] {
    return (
      this.db
        .prepare('SELECT * FROM storage_objects WHERE bucket_id = ? AND substr(key, 1, ?) = ? AND updated_at > ? ORDER BY updated_at, id LIMIT ?')
        .all(bucketId, prefix.length, prefix, afterUpdatedAt, limit) as Row[]
    ).map(toObject);
  }

  objectsForBucket(bucketId: string): StorageObject[] {
    return (this.db.prepare('SELECT * FROM storage_objects WHERE bucket_id = ?').all(bucketId) as Row[]).map(toObject);
  }

  usage(where: { projectId?: string; instanceId?: string } = {}): { objects: number; bytes: number } {
    let sql = 'SELECT COUNT(*) AS n, COALESCE(SUM(o.size), 0) AS b FROM storage_objects o';
    const args: unknown[] = [];
    if (where.instanceId) {
      sql += ' JOIN storage_buckets b ON b.id = o.bucket_id WHERE b.instance_id = ?';
      args.push(where.instanceId);
    } else if (where.projectId) {
      sql += ' WHERE o.project_id = ?';
      args.push(where.projectId);
    }
    const r = this.db.prepare(sql).get(...args) as { n: number; b: number };
    return { objects: r.n, bytes: r.b };
  }

  // ---------- uploads / parts ----------
  createUpload(b: StorageBucket, u: { kind: StorageUpload['kind']; key: string; contentType?: string | null; headers?: Record<string, string>; metadata?: Record<string, string>; state?: Record<string, unknown>; runId?: string | null; ttlMs: number }): StorageUpload {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO storage_uploads (id, project_id, bucket_id, kind, key, content_type, headers, metadata, state, run_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, b.projectId, b.id, u.kind, u.key, u.contentType ?? null, JSON.stringify(u.headers ?? {}), JSON.stringify(u.metadata ?? {}), JSON.stringify(u.state ?? {}), u.runId ?? null, new Date(now).toISOString(), new Date(now + u.ttlMs).toISOString());
    return this.getUpload(id)!;
  }

  getUpload(id: string): StorageUpload | null {
    const r = this.db.prepare('SELECT * FROM storage_uploads WHERE id = ?').get(id) as Row | undefined;
    return r ? toUpload(r) : null;
  }

  listUploads(bucketId: string): StorageUpload[] {
    return (this.db.prepare('SELECT * FROM storage_uploads WHERE bucket_id = ? ORDER BY key, created_at').all(bucketId) as Row[]).map(toUpload);
  }

  uploadsForInstance(instanceId: string): (StorageUpload & { bucket: string; parts: number; bytes: number })[] {
    return (
      this.db
        .prepare(
          `SELECT u.*, b.name AS bucket_name, (SELECT COUNT(*) FROM storage_parts p WHERE p.upload_id = u.id) AS n_parts,
                  (SELECT COALESCE(SUM(size), 0) FROM storage_parts p WHERE p.upload_id = u.id) AS n_bytes
           FROM storage_uploads u JOIN storage_buckets b ON b.id = u.bucket_id WHERE b.instance_id = ? ORDER BY u.created_at DESC`,
        )
        .all(instanceId) as Row[]
    ).map((r) => ({ ...toUpload(r), bucket: String(r.bucket_name), parts: Number(r.n_parts), bytes: Number(r.n_bytes) }));
  }

  updateUploadState(id: string, state: Record<string, unknown>): void {
    this.db.prepare('UPDATE storage_uploads SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
  }

  deleteUpload(id: string): void {
    this.db.prepare('DELETE FROM storage_uploads WHERE id = ?').run(id);
  }

  expiredUploads(nowIsoStr: string): StorageUpload[] {
    return (this.db.prepare('SELECT * FROM storage_uploads WHERE expires_at < ?').all(nowIsoStr) as Row[]).map(toUpload);
  }

  upsertPart(p: { uploadId: string; partId: string; size: number; etag: string; md5: string; checksums: Record<string, string> }): StoragePart | null {
    const old = this.db.prepare('SELECT * FROM storage_parts WHERE upload_id = ? AND part_id = ?').get(p.uploadId, p.partId) as Row | undefined;
    this.db
      .prepare('INSERT OR REPLACE INTO storage_parts (upload_id, part_id, size, etag, md5, checksums, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.uploadId, p.partId, p.size, p.etag, p.md5, JSON.stringify(p.checksums), nowIso());
    return old ? toPart(old) : null;
  }

  listParts(uploadId: string): StoragePart[] {
    return (this.db.prepare('SELECT * FROM storage_parts WHERE upload_id = ?').all(uploadId) as Row[]).map(toPart);
  }

  // ---------- rules ----------
  listRules(instanceId: string, opts: { runId?: string | null | 'all'; bucketId?: string | null | 'all' } = {}): StorageRule[] {
    const args: unknown[] = [instanceId];
    let where = 'instance_id = ?';
    if (opts.runId !== 'all') {
      if (opts.runId) {
        where += ' AND run_id = ?';
        args.push(opts.runId);
      } else where += ' AND run_id IS NULL';
    }
    if (opts.bucketId !== undefined && opts.bucketId !== 'all') {
      if (opts.bucketId) {
        where += ' AND bucket_id = ?';
        args.push(opts.bucketId);
      } else where += ' AND bucket_id IS NULL';
    }
    return (this.db.prepare(`SELECT * FROM storage_rules WHERE ${where} ORDER BY position, created_at`).all(...args) as Row[]).map(toRule);
  }

  getRule(id: string): StorageRule | null {
    const r = this.db.prepare('SELECT * FROM storage_rules WHERE id = ?').get(id) as Row | undefined;
    return r ? toRule(r) : null;
  }

  insertRule(r: Omit<StorageRule, 'id' | 'hits' | 'createdAt' | 'active' | 'position'>): StorageRule {
    const id = newId();
    const position = ((this.db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM storage_rules WHERE instance_id = ?').get(r.instanceId) as { m: number }).m ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO storage_rules (id, project_id, instance_id, bucket_id, run_id, op, key_prefix, action, params, position, remaining_count, skip_count, fail_rate, expires_at, label, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, r.projectId, r.instanceId, r.bucketId, r.runId, r.op, r.keyPrefix, r.action, JSON.stringify(r.params), position, r.remainingCount, r.skipCount, r.failRate, r.expiresAt, r.label, r.enabled ? 1 : 0, nowIso());
    return this.getRule(id)!;
  }

  updateRule(id: string, patch: { enabled?: boolean; label?: string | null }): StorageRule | null {
    if (patch.enabled !== undefined) this.db.prepare('UPDATE storage_rules SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.label !== undefined) this.db.prepare('UPDATE storage_rules SET label = ? WHERE id = ?').run(patch.label, id);
    return this.getRule(id);
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM storage_rules WHERE id = ?').run(id);
  }

  clearRules(instanceId: string, runId: string | null | 'all'): number {
    if (runId === 'all') return this.db.prepare('DELETE FROM storage_rules WHERE instance_id = ?').run(instanceId).changes;
    if (runId) return this.db.prepare('DELETE FROM storage_rules WHERE instance_id = ? AND run_id = ?').run(instanceId, runId).changes;
    return this.db.prepare('DELETE FROM storage_rules WHERE instance_id = ? AND run_id IS NULL').run(instanceId).changes;
  }

  deleteRulesForRun(runId: string): number {
    return this.db.prepare('DELETE FROM storage_rules WHERE run_id = ?').run(runId).changes;
  }

  consumeRule(id: string): void {
    this.db
      .prepare(
        `UPDATE storage_rules SET hits = hits + 1,
           remaining_count = CASE WHEN remaining_count IS NULL THEN NULL ELSE remaining_count - 1 END,
           enabled = CASE WHEN remaining_count IS NOT NULL AND remaining_count - 1 <= 0 THEN 0 ELSE enabled END
         WHERE id = ?`,
      )
      .run(id);
  }

  skipRule(id: string): void {
    this.db.prepare('UPDATE storage_rules SET skip_count = MAX(skip_count - 1, 0) WHERE id = ?').run(id);
  }

  resetHits(projectId: string): number {
    return this.db.prepare('UPDATE storage_rules SET hits = 0 WHERE project_id = ?').run(projectId).changes;
  }
}
