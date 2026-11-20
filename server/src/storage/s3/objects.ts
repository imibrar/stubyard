import type { StorageBucket } from '../../repos/storage.js';
import { fault, type StorageCtx, type StorageEffects } from '../types.js';
import { el, xmlDoc } from '../xml.js';
import { checkAnonymous, type S3Auth } from './auth.js';
import { checkConditions, hdr, objectHeaders, parseCopySource, parseRange, storedHeaders, uploadBody, userMetadata, xmlDate } from './common.js';

export const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/';

export function aclOf(ctx: StorageCtx): string | null {
  const acl = hdr(ctx, 'x-amz-acl') ?? null;
  if (acl && ctx.preset.quirks?.ignoreAcl) {
    ctx.warnings.push(`${ctx.preset.name} ignores x-amz-acl ("${acl}"): make the bucket public instead`);
    return null;
  }
  return acl;
}

/** Byte limit for this upload: entity_too_large{maxBytes} scenario, else the instance / global limit. */
function maxBytesFor(ctx: StorageCtx, e: StorageEffects | null): number | undefined {
  if (e?.action === 'entity_too_large' && e.params.maxBytes !== undefined) return Number(e.params.maxBytes);
  return undefined;
}

function precheckLength(ctx: StorageCtx, e: StorageEffects | null): void {
  const declared = Number(hdr(ctx, 'x-amz-decoded-content-length') ?? hdr(ctx, 'content-length') ?? NaN);
  const limit = maxBytesFor(ctx, e) ?? ctx.hub.storage.maxObjectBytes(ctx.instance);
  if (Number.isFinite(declared) && declared > limit) throw fault('entity_too_large', undefined, { detail: { ProposedSize: String(declared), MaxSizeAllowed: String(limit) }, reason: `object limit ${limit} bytes` });
  if (Number.isFinite(declared)) {
    const left = ctx.hub.storage.limits(ctx.instance).remaining();
    if (declared > left) throw fault('quota_exceeded', 'Storage quota exceeded', { reason: ctx.hub.storage.limits(ctx.instance).quotaReason() });
  }
  if (hdr(ctx, 'content-length') === undefined && !/chunked/i.test(hdr(ctx, 'transfer-encoding') ?? '')) throw fault('missing_content_length');
}

export async function putObject(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string, e: StorageEffects | null) {
  checkAnonymous(ctx, auth, false, true);
  precheckLength(ctx, e);
  if (hdr(ctx, 'if-match')) {
    const cur = ctx.store.head(bucket, key);
    if (!cur || checkConditions(ctx, cur)) throw fault(cur ? 'precondition_failed' : 'no_such_key', undefined, { detail: { Condition: 'If-Match' } });
  }
  const body = uploadBody(ctx, auth, ctx.body(e));
  const obj = await ctx.store.put(bucket, key, body.stream, {
    contentType: hdr(ctx, 'content-type') ?? 'binary/octet-stream',
    headers: storedHeaders(ctx),
    metadata: userMetadata(ctx.req.headers),
    acl: aclOf(ctx),
    algos: body.algos,
    sha256: body.sha256,
    verify: body.verify,
    ifNoneMatch: hdr(ctx, 'if-none-match') === '*',
    source: 'api',
    runId: ctx.explicitRun?.id ?? null,
    logId: ctx.req.trafficLogId ?? null,
    maxBytes: maxBytesFor(ctx, e),
  });
  ctx.noteRequestSize(obj.size);
  Object.assign(ctx.resolved, { objectId: obj.id, etag: obj.etag, contentType: obj.contentType });
  ctx.changed({ bucket: bucket.name, key, put: true });
  const h: Record<string, string> = { etag: obj.etag };
  for (const [k, v] of Object.entries(obj.checksums)) if (k !== 'type') h[`x-amz-checksum-${k}`] = v;
  if (body.checksumAlgo) h['x-amz-checksum-type'] = 'FULL_OBJECT';
  for (const [k, v] of Object.entries(h)) ctx.reply.header(k, v);
  return ctx.reply.status(200).send();
}

export async function getObject(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string, e: StorageEffects | null, head: boolean) {
  const o = ctx.store.head(bucket, key);
  if (!o) throw fault('no_such_key', undefined, { detail: { Key: key } });
  checkAnonymous(ctx, auth, bucket.public || o.acl === 'public-read' || o.acl === 'public-read-write', false);
  const cond = checkConditions(ctx, o);
  if (cond) {
    if (cond.kind === 'not_modified') {
      ctx.reply.header('etag', o.etag).header('last-modified', new Date(o.updatedAt).toUTCString());
      return ctx.reply.status(304).send();
    }
    throw fault(cond.kind, undefined, { detail: cond.detail });
  }
  if (ctx.query.has('partNumber')) ctx.warnings.push('GET with partNumber is not supported by stubyard: the whole object is returned');
  const range = parseRange(hdr(ctx, 'range'), o.size);
  if (range === 'invalid') throw fault('invalid_range', undefined, { detail: { RangeRequested: String(hdr(ctx, 'range')), ActualObjectSize: String(o.size) }, headers: { 'content-range': `bytes */${o.size}` } });
  if (hdr(ctx, 'range') && !range && /,/.test(hdr(ctx, 'range')!)) ctx.warnings.push('Multi-range request answered with the full object (like S3)');
  const h = objectHeaders(ctx, o);
  if (range) {
    // Checksums describe the whole object: not sent for partial responses.
    for (const k of Object.keys(h)) if (k.startsWith('x-amz-checksum-')) delete h[k];
  }
  for (const [k, v] of Object.entries(h)) ctx.reply.header(k, v);
  const len = range ? range.end - range.start + 1 : o.size;
  ctx.reply.header('content-length', String(len));
  if (range) ctx.reply.header('content-range', `bytes ${range.start}-${range.end}/${o.size}`);
  Object.assign(ctx.resolved, { objectId: o.id, etag: o.etag, size: o.size, contentType: o.contentType, ...(range ? { range: `${range.start}-${range.end}` } : {}) });
  ctx.reply.status(range ? 206 : 200);
  if (head || ctx.req.method === 'HEAD') return ctx.reply.send();
  return ctx.sendBody(ctx.store.open(o, range), len, e);
}

