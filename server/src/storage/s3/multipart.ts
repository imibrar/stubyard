import type { StorageBucket, StorageUpload } from '../../repos/storage.js';
import { compositeChecksum, multipartEtag, parseAlgo } from '../checksums.js';
import { fault, type ChecksumAlgo, type StorageCtx, type StorageEffects } from '../types.js';
import { children, el, parseXml, text, xmlDoc } from '../xml.js';
import { tooLargeFault } from '../store.js';
import { checkAnonymous, type S3Auth } from './auth.js';
import { hdr, parseCopySource, parseRange, storedHeaders, uploadBody, userMetadata, xmlDate } from './common.js';
import { aclOf, S3_NS } from './objects.js';

const MIN_PART = 5 * 1024 * 1024;
const unq = (e: string) => e.replace(/^"|"$/g, '');

function requireUpload(ctx: StorageCtx, bucket: StorageBucket, key: string): StorageUpload {
  const id = ctx.query.get('uploadId') ?? '';
  const u = id ? ctx.store.uploads.get(id) : null;
  if (!u || u.bucketId !== bucket.id || u.key !== key || u.kind !== 's3-multipart') throw fault('no_such_upload', undefined, { detail: { UploadId: id } });
  ctx.resolved.uploadId = u.id;
  return u;
}

export function createMultipart(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string) {
  checkAnonymous(ctx, auth, false, true);
  const algo = parseAlgo(hdr(ctx, 'x-amz-checksum-algorithm'));
  const ctype = (hdr(ctx, 'x-amz-checksum-type') ?? '').toUpperCase();
  const checksumType = algo ? (ctype === 'FULL_OBJECT' ? 'FULL_OBJECT' : ctype === 'COMPOSITE' ? 'COMPOSITE' : algo.startsWith('crc64') ? 'FULL_OBJECT' : 'COMPOSITE') : null;
  const u = ctx.store.uploads.create(bucket, 's3-multipart', key, {
    contentType: hdr(ctx, 'content-type') ?? 'binary/octet-stream',
    headers: storedHeaders(ctx),
    metadata: userMetadata(ctx.req.headers),
    state: { acl: aclOf(ctx), algo, checksumType },
    runId: ctx.explicitRun?.id ?? null,
  });
  ctx.resolved.uploadId = u.id;
  ctx.changed({ bucket: bucket.name, key, upload: u.id });
  if (algo) ctx.reply.header('x-amz-checksum-algorithm', algo.toUpperCase()).header('x-amz-checksum-type', checksumType!);
  return ctx.reply.type('application/xml').send(xmlDoc(el('InitiateMultipartUploadResult', el('Bucket', bucket.name), el('Key', key), el('UploadId', u.id)), S3_NS));
}

function partNumber(ctx: StorageCtx): number {
  const n = Number(ctx.query.get('partNumber'));
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw fault('invalid_argument', 'Part number must be an integer between 1 and 10000, inclusive', { detail: { ArgumentName: 'partNumber', ArgumentValue: String(ctx.query.get('partNumber')) } });
  ctx.resolved.partNumber = n;
  return n;
}

export async function uploadPart(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string, e: StorageEffects | null) {
  checkAnonymous(ctx, auth, false, true);
  const u = requireUpload(ctx, bucket, key);
  const n = partNumber(ctx);
  const declared = Number(hdr(ctx, 'x-amz-decoded-content-length') ?? hdr(ctx, 'content-length') ?? NaN);
  const max = e?.action === 'entity_too_large' && e.params.maxBytes !== undefined ? Number(e.params.maxBytes) : 5 * 1024 * 1024 * 1024;
  if (Number.isFinite(declared) && declared > max) throw tooLargeFault(max, declared);
  const body = uploadBody(ctx, auth, ctx.body(e));
  const p = await ctx.store.uploads.putPart(u, String(n), body.stream, { algos: body.algos, sha256: body.sha256, verify: body.verify, maxBytes: max });
  ctx.noteRequestSize(p.size);
  ctx.reply.header('etag', p.etag);
  for (const [k, v] of Object.entries(p.checksums)) ctx.reply.header(`x-amz-checksum-${k}`, v);
  return ctx.reply.status(200).send();
}

