/**
 * Google Cloud Storage (preset "gcs"): JSON API (B/storage/v1/…), uploads (B/upload/storage/v1/… media, multipart,
 * resumable), downloads (alt=media, B/download/…), XML API object GET/HEAD/PUT/DELETE at B/<bucket>/<object> with
 * V4 signed URLs. Point `new Storage({ apiEndpoint: B, projectId })` at the instance.
 */
import crypto from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import type { Hub } from '../../hub.js';
import type { StorageBucket, StorageObject, StorageUpload } from '../../repos/storage.js';
import { BUCKET_NAME_RE } from '../../repos/storage.js';
import { HttpError } from '../../util.js';
import { gate, HANDLED, header, laxOrThrow, maxBytesOf, noteObject, precheck, readJson, safe, sendObject, writableBucket } from '../provider-kit.js';
import { candidateHosts } from '../s3/auth.js';
import { registerStorageProtocol } from '../service.js';
import { fault, StorageFaultError, type FaultKind, type InstanceView, type ProtocolError, type Snippet, type StorageCtx, type StorageEffects, type StorageFault, type StoragePreset, type StorageProtocol } from '../types.js';
import { el, xmlDoc } from '../xml.js';
import { RelatedParser } from './related.js';
import { parseGoog4, serviceAccountOf, signGoog4, verifyGoog4 } from './signed.js';

export const GCS_PRESET: StoragePreset = {
  id: 'gcs',
  name: 'Google Cloud Storage',
  protocol: 'gcs',
  description: 'Google Cloud Storage JSON API (@google-cloud/storage, google-cloud-storage for Python): uploads (simple, multipart, resumable), downloads, list, copy, V4 signed URLs.',
  region: 'US',
  credentials: [],
  quotaError: { code: 'quotaExceeded', status: 403 },
  quirks: { credentialLabels: ['service account', ''] },
  notes: [
    'new Storage({ apiEndpoint: <endpoint>, projectId: "devhub" }): no credentials are needed (the client sends no auth to a custom endpoint).',
    'getSignedUrl() drops the endpoint path: put the instance path back (see the snippet) or sign with the service account from the dashboard.',
  ],
  docsUrl: 'https://cloud.google.com/storage/docs/json_api/v1',
};

// [status, reason, message]
const MAP: Partial<Record<FaultKind, [number, string, string]>> = {
  access_denied: [403, 'forbidden', 'devhub@devhub.iam.gserviceaccount.com does not have storage.objects.get access to the Google Cloud Storage object.'],
  slow_down: [429, 'rateLimitExceeded', 'The rate of change requests to the object exceeds the rate limit. Please reduce the rate of create, update, and delete requests.'],
  internal_error: [500, 'backendError', 'Backend Error'],
  quota_exceeded: [403, 'quotaExceeded', 'Quota exceeded'],
  entity_too_large: [413, 'uploadTooLarge', 'The upload is larger than the maximum allowed size'],
  expired_url: [400, 'ExpiredToken', 'The provided token has expired.'],
  bad_signature: [403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.'],
  checksum_mismatch: [400, 'invalid', 'Provided CRC32C or MD5 hash does not match the calculated hash of the object.'],
  bad_digest: [400, 'invalid', 'Provided CRC32C or MD5 hash does not match the calculated hash of the object.'],
  invalid_digest: [400, 'invalid', 'Invalid hash value.'],
  incomplete_body: [400, 'invalid', 'The uploaded data did not match the declared length.'],
  not_found: [404, 'notFound', 'No such object.'],
  no_such_key: [404, 'notFound', 'No such object.'],
  no_such_bucket: [404, 'notFound', 'The specified bucket does not exist.'],
  no_such_upload: [404, 'notFound', 'No such upload session.'],
  bucket_exists: [409, 'conflict', 'Your previous request to create the named bucket succeeded and you already own it.'],
  bucket_not_empty: [409, 'conflict', 'The bucket you tried to delete is not empty.'],
  invalid_bucket_name: [400, 'invalid', 'Invalid bucket name.'],
  precondition_failed: [412, 'conditionNotMet', 'At least one of the pre-conditions you specified did not hold.'],
  not_modified: [304, 'notModified', 'Not Modified'],
  invalid_range: [416, 'requestedRangeNotSatisfiable', 'The requested range cannot be satisfied.'],
  invalid_argument: [400, 'invalid', 'Invalid argument.'],
  invalid_request: [400, 'invalid', 'Invalid request.'],
  missing_content_length: [411, 'required', 'Length required.'],
  unknown_access_key: [401, 'authError', 'Invalid Credentials'],
  not_implemented: [501, 'notImplemented', 'Not implemented by devhub.'],
  method_not_allowed: [405, 'methodNotAllowed', 'Method not allowed.'],
  unknown_instance: [404, 'notFound', 'Unknown storage instance.'],
  timeout: [408, 'requestTimeout', 'Request timeout.'],
  cors_blocked: [403, 'forbidden', 'CORS request not allowed.'],
};

const isXmlApi = (path: string) => !/^\/(storage|upload|download|batch)\//.test(path + '/');

export function gcsError(ctx: StorageCtx | null, f: StorageFault): ProtocolError {
  const [status, reason, message] = MAP[f.kind] ?? [500, 'backendError', f.kind];
  const st = f.status ?? status;
  if (st === 304) return { status: 304 };
  const msg = f.message ?? message;
  if (ctx && isXmlApi(ctx.path)) {
    const code = f.code ?? (f.kind === 'no_such_key' || f.kind === 'not_found' ? 'NoSuchKey' : f.kind === 'no_such_bucket' ? 'NoSuchBucket' : f.kind === 'access_denied' ? 'AccessDenied' : f.kind === 'expired_url' ? 'ExpiredToken' : f.kind === 'bad_signature' ? 'SignatureDoesNotMatch' : reason);
    return { status: st, contentType: 'application/xml; charset=UTF-8', body: xmlDoc(el('Error', el('Code', code), el('Message', f.kind === 'expired_url' ? 'Invalid argument.' : msg), f.kind === 'expired_url' ? el('Details', msg) : null)) };
  }
  const headers: Record<string, string> = {};
  if (f.kind === 'slow_down') headers['retry-after'] = '1';
  return { status: st, headers, contentType: 'application/json; charset=UTF-8', body: JSON.stringify({ error: { code: st, message: msg, errors: [{ message: msg, domain: 'global', reason: f.code ?? reason }] } }) };
}

// ---------------------------------------------------------------- resources

const generationOf = (o: StorageObject) => String(o.extra.generation ?? Date.parse(o.updatedAt) * 1000);
const metagenerationOf = (o: StorageObject) => String(o.extra.metageneration ?? 1);
const encName = (k: string) => encodeURIComponent(k);
const md5b64 = (o: StorageObject) => (o.md5 ? Buffer.from(o.md5, 'hex').toString('base64') : undefined);

function resource(ctx: StorageCtx, b: StorageBucket, o: StorageObject) {
  const gen = generationOf(o);
  const base = ctx.bases.request;
  const r: Record<string, unknown> = {
    kind: 'storage#object',
    id: `${b.name}/${o.key}/${gen}`,
    selfLink: `${base}/storage/v1/b/${b.name}/o/${encName(o.key)}`,
    mediaLink: `${base}/download/storage/v1/b/${b.name}/o/${encName(o.key)}?generation=${gen}&alt=media`,
    name: o.key,
    bucket: b.name,
    generation: gen,
    metageneration: metagenerationOf(o),
    contentType: o.contentType ?? 'application/octet-stream',
    storageClass: 'STANDARD',
    size: String(o.size),
    md5Hash: md5b64(o),
    crc32c: o.checksums.crc32c,
    etag: Buffer.from(gen).toString('base64').replace(/=+$/, ''),
    timeCreated: o.createdAt,
    updated: o.updatedAt,
    timeStorageClassUpdated: o.createdAt,
    timeFinalized: o.updatedAt,
  };
  if (o.headers['cache-control']) r.cacheControl = o.headers['cache-control'];
  if (o.headers['content-disposition']) r.contentDisposition = o.headers['content-disposition'];
  if (o.headers['content-encoding']) r.contentEncoding = o.headers['content-encoding'];
  if (o.headers['content-language']) r.contentLanguage = o.headers['content-language'];
  if (Object.keys(o.metadata).length) r.metadata = o.metadata;
  return r;
}

function bucketResource(ctx: StorageCtx, b: StorageBucket) {
  return {
    kind: 'storage#bucket',
    selfLink: `${ctx.bases.request}/storage/v1/b/${b.name}`,
    id: b.name,
    name: b.name,
    projectNumber: '0',
    metageneration: '1',
    location: (b.region ?? 'US').toUpperCase(),
    storageClass: 'STANDARD',
    etag: 'CAE=',
    timeCreated: b.createdAt,
    updated: b.createdAt,
    locationType: 'multi-region',
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: b.public ? 'inherited' : 'enforced' },
  };
}