export function deleteObject(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string) {
  checkAnonymous(ctx, auth, false, true);
  const existed = ctx.store.remove(bucket, key);
  ctx.resolved.deleted = existed;
  if (existed) ctx.changed({ bucket: bucket.name, key, deleted: true });
  return ctx.reply.status(204).send();
}

export async function copyObject(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket, key: string) {
  checkAnonymous(ctx, auth, false, true);
  const src = parseCopySource(hdr(ctx, 'x-amz-copy-source') ?? '');
  if (!src) throw fault('invalid_argument', 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey', { detail: { ArgumentName: 'x-amz-copy-source' } });
  const srcBucket = ctx.store.bucket(src.bucket);
  if (!srcBucket) throw fault('no_such_bucket', undefined, { detail: { BucketName: src.bucket } });
  const so = ctx.store.head(srcBucket, src.key);
  if (!so) throw fault('no_such_key', undefined, { detail: { Key: src.key } });
  const cond = checkConditions(ctx, so, 'x-amz-copy-source-');
  if (cond) throw fault('precondition_failed', undefined, { detail: cond.detail });
  const replace = (hdr(ctx, 'x-amz-metadata-directive') ?? 'COPY').toUpperCase() === 'REPLACE';
  if (srcBucket.id === bucket.id && src.key === key && !replace) throw fault('invalid_request', 'This copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata, storage class, website redirect location or encryption attributes.');
  const obj = await ctx.store.copy(so, bucket, key, {
    replaceMetadata: replace,
    contentType: hdr(ctx, 'content-type') ?? 'binary/octet-stream',
    headers: storedHeaders(ctx),
    metadata: userMetadata(ctx.req.headers),
    acl: aclOf(ctx) ?? (replace ? null : so.acl),
    source: 'api',
    runId: ctx.explicitRun?.id ?? null,
    logId: ctx.req.trafficLogId ?? null,
  });
  Object.assign(ctx.resolved, { objectId: obj.id, etag: obj.etag, size: obj.size, copySource: `${src.bucket}/${src.key}` });
  ctx.changed({ bucket: bucket.name, key, put: true });
  return ctx.reply
    .status(200)
    .type('application/xml')
    .send(xmlDoc(el('CopyObjectResult', el('LastModified', xmlDate(obj.updatedAt)), el('ETag', obj.etag), ...Object.entries(obj.checksums).filter(([k]) => k !== 'type').map(([k, v]) => el(`Checksum${k.toUpperCase()}`, v))), S3_NS));
}

/** POST ?delete with <Delete><Object><Key>…</Key></Object>…<Quiet>true</Quiet></Delete>. */
export async function deleteObjects(ctx: StorageCtx, auth: S3Auth, bucket: StorageBucket) {
  checkAnonymous(ctx, auth, false, true);
  const { parseXml, children, text } = await import('../xml.js');
  const buf = await ctx.readSmall(2 * 1024 * 1024);
  let doc;
  try {
    doc = parseXml(buf.toString('utf8'));
  } catch {
    throw fault('malformed_xml');
  }
  const objs = children(doc, 'Object');
  if (objs.length > 1000) throw fault('malformed_xml', 'The request must contain no more than 1000 keys');
  const quiet = text(doc, 'Quiet') === 'true';
  const deleted: string[] = [];
  for (const o of objs) {
    const k = text(o, 'Key');
    if (k === undefined) continue;
    ctx.store.remove(bucket, k);
    deleted.push(k);
  }
  ctx.resolved.keys = deleted.length;
  if (deleted.length) ctx.changed({ bucket: bucket.name, deleted: deleted.length });
  return ctx.reply
    .status(200)
    .type('application/xml')
    .send(xmlDoc(el('DeleteResult', quiet ? null : deleted.map((k) => el('Deleted', el('Key', k)))), S3_NS));
}

export function objectAcl(ctx: StorageCtx, bucket: StorageBucket, key: string, put: boolean) {
  const o = ctx.store.head(bucket, key);
  if (!o) throw fault('no_such_key', undefined, { detail: { Key: key } });
  if (put) {
    const acl = aclOf(ctx);
    ctx.hub.storage.repo.updateObjectMeta(o, { acl: acl ?? 'private' });
    ctx.changed({ bucket: bucket.name, key, acl });
    return ctx.reply.status(200).send();
  }
  return ctx.reply.type('application/xml').send(aclXml(o.acl === 'public-read' || bucket.public));
}

export function aclXml(publicRead: boolean): string {
  const owner = el('Owner', el('ID', 'stubyard'), el('DisplayName', 'stubyard'));
  const grant = (uri: string | null, perm: string) =>
    el('Grant', uri ? { name: 'Grantee', attrs: { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xsi:type': 'Group' }, children: [el('URI', uri)] } : { name: 'Grantee', attrs: { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xsi:type': 'CanonicalUser' }, children: [el('ID', 'stubyard'), el('DisplayName', 'stubyard')] }, el('Permission', perm));
  return xmlDoc(el('AccessControlPolicy', owner, el('AccessControlList', grant(null, 'FULL_CONTROL'), publicRead ? grant('http://acs.amazonaws.com/groups/global/AllUsers', 'READ') : null)), S3_NS);
}

