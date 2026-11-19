/**
 * Cloudinary (preset "cloudinary"): Upload API (B/v1_1/<cloud>/<resource_type>/upload, signed or unsigned, chunked
 * upload_large, destroy, rename, explicit), a basic Admin API (resources list / get / delete, ping) and delivery URLs
 * (B/<cloud>/<resource_type>/<type>/[<transformations>/][v<version>/]<public_id>[.<ext>]) served from storage with
 * transformations ignored. Buckets are the resource types (image, video, raw); keys are public ids.
 */
import crypto from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { StorageBucket, StorageObject, StorageUpload } from '../../repos/storage.js';
import { checkOutboundUrl } from '../../traffic/outbound.js';
import { HttpError } from '../../util.js';
import { formatOf, imageSize, mimeOf } from '../image-size.js';
import { parseForm } from '../multipart-form.js';
import { gate, HANDLED, header, laxOrThrow, maxBytesOf, noteObject, parseUrlencoded, precheck, safe, sendObject } from '../provider-kit.js';
import { registerStorageProtocol } from '../service.js';
import { fault, StorageFaultError, type FaultKind, type InstanceView, type ProtocolError, type Snippet, type StorageCtx, type StorageEffects, type StorageFault, type StoragePreset, type StorageProtocol } from '../types.js';

const DEFAULT_CLOUD = 'devhub';
const DEFAULT_KEY = '123456789012345';
const DEFAULT_SECRET = 'devhub-secret';
const RESOURCE_TYPES = ['image', 'video', 'raw'] as const;

export const CLOUDINARY_PRESET: StoragePreset = {
  id: 'cloudinary',
  name: 'Cloudinary',
  protocol: 'cloudinary',
  description: 'Cloudinary Upload / Admin API and delivery URLs (cloudinary Node / Python / PHP / Ruby SDKs, unsigned browser uploads). Transformations are accepted and ignored.',
  region: 'global',
  credentials: [{ accessKeyId: DEFAULT_KEY, secretAccessKey: DEFAULT_SECRET }],
  quotaError: { code: 'Storage quota exceeded', status: 400 },
  quirks: { credentialLabels: ['api_key', 'api_secret'] },
  notes: [
    'Cloud name "devhub" (config.cloudName). Set upload_prefix to the endpoint; the Node SDK picks http/https when it is first loaded, so for an http:// endpoint put upload_prefix in CLOUDINARY_URL (see the snippet).',
    'Transformations, eager derivatives and format conversion are not performed: delivery URLs return the original bytes.',
  ],
  docsUrl: 'https://cloudinary.com/documentation/image_upload_api_reference',
};

const MAP: Partial<Record<FaultKind, [number, string]>> = {
  access_denied: [401, 'Invalid API key or not allowed'],
  slow_down: [420, 'Rate Limit Exceeded'],
  internal_error: [500, 'General Error'],
  quota_exceeded: [400, 'Storage quota exceeded'],
  entity_too_large: [400, 'File size too large'],
  expired_url: [401, 'Stale request'],
  bad_signature: [401, 'Invalid Signature'],
  bad_digest: [400, 'Upload checksum mismatch'],
  checksum_mismatch: [400, 'Upload checksum mismatch'],
  not_found: [404, 'Resource not found'],
  no_such_key: [404, 'Resource not found'],
  no_such_bucket: [404, 'Resource not found'],
  no_such_upload: [400, 'Upload session not found'],
  precondition_failed: [400, 'Resource already exists'],
  invalid_range: [416, 'Invalid range'],
  invalid_argument: [400, 'Invalid request'],
  invalid_request: [400, 'Invalid request'],
  unknown_access_key: [401, 'Unknown API key'],
  not_implemented: [501, 'Not implemented by devhub'],
  method_not_allowed: [405, 'Method not allowed'],
  unknown_instance: [404, 'Unknown cloud'],
  policy_violation: [400, 'Upload preset not found'],
  timeout: [499, 'Request Timeout'],
  cors_blocked: [403, 'CORS request not allowed'],
};

export function cloudinaryError(_ctx: StorageCtx | null, f: StorageFault): ProtocolError {
  const [status, message] = MAP[f.kind] ?? [500, f.kind];
  const st = f.status ?? status;
  if (st === 304) return { status: 304 };
  const headers: Record<string, string> = { 'x-cld-error': f.message ?? message };
  for (const k of Object.keys(headers)) headers[k] = headers[k].replace(/[^\x20-\x7e]/g, '?');
  return { status: st, headers, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: { message: f.message ?? message } }) };
}

// ---------------------------------------------------------------- helpers

type Inst = { instance: { config: Record<string, unknown> }; hub: StorageCtx['hub'] };
const cloudOf = (ctx: { instance: { config: Record<string, unknown> } }) => String(ctx.instance.config.cloudName || DEFAULT_CLOUD);
function creds(ctx: Inst) {
  const c = (ctx.instance.config.credentials as { accessKeyId: string; secretAccessKey: string }[] | undefined)?.[0];
  return {
    apiKey: String(ctx.instance.config.apiKey || c?.accessKeyId || DEFAULT_KEY),
    apiSecret: String(ctx.instance.config.apiSecret || c?.secretAccessKey || DEFAULT_SECRET),
    explicitSecret: !!(ctx.instance.config.apiSecret || c?.secretAccessKey),
  };
}

const EXCLUDED = new Set(['file', 'cloud_name', 'resource_type', 'api_key', 'signature', 'signature_algorithm']);

