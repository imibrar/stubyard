import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import type { Mailpit } from '../../mailpit/mailpit.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'content-encoding', 'content-length',
]);

/**
 * Proxies /mailpit/* to the embedded Mailpit (HTML preview, attachments, raw source, Mailpit UI).
 * Mailpit runs with --webroot /mailpit/, so paths pass through unchanged.
 */
export async function registerMailpitProxy(app: FastifyInstance, mailpit: Mailpit): Promise<void> {
  const origin = new URL(mailpit.baseUrl).origin;
  const handler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const target = origin + req.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k === 'host') continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    headers['accept-encoding'] = 'identity';
    // Never pass stubyard's own credentials on; add Mailpit's login (sign-in on) instead.
    delete headers.cookie;
    delete headers.authorization;
    delete headers['x-stubyard-csrf'];
    Object.assign(headers, mailpit.authHeaders());
    const hasBody = !['GET', 'HEAD'].includes(req.method) && req.rawBody;
    let upstream: Response;
    try {
      upstream = await fetch(target, { method: req.method, headers, body: hasBody ? new Uint8Array(req.rawBody!) : undefined, redirect: 'manual' });
    } catch (err) {
      return reply.status(502).send({ error: `Mailpit is not reachable: ${(err as Error).message}` });
    }
    reply.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      // A Basic challenge would make the browser show a login dialog for Mailpit's internal login.
      if (!HOP_BY_HOP.has(key) && key !== 'www-authenticate') reply.header(key, value);
    });
    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  };
  app.all('/mailpit', handler);
  app.all('/mailpit/*', handler);
}
