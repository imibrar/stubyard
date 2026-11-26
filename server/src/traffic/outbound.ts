import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { DEFAULT_OUTBOUND_ALLOW } from '../config.js';
import type { TrafficLogger } from './logger.js';

export interface OutboundRequest {
  projectId: string | null;
  parentLogId?: string | null;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer | null;
  /** Shown in the traffic log ("status callback", "inbound message"…). */
  purpose: string;
  resolved?: Record<string, unknown>;
  timeoutMs?: number;
  /** Accept a self-signed / untrusted certificate for this call (also: STUBYARD_OUTBOUND_INSECURE_TLS). */
  insecureTls?: boolean;
  /** Test run the call belongs to (taken from the message / user that caused it). */
  runId?: string | null;
  /** OpenAPI contract the app's response is checked against (a webhook template's `contract`); else auto-matched. */
  contract?: { spec: string; operation?: string } | null;
}

export interface OutboundResult {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  logId: string;
  /** Not sent: the host is not on the outbound allowlist (retrying will not help). */
  blocked?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound policy: which hosts stubyard may call, and where self-signed HTTPS is accepted.
// Set once per process by createHub() from the config (STUBYARD_OUTBOUND_ALLOW / STUBYARD_OUTBOUND_INSECURE_TLS).
// ---------------------------------------------------------------------------------------------------------------

export interface OutboundPolicy {
  allow: string[];
  insecureTls: string[];
}

let policy: OutboundPolicy = { allow: DEFAULT_OUTBOUND_ALLOW, insecureTls: [] };

export function configureOutbound(p: Partial<OutboundPolicy>): void {
  policy = { allow: p.allow ?? policy.allow, insecureTls: p.insecureTls ?? policy.insecureTls };
}

export function outboundPolicy(): OutboundPolicy {
  return policy;
}

const CIDR_RE = /^([0-9a-f:.]+)\/(\d{1,3})$/i;

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

/** Does `host` (name or IP literal) match one allowlist entry? DNS is not consulted here. */
function matchesEntry(host: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e === '*') return true;
  if (e === 'single-label') return !net.isIP(host) && !host.includes('.');
  const cidr = CIDR_RE.exec(e);
  if (cidr) {
    const fam = net.isIP(host);
    const netFam = net.isIP(cidr[1]);
    if (!fam || !netFam) return false;
    const bl = new net.BlockList();
    try {
      bl.addSubnet(cidr[1], Number(cidr[2]), netFam === 6 ? 'ipv6' : 'ipv4');
    } catch {
      return false;
    }
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) counts as its IPv4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return bl.check(mapped[1], 'ipv4');
    return bl.check(host, fam === 6 ? 'ipv6' : 'ipv4');
  }
  if (e.startsWith('*.')) return host.endsWith(e.slice(1));
  return host === e.replace(/^\[|\]$/g, '');
}

export function hostMatches(host: string, entries: string[]): boolean {
  return entries.some((e) => matchesEntry(host, e));
}

export interface AllowCheck {
  allowed: boolean;
  host: string;
  /** Why it is allowed / blocked, for logs and the doctor. */
  reason: string;
  /** Addresses the host resolved to (when DNS had to be consulted). */
  addresses?: string[];
}

/**
 * Is stubyard allowed to call this URL? Allowed when the host matches an entry by name / IP, or when it is a name that
 * resolves only to addresses that match an IP / CIDR entry (e.g. a company dev host on 10.x).
 */
export async function checkOutboundUrl(rawUrl: string, allow: string[] = policy.allow): Promise<AllowCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, host: '', reason: `"${rawUrl}" is not a valid URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allowed: false, host: '', reason: `only http(s) URLs can be called (got ${url.protocol})` };
  const host = hostnameOf(url);
  if (hostMatches(host, allow)) return { allowed: true, host, reason: allow.includes('*') ? 'allowlist disabled (*)' : 'host is on the outbound allowlist' };
  if (!net.isIP(host)) {
    try {
      const addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
      const ipEntries = allow.filter((e) => CIDR_RE.test(e.trim()) || net.isIP(e.trim().replace(/^\[|\]$/g, '')));
      if (addrs.length && addrs.every((a) => hostMatches(a.toLowerCase(), ipEntries))) {
        return { allowed: true, host, reason: `resolves to private address ${addrs.join(', ')}`, addresses: addrs };
      }
      return { allowed: false, host, reason: blockedReason(host, addrs), addresses: addrs };
    } catch {
      /* unresolvable: blocked by name; the request would fail anyway */
    }
  }
  return { allowed: false, host, reason: blockedReason(host) };
}

function blockedReason(host: string, addrs?: string[]): string {
  return (
    `${host}${addrs?.length ? ` (${addrs.join(', ')})` : ''} is not on stubyard's outbound allowlist, so stubyard did not call it ` +
    `(protects real/production URLs, e.g. from an imported config). Allowed by default: localhost, host.docker.internal, ` +
    `*.local, *.test, *.internal, private IPs and docker service names. Add it with STUBYARD_OUTBOUND_ALLOW=+${host} (or * to allow everything).`
  );
}