/** Cloudinary signature: sorted "k=v" pairs (non-empty, excluded keys dropped) joined by "&", plus the secret. */
export function cloudinarySignature(params: Record<string, string>, secret: string, algo: 'sha1' | 'sha256' = 'sha1'): string {
  const s = Object.keys(params)
    .filter((k) => !EXCLUDED.has(k) && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash(algo).update(s + secret).digest('hex');
}

/** Signed (api_key + timestamp + signature) or unsigned (upload_preset) upload / API call. */
function authenticate(ctx: StorageCtx, params: Record<string, string>, requireAuth = true): void {
  const { apiKey, apiSecret, explicitSecret } = creds(ctx);
  const verifyMode = explicitSecret || ctx.strict || ctx.instance.config.verifySignatures === true;
  if (params.signature) {
    const algo = params.signature_algorithm === 'sha256' ? 'sha256' : 'sha1';
    const expected = cloudinarySignature(params, apiSecret, algo);
    const ok = expected === params.signature;
    ctx.resolved.auth = { type: 'signed', accessKeyId: params.api_key ?? null, verified: ok };
    if (params.api_key && params.api_key !== apiKey) laxOrThrow(ctx, { kind: 'unknown_access_key', message: `Unknown API key ${params.api_key}` }, `Unknown api_key "${params.api_key}" (instance: ${apiKey})`);
    if (!ok) laxOrThrow(ctx, { kind: 'bad_signature', message: `Invalid Signature ${params.signature}. String to sign - '${Object.keys(params).filter((k) => !EXCLUDED.has(k) && params[k] !== '').sort().map((k) => `${k}=${params[k]}`).join('&')}'.` }, 'Cloudinary signature does not match the api_secret', verifyMode);
    const ts = Number(params.timestamp ?? 0);
    if (!ts) laxOrThrow(ctx, { kind: 'invalid_argument', message: 'Missing required parameter - timestamp' }, 'Signed request without timestamp');
    else if (Math.abs(Date.now() / 1000 - ts) > 3600) laxOrThrow(ctx, { kind: 'expired_url', message: `Stale request - reported time is ${new Date(ts * 1000).toISOString()} which is more than 1 hour ago` }, 'Stale timestamp (more than 1 hour)');
    return;
  }
  if (params.upload_preset) {
    ctx.resolved.auth = { type: 'unsigned', preset: params.upload_preset };
    const presets = (ctx.instance.config.uploadPresets as { name: string; unsigned?: boolean }[] | undefined) ?? [];
    const p = presets.find((x) => x.name === params.upload_preset);
    if (!p) laxOrThrow(ctx, { kind: 'policy_violation', message: `Upload preset not found` }, `Unknown upload preset "${params.upload_preset}" (configure uploadPresets on the instance)`, ctx.strict);
    else if (p.unsigned === false) laxOrThrow(ctx, { kind: 'policy_violation', message: 'Upload preset must be whitelisted for unsigned uploads' }, `Upload preset "${p.name}" is signed-only`);
    return;
  }
  const basic = /^Basic\s+(.+)$/i.exec(header(ctx, 'authorization') ?? '')?.[1];
  if (basic) {
    const [k, s] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    const ok = k === apiKey && s === apiSecret;
    ctx.resolved.auth = { type: 'basic', accessKeyId: k, verified: ok };
    if (!ok) laxOrThrow(ctx, { kind: 'access_denied', message: k !== apiKey ? `Unknown API key ${k}` : 'Invalid API secret' }, 'Basic auth does not match api_key / api_secret', verifyMode);
    return;
  }
  ctx.resolved.auth = { type: 'anonymous' };
  if (requireAuth) laxOrThrow(ctx, { kind: 'invalid_argument', message: 'Upload preset must be specified when using unsigned upload' }, 'Neither a signature nor an upload_preset');
}

const unixNow = () => Math.floor(Date.now() / 1000);
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

function deliveryPath(cloud: string, o: StorageObject, rt: string): string {
  const x = o.extra as Record<string, unknown>;
  const ext = rt === 'raw' || !x.format ? '' : `.${x.format}`;
  const ver = x.version ? `v${x.version}/` : '';
  return `/${cloud}/${rt}/${String(x.type ?? 'upload')}/${ver}${o.key.split('/').map(encodeURIComponent).join('/')}${ext}`;
}

/** url (http) and secure_url (https when devhub can tell the TLS address: the default ports; else the browser base). */
function urls(ctx: Inst & { project: { slug: string }; instance: StorageCtx['instance'] }, path: string) {
  const browser = ctx.hub.storage.browserBase(ctx.project as never, ctx.instance);
  const { httpPort, httpsPort } = ctx.hub.config;
  const u = new URL(browser);
  let plain = browser;
  let secure = browser;
  if (u.protocol === 'http:' && ctx.hub.tls && Number(u.port || 80) === httpPort) secure = browser.replace(/^http:\/\/([^/:]+):\d+/, `https://$1:${httpsPort}`);
  if (u.protocol === 'https:' && Number(u.port || 443) === httpsPort) plain = browser.replace(/^https:\/\/([^/:]+)(:\d+)?/, `http://$1:${httpPort}`);
  return { url: plain + path, secure_url: secure + path };
}

function asset(ctx: StorageCtx, b: StorageBucket, o: StorageObject, extra: Record<string, unknown> = {}) {
  const x = o.extra as Record<string, unknown>;
  const { apiSecret } = creds(ctx);
  const version = Number(x.version ?? unixNow());
  const p = deliveryPath(cloudOf(ctx), o, b.name);
  const out: Record<string, unknown> = {
    asset_id: x.asset_id ?? md5(o.id),
    public_id: o.key,
    version,
    version_id: x.version_id ?? md5(`${o.id}/${version}`),
    signature: crypto.createHash('sha1').update(`public_id=${o.key}&version=${version}${apiSecret}`).digest('hex'),
    ...(typeof x.width === 'number' ? { width: x.width, height: x.height } : {}),
    format: x.format ?? (b.name === 'raw' ? undefined : formatOf(null, o.contentType)),
    resource_type: b.name,
    created_at: new Date(o.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    tags: (x.tags as string[]) ?? [],
    bytes: o.size,
    type: x.type ?? 'upload',
    etag: o.md5 ?? o.etag.replace(/"/g, ''),
    placeholder: !!x.placeholder,
    ...urls(ctx, p),
    asset_folder: x.asset_folder ?? '',
    display_name: x.display_name ?? o.key.split('/').pop(),
    ...(x.context ? { context: x.context } : {}),
    original_filename: x.original_filename ?? o.key.split('/').pop(),
    api_key: creds(ctx).apiKey,
    ...extra,
  };
  if (out.format === undefined) delete out.format;
  return out;
}

/** Resource type of an "auto" upload from the content type / file name. */
function autoType(ct: string | null, name: string | null): (typeof RESOURCE_TYPES)[number] {
  const t = (ct ?? mimeOf(formatOf(name)) ?? '').toLowerCase();
  if (t.startsWith('image/') || t === 'application/pdf') return 'image';
  if (t.startsWith('video/') || t.startsWith('audio/')) return 'video';
  return 'raw';
}

function resourceBucket(ctx: StorageCtx, rt: string): StorageBucket {
  const b = ctx.store.bucket(rt);
  if (b) return b;
  return ctx.hub.storage.repo.createBucket(ctx.instance, { name: rt, public: true });
}

/** First bytes of the stream → width / height (images); passes everything through. */
class Sniffer extends Transform {
  head = Buffer.alloc(0);
  override _transform(c: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    if (this.head.length < 65536) this.head = Buffer.concat([this.head, c.subarray(0, 65536 - this.head.length)]);
    cb(null, c);
  }
}

// ---------------------------------------------------------------- upload

interface UploadSource {
  stream: Readable;
  filename: string | null;
  contentType: string | null;
  placeholder?: boolean;
}

async function sourceFromString(ctx: StorageCtx, file: string): Promise<UploadSource> {
  const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(file);
  if (data) {
    const buf = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]), 'utf8');
    return { stream: Readable.from([buf]), filename: null, contentType: data[1] || 'application/octet-stream' };
  }
  if (/^https?:\/\//i.test(file)) {
    const check = await checkOutboundUrl(file);
    const name = (() => {
      try {
        return new URL(file).pathname.split('/').pop() || null;
      } catch {
        return null;
      }
    })();
    if (check.allowed) {
      const res = await fetch(file, { redirect: 'error', signal: AbortSignal.timeout(15_000) }).catch((e) => {
        throw fault('invalid_argument', `Error in loading ${file} - ${(e as Error).message}`);
      });
      if (!res.ok || !res.body) throw fault('invalid_argument', `Error in loading ${file} - ${res.status} ${res.statusText}`);
      ctx.warnings.push(`Remote file fetched from ${check.host} (${check.reason})`);
      return { stream: Readable.fromWeb(res.body as never), filename: name, contentType: res.headers.get('content-type') };
    }
    ctx.warnings.push(`Remote URL not fetched: ${check.reason}. A placeholder was stored instead (DEVHUB_OUTBOUND_ALLOW controls which hosts devhub may fetch)`);
    const text = `devhub placeholder: Cloudinary would fetch ${file}\n`;
    const ct = mimeOf(formatOf(name));
    return { stream: Readable.from([Buffer.from(text)]), filename: name, contentType: ct && !ct.startsWith('image/') ? ct : 'text/plain', placeholder: true };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(file) && file.length > 16) return { stream: Readable.from([Buffer.from(file, 'base64')]), filename: null, contentType: null };
  throw fault('invalid_argument', `Invalid image file`);
}