export async function uploadPartCopy(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string) {
  checkAnonymous(ctx, auth, false, true);
  const u = requireUpload(ctx, bucket, key);
  const n = partNumber(ctx);
  const src = parseCopySource(hdr(ctx, 'x-amz-copy-source') ?? '');
  if (!src) throw fault('invalid_argument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey');
  const sb = ctx.store.bucket(src.bucket);
  if (!sb) throw fault('no_such_bucket', undefined, { detail: { BucketName: src.bucket } });
  const so = ctx.store.head(sb, src.key);
  if (!so) throw fault('no_such_key', undefined, { detail: { Key: src.key } });
  const rh = hdr(ctx, 'x-amz-copy-source-range');
  const range = rh ? parseRange(rh, so.size) : null;
  if (range === 'invalid') throw fault('invalid_argument', 'The x-amz-copy-source-range value must be of the form bytes=first-last where first and last are the zero-based offsets of the first and last bytes to copy');
  const p = await ctx.store.uploads.copyPart(u, String(n), so, range);
  return ctx.reply.type('application/xml').send(xmlDoc(el('CopyPartResult', el('LastModified', xmlDate(new Date().toISOString())), el('ETag', p.etag)), S3_NS));
}

export function listParts(ctx: StorageCtx, bucket: StorageBucket, key: string) {
  const u = requireUpload(ctx, bucket, key);
  const after = Number(ctx.query.get('part-number-marker') ?? 0);
  const max = Math.min(Number(ctx.query.get('max-parts') ?? 1000) || 1000, 1000);
  const all = ctx.store.uploads.parts(u).filter((p) => Number(p.partId) > after);
  const page = all.slice(0, max);
  return ctx.reply.type('application/xml').send(
    xmlDoc(
      el(
        'ListPartsResult',
        el('Bucket', bucket.name),
        el('Key', key),
        el('UploadId', u.id),
        el('PartNumberMarker', after),
        page.length ? el('NextPartNumberMarker', page[page.length - 1].partId) : null,
        el('MaxParts', max),
        el('IsTruncated', all.length > max),
        u.state.algo ? el('ChecksumAlgorithm', String(u.state.algo).toUpperCase()) : null,
        page.map((p) => el('Part', el('PartNumber', p.partId), el('LastModified', xmlDate(p.createdAt)), el('ETag', p.etag), el('Size', p.size), ...Object.entries(p.checksums).map(([k, v]) => el(`Checksum${k.toUpperCase()}`, v)))),
        el('Initiator', el('ID', 'stubyard'), el('DisplayName', 'stubyard')),
        el('Owner', el('ID', 'stubyard'), el('DisplayName', 'stubyard')),
        el('StorageClass', 'STANDARD'),
      ),
      S3_NS,
    ),
  );
}

