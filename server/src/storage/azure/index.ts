/**
 * Azure Blob Storage (preset "azure"): path-style account URLs B/<account>/<container>/<blob> like Azurite, so an
 * Azurite connection string only needs BlobEndpoint changed. Containers, Put Blob, Put Block / Block List, Get / Head
 * (Range), properties and metadata, Delete, List Blobs, Copy (same instance), SAS tokens, XML errors.
 */
import crypto from 'node:crypto';
import type { StorageBucket, StorageObject, StorageUpload } from '../../repos/storage.js';
import { BUCKET_NAME_RE } from '../../repos/storage.js';
import { HttpError } from '../../util.js';
import { gate, HANDLED, header, laxOrThrow, maxBytesOf, noteObject, precheck, safe, sendObject, writableBucket } from '../provider-kit.js';
import { registerStorageProtocol } from '../service.js';
import { fault, type FaultKind, type InstanceView, type ProtocolError, type Snippet, type StorageCtx, type StorageEffects, type StorageFault, type StoragePreset, type StorageProtocol } from '../types.js';
import { el, elA, parseXml, xmlDoc } from '../xml.js';

export const AZURITE_ACCOUNT = 'devstoreaccount1';
export const AZURITE_KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const VERSION = '2025-11-05';

export const AZURE_PRESET: StoragePreset = {
  id: 'azure',
  name: 'Azure Blob Storage',
  protocol: 'azure',
  description: 'Azure Blob Storage (@azure/storage-blob, azure-storage-blob for Python, .NET…) with Azurite-style path URLs: block blobs, containers, SAS tokens.',
  region: 'local',
  credentials: [{ accessKeyId: AZURITE_ACCOUNT, secretAccessKey: AZURITE_KEY }],
  quotaError: { code: 'AccountLimitExceeded', status: 409 },
  quirks: { credentialLabels: ['account', 'account key'] },
  notes: ['Uses Azurite\'s well-known account devstoreaccount1 and key: an Azurite connection string only needs BlobEndpoint pointed at stubyard.', 'SharedKey signatures are accepted without checking; SAS expiry is always enforced, the SAS signature only in strict / verify mode.'],
  docsUrl: 'https://learn.microsoft.com/rest/api/storageservices/blob-service-rest-api',
};

const MAP: Partial<Record<FaultKind, [number, string, string]>> = {
  access_denied: [403, 'AuthorizationFailure', 'This request is not authorized to perform this operation.'],
  slow_down: [503, 'ServerBusy', 'The server is currently unable to receive requests. Please retry your request.'],
  internal_error: [500, 'InternalError', 'The server encountered an internal error. Please retry the request.'],
  quota_exceeded: [409, 'AccountLimitExceeded', 'The specified account is at its maximum capacity.'],
  entity_too_large: [413, 'RequestBodyTooLarge', 'The request body is too large and exceeds the maximum permissible limit.'],
  expired_url: [403, 'AuthenticationFailed', 'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.'],
  bad_signature: [403, 'AuthenticationFailed', 'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.'],
  checksum_mismatch: [400, 'Md5Mismatch', 'The MD5 value specified in the request did not match with the MD5 value calculated by the server.'],
  bad_digest: [400, 'Md5Mismatch', 'The MD5 value specified in the request did not match with the MD5 value calculated by the server.'],
  invalid_digest: [400, 'InvalidMd5', 'The MD5 value specified in the request is invalid.'],
  incomplete_body: [400, 'InvalidHeaderValue', 'The value for one of the HTTP headers is not in the correct format.'],
  not_found: [404, 'BlobNotFound', 'The specified blob does not exist.'],
  no_such_key: [404, 'BlobNotFound', 'The specified blob does not exist.'],
  no_such_bucket: [404, 'ContainerNotFound', 'The specified container does not exist.'],
  no_such_upload: [400, 'InvalidBlockList', 'The specified block list is invalid.'],
  invalid_part: [400, 'InvalidBlockList', 'The specified block list is invalid.'],
  bucket_exists: [409, 'ContainerAlreadyExists', 'The specified container already exists.'],
  bucket_not_empty: [409, 'ContainerBeingDeleted', 'The specified container is being deleted.'],
  invalid_bucket_name: [400, 'InvalidResourceName', 'The specified resource name contains invalid characters.'],
  precondition_failed: [412, 'ConditionNotMet', 'The condition specified using HTTP conditional header(s) is not met.'],
  not_modified: [304, 'ConditionNotMet', 'Not Modified'],
  invalid_range: [416, 'InvalidRange', 'The range specified is invalid for the current size of the resource.'],
  invalid_argument: [400, 'InvalidQueryParameterValue', 'Value for one of the query parameters specified in the request URI is invalid.'],
  invalid_request: [400, 'InvalidInput', 'One of the request inputs is not valid.'],
  malformed_xml: [400, 'InvalidXmlDocument', 'XML specified is not syntactically valid.'],
  missing_content_length: [411, 'MissingContentLengthHeader', 'Content-Length header value must be specified.'],
  unknown_access_key: [403, 'AuthenticationFailed', 'Server failed to authenticate the request.'],
  not_implemented: [501, 'NotImplemented', 'The requested operation is not implemented by stubyard.'],
  method_not_allowed: [405, 'UnsupportedHttpVerb', 'The resource doesn\'t support specified Http Verb.'],
  policy_violation: [403, 'AuthorizationPermissionMismatch', 'This request is not authorized to perform this operation using this permission.'],
  unknown_instance: [404, 'ResourceNotFound', 'The specified resource does not exist.'],
  timeout: [500, 'OperationTimedOut', 'The operation could not be completed within the permitted time.'],
  cors_blocked: [403, 'CorsPreflightFailure', 'CORS not enabled or no matching rule found for this request.'],
};