function publicIdFor(params: Record<string, string>, filename: string | null, rt: string): string {
  const folder = (params.folder ?? params.asset_folder ?? '').replace(/^\/+|\/+$/g, '');
  let id = params.public_id;
  if (!id) {
    const base = filename && params.use_filename === 'true' ? (rt === 'raw' ? filename : filename.replace(/\.[^.]+$/, '')) : null;
    if (base) {
      const safeBase = base.replace(/[^\w\-./]+/g, '_');
      id = params.unique_filename === 'false' ? safeBase : `${safeBase}_${crypto.randomBytes(3).toString('hex')}`;
    } else id = crypto.randomBytes(10).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  }
  if (folder && !id.startsWith(folder + '/')) id = `${folder}/${id}`;
  return id;
}

async function commitAsset(ctx: StorageCtx, rtParam: string, params: Record<string, string>, src: UploadSource, e: StorageEffects | null, upload: StorageUpload | null) {
  const rt = rtParam === 'auto' ? autoType(src.contentType, src.filename) : rtParam;
  if (!(RESOURCE_TYPES as readonly string[]).includes(rt)) throw fault('invalid_argument', `Invalid resource type ${rtParam}`);
  const b = resourceBucket(ctx, rt);
  const publicId = (upload?.key && upload.key !== '?' ? upload.key : null) ?? publicIdFor(params, src.filename, rt);
  ctx.setOp('put', 'Upload', { bucket: rt, key: publicId });
  const existing = ctx.store.head(b, publicId);
  if (existing && params.overwrite === 'false') {
    src.stream.resume();
    noteObject(ctx, b, existing, false);
    return asset(ctx, b, existing, { existing: true });
  }
  const sniff = new Sniffer();
  src.stream.on('error', (err) => sniff.destroy(err));
  const body = upload ? null : src.stream.pipe(sniff);
  const extraBase: Record<string, unknown> = {
    public_id: publicId,
    version: unixNow(),
    type: params.type ?? 'upload',
    tags: params.tags ? params.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    original_filename: src.filename ? src.filename.replace(/\.[^.]+$/, '') : 'file',
    display_name: publicId.split('/').pop(),
    asset_folder: params.asset_folder ?? params.folder ?? '',
    ...(params.context ? { context: { custom: Object.fromEntries(params.context.split('|').map((kv) => kv.split('=')).filter((x) => x[0]).map(([k, v]) => [k, v ?? ''])) } } : {}),
    ...(src.placeholder ? { placeholder: true } : {}),
  };
  const contentType = src.contentType && src.contentType !== 'application/octet-stream' ? src.contentType : (mimeOf(formatOf(src.filename)) ?? src.contentType ?? 'application/octet-stream');
  let obj: StorageObject;
  if (upload) {
    obj = await ctx.store.uploads.complete(upload, ctx.store.uploads.parts(upload).map((p) => p.partId), { contentType, source: 'api', runId: upload.runId ?? ctx.explicitRun?.id ?? null, logId: ctx.req.trafficLogId ?? null, extra: extraBase });
  } else {
    obj = await ctx.store.put(b, publicId, body!, { contentType, source: 'api', runId: ctx.explicitRun?.id ?? null, logId: ctx.req.trafficLogId ?? null, maxBytes: maxBytesOf(e), extra: extraBase });
    ctx.noteRequestSize(obj.size);
  }
  // Format / dimensions from the bytes (header sniffing only; no image library).
  let head = sniff.head;
  if (upload || !head.length) {
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of ctx.store.open(obj, obj.size ? { start: 0, end: Math.min(obj.size, 65536) - 1 } : null)) {
      chunks.push(c as Buffer);
      n += (c as Buffer).length;
      if (n >= 65536) break;
    }
    head = Buffer.concat(chunks);
  }
  const dim = rt === 'raw' ? null : imageSize(head);
  const format = params.format || dim?.format || (rt === 'raw' ? null : formatOf(src.filename, contentType));
  const fin = ctx.hub.storage.repo.updateObjectMeta(obj, { extra: { ...obj.extra, ...(dim ? { width: dim.width, height: dim.height } : {}), ...(format ? { format } : {}), asset_id: md5(obj.id) } });
  noteObject(ctx, b, fin, false);
  ctx.changed({ bucket: rt, key: publicId, put: true });
  const eager = params.eager ? params.eager.split('|').map((t) => ({ transformation: t, ...urls(ctx, deliveryPath(cloudOf(ctx), fin, rt)) })) : undefined;
  if (eager) ctx.warnings.push('Eager transformations are not performed: the eager URLs point at the original bytes');
  return asset(ctx, b, fin, eager ? { eager } : {});
}

