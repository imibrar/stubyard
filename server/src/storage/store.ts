import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageBucket, StorageInstance, StorageObject, StorageRepo, StorageUpload } from '../repos/storage.js';
import { BUCKET_NAME_RE } from '../repos/storage.js';
import { newId } from '../util.js';
import { MultiHasher } from './checksums.js';
import { ByteLimit } from './streams.js';
import { fault, StorageFaultError, type ByteRange, type ChecksumAlgo, type Digests, type ListInput, type ListOutput, type ObjectStore, type PutOptions } from './types.js';

/**
 * On-disk layout (project / instance *ids*, so nothing moves on rename):
 *   <root>/<projectId>/<instanceId>/objects/<last 2 chars of id>/<objectId>   committed bytes (never named after the key)
 *   <root>/<projectId>/<instanceId>/uploads/<uploadId>/<part>                 multipart parts / blocks
 *   <root>/<projectId>/tmp/<uuid>                                              in-flight bodies, renamed on commit
 */

export interface Limits {
  /** Max bytes for one object (instance config, else DEVHUB_STORAGE_MAX_OBJECT_MB). */
  maxObjectBytes: number;
  /** Bytes still available under every quota (global, project, instance); Infinity when unlimited. */
  remaining(): number;
  /** Which quota is the tightest (for x-devhub-reason). */
  quotaReason(): string;
}

class HashThrough extends Transform {
  constructor(private h: MultiHasher) {
    super();
  }
  override _transform(c: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.h.update(c);
    cb(null, c);
  }
}

const UPLOAD_TTL_MS = 24 * 3600_000;

export function objectPath(root: string, projectId: string, instanceId: string, objectId: string): string {
  return path.join(root, projectId, instanceId, 'objects', objectId.slice(-2), objectId);
}

export function storageRoot(dataDir: string): string {
  return path.join(dataDir, 'storage');
}

/** S3-like successor of a string in byte order: the smallest string greater than every string starting with s. */
export function successor(s: string): string {
  const cps = Array.from(s);
  const last = cps.pop();
  if (last === undefined) return '';
  return cps.join('') + String.fromCodePoint(last.codePointAt(0)! + 1);
}

export class DiskStore implements ObjectStore {
  readonly uploads: ObjectStore['uploads'];

