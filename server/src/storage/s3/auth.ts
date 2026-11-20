import { parseAmzDate, parseSigV4, verifySigV4, type SigV4Auth } from '../sigv4.js';
import { fault, type StorageCtx } from '../types.js';
import { LEGACY_NAME } from '../../legacy.js';

export interface S3Auth extends SigV4Auth {
  verified: boolean | null;
  /** Signing key when the signature verified (needed for chunk signatures). */
  key?: Buffer;
  secret?: string;
}

const MAX_EXPIRES = 604800;
const SKEW_MS = 15 * 60_000;

/** Host values a signature may have been computed for (stubyard cannot pick the host of SDK-signed URLs). */
export function candidateHosts(ctx: StorageCtx): string[] {
  const cfg = ctx.hub.config;
  const hosts = [String(ctx.req.headers.host ?? '')];
  if (cfg.publicUrl) {
    try {
      hosts.push(new URL(cfg.publicUrl).host);
    } catch {
      /* ignore */
    }
  }
  if (ctx.instance.config.browserBaseUrl) {
    try {
      hosts.push(new URL(String(ctx.instance.config.browserBaseUrl)).host);
    } catch {
      /* ignore */
    }
  }
  for (const p of [cfg.httpPort, cfg.httpsPort]) hosts.push(`stubyard:${p}`, `${LEGACY_NAME}:${p}`, `localhost:${p}`, `127.0.0.1:${p}`, `host.docker.internal:${p}`);
  hosts.push('localhost', 'stubyard', LEGACY_NAME);
  return hosts;
}

/**
 * Parse (and, when possible, verify) the request's credentials. Always enforced: expiry of presigned URLs,
 * X-Amz-Expires ≤ 7 days, well-formed credentials. Lax mode turns the rest into warnings; strict mode into errors.
 */
export function authenticate(ctx: StorageCtx): S3Auth {
  const a = parseSigV4(ctx.req.headers, ctx.query);
  const out: S3Auth = { ...a, verified: null };
  const strict = ctx.strict;
  const verifyMode = strict || ctx.instance.config.verifySignatures === true;
  const record = () => {
    ctx.resolved.auth = { type: out.type, accessKeyId: out.accessKeyId, expiresAt: out.expiresAt ?? null, verified: out.verified };
  };
  record();
  if (a.malformed) {
    throw fault('invalid_argument', a.malformed, { code: a.type === 'sigv4-query' ? 'AuthorizationQueryParametersError' : 'AuthorizationHeaderMalformed', status: 400 });
  }
  if (a.type === 'sigv4-query') {
    if (!(a.expires! > 0) || a.expires! > MAX_EXPIRES) {
      throw fault('invalid_argument', 'X-Amz-Expires must be less than a week (in seconds) that is 604800', { code: 'AuthorizationQueryParametersError', status: 400 });
    }
  }
  if (a.expiresAt && Date.parse(a.expiresAt) < Date.now()) {
    throw fault('expired_url', 'Request has expired', { detail: { 'X-Amz-Expires': String(a.expires ?? ''), Expires: a.expiresAt, ServerTime: new Date().toISOString() }, reason: 'presigned URL expired' });
  }
  if (a.type === 'sigv4-query') {
    const start = parseAmzDate(a.amzDate);
    if (start && start.getTime() - Date.now() > SKEW_MS) {
      const msg = 'Request is not valid yet (X-Amz-Date is in the future)';
      if (strict) throw fault('access_denied', msg);
      ctx.warnings.push(msg);
    }
  }
  if (a.type === 'anonymous') return out;
  if (a.type === 'sigv2') {
    ctx.warnings.push('Signature Version 2 request: accepted by stubyard but not verified (real S3 rejects SigV2 in most regions)');
    return out;
  }

  const creds = ctx.hub.storage.credentials(ctx.instance);
  const cred = creds.find((c) => c.accessKeyId === a.accessKeyId);
  if (!cred) {
    const msg = `Unknown access key "${a.accessKeyId}" (configured: ${creds.map((c) => c.accessKeyId).join(', ')})`;
    if (strict) throw fault('unknown_access_key', 'The AWS Access Key Id you provided does not exist in our records.', { detail: { AWSAccessKeyId: String(a.accessKeyId) }, reason: msg });
    ctx.warnings.push(`${msg}; accepted in lax mode`);
  } else {
    const v = verifySigV4(a, { method: ctx.req.method, rawUrl: ctx.req.originalUrl ?? ctx.req.url, headers: ctx.req.headers, secret: cred.secretAccessKey, hosts: candidateHosts(ctx) });
    out.verified = v.ok;
    out.key = v.key;
    out.secret = cred.secretAccessKey;
    if (v.ok && v.host && v.host !== ctx.req.headers.host) ctx.warnings.push(`Signature was computed for host "${v.host}", request came to "${ctx.req.headers.host}" (accepted)`);
    if (!v.ok) {
      const msg = 'Signature does not match (wrong secret key, or the request was changed after signing)';
      if (verifyMode) throw fault('bad_signature', undefined, { detail: { AWSAccessKeyId: String(a.accessKeyId) }, reason: msg });
      ctx.warnings.push(`${msg}; accepted in lax mode`);
    }
  }
  if (a.type === 'sigv4-header') {
    const t = parseAmzDate(a.amzDate);
    if (t && Math.abs(t.getTime() - Date.now()) > SKEW_MS) {
      const msg = `Request time ${a.amzDate} is more than 15 minutes from the server time`;
      if (strict) throw fault('clock_skew', undefined, { detail: { RequestTime: String(a.amzDate), ServerTime: new Date().toISOString() } });
      ctx.warnings.push(msg);
    }
    if (a.region && a.region !== ctx.hub.storage.region(ctx.instance) && ctx.preset.id === 's3') {
      ctx.warnings.push(`Request signed for region "${a.region}", instance region is "${ctx.hub.storage.region(ctx.instance)}" (real S3 answers AuthorizationHeaderMalformed / a redirect)`);
    }
  }
  record();
  return out;
}

/** Anonymous access to a private bucket / object: warning, or AccessDenied in strict mode. */
export function checkAnonymous(ctx: StorageCtx, auth: S3Auth, publicRead: boolean, write: boolean): void {
  if (auth.type !== 'anonymous') return;
  if (publicRead && !write) return;
  const msg = write ? 'Anonymous write: real S3 requires a signed request' : 'Anonymous read of a private object: real S3 answers 403 AccessDenied';
  if (ctx.strict) throw fault('access_denied', 'Access Denied', { reason: msg });
  ctx.warnings.push(`${msg} (allowed in lax mode)`);
}