/** Chunked upload (upload_large): X-Unique-Upload-Id + Content-Range "bytes a-b/(total|-1)". */
async function chunk(ctx: StorageCtx, rtParam: string, params: Record<string, string>, src: UploadSource, e: StorageEffects | null) {
  const uid = header(ctx, 'x-unique-upload-id')!;
  const cr = /^bytes\s+(\d+)-(\d+)\/(-?\d+|\*)$/i.exec(header(ctx, 'content-range') ?? '');
  if (!cr) {
    src.stream.resume();
    throw fault('invalid_argument', 'Invalid Content-Range header');
  }
  const start = Number(cr[1]);
  const total = cr[3] === '*' || cr[3] === '-1' ? null : Number(cr[3]);
  const holder = resourceBucket(ctx, rtParam === 'auto' ? 'raw' : rtParam);
  let u = ctx.store.uploads.list(holder).find((x) => x.kind === 'cloudinary-chunked' && x.state.uid === uid) ?? null;
  if (!u) {
    if (start !== 0) {
      src.stream.resume();
      throw fault('no_such_upload', 'Chunked upload not found (the first chunk must start at byte 0)');
    }
    const rt = rtParam === 'auto' ? autoType(src.contentType, src.filename) : rtParam;
    u = ctx.store.uploads.create(holder, 'cloudinary-chunked', publicIdFor(params, src.filename, rt), { state: { uid, size: 0, rt, filename: src.filename }, runId: ctx.explicitRun?.id ?? null });
  }
  ctx.resolved.uploadId = u.id;
  const st = u.state as { uid: string; size: number; rt: string; filename: string | null };
  if (start !== st.size) {
    src.stream.resume();
    throw fault('invalid_argument', `Chunk starts at ${start}, expected ${st.size}`);
  }
  const p = await ctx.store.uploads.putPart(u, String(start), src.stream, { maxBytes: maxBytesOf(e) });
  st.size += p.size;
  ctx.hub.storage.repo.updateUploadState(u.id, { ...u.state, size: st.size });
  ctx.noteRequestSize(p.size);
  if (total === null || st.size < total) {
    ctx.setOp('multipart', 'UploadChunk', { bucket: holder.name, key: u.key });
    ctx.changed({ upload: u.id });
    return ctx.reply.send({ done: false, bytes: st.size, upload_id: uid });
  }
  // The final chunk: the resource type / bucket may differ from the holder (auto).
  const target = resourceBucket(ctx, st.rt);
  const upload = target.id === holder.id ? u : u;
  if (target.id !== holder.id) {
    // Move the session's parts by completing into the holder and copying; rare (auto + non-raw).
    const tmp = await ctx.store.uploads.complete(upload, ctx.store.uploads.parts(upload).map((x) => x.partId), { contentType: src.contentType, source: 'api' });
    const moved = await ctx.store.copy(tmp, target, tmp.key, { source: 'api', runId: u.runId, logId: ctx.req.trafficLogId ?? null });
    ctx.store.remove(holder, tmp.key);
    return ctx.reply.send(await commitExisting(ctx, target, moved, params, st.filename));
  }
  return ctx.reply.send(await commitAsset(ctx, st.rt, params, { stream: Readable.from([]), filename: st.filename, contentType: src.contentType }, e, upload));
}

