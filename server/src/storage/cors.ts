import type { BucketCors, CorsRule } from '../repos/storage.js';

/**
 * CORS for /storage/*. Per bucket: permissive (default: reflect Origin, allow whatever is asked, warn that the real
 * bucket needs a rule), rules (S3 CORSRule[], enforced exactly), none (no CORS headers at all).
 */

export const EXPOSE = 'ETag, Content-Range, Content-Length, Content-Type, Last-Modified, Accept-Ranges, x-amz-request-id, x-amz-id-2, x-amz-version-id, x-amz-checksum-crc32, x-amz-checksum-crc32c, x-amz-checksum-crc64nvme, x-amz-checksum-sha1, x-amz-checksum-sha256, x-amz-checksum-type, x-amz-meta-*, x-goog-hash, x-goog-generation, x-ms-request-id, x-ms-version, x-hub-request-id, x-stubyard-reason';

const wildcard = (pattern: string, value: string) => {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return re.test(value);
};

export interface CorsDecision {
  headers: Record<string, string>;
  /** Preflight / request not allowed by the bucket's rules. */
  denied: boolean;
  warning?: string;
}

export function corsFor(cors: BucketCors | null, o: { origin?: string; method: string; requestHeaders?: string; preflight: boolean }): CorsDecision {
  const origin = o.origin;
  if (!origin) return { headers: {}, denied: false };
  const mode = cors?.mode ?? 'permissive';
  if (mode === 'none') return { headers: {}, denied: o.preflight };
  if (mode === 'permissive') {
    const h: Record<string, string> = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': EXPOSE,
      vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
    };
    if (o.preflight) {
      h['access-control-allow-methods'] = 'GET, HEAD, PUT, POST, DELETE, PATCH, OPTIONS';
      h['access-control-allow-headers'] = o.requestHeaders || '*';
      h['access-control-max-age'] = '600';
    }
    return { headers: h, denied: false, warning: `CORS: stubyard allowed origin ${origin} (permissive mode); a real bucket needs a CORS rule for it` };
  }
  const reqHeaders = (o.requestHeaders ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const rule = (cors?.rules ?? []).find(
    (r: CorsRule) =>
      r.AllowedOrigins.some((p) => wildcard(p, origin)) &&
      r.AllowedMethods.some((m) => m.toUpperCase() === o.method.toUpperCase()) &&
      reqHeaders.every((hd) => (r.AllowedHeaders ?? []).some((p) => wildcard(p.toLowerCase(), hd))),
  );
  if (!rule) return { headers: {}, denied: true };
  const h: Record<string, string> = {
    'access-control-allow-origin': rule.AllowedOrigins.includes('*') ? '*' : origin,
    vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
  };
  if (rule.ExposeHeaders?.length) h['access-control-expose-headers'] = rule.ExposeHeaders.join(', ');
  if (o.preflight) {
    h['access-control-allow-methods'] = rule.AllowedMethods.join(', ');
    if (reqHeaders.length) h['access-control-allow-headers'] = reqHeaders.join(', ');
    if (rule.MaxAgeSeconds) h['access-control-max-age'] = String(rule.MaxAgeSeconds);
  }
  if (!rule.AllowedOrigins.includes('*')) h['access-control-allow-credentials'] = 'true';
  return { headers: h, denied: false };
}
