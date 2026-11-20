import type { StorageBucket } from '../../repos/storage.js';
import { fault, type StorageCtx } from '../types.js';
import { el, xmlDoc } from '../xml.js';
import { checkAnonymous, type S3Auth } from './auth.js';
import { xmlDate } from './common.js';
import { S3_NS } from './objects.js';

const owner = () => el('Owner', el('ID', 'stubyard'), el('DisplayName', 'stubyard'));
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

function maxKeys(ctx: StorageCtx, name = 'max-keys'): number {
  const v = ctx.query.get(name);
  if (v === null || v === '') return 1000;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fault('invalid_argument', `Provided ${name} not an integer or within integer range`, { detail: { ArgumentName: name, ArgumentValue: v } });
  return Math.min(n, 1000);
}

/** encoding-type=url (boto3 default): keys and prefixes URL-encoded (S3 keeps "/" readable). */
const encoder = (ctx: StorageCtx) => {
  const url = ctx.query.get('encoding-type') === 'url';
  return (s: string) => (url ? encodeURIComponent(s).replace(/%2F/g, '/') : s);
};

export function listObjects(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, v2: boolean) {
  checkAnonymous(ctx, auth, bucket.public, false);
  const q = ctx.query;
  const prefix = q.get('prefix') ?? '';
  const delimiter = q.get('delimiter') ?? '';
  const limit = maxKeys(ctx);
  const encType = q.get('encoding-type');
  if (encType && encType !== 'url') throw fault('invalid_argument', 'Invalid Encoding Method specified in Request', { detail: { ArgumentName: 'encoding-type', ArgumentValue: encType } });
  const enc = encoder(ctx);
  let after: string | undefined;
  const token = v2 ? q.get('continuation-token') : null;
  if (v2) {
    if (token) {
      try {
        after = unb64url(token);
      } catch {
        throw fault('invalid_argument', 'The continuation token provided is incorrect', { detail: { ArgumentName: 'continuation-token' } });
      }
    } else if (q.get('start-after')) after = q.get('start-after')!;
  } else if (q.get('marker')) after = q.get('marker')!;
  const r = ctx.store.list(bucket, { prefix, delimiter: delimiter || undefined, after, limit });
  const fetchOwner = !v2 || q.get('fetch-owner') === 'true';
  ctx.resolved.listed = r.objects.length + r.prefixes.length;
  const contents = r.objects.map((o) =>
    el('Contents', el('Key', enc(o.key)), el('LastModified', xmlDate(o.updatedAt)), el('ETag', o.etag), Object.keys(o.checksums).some((k) => k !== 'type') ? el('ChecksumAlgorithm', Object.keys(o.checksums).filter((k) => k !== 'type').map((k) => k.toUpperCase())[0]) : null, el('Size', o.size), fetchOwner ? owner() : null, el('StorageClass', 'STANDARD')),
  );
  const cps = r.prefixes.map((p) => el('CommonPrefixes', el('Prefix', enc(p))));
  const body = v2
    ? el(
        'ListBucketResult',
        el('Name', bucket.name),
        el('Prefix', enc(prefix)),
        q.get('start-after') ? el('StartAfter', enc(q.get('start-after')!)) : null,
        token ? el('ContinuationToken', token) : null,
        el('KeyCount', r.objects.length + r.prefixes.length),
        el('MaxKeys', limit),
        delimiter ? el('Delimiter', enc(delimiter)) : null,
        encType ? el('EncodingType', encType) : null,
        el('IsTruncated', r.truncated),
        r.truncated && r.last ? el('NextContinuationToken', b64url(r.last)) : null,
        contents,
        cps,
      )
    : el(
        'ListBucketResult',
        el('Name', bucket.name),
        el('Prefix', enc(prefix)),
        el('Marker', enc(q.get('marker') ?? '')),
        r.truncated && delimiter && r.last ? el('NextMarker', enc(r.last)) : null,
        el('MaxKeys', limit),
        delimiter ? el('Delimiter', enc(delimiter)) : null,
        encType ? el('EncodingType', encType) : null,
        el('IsTruncated', r.truncated),
        contents,
        cps,
      );
  return ctx.reply.type('application/xml').send(xmlDoc(body, S3_NS));
}

/** Every object as its single version "null" (versioning is not simulated). */
export function listObjectVersions(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket) {
  checkAnonymous(ctx, auth, bucket.public, false);
  const q = ctx.query;
  const prefix = q.get('prefix') ?? '';
  const delimiter = q.get('delimiter') ?? '';
  const limit = maxKeys(ctx);
  const enc = encoder(ctx);
  const r = ctx.store.list(bucket, { prefix, delimiter: delimiter || undefined, after: q.get('key-marker') ?? undefined, limit });
  return ctx.reply.type('application/xml').send(
    xmlDoc(
      el(
        'ListVersionsResult',
        el('Name', bucket.name),
        el('Prefix', enc(prefix)),
        el('KeyMarker', enc(q.get('key-marker') ?? '')),
        el('VersionIdMarker', ''),
        r.truncated && r.last ? [el('NextKeyMarker', enc(r.last)), el('NextVersionIdMarker', 'null')] : null,
        el('MaxKeys', limit),
        delimiter ? el('Delimiter', enc(delimiter)) : null,
        el('IsTruncated', r.truncated),
        r.objects.map((o) => el('Version', el('Key', enc(o.key)), el('VersionId', 'null'), el('IsLatest', true), el('LastModified', xmlDate(o.updatedAt)), el('ETag', o.etag), el('Size', o.size), owner(), el('StorageClass', 'STANDARD'))),
        r.prefixes.map((p) => el('CommonPrefixes', el('Prefix', enc(p)))),
      ),
      S3_NS,
    ),
  );
}

export function listMultipartUploads(ctx: StorageCtx, bucket: StorageBucket) {
  const prefix = ctx.query.get('prefix') ?? '';
  const ups = ctx.store.uploads.list(bucket).filter((u) => u.kind === 's3-multipart' && u.key.startsWith(prefix));
  const limit = Math.min(Number(ctx.query.get('max-uploads') ?? 1000) || 1000, 1000);
  const page = ups.slice(0, limit);
  return ctx.reply.type('application/xml').send(
    xmlDoc(
      el(
        'ListMultipartUploadsResult',
        el('Bucket', bucket.name),
        el('KeyMarker', ''),
        el('UploadIdMarker', ''),
        el('Prefix', prefix),
        el('MaxUploads', limit),
        el('IsTruncated', ups.length > limit),
        page.map((u) => el('Upload', el('Key', u.key), el('UploadId', u.id), el('Initiator', el('ID', 'stubyard'), el('DisplayName', 'stubyard')), owner(), el('StorageClass', 'STANDARD'), el('Initiated', xmlDate(u.createdAt)))),
      ),
      S3_NS,
    ),
  );
}
