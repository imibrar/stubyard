/**
 * Supabase Storage (preset "supabase"): the Storage REST API under B/storage/v1 (objects, signed URLs, signed upload
 * URLs, public URLs, list, move / copy, buckets) plus its S3 endpoint (B/storage/v1/s3 → the S3 engine).
 * `createClient(B, anonKey)` works unchanged: supabase-js appends /storage/v1 itself.
 */
import type { StorageBucket, StorageObject } from '../../repos/storage.js';
import { BUCKET_NAME_RE } from '../../repos/storage.js';
import { HttpError } from '../../util.js';
import { parseForm } from '../multipart-form.js';
import { decodeJwt, gate, HANDLED, header, laxOrThrow, noteObject, precheck, putObject, readJson, safe, sendObject, signJwt, writableBucket } from '../provider-kit.js';
import { registerStorageProtocol, safeDecode } from '../service.js';
import { s3Protocol } from '../s3/index.js';
import { fault, StorageFaultError, type FaultKind, type InstanceView, type ProtocolError, type Snippet, type StorageCtx, type StorageEffects, type StorageFault, type StoragePreset, type StorageProtocol } from '../types.js';

/** Supabase CLI's well-known local JWT secret; the demo anon / service_role keys are signed with it. */
export const SUPABASE_DEMO_SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long';
const demoKey = (role: string, secret: string) => signJwt({ iss: 'supabase-demo', role, exp: 1983812996 }, secret);

export const SUPABASE_PRESET: StoragePreset = {
  id: 'supabase',
  name: 'Supabase Storage',
  protocol: 'supabase',
  description: 'Supabase Storage REST API (supabase-js storage.from(…)), signed / public URLs, signed uploads, and its S3 endpoint.',
  region: 'local',
  credentials: [{ accessKeyId: demoKey('anon', SUPABASE_DEMO_SECRET), secretAccessKey: demoKey('service_role', SUPABASE_DEMO_SECRET) }],
  quotaError: { code: 'EntityTooLarge', status: 400 },
  quirks: { credentialLabels: ['anon key', 'service_role key'] },
  notes: ['createClient(<endpoint>, anonKey): supabase-js appends /storage/v1 itself. Keys are the Supabase CLI demo keys (any key is accepted in lax mode).', 'Row Level Security is not simulated: every request is allowed; the JWT role is only logged.'],
  docsUrl: 'https://supabase.com/docs/reference/javascript/storage-from-upload',
};

const MAP: Partial<Record<FaultKind, [number, string, string, string]>> = {
  // [http status, statusCode (body, string), error, message]
  access_denied: [403, '403', 'Unauthorized', 'new row violates row-level security policy'],
  slow_down: [429, '429', 'too_many_requests', 'Too many requests, please slow down'],
  internal_error: [500, '500', 'internal', 'Internal Server Error'],
  quota_exceeded: [400, '413', 'Payload too large', 'The object exceeded the maximum allowed size'],
  entity_too_large: [400, '413', 'Payload too large', 'The object exceeded the maximum allowed size'],
  expired_url: [400, '400', 'InvalidJWT', '"exp" claim timestamp check failed'],
  bad_signature: [400, '400', 'InvalidJWT', 'invalid signature'],
  bad_digest: [400, '400', 'InvalidChecksum', 'The checksum does not match the uploaded content'],
  checksum_mismatch: [400, '400', 'InvalidChecksum', 'The checksum does not match the uploaded content'],
  not_found: [400, '404', 'not_found', 'Object not found'],
  no_such_key: [400, '404', 'not_found', 'Object not found'],
  no_such_bucket: [400, '404', 'Bucket not found', 'Bucket not found'],
  no_such_upload: [400, '404', 'not_found', 'Upload not found'],
  bucket_exists: [400, '409', 'Duplicate', 'The resource already exists'],
  bucket_not_empty: [400, '409', 'InvalidRequest', 'The bucket you tried to delete is not empty'],
  invalid_bucket_name: [400, '400', 'Invalid Input', 'Bucket name invalid'],
  precondition_failed: [400, '409', 'Duplicate', 'The resource already exists'],
  invalid_range: [416, '416', 'InvalidRange', 'The requested range is not satisfiable'],
  unknown_access_key: [400, '403', 'Unauthorized', 'Invalid Compact JWS'],
  invalid_argument: [400, '400', 'Invalid Input', 'Invalid input'],
  invalid_request: [400, '400', 'InvalidRequest', 'Invalid request'],
  not_implemented: [501, '501', 'NotImplemented', 'Not implemented by devhub'],
  method_not_allowed: [405, '405', 'MethodNotAllowed', 'Method not allowed'],
  unknown_instance: [404, '404', 'not_found', 'Unknown storage instance'],
  policy_violation: [400, '415', 'invalid_mime_type', 'mime type not supported'],
  timeout: [504, '504', 'timeout', 'timeout'],
  cors_blocked: [403, '403', 'AccessForbidden', 'CORS request not allowed'],
};