  constructor(
    readonly instance: StorageInstance,
    private repo: StorageRepo,
    private root: string,
    private limits: Limits,
  ) {
    const self = this;
    this.uploads = {
      create(bucket, kind, key, opts = {}) {
        return repo.createUpload(bucket, { kind, key, contentType: opts.contentType, headers: opts.headers, metadata: opts.metadata, state: opts.state, runId: opts.runId, ttlMs: UPLOAD_TTL_MS });
      },
      get: (id) => repo.getUpload(id),
      async putPart(upload, partId, body, opts = {}) {
        const tmp = self.tmpPath();
        const h = new MultiHasher(opts.algos ?? [], !!opts.sha256);
        const d = await self.write(body, tmp, h, opts.maxBytes ?? self.limits.maxObjectBytes, opts.verify);
        const file = self.partPath(upload.id, partId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.renameSync(tmp, file);
        const etag = `"${d.md5}"`;
        repo.upsertPart({ uploadId: upload.id, partId, size: d.size, etag, md5: d.md5, checksums: d.checksums as Record<string, string> });
        return { etag, size: d.size, md5: d.md5, checksums: d.checksums };
      },
      async copyPart(upload, partId, src, range) {
        const tmp = self.tmpPath();
        const h = new MultiHasher();
        const d = await self.write(self.open(src, range), tmp, h, self.limits.maxObjectBytes);
        const file = self.partPath(upload.id, partId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.renameSync(tmp, file);
        const etag = `"${d.md5}"`;
        repo.upsertPart({ uploadId: upload.id, partId, size: d.size, etag, md5: d.md5, checksums: {} });
        return { etag, size: d.size, md5: d.md5 };
      },
      parts: (upload) =>
        repo
          .listParts(upload.id)
          .map((p) => ({ partId: p.partId, size: p.size, etag: p.etag, md5: p.md5, checksums: p.checksums, createdAt: p.createdAt }))
          .sort((a, b) => (/^\d+$/.test(a.partId) && /^\d+$/.test(b.partId) ? Number(a.partId) - Number(b.partId) : a.partId < b.partId ? -1 : 1)),
      async complete(upload, partIds, opts) {
        const bucket = repo.bucketById(upload.bucketId);
        if (!bucket) throw fault('no_such_bucket');
        const files = partIds.map((p) => self.partPath(upload.id, p));
        async function* concat() {
          for (const f of files) for await (const c of fs.createReadStream(f)) yield c as Buffer;
        }
        const obj = await self.put(bucket, upload.key, Readable.from(concat()), { ...opts, maxBytes: Number.MAX_SAFE_INTEGER });
        this.abort(upload);
        return obj;
      },
      abort(upload) {
        repo.deleteUpload(upload.id);
        fs.rmSync(self.uploadDir(upload.id), { recursive: true, force: true });
      },
      list: (bucket) => repo.listUploads(bucket.id),
    };
  }

  // ---------- paths ----------
  private instanceDir(): string {
    return path.join(this.root, this.instance.projectId, this.instance.id);
  }
  tmpPath(): string {
    const dir = path.join(this.root, this.instance.projectId, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, newId());
  }
  filePath(obj: { id: string }): string {
    return objectPath(this.root, this.instance.projectId, this.instance.id, obj.id);
  }
  uploadDir(uploadId: string): string {
    return path.join(this.instanceDir(), 'uploads', uploadId);
  }
  private partPath(uploadId: string, partId: string): string {
    // Part ids are S3 part numbers or Azure block ids (base64): hex-encode so they are safe file names.
    return path.join(this.uploadDir(uploadId), /^\d{1,5}$/.test(partId) ? partId : 'b' + Buffer.from(partId).toString('hex'));
  }

  // ---------- buckets ----------
  bucket(name: string): StorageBucket | null {
    return this.repo.getBucket(this.instance.id, name);
  }

  requireBucket(name: string): StorageBucket {
    const b = this.bucket(name);
    if (!b) throw fault('no_such_bucket', 'The specified bucket does not exist', { detail: { BucketName: name } });
    return b;
  }

  bucketOrCreate(name: string): StorageBucket {
    const b = this.bucket(name);
    if (b) return b;
    if (this.instance.config.autoCreateBuckets === false) throw fault('no_such_bucket', 'The specified bucket does not exist', { detail: { BucketName: name } });
    if (!BUCKET_NAME_RE.test(name)) throw fault('invalid_bucket_name', 'The specified bucket is not valid.', { detail: { BucketName: name } });
    return this.repo.createBucket(this.instance, { name, region: this.instance.config.region ?? null });
  }

  // ---------- objects ----------
  /** Stream `body` into a tmp file with limit + hashing; unlink on any failure. */
  private async write(body: Readable, tmp: string, h: MultiHasher, maxBytes: number, verify?: (d: Digests) => import('./types.js').StorageFault | null): Promise<Digests> {
    const remaining = this.limits.remaining();
    const limit = Math.min(maxBytes, remaining);
    const lim = new ByteLimit(Number.isFinite(limit) ? limit : 0);
    try {
      await pipeline(body, lim, new HashThrough(h), fs.createWriteStream(tmp));
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      const code = (err as { code?: string }).code;
      if (code === 'ENTITY_TOO_LARGE') {
        if (lim.bytes > maxBytes || maxBytes <= remaining) throw fault('entity_too_large', 'Your proposed upload exceeds the maximum allowed size', { detail: { MaxSizeAllowed: String(maxBytes) }, reason: `object limit ${maxBytes} bytes` });
        throw fault('quota_exceeded', 'Storage quota exceeded', { reason: this.limits.quotaReason() });
      }
      if (code === 'INCOMPLETE_CHUNKED') throw fault('incomplete_body', 'You did not provide the number of bytes specified by the Content-Length HTTP header.');
      if ((err as Error).message?.startsWith('Invalid aws-chunked')) throw fault('invalid_request', (err as Error).message);
      throw err;
    }
    const d = h.digest();
    const f = verify?.(d);
    if (f) {
      fs.rmSync(tmp, { force: true });
      throw new StorageFaultError(f);
    }
    return d;
  }

  async put(bucket: StorageBucket, key: string, body: Readable, opts: PutOptions = {}): Promise<StorageObject> {
    if (opts.ifNoneMatch && this.repo.getObject(bucket.id, key)) {
      body.resume();
      throw fault('precondition_failed', 'At least one of the pre-conditions you specified did not hold', { detail: { Condition: 'If-None-Match' } });
    }
    const tmp = this.tmpPath();
    const h = new MultiHasher(opts.algos ?? [], !!opts.sha256);
    const d = await this.write(body, tmp, h, opts.maxBytes ?? this.limits.maxObjectBytes, opts.verify);
    return this.commit(bucket, key, tmp, d, opts);
  }

  private commit(bucket: StorageBucket, key: string, tmp: string, d: Digests, opts: PutOptions): StorageObject {
    const id = newId();
    const file = this.filePath({ id });
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const checksums: Record<string, string> = { ...(d.checksums as Record<string, string>), ...((opts.checksums as Record<string, string>) ?? {}) };
    if (opts.checksumType) checksums.type = opts.checksumType;
    try {
      const { object, replaced } = this.repo.upsertObject({
        id,
        bucket,
        key,
        size: d.size,
        etag: opts.etag ?? `"${d.md5}"`,
        md5: d.md5,
        contentType: opts.contentType ?? null,
        headers: opts.headers ?? {},
        metadata: opts.metadata ?? {},
        checksums,
        parts: opts.parts ?? null,
        acl: opts.acl ?? null,
        extra: opts.extra ?? {},
        source: opts.source ?? 'api',
        runId: opts.runId ?? null,
        logId: opts.logId ?? null,
      });
      if (replaced) fs.rmSync(this.filePath(replaced), { force: true });
      return object;
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  }

  open(obj: StorageObject, range?: ByteRange | null): Readable {
    const file = this.filePath(obj);
    if (obj.size === 0) return Readable.from([]);
    return fs.createReadStream(file, range ? { start: range.start, end: range.end } : {});
  }

  head(bucket: StorageBucket, key: string): StorageObject | null {
    return this.repo.getObject(bucket.id, key);
  }

  remove(bucket: StorageBucket, key: string): boolean {
    const o = this.repo.getObject(bucket.id, key);
    if (!o) return false;
    this.repo.deleteObjectRow(o.id);
    fs.rmSync(this.filePath(o), { force: true });
    return true;
  }

  async copy(src: StorageObject, dst: StorageBucket, key: string, opts: PutOptions & { replaceMetadata?: boolean } = {}): Promise<StorageObject> {
    const max = this.limits.maxObjectBytes;
    if (src.size > max) throw fault('entity_too_large', 'Your proposed upload exceeds the maximum allowed size', { reason: `object limit ${max} bytes` });
    if (src.size > this.limits.remaining()) throw fault('quota_exceeded', 'Storage quota exceeded', { reason: this.limits.quotaReason() });
    const tmp = this.tmpPath();
    const srcFile = objectPath(this.root, src.projectId, this.instanceIdOfBucket(src.bucketId), src.id);
    fs.copyFileSync(srcFile, tmp, fs.constants.COPYFILE_FICLONE);
    const checksums = { ...src.checksums };
    const d: Digests = { size: src.size, md5: src.md5 ?? src.etag.replace(/"/g, ''), checksums: {} };
    const keep = !opts.replaceMetadata;
    return this.commit(dst, key, tmp, d, {
      ...opts,
      etag: src.etag,
      contentType: keep ? src.contentType : (opts.contentType ?? null),
      headers: keep ? src.headers : (opts.headers ?? {}),
      metadata: keep ? src.metadata : (opts.metadata ?? {}),
      checksums: checksums as PutOptions['checksums'],
      parts: src.parts,
      extra: opts.extra ?? src.extra,
    });
  }

  private instanceIdOfBucket(bucketId: string): string {
    return this.repo.bucketById(bucketId)?.instanceId ?? this.instance.id;
  }

  /**
   * S3 listing semantics: keys in UTF-8 byte order after `after`, grouped into common prefixes by `delimiter`;
   * prefixes and keys both count towards `limit`. After a common prefix the scan seeks past it.
   */
  list(bucket: StorageBucket, input: ListInput): ListOutput {
    const prefix = input.prefix ?? '';
    const delim = input.delimiter ?? '';
    const limit = Math.max(0, input.limit);
    const objects: StorageObject[] = [];
    const prefixes: string[] = [];
    let last: string | null = null;
    let from: { key: string; inclusive: boolean } | null = input.after ? { key: input.after, inclusive: false } : prefix ? { key: prefix, inclusive: true } : null;
    if (input.after && prefix && Buffer.compare(Buffer.from(input.after), Buffer.from(prefix)) < 0) from = { key: prefix, inclusive: true };
    // A token pointing at a common prefix: continue after everything under it.
    if (input.after && delim) {
      const rest = input.after.startsWith(prefix) ? input.after.slice(prefix.length) : null;
      if (rest !== null && rest.endsWith(delim) && rest.indexOf(delim) === rest.length - delim.length) from = { key: successor(input.after), inclusive: true };
    }
    if (limit === 0) return { objects, prefixes, truncated: false, last: null };
    for (;;) {
      const batch = this.repo.scanObjects(bucket.id, from, prefix, 500);
      if (!batch.length) return { objects, prefixes, truncated: false, last };
      let seeked = false;
      for (const o of batch) {
        if (objects.length + prefixes.length >= limit) return { objects, prefixes, truncated: true, last };
        if (delim) {
          const idx = o.key.indexOf(delim, prefix.length);
          if (idx >= 0) {
            const cp = o.key.slice(0, idx + delim.length);
            prefixes.push(cp);
            last = cp;
            from = { key: successor(cp), inclusive: true };
            seeked = true;
            break;
          }
        }
        objects.push(o);
        last = o.key;
        from = { key: o.key, inclusive: false };
      }
      if (!seeked && batch.length < 500) {
        // Exhausted; truncated only if something else follows (none: batch was short).
        return { objects, prefixes, truncated: false, last };
      }
      if (objects.length + prefixes.length >= limit) {
        const more = this.repo.scanObjects(bucket.id, from, prefix, 1).length > 0;
        return { objects, prefixes, truncated: more, last };
      }
    }
  }

  /** Remove every object of a bucket (rows + files). */
  empty(bucket: StorageBucket): number {
    const objs = this.repo.objectsForBucket(bucket.id);
    for (const o of objs) {
      this.repo.deleteObjectRow(o.id);
      fs.rmSync(this.filePath(o), { force: true });
    }
    for (const u of this.repo.listUploads(bucket.id)) this.uploads.abort(u);
    return objs.length;
  }
}

export type { ChecksumAlgo, StorageUpload };