function hashHeader(o: StorageObject): string {
  return [o.checksums.crc32c ? `crc32c=${o.checksums.crc32c}` : null, md5b64(o) ? `md5=${md5b64(o)}` : null].filter(Boolean).join(',');
}

function objectHeaders(o: StorageObject): Record<string, string> {
  const h: Record<string, string> = {
    etag: `"${o.md5 ?? generationOf(o)}"`,
    'x-goog-generation': generationOf(o),
    'x-goog-metageneration': metagenerationOf(o),
    'x-goog-stored-content-length': String(o.size),
    'x-goog-stored-content-encoding': o.headers['content-encoding'] ?? 'identity',
    'x-goog-storage-class': 'STANDARD',
  };
  const hh = hashHeader(o);
  if (hh) h['x-goog-hash'] = hh;
  for (const k of ['cache-control', 'content-disposition', 'content-encoding', 'content-language']) if (o.headers[k]) h[k] = o.headers[k];
  for (const [k, v] of Object.entries(o.metadata)) h[`x-goog-meta-${k}`] = v;
  return h;
}

// ---------------------------------------------------------------- preconditions

function checkPreconditions(ctx: StorageCtx, cur: StorageObject | null): void {
  const q = ctx.query;
  const gm = q.get('ifGenerationMatch') ?? header(ctx, 'x-goog-if-generation-match');
  const gnm = q.get('ifGenerationNotMatch');
  const mm = q.get('ifMetagenerationMatch') ?? header(ctx, 'x-goog-if-metageneration-match');
  const mnm = q.get('ifMetagenerationNotMatch');
  const gen = cur ? generationOf(cur) : '0';
  if (gm !== null && gm !== undefined && gm !== gen) throw fault('precondition_failed');
  if (gnm !== null && gnm === gen) throw fault(ctx.req.method === 'GET' ? 'not_modified' : 'precondition_failed');
  if (mm !== null && mm !== undefined && cur && mm !== metagenerationOf(cur)) throw fault('precondition_failed');
  if (mnm !== null && cur && mnm === metagenerationOf(cur)) throw fault(ctx.req.method === 'GET' ? 'not_modified' : 'precondition_failed');
}

// ---------------------------------------------------------------- uploads

const META_HEADERS: [string, string][] = [
  ['cacheControl', 'cache-control'],
  ['contentDisposition', 'content-disposition'],
  ['contentEncoding', 'content-encoding'],
  ['contentLanguage', 'content-language'],
];

