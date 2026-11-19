import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Hub } from '../hub.js';
import type { LogOutcome } from '../repos/logs.js';
import { HttpError } from '../util.js';
import { registerGuard } from './guard.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAgentGuideRoutes } from './routes/agent-guide.js';
import { registerAuthenticatorRoutes } from './routes/authenticators.js';
import { registerDoctorRoutes } from './routes/doctor.js';
import { registerMailpitProxy } from './routes/mailpit-proxy.js';
import { registerMessagingRoutes } from './routes/messaging.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerStream } from './routes/stream.js';
import { registerMockRoutes } from './routes/mocks.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerRunHook, rewriteRunUrl } from '../runs/resolver.js';
import { registerStorageRoutes } from './routes/storage.js';
import { registerLintRoutes } from './routes/lint.js';
import { installCheckContinue, rewriteStorageHost } from '../storage/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    bodyError?: string;
    trafficLogId?: string;
    /** Set by traffic routes to override the computed outcome. */
    trafficOutcome?: LogOutcome;
    trafficResolved?: Record<string, unknown>;
  }
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Request handler, so the same app can also be served over HTTPS. */
  handler: http.RequestListener;
}

/** Paths that carry app traffic and are always logged. Dashboard/API calls are not. */
const TRAFFIC_PREFIXES = ['/mock/', '/hook/', '/auth/', '/storage/'];

export async function buildApp(hub: Hub, logger: Logger): Promise<BuiltApp> {
  let handler: http.RequestListener | null = null;
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: Math.max(hub.config.maxEmailBytes, 1024 * 1024),
    // Requests are recorded in the traffic log; no per-request console lines.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    // /run/<key>/mock/… and /run/<key>/hook/… → the plain URL plus an X-Hub-Run header (test runs).
    rewriteUrl: (req) => rewriteStorageHost(req, hub.config.storageDomain) ?? rewriteRunUrl(req),
    serverFactory: (h) => {
      handler = h;
      const server = http.createServer(h);
      // Storage uploads send "100 Continue" only once the request passed auth and rules (storage/service.ts).
      installCheckContinue(server, h, hub.config.storageDomain);
      return server;
    },
  }) as unknown as FastifyInstance;

  // --- Body parsing: keep the raw bytes for logging, never fail the request at the parser ---
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    const ct = String(req.headers['content-type'] ?? '');
    if (buf.length === 0) return done(null, undefined);
    if (/[/+]json\b/i.test(ct)) {
      try {
        return done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        req.bodyError = `Invalid JSON: ${(err as Error).message}`;
        return done(null, undefined);
      }
    }
    if (/application\/x-www-form-urlencoded/i.test(ct)) {
      const params = new URLSearchParams(buf.toString('utf8'));
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of params) {
        const cur = out[k];
        out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
      }
      return done(null, out);
    }
    if (/^text\//i.test(ct)) return done(null, buf.toString('utf8'));
    return done(null, buf);
  });

  // --- Protect the dashboard API from other web pages (DNS rebinding, cross-site forms) ---
  registerGuard(app, hub.config);

  // --- Traffic logging ("log everything") ---
  app.addHook('onRequest', async (req, reply) => {
    if (!shouldLog(req)) return;
    const id = hub.traffic.start({
      direction: 'inbound',
      protocol: 'http',
      method: req.method,
      url: req.originalUrl ?? req.url,
      clientIp: req.ip,
      reqHeaders: { ...req.headers },
    });
    req.trafficLogId = id;
    reply.header('x-hub-request-id', id);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const id = req.trafficLogId;
    if (!id) return payload;
    const tb = req.trafficBody;
    // Object bytes (storage) are never stored: only the size (req.trafficBody), small control bodies as text.
    const reqBody = tb?.reqSize !== undefined ? { text: null, size: tb.reqSize, truncated: false } : hub.traffic.clip(req.rawBody ?? null);
    let resBody: ReturnType<typeof hub.traffic.clip>;
    if (tb?.resSize !== undefined) resBody = { text: null, size: tb.resSize, truncated: false };
    else if (typeof payload === 'string' || Buffer.isBuffer(payload)) resBody = hub.traffic.clip(payload);
    else if (payload === null || payload === undefined) resBody = hub.traffic.clip(null);
    else resBody = { text: '[streamed response]', size: 0, truncated: false };
    hub.traffic.update(id, {
      reqBody: reqBody.text,
      reqBodySize: reqBody.size,
      reqTruncated: reqBody.truncated,
      resStatus: reply.statusCode,
      resHeaders: reply.getHeaders() as Record<string, unknown>,
      resBody: resBody.text,
      resBodySize: resBody.size,
      resTruncated: resBody.truncated,
    });
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const id = req.trafficLogId;
    if (!id) return;
    hub.traffic.finish(id, { outcome: outcomeFor(req, reply), resStatus: reply.statusCode });
    if (req.trafficResolved || req.bodyError) {
      hub.traffic.mergeResolved(id, { ...(req.trafficResolved ?? {}), ...(req.bodyError ? { bodyError: req.bodyError } : {}) });
    }
  });

  app.addHook('onRequestAbort', async (req) => {
    const id = req.trafficLogId;
    if (!id) return;
    hub.traffic.finish(id, { outcome: 'network_error', errorType: 'client_aborted', errorMessage: 'Client closed the connection before the response was sent', respondedAt: null });
  });

  // --- Errors ---
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; details?: unknown; validation?: unknown };
    const status = err instanceof HttpError ? err.statusCode : e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      if (req.trafficLogId) hub.traffic.update(req.trafficLogId, { errorType: 'internal_error', errorMessage: e.message });
    }
    reply.status(status).send({ error: status >= 500 && !(err instanceof HttpError) ? 'Internal error' : e.message, details: (err as HttpError).details ?? undefined, requestId: req.trafficLogId });
  });

  // API routes reject unparsable JSON with 400; traffic routes decide for themselves.
  app.addHook('preHandler', async (req) => {
    if (req.bodyError && req.url.startsWith('/api/')) throw new HttpError(400, req.bodyError);
  });

  // --- Test runs: explicit X-Hub-Run on /mock and /hook (unknown / stopped run → 404) ---
  registerRunHook(app, hub);

  await registerRunRoutes(app, hub);
  await registerAuthRoutes(app, hub);
  await registerStorageRoutes(app, hub);
  await registerAuthenticatorRoutes(app, hub);
  await registerMessagingRoutes(app, hub);
  await registerMcpRoutes(app, hub);
  await registerApiRoutes(app, hub);
  await registerStream(app, hub);
  await registerMockRoutes(app, hub);
  await registerSystemRoutes(app, hub);
  await registerWebhookRoutes(app, hub);
  await registerLintRoutes(app, hub);
  await registerAgentGuideRoutes(app, hub);
  await registerDoctorRoutes(app, hub);
  if (hub.mailpit) await registerMailpitProxy(app, hub.mailpit);

  // --- Dashboard (static) + SPA fallback ---
  const indexFile = path.join(hub.config.webDir, 'index.html');
  const hasWeb = fs.existsSync(indexFile);
  if (hasWeb) {
    await app.register(fastifyStatic, { root: hub.config.webDir, wildcard: false, index: ['index.html'] });
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (hasWeb && (req.method === 'GET' || req.method === 'HEAD') && acceptsHtml(req)) {
      return reply.type('text/html').send(fs.createReadStream(indexFile));
    }
    req.trafficOutcome = 'unmatched';
    const p = req.url.split('?')[0];
    // /mock/<project>/… or /hook/<project>/…: attach the log to that project so it shows in its traffic log.
    const m = /^\/(?:mock|hook|storage)\/([^/]+)/.exec(p);
    const project = m ? hub.projects.getBySlug(decodeURIComponent(m[1]).toLowerCase()) : null;
    if (req.trafficLogId) {
      if (project) hub.traffic.update(req.trafficLogId, { projectId: project.id });
      req.trafficResolved = { project: project?.slug ?? null, ...(m && !project ? { unknownProject: m[1] } : {}) };
    }
    return reply.status(404).send({
      error: 'Not found',
      message: `devhub has no route for ${req.method} ${p}`,
      hint: hintFor(p),
      requestId: req.trafficLogId,
    });
  });

  await app.ready();
  if (!handler) throw new Error('server handler not initialised');
  return { app, handler };
}

