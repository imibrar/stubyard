import type { StorageObject } from '../../repos/storage.js';
import { isAwsChunked, AwsChunkedDecoder, storedEncoding } from '../aws-chunked.js';
import { parseAlgo } from '../checksums.js';
import { verifyChunkSignatures } from '../sigv4.js';
import type { Readable } from 'node:stream';
import { fault, type ByteRange, type ChecksumAlgo, type Digests, type StorageCtx, type StorageFault } from '../types.js';
import type { S3Auth } from './auth.js';

export const STORED_HEADERS = ['cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires'] as const;

export const hdr = (ctx: StorageCtx, name: string): string | undefined => {
  const v = ctx.req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function userMetadata(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k.startsWith('x-amz-meta-') && v !== undefined) out[k.slice(11)] = Array.isArray(v) ? v.join(',') : v;
  return out;
}

export function storedHeaders(ctx: StorageCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of STORED_HEADERS) {
    const v = hdr(ctx, h);
    if (v === undefined) continue;
    if (h === 'content-encoding') {
      const e = storedEncoding(v);
      if (e) out[h] = e;
    } else out[h] = v;
  }
  return out;
}

/** RFC 1123 date for Last-Modified (second precision). */
export const httpDate = (iso: string) => new Date(iso).toUTCString();
/** ISO-8601 with milliseconds for XML. */
export const xmlDate = (iso: string) => new Date(iso).toISOString();

/** Response headers of an object (GET / HEAD), including stored headers and user metadata. */
export function objectHeaders(ctx: StorageCtx, o: StorageObject): Record<string, string> {
  const h: Record<string, string> = {
    etag: o.etag,
    'last-modified': httpDate(o.updatedAt),
    'accept-ranges': 'bytes',
    'content-type': o.contentType || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    ...o.headers,
  };
  for (const [k, v] of Object.entries(o.metadata)) h[`x-amz-meta-${k}`] = v;
  if (o.parts) h['x-amz-mp-parts-count'] = String(o.parts);
  if (activeContent(o.contentType) && ctx.instance.config.allowActiveContent !== true) h['content-security-policy'] = 'sandbox';
  if (hdr(ctx, 'x-amz-checksum-mode')?.toUpperCase() === 'ENABLED') {
    for (const [k, v] of Object.entries(o.checksums)) if (k !== 'type') h[`x-amz-checksum-${k}`] = v;
    if (Object.keys(o.checksums).some((k) => k !== 'type')) h['x-amz-checksum-type'] = o.checksums.type ?? (o.parts ? 'COMPOSITE' : 'FULL_OBJECT');
  }
  // response-* query overrides (presigned downloads).
  for (const [q, name] of [
    ['response-content-type', 'content-type'],
    ['response-content-disposition', 'content-disposition'],
    ['response-cache-control', 'cache-control'],
    ['response-content-encoding', 'content-encoding'],
    ['response-content-language', 'content-language'],
    ['response-expires', 'expires'],
  ] as const) {
    const v = ctx.query.get(q);
    if (v) h[name] = v;
  }
  return h;
}

/** HTML, SVG and XML can run script in the stubyard origin: served with CSP sandbox unless allowActiveContent. */
export function activeContent(ct: string | null | undefined): boolean {
  const t = (ct ?? '').toLowerCase();
  return /html|svg|xml|javascript|ecmascript/.test(t);
}

/** "bytes=0-99" / "bytes=-500" / "bytes=100-" → range; multi-range → null (full 200); unsatisfiable → 'invalid'. */
export function parseRange(v: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!v) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(v.trim());
  if (!m) return null;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    return size === 0 ? 'invalid' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || (m[2] !== '' && Number(m[2]) < start)) return 'invalid';
  return { start, end };
}

