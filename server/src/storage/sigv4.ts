import crypto from 'node:crypto';

/**
 * AWS Signature Version 4 (and V2, accepted but never verified): parsing, verification against candidate hosts, and
 * presigned URL generation for the control API.
 */

export interface SigV4Auth {
  type: 'sigv4-header' | 'sigv4-query' | 'sigv2' | 'anonymous';
  accessKeyId: string | null;
  /** yyyymmdd / region / service from the credential scope. */
  date?: string;
  region?: string;
  service?: string;
  /** X-Amz-Date / x-amz-date (yyyymmddThhmmssZ). */
  amzDate?: string;
  signedHeaders?: string[];
  signature?: string;
  /** Presigned: seconds and absolute expiry. */
  expires?: number;
  expiresAt?: string;
  payloadHash?: string;
  malformed?: string;
}

const enc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function parseAmzDate(v: string | undefined): Date | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function parseCredential(cred: string): Pick<SigV4Auth, 'accessKeyId' | 'date' | 'region' | 'service'> | null {
  const parts = cred.split('/');
  if (parts.length < 5 || parts[parts.length - 1] !== 'aws4_request') return null;
  const n = parts.length;
  return { accessKeyId: parts.slice(0, n - 4).join('/'), date: parts[n - 4], region: parts[n - 3], service: parts[n - 2] };
}

export function parseSigV4(headers: Record<string, string | string[] | undefined>, query: URLSearchParams): SigV4Auth {
  const h = (n: string) => {
    const v = headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const authz = h('authorization');
  if (authz?.startsWith('AWS4-HMAC-SHA256')) {
    const out: SigV4Auth = { type: 'sigv4-header', accessKeyId: null, amzDate: h('x-amz-date') ?? h('date'), payloadHash: h('x-amz-content-sha256') ?? 'UNSIGNED-PAYLOAD' };
    const fields = Object.fromEntries(
      authz
        .slice('AWS4-HMAC-SHA256'.length)
        .split(',')
        .map((p) => p.trim().split('=') as [string, string])
        .filter((p) => p.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join('=').trim()]),
    );
    const cred = fields.Credential ? parseCredential(fields.Credential) : null;
    if (!cred || !fields.SignedHeaders || !fields.Signature) return { ...out, malformed: 'Authorization header is malformed' };
    return { ...out, ...cred, signedHeaders: fields.SignedHeaders.split(';'), signature: fields.Signature };
  }
  if (authz?.startsWith('AWS ')) {
    const [ak] = authz.slice(4).split(':');
    return { type: 'sigv2', accessKeyId: ak || null };
  }
  if (query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' || query.has('X-Amz-Credential')) {
    const out: SigV4Auth = { type: 'sigv4-query', accessKeyId: null, amzDate: query.get('X-Amz-Date') ?? undefined, payloadHash: query.get('X-Amz-Content-Sha256') ?? 'UNSIGNED-PAYLOAD' };
    const cred = parseCredential(query.get('X-Amz-Credential') ?? '');
    const sh = query.get('X-Amz-SignedHeaders');
    const sig = query.get('X-Amz-Signature');
    const exp = Number(query.get('X-Amz-Expires'));
    if (!cred || !sh || !sig || !out.amzDate) return { ...out, ...(cred ?? {}), malformed: 'Presigned URL is missing X-Amz-Credential, X-Amz-Date, X-Amz-SignedHeaders or X-Amz-Signature' };
    const start = parseAmzDate(out.amzDate);
    const expires = Number.isFinite(exp) && exp > 0 ? exp : 0;
    return {
      ...out,
      ...cred,
      signedHeaders: sh.split(';'),
      signature: sig,
      expires,
      expiresAt: start ? new Date(start.getTime() + expires * 1000).toISOString() : undefined,
    };
  }
  if (query.has('AWSAccessKeyId') && query.has('Signature')) {
    const e = Number(query.get('Expires'));
    return { type: 'sigv2', accessKeyId: query.get('AWSAccessKeyId'), ...(e ? { expiresAt: new Date(e * 1000).toISOString(), expires: e } : {}) };
  }
  return { type: 'anonymous', accessKeyId: null };
}