async function commitExisting(ctx: StorageCtx, b: StorageBucket, o: StorageObject, params: Record<string, string>, filename: string | null) {
  const chunks: Buffer[] = [];
  for await (const c of ctx.store.open(o, o.size ? { start: 0, end: Math.min(o.size, 65536) - 1 } : null)) chunks.push(c as Buffer);
  const dim = b.name === 'raw' ? null : imageSize(Buffer.concat(chunks));
  const fin = ctx.hub.storage.repo.updateObjectMeta(o, { extra: { ...o.extra, public_id: o.key, version: unixNow(), type: params.type ?? 'upload', original_filename: filename?.replace(/\.[^.]+$/, '') ?? 'file', ...(dim ? { width: dim.width, height: dim.height, format: dim.format } : {}) } });
  noteObject(ctx, b, fin, false);
  ctx.changed({ bucket: b.name, key: fin.key, put: true });
  return asset(ctx, b, fin);
}

async function uploadEndpoint(ctx: StorageCtx, rt: string) {
  if (!['image', 'video', 'raw', 'auto'].includes(rt)) throw fault('invalid_argument', `Invalid resource type ${rt}`);
  ctx.setOp('put', 'Upload', { bucket: rt === 'auto' ? undefined : rt });
  const e = await gate(ctx, ctx.store.bucket(rt), true);
  if (e === HANDLED) return ctx.reply;
  precheck(ctx, e);
  const ct = header(ctx, 'content-type') ?? '';
  const chunked = !!header(ctx, 'x-unique-upload-id') && !!header(ctx, 'content-range');
  if (/^multipart\/form-data/i.test(ct)) {
    let handled: unknown = null;
    const r = await parseForm(ctx.body(e), ctx.req.headers, async (fields, file) => {
      authenticate(ctx, fields);
      const src: UploadSource = { stream: file.stream, filename: file.filename || null, contentType: file.mimeType || null };
      handled = chunked ? await chunk(ctx, rt, fields, src, e) : await commitAsset(ctx, rt, fields, src, e, null);
      return true;
    });
    if (r.result) return chunked ? handled : ctx.reply.send(handled);
    const fields = r.fields;
    authenticate(ctx, fields);
    if (!fields.file) throw fault('invalid_argument', 'Missing required parameter - file');
    return ctx.reply.send(await commitAsset(ctx, rt, fields, await sourceFromString(ctx, fields.file), e, null));
  }
  const max = Math.min(Math.ceil(ctx.hub.storage.maxObjectBytes(ctx.instance) * 1.4) + 65536, 128 * 1024 * 1024);
  const raw = (await ctx.readSmall(max)).toString('utf8');
  let params: Record<string, string>;
  if (/json/i.test(ct)) {
    try {
      const j = JSON.parse(raw || '{}') as Record<string, unknown>;
      params = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)]));
    } catch {
      throw fault('invalid_argument', 'Invalid JSON body');
    }
  } else params = parseUrlencoded(raw);
  ctx.req.rawBody = Buffer.from(raw.length > 4096 ? raw.slice(0, 4096) + '…' : raw);
  authenticate(ctx, params);
  if (!params.file) throw fault('invalid_argument', 'Missing required parameter - file');
  return ctx.reply.send(await commitAsset(ctx, rt, params, await sourceFromString(ctx, params.file), e, null));
}

async function readParams(ctx: StorageCtx): Promise<Record<string, string>> {
  const ct = header(ctx, 'content-type') ?? '';
  const q = Object.fromEntries([...ctx.query.entries()].map(([k, v]) => [k.replace(/\[\]$/, ''), v]));
  if (ctx.req.method === 'GET' || ctx.req.method === 'DELETE') {
    const all: Record<string, string> = {};
    for (const [k, v] of ctx.query.entries()) {
      const key = k.replace(/\[\]$/, '');
      all[key] = all[key] ? `${all[key]},${v}` : v;
    }
    if (ctx.req.method === 'DELETE' && header(ctx, 'content-length') && header(ctx, 'content-length') !== '0') Object.assign(all, parseUrlencoded((await ctx.readSmall()).toString('utf8')));
    return all;
  }
  if (/^multipart\/form-data/i.test(ct)) {
    const r = await parseForm(ctx.body(null), ctx.req.headers, async (_f, file) => {
      file.stream.resume();
      return true;
    });
    return { ...q, ...r.fields, ...r.after };
  }
  const raw = (await ctx.readSmall()).toString('utf8');
  if (/json/i.test(ct)) {
    try {
      const j = JSON.parse(raw || '{}') as Record<string, unknown>;
      return { ...q, ...Object.fromEntries(Object.entries(j).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])) };
    } catch {
      throw fault('invalid_argument', 'Invalid JSON body');
    }
  }
  return { ...q, ...parseUrlencoded(raw) };
}