/** If-Match / If-None-Match / If-(Un)Modified-Since. Returns a fault (412 / 304) or null. */
export function checkConditions(ctx: StorageCtx, o: StorageObject, prefix = ''): StorageFault | null {
  const g = (n: string) => hdr(ctx, prefix + n);
  const etagIn = (list: string) => list.split(',').map((s) => s.trim()).some((e) => e === '*' || e === o.etag || `"${e}"` === o.etag || e.replace(/^W\//, '') === o.etag);
  const modified = Math.floor(Date.parse(o.updatedAt) / 1000);
  const ifMatch = g('if-match');
  const ifNone = g('if-none-match');
  const ifUnmod = g('if-unmodified-since');
  const ifMod = g('if-modified-since');
  if (ifMatch && !etagIn(ifMatch)) return { kind: 'precondition_failed', detail: { Condition: prefix ? 'x-amz-copy-source-If-Match' : 'If-Match' } };
  if (!ifMatch && ifUnmod && modified > Math.floor(Date.parse(ifUnmod) / 1000)) return { kind: 'precondition_failed', detail: { Condition: 'If-Unmodified-Since' } };
  const read = ctx.req.method === 'GET' || ctx.req.method === 'HEAD';
  if (ifNone && etagIn(ifNone)) return read && !prefix ? { kind: 'not_modified' } : { kind: 'precondition_failed', detail: { Condition: 'If-None-Match' } };
  if (!ifNone && ifMod && modified <= Math.floor(Date.parse(ifMod) / 1000)) return read && !prefix ? { kind: 'not_modified' } : { kind: 'precondition_failed', detail: { Condition: 'If-Modified-Since' } };
  return null;
}

export interface UploadBody {
  stream: Readable;
  algos: ChecksumAlgo[];
  sha256: boolean;
  /** Called after the bytes were written: digest checks (Content-MD5, x-amz-checksum-* header or trailer, hex SHA-256, decoded length). */
  verify: (d: Digests) => StorageFault | null;
  checksumAlgo: ChecksumAlgo | null;
  /** Checksum values to store (computed). */
  pick: (d: Digests) => Partial<Record<ChecksumAlgo, string>>;
  encoding: string | null;
}

/**
 * Body of PutObject / UploadPart: aws-chunked decoding, requested checksums, digest verification.
 */
export function uploadBody(ctx: StorageCtx, auth: S3Auth, raw: Readable): UploadBody {
  const h = (n: string) => hdr(ctx, n);
  const sha = h('x-amz-content-sha256') ?? '';
  const chunked = isAwsChunked(ctx.req.headers);
  const trailerNames = (h('x-amz-trailer') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const headerAlgo = Object.keys(ctx.req.headers).map((k) => (k.startsWith('x-amz-checksum-') && k !== 'x-amz-checksum-algorithm' && k !== 'x-amz-checksum-type' && k !== 'x-amz-checksum-mode' ? parseAlgo(k) : null)).find(Boolean) ?? null;
  const trailerAlgo = trailerNames.map((t) => (t.startsWith('x-amz-checksum-') ? parseAlgo(t) : null)).find(Boolean) ?? null;
  const declaredAlgo = parseAlgo(h('x-amz-sdk-checksum-algorithm') ?? h('x-amz-checksum-algorithm'));
  const checksumAlgo = headerAlgo ?? trailerAlgo ?? declaredAlgo ?? null;
  const algos: ChecksumAlgo[] = checksumAlgo ? [checksumAlgo] : [];
  const sha256 = /^[0-9a-f]{64}$/i.test(sha);
  const contentMd5 = h('content-md5');
  if (contentMd5 !== undefined && !/^[A-Za-z0-9+/]{22}==$/.test(contentMd5)) throw fault('invalid_digest');
  let decoder: AwsChunkedDecoder | null = null;
  let stream = raw;
  if (chunked) {
    if (ctx.preset.quirks?.warnTrailingChecksum && trailerNames.length) ctx.warnings.push(`Trailing checksum (aws-chunked) upload: real ${ctx.preset.name} may need requestChecksumCalculation: "WHEN_REQUIRED" in the AWS SDK`);
    decoder = new AwsChunkedDecoder({ hashChunks: auth.verified === true && sha.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD') });
    stream = raw.pipe(decoder);
    raw.on('error', (e) => decoder!.destroy(e));
    ctx.resolved.encoding = 'aws-chunked';
  }
  const decodedLength = h('x-amz-decoded-content-length');
  const verify = (d: Digests): StorageFault | null => {
    if (decoder && decodedLength !== undefined && Number(decodedLength) !== d.size) return { kind: 'incomplete_body', reason: `x-amz-decoded-content-length ${decodedLength}, got ${d.size} bytes` };
    if (!decoder) {
      const cl = h('content-length');
      if (cl !== undefined && Number(cl) !== d.size) return { kind: 'incomplete_body', reason: `Content-Length ${cl}, got ${d.size} bytes` };
    }
    if (contentMd5 !== undefined && Buffer.from(d.md5, 'hex').toString('base64') !== contentMd5) return { kind: 'bad_digest', message: 'The Content-MD5 you specified did not match what we received.', detail: { ExpectedDigest: contentMd5, CalculatedDigest: Buffer.from(d.md5, 'hex').toString('base64') } };
    if (sha256 && d.sha256Hex && d.sha256Hex !== sha.toLowerCase()) return { kind: 'sha256_mismatch', detail: { ClientComputedContentSHA256: sha, S3ComputedContentSHA256: d.sha256Hex } };
    if (checksumAlgo) {
      const expected = h(`x-amz-checksum-${checksumAlgo}`) ?? decoder?.trailers[`x-amz-checksum-${checksumAlgo}`];
      const got = d.checksums[checksumAlgo];
      ctx.resolved.checksum = { algo: checksumAlgo, ok: expected === undefined ? null : expected === got, source: h(`x-amz-checksum-${checksumAlgo}`) ? 'header' : expected ? 'trailer' : 'computed' };
      if (expected !== undefined && expected !== got) return { kind: 'bad_digest', message: `Value for x-amz-checksum-${checksumAlgo} trailing header is invalid.`, code: 'BadDigest', reason: `x-amz-checksum-${checksumAlgo}: expected ${expected}, computed ${got}` };
    }
    if (decoder && auth.verified === true && auth.key && sha.startsWith('STREAMING-AWS4-HMAC-SHA256-PAYLOAD')) {
      if (!verifyChunkSignatures(auth, auth.key, decoder.chunks)) {
        const msg = 'aws-chunked chunk signatures do not verify';
        if (ctx.strict || ctx.instance.config.verifySignatures === true) return { kind: 'bad_signature', reason: msg };
        ctx.warnings.push(msg);
      }
    }
    return null;
  };
  return {
    stream,
    algos,
    sha256,
    verify,
    checksumAlgo,
    pick: (d) => (checksumAlgo && d.checksums[checksumAlgo] ? { [checksumAlgo]: d.checksums[checksumAlgo] } : {}),
    encoding: storedEncoding(h('content-encoding')),
  };
}

/** "/bucket/key?versionId=…" (URL-encoded) → bucket + key. */
export function parseCopySource(v: string): { bucket: string; key: string } | null {
  let s = v.split('?')[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    return null;
  }
  s = s.replace(/^\/+/, '');
  const i = s.indexOf('/');
  if (i <= 0 || i === s.length - 1) return null;
  return { bucket: s.slice(0, i), key: s.slice(i + 1) };
}