export function supabaseError(_ctx: StorageCtx | null, f: StorageFault): ProtocolError {
  const [status, statusCode, error, message] = MAP[f.kind] ?? [500, '500', 'internal', f.kind];
  const st = f.status ?? status;
  if (st === 304) return { status: 304 };
  return { status: st, body: JSON.stringify({ statusCode, error: f.code ?? error, message: f.message ?? message }), contentType: 'application/json' };
}

const secretOf = (ctx: { instance: { config: Record<string, unknown> } }) => String(ctx.instance.config.jwtSecret || SUPABASE_DEMO_SECRET);

/** Bearer / apikey: accepted unverified in lax mode; the role is logged. */
function authenticate(ctx: StorageCtx): { role: string | null } {
  const bearer = /^Bearer\s+(.+)$/i.exec(header(ctx, 'authorization') ?? '')?.[1];
  const apikey = header(ctx, 'apikey');
  const token = bearer ?? apikey;
  let role: string | null = null;
  if (token) {
    const d = decodeJwt(token, secretOf(ctx));
    role = typeof d.payload?.role === 'string' ? d.payload.role : null;
    if (d.valid === false) laxOrThrow(ctx, { kind: 'bad_signature', status: 400, code: 'InvalidJWT', message: 'invalid signature' }, 'JWT signature does not verify with the instance jwtSecret');
    const exp = Number(d.payload?.exp ?? 0);
    if (exp && exp * 1000 < Date.now()) throw fault('expired_url', '"exp" claim timestamp check failed', { reason: 'JWT expired' });
  }
  ctx.resolved.auth = { type: bearer ? 'bearer' : apikey ? 'apikey' : 'anonymous', role };
  return { role };
}

function fileObject(o: StorageObject, name: string) {
  return {
    name,
    id: o.id,
    updated_at: o.updatedAt,
    created_at: o.createdAt,
    last_accessed_at: o.updatedAt,
    metadata: {
      eTag: o.etag,
      size: o.size,
      mimetype: o.contentType ?? 'application/octet-stream',
      cacheControl: o.headers['cache-control'] ?? 'no-cache',
      lastModified: o.updatedAt,
      contentLength: o.size,
      httpStatusCode: 200,
    },
    user_metadata: (o.extra.userMetadata as Record<string, unknown>) ?? {},
  };
}

function bucketJson(b: StorageBucket) {
  return {
    id: b.name,
    name: b.name,
    owner: '',
    public: b.public,
    file_size_limit: (b.config.fileSizeLimit as number | null) ?? null,
    allowed_mime_types: (b.config.allowedMimeTypes as string[] | null) ?? null,
    created_at: b.createdAt,
    updated_at: b.createdAt,
  };
}

function requireBucket(ctx: StorageCtx, name: string): StorageBucket {
  const b = ctx.store.bucket(name);
  if (!b) throw fault('no_such_bucket');
  return b;
}

function requireObject(ctx: StorageCtx, b: StorageBucket, key: string): StorageObject {
  const o = ctx.store.head(b, key);
  if (!o) throw fault('no_such_key');
  return o;
}

function parseSize(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v).trim());
  if (!m) throw fault('invalid_argument', 'file_size_limit must be a number of bytes or e.g. "5MB"');
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.round(Number(m[1]) * mult[(m[2] ?? 'b').toLowerCase()]);
}

function mimeAllowed(allowed: string[] | null | undefined, ct: string): boolean {
  if (!allowed || !allowed.length) return true;
  const t = ct.split(';')[0].trim().toLowerCase();
  return allowed.some((a) => {
    const x = a.toLowerCase();
    return x === t || (x.endsWith('/*') && t.startsWith(x.slice(0, -1)));
  });
}

// ---------------------------------------------------------------- objects