function shouldLog(req: FastifyRequest): boolean {
  const p = req.url.split('?')[0];
  if (p.startsWith('/api/') || p === '/api' || p.startsWith('/mailpit')) return false;
  if (TRAFFIC_PREFIXES.some((pre) => p.startsWith(pre))) return true;
  if (req.is404) {
    // Browser navigation to dashboard pages is served the SPA, not logged.
    return !((req.method === 'GET' || req.method === 'HEAD') && acceptsHtml(req));
  }
  return false; // static dashboard assets
}

function acceptsHtml(req: FastifyRequest): boolean {
  return String(req.headers.accept ?? '').includes('text/html');
}

function outcomeFor(req: FastifyRequest, reply: FastifyReply): LogOutcome {
  if (req.trafficOutcome) return req.trafficOutcome;
  const s = reply.statusCode;
  if (req.is404 || s === 404) return 'unmatched';
  if (s >= 500) return 'internal_error';
  if (req.bodyError) return 'invalid';
  if (s === 400 || s === 413 || s === 415 || s === 422) return 'invalid';
  return 'ok';
}

function hintFor(p: string): string {
  if (p.startsWith('/mock/')) return 'Mock URLs look like /mock/<project>/<provider-instance>/... - check the project and provider slugs in the dashboard (Providers tab).';
  if (p.startsWith('/auth/')) return 'Login provider URLs look like /auth/<project>/<provider>/<real path> - check the project and provider slugs in the dashboard (Providers tab → Login providers).';
  if (p.startsWith('/storage/')) return 'Storage URLs look like /storage/<project>/<instance>/<bucket>/<key> - check the project and instance slugs in the dashboard (Storage tab).';
  if (p.startsWith('/hook/')) return 'Webhook URLs look like /hook/<project>/<endpoint> - check the endpoint in the dashboard (Webhooks tab).';
  return 'See the devhub dashboard for the URLs of each project.';
}