function insecureFor(url: string, r: OutboundRequest): boolean {
  if (!url.startsWith('https:')) return false;
  if (r.insecureTls) return true;
  try {
    return hostMatches(hostnameOf(new URL(url)), policy.insecureTls);
  } catch {
    return false;
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** fetch() cannot skip certificate checks without undici; use node:https for those calls. */
function requestNode(url: string, method: string, headers: Record<string, string>, body: string | Buffer | undefined, timeoutMs: number, insecure: boolean): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method, headers, rejectUnauthorized: !insecure, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : String(v);
        resolve({ status: res.statusCode ?? 0, headers: h, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      req.destroy(e);
    });
    req.on('error', (err: Error & { code?: string }) => {
      if (err.name === 'TimeoutError') return reject(err);
      reject(Object.assign(new Error(err.message), { cause: { code: err.code, message: err.message } }));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Sends a request to the developer's app (status callbacks, inbound messages, webhooks) and records it in the
 * traffic log as an outbound entry, linked to the request that caused it. Hosts outside the outbound allowlist are
 * not called (logged as `blocked_by_allowlist`).
 */
export async function sendOutbound(traffic: TrafficLogger, r: OutboundRequest): Promise<OutboundResult> {
  const method = r.method ?? 'POST';
  const headers = { 'user-agent': 'stubyard (local testing hub)', ...(r.headers ?? {}) };
  const logId = traffic.start({
    projectId: r.projectId,
    direction: 'outbound',
    protocol: 'http',
    method,
    url: r.url,
    reqHeaders: headers,
    parentLogId: r.parentLogId ?? null,
    resolved: { purpose: r.purpose, ...(r.resolved ?? {}) },
    runId: r.runId ?? null,
  });
  const reqBody = traffic.clip(r.body ?? null);
  traffic.update(logId, { reqBody: reqBody.text, reqBodySize: reqBody.size, reqTruncated: reqBody.truncated });

  const check = await checkOutboundUrl(r.url);
  if (!check.allowed) {
    traffic.finish(logId, { outcome: 'network_error', errorType: 'blocked_by_allowlist', errorMessage: check.reason });
    traffic.mergeResolved(logId, { blockedByAllowlist: true });
    return { ok: false, status: null, body: null, error: `blocked_by_allowlist: ${check.reason}`, logId, blocked: true };
  }

  const timeoutMs = r.timeoutMs ?? 10_000;
  const insecure = insecureFor(r.url, r);
  const sendBody = method === 'GET' || method === 'HEAD' ? undefined : r.body ?? undefined;
  try {
    let res: RawResponse;
    if (insecure) {
      res = await requestNode(r.url, method, headers, sendBody, timeoutMs, true);
      traffic.mergeResolved(logId, { insecureTls: true });
    } else {
      const f = await fetch(r.url, { method, headers, body: Buffer.isBuffer(sendBody) ? new Uint8Array(sendBody) : sendBody, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      const h: Record<string, string> = {};
      f.headers.forEach((v, k) => (h[k] = v));
      res = { status: f.status, headers: h, text: await f.text() };
    }
    const clipped = traffic.clip(res.text);
    traffic.finish(logId, {
      resStatus: res.status,
      resHeaders: res.headers,
      resBody: clipped.text,
      resBodySize: clipped.size,
      resTruncated: clipped.truncated,
      outcome: res.status < 400 ? 'ok' : 'rejected',
      errorType: res.status < 400 ? null : 'app_error',
      errorMessage: res.status < 400 ? null : `Your app answered ${res.status}`,
    });
    try {
      traffic.outboundObserver?.(r, { logId, status: res.status, headers: res.headers, text: res.text });
    } catch {
      // A failing contract check never fails the call.
    }
    return { ok: res.status < 400, status: res.status, body: res.text, error: null, logId };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const msg = timeout ? `No answer within ${timeoutMs / 1000}s` : e.cause?.code ? `${e.cause.code}: ${e.cause.message ?? e.message}` : e.message;
    const tlsHint = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(msg) ? ' Self-signed HTTPS? Set STUBYARD_OUTBOUND_INSECURE_TLS=1 (or a host list).' : '';
    traffic.finish(logId, { outcome: 'network_error', errorType: timeout ? 'timeout' : 'connection_failed', errorMessage: `${msg} (is your app running and reachable from stubyard?)${tlsHint}` });
    return { ok: false, status: null, body: null, error: msg, logId };
  }
}