function storedFrom(meta: Record<string, unknown>): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, n] of META_HEADERS) if (typeof meta[k] === 'string') h[n] = meta[k] as string;
  return h;
}

function userMeta(meta: Record<string, unknown>): Record<string, string> {
  const m = meta.metadata;
  if (!m || typeof m !== 'object') return {};
  return Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
}

/** x-goog-hash on uploads ("crc32c=…,md5=…") or md5Hash / crc32c in the metadata → verified after the write. */
function expectedHashes(ctx: StorageCtx, meta: Record<string, unknown>): { crc32c?: string; md5?: string } {
  const out: { crc32c?: string; md5?: string } = {};
  for (const part of (header(ctx, 'x-goog-hash') ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 'crc32c') out.crc32c = v;
    if (k === 'md5') out.md5 = v;
  }
  if (typeof meta.crc32c === 'string') out.crc32c = meta.crc32c;
  if (typeof meta.md5Hash === 'string') out.md5 = meta.md5Hash;
  return out;
}

async function storeObject(ctx: StorageCtx, b: StorageBucket, name: string, body: Readable, meta: Record<string, unknown>, contentType: string | null, e: StorageEffects | null, maxBytes?: number) {
  const exp = expectedHashes(ctx, meta);
  const prev = ctx.store.head(b, name);
  try {
    const obj = await ctx.store.put(b, name, body, {
      contentType: (typeof meta.contentType === 'string' ? meta.contentType : contentType) ?? 'application/octet-stream',
      headers: storedFrom(meta),
      metadata: userMeta(meta),
      algos: ['crc32c'],
      extra: { generation: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)), metageneration: 1 },
      source: 'api',
      runId: ctx.explicitRun?.id ?? null,
      logId: ctx.req.trafficLogId ?? null,
      maxBytes: maxBytes ?? maxBytesOf(e),
      verify: (d) => {
        if (exp.crc32c && exp.crc32c !== d.checksums.crc32c) return { kind: 'bad_digest', reason: `crc32c: expected ${exp.crc32c}, computed ${d.checksums.crc32c}` };
        const md5 = Buffer.from(d.md5, 'hex').toString('base64');
        if (exp.md5 && exp.md5 !== md5) return { kind: 'bad_digest', reason: `md5: expected ${exp.md5}, computed ${md5}` };
        ctx.resolved.checksum = { algo: 'crc32c', ok: exp.crc32c ? true : null };
        return null;
      },
    });
    noteObject(ctx, b, obj, true);
    if (prev) ctx.resolved.replaced = true;
    return obj;
  } catch (err) {
    if ((err as { code?: string }).code === 'BAD_MULTIPART') throw fault('invalid_argument', (err as Error).message);
    throw err;
  }
}

async function simpleUpload(ctx: StorageCtx, b: StorageBucket, e: StorageEffects | null) {
  const name = ctx.query.get('name');
  if (!name) throw fault('invalid_argument', 'Required: name', { code: 'required' });
  ctx.setOp('put', 'InsertObject', { bucket: b.name, key: name });
  precheck(ctx, e);
  checkPreconditions(ctx, ctx.store.head(b, name));
  const obj = await storeObject(ctx, b, name, ctx.body(e), {}, header(ctx, 'content-type') ?? null, e);
  return ctx.reply.status(200).send(resource(ctx, b, obj));
}

async function multipartUpload(ctx: StorageCtx, b: StorageBucket, e: StorageEffects | null) {
  const ct = header(ctx, 'content-type') ?? '';
  const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
  if (!/^multipart\/related/i.test(ct) || !boundary) throw fault('invalid_argument', 'uploadType=multipart needs Content-Type: multipart/related; boundary=…');
  precheck(ctx, e);
  const parser = new RelatedParser(boundary);
  const body = ctx.body(e);
  body.on('error', (err) => parser.destroy(err));
  body.pipe(parser);
  let head;
  try {
    head = await parser.head;
  } catch (err) {
    throw fault('invalid_argument', (err as Error).message);
  }
  const name = String(head.metadata.name ?? ctx.query.get('name') ?? '');
  if (!name) throw fault('invalid_argument', 'Required: name', { code: 'required' });
  ctx.setOp('put', 'InsertObject', { bucket: b.name, key: name });
  checkPreconditions(ctx, ctx.store.head(b, name));
  const obj = await storeObject(ctx, b, name, parser, head.metadata, head.mediaType, e);
  return ctx.reply.status(200).send(resource(ctx, b, obj));
}

async function startResumable(ctx: StorageCtx, b: StorageBucket) {
  const meta = await readJson(ctx);
  const name = String(meta.name ?? ctx.query.get('name') ?? '');
  if (!name) throw fault('invalid_argument', 'Required: name', { code: 'required' });
  ctx.setOp('multipart', 'StartResumableUpload', { bucket: b.name, key: name });
  checkPreconditions(ctx, ctx.store.head(b, name));
  const total = header(ctx, 'x-upload-content-length');
  const u = ctx.store.uploads.create(b, 'gcs-resumable', name, {
    contentType: (typeof meta.contentType === 'string' ? meta.contentType : header(ctx, 'x-upload-content-type')) ?? null,
    state: { meta, size: 0, total: total !== undefined ? Number(total) : null, query: { ifGenerationMatch: ctx.query.get('ifGenerationMatch') } },
    runId: ctx.explicitRun?.id ?? null,
  });
  ctx.resolved.uploadId = u.id;
  ctx.changed({ bucket: b.name, key: name, upload: u.id });
  const loc = `${ctx.bases.request}/upload/storage/v1/b/${b.name}/o?uploadType=resumable&name=${encodeURIComponent(name)}&upload_id=${u.id}`;
  return ctx.reply.status(200).header('location', loc).header('x-guploader-uploadid', u.id).send();
}