export async function completeMultipart(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string, e: StorageEffects | null) {
  checkAnonymous(ctx, auth, false, true);
  const u = requireUpload(ctx, bucket, key);
  const buf = await ctx.readSmall(2 * 1024 * 1024);
  if (e?.action === 'complete_error_200') {
    // The classic S3 trap: HTTP 200 whose body is an <Error>. SDKs must inspect the body.
    ctx.req.trafficOutcome = 'forced_error';
    return ctx.reply
      .status(200)
      .type('application/xml')
      .send(xmlDoc(el('Error', el('Code', 'InternalError'), el('Message', 'We encountered an internal error. Please try again.'), el('RequestId', ctx.requestId), el('HostId', 'stubyard'))));
  }
  let list: { n: number; etag: string; checksums: Record<string, string> }[];
  try {
    const doc = parseXml(buf.toString('utf8'));
    list = children(doc, 'Part').map((p) => ({
      n: Number(text(p, 'PartNumber')),
      etag: unq(text(p, 'ETag') ?? ''),
      checksums: Object.fromEntries(p.children.filter((c) => c.name.startsWith('Checksum')).map((c) => [c.name.slice(8).toLowerCase(), c.text])),
    }));
  } catch {
    throw fault('malformed_xml');
  }
  if (!list.length) throw fault('malformed_xml', 'The XML you provided was not well-formed or did not validate against our published schema');
  for (let i = 1; i < list.length; i++) if (!(list[i].n > list[i - 1].n)) throw fault('invalid_part_order');
  const stored = new Map(ctx.store.uploads.parts(u).map((p) => [Number(p.partId), p]));
  const used = list.map((l) => {
    const p = stored.get(l.n);
    if (!p || unq(p.etag) !== l.etag) throw fault('invalid_part', undefined, { detail: { UploadId: u.id, PartNumber: String(l.n), ETag: l.etag } });
    return p;
  });
  for (let i = 0; i < used.length - 1; i++) {
    if (used[i].size < MIN_PART) {
      const msg = `Part ${list[i].n} is ${used[i].size} bytes; real S3 requires at least 5 MiB for every part but the last (EntityTooSmall)`;
      if (ctx.strict) throw fault('entity_too_small', undefined, { detail: { ProposedSize: String(used[i].size), MinSizeAllowed: String(MIN_PART), PartNumber: String(list[i].n), ETag: list[i].etag } });
      ctx.warnings.push(msg);
      break;
    }
  }
  const algo = (u.state.algo as ChecksumAlgo | null) ?? null;
  const type = (u.state.checksumType as 'FULL_OBJECT' | 'COMPOSITE' | null) ?? null;
  const etag = multipartEtag(used.map((p) => p.md5));
  const checksums: Partial<Record<ChecksumAlgo, string>> = {};
  if (algo && type === 'COMPOSITE' && used.every((p) => p.checksums[algo])) checksums[algo] = compositeChecksum(algo, used.map((p) => p.checksums[algo]!));
  const expectFull = algo && type === 'FULL_OBJECT' ? hdr(ctx, `x-amz-checksum-${algo}`) : undefined;
  const obj = await ctx.store.uploads.complete(
    u,
    used.map((p) => p.partId),
    {
      contentType: u.contentType,
      headers: u.headers,
      metadata: u.metadata,
      acl: (u.state.acl as string | null) ?? null,
      etag,
      parts: used.length,
      algos: algo && type === 'FULL_OBJECT' ? [algo] : [],
      checksums,
      checksumType: algo ? (type ?? 'COMPOSITE') : undefined,
      verify: (d) => (expectFull && algo && d.checksums[algo] !== expectFull ? { kind: 'bad_digest', reason: `full-object ${algo}: expected ${expectFull}, computed ${d.checksums[algo]}` } : null),
      source: 'api',
      runId: u.runId ?? ctx.explicitRun?.id ?? null,
      logId: ctx.req.trafficLogId ?? null,
    },
  );
  Object.assign(ctx.resolved, { objectId: obj.id, etag: obj.etag, size: obj.size, parts: used.length, contentType: obj.contentType });
  ctx.changed({ bucket: bucket.name, key, put: true });
  const location = `${ctx.bases.request}/${bucket.name}/${key.split('/').map(encodeURIComponent).join('/')}`;
  return ctx.reply.type('application/xml').send(
    xmlDoc(
      el(
        'CompleteMultipartUploadResult',
        el('Location', location),
        el('Bucket', bucket.name),
        el('Key', key),
        el('ETag', obj.etag),
        ...Object.entries(obj.checksums)
          .filter(([k]) => k !== 'type')
          .map(([k, v]) => el(`Checksum${k.toUpperCase()}`, v)),
        algo ? el('ChecksumType', obj.checksums.type ?? 'COMPOSITE') : null,
      ),
      S3_NS,
    ),
  );
}

export function abortMultipart(ctx: StorageCtx, bucket: StorageBucket, key: string) {
  const u = requireUpload(ctx, bucket, key);
  ctx.store.uploads.abort(u);
  ctx.changed({ bucket: bucket.name, key, aborted: u.id });
  return ctx.reply.status(204).send();
}
