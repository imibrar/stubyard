import type { StorageBucket } from '../../repos/storage.js';
import { parseForm } from '../multipart-form.js';
import { policySignature } from '../sigv4.js';
import { fault, StorageFaultError, type StorageCtx, type StorageEffects } from '../types.js';
import { el, xmlDoc } from '../xml.js';

type Condition = { kind: 'eq' | 'starts-with'; field: string; value: string } | { kind: 'range'; min: number; max: number };

function parsePolicy(b64: string): { expiration: string | null; conditions: Condition[] } {
  let doc: { expiration?: string; conditions?: unknown[] };
  try {
    doc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw fault('invalid_argument', 'Invalid Policy: Invalid JSON.', { code: 'InvalidPolicyDocument', status: 400 });
  }
  const conditions: Condition[] = [];
  for (const c of doc.conditions ?? []) {
    if (Array.isArray(c)) {
      const op = String(c[0]).toLowerCase();
      if (op === 'content-length-range') conditions.push({ kind: 'range', min: Number(c[1]), max: Number(c[2]) });
      else if (op === 'eq' || op === 'starts-with') conditions.push({ kind: op, field: String(c[1]).replace(/^\$/, '').toLowerCase(), value: String(c[2]) });
    } else if (c && typeof c === 'object') {
      for (const [k, v] of Object.entries(c)) conditions.push({ kind: 'eq', field: k.toLowerCase(), value: String(v) });
    }
  }
  return { expiration: doc.expiration ?? null, conditions };
}