export function azureError(ctx: StorageCtx | null, f: StorageFault): ProtocolError {
  const [status, code0, message] = MAP[f.kind] ?? [500, 'InternalError', f.kind];
  const st = f.status ?? status;
  const code = f.code ?? code0;
  const headers: Record<string, string> = { 'x-ms-error-code': code };
  if (st === 304) return { status: 304, headers };
  const msg = `${f.message ?? message}\nRequestId:${ctx?.requestId ?? ''}\nTime:${new Date().toISOString()}`;
  return { status: st, headers, contentType: 'application/xml', body: xmlDoc(el('Error', el('Code', code), el('Message', msg), ...Object.entries(f.detail ?? {}).map(([k, v]) => el(k, v)))) };
}

// ---------------------------------------------------------------- helpers

const rfc1123 = (iso: string) => new Date(iso).toUTCString();
const bareEtag = (o: { etag: string }) => o.etag.replace(/"/g, '');
const newEtag = () => `"0x8D${crypto.randomBytes(7).toString('hex').toUpperCase().slice(0, 13)}"`;
const accountOf = (ctx: { instance: { config: Record<string, unknown> } }) => String(ctx.instance.config.accountName || AZURITE_ACCOUNT);
const accountKeyOf = (ctx: { instance: { config: Record<string, unknown> } }) => String(ctx.instance.config.accountKey || AZURITE_KEY);

const CONTENT_HEADERS: [string, string][] = [
  ['x-ms-blob-cache-control', 'cache-control'],
  ['x-ms-blob-content-disposition', 'content-disposition'],
  ['x-ms-blob-content-encoding', 'content-encoding'],
  ['x-ms-blob-content-language', 'content-language'],
];

function storedHeaders(ctx: StorageCtx): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [ms, n] of CONTENT_HEADERS) {
    const v = header(ctx, ms);
    if (v !== undefined) h[n] = v;
  }
  return h;
}

function userMetadata(ctx: StorageCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.req.headers)) if (k.startsWith('x-ms-meta-') && v !== undefined) out[k.slice(10)] = Array.isArray(v) ? v.join(',') : v;
  return out;
}

function blobHeaders(o: StorageObject): Record<string, string> {
  const h: Record<string, string> = {
    etag: o.etag,
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-creation-time': rfc1123(o.createdAt),
    'x-ms-lease-status': 'unlocked',
    'x-ms-lease-state': 'available',
    'x-ms-server-encrypted': 'true',
    'x-ms-access-tier': 'Hot',
    'x-ms-access-tier-inferred': 'true',
  };
  if (o.extra.contentMd5) h['content-md5'] = String(o.extra.contentMd5);
  for (const k of ['cache-control', 'content-disposition', 'content-encoding', 'content-language']) if (o.headers[k]) h[k] = o.headers[k];
  for (const [k, v] of Object.entries(o.metadata)) h[`x-ms-meta-${k}`] = v;
  return h;
}

/** If-Match / If-None-Match / If-(Un)Modified-Since on a blob. */
function conditions(ctx: StorageCtx, o: StorageObject | null, read: boolean): void {
  const im = header(ctx, 'if-match');
  const inm = header(ctx, 'if-none-match');
  const ims = header(ctx, 'if-modified-since');
  const ius = header(ctx, 'if-unmodified-since');
  const match = (list: string) => !!o && list.split(',').map((s) => s.trim()).some((e) => e === '*' || e === o.etag || `"${e}"` === o.etag);
  if (im && !match(im)) throw fault('precondition_failed');
  if (inm && (inm === '*' ? !!o : match(inm))) throw fault(read ? 'not_modified' : 'precondition_failed', inm === '*' && !read ? 'The specified blob already exists.' : undefined, inm === '*' && !read ? { code: 'BlobAlreadyExists', status: 409 } : {});
  if (o && ims && Date.parse(o.updatedAt) <= Date.parse(ims)) throw fault(read ? 'not_modified' : 'precondition_failed');
  if (o && ius && Date.parse(o.updatedAt) > Date.parse(ius) + 999) throw fault('precondition_failed');
}

// ---------------------------------------------------------------- SAS

const PERM_FOR: Record<string, string> = { read: 'r', write: 'wc', delete: 'd', list: 'l' };