async function upload(ctx: StorageCtx, bucketName: string, key: string, e: StorageEffects | null, upsert: boolean, opName: string) {
  if (!key) throw fault('invalid_argument', 'The object name is required');
  const bucket = writableBucket(ctx, bucketName, 'Bucket');
  const sizeLimit = (bucket.config.fileSizeLimit as number | null) ?? null;
  const declared = Number(header(ctx, 'content-length') ?? NaN);
  precheck(ctx, e);
  if (sizeLimit && Number.isFinite(declared) && declared > sizeLimit + 64 * 1024 && !/multipart/i.test(header(ctx, 'content-type') ?? '')) {
    throw fault('entity_too_large', 'The object exceeded the maximum allowed size', { reason: `bucket file_size_limit ${sizeLimit}` });
  }
  if (!upsert && ctx.store.head(bucket, key)) throw fault('precondition_failed', 'The resource already exists', { status: 400, code: 'Duplicate' });
  const ct = header(ctx, 'content-type') ?? 'application/octet-stream';
  const meta = header(ctx, 'x-metadata');
  let userMetadata: Record<string, unknown> | undefined;
  if (meta) {
    try {
      userMetadata = JSON.parse(Buffer.from(meta, 'base64').toString('utf8'));
    } catch {
      /* ignore */
    }
  }
  const limit = sizeLimit ?? undefined;
  const store = async (stream: import('node:stream').Readable, contentType: string, cacheControl: string | undefined) => {
    if (!mimeAllowed(bucket.config.allowedMimeTypes as string[] | null, contentType)) {
      stream.resume();
      throw fault('policy_violation', `mime type ${contentType} is not supported`, { reason: 'bucket allowed_mime_types' });
    }
    return putObject(
      ctx,
      bucket,
      key,
      stream,
      {
        contentType,
        headers: cacheControl ? { 'cache-control': /^\d+$/.test(cacheControl) ? `max-age=${cacheControl}` : cacheControl } : {},
        extra: userMetadata ? { userMetadata } : {},
        ...(limit !== undefined ? { maxBytes: Math.min(limit, ctx.hub.storage.maxObjectBytes(ctx.instance)) } : {}),
      },
      e,
    ).catch((err) => {
      if (err instanceof StorageFaultError && err.fault.kind === 'entity_too_large' && limit !== undefined) err.fault.reason = `bucket file_size_limit ${limit}`;
      throw err;
    });
  };
  let obj: StorageObject;
  if (/^multipart\/form-data/i.test(ct)) {
    const r = await parseForm(ctx.body(e), ctx.req.headers, (fields, file) => {
      if (fields.metadata && !userMetadata) {
        try {
          userMetadata = JSON.parse(fields.metadata);
        } catch {
          /* ignore */
        }
      }
      return store(file.stream, file.mimeType || 'application/octet-stream', fields.cacheControl);
    });
    if (!r.result) throw fault('invalid_argument', 'The multipart body has no file part');
    obj = r.result;
  } else {
    obj = await store(ctx.body(e), ct, header(ctx, 'cache-control'));
  }
  ctx.resolved.op = opName;
  return ctx.reply.status(200).send({ Id: obj.id, Key: `${bucket.name}/${key}`, id: obj.id, path: key, fullPath: `${bucket.name}/${key}` });
}

function download(ctx: StorageCtx, b: StorageBucket, key: string, e: StorageEffects | null) {
  const o = requireObject(ctx, b, key);
  const dl = ctx.query.get('download');
  const h: Record<string, string> = { etag: o.etag, 'cache-control': o.headers['cache-control'] ?? 'no-cache' };
  if (dl !== null) h['content-disposition'] = `attachment; filename="${(dl || key.split('/').pop() || 'download').replace(/"/g, '')}"`;
  return sendObject(ctx, o, e, h);
}

function signToken(ctx: StorageCtx | { instance: { config: Record<string, unknown> } }, url: string, expiresIn: number, extra: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ url, iat, exp: iat + expiresIn, ...extra }, secretOf(ctx));
}