/** Canonical query string: every parameter but X-Amz-Signature (and devhub's hub_scenario), RFC 3986, sorted. */
export function canonicalQuery(rawQuery: string, opts: { presigned: boolean }): string {
  const pairs: [string, string][] = [];
  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = safeDecode(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? '' : safeDecode(part.slice(eq + 1));
    if (opts.presigned && k === 'X-Amz-Signature') continue;
    if (k === 'hub_scenario') continue;
    pairs.push([enc3986(k), enc3986(v)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%20'));
  } catch {
    return s;
  }
}

/** S3 does not normalise or double-encode the path: re-encode each segment canonically. */
export function canonicalPath(rawPath: string): string {
  return rawPath
    .split('/')
    .map((seg) => enc3986(safeDecode(seg)).replace(/%7E/g, '~'))
    .join('/');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const k1 = crypto.createHmac('sha256', 'AWS4' + secret).update(date).digest();
  const k2 = crypto.createHmac('sha256', k1).update(region).digest();
  const k3 = crypto.createHmac('sha256', k2).update(service).digest();
  return crypto.createHmac('sha256', k3).update('aws4_request').digest();
}

const sha256hex = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (k: Buffer, s: string) => crypto.createHmac('sha256', k).update(s).digest('hex');

export interface VerifyInput {
  method: string;
  /** Raw request target (path + query) as received, before any rewrite. */
  rawUrl: string;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  /** Host values to try (request Host first). */
  hosts: string[];
}

/** Returns the host the signature matched, or null. */
export function verifySigV4(auth: SigV4Auth, v: VerifyInput): { ok: boolean; host: string | null; key?: Buffer } {
  if (!auth.signature || !auth.signedHeaders || !auth.date || !auth.region || !auth.service || !auth.amzDate) return { ok: false, host: null };
  const q = v.rawUrl.indexOf('?');
  const path = q < 0 ? v.rawUrl : v.rawUrl.slice(0, q);
  const query = q < 0 ? '' : v.rawUrl.slice(q + 1);
  const cq = canonicalQuery(query, { presigned: auth.type === 'sigv4-query' });
  const key = signingKey(v.secret, auth.date, auth.region, auth.service);
  const scope = `${auth.date}/${auth.region}/${auth.service}/aws4_request`;
  const payload = auth.type === 'sigv4-query' ? (auth.payloadHash ?? 'UNSIGNED-PAYLOAD') : String(v.headers['x-amz-content-sha256'] ?? 'UNSIGNED-PAYLOAD');
  const paths = [...new Set([canonicalPath(path), path])];
  for (const host of [...new Set(v.hosts.filter(Boolean))]) {
    const ch = auth.signedHeaders
      .map((name) => {
        let val: string;
        if (name === 'host') val = host;
        else {
          const raw = v.headers[name];
          val = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).trim().replace(/\s+/g, ' ');
        }
        return `${name}:${val}\n`;
      })
      .join('');
    for (const p of paths) {
      const creq = [v.method, p, cq, ch, auth.signedHeaders.join(';'), payload].join('\n');
      const sts = ['AWS4-HMAC-SHA256', auth.amzDate, scope, sha256hex(creq)].join('\n');
      const sig = hmacHex(key, sts);
      if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(auth.signature.padEnd(sig.length).slice(0, sig.length)))) return { ok: true, host, key };
    }
  }
  return { ok: false, host: null };
}

/** Chain-verify aws-chunked chunk signatures (seed = header signature). */
export function verifyChunkSignatures(auth: SigV4Auth, key: Buffer, chunks: { signature: string | null; sha256: string | null }[]): boolean {
  if (!auth.signature || !auth.amzDate || !auth.date) return false;
  const scope = `${auth.date}/${auth.region}/${auth.service}/aws4_request`;
  const empty = sha256hex('');
  let prev = auth.signature;
  for (const c of chunks) {
    if (!c.signature || !c.sha256) return false;
    const sts = ['AWS4-HMAC-SHA256-PAYLOAD', auth.amzDate, scope, prev, empty, c.sha256].join('\n');
    const sig = hmacHex(key, sts);
    if (sig !== c.signature) return false;
    prev = sig;
  }
  return true;
}

/** Build a SigV4 presigned URL (query auth, UNSIGNED-PAYLOAD, signed headers: host). */
export function presignUrl(o: { method: string; url: string; accessKeyId: string; secret: string; region: string; expiresIn: number; now?: Date; extraQuery?: Record<string, string> }): string {
  const u = new URL(o.url);
  const now = o.now ?? new Date();
  const ad = amzDate(now);
  const date = ad.slice(0, 8);
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    ...(o.extraQuery ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': `${o.accessKeyId}/${scope}`,
    'X-Amz-Date': ad,
    'X-Amz-Expires': String(o.expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  const rawQuery = Object.entries(params)
    .map(([k, v]) => `${enc3986(k)}=${enc3986(v)}`)
    .join('&');
  const cq = canonicalQuery(rawQuery, { presigned: true });
  const path = canonicalPath(u.pathname);
  const creq = [o.method, path, cq, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', ad, scope, sha256hex(creq)].join('\n');
  const sig = hmacHex(signingKey(o.secret, date, o.region, 's3'), sts);
  const extra = Object.entries(o.extraQuery ?? {}).filter(([k]) => k === 'hub_scenario').map(([k, v]) => `&${enc3986(k)}=${enc3986(v)}`).join('');
  return `${u.origin}${path}?${cq}&X-Amz-Signature=${sig}${extra}`;
}

/** POST policy signature: hex HMAC of the base64 policy with the SigV4 signing key. */
export function policySignature(policyB64: string, secret: string, credential: string): string | null {
  const parts = credential.split('/');
  if (parts.length < 5) return null;
  const n = parts.length;
  return hmacHex(signingKey(secret, parts[n - 4], parts[n - 3], parts[n - 2]), policyB64);
}