/** Drops the first n bytes (a resumable chunk that overlaps bytes already persisted). */
class Skip extends Transform {
  constructor(private n: number) {
    super();
  }
  override _transform(c: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    if (this.n >= c.length) {
      this.n -= c.length;
      return cb();
    }
    const out = this.n ? c.subarray(this.n) : c;
    this.n = 0;
    cb(null, out);
  }
}

async function resumableChunk(ctx: StorageCtx, b: StorageBucket, u: StorageUpload, e: StorageEffects | null) {
  ctx.setOp('multipart', 'ResumableUploadChunk', { bucket: b.name, key: u.key });
  ctx.resolved.uploadId = u.id;
  const st = u.state as { meta: Record<string, unknown>; size: number; total: number | null };
  const cr = header(ctx, 'content-range');
  let start = st.size;
  let total = st.total;
  let status = false;
  if (cr) {
    const m = /^bytes\s+(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/i.exec(cr.trim());
    if (!m) throw fault('invalid_argument', `Invalid Content-Range: ${cr}`);
    if (m[3] !== '*') total = Number(m[3]);
    if (m[1] === undefined) status = true;
    else start = Number(m[1]);
  }
  const range = () => (st.size > 0 ? { range: `bytes=0-${st.size - 1}` } : {});
  if (!status) {
    if (start > st.size) {
      ctx.body(e).resume();
      throw fault('invalid_argument', `Chunk starts at ${start}, but only ${st.size} bytes were persisted`);
    }
    const skip = st.size - start;
    precheck(ctx, e, Number(header(ctx, 'content-length') ?? NaN) - skip);
    let body: Readable = ctx.body(e);
    if (skip > 0) body = body.pipe(new Skip(skip));
    const p = await ctx.store.uploads.putPart(u, String(st.size), body, { maxBytes: maxBytesOf(e) });
    st.size += p.size;
    ctx.hub.storage.repo.updateUploadState(u.id, { ...u.state, size: st.size, total });
    ctx.noteRequestSize(p.size);
  } else {
    await ctx.readSmall(0).catch(() => Buffer.alloc(0));
  }
  if (total !== null && st.size > total) throw fault('invalid_argument', `Received ${st.size} bytes, more than the declared total ${total}`);
  const done = (total !== null && st.size === total) || (!cr && !status);
  if (!done) {
    for (const [k, v] of Object.entries(range())) ctx.reply.header(k, v);
    return ctx.reply.status(308).header('x-guploader-uploadid', u.id).send();
  }
  ctx.setOp('put', 'InsertObject', { bucket: b.name, key: u.key });
  const parts = ctx.store.uploads.parts(u).map((p) => p.partId);
  checkPreconditions(ctx, ctx.store.head(b, u.key));
  const exp = expectedHashes(ctx, st.meta);
  const obj = await ctx.store.uploads.complete(u, parts, {
    contentType: (typeof st.meta.contentType === 'string' ? st.meta.contentType : u.contentType) ?? 'application/octet-stream',
    headers: storedFrom(st.meta),
    metadata: userMeta(st.meta),
    algos: ['crc32c'],
    extra: { generation: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)), metageneration: 1 },
    source: 'api',
    runId: u.runId ?? ctx.explicitRun?.id ?? null,
    logId: ctx.req.trafficLogId ?? null,
    verify: (d) => (exp.crc32c && exp.crc32c !== d.checksums.crc32c ? { kind: 'bad_digest', reason: `crc32c: expected ${exp.crc32c}, computed ${d.checksums.crc32c}` } : null),
  });
  noteObject(ctx, b, obj, false);
  ctx.changed({ bucket: b.name, key: obj.key, put: true });
  return ctx.reply.status(200).send(resource(ctx, b, obj));
}

// ---------------------------------------------------------------- JSON API

async function listObjects(ctx: StorageCtx, b: StorageBucket) {
  const q = ctx.query;
  const prefix = q.get('prefix') ?? '';
  const delimiter = q.get('delimiter') ?? undefined;
  const max = Math.min(Number(q.get('maxResults') ?? 1000) || 1000, 1000);
  const token = q.get('pageToken');
  const startOffset = q.get('startOffset');
  const endOffset = q.get('endOffset');
  const after = token ? Buffer.from(token, 'base64url').toString('utf8') : undefined;
  const ranged = !!(startOffset || endOffset);
  const out = ctx.store.list(b, { prefix, delimiter, after, limit: ranged ? 100_000 : max });
  let items = out.objects;
  if (startOffset) items = items.filter((o) => o.key >= startOffset);
  if (endOffset) items = items.filter((o) => o.key < endOffset);
  if (ranged && items.length > max) {
    items = items.slice(0, max);
    out.truncated = true;
    out.last = items[items.length - 1].key;
  }
  const res: Record<string, unknown> = { kind: 'storage#objects' };
  const includeTrailing = q.get('includeTrailingDelimiter') === 'true';
  if (out.prefixes.length) res.prefixes = out.prefixes;
  res.items = items.map((o) => resource(ctx, b, o));
  if (includeTrailing && delimiter) {
    for (const p of out.prefixes) {
      const o = ctx.store.head(b, p);
      if (o) (res.items as unknown[]).push(resource(ctx, b, o));
    }
  }
  if (!(res.items as unknown[]).length) delete res.items;
  if (out.truncated && out.last) res.nextPageToken = Buffer.from(out.last).toString('base64url');
  ctx.resolved.items = items.length;
  return ctx.reply.send(res);
}