async function destroy(ctx: StorageCtx, rt: string) {
  const params = await readParams(ctx);
  ctx.setOp('delete', 'Destroy', { bucket: rt, key: params.public_id });
  authenticate(ctx, params);
  const b = ctx.store.bucket(rt);
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  if (!params.public_id) throw fault('invalid_argument', 'Missing required parameter - public_id');
  const ok = !!b && ctx.store.remove(b, params.public_id);
  if (ok) ctx.changed({ bucket: rt, key: params.public_id, deleted: true });
  return ctx.reply.send({ result: ok ? 'ok' : 'not found' });
}

async function rename(ctx: StorageCtx, rt: string) {
  const params = await readParams(ctx);
  ctx.setOp('copy', 'Rename', { bucket: rt, key: params.to_public_id });
  authenticate(ctx, params);
  const b = ctx.store.bucket(rt);
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  const from = params.from_public_id;
  const to = params.to_public_id;
  if (!from || !to) throw fault('invalid_argument', 'Missing required parameter - from_public_id / to_public_id');
  const src = b ? ctx.store.head(b, from) : null;
  if (!b || !src) throw fault('not_found', `Resource not found - ${from}`);
  if (ctx.store.head(b, to) && params.overwrite !== 'true') throw fault('precondition_failed', `to_public_id ${to} already exists`);
  const obj = await ctx.store.copy(src, b, to, { source: 'api', runId: ctx.explicitRun?.id ?? null, logId: ctx.req.trafficLogId ?? null, extra: { ...src.extra, public_id: to, display_name: to.split('/').pop() } });
  ctx.store.remove(b, from);
  noteObject(ctx, b, obj, false);
  ctx.changed({ bucket: rt, key: to, put: true });
  return ctx.reply.send(asset(ctx, b, obj));
}

async function explicit(ctx: StorageCtx, rt: string) {
  const params = await readParams(ctx);
  ctx.setOp('get', 'Explicit', { bucket: rt, key: params.public_id });
  authenticate(ctx, params);
  const b = ctx.store.bucket(rt);
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  const o = b && params.public_id ? ctx.store.head(b, params.public_id) : null;
  if (!b || !o) throw fault('not_found', `Resource not found - ${params.public_id ?? ''}`);
  let fin = o;
  if (params.tags) fin = ctx.hub.storage.repo.updateObjectMeta(o, { extra: { ...o.extra, tags: params.tags.split(',').map((t) => t.trim()) } });
  const eager = params.eager ? params.eager.split('|').map((t) => ({ transformation: t, ...urls(ctx, deliveryPath(cloudOf(ctx), fin, rt)) })) : undefined;
  return ctx.reply.send(asset(ctx, b, fin, eager ? { eager } : {}));
}

// ---------------------------------------------------------------- Admin API