function checkAuth(ctx: StorageCtx, need: keyof typeof PERM_FOR, container: string, blob: string): void {
  const q = ctx.query;
  const auth = header(ctx, 'authorization');
  if (!q.has('sig')) {
    const t = auth ? (/^SharedKey(Lite)?\s/i.test(auth) ? 'sharedkey' : /^Bearer\s/i.test(auth) ? 'bearer' : 'other') : 'anonymous';
    ctx.resolved.auth = { type: t, accessKeyId: t === 'sharedkey' ? auth!.split(/\s+/)[1]?.split(':')[0] : undefined, verified: null };
    if (t === 'anonymous') {
      const b = container ? ctx.store.bucket(container) : null;
      if (!(need === 'read' && b?.public)) laxOrThrow(ctx, { kind: 'access_denied', code: 'NoAuthenticationInformation', status: 401, message: 'Server failed to authenticate the request. Please refer to the information in the www-authenticate header.' }, 'Anonymous request: real Azure answers 401 NoAuthenticationInformation');
    }
    return;
  }
  const se = q.get('se');
  const st = q.get('st');
  const sp = q.get('sp') ?? '';
  const sv = q.get('sv') ?? '';
  ctx.resolved.auth = { type: q.has('ss') ? 'account-sas' : q.has('skoid') ? 'user-delegation-sas' : 'service-sas', expiresAt: se, permissions: sp, verified: null as boolean | null };
  if (!se || Number.isNaN(Date.parse(se))) throw fault('bad_signature', 'Server failed to authenticate the request.', { detail: { AuthenticationErrorDetail: 'se is mandatory. Cannot be empty' } });
  if (Date.parse(se) < Date.now()) throw fault('expired_url', undefined, { detail: { AuthenticationErrorDetail: `Signed expiry time [${new Date(se).toUTCString()}] has to be after current time [${new Date().toUTCString()}]` }, reason: 'SAS expired' });
  if (st && Date.parse(st) > Date.now() + 15 * 60_000) throw fault('bad_signature', undefined, { detail: { AuthenticationErrorDetail: `Signed start time [${new Date(st).toUTCString()}] is in the future` }, reason: 'SAS not yet valid' });
  const letters = PERM_FOR[need];
  if (![...letters].some((l) => sp.includes(l)) && !(need === 'write' && sp.includes('a'))) {
    laxOrThrow(ctx, { kind: 'policy_violation' }, `SAS permissions "${sp}" do not allow ${need} (needs ${letters.split('').join(' or ')})`);
  }
  const verifyMode = ctx.strict || ctx.instance.config.verifySignatures === true;
  if (!verifyMode || q.has('ss') || q.has('skoid')) return;
  const sr = q.get('sr') ?? '';
  const resource = `/blob/${accountOf(ctx)}/${container}${sr === 'c' ? '' : `/${blob}`}`;
  const g = (k: string) => q.get(k) ?? '';
  const fields = [sp, g('st'), se, resource, g('si'), g('sip'), g('spr'), sv, sr, g('snapshot') || g('versionid'), ...(sv >= '2020-12-06' ? [g('ses')] : []), g('rscc'), g('rscd'), g('rsce'), g('rscl'), g('rsct')];
  const sig = crypto.createHmac('sha256', Buffer.from(accountKeyOf(ctx), 'base64')).update(fields.join('\n'), 'utf8').digest('base64');
  const ok = sig === q.get('sig');
  (ctx.resolved.auth as Record<string, unknown>).verified = ok;
  if (!ok) throw fault('bad_signature', undefined, { detail: { AuthenticationErrorDetail: `Signature did not match. String to sign used was ${fields.join('\n')}` }, reason: 'SAS signature mismatch' });
}

export function signSas(o: { account: string; key: string; container: string; blob: string; permissions: string; expiresOn: Date }): string {
  const trunc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sv = '2025-11-05';
  const se = trunc(o.expiresOn);
  const fields = [o.permissions, '', se, `/blob/${o.account}/${o.container}/${o.blob}`, '', '', 'https,http', sv, 'b', '', '', '', '', '', '', ''];
  const sig = crypto.createHmac('sha256', Buffer.from(o.key, 'base64')).update(fields.join('\n'), 'utf8').digest('base64');
  return new URLSearchParams({ sv, spr: 'https,http', se, sr: 'b', sp: o.permissions, sig }).toString();
}

// ---------------------------------------------------------------- containers

function containersXml(ctx: StorageCtx) {
  const q = ctx.query;
  const prefix = q.get('prefix') ?? '';
  const max = Math.min(Number(q.get('maxresults') ?? 5000) || 5000, 5000);
  const marker = q.get('marker') ?? '';
  const all = ctx.hub.storage.repo.listBuckets(ctx.instance.id).filter((b) => b.name.startsWith(prefix) && b.name > marker).sort((a, b) => (a.name < b.name ? -1 : 1));
  const page = all.slice(0, max);
  const next = all.length > max ? page[page.length - 1].name : '';
  const meta = (q.get('include') ?? '').includes('metadata');
  return xmlDoc(
    elA(
      'EnumerationResults',
      { ServiceEndpoint: `${ctx.bases.request}/${accountOf(ctx)}/` },
      prefix ? el('Prefix', prefix) : null,
      marker ? el('Marker', marker) : null,
      q.has('maxresults') ? el('MaxResults', String(max)) : null,
      el(
        'Containers',
        page.map((b) =>
          el(
            'Container',
            el('Name', b.name),
            el('Properties', el('Last-Modified', rfc1123(b.createdAt)), el('Etag', '"0x8D0000000000000"'), el('LeaseStatus', 'unlocked'), el('LeaseState', 'available'), b.public ? el('PublicAccess', 'blob') : null, el('HasImmutabilityPolicy', 'false'), el('HasLegalHold', 'false')),
            meta ? el('Metadata') : null,
          ),
        ),
      ),
      el('NextMarker', next),
    ),
  );
}

