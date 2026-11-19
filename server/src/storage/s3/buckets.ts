import { BUCKET_NAME_RE, type CorsRule, type StorageBucket } from '../../repos/storage.js';
import { fault, type StorageCtx } from '../types.js';
import { child, children, el, parseXml, text, xmlDoc } from '../xml.js';
import { xmlDate } from './common.js';
import { aclOf, aclXml, S3_NS } from './objects.js';

export function listBuckets(ctx: StorageCtx) {
  const buckets = ctx.hub.storage.repo.listBuckets(ctx.instance.id);
  return ctx.reply.type('application/xml').send(
    xmlDoc(
      el(
        'ListAllMyBucketsResult',
        el('Owner', el('ID', 'devhub'), el('DisplayName', 'devhub')),
        el(
          'Buckets',
          buckets.map((b) => el('Bucket', el('Name', b.name), el('CreationDate', xmlDate(b.createdAt)), el('BucketRegion', b.region ?? ctx.hub.storage.region(ctx.instance)))),
        ),
      ),
      S3_NS,
    ),
  );
}

export async function createBucket(ctx: StorageCtx, name: string) {
  if (!BUCKET_NAME_RE.test(name) || /\.\./.test(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name)) throw fault('invalid_bucket_name', undefined, { detail: { BucketName: name } });
  const buf = await ctx.readSmall(64 * 1024);
  let region: string | null = null;
  if (buf.length) {
    try {
      region = text(parseXml(buf.toString('utf8')), 'LocationConstraint') ?? null;
    } catch {
      throw fault('malformed_xml');
    }
  }
  const instRegion = ctx.hub.storage.region(ctx.instance);
  const existing = ctx.store.bucket(name);
  if (existing) {
    // us-east-1 answers 200 for a bucket you already own (legacy behaviour).
    if (instRegion === 'us-east-1' && ctx.preset.id === 's3') return ctx.reply.header('location', `/${name}`).status(200).send();
    throw fault('bucket_exists', undefined, { detail: { BucketName: name } });
  }
  const acl = aclOf(ctx);
  ctx.hub.storage.repo.createBucket(ctx.instance, { name, region: region || instRegion, public: acl === 'public-read' || acl === 'public-read-write' });
  ctx.changed({ bucket: name, created: true });
  return ctx.reply.header('location', `/${name}`).status(200).send();
}

export function headBucket(ctx: StorageCtx, b: StorageBucket) {
  return ctx.reply.header('x-amz-bucket-region', b.region ?? ctx.hub.storage.region(ctx.instance)).header('x-amz-access-point-alias', 'false').status(200).send();
}

export function deleteBucket(ctx: StorageCtx, b: StorageBucket) {
  if (ctx.hub.storage.repo.bucketStats(b.id).objects > 0) throw fault('bucket_not_empty', undefined, { detail: { BucketName: b.name } });
  ctx.hub.storage.repo.deleteBucket(b);
  ctx.changed({ bucket: b.name, deleted: true });
  return ctx.reply.status(204).send();
}

export function getLocation(ctx: StorageCtx, b: StorageBucket) {
  const r = b.region ?? ctx.hub.storage.region(ctx.instance);
  return ctx.reply.type('application/xml').send(xmlDoc(el('LocationConstraint', r === 'us-east-1' ? '' : r), S3_NS));
}

export function getVersioning(ctx: StorageCtx) {
  return ctx.reply.type('application/xml').send(xmlDoc(el('VersioningConfiguration'), S3_NS));
}

export function bucketAcl(ctx: StorageCtx, b: StorageBucket, put: boolean) {
  if (put) {
    const acl = aclOf(ctx);
    ctx.hub.storage.repo.updateBucket(b, { public: acl === 'public-read' || acl === 'public-read-write' });
    ctx.changed({ bucket: b.name, acl });
    return ctx.reply.status(200).send();
  }
  return ctx.reply.type('application/xml').send(aclXml(b.public));
}

export async function bucketCors(ctx: StorageCtx, b: StorageBucket, method: string) {
  const repo = ctx.hub.storage.repo;
  if (method === 'DELETE') {
    repo.updateBucket(b, { cors: { mode: 'permissive' } });
    ctx.changed({ bucket: b.name, cors: 'permissive' });
    return ctx.reply.status(204).send();
  }
  if (method === 'PUT') {
    const buf = await ctx.readSmall(64 * 1024);
    let rules: CorsRule[];
    try {
      const doc = parseXml(buf.toString('utf8'));
      rules = children(doc, 'CORSRule').map((r) => ({
        ID: text(r, 'ID'),
        AllowedOrigins: children(r, 'AllowedOrigin').map((x) => x.text),
        AllowedMethods: children(r, 'AllowedMethod').map((x) => x.text),
        AllowedHeaders: children(r, 'AllowedHeader').map((x) => x.text),
        ExposeHeaders: children(r, 'ExposeHeader').map((x) => x.text),
        MaxAgeSeconds: child(r, 'MaxAgeSeconds') ? Number(text(r, 'MaxAgeSeconds')) : undefined,
      }));
    } catch {
      throw fault('malformed_xml');
    }
    repo.updateBucket(b, { cors: { mode: 'rules', rules } });
    ctx.changed({ bucket: b.name, cors: 'rules' });
    return ctx.reply.status(200).send();
  }
  if (b.cors.mode !== 'rules' || !b.cors.rules?.length) throw fault('no_such_key', 'The CORS configuration does not exist', { code: 'NoSuchCORSConfiguration', status: 404, detail: { BucketName: b.name } });
  return ctx.reply.type('application/xml').send(
    xmlDoc(
      el(
        'CORSConfiguration',
        b.cors.rules.map((r) =>
          el(
            'CORSRule',
            r.ID ? el('ID', r.ID) : null,
            (r.AllowedHeaders ?? []).map((h) => el('AllowedHeader', h)),
            r.AllowedMethods.map((m) => el('AllowedMethod', m)),
            r.AllowedOrigins.map((o) => el('AllowedOrigin', o)),
            (r.ExposeHeaders ?? []).map((h) => el('ExposeHeader', h)),
            r.MaxAgeSeconds ? el('MaxAgeSeconds', r.MaxAgeSeconds) : null,
          ),
        ),
      ),
      S3_NS,
    ),
  );
}
