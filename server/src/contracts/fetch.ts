// OpenAPI contracts (C1): fetch a spec from a URL for import (§2.1, decision 10). Not subject to the outbound
// allowlist; SSRF limits apply instead: http(s) only, link-local and cloud metadata addresses refused (checked again on
// every redirect and at connect time, so DNS rebinding cannot slip past), 10 MB, 15 s, at most 3 redirects, no
// credentials. The response body is never echoed in an error.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { envVar } from '../config.js';
import { SPEC_MAX_BYTES, SpecError } from './openapi.js';

export const SPEC_FETCH_TIMEOUT_MS = 15_000;
export const SPEC_FETCH_MAX_REDIRECTS = 3;

const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);

/** Always refused: link-local (cloud metadata lives at 169.254.169.254) and unspecified addresses. */
const ALWAYS_BLOCKED = new net.BlockList();
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED.addAddress('::', 'ipv6');

/** Refused as well with STUBYARD_SPEC_FETCH=public: loopback and private ranges. */
const PRIVATE = new net.BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

export type SpecFetchPolicy = 'off' | 'default' | 'public';

/** STUBYARD_SPEC_FETCH: 0 = URL import off; public = public addresses only; anything else = default. */
export function specFetchPolicy(): SpecFetchPolicy {
  const v = (envVar('STUBYARD_SPEC_FETCH') ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return 'off';
  if (v === 'public') return 'public';
  return 'default';
}

/** Why an address may not be fetched, or null when it may. */
export function blockedAddress(address: string, policy: SpecFetchPolicy = specFetchPolicy()): string | null {
  const a = address.replace(/^\[|\]$/g, '').toLowerCase();
  let fam = net.isIP(a);
  if (!fam) return null;
  // IPv4-mapped IPv6 (::ffff:169.254.169.254) counts as its IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  const ip = mapped ? mapped[1] : a;
  if (mapped) fam = 4;
  const type = fam === 6 ? 'ipv6' : 'ipv4';
  if (ALWAYS_BLOCKED.check(ip, type)) return `${address} is a link-local / metadata address`;
  if (policy === 'public' && PRIVATE.check(ip, type)) return `${address} is a private or loopback address (STUBYARD_SPEC_FETCH=public)`;
  return null;
}

function checkUrl(raw: string, policy: SpecFetchPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SpecError(`"${String(raw).slice(0, 200)}" is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SpecError(`Only http(s) URLs can be imported (got ${url.protocol})`);
  if (url.username || url.password) throw new SpecError('The spec URL must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(host)) throw new SpecError(`Refusing to fetch a spec from ${host} (cloud metadata)`);
  const why = blockedAddress(host, policy);
  if (why) throw new SpecError(`Refusing to fetch a spec from ${why}`);
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** A `lookup` for http.request that refuses blocked addresses at connect time. */
function guardedLookup(policy: SpecFetchPolicy) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, '');
      const list = addrs as dns.LookupAddress[];
      for (const a of list) {
        const why = blockedAddress(a.address, policy);
        if (why) return cb(Object.assign(new Error(`${hostname} resolves to ${why}`), { code: 'ESPECBLOCKED' }), '');
      }
      if (!list.length) return cb(Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' }), '');
      if (options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}

interface Hop {
  status: number;
  location: string | null;
  text: string;
  contentType: string | null;
}

function get(url: URL, policy: SpecFetchPolicy, deadline: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const remaining = Math.max(1, deadline - Date.now());
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json, application/yaml, application/x-yaml, text/yaml, text/plain;q=0.8, */*;q=0.5', 'user-agent': 'stubyard-spec-import' },
        lookup: guardedLookup(policy) as unknown as net.LookupFunction,
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: typeof res.headers.location === 'string' ? res.headers.location : null, text: '', contentType: null });
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > SPEC_MAX_BYTES) {
          res.destroy();
          return reject(new SpecError(`The spec at ${url.host} is larger than ${SPEC_MAX_BYTES / 1024 / 1024} MB`, 413));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > SPEC_MAX_BYTES) {
            res.destroy();
            req.destroy();
            reject(new SpecError(`The spec at ${url.host} is larger than ${SPEC_MAX_BYTES / 1024 / 1024} MB`, 413));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, location: null, text: Buffer.concat(chunks).toString('utf8'), contentType: (res.headers['content-type'] as string) ?? null }));
        res.on('error', (err) => reject(err));
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), remaining);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * GET a spec document. Throws a SpecError: 400 when URL import is off or the URL / an address is refused, 413 above
 * 10 MB, 502 when the server cannot be reached or does not answer 2xx (status only, never the body).
 */
export async function fetchSpec(rawUrl: string): Promise<{ text: string; url: string; contentType: string | null }> {
  const policy = specFetchPolicy();
  if (policy === 'off') throw new SpecError('URL import is turned off on this stubyard (STUBYARD_SPEC_FETCH=0); upload or paste the spec instead');
  let url = checkUrl(rawUrl, policy);
  const deadline = Date.now() + SPEC_FETCH_TIMEOUT_MS;
  for (let hops = 0; ; hops++) {
    let hop: Hop;
    try {
      hop = await get(url, policy, deadline);
    } catch (err) {
      if (err instanceof SpecError) throw err;
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ESPECBLOCKED') throw new SpecError(`Refusing to fetch a spec: ${e.message}`);
      if (e.code === 'ETIMEDOUT') throw new SpecError(`Fetching the spec from ${url.host} timed out after ${SPEC_FETCH_TIMEOUT_MS / 1000} s`, 502);
      throw new SpecError(`Could not fetch the spec from ${url.host}: ${e.code ?? e.message}`, 502);
    }
    if (hop.status >= 300 && hop.status < 400) {
      if (!hop.location) throw new SpecError(`${url.host} answered ${hop.status} without a Location header`, 502);
      if (hops >= SPEC_FETCH_MAX_REDIRECTS) throw new SpecError(`Too many redirects fetching the spec (max ${SPEC_FETCH_MAX_REDIRECTS})`, 502);
      url = checkUrl(new URL(hop.location, url).toString(), policy);
      continue;
    }
    if (hop.status < 200 || hop.status >= 300) throw new SpecError(`${url.host} answered ${hop.status} for the spec URL`, 502);
    return { text: hop.text, url: url.toString(), contentType: hop.contentType };
  }
}