async function copyOrRewrite(ctx: StorageCtx, src: StorageBucket, srcKey: string, dstBucketName: string, dstKey: string, rewrite: boolean) {
  const so = ctx.store.head(src, srcKey);
  if (!so) throw fault('no_such_key', `No such object: ${src.name}/${srcKey}`);
  const dst = writableBucket(ctx, dstBucketName, 'Bucket');
  checkPreconditions(ctx, ctx.store.head(dst, dstKey));
  const meta = await readJson(ctx);
  const replace = Object.keys(meta).length > 0;
  const obj = await ctx.store.copy(so, dst, dstKey, {
    replaceMetadata: false,
    extra: { ...so.extra, generation: String(Date.now() * 1000 + Math.floor(Math.random() * 1000)), metageneration: 1 },
    source: 'api',
    runId: ctx.explicitRun?.id ?? null,
    logId: ctx.req.trafficLogId ?? null,
  });
  let out = obj;
  if (replace) out = ctx.hub.storage.repo.updateObjectMeta(obj, { contentType: typeof meta.contentType === 'string' ? meta.contentType : obj.contentType, metadata: { ...obj.metadata, ...userMeta(meta) }, headers: { ...obj.headers, ...storedFrom(meta) } });
  noteObject(ctx, dst, out, false);
  ctx.changed({ bucket: dst.name, key: dstKey, put: true });
  const r = resource(ctx, dst, out);
  if (!rewrite) return ctx.reply.send(r);
  return ctx.reply.send({ kind: 'storage#rewriteResponse', totalBytesRewritten: String(out.size), objectSize: String(out.size), done: true, resource: r });
}

async function bucketsApi(ctx: StorageCtx, name: string | null) {
  const m = ctx.req.method;
  const repo = ctx.hub.storage.repo;
  if (!name) {
    if (m === 'GET') {
      ctx.setOp('bucket', 'ListBuckets');
      if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
      const items = repo.listBuckets(ctx.instance.id).map((b) => bucketResource(ctx, b));
      return ctx.reply.send({ kind: 'storage#buckets', ...(items.length ? { items } : {}) });
    }
    if (m === 'POST') {
      const body = await readJson(ctx);
      const n = String(body.name ?? '');
      ctx.setOp('bucket', 'InsertBucket', { bucket: n });
      if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
      if (!BUCKET_NAME_RE.test(n)) throw fault('invalid_bucket_name', `Invalid bucket name: '${n}'`);
      if (ctx.store.bucket(n)) throw fault('bucket_exists');
      const b = repo.createBucket(ctx.instance, { name: n, region: typeof body.location === 'string' ? body.location : null });
      ctx.changed({ bucket: n, created: true });
      return ctx.reply.send(bucketResource(ctx, b));
    }
    throw fault('method_not_allowed');
  }
  ctx.setOp('bucket', m === 'GET' ? 'GetBucket' : m === 'DELETE' ? 'DeleteBucket' : m === 'PATCH' ? 'PatchBucket' : 'Bucket', { bucket: name });
  const b = ctx.store.bucket(name);
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  if (!b) throw fault('no_such_bucket');
  if (m === 'GET') return ctx.reply.send(bucketResource(ctx, b));
  if (m === 'PATCH' || m === 'PUT') {
    await ctx.readSmall();
    return ctx.reply.send(bucketResource(ctx, b));
  }
  if (m === 'DELETE') {
    if (repo.bucketStats(b.id).objects > 0) throw fault('bucket_not_empty');
    repo.deleteBucket(b);
    ctx.changed({ bucket: name, deleted: true });
    return ctx.reply.status(204).send();
  }
  throw fault('method_not_allowed');
}

/** /o/<name>[/(copyTo|rewriteTo)/b/<db>/o/<dname>]: the name is one encoded segment, or several when unencoded. */
function splitObjectPath(raw: string[]): { key: string; action?: 'copyTo' | 'rewriteTo' | 'compose'; dstBucket?: string; dstKey?: string } {
  const i = raw.findIndex((s, n) => (s === 'copyTo' || s === 'rewriteTo') && raw[n + 1] === 'b' && raw[n + 3] === 'o');
  if (i > 0) return { key: raw.slice(0, i).map(safe).join('/'), action: raw[i] as 'copyTo', dstBucket: safe(raw[i + 2]), dstKey: raw.slice(i + 4).map(safe).join('/') };
  if (raw[raw.length - 1] === 'compose') return { key: raw.slice(0, -1).map(safe).join('/'), action: 'compose' };
  return { key: raw.map(safe).join('/') };
}