/** ?token= of a signed URL: expiry always enforced; signature / path checked (lax: warning). */
function checkToken(ctx: StorageCtx, url: string, upload: boolean): Record<string, unknown> {
  const token = ctx.query.get('token');
  if (!token) throw fault('invalid_argument', 'Missing token', { status: 400, code: 'InvalidJWT' });
  const d = decodeJwt(token, secretOf(ctx));
  if (!d.payload) throw fault('bad_signature', 'jwt malformed');
  ctx.resolved.auth = { type: upload ? 'signed-upload-token' : 'signed-url', expiresAt: d.payload.exp ? new Date(Number(d.payload.exp) * 1000).toISOString() : null, verified: d.valid };
  if (Number(d.payload.exp ?? 0) * 1000 < Date.now()) throw fault('expired_url', '"exp" claim timestamp check failed', { reason: 'signed URL expired' });
  if (d.valid === false) laxOrThrow(ctx, { kind: 'bad_signature' }, 'Signed URL token does not verify with the instance jwtSecret', ctx.strict || ctx.instance.config.verifySignatures === true);
  if (d.payload.url !== url) laxOrThrow(ctx, { kind: 'bad_signature', message: 'url mismatch' }, `Token was signed for "${d.payload.url}", not "${url}"`);
  return d.payload;
}

