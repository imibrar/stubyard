/** GCS V4 signed URLs (GOOG4-RSA-SHA256): parse, expiry, signature check, and signing for the control API. */
import crypto from 'node:crypto';
import type { Hub } from '../../hub.js';
import type { StorageInstance } from '../../repos/storage.js';

export interface ServiceAccount {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  token_uri: string;
}

/** The instance's fake service account (RSA key generated once, kept in config.serviceAccount). */
export function serviceAccountOf(hub: Hub, i: StorageInstance): ServiceAccount {
  const cur = i.config.serviceAccount as ServiceAccount | undefined;
  if (cur?.private_key && cur.client_email) return cur;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa: ServiceAccount = {
    type: 'service_account',
    project_id: 'stubyard',
    private_key_id: crypto.randomBytes(20).toString('hex'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: `stubyard@${i.slug}.iam.gserviceaccount.com`,
    client_id: String(BigInt('0x' + crypto.randomBytes(8).toString('hex'))),
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  hub.storage.update(i, { config: { serviceAccount: sa } });
  i.config.serviceAccount = sa;
  return sa;
}

/** RFC 3986 encoding as the Node client does it (encodeURIComponent plus !'()*). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p: string) => p.split('/').map(rfc3986).join('/');

export interface Goog4 {
  credential: string;
  email: string;
  scope: string;
  date: string;
  expires: number;
  signedHeaders: string;
  signature: string;
  expiresAt: string;
}

export function parseGoog4(q: URLSearchParams): Goog4 | null | 'malformed' {
  if (!q.has('X-Goog-Signature') && !q.has('X-Goog-Algorithm')) return null;
  const alg = q.get('X-Goog-Algorithm');
  const credential = q.get('X-Goog-Credential') ?? '';
  const date = q.get('X-Goog-Date') ?? '';
  const expires = Number(q.get('X-Goog-Expires'));
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (alg !== 'GOOG4-RSA-SHA256' || !credential.includes('/') || !m || !(expires > 0) || !q.get('X-Goog-Signature')) return 'malformed';
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const i = credential.indexOf('/');
  return {
    credential,
    email: credential.slice(0, i),
    scope: credential.slice(i + 1),
    date,
    expires,
    signedHeaders: q.get('X-Goog-SignedHeaders') ?? 'host',
    signature: q.get('X-Goog-Signature') ?? '',
    expiresAt: new Date(start + expires * 1000).toISOString(),
  };
}

function canonicalQuery(q: URLSearchParams): string {
  return [...q.entries()]
    .filter(([k]) => k !== 'X-Goog-Signature' && k !== 'hub_scenario')
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function stringToSign(g: Goog4, method: string, path: string, q: URLSearchParams, headers: Record<string, string>): string {
  const names = g.signedHeaders.split(';').filter(Boolean);
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? '').trim().replace(/\s{2,}/g, ' ')}\n`).join('');
  const req = [method, path, canonicalQuery(q), canonicalHeaders, g.signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  return ['GOOG4-RSA-SHA256', g.date, g.scope, crypto.createHash('sha256').update(req).digest('hex')].join('\n');
}

/**
 * Verify against the service account key: the Node client signs the path "/<bucket>/<object>" (no endpoint path
 * prefix) and "host:<hostname>" without the port, so every candidate host is tried with and without its port.
 */
export function verifyGoog4(g: Goog4, o: { method: string; paths: string[]; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; hosts: string[]; publicKey: crypto.KeyObject | string }): boolean {
  const sig = Buffer.from(g.signature, 'hex');
  const hosts = new Set<string>();
  for (const h of o.hosts) {
    if (!h) continue;
    hosts.add(h);
    hosts.add(h.replace(/:\d+$/, ''));
  }
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers)) if (v !== undefined) base[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  for (const p of o.paths) {
    for (const host of hosts) {
      const sts = stringToSign(g, o.method, p, o.query, { ...base, host });
      if (crypto.verify('RSA-SHA256', Buffer.from(sts), o.publicKey, sig)) return true;
    }
  }
  return false;
}

/** Sign a V4 URL like the Node client (path-style "/<bucket>/<object>", host without port). */
export function signGoog4(o: { method: string; base: string; bucket: string; key: string; expiresIn: number; sa: ServiceAccount; contentType?: string; extra?: Record<string, string> }): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const date = `${day}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const scope = `${day}/auto/storage/goog4_request`;
  const url = new URL(o.base);
  const headers: Record<string, string> = { host: url.hostname };
  if (o.contentType) headers['content-type'] = o.contentType;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const q = new URLSearchParams({
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${o.sa.client_email}/${scope}`,
    'X-Goog-Date': date,
    'X-Goog-Expires': String(o.expiresIn),
    'X-Goog-SignedHeaders': signedHeaders,
  });
  const path = `/${o.bucket}/${encPath(o.key)}`;
  const g: Goog4 = { credential: '', email: o.sa.client_email, scope, date, expires: o.expiresIn, signedHeaders, signature: '', expiresAt: '' };
  const sts = stringToSign(g, o.method, path, q, headers);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(sts), o.sa.private_key).toString('hex');
  const qs = [...q.entries(), ['X-Goog-Signature', signature], ...Object.entries(o.extra ?? {})].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  return `${o.base.replace(/\/+$/, '')}${path}?${qs}`;
}