async function jsonApi(ctx: StorageCtx, raw: string[]) {
  // raw = segments after /storage/v1
  if (raw[0] !== 'b') throw fault('not_implemented', `devhub does not simulate /storage/v1/${raw.join('/')}`);
  if (raw.length === 1) return bucketsApi(ctx, null);
  const bucketName = safe(raw[1]);
  if (raw.length === 2) return bucketsApi(ctx, bucketName);
  if (raw[2] !== 'o') throw fault('not_implemented', `devhub does not simulate /storage/v1/b/<bucket>/${raw.slice(2).join('/')} (IAM, ACLs, notifications are out of scope)`);
  const m = ctx.req.method;
  if (raw.length === 3) {
    if (m !== 'GET') throw fault('method_not_allowed');
    ctx.setOp('list', 'ListObjects', { bucket: bucketName });
    const b = ctx.store.bucket(bucketName);
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    if (!b) throw fault('no_such_bucket');
    return listObjects(ctx, b);
  }
  const p = splitObjectPath(raw.slice(3));
  if (p.action === 'compose') throw fault('not_implemented', 'compose is not simulated by devhub');
  if (p.action) {
    ctx.setOp('copy', p.action === 'rewriteTo' ? 'RewriteObject' : 'CopyObject', { bucket: p.dstBucket, key: p.dstKey });
    const src = ctx.store.bucket(bucketName);
    if ((await gate(ctx, src, false)) === HANDLED) return ctx.reply;
    if (!src) throw fault('no_such_bucket');
    return copyOrRewrite(ctx, src, p.key, p.dstBucket!, p.dstKey!, p.action === 'rewriteTo');
  }
  const media = ctx.query.get('alt') === 'media';
  ctx.setOp(m === 'DELETE' ? 'delete' : m === 'PATCH' || m === 'PUT' ? 'put' : 'get', m === 'DELETE' ? 'DeleteObject' : m === 'PATCH' || m === 'PUT' ? 'PatchObject' : media ? 'GetObjectMedia' : 'GetObject', { bucket: bucketName, key: p.key });
  const b = ctx.store.bucket(bucketName);
  const e = await gate(ctx, b, false);
  if (e === HANDLED) return ctx.reply;
  if (!b) throw fault('no_such_bucket');
  const o = ctx.store.head(b, p.key);
  if (!o) throw fault('no_such_key', `No such object: ${bucketName}/${p.key}`);
  checkPreconditions(ctx, o);
  if (m === 'GET' || m === 'HEAD') {
    if (!media) {
      Object.assign(ctx.resolved, { objectId: o.id, size: o.size });
      return ctx.reply.send(resource(ctx, b, o));
    }
    return sendObject(ctx, o, e, objectHeaders(o));
  }
  if (m === 'DELETE') {
    ctx.store.remove(b, p.key);
    ctx.changed({ bucket: b.name, key: p.key, deleted: true });
    return ctx.reply.status(204).send();
  }
  if (m === 'PATCH' || m === 'PUT') {
    const meta = await readJson(ctx);
    const metadata = m === 'PUT' ? userMeta(meta) : { ...o.metadata, ...userMeta(meta) };
    if (m === 'PATCH' && meta.metadata && typeof meta.metadata === 'object') for (const [k, v] of Object.entries(meta.metadata as Record<string, unknown>)) if (v === null) delete metadata[k];
    const updated = ctx.hub.storage.repo.updateObjectMeta(o, {
      contentType: typeof meta.contentType === 'string' ? meta.contentType : o.contentType,
      metadata,
      headers: { ...o.headers, ...storedFrom(meta) },
      extra: { ...o.extra, metageneration: Number(metagenerationOf(o)) + 1 },
    });
    ctx.changed({ bucket: b.name, key: p.key, meta: true });
    return ctx.reply.send(resource(ctx, b, updated));
  }
  throw fault('method_not_allowed');
}

async function uploadApi(ctx: StorageCtx, raw: string[]) {
  // raw = segments after /upload/storage/v1 → b/<bucket>/o
  if (raw[0] !== 'b' || raw[2] !== 'o') throw fault('not_implemented', 'Upload URLs look like /upload/storage/v1/b/<bucket>/o?uploadType=…');
  const bucketName = safe(raw[1]);
  const m = ctx.req.method;
  const uploadId = ctx.query.get('upload_id');
  if (uploadId) {
    const u = ctx.store.uploads.get(uploadId);
    ctx.setOp('multipart', m === 'DELETE' ? 'CancelResumableUpload' : 'ResumableUploadChunk', { bucket: bucketName, key: u?.key });
    const b = ctx.store.bucket(bucketName);
    const e = await gate(ctx, b, true);
    if (e === HANDLED) return ctx.reply;
    if (!u || u.kind !== 'gcs-resumable' || !b || u.bucketId !== b.id) {
      if (header(ctx, 'content-length') !== '0') ctx.body(e).resume();
      throw fault('no_such_upload', 'No such upload session (completed, cancelled or expired)', { status: 404 });
    }
    if (m === 'DELETE') {
      ctx.store.uploads.abort(u);
      ctx.changed({ bucket: b.name, upload: u.id, aborted: true });
      return ctx.reply.status(499).send();
    }
    if (m !== 'PUT' && m !== 'POST') throw fault('method_not_allowed');
    return resumableChunk(ctx, b, u, e);
  }
  if (m !== 'POST') throw fault('method_not_allowed');
  const type = ctx.query.get('uploadType') ?? 'media';
  ctx.setOp(type === 'resumable' ? 'multipart' : 'put', type === 'resumable' ? 'StartResumableUpload' : 'InsertObject', { bucket: bucketName, key: ctx.query.get('name') ?? undefined });
  const existing = ctx.store.bucket(bucketName);
  const e = await gate(ctx, existing, true);
  if (e === HANDLED) return ctx.reply;
  const b = writableBucket(ctx, bucketName, 'Bucket');
  if (type === 'media') return simpleUpload(ctx, b, e);
  if (type === 'multipart') return multipartUpload(ctx, b, e);
  if (type === 'resumable') return startResumable(ctx, b);
  throw fault('invalid_argument', `Invalid uploadType: ${type}`);
}

// ---------------------------------------------------------------- XML API (+ V4 signed URLs)