async function list(ctx: StorageCtx, b: StorageBucket) {
  const body = await readJson<{ prefix?: string; limit?: number; offset?: number; search?: string; sortBy?: { column?: string; order?: string } }>(ctx);
  let prefix = String(body.prefix ?? '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const limit = Math.min(Number(body.limit ?? 100) || 100, 1000);
  const offset = Number(body.offset ?? 0) || 0;
  const search = String(body.search ?? '');
  const out = ctx.store.list(b, { prefix, delimiter: '/', limit: 100_000 });
  type Entry = { name: string; id: string | null; updated_at: string | null; created_at: string | null; last_accessed_at: string | null; metadata: unknown };
  let entries: Entry[] = [
    ...out.prefixes.map((p) => ({ name: p.slice(prefix.length, -1), id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null })),
    ...out.objects.map((o) => fileObject(o, o.key.slice(prefix.length))),
  ];
  if (search) entries = entries.filter((x) => x.name.toLowerCase().includes(search.toLowerCase()));
  const col = body.sortBy?.column ?? 'name';
  const dir = (body.sortBy?.order ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;
  entries.sort((a, z) => {
    const av = String((a as Record<string, unknown>)[col] ?? '');
    const zv = String((z as Record<string, unknown>)[col] ?? '');
    return av < zv ? -dir : av > zv ? dir : 0;
  });
  ctx.resolved.items = entries.length;
  return ctx.reply.send(entries.slice(offset, offset + limit));
}

async function listV2(ctx: StorageCtx, b: StorageBucket) {
  const body = await readJson<{ prefix?: string; limit?: number; cursor?: string; with_delimiter?: boolean }>(ctx);
  const prefix = String(body.prefix ?? '');
  const limit = Math.min(Number(body.limit ?? 1000) || 1000, 1000);
  const out = ctx.store.list(b, { prefix, delimiter: body.with_delimiter === false ? undefined : '/', after: body.cursor || undefined, limit });
  return ctx.reply.send({
    hasNext: out.truncated,
    nextCursor: out.truncated ? out.last : undefined,
    folders: out.prefixes.map((p) => ({ name: p.slice(prefix.length).replace(/\/$/, ''), key: p })),
    objects: out.objects.map((o) => ({ ...fileObject(o, o.key.slice(prefix.length)), key: o.key })),
  });
}

async function removeMany(ctx: StorageCtx, b: StorageBucket) {
  const body = await readJson<{ prefixes?: (string | { path: string })[] }>(ctx);
  const paths = (body.prefixes ?? []).map((p) => (typeof p === 'string' ? p : p?.path)).filter((p): p is string => typeof p === 'string');
  if (paths.length > 1000) throw fault('invalid_argument', 'At most 1000 paths per request');
  const removed = [];
  for (const k of paths) {
    const o = ctx.store.head(b, k);
    if (!o) continue;
    removed.push({ ...fileObject(o, k), bucket_id: b.name });
    ctx.store.remove(b, k);
  }
  ctx.resolved.keys = removed.length;
  if (removed.length) ctx.changed({ bucket: b.name, deleted: removed.length });
  return ctx.reply.send(removed);
}

async function moveOrCopy(ctx: StorageCtx, move: boolean) {
  const body = await readJson<{ bucketId?: string; sourceKey?: string; destinationKey?: string; destinationBucket?: string }>(ctx);
  if (!body.bucketId || !body.sourceKey || !body.destinationKey) throw fault('invalid_argument', 'bucketId, sourceKey and destinationKey are required');
  const src = requireBucket(ctx, body.bucketId);
  const dst = body.destinationBucket ? requireBucket(ctx, body.destinationBucket) : src;
  const so = requireObject(ctx, src, body.sourceKey);
  if (ctx.store.head(dst, body.destinationKey) && (header(ctx, 'x-upsert') ?? 'false') !== 'true') throw fault('precondition_failed', 'The resource already exists', { status: 400, code: 'Duplicate' });
  const obj = await ctx.store.copy(so, dst, body.destinationKey, { source: 'api', runId: ctx.explicitRun?.id ?? null, logId: ctx.req.trafficLogId ?? null });
  if (move) ctx.store.remove(src, body.sourceKey);
  noteObject(ctx, dst, obj, false);
  ctx.changed({ bucket: dst.name, key: obj.key, put: true });
  return ctx.reply.send(move ? { message: 'Successfully moved' } : { Id: obj.id, Key: `${dst.name}/${obj.key}` });
}

// ---------------------------------------------------------------- buckets

async function buckets(ctx: StorageCtx, rest: string[]) {
  const m = ctx.req.method;
  const id = rest[0];
  if (!id) {
    if (m === 'GET') {
      ctx.setOp('bucket', 'ListBuckets');
      if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
      return ctx.reply.send(ctx.hub.storage.repo.listBuckets(ctx.instance.id).map(bucketJson));
    }
    if (m === 'POST') {
      const body = await readJson<{ id?: string; name?: string; public?: boolean; file_size_limit?: unknown; allowed_mime_types?: string[] | null }>(ctx);
      const name = String(body.id ?? body.name ?? '');
      ctx.setOp('bucket', 'CreateBucket', { bucket: name });
      if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
      if (!BUCKET_NAME_RE.test(name)) throw fault('invalid_bucket_name', `Bucket name "${name}" is invalid (devhub: 3-63 chars, lowercase letters, digits, ".", "_", "-")`);
      if (ctx.store.bucket(name)) throw fault('bucket_exists');
      ctx.hub.storage.repo.createBucket(ctx.instance, { name, public: body.public === true, config: { fileSizeLimit: parseSize(body.file_size_limit), allowedMimeTypes: body.allowed_mime_types ?? null } });
      ctx.changed({ bucket: name, created: true });
      return ctx.reply.send({ name });
    }
    throw fault('method_not_allowed');
  }
  const b = requireBucketForOp(ctx, id, rest[1] === 'empty' ? 'EmptyBucket' : m === 'GET' ? 'GetBucket' : m === 'PUT' ? 'UpdateBucket' : m === 'DELETE' ? 'DeleteBucket' : 'Bucket');
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  if (rest[1] === 'empty' && m === 'POST') {
    const n = ctx.hub.storage.store(ctx.instance).empty(b);
    ctx.changed({ bucket: b.name, emptied: n });
    return ctx.reply.send({ message: 'Successfully emptied' });
  }
  if (m === 'GET') return ctx.reply.send(bucketJson(b));
  if (m === 'PUT') {
    const body = await readJson<{ public?: boolean; file_size_limit?: unknown; allowed_mime_types?: string[] | null }>(ctx);
    const config = { ...b.config };
    if (body.file_size_limit !== undefined) config.fileSizeLimit = parseSize(body.file_size_limit);
    if (body.allowed_mime_types !== undefined) config.allowedMimeTypes = body.allowed_mime_types;
    ctx.hub.storage.repo.updateBucket(b, { public: typeof body.public === 'boolean' ? body.public : undefined, config });
    ctx.changed({ bucket: b.name, updated: true });
    return ctx.reply.send({ message: 'Successfully updated' });
  }
  if (m === 'DELETE') {
    if (ctx.hub.storage.repo.bucketStats(b.id).objects > 0) throw fault('bucket_not_empty');
    ctx.hub.storage.repo.deleteBucket(b);
    ctx.changed({ bucket: b.name, deleted: true });
    return ctx.reply.send({ message: 'Successfully deleted' });
  }
  throw fault('method_not_allowed');
}

function requireBucketForOp(ctx: StorageCtx, id: string, op: string): StorageBucket {
  ctx.setOp('bucket', op, { bucket: id });
  return requireBucket(ctx, id);
}

// ---------------------------------------------------------------- S3 endpoint

async function s3Endpoint(ctx: StorageCtx, rest: string) {
  const sub: StorageCtx = { ...ctx, path: rest || '/', protocol: s3Protocol };
  try {
    return await s3Protocol.handle(sub);
  } catch (err) {
    if (!(err instanceof StorageFaultError)) throw err;
    const pe = s3Protocol.errorFor(sub, err.fault);
    ctx.resolved.error = { code: err.fault.code ?? err.fault.kind, status: pe.status };
    if (!ctx.req.trafficOutcome) ctx.req.trafficOutcome = pe.status >= 500 ? 'forced_error' : 'rejected';
    ctx.reply.status(pe.status);
    for (const [k, v] of Object.entries(pe.headers ?? {})) ctx.reply.header(k, v);
    if (pe.contentType) ctx.reply.type(pe.contentType);
    return ctx.reply.send(ctx.req.method === 'HEAD' ? undefined : pe.body);
  }
}

// ---------------------------------------------------------------- router

async function handleSupabase(ctx: StorageCtx): Promise<unknown> {
  const raw = ctx.path;
  if (!raw.startsWith('/storage/v1/') && raw !== '/storage/v1') throw fault('not_found', 'Supabase Storage lives under <endpoint>/storage/v1 (createClient(<endpoint>, key) adds it)', { status: 404 });
  const after = raw.slice('/storage/v1'.length);
  if (after === '/s3' || after.startsWith('/s3/')) return s3Endpoint(ctx, after.slice(3));
  const segs = after.split('/').slice(1);
  const m = ctx.req.method;
  const area = segs[0];
  if (area === 'bucket') {
    authenticate(ctx);
    return buckets(ctx, segs.slice(1).map(safe));
  }
  if (area === 'render' && segs[1] === 'image') {
    // /render/image/{public|authenticated|sign}/<b>/<path>: transformations are ignored, the original is served.
    ctx.warnings.push('Image transformation ignored by devhub: the original bytes are returned');
    const kind = segs[2];
    const b = safeDecode(segs[3] ?? '');
    const key = segs.slice(4).map(safeDecode).join('/');
    ctx.setOp('get', 'RenderImage', { bucket: b, key });
    if (kind === 'sign') checkToken(ctx, `${b}/${key}`, false);
    else authenticate(ctx);
    const bucket = requireBucket(ctx, b);
    const e = await gate(ctx, bucket, false);
    if (e === HANDLED) return ctx.reply;
    ctx.reply.header('x-devhub-transformations-ignored', [...ctx.query.keys()].filter((k) => k !== 'token').join(',') || 'none');
    return download(ctx, bucket, key, e);
  }
  if (area !== 'object') throw fault('not_found', `devhub does not simulate /storage/v1/${area ?? ''}`, { status: 404 });

  const sub = segs[1] ?? '';
  const restAfter = (n: number) => ({ bucket: safeDecode(segs[n] ?? ''), key: segs.slice(n + 1).map(safeDecode).join('/') });

  if (sub === 'list' && m === 'POST') {
    const bucket = safeDecode(segs[2] ?? '');
    ctx.setOp('list', 'ListObjects', { bucket });
    authenticate(ctx);
    const b = requireBucket(ctx, bucket);
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    return list(ctx, b);
  }
  if (sub === 'list-v2' && m === 'POST') {
    const bucket = safeDecode(segs[2] ?? '');
    ctx.setOp('list', 'ListObjectsV2', { bucket });
    authenticate(ctx);
    const b = requireBucket(ctx, bucket);
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    return listV2(ctx, b);
  }
  if ((sub === 'move' || sub === 'copy') && m === 'POST') {
    ctx.setOp('copy', sub === 'move' ? 'MoveObject' : 'CopyObject');
    authenticate(ctx);
    if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
    return moveOrCopy(ctx, sub === 'move');
  }
  if (sub === 'sign') {
    const { bucket, key } = restAfter(2);
    if (m === 'GET') {
      ctx.setOp('get', 'GetSignedObject', { bucket, key });
      checkToken(ctx, `${bucket}/${key}`, false);
      const b = requireBucket(ctx, bucket);
      const e = await gate(ctx, b, false);
      if (e === HANDLED) return ctx.reply;
      return download(ctx, b, key, e);
    }
    if (m === 'POST') {
      ctx.setOp('get', key ? 'CreateSignedUrl' : 'CreateSignedUrls', { bucket, key: key || undefined });
      authenticate(ctx);
      const b = requireBucket(ctx, bucket);
      if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
      const body = await readJson<{ expiresIn?: number; paths?: string[] }>(ctx);
      const exp = Number(body.expiresIn ?? 0);
      if (!(exp > 0)) throw fault('invalid_argument', 'expiresIn must be a positive number of seconds');
      const url = (k: string) => `/object/sign/${bucket}/${k.split('/').map(encodeURIComponent).join('/')}?token=${signToken(ctx, `${bucket}/${k}`, exp)}`;
      if (key) {
        requireObject(ctx, b, key);
        return ctx.reply.send({ signedURL: url(key) });
      }
      return ctx.reply.send((body.paths ?? []).map((p) => (ctx.store.head(b, p) ? { error: null, path: p, signedURL: url(p) } : { error: 'Either the object does not exist or you do not have access to it', path: p, signedURL: null })));
    }
    throw fault('method_not_allowed');
  }
  if (sub === 'upload' && segs[2] === 'sign') {
    const { bucket, key } = restAfter(3);
    if (m === 'POST') {
      ctx.setOp('put', 'CreateSignedUploadUrl', { bucket, key });
      authenticate(ctx);
      if ((await gate(ctx, ctx.store.bucket(bucket), false)) === HANDLED) return ctx.reply;
      await ctx.readSmall();
      const upsert = header(ctx, 'x-upsert') === 'true';
      const token = signToken(ctx, `${bucket}/${key}`, 7200, { upsert });
      return ctx.reply.send({ url: `/object/upload/sign/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}?token=${token}`, token });
    }
    if (m === 'PUT') {
      ctx.setOp('put', 'UploadToSignedUrl', { bucket, key });
      const payload = checkToken(ctx, `${bucket}/${key}`, true);
      const e = await gate(ctx, ctx.store.bucket(bucket), true);
      if (e === HANDLED) return ctx.reply;
      return upload(ctx, bucket, key, e, payload.upsert === true || header(ctx, 'x-upsert') === 'true', 'UploadToSignedUrl');
    }
    throw fault('method_not_allowed');
  }
  if (sub === 'public' || sub === 'authenticated') {
    const { bucket, key } = restAfter(2);
    ctx.setOp(m === 'HEAD' ? 'head' : 'get', sub === 'public' ? 'GetPublicObject' : 'GetAuthenticatedObject', { bucket, key });
    if (sub === 'authenticated') authenticate(ctx);
    const b = requireBucket(ctx, bucket);
    if (sub === 'public' && !b.public) throw fault('no_such_bucket', 'Bucket not found', { reason: `public URL of private bucket "${bucket}"` });
    const e = await gate(ctx, b, false);
    if (e === HANDLED) return ctx.reply;
    return download(ctx, b, key, e);
  }
  if (sub === 'info') {
    const off = segs[2] === 'public' || segs[2] === 'authenticated' ? 3 : 2;
    const { bucket, key } = restAfter(off);
    ctx.setOp('head', 'GetObjectInfo', { bucket, key });
    authenticate(ctx);
    const b = requireBucket(ctx, bucket);
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    const o = requireObject(ctx, b, key);
    return ctx.reply.send({
      id: o.id,
      name: key,
      version: o.id,
      bucket_id: b.name,
      size: o.size,
      content_type: o.contentType,
      cache_control: o.headers['cache-control'] ?? 'no-cache',
      etag: o.etag,
      metadata: o.extra.userMetadata ?? {},
      last_modified: o.updatedAt,
      created_at: o.createdAt,
    });
  }

  // /object/<bucket>[/<path>]
  const { bucket, key } = restAfter(1);
  if (!key) {
    if (m === 'DELETE') {
      ctx.setOp('delete', 'DeleteObjects', { bucket });
      authenticate(ctx);
      const b = requireBucket(ctx, bucket);
      if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
      return removeMany(ctx, b);
    }
    throw fault('invalid_argument', 'The object path is required', { status: 400 });
  }
  if (m === 'POST' || m === 'PUT') {
    ctx.setOp('put', m === 'POST' ? 'UploadObject' : 'UpdateObject', { bucket, key });
    authenticate(ctx);
    const e = await gate(ctx, ctx.store.bucket(bucket), true);
    if (e === HANDLED) return ctx.reply;
    // POST = create (x-upsert: true replaces); PUT = update (replaces, also when missing on devhub).
    const upsert = m === 'PUT' || header(ctx, 'x-upsert') === 'true';
    return upload(ctx, bucket, key, e, upsert, m === 'POST' ? 'UploadObject' : 'UpdateObject');
  }
  if (m === 'GET' || m === 'HEAD') {
    ctx.setOp(m === 'GET' ? 'get' : 'head', m === 'GET' ? 'GetObject' : 'HeadObject', { bucket, key });
    authenticate(ctx);
    const b = requireBucket(ctx, bucket);
    const e = await gate(ctx, b, false);
    if (e === HANDLED) return ctx.reply;
    return download(ctx, b, key, e);
  }
  if (m === 'DELETE') {
    ctx.setOp('delete', 'DeleteObject', { bucket, key });
    authenticate(ctx);
    const b = requireBucket(ctx, bucket);
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    requireObject(ctx, b, key);
    ctx.store.remove(b, key);
    ctx.changed({ bucket: b.name, key, deleted: true });
    return ctx.reply.send({ message: 'Successfully deleted' });
  }
  throw fault('method_not_allowed');
}

function supabaseSnippets(v: InstanceView): Snippet[] {
  const anon = v.credentials[0]?.accessKeyId ?? '';
  const service = v.credentials[0]?.secretAccessKey ?? '';
  return [
    {
      title: 'Node.js / browser — supabase-js',
      language: 'javascript',
      code:
        `import { createClient } from '@supabase/supabase-js';\n\n` +
        `// supabase-js appends /storage/v1 itself. Backend (in Docker: ${v.urls.docker}); browsers: ${v.urls.browser}\n` +
        `const supabase = createClient('${v.urls.backend}', '${anon}');\n\n` +
        `await supabase.storage.createBucket('avatars', { public: true });\n` +
        `const { data, error } = await supabase.storage.from('avatars').upload('public/cat.png', file, { contentType: 'image/png', upsert: true });\n` +
        `const { data: signed } = await supabase.storage.from('avatars').createSignedUrl('public/cat.png', 60);\n` +
        `const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl('public/cat.png');`,
    },
    {
      title: 'Environment (.env)',
      language: 'shell',
      code: `SUPABASE_URL=${v.urls.backend}\nNEXT_PUBLIC_SUPABASE_URL=${v.urls.browser}\nSUPABASE_ANON_KEY=${anon}\nSUPABASE_SERVICE_ROLE_KEY=${service}`,
    },
    {
      title: 'Python — supabase-py',
      language: 'python',
      code: `from supabase import create_client\n\nsupabase = create_client("${v.urls.backend}", "${anon}")\nsupabase.storage.from_("avatars").upload("public/cat.png", open("cat.png", "rb"), {"content-type": "image/png"})`,
    },
    {
      title: 'S3 endpoint (AWS SDK)',
      language: 'javascript',
      code: `new S3Client({ endpoint: '${v.urls.backend}/storage/v1/s3', forcePathStyle: true, region: '${v.region}', credentials: { accessKeyId: 'devhub', secretAccessKey: 'devhub-secret' } });`,
    },
  ];
}

export const supabaseProtocol: StorageProtocol = {
  id: 'supabase',
  presets: [SUPABASE_PRESET],
  reservedSegments: ['storage'],
  handle: handleSupabase,
  errorFor: supabaseError,
  snippets: supabaseSnippets,
  objectPath: (bucket, key) => `/storage/v1/object/public/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
  presign(ctx, input) {
    if (input.method !== 'GET') throw new HttpError(400, 'Supabase signed URLs are GET only (use createSignedUploadUrl for uploads)');
    const keyPath = input.key.split('/').map(encodeURIComponent).join('/');
    const token = signToken(ctx, `${input.bucket}/${input.key}`, input.expiresIn);
    const q = `?token=${token}${input.scenario ? `&hub_scenario=${encodeURIComponent(input.scenario)}` : ''}`;
    const path = `/storage/v1/object/sign/${input.bucket}/${keyPath}${q}`;
    return { backend: ctx.bases.backend + path, browser: ctx.bases.browser + path, expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(), headers: {} };
  },
};


let registered = false;
export function registerSupabaseProtocol(): void {
  if (registered) return;
  registered = true;
  registerStorageProtocol(supabaseProtocol);
}
