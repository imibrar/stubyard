/**
 * Helpers shared by the non-S3 protocol modules (GCS, Azure Blob, Cloudinary, Supabase): scenario gating, object
 * responses with ranges, uploads through the store, small JSON bodies, JWT-ish tokens.
 */
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { StorageBucket, StorageObject } from '../repos/storage.js';
import { activeContent, parseRange } from './s3/common.js';
import { tooLargeFault } from './store.js';
import { fault, StorageFaultError, type PutOptions, type StorageCtx, type StorageEffects, type StorageFault } from './types.js';

export const header = (ctx: StorageCtx, name: string): string | undefined => {
  const v = ctx.req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Split the raw path below the instance base into decoded segments ("/a/b%2Fc" → ["a", "b/c"]). */
export function segments(raw: string): string[] {
  return raw
    .split('/')
    .slice(1)
    .map((s) => safe(s));
}

export function safe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const HANDLED = Symbol('handled');

/**
 * Scenario effects for the classified operation: transport effects (delay, timeout, reset) and the generic
 * rejecting actions. Returns the effects (for body throttling / download corruption) or HANDLED.
 */
export async function gate(ctx: StorageCtx, bucket: StorageBucket | null, upload: boolean): Promise<StorageEffects | null | typeof HANDLED> {
  const e = ctx.effects(bucket);
  if (await ctx.transport(e)) return HANDLED;
  if (!e) return e;
  const reject = ['access_denied', 'slow_down', 'internal_error', 'quota_exceeded', 'expired_url', 'bad_signature', 'not_found'];
  if (reject.includes(e.action)) throw new StorageFaultError({ kind: e.action as StorageFault['kind'], reason: `scenario ${e.action}` });
  if (upload && e.action === 'entity_too_large' && e.params.maxBytes === undefined) throw new StorageFaultError({ kind: 'entity_too_large', reason: 'scenario entity_too_large' });
  if (upload && e.action === 'checksum_mismatch') throw new StorageFaultError({ kind: 'bad_digest', reason: 'scenario checksum_mismatch' });
  return e;
}

/** Byte limit of an upload under an entity_too_large{maxBytes} effect. */
export function maxBytesOf(e: StorageEffects | null): number | undefined {
  return e?.action === 'entity_too_large' && e.params.maxBytes !== undefined ? Number(e.params.maxBytes) : undefined;
}

/**
 * Before reading the body: a new key in a full instance (maxObjects; pass `target`), then a declared Content-Length
 * over the object limit / remaining quota. Each protocol renders the fault as its own native error.
 */
export function precheck(ctx: StorageCtx, e: StorageEffects | null, declared?: number, target?: { bucket: StorageBucket; key: string }): void {
  if (target) ctx.store.checkObjectLimit(target.bucket, target.key);
  const n = declared ?? Number(header(ctx, 'content-length') ?? NaN);
  if (!Number.isFinite(n)) return;
  const limit = maxBytesOf(e) ?? ctx.hub.storage.maxObjectBytes(ctx.instance);
  if (n > limit) throw tooLargeFault(limit, n);
  const lim = ctx.hub.storage.limits(ctx.instance);
  if (n > lim.remaining()) throw lim.quotaFault();
}

/** Store an object with the request's attribution, note it in the log and tell dashboards. */
export async function putObject(ctx: StorageCtx, bucket: StorageBucket, key: string, body: Readable, opts: PutOptions, e: StorageEffects | null): Promise<StorageObject> {
  const obj = await ctx.store.put(bucket, key, body, {
    source: 'api',
    runId: ctx.explicitRun?.id ?? null,
    logId: ctx.req.trafficLogId ?? null,
    maxBytes: maxBytesOf(e),
    ...opts,
  });
  noteObject(ctx, bucket, obj, true);
  return obj;
}

export function noteObject(ctx: StorageCtx, bucket: StorageBucket, obj: StorageObject, upload: boolean): void {
  if (upload) ctx.noteRequestSize(obj.size);
  Object.assign(ctx.resolved, { objectId: obj.id, etag: obj.etag, contentType: obj.contentType, key: obj.key, bucket: bucket.name });
  if (upload) ctx.changed({ bucket: bucket.name, key: obj.key, put: true });
}

/** Bucket for a write: created on the fly (with the usual warning) unless autoCreateBuckets is off. */
export function writableBucket(ctx: StorageCtx, name: string, missing: string): StorageBucket {
  const b = ctx.store.bucket(name);
  if (b) return b;
  const nb = ctx.store.bucketOrCreate(name);
  ctx.warnings.push(`${missing} "${name}" did not exist and was created automatically (autoCreateBuckets); real ${ctx.preset.name} answers not found`);
  ctx.changed({ bucket: name, created: true });
  return nb;
}

/**
 * Send an object (GET / HEAD) with Range support. `headers` are the provider's own headers; nosniff and the
 * CSP sandbox for active content are added here.
 */
export function sendObject(ctx: StorageCtx, o: StorageObject, e: StorageEffects | null, headers: Record<string, string>, opts: { head?: boolean; range?: string; contentType?: string } = {}) {
  const rangeHeader = opts.range ?? header(ctx, 'range');
  const range = parseRange(rangeHeader, o.size);
  if (range === 'invalid') throw fault('invalid_range', undefined, { headers: { 'content-range': `bytes */${o.size}` } });
  const ct = opts.contentType ?? o.contentType ?? 'application/octet-stream';
  const h: Record<string, string> = {
    'content-type': ct,
    'accept-ranges': 'bytes',
    'last-modified': new Date(o.updatedAt).toUTCString(),
    'x-content-type-options': 'nosniff',
    ...headers,
  };
  if (activeContent(ct) && ctx.instance.config.allowActiveContent !== true) h['content-security-policy'] = 'sandbox';
  for (const [k, v] of Object.entries(h)) ctx.reply.header(k, v);
  const len = range ? range.end - range.start + 1 : o.size;
  ctx.reply.header('content-length', String(len));
  if (range) ctx.reply.header('content-range', `bytes ${range.start}-${range.end}/${o.size}`);
  Object.assign(ctx.resolved, { objectId: o.id, etag: o.etag, size: o.size, contentType: o.contentType, ...(range ? { range: `${range.start}-${range.end}` } : {}) });
  ctx.reply.status(range ? 206 : 200);
  if (opts.head || ctx.req.method === 'HEAD') return ctx.reply.send();
  return ctx.sendBody(ctx.store.open(o, range), len, e);
}

/** Small JSON body ({} when empty); malformed → invalid_argument. */
export async function readJson<T = Record<string, unknown>>(ctx: StorageCtx, max = 1024 * 1024): Promise<T> {
  const buf = await ctx.readSmall(max);
  if (!buf.length) return {} as T;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw fault('invalid_argument', 'Request body is not valid JSON');
  }
}

/** urlencoded body → record (arrays as "a[]" keys collapse to comma lists). */
export function parseUrlencoded(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(s)) {
    if (k.endsWith('[]')) out[k.slice(0, -2)] = out[k.slice(0, -2)] ? `${out[k.slice(0, -2)]},${v}` : v;
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- HS256 JWT (Supabase tokens, signed upload URLs)

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Decode a JWT; `valid` is null when no secret was given (payload read unverified). */
export function decodeJwt(token: string, secret?: string): { payload: Record<string, unknown> | null; valid: boolean | null } {
  const parts = token.split('.');
  if (parts.length !== 3) return { payload: null, valid: false };
  let payload: Record<string, unknown> | null = null;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { payload: null, valid: false };
  }
  if (!secret) return { payload, valid: null };
  const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(parts[2]);
  return { payload, valid: a.length === b.length && crypto.timingSafeEqual(a, b) };
}

/** Lax / strict switch: strict → throw the fault, lax → warning. */
export function laxOrThrow(ctx: StorageCtx, f: StorageFault, warning: string, strict = ctx.strict): void {
  if (strict) throw new StorageFaultError({ ...f, reason: f.reason ?? warning });
  ctx.warnings.push(`${warning} (accepted in lax mode)`);
}