async function containerOp(ctx: StorageCtx, name: string) {
  const m = ctx.req.method;
  const comp = ctx.query.get('comp');
  const repo = ctx.hub.storage.repo;
  if (comp === 'list') {
    ctx.setOp('list', 'ListBlobs', { bucket: name });
    checkAuth(ctx, 'list', name, '');
    const b = ctx.store.bucket(name);
    const e = await gate(ctx, b, false);
    if (e === HANDLED) return ctx.reply;
    if (!b) throw fault('no_such_bucket');
    return listBlobs(ctx, b);
  }
  if (comp === 'acl') {
    ctx.setOp('bucket', m === 'PUT' ? 'SetContainerAcl' : 'GetContainerAcl', { bucket: name });
    checkAuth(ctx, m === 'PUT' ? 'write' : 'read', name, '');
    const b = ctx.store.bucket(name);
    if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
    if (!b) throw fault('no_such_bucket');
    if (m === 'PUT') {
      await ctx.readSmall();
      const access = header(ctx, 'x-ms-blob-public-access');
      repo.updateBucket(b, { public: access === 'blob' || access === 'container' });
      ctx.changed({ bucket: name, public: !!access });
      return ctx.reply.status(200).header('etag', '"0x8D0000000000000"').header('last-modified', rfc1123(b.createdAt)).send();
    }
    if (b.public) ctx.reply.header('x-ms-blob-public-access', 'blob');
    return ctx.reply.type('application/xml').send(xmlDoc(el('SignedIdentifiers')));
  }
  if (comp === 'metadata') {
    ctx.setOp('bucket', 'SetContainerMetadata', { bucket: name });
    if (!ctx.store.bucket(name)) throw fault('no_such_bucket');
    return ctx.reply.status(200).send();
  }
  if (comp) {
    ctx.setOp('bucket', `NotImplemented:${comp}`, { bucket: name });
    throw fault('not_implemented', `stubyard does not simulate container comp=${comp} (leases, batch, etc.)`);
  }
  if (m === 'PUT') {
    ctx.setOp('bucket', 'CreateContainer', { bucket: name });
    checkAuth(ctx, 'write', name, '');
    if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
    if (!BUCKET_NAME_RE.test(name) || name.includes('_') || name.includes('.')) throw fault('invalid_bucket_name', 'The specified resource name contains invalid characters.');
    if (ctx.store.bucket(name)) throw fault('bucket_exists');
    const access = header(ctx, 'x-ms-blob-public-access');
    const b = repo.createBucket(ctx.instance, { name, public: access === 'blob' || access === 'container' });
    ctx.changed({ bucket: name, created: true });
    return ctx.reply.status(201).header('etag', '"0x8D0000000000000"').header('last-modified', rfc1123(b.createdAt)).send();
  }
  ctx.setOp('bucket', m === 'DELETE' ? 'DeleteContainer' : 'GetContainerProperties', { bucket: name });
  checkAuth(ctx, m === 'DELETE' ? 'delete' : 'read', name, '');
  const b = ctx.store.bucket(name);
  if ((await gate(ctx, b, false)) === HANDLED) return ctx.reply;
  if (!b) throw fault('no_such_bucket');
  if (m === 'DELETE') {
    // Azure deletes non-empty containers with their blobs.
    ctx.hub.storage.store(ctx.instance).empty(b);
    repo.deleteBucket(b);
    ctx.changed({ bucket: name, deleted: true });
    return ctx.reply.status(202).send();
  }
  if (m === 'GET' || m === 'HEAD') {
    ctx.reply.header('etag', '"0x8D0000000000000"').header('last-modified', rfc1123(b.createdAt)).header('x-ms-lease-status', 'unlocked').header('x-ms-lease-state', 'available').header('x-ms-has-immutability-policy', 'false').header('x-ms-has-legal-hold', 'false');
    if (b.public) ctx.reply.header('x-ms-blob-public-access', 'blob');
    return ctx.reply.status(200).send();
  }
  throw fault('method_not_allowed');
}

function listBlobs(ctx: StorageCtx, b: StorageBucket) {
  const q = ctx.query;
  const prefix = q.get('prefix') ?? '';
  const delimiter = q.get('delimiter') ?? undefined;
  const max = Math.min(Number(q.get('maxresults') ?? 5000) || 5000, 5000);
  const marker = q.get('marker') ?? '';
  const include = (q.get('include') ?? '').split(',');
  const out = ctx.store.list(b, { prefix, delimiter, after: marker ? Buffer.from(marker, 'base64url').toString('utf8') : undefined, limit: max });
  const blobXml = (o: StorageObject) =>
    el(
      'Blob',
      el('Name', o.key),
      el(
        'Properties',
        el('Creation-Time', rfc1123(o.createdAt)),
        el('Last-Modified', rfc1123(o.updatedAt)),
        el('Etag', bareEtag(o)),
        el('Content-Length', String(o.size)),
        el('Content-Type', o.contentType ?? 'application/octet-stream'),
        el('Content-Encoding', o.headers['content-encoding'] ?? ''),
        el('Content-Language', o.headers['content-language'] ?? ''),
        el('Content-CRC64', ''),
        el('Content-MD5', String(o.extra.contentMd5 ?? '')),
        el('Cache-Control', o.headers['cache-control'] ?? ''),
        el('Content-Disposition', o.headers['content-disposition'] ?? ''),
        el('BlobType', 'BlockBlob'),
        el('AccessTier', 'Hot'),
        el('AccessTierInferred', 'true'),
        el('LeaseStatus', 'unlocked'),
        el('LeaseState', 'available'),
        el('ServerEncrypted', 'true'),
      ),
      include.includes('metadata') ? el('Metadata', Object.entries(o.metadata).map(([k, v]) => el(k, v))) : null,
    );
  ctx.resolved.items = out.objects.length;
  const body = xmlDoc(
    elA(
      'EnumerationResults',
      { ServiceEndpoint: `${ctx.bases.request}/${accountOf(ctx)}/`, ContainerName: b.name },
      prefix ? el('Prefix', prefix) : null,
      marker ? el('Marker', marker) : null,
      q.has('maxresults') ? el('MaxResults', String(max)) : null,
      delimiter ? el('Delimiter', delimiter) : null,
      el('Blobs', ...out.objects.map(blobXml), ...out.prefixes.map((p) => el('BlobPrefix', el('Name', p)))),
      el('NextMarker', out.truncated && out.last ? Buffer.from(out.last).toString('base64url') : ''),
    ),
  );
  return ctx.reply.type('application/xml').send(body);
}