/** Browser upload: POST B/<bucket> with a multipart form (policy fields first, then `file`). */
export async function postObject(ctx: StorageCtx, bucket: StorageBucket, e: StorageEffects | null) {
  const { req, reply } = ctx;
  const parsed = await parseForm(
    ctx.body(e),
    req.headers,
    async (fields, file) => {
      const get = (n: string) => fields[n] ?? fields[n.toLowerCase()];
      const policyB64 = get('policy');
      const cred = get('x-amz-credential');
      const accessKeyId = cred?.split('/')[0] ?? get('awsaccesskeyid') ?? null;
      ctx.resolved.auth = { type: policyB64 ? 'post-policy' : 'anonymous', accessKeyId };
      let range: { min: number; max: number } | null = null;
      const key = (get('key') ?? '').replace(/\$\{filename\}/g, file.filename);
      if (!key) throw fault('invalid_argument', 'Bucket POST must contain a field named \'key\'.  If it is specified, please check the order of the fields.', { detail: { ArgumentName: 'key' } });
      ctx.setOp('put', 'PostObject', { bucket: bucket.name, key });
      if (policyB64) {
        const policy = parsePolicy(policyB64);
        if (!policy.expiration || Date.parse(policy.expiration) < Date.now()) throw fault('access_denied', 'Invalid according to Policy: Policy expired.', { reason: `policy expiration ${policy.expiration}` });
        const failures: string[] = [];
        for (const c of policy.conditions) {
          if (c.kind === 'range') {
            range = { min: c.min, max: c.max };
            continue;
          }
          if (['x-amz-signature', 'policy', 'file'].includes(c.field)) continue;
          const actual = c.field === 'bucket' ? bucket.name : c.field === 'key' ? key : (get(c.field) ?? '');
          const ok = c.kind === 'eq' ? actual === c.value : actual.startsWith(c.value);
          if (!ok) failures.push(`${c.kind === 'eq' ? 'eq' : 'starts-with'} $${c.field} "${c.value}" (got "${actual}")`);
        }
        if (failures.length) {
          const msg = `Invalid according to Policy: Policy Condition failed: ${failures.join('; ')}`;
          if (ctx.strict) throw fault('policy_violation', msg);
          ctx.warnings.push(`${msg} (allowed in lax mode)`);
        }
        const creds = ctx.hub.storage.credentials(ctx.instance);
        const c = creds.find((x) => x.accessKeyId === accessKeyId);
        const sig = get('x-amz-signature');
        if (!c) {
          const msg = `Unknown access key "${accessKeyId}" in the POST policy`;
          if (ctx.strict) throw fault('unknown_access_key', undefined, { reason: msg });
          ctx.warnings.push(msg);
        } else if (sig && cred) {
          const ok = policySignature(policyB64, c.secretAccessKey, cred) === sig;
          (ctx.resolved.auth as Record<string, unknown>).verified = ok;
          if (!ok) {
            const msg = 'POST policy signature does not match';
            if (ctx.strict || ctx.instance.config.verifySignatures === true) throw fault('bad_signature', undefined, { reason: msg });
            ctx.warnings.push(msg);
          }
        }
      } else if (ctx.strict && !bucket.public) throw fault('access_denied', 'Access Denied', { reason: 'POST without a policy to a private bucket' });
      else ctx.warnings.push('POST upload without a policy (anonymous): real S3 only allows this for buckets with public write');
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) if (k.toLowerCase().startsWith('x-amz-meta-')) meta[k.toLowerCase().slice(11)] = v;
      const headers: Record<string, string> = {};
      for (const h of ['cache-control', 'content-disposition', 'content-encoding', 'expires']) if (get(h)) headers[h] = get(h)!;
      const rng = range as { min: number; max: number } | null;
      const obj = await ctx.store.put(bucket, key, file.stream, {
        contentType: get('content-type') ?? file.mimeType ?? 'binary/octet-stream',
        headers,
        metadata: meta,
        acl: get('acl') ?? null,
        source: 'api',
        runId: ctx.explicitRun?.id ?? null,
        logId: req.trafficLogId ?? null,
        maxBytes: rng ? rng.max : e?.action === 'entity_too_large' && e.params.maxBytes !== undefined ? Number(e.params.maxBytes) : undefined,
        verify: (d) => (rng && d.size < rng.min ? { kind: 'entity_too_small', message: 'Your proposed upload is smaller than the minimum allowed size', detail: { ProposedSize: String(d.size), MinSizeAllowed: String(rng.min) } } : null),
      });
      return { obj, fields, key };
    },
    { fileField: 'file' },
  ).catch((err) => {
    if (err instanceof StorageFaultError) throw err;
    if ((err as Error).message?.includes('Unexpected end of form') || (err as Error).message?.includes('Malformed')) throw fault('malformed_xml', 'The body of your POST request is not well-formed multipart/form-data.', { code: 'MalformedPOSTRequest', status: 400 });
    throw err;
  });
  if (!parsed.result) throw fault('invalid_argument', 'POST requires exactly one file upload per request.', { detail: { ArgumentName: 'file', ArgumentValue: '0' } });
  const { obj, fields, key } = parsed.result;
  ctx.noteRequestSize(obj.size);
  Object.assign(ctx.resolved, { objectId: obj.id, etag: obj.etag, contentType: obj.contentType });
  ctx.changed({ bucket: bucket.name, key, put: true });
  const location = `${ctx.bases.request}/${bucket.name}/${key.split('/').map(encodeURIComponent).join('/')}`;
  reply.header('etag', obj.etag).header('location', location);
  const redirect = fields.success_action_redirect ?? fields.redirect;
  if (redirect) {
    try {
      const u = new URL(redirect);
      u.searchParams.set('bucket', bucket.name);
      u.searchParams.set('key', key);
      u.searchParams.set('etag', obj.etag);
      return reply.status(303).header('location', u.toString()).send();
    } catch {
      ctx.warnings.push(`success_action_redirect "${redirect}" is not an absolute URL; ignored`);
    }
  }
  const status = Number(fields.success_action_status ?? 204);
  if (status === 201) {
    return reply.status(201).type('application/xml').send(xmlDoc(el('PostResponse', el('Location', location), el('Bucket', bucket.name), el('Key', key), el('ETag', obj.etag))));
  }
  return reply.status(status === 200 ? 200 : 204).send();
}