async function admin(ctx: StorageCtx, rest: string[]) {
  const m = ctx.req.method;
  if (rest[0] === 'ping') {
    ctx.setOp('any', 'Ping');
    authenticate(ctx, {}, false);
    return ctx.reply.send({ status: 'ok' });
  }
  if (rest[0] === 'usage') {
    ctx.setOp('any', 'Usage');
    authenticate(ctx, {}, false);
    const u = ctx.hub.storage.repo.usage({ instanceId: ctx.instance.id });
    return ctx.reply.send({ plan: 'devhub', last_updated: new Date().toISOString().slice(0, 10), resources: u.objects, storage: { usage: u.bytes }, requests: 0 });
  }
  if (rest[0] === 'upload_presets') {
    ctx.setOp('any', m === 'POST' ? 'CreateUploadPreset' : 'ListUploadPresets');
    authenticate(ctx, {}, false);
    const presets = ((ctx.instance.config.uploadPresets as { name: string; unsigned?: boolean; folder?: string }[] | undefined) ?? []).slice();
    if (m === 'POST') {
      const p = await readParams(ctx);
      const name = p.name || `preset_${crypto.randomBytes(4).toString('hex')}`;
      const next = [...presets.filter((x) => x.name !== name), { name, unsigned: p.unsigned === 'true', ...(p.folder ? { folder: p.folder } : {}) }];
      ctx.hub.storage.update(ctx.instance, { config: { uploadPresets: next } });
      return ctx.reply.send({ message: 'created', name });
    }
    return ctx.reply.send({ presets: presets.map((p) => ({ name: p.name, unsigned: p.unsigned !== false, settings: p.folder ? { folder: p.folder } : {} })) });
  }
  if (rest[0] !== 'resources') throw fault('not_implemented', `devhub does not simulate the Admin API /${rest.join('/')}`);
  const rt = rest[1];
  const type = rest[2];
  const publicId = rest.slice(3).join('/');
  const params = await readParams(ctx);
  authenticate(ctx, {}, false);
  if (!rt) {
    ctx.setOp('list', 'ResourceTypes');
    return ctx.reply.send({ resource_types: ctx.hub.storage.repo.listBuckets(ctx.instance.id).map((b) => b.name) });
  }
  const b = ctx.store.bucket(rt);
  if (m === 'DELETE') {
    ctx.setOp('delete', 'DeleteResources', { bucket: rt });
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    const ids = (params.public_ids ?? '').split(',').filter(Boolean);
    const prefix = params.prefix;
    const deleted: Record<string, string> = {};
    if (b && prefix) {
      for (const o of ctx.store.list(b, { prefix, limit: 1000 }).objects) {
        ctx.store.remove(b, o.key);
        deleted[o.key] = 'deleted';
      }
    }
    for (const id of ids) deleted[id] = b && ctx.store.remove(b, id) ? 'deleted' : 'not_found';
    if (Object.keys(deleted).length) ctx.changed({ bucket: rt, deleted: Object.keys(deleted).length });
    return ctx.reply.send({ deleted, deleted_counts: Object.fromEntries(Object.keys(deleted).map((k) => [k, { original: deleted[k] === 'deleted' ? 1 : 0, derived: 0 }])), partial: false });
  }
  if (publicId) {
    ctx.setOp('head', 'GetResource', { bucket: rt, key: publicId });
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    const o = b ? ctx.store.head(b, publicId) : null;
    if (!b || !o) throw fault('not_found', `Resource not found - ${publicId}`);
    return ctx.reply.send({ ...asset(ctx, b, o), derived: [] });
  }
  ctx.setOp('list', 'ListResources', { bucket: rt });
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  if (!b) return ctx.reply.send({ resources: [] });
  const max = Math.min(Number(params.max_results ?? 10) || 10, 500);
  const after = params.next_cursor ? Buffer.from(params.next_cursor, 'base64url').toString('utf8') : undefined;
  const out = ctx.store.list(b, { prefix: params.prefix ?? '', after, limit: max });
  const items = out.objects.filter((o) => !type || String(o.extra.type ?? 'upload') === type);
  ctx.resolved.items = items.length;
  const res: Record<string, unknown> = { resources: items.map((o) => asset(ctx, b, o)) };
  if (out.truncated && out.last) res.next_cursor = Buffer.from(out.last).toString('base64url');
  return ctx.reply.send(res);
}

// ---------------------------------------------------------------- delivery

async function delivery(ctx: StorageCtx, segs: string[]) {
  // segs: [rt, type, ...rest]
  const rt = segs[0];
  const type = segs[1];
  ctx.setOp(ctx.req.method === 'HEAD' ? 'head' : 'get', 'Deliver', { bucket: rt });
  ctx.resolved.auth = { type: 'delivery' };
  const b = ctx.store.bucket(rt);
  const e = await gate(ctx, b, false);
  if (e === HANDLED) return ctx.reply;
  if (!b || !type) throw fault('not_found', 'Resource not found');
  let rest = segs.slice(2);
  const vi = rest.findIndex((s) => /^v\d+$/.test(s));
  let transformations: string[] = [];
  if (vi >= 0) {
    transformations = rest.slice(0, vi);
    rest = rest.slice(vi + 1);
  }
  // Without a version, transformations and folders look alike: take the longest public id that exists.
  let found: StorageObject | null = null;
  let ext: string | null = null;
  for (let i = 0; i < rest.length && !found; i++) {
    const path = rest.slice(i).join('/');
    const m = /^(.*)\.([A-Za-z0-9]{1,8})$/.exec(path);
    const candidates = rt === 'raw' ? [path, m?.[1]] : [m?.[1], path];
    for (const c of candidates) {
      if (!c) continue;
      const o = ctx.store.head(b, c);
      if (o) {
        found = o;
        ext = c === path ? null : (m?.[2] ?? null);
        transformations = [...transformations, ...rest.slice(0, i)];
        break;
      }
    }
  }
  if (!found) throw fault('not_found', 'Resource not found');
  ctx.setOp(ctx.req.method === 'HEAD' ? 'head' : 'get', 'Deliver', { bucket: rt, key: found.key });
  const format = String(found.extra.format ?? '');
  const ignored = [...transformations];
  if (ext && format && ext.toLowerCase() !== format.toLowerCase() && !(ext === 'jpeg' && format === 'jpg')) ignored.push(`format ${ext} (stored: ${format})`);
  const h: Record<string, string> = { etag: `"${found.md5 ?? ''}"`, 'cache-control': 'public, max-age=2592000', 'access-control-allow-origin': '*', 'timing-allow-origin': '*' };
  if (ignored.length) {
    h['x-devhub-transformations-ignored'] = ignored.join('/').replace(/[^\x20-\x7e]/g, '?');
    ctx.warnings.push(`Transformations ignored by devhub (original bytes served): ${ignored.join('/')}`);
  }
  return sendObject(ctx, found, e, h);
}

// ---------------------------------------------------------------- router