// ---------------------------------------------------------------- blobs

function blocksUpload(ctx: StorageCtx, b: StorageBucket, key: string, create: boolean): StorageUpload | null {
  const u = ctx.store.uploads.list(b).find((x) => x.kind === 'azure-blocks' && x.key === key) ?? null;
  if (u || !create) return u;
  return ctx.store.uploads.create(b, 'azure-blocks', key, { runId: ctx.explicitRun?.id ?? null });
}

async function putBlob(ctx: StorageCtx, b: StorageBucket, key: string, e: StorageEffects | null) {
  const type = header(ctx, 'x-ms-blob-type');
  if (type && type !== 'BlockBlob') throw fault('not_implemented', `stubyard simulates block blobs only (x-ms-blob-type: ${type})`, { code: 'FeatureNotSupported', status: 400 });
  conditions(ctx, ctx.store.head(b, key), false);
  precheck(ctx, e);
  const md5 = header(ctx, 'content-md5');
  const obj = await ctx.store.put(b, key, ctx.body(e), {
    contentType: header(ctx, 'x-ms-blob-content-type') ?? header(ctx, 'content-type') ?? 'application/octet-stream',
    headers: storedHeaders(ctx),
    metadata: userMetadata(ctx),
    etag: newEtag(),
    source: 'api',
    runId: ctx.explicitRun?.id ?? null,
    logId: ctx.req.trafficLogId ?? null,
    maxBytes: maxBytesOf(e),
    verify: (d) => {
      const got = Buffer.from(d.md5, 'hex').toString('base64');
      if (md5 && md5 !== got) return { kind: 'bad_digest', reason: `Content-MD5 ${md5}, computed ${got}` };
      return null;
    },
  });
  const contentMd5 = obj.md5 ? Buffer.from(obj.md5, 'hex').toString('base64') : undefined;
  const fin = ctx.hub.storage.repo.updateObjectMeta(obj, { extra: { ...obj.extra, blobType: 'BlockBlob', contentMd5: header(ctx, 'x-ms-blob-content-md5') ?? contentMd5 } });
  noteObject(ctx, b, fin, true);
  const old = blocksUpload(ctx, b, key, false);
  if (old) ctx.store.uploads.abort(old);
  return ctx.reply.status(201).header('etag', fin.etag).header('last-modified', rfc1123(fin.updatedAt)).header('content-md5', contentMd5 ?? '').header('x-ms-request-server-encrypted', 'true').send();
}

async function putBlock(ctx: StorageCtx, b: StorageBucket, key: string, e: StorageEffects | null) {
  const id = ctx.query.get('blockid') ?? '';
  if (!id || !/^[A-Za-z0-9+/=]+$/.test(id) || Buffer.from(id, 'base64').length > 64) throw fault('invalid_argument', 'The specifed block id is invalid.', { code: 'InvalidQueryParameterValue', detail: { QueryParameterName: 'blockid', QueryParameterValue: id } });
  precheck(ctx, e);
  const u = blocksUpload(ctx, b, key, true)!;
  ctx.resolved.uploadId = u.id;
  ctx.resolved.partNumber = id;
  const md5 = header(ctx, 'content-md5');
  const p = await ctx.store.uploads.putPart(u, id, ctx.body(e), {
    maxBytes: maxBytesOf(e) ?? 4000 * 1024 * 1024,
    verify: (d) => (md5 && md5 !== Buffer.from(d.md5, 'hex').toString('base64') ? { kind: 'bad_digest', reason: 'Content-MD5 mismatch on Put Block' } : null),
  });
  ctx.noteRequestSize(p.size);
  ctx.changed({ bucket: b.name, key, upload: u.id });
  return ctx.reply.status(201).header('content-md5', Buffer.from(p.md5, 'hex').toString('base64')).header('x-ms-request-server-encrypted', 'true').send();
}