function checkSigned(ctx: StorageCtx, bucket: string, key: string): void {
  const g = parseGoog4(ctx.query);
  if (g === null) {
    ctx.resolved.auth = { type: header(ctx, 'authorization') ? 'bearer' : 'anonymous' };
    return;
  }
  if (g === 'malformed') throw fault('invalid_argument', 'Invalid argument: malformed X-Goog-* signed URL parameters', { status: 400, code: 'InvalidArgument' });
  ctx.resolved.auth = { type: 'goog4', accessKeyId: g.email, expiresAt: g.expiresAt, verified: null as boolean | null };
  if (g.expires > 604800) throw fault('invalid_argument', 'Max allowed expiration interval is seven days (604800 seconds).', { status: 400, code: 'InvalidArgument' });
  if (Date.parse(g.expiresAt) < Date.now()) throw fault('expired_url', `The provided token has expired. Request signature expired at: ${g.expiresAt}`, { reason: 'signed URL expired' });
  const sa = ctx.instance.config.serviceAccount as { private_key?: string } | undefined;
  if (!sa?.private_key) return;
  const enc = (s: string) => s.split('/').map((x) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  const ok = verifyGoog4(g, {
    method: ctx.req.method,
    paths: [`/${bucket}/${enc(key)}`, `/${enc(key)}`],
    query: ctx.query,
    headers: ctx.req.headers,
    hosts: candidateHosts(ctx),
    publicKey: crypto.createPublicKey(sa.private_key),
  });
  (ctx.resolved.auth as Record<string, unknown>).verified = ok;
  if (!ok) laxOrThrow(ctx, { kind: 'bad_signature' }, 'V4 signature does not verify with the instance service account', ctx.strict || ctx.instance.config.verifySignatures === true);
}

async function xmlApi(ctx: StorageCtx, raw: string[]) {
  const bucketName = safe(raw[0] ?? '');
  const key = raw.slice(1).map(safe).join('/');
  const m = ctx.req.method;
  if (!bucketName || !key) {
    ctx.setOp('list', 'XmlBucket', { bucket: bucketName || undefined });
    throw fault('not_implemented', 'devhub simulates the GCS XML API for objects only (GET/HEAD/PUT/DELETE <bucket>/<object>); use the JSON API for buckets and listings');
  }
  const op = m === 'PUT' ? 'XmlPutObject' : m === 'DELETE' ? 'XmlDeleteObject' : m === 'HEAD' ? 'XmlHeadObject' : 'XmlGetObject';
  ctx.setOp(m === 'PUT' ? 'put' : m === 'DELETE' ? 'delete' : m === 'HEAD' ? 'head' : 'get', op, { bucket: bucketName, key });
  checkSigned(ctx, bucketName, key);
  const existing = ctx.store.bucket(bucketName);
  const e = await gate(ctx, existing, m === 'PUT');
  if (e === HANDLED) return ctx.reply;
  if (m === 'PUT') {
    if (header(ctx, 'x-goog-copy-source')) throw fault('not_implemented', 'XML API copy is not simulated; use rewriteTo');
    const b = writableBucket(ctx, bucketName, 'Bucket');
    precheck(ctx, e);
    const meta: Record<string, unknown> = { metadata: Object.fromEntries(Object.entries(ctx.req.headers).filter(([k]) => k.startsWith('x-goog-meta-')).map(([k, v]) => [k.slice(12), String(v)])) };
    for (const [k, n] of META_HEADERS) if (header(ctx, n)) meta[k] = header(ctx, n);
    const obj = await storeObject(ctx, b, key, ctx.body(e), meta, header(ctx, 'content-type') ?? null, e);
    ctx.reply.header('etag', `"${obj.md5}"`).header('x-goog-generation', generationOf(obj)).header('x-goog-hash', hashHeader(obj));
    return ctx.reply.status(200).send();
  }
  if (m === 'POST' && header(ctx, 'x-goog-resumable') === 'start') throw fault('not_implemented', 'XML API resumable uploads are not simulated; use the JSON API (uploadType=resumable)');
  if (!existing) throw fault('no_such_bucket');
  const o = ctx.store.head(existing, key);
  if (!o) throw fault('no_such_key', 'The specified key does not exist.');
  if (m === 'DELETE') {
    ctx.store.remove(existing, key);
    ctx.changed({ bucket: existing.name, key, deleted: true });
    return ctx.reply.status(204).send();
  }
  if (m === 'GET' || m === 'HEAD') {
    const h = objectHeaders(o);
    const rcd = ctx.query.get('response-content-disposition');
    if (rcd) h['content-disposition'] = rcd;
    return sendObject(ctx, o, e, h, { contentType: ctx.query.get('response-content-type') ?? undefined });
  }
  throw fault('method_not_allowed');
}

// ---------------------------------------------------------------- router

async function handleGcs(ctx: StorageCtx): Promise<unknown> {
  const raw = ctx.path.split('/').slice(1);
  if (raw[raw.length - 1] === '' && raw.length > 1) raw.pop();
  try {
    if (raw[0] === 'storage' && raw[1] === 'v1') return await jsonApi(ctx, raw.slice(2));
    if (raw[0] === 'upload' && raw[1] === 'storage' && raw[2] === 'v1') return await uploadApi(ctx, raw.slice(3));
    if (raw[0] === 'download' && raw[1] === 'storage' && raw[2] === 'v1') return await jsonApi(ctx, raw.slice(3));
    if (raw[0] === 'batch') {
      ctx.setOp('any', 'Batch');
      throw fault('not_implemented', 'The GCS batch endpoint is not simulated by devhub');
    }
    return await xmlApi(ctx, raw);
  } catch (err) {
    if (err instanceof StorageFaultError && err.fault.kind === 'no_such_bucket' && !err.fault.message) err.fault.message = 'The specified bucket does not exist.';
    throw err;
  }
}

/**
 * @google-cloud/storage v9 resolves JSON API paths ("/storage/v1/…") against the endpoint origin, dropping the
 * instance path (uploads keep it). Such requests are mapped to a GCS instance by, in order: the x-goog-api-key header
 * "<project>/<instance>" (Storage({ apiKey })), the instance owning the bucket in the path, ?project=<project slug>,
 * or the only GCS instance.
 */
function gcsRootRoute(hub: Hub, pathname: string, query: URLSearchParams, headers: Record<string, string | string[] | undefined>): string | ProtocolError | null {
  if (!/^\/storage\/v1(\/|$)/.test(pathname)) return null;
  const all = hub.storage.repo.allInstances().filter((i) => hub.storage.presetOf(i).protocol === 'gcs');
  if (!all.length) return null;
  const slugOf = (projectId: string) => hub.projects.get(projectId)?.slug ?? '';
  const prefix = (i: (typeof all)[number]) => `/storage/${slugOf(i.projectId)}/${i.slug}`;
  const key = String(headers['x-goog-api-key'] ?? '');
  const km = /^([^/]+)\/([^/]+)$/.exec(key);
  if (km) {
    const hit = all.find((i) => slugOf(i.projectId) === km[1].toLowerCase() && i.slug === km[2].toLowerCase());
    if (hit) return prefix(hit);
  }
  const bucket = /^\/storage\/v1\/b\/([^/]+)/.exec(pathname)?.[1];
  if (bucket) {
    const owners = all.filter((i) => hub.storage.repo.getBucket(i.id, decodeURIComponent(bucket)));
    if (owners.length === 1) return prefix(owners[0]);
  }
  const project = query.get('project')?.toLowerCase();
  const inProject = project ? all.filter((i) => slugOf(i.projectId) === project) : [];
  if (inProject.length) return prefix(inProject[0]);
  if (all.length === 1) return prefix(all[0]);
  return gcsError(null, {
    kind: 'not_found',
    status: 404,
    message: `devhub got a GCS JSON API call outside an instance path (@google-cloud/storage v9 drops the apiEndpoint path) and cannot tell which of ${all.length} GCS instances is meant. Pass new Storage({ apiKey: '<project>/<instance>' }), e.g. one of: ${all.map((i) => `${slugOf(i.projectId)}/${i.slug}`).join(', ')}.`,
  });
}

function gcsSnippets(v: InstanceView): Snippet[] {
  // "<project>/<instance>" from the base path: v9 of the Node client sends JSON API calls without the endpoint path,
  // and the apiKey (sent as x-goog-api-key on every request) tells devhub which instance they are for.
  const ref = new URL(v.urls.backend).pathname.split('/').slice(2, 4).join('/');
  return [
    {
      title: 'Node.js — @google-cloud/storage',
      language: 'javascript',
      code:
        `import { Storage } from '@google-cloud/storage';\n\n` +
        `// apiKey: no Google credentials needed, and devhub uses it to find this instance. In Docker: ${v.urls.docker}\n` +
        `const storage = new Storage({ apiEndpoint: '${v.urls.backend}', projectId: 'devhub', apiKey: '${ref}' });\n` +
        `const bucket = storage.bucket('uploads');\n\n` +
        `await bucket.file('docs/hello.txt').save('hello', { contentType: 'text/plain', resumable: false });\n` +
        `const [data] = await bucket.file('docs/hello.txt').download();\n` +
        `const [files] = await bucket.getFiles({ prefix: 'docs/' });`,
    },
    {
      title: 'Signed URLs (V4)',
      language: 'javascript',
      code:
        `// getSignedUrl() needs a private key: download the instance's fake service account from\n` +
        `// GET /api/projects/<project>/storage/<instance>/service-account.json\n` +
        `const signer = new Storage({ apiEndpoint: '${v.urls.browser}', projectId: 'devhub', credentials: serviceAccount }); // signing only, offline\n` +
        `let [url] = await signer.bucket('uploads').file('docs/hello.txt').getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 15 * 60_000 });\n` +
        `// The client replaces the endpoint path with /<bucket>/<object>: put the instance path back.\n` +
        `url = url.replace(new URL(url).origin, '${v.urls.browser}');`,
    },
    {
      title: 'Python — google-cloud-storage',
      language: 'python',
      code: `from google.auth.credentials import AnonymousCredentials\nfrom google.cloud import storage\n\nclient = storage.Client(project="devhub", credentials=AnonymousCredentials(), client_options={"api_endpoint": "${v.urls.backend}"})\nclient.bucket("uploads").blob("docs/hello.txt").upload_from_string("hello")`,
    },
    {
      title: 'Environment (.env)',
      language: 'shell',
      code: `# Python reads STORAGE_EMULATOR_HOST (it keeps the instance path); the Node client needs apiEndpoint + apiKey\nSTORAGE_EMULATOR_HOST=${v.urls.backend}\nGCS_API_ENDPOINT=${v.urls.backend}\nGCS_API_KEY=${ref}\nGCLOUD_PROJECT=devhub`,
    },
  ];
}

export const gcsProtocol: StorageProtocol = {
  id: 'gcs',
  presets: [GCS_PRESET],
  reservedSegments: ['storage', 'upload', 'download', 'batch'],
  handle: handleGcs,
  errorFor: gcsError,
  snippets: gcsSnippets,
  commonHeaders: (ctx) => ({ 'x-guploader-uploadid': ctx.requestId }),
  rootRoute: gcsRootRoute,
  presign(ctx, input) {
    const sa = serviceAccountOf(ctx.hub, ctx.instance);
    const extra: Record<string, string> = input.scenario ? { hub_scenario: input.scenario } : {};
    if (input.expiresIn > 604800) throw new HttpError(400, 'GCS V4 signed URLs expire after at most 7 days (604800 s)');
    const sign = (base: string) => signGoog4({ method: input.method, base, bucket: input.bucket, key: input.key, expiresIn: input.expiresIn, sa, contentType: input.method === 'PUT' ? input.contentType : undefined, extra });
    return {
      backend: sign(ctx.bases.backend),
      browser: sign(ctx.bases.browser),
      expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
      headers: (input.method === 'PUT' && input.contentType ? { 'content-type': input.contentType } : {}) as Record<string, string>,
    };
  },
};

let registered = false;
export function registerGcsProtocol(): void {
  if (registered) return;
  registered = true;
  registerStorageProtocol(gcsProtocol);
}
