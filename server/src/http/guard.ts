import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { LEGACY_NAME } from '../legacy.js';

const BUILT_IN = ['localhost', '127.0.0.1', '::1', 'stubyard', LEGACY_NAME, 'host.docker.internal'];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** "localhost:4000" / "[::1]:4000" / "https://x.y:8443" → hostname, lower-case. */
export function hostOf(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
  if (v.startsWith('[')) return v.slice(1, v.indexOf(']'));
  const parts = v.split(':');
  return parts.length === 2 ? parts[0] : v; // bare IPv6 without port stays as-is
}

/**
 * stubyard's dashboard API has no login (local tool), so it must not be callable by other web pages:
 *  - Host must be a known name (blocks DNS rebinding: evil.example → 127.0.0.1).
 *  - Mutating requests from a browser must come from a stubyard page (Origin / Sec-Fetch-Site), and send JSON,
 *    so a form on any website cannot POST to /api/factory-reset.
 * Provider mocks (/mock, /hook) are left open: apps and third parties call them.
 */
export function registerGuard(app: FastifyInstance, config: Config): void {
  if (config.allowedHosts.includes('*')) return;
  const allowed = new Set([...BUILT_IN, ...config.tlsExtraNames, ...config.allowedHosts].map((h) => hostOf(h)));
  const isAllowed = (h: string) => allowed.has(hostOf(h));

  const deny = (reason: string) => ({
    error: `Blocked by stubyard: ${reason}`,
    hint: 'If you reach stubyard under another name or IP, add it to STUBYARD_ALLOWED_HOSTS (comma-separated), or set STUBYARD_ALLOWED_HOSTS=* to disable this check.',
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const path = req.url.split('?')[0];
    if (!(path === '/api' || path.startsWith('/api/') || path === '/mcp')) return;
    const host = String(req.headers.host ?? '');
    if (host && !isAllowed(host)) return reply.status(403).send(deny(`unknown Host "${host}"`));
    if (!MUTATING.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !isAllowed(origin)) return reply.status(403).send(deny(`cross-site request from ${origin}`));
    if (origin === 'null' || req.headers['sec-fetch-site'] === 'cross-site') return reply.status(403).send(deny('cross-site request'));
    // HTML forms can only send urlencoded / multipart / text bodies; the API only takes JSON.
    const ct = String(req.headers['content-type'] ?? '');
    if (ct && !/[/+]json\b/i.test(ct)) return reply.status(415).send({ error: `The stubyard API accepts JSON bodies only (got "${ct}")` });
  });
}