async function putBlockList(ctx: StorageCtx, b: StorageBucket, key: string) {
  conditions(ctx, ctx.store.head(b, key), false);
  const buf = await ctx.readSmall(4 * 1024 * 1024);
  let doc;
  try {
    doc = parseXml(buf.toString('utf8'));
  } catch {
    throw fault('malformed_xml');
  }
  const ids = doc.children.filter((c) => ['Latest', 'Committed', 'Uncommitted'].includes(c.name)).map((c) => ({ kind: c.name, id: c.text.trim() }));
  const u = blocksUpload(ctx, b, key, false);
  const parts = u ? ctx.store.uploads.parts(u) : [];
  const have = new Map(parts.map((p) => [p.partId, p]));
  for (const x of ids) if (!have.has(x.id)) throw fault('invalid_part', `The specified block list is invalid (block ${x.id} was not uploaded; stubyard keeps only uncommitted blocks)`, { reason: `missing block ${x.id}` });
  if (!u || !ids.length) {
    if (ids.length) throw fault('invalid_part');
    // Empty block list: an empty blob.
    const { Readable } = await import('node:stream');
    const obj = await ctx.store.put(b, key, Readable.from([]), { contentType: header(ctx, 'x-ms-blob-content-type') ?? 'application/octet-stream', headers: storedHeaders(ctx), metadata: userMetadata(ctx), etag: newEtag(), runId: ctx.explicitRun?.id ?? null, logId: ctx.req.trafficLogId ?? null, extra: { blobType: 'BlockBlob', blocks: [] } });
    noteObject(ctx, b, obj, false);
    ctx.changed({ bucket: b.name, key, put: true });
    return ctx.reply.status(201).header('etag', obj.etag).header('last-modified', rfc1123(obj.updatedAt)).send();
  }
  ctx.resolved.uploadId = u.id;
  const blocks = ids.map((x) => ({ id: x.id, size: have.get(x.id)!.size }));
  const obj = await ctx.store.uploads.complete(
    u,
    ids.map((x) => x.id),
    {
      contentType: header(ctx, 'x-ms-blob-content-type') ?? 'application/octet-stream',
      headers: storedHeaders(ctx),
      metadata: userMetadata(ctx),
      etag: newEtag(),
      source: 'api',
      runId: u.runId ?? ctx.explicitRun?.id ?? null,
      logId: ctx.req.trafficLogId ?? null,
      extra: { blobType: 'BlockBlob', blocks, contentMd5: header(ctx, 'x-ms-blob-content-md5') },
    },
  );
  noteObject(ctx, b, obj, false);
  ctx.changed({ bucket: b.name, key, put: true });
  return ctx.reply.status(201).header('etag', obj.etag).header('last-modified', rfc1123(obj.updatedAt)).header('x-ms-request-server-encrypted', 'true').send();
}

function getBlockList(ctx: StorageCtx, b: StorageBucket, key: string) {
  const o = ctx.store.head(b, key);
  const u = blocksUpload(ctx, b, key, false);
  const type = (ctx.query.get('blocklisttype') ?? 'committed').toLowerCase();
  if (!o && !u) throw fault('no_such_key');
  const committed = ((o?.extra.blocks as { id: string; size: number }[] | undefined) ?? (o ? [{ id: Buffer.from('stubyard-whole-blob').toString('base64'), size: o.size }] : [])).map((x) => el('Block', el('Name', x.id), el('Size', String(x.size))));
  const uncommitted = (u ? ctx.store.uploads.parts(u) : []).map((p) => el('Block', el('Name', p.partId), el('Size', String(p.size))));
  if (o) ctx.reply.header('etag', o.etag).header('last-modified', rfc1123(o.updatedAt));
  ctx.reply.header('x-ms-blob-content-length', String(o?.size ?? 0));
  return ctx.reply.type('application/xml').send(xmlDoc(el('BlockList', type !== 'uncommitted' ? el('CommittedBlocks', committed) : null, type !== 'committed' ? el('UncommittedBlocks', uncommitted) : null)));
}

async function copyBlob(ctx: StorageCtx, b: StorageBucket, key: string) {
  const src = header(ctx, 'x-ms-copy-source') ?? '';
  let path: string;
  try {
    path = new URL(src).pathname;
  } catch {
    throw fault('invalid_argument', 'The value for x-ms-copy-source is not a valid URL', { code: 'InvalidHeaderValue' });
  }
  const marker = `/${accountOf(ctx)}/`;
  const i = path.indexOf(marker);
  if (i < 0) throw fault('not_implemented', 'stubyard copies only from the same instance (x-ms-copy-source must be a URL of this account)', { code: 'CannotVerifyCopySource', status: 404 });
  const rest = path.slice(i + marker.length).split('/').map(safe);
  const sb = ctx.store.bucket(rest[0]);
  const so = sb ? ctx.store.head(sb, rest.slice(1).join('/')) : null;
  if (!so) throw fault('no_such_key', 'The specified blob does not exist.', { code: 'CannotVerifyCopySource', status: 404 });
  const meta = userMetadata(ctx);
  const obj = await ctx.store.copy(so, b, key, { replaceMetadata: false, etag: newEtag(), source: 'api', runId: ctx.explicitRun?.id ?? null, logId: ctx.req.trafficLogId ?? null });
  const fin = Object.keys(meta).length ? ctx.hub.storage.repo.updateObjectMeta(obj, { metadata: meta }) : obj;
  noteObject(ctx, b, fin, false);
  ctx.changed({ bucket: b.name, key, put: true });
  const copyId = crypto.randomUUID();
  return ctx.reply.status(202).header('etag', fin.etag).header('last-modified', rfc1123(fin.updatedAt)).header('x-ms-copy-id', copyId).header('x-ms-copy-status', 'success').send();
}

