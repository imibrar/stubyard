import { safeDecode, StorageService } from '../service.js';
import { fault, type StorageCtx, type StorageOp } from '../types.js';
import { authenticate } from './auth.js';
import { bucketAcl, bucketCors, createBucket, deleteBucket, getLocation, getVersioning, headBucket, listBuckets } from './buckets.js';
import { hdr } from './common.js';
import { listMultipartUploads, listObjects, listObjectVersions } from './list.js';
import { abortMultipart, completeMultipart, createMultipart, listParts, uploadPart, uploadPartCopy } from './multipart.js';
import { copyObject, deleteObject, deleteObjects, getObject, objectAcl, putObject } from './objects.js';
import { postObject } from './post-policy.js';

/** Bucket sub-resources we answer; anything else is 501 NotImplemented (versioning, lifecycle, policy, tagging…). */
const UNSUPPORTED = ['policy', 'lifecycle', 'tagging', 'website', 'encryption', 'replication', 'notification', 'logging', 'object-lock', 'ownershipControls', 'publicAccessBlock', 'requestPayment', 'accelerate', 'analytics', 'inventory', 'metrics', 'intelligent-tiering', 'retention', 'legal-hold', 'restore', 'select', 'torrent', 'attributes'];

interface Classified {
  group: StorageOp;
  name: string;
}

function classify(ctx: StorageCtx, bucket: string, key: string): Classified {
  const m = ctx.req.method;
  const q = ctx.query;
  const has = (k: string) => q.has(k);
  if (!bucket) return m === 'GET' || m === 'HEAD' ? { group: 'bucket', name: 'ListBuckets' } : { group: 'bucket', name: 'MethodNotAllowed' };
  const unsupported = UNSUPPORTED.find((k) => has(k));
  if (unsupported) return { group: key ? 'any' : 'bucket', name: `NotImplemented:${unsupported}` };
  if (!key) {
    if (has('cors')) return { group: 'bucket', name: m === 'PUT' ? 'PutBucketCors' : m === 'DELETE' ? 'DeleteBucketCors' : 'GetBucketCors' };
    if (has('acl')) return { group: 'bucket', name: m === 'PUT' ? 'PutBucketAcl' : 'GetBucketAcl' };
    if (has('versioning')) return { group: 'bucket', name: m === 'PUT' ? 'NotImplemented:versioning' : 'GetBucketVersioning' };
    if (has('location')) return { group: 'bucket', name: 'GetBucketLocation' };
    switch (m) {
      case 'PUT':
        return { group: 'bucket', name: 'CreateBucket' };
      case 'HEAD':
        return { group: 'bucket', name: 'HeadBucket' };
      case 'DELETE':
        return { group: 'bucket', name: 'DeleteBucket' };
      case 'GET':
        if (has('uploads')) return { group: 'list', name: 'ListMultipartUploads' };
        if (has('versions')) return { group: 'list', name: 'ListObjectVersions' };
        return { group: 'list', name: q.get('list-type') === '2' ? 'ListObjectsV2' : 'ListObjects' };
      case 'POST':
        if (has('delete')) return { group: 'delete', name: 'DeleteObjects' };
        if (/multipart\/form-data/i.test(hdr(ctx, 'content-type') ?? '')) return { group: 'put', name: 'PostObject' };
        return { group: 'bucket', name: 'MethodNotAllowed' };
    }
    return { group: 'bucket', name: 'MethodNotAllowed' };
  }
  switch (m) {
    case 'PUT':
      if (has('acl')) return { group: 'put', name: 'PutObjectAcl' };
      if (has('partNumber') && has('uploadId')) return hdr(ctx, 'x-amz-copy-source') ? { group: 'copy', name: 'UploadPartCopy' } : { group: 'multipart', name: 'UploadPart' };
      if (hdr(ctx, 'x-amz-copy-source')) return { group: 'copy', name: 'CopyObject' };
      return { group: 'put', name: 'PutObject' };
    case 'GET':
      if (has('uploadId')) return { group: 'multipart', name: 'ListParts' };
      if (has('acl')) return { group: 'get', name: 'GetObjectAcl' };
      return { group: 'get', name: 'GetObject' };
    case 'HEAD':
      return { group: 'head', name: 'HeadObject' };
    case 'DELETE':
      if (has('uploadId')) return { group: 'multipart', name: 'AbortMultipartUpload' };
      return { group: 'delete', name: 'DeleteObject' };
    case 'POST':
      if (has('uploads')) return { group: 'multipart', name: 'CreateMultipartUpload' };
      if (has('uploadId')) return { group: 'multipart', name: 'CompleteMultipartUpload' };
      if (has('restore') || has('select')) return { group: 'any', name: 'NotImplemented:restore' };
      return { group: 'any', name: 'MethodNotAllowed' };
  }
  return { group: 'any', name: 'MethodNotAllowed' };
}