async function handleCloudinary(ctx: StorageCtx): Promise<unknown> {
  const segs = ctx.path.split('/').slice(1).map(safe);
  if (segs[segs.length - 1] === '' && segs.length > 1) segs.pop();
  const cloud = cloudOf(ctx);
  if (segs[0] === 'v1_1' || segs[0] === 'v2') {
    const c = segs[1] ?? '';
    if (c !== cloud) laxOrThrow(ctx, { kind: 'unknown_instance', message: `Invalid cloud_name ${c}`, status: 401 }, `Cloud name "${c}" in the URL, instance cloud name is "${cloud}"`);
    const rest = segs.slice(2);
    if (['resources', 'ping', 'usage', 'upload_presets', 'tags', 'folders'].includes(rest[0])) return admin(ctx, rest);
    const [rt, action] = rest;
    if (ctx.req.method !== 'POST') throw fault('method_not_allowed');
    if (action === 'upload') return uploadEndpoint(ctx, rt);
    if (action === 'destroy') return destroy(ctx, rt);
    if (action === 'rename') return rename(ctx, rt);
    if (action === 'explicit') return explicit(ctx, rt);
    ctx.setOp('any', `NotImplemented:${action}`);
    throw fault('not_implemented', `devhub does not simulate the Upload API action "${action ?? ''}"`);
  }
  if (segs[0] === cloud || (segs[0] && (RESOURCE_TYPES as readonly string[]).includes(segs[1] ?? ''))) {
    if (segs[0] !== cloud) ctx.warnings.push(`Cloud name "${segs[0]}" in the delivery URL, instance cloud name is "${cloud}"`);
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') throw fault('method_not_allowed');
    return delivery(ctx, segs.slice(1));
  }
  ctx.setOp('any', 'Unknown');
  throw fault('not_found', `Cloudinary URLs look like ${ctx.bases.request}/v1_1/${cloud}/image/upload (API) or ${ctx.bases.request}/${cloud}/image/upload/<public_id> (delivery)`);
}

function cloudinarySnippets(v: InstanceView): Snippet[] {
  const cloud = String(v.config.cloudName || DEFAULT_CLOUD);
  const key = v.credentials[0]?.accessKeyId ?? DEFAULT_KEY;
  const secret = v.credentials[0]?.secretAccessKey ?? DEFAULT_SECRET;
  return [
    {
      title: 'Node.js — cloudinary',
      language: 'javascript',
      code:
        `// The Node SDK chooses http/https when it is first loaded, from CLOUDINARY_URL: set it before importing.\n` +
        `// .env: CLOUDINARY_URL=cloudinary://${key}:${secret}@${cloud}?upload_prefix=${v.urls.backend}\n` +
        `import { v2 as cloudinary } from 'cloudinary';\n\n` +
        `const res = await cloudinary.uploader.upload('photo.jpg', { folder: 'avatars' });\n` +
        `console.log(res.secure_url); // served by devhub; transformations in the URL are ignored\n` +
        `await cloudinary.uploader.destroy(res.public_id);\n` +
        `const { resources } = await cloudinary.api.resources({ max_results: 50 });`,
    },
    {
      title: 'Environment (.env)',
      language: 'shell',
      code: `CLOUDINARY_URL=cloudinary://${key}:${secret}@${cloud}?upload_prefix=${v.urls.backend}\n# In Docker: upload_prefix=${v.urls.docker}\nCLOUDINARY_CLOUD_NAME=${cloud}\nCLOUDINARY_API_KEY=${key}\nCLOUDINARY_API_SECRET=${secret}`,
    },
    {
      title: 'Browser — unsigned upload',
      language: 'javascript',
      code: `const form = new FormData();\nform.append('file', fileInput.files[0]);\nform.append('upload_preset', 'unsigned_dev');\nconst res = await fetch('${v.urls.browser}/v1_1/${cloud}/image/upload', { method: 'POST', body: form }).then((r) => r.json());`,
    },
    {
      title: 'Python — cloudinary',
      language: 'python',
      code: `import cloudinary, cloudinary.uploader\n\ncloudinary.config(cloud_name="${cloud}", api_key="${key}", api_secret="${secret}", upload_prefix="${v.urls.backend}")\ncloudinary.uploader.upload("photo.jpg", folder="avatars")`,
    },
  ];
}

export const cloudinaryProtocol: StorageProtocol = {
  id: 'cloudinary',
  presets: [CLOUDINARY_PRESET],
  reservedSegments: ['v1_1', 'v2'],
  handle: handleCloudinary,
  errorFor: cloudinaryError,
  snippets: cloudinarySnippets,
  objectPath: (bucket, key, i) => `/${String(i.config.cloudName || DEFAULT_CLOUD)}/${bucket}/upload/${key.split('/').map(encodeURIComponent).join('/')}`,
  commonHeaders: (ctx) => ({ 'x-request-id': ctx.requestId }),
  presign(ctx, input) {
    if (input.method !== 'GET' && input.method !== 'HEAD') throw new HttpError(400, 'Cloudinary delivery URLs are read-only (uploads go through the Upload API)');
    const o = ctx.hub.storage.repo.getBucket(ctx.instance.id, input.bucket);
    const obj = o ? ctx.hub.storage.repo.getObject(o.id, input.key) : null;
    const path = obj ? deliveryPath(cloudOf(ctx), obj, input.bucket) : `/${cloudOf(ctx)}/${input.bucket}/upload/${input.key.split('/').map(encodeURIComponent).join('/')}`;
    const q = input.scenario ? `?hub_scenario=${encodeURIComponent(input.scenario)}` : '';
    return { backend: ctx.bases.backend + path + q, browser: ctx.bases.browser + path + q, expiresAt: new Date(Date.now() + 10 * 365 * 86400_000).toISOString(), headers: {} };
  },
};

void StorageFaultError;

let registered = false;
export function registerCloudinaryProtocol(): void {
  if (registered) return;
  registered = true;
  registerStorageProtocol(cloudinaryProtocol);
}