async function blobOp(ctx: StorageCtx, container: string, key: string) {
  const m = ctx.req.method;
  const comp = ctx.query.get('comp');
  const copy = m === 'PUT' && !!header(ctx, 'x-ms-copy-source') && !comp;
  const op =
    m === 'PUT'
      ? comp === 'block'
        ? ['multipart', 'PutBlock']
        : comp === 'blocklist'
          ? ['multipart', 'PutBlockList']
          : comp === 'metadata'
            ? ['put', 'SetBlobMetadata']
            : comp === 'properties'
              ? ['put', 'SetBlobProperties']
              : copy
                ? ['copy', 'CopyBlob']
                : comp
                  ? ['any', `NotImplemented:${comp}`]
                  : ['put', 'PutBlob']
      : m === 'GET' || m === 'HEAD'
        ? comp === 'blocklist'
          ? ['multipart', 'GetBlockList']
          : comp === 'metadata'
            ? ['head', 'GetBlobMetadata']
            : comp
              ? ['any', `NotImplemented:${comp}`]
              : m === 'HEAD'
                ? ['head', 'GetBlobProperties']
                : ['get', 'GetBlob']
        : m === 'DELETE'
          ? ['delete', 'DeleteBlob']
          : ['any', 'MethodNotAllowed'];
  ctx.setOp(op[0] as 'put', op[1], { bucket: container, key });
  if (op[1].startsWith('NotImplemented')) throw fault('not_implemented', `stubyard does not simulate comp=${comp} (leases, snapshots, tags, tiers, append / page blobs are out of scope)`);
  if (op[1] === 'MethodNotAllowed') throw fault('method_not_allowed');
  const need = m === 'DELETE' ? 'delete' : m === 'PUT' ? 'write' : 'read';
  checkAuth(ctx, need, container, key);
  const existing = ctx.store.bucket(container);
  const upload = op[1] === 'PutBlob' || op[1] === 'PutBlock';
  const e = await gate(ctx, existing, upload);
  if (e === HANDLED) return ctx.reply;
  if (m === 'PUT' && (op[1] === 'PutBlob' || op[1] === 'PutBlock' || op[1] === 'PutBlockList' || op[1] === 'CopyBlob')) {
    const b = writableBucket(ctx, container, 'Container');
    if (op[1] === 'PutBlob') return putBlob(ctx, b, key, e);
    if (op[1] === 'PutBlock') return putBlock(ctx, b, key, e);
    if (op[1] === 'PutBlockList') return putBlockList(ctx, b, key);
    return copyBlob(ctx, b, key);
  }
  if (!existing) throw fault('no_such_bucket');
  if (op[1] === 'GetBlockList') return getBlockList(ctx, existing, key);
  const o = ctx.store.head(existing, key);
  if (!o) throw fault('no_such_key');
  if (op[1] === 'SetBlobMetadata') {
    conditions(ctx, o, false);
    const u = ctx.hub.storage.repo.updateObjectMeta(o, { metadata: userMetadata(ctx) });
    ctx.changed({ bucket: container, key, meta: true });
    return ctx.reply.status(200).header('etag', u.etag).header('last-modified', rfc1123(u.updatedAt)).send();
  }
  if (op[1] === 'SetBlobProperties') {
    conditions(ctx, o, false);
    const ct = header(ctx, 'x-ms-blob-content-type');
    const headers: Record<string, string> = {};
    for (const [ms, n] of CONTENT_HEADERS) {
      const v = header(ctx, ms);
      if (v) headers[n] = v;
    }
    const u = ctx.hub.storage.repo.updateObjectMeta(o, { contentType: ct ?? o.contentType, headers, extra: { ...o.extra, contentMd5: header(ctx, 'x-ms-blob-content-md5') ?? o.extra.contentMd5 } });
    ctx.changed({ bucket: container, key, meta: true });
    return ctx.reply.status(200).header('etag', u.etag).header('last-modified', rfc1123(u.updatedAt)).send();
  }
  if (op[1] === 'GetBlobMetadata') {
    for (const [k, v] of Object.entries(o.metadata)) ctx.reply.header(`x-ms-meta-${k}`, v);
    return ctx.reply.status(200).header('etag', o.etag).send();
  }
  if (op[1] === 'DeleteBlob') {
    conditions(ctx, o, false);
    ctx.store.remove(existing, key);
    ctx.changed({ bucket: container, key, deleted: true });
    return ctx.reply.status(202).header('x-ms-delete-type-permanent', 'true').send();
  }
  // Get Blob / Get Blob Properties
  conditions(ctx, o, true);
  const range = header(ctx, 'x-ms-range') ?? header(ctx, 'range');
  const h = blobHeaders(o);
  for (const [q, n] of [
    ['rsct', 'content-type'],
    ['rscd', 'content-disposition'],
    ['rscc', 'cache-control'],
  ] as const) {
    const v = ctx.query.get(q);
    if (v) h[n] = v;
  }
  if (range && o.extra.contentMd5 && header(ctx, 'x-ms-range-get-content-md5') !== 'true') delete h['content-md5'];
  return sendObject(ctx, o, e, h, { range, head: m === 'HEAD', contentType: ctx.query.get('rsct') ?? undefined });
}

// ---------------------------------------------------------------- router

async function handleAzure(ctx: StorageCtx): Promise<unknown> {
  const raw = ctx.path.split('/').slice(1);
  const account = safe(raw[0] ?? '');
  if (!account) {
    ctx.setOp('any', 'Unknown');
    throw fault('invalid_request', `Azure Blob URLs look like ${ctx.bases.request}/${accountOf(ctx)}/<container>/<blob>`, { code: 'InvalidUri', status: 400 });
  }
  if (account !== accountOf(ctx)) laxOrThrow(ctx, { kind: 'unknown_instance', code: 'ResourceNotFound', message: 'The specified resource does not exist.' }, `Account "${account}" in the URL, instance account is "${accountOf(ctx)}"`);
  const container = safe(raw[1] ?? '');
  const key = raw.slice(2).map(safe).join('/');
  const q = ctx.query;
  if (!container) {
    const comp = q.get('comp');
    if (comp === 'list') {
      ctx.setOp('bucket', 'ListContainers');
      checkAuth(ctx, 'list', '', '');
      if ((await gate(ctx, null, false)) === HANDLED) return ctx.reply;
      return ctx.reply.type('application/xml').send(containersXml(ctx));
    }
    if (q.get('restype') === 'service' && comp === 'properties') {
      ctx.setOp('bucket', 'GetServiceProperties');
      if (ctx.req.method === 'PUT') await ctx.readSmall();
      return ctx.reply.type('application/xml').send(xmlDoc(el('StorageServiceProperties', el('Cors'), el('DefaultServiceVersion', VERSION))));
    }
    if (q.get('restype') === 'account' && comp === 'properties') {
      ctx.setOp('bucket', 'GetAccountInfo');
      return ctx.reply.status(200).header('x-ms-sku-name', 'Standard_LRS').header('x-ms-account-kind', 'StorageV2').header('x-ms-is-hns-enabled', 'false').send();
    }
    ctx.setOp('any', `NotImplemented:${comp ?? 'service'}`);
    throw fault('not_implemented', `stubyard does not simulate the account-level operation comp=${comp ?? ''}`);
  }
  if (!key && q.get('restype') === 'container') return containerOp(ctx, container);
  if (!key) {
    ctx.setOp('any', 'Unknown', { bucket: container });
    throw fault('invalid_request', 'Container operations need ?restype=container', { code: 'InvalidUri', status: 400 });
  }
  return blobOp(ctx, container, key);
}