/** S3 engine entry point: classify → auth → rules → operation. */
export async function handleS3(ctx: StorageCtx): Promise<unknown> {
  const segs = ctx.path.split('/');
  const bucketName = safeDecode(segs[1] ?? '');
  const rawKey = segs.slice(2).join('/');
  const key = rawKey ? safeDecode(rawKey) : '';
  if (key.length > 1024) throw fault('invalid_argument', 'Your key is too long', { code: 'KeyTooLongError', status: 400 });
  const op = classify(ctx, bucketName, key);
  ctx.setOp(op.group, op.name, { bucket: bucketName || undefined, key: key || undefined });

  const auth = authenticate(ctx);
  const bucket = bucketName ? ctx.store.bucket(bucketName) : null;
  const e = ctx.effects(bucket);
  if (await ctx.transport(e)) return ctx.reply;
  const ef = StorageService.effectFault(e, op.name);
  if (ef) {
    if (e?.action === 'not_found' && !key) ef.kind = 'no_such_bucket';
    if (e?.action === 'expired_url') ef.detail = { Expires: new Date(Date.now() - 60_000).toISOString(), ServerTime: new Date().toISOString() };
    return ctx.fail(ef);
  }

  if (op.name.startsWith('NotImplemented')) throw fault('not_implemented', `devhub does not simulate ${op.name.split(':')[1]} (see the storage docs: out of scope)`, { detail: { Header: op.name.split(':')[1] } });
  if (op.name === 'MethodNotAllowed') throw fault('method_not_allowed', undefined, { detail: { Method: ctx.req.method, ResourceType: key ? 'OBJECT' : 'BUCKET' }, headers: { allow: key ? 'GET, HEAD, PUT, DELETE, POST' : 'GET, HEAD, PUT, DELETE, POST' } });
  if (op.name === 'ListBuckets') return listBuckets(ctx);
  if (op.name === 'CreateBucket') return createBucket(ctx, bucketName);

  // Writes may create the bucket on the fly (autoCreateBuckets, default true) so apps need no setup step.
  const writes = ['PutObject', 'PostObject', 'CopyObject', 'CreateMultipartUpload'];
  const b = bucket ?? (writes.includes(op.name) ? ctx.store.bucketOrCreate(bucketName) : ctx.store.requireBucket(bucketName));
  if (!bucket && writes.includes(op.name)) {
    ctx.warnings.push(`Bucket "${bucketName}" did not exist and was created automatically (autoCreateBuckets); real ${ctx.preset.name} answers NoSuchBucket`);
    ctx.changed({ bucket: bucketName, created: true });
  }

  switch (op.name) {
    case 'HeadBucket':
      return headBucket(ctx, b);
    case 'DeleteBucket':
      return deleteBucket(ctx, b);
    case 'GetBucketLocation':
      return getLocation(ctx, b);
    case 'GetBucketVersioning':
      return getVersioning(ctx);
    case 'GetBucketAcl':
    case 'PutBucketAcl':
      return bucketAcl(ctx, b, op.name === 'PutBucketAcl');
    case 'GetBucketCors':
    case 'PutBucketCors':
    case 'DeleteBucketCors':
      return bucketCors(ctx, b, ctx.req.method);
    case 'ListObjectsV2':
    case 'ListObjects':
      return listObjects(ctx, auth, b, op.name === 'ListObjectsV2');
    case 'ListObjectVersions':
      return listObjectVersions(ctx, auth, b);
    case 'ListMultipartUploads':
      return listMultipartUploads(ctx, b);
    case 'DeleteObjects':
      return deleteObjects(ctx, auth, b);
    case 'PostObject':
      return postObject(ctx, b, e);
    case 'PutObject':
      return putObject(ctx, auth, b, key, e);
    case 'CopyObject':
      return copyObject(ctx, auth, b, key);
    case 'GetObject':
    case 'HeadObject':
      return getObject(ctx, auth, b, key, e, op.name === 'HeadObject');
    case 'DeleteObject':
      return deleteObject(ctx, auth, b, key);
    case 'GetObjectAcl':
    case 'PutObjectAcl':
      return objectAcl(ctx, b, key, op.name === 'PutObjectAcl');
    case 'CreateMultipartUpload':
      return createMultipart(ctx, auth, b, key);
    case 'UploadPart':
      return uploadPart(ctx, auth, b, key, e);
    case 'UploadPartCopy':
      return uploadPartCopy(ctx, auth, b, key);
    case 'ListParts':
      return listParts(ctx, b, key);
    case 'CompleteMultipartUpload':
      return completeMultipart(ctx, auth, b, key, e);
    case 'AbortMultipartUpload':
      return abortMultipart(ctx, b, key);
  }
  throw fault('not_implemented');
}