function azureSnippets(v: InstanceView): Snippet[] {
  const account = v.credentials[0]?.accessKeyId ?? AZURITE_ACCOUNT;
  const key = v.credentials[0]?.secretAccessKey ?? AZURITE_KEY;
  const cs = (base: string) => `DefaultEndpointsProtocol=http;AccountName=${account};AccountKey=${key};BlobEndpoint=${base}/${account};`;
  return [
    {
      title: 'Node.js — @azure/storage-blob',
      language: 'javascript',
      code:
        `import { BlobServiceClient } from '@azure/storage-blob';\n\n` +
        `// In Docker: ${cs(v.urls.docker)}\n` +
        `const service = BlobServiceClient.fromConnectionString('${cs(v.urls.backend)}');\n` +
        `const container = service.getContainerClient('uploads');\n` +
        `await container.createIfNotExists();\n` +
        `await container.getBlockBlobClient('docs/hello.txt').uploadData(Buffer.from('hello'), { blobHTTPHeaders: { blobContentType: 'text/plain' } });\n` +
        `for await (const blob of container.listBlobsFlat({ prefix: 'docs/' })) console.log(blob.name);`,
    },
    {
      title: 'Connection string (.env)',
      language: 'shell',
      code: `AZURE_STORAGE_CONNECTION_STRING="${cs(v.urls.backend)}"\n# Browsers (SAS URLs):\nAZURE_STORAGE_BLOB_URL=${v.urls.browser}/${account}`,
    },
    {
      title: 'Python — azure-storage-blob',
      language: 'python',
      code: `from azure.storage.blob import BlobServiceClient\n\nservice = BlobServiceClient.from_connection_string("${cs(v.urls.backend)}")\nservice.get_blob_client("uploads", "docs/hello.txt").upload_blob(b"hello", overwrite=True)`,
    },
    {
      title: 'SAS URL for a browser',
      language: 'javascript',
      code:
        `import { BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } from '@azure/storage-blob';\n\n` +
        `const cred = new StorageSharedKeyCredential('${account}', '${key}');\n` +
        `// Pass containerName / blobName explicitly: with a path-prefixed endpoint the client's own parsing of the URL is off.\n` +
        `const sas = generateBlobSASQueryParameters({ containerName: 'uploads', blobName: 'docs/hello.txt', permissions: BlobSASPermissions.parse('r'), expiresOn: new Date(Date.now() + 3600_000) }, cred).toString();\n` +
        `const url = \`${v.urls.browser}/${account}/uploads/docs/hello.txt?\${sas}\`;`,
    },
  ];
}

export const azureProtocol: StorageProtocol = {
  id: 'azure',
  presets: [AZURE_PRESET],
  handle: handleAzure,
  errorFor: azureError,
  snippets: azureSnippets,
  objectPath: (bucket, key, i) => `/${String(i.config.accountName || AZURITE_ACCOUNT)}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
  commonHeaders: (ctx) => ({ 'x-ms-request-id': ctx.requestId, 'x-ms-version': header(ctx, 'x-ms-version') ?? VERSION, date: new Date().toUTCString(), ...(header(ctx, 'x-ms-client-request-id') ? { 'x-ms-client-request-id': header(ctx, 'x-ms-client-request-id')! } : {}) }),
  presign(ctx, input) {
    const perm = input.method === 'GET' || input.method === 'HEAD' ? 'r' : input.method === 'PUT' ? 'cw' : 'd';
    const account = accountOf(ctx);
    if (input.expiresIn <= 0) throw new HttpError(400, 'expiresIn must be positive');
    const sas = signSas({ account, key: accountKeyOf(ctx), container: input.bucket, blob: input.key, permissions: perm, expiresOn: new Date(Date.now() + input.expiresIn * 1000) });
    const q = sas + (input.scenario ? `&hub_scenario=${encodeURIComponent(input.scenario)}` : '');
    const path = `/${account}/${input.bucket}/${input.key.split('/').map(encodeURIComponent).join('/')}?${q}`;
    return {
      backend: ctx.bases.backend + path,
      browser: ctx.bases.browser + path,
      expiresAt: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
      headers: input.method === 'PUT' ? { 'x-ms-blob-type': 'BlockBlob', ...(input.contentType ? { 'x-ms-blob-content-type': input.contentType } : {}) } : {},
    };
  },
};


let registered = false;
export function registerAzureProtocol(): void {
  if (registered) return;
  registered = true;
  registerStorageProtocol(azureProtocol);
}
