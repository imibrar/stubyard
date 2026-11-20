import http2 from 'node:http2';
import net from 'node:net';
import { Duplex } from 'node:stream';
import type { Hub } from '../hub.js';
import type { LogOutcome } from '../repos/logs.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import type { PushInstance } from './types.js';
import { handleApns, type ApnsResult } from './apns.js';

const MAX_BODY = 64 * 1024;
/** Resource limits: the listener is unauthenticated (lax by default). */
export const APNS_LIMITS = { maxConcurrentStreams: 100, maxSessionMemoryMb: 10, maxSessions: 256, maxConnections: 512, sessionIdleMs: 120_000, streamMs: 30_000, prefaceMs: 10_000 };
const HTTP1_REFUSAL = JSON.stringify({ reason: 'BadPath', message: 'This is stubyard\'s fake APNs listener: APNs speaks HTTP/2 only. Use an HTTP/2 client (or the /push/<project>/<instance>/3/device/<token> route on the normal HTTP port for curl).' });

export interface ApnsListener {
  port: number;
  close: () => Promise<void>;
}

/**
 * The fake APNs provider API: HTTP/2 only, like api.push.apple.com. With TLS (stubyard CA) when stubyard has TLS,
 * else cleartext HTTP/2 with prior knowledge (h2c). HTTP/1.1 clients get one plain 505 answer and the connection closes.
 */
export async function startApnsServer(hub: Hub, o: { port: number; host: string; log?: { error: (obj: object, msg: string) => void } }): Promise<ApnsListener> {
  const sessions = new Set<http2.Http2Session>();
  const timers = new Set<NodeJS.Timeout>();
  const tls = hub.tls;
  const L = APNS_LIMITS;
  const h2opts = { settings: { maxConcurrentStreams: L.maxConcurrentStreams }, maxSessionMemory: L.maxSessionMemoryMb };
  const h2 = tls ? http2.createSecureServer({ ...h2opts, key: tls.keyPem, cert: tls.certPem, allowHTTP1: false }) : http2.createServer(h2opts);
  h2.on('session', (s) => {
    if (sessions.size >= L.maxSessions) {
      s.destroy();
      return;
    }
    sessions.add(s);
    s.on('close', () => sessions.delete(s));
    s.on('error', () => undefined);
    // Idle connections go (real APNs also closes idle connections).
    s.setTimeout(L.sessionIdleMs, () => s.close());
  });
  h2.on('sessionError', () => undefined);
  h2.on('error', (err) => o.log?.error({ err }, 'APNs HTTP/2 server error'));
  h2.on('stream', (stream, headers) => {
    try {
      onStream(hub, stream as http2.ServerHttp2Stream, headers, tls ? 'h2' : 'h2c', timers);
    } catch (err) {
      o.log?.error({ err }, 'APNs stream handling failed');
      if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    }
  });

  let listener: net.Server;
  if (tls) {
    // ALPN did not pick h2 (an HTTP/1.1 client): answer once in HTTP/1.1 and close.
    h2.on('unknownProtocol', (socket: net.Socket) => {
      socket.on('error', () => undefined);
      socket.end(refusal());
    });
    listener = h2 as unknown as net.Server;
  } else {
    // h2c: look at the first bytes; the HTTP/2 connection preface goes to the HTTP/2 server, anything else is refused.
    listener = net.createServer((sock) => {
      sock.on('error', () => undefined);
      // A socket that never sends the connection preface is dropped.
      sock.setTimeout(L.prefaceMs, () => sock.destroy());
      sock.once('data', (first: Buffer) => {
        sock.setTimeout(0);
        if (!first.subarray(0, 14).toString('latin1').startsWith('PRI * HTTP/2.0'.slice(0, Math.min(14, first.length)))) {
          sock.end(refusal());
          return;
        }
        sock.pause();
        const d = new Duplex({
          read() {
            sock.resume();
          },
          write(chunk, enc, cb) {
            sock.write(chunk, enc, cb);
          },
          final(cb) {
            sock.end();
            cb();
          },
          destroy(err, cb) {
            sock.destroy(err ?? undefined);
            cb(err);
          },
        });
        Object.assign(d, { remoteAddress: sock.remoteAddress, remotePort: sock.remotePort, remoteFamily: sock.remoteFamily, setNoDelay: () => d, setKeepAlive: () => d, setTimeout: () => d });
        d.push(first);
        sock.on('data', (c: Buffer) => {
          if (!d.push(c)) sock.pause();
        });
        sock.on('end', () => d.push(null));
        sock.on('close', () => d.destroy());
        h2.emit('connection', d);
      });
    });
  }

  listener.maxConnections = L.maxConnections;
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(o.port, o.host, () => {
      listener.off('error', reject);
      resolve();
    });
  });
  // After startup an 'error' (EMFILE on accept, …) must not crash the process.
  listener.on('error', (err) => o.log?.error({ err }, 'APNs listener error'));
  const port = (listener.address() as net.AddressInfo).port;
  return {
    port,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      for (const s of sessions) s.destroy();
      await new Promise<void>((r) => listener.close(() => r()));
      if (!tls) await new Promise<void>((r) => (h2 as http2.Http2Server).close(() => r()));
    },
  };
}

/** Runs fn; a throw (traffic log / DB) is swallowed: timer and stream callbacks must never throw. */
function quiet(fn: () => void): void {
  try {
    fn();
  } catch {
    /* ignore */
  }
}

function refusal(): string {
  return `HTTP/1.1 505 HTTP Version Not Supported\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(HTTP1_REFUSAL)}\r\nconnection: close\r\n\r\n${HTTP1_REFUSAL}`;
}

function onStream(hub: Hub, stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, transport: 'h2' | 'h2c', timers: Set<NodeJS.Timeout>): void {
  stream.on('error', () => undefined);
  const chunks: Buffer[] = [];
  let size = 0;
  // A request that never ends (no END_STREAM) is cancelled instead of held forever.
  const idle = setTimeout(() => {
    timers.delete(idle);
    if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
  }, APNS_LIMITS.streamMs);
  timers.add(idle);
  const clearIdle = () => {
    clearTimeout(idle);
    timers.delete(idle);
  };
  stream.on('close', clearIdle);
  stream.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= MAX_BODY) chunks.push(c);
  });
  stream.on('end', () => {
    clearIdle();
    try {
      handleEnd();
    } catch {
      // Traffic log or DB failure: answer 500 rather than throw out of an event handler.
      try {
        if (!stream.destroyed && !stream.headersSent) {
          stream.respond({ ':status': 500, 'content-type': 'application/json' });
          stream.end(JSON.stringify({ reason: 'InternalServerError' }));
        }
      } catch {
        /* client went away */
      }
    }
  });
  const handleEnd = () => {
    const body = Buffer.concat(chunks);
    const method = String(headers[':method'] ?? 'GET');
    const rawPath = String(headers[':path'] ?? '/');
    const authority = String(headers[':authority'] ?? headers.host ?? 'localhost');
    const reqHeaders: Record<string, unknown> = { ...headers };
    if (reqHeaders.authorization) reqHeaders.authorization = '[redacted]';
    const logId = hub.traffic.start({
      direction: 'inbound',
      protocol: 'http',
      method,
      url: `${transport === 'h2' ? 'https' : 'http'}://${authority}${rawPath}`,
      clientIp: stream.session?.socket?.remoteAddress ?? null,
      reqHeaders,
      resolved: { kind: 'push', provider: 'apns', transport },
    });
    const clip = hub.traffic.clip(body);
    hub.traffic.update(logId, { reqBody: clip.text, reqBodySize: size, reqTruncated: clip.truncated || size > MAX_BODY });

    let result: ApnsResult;
    try {
      result = route(hub, { method, rawPath, headers, body, transport, logId, connection: stream.session ?? undefined });
    } catch (err) {
      result = { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'InternalServerError' }), projectId: null, runId: null, resolved: { error: (err as Error).message } };
    }
    hub.traffic.mergeResolved(logId, result.resolved);
    if (result.hold) {
      const t = setTimeout(() => {
        timers.delete(t);
        quiet(() => hub.traffic.finish(logId, { outcome: 'forced_error', errorType: 'timeout', errorMessage: 'Fault "timeout": stream reset without an answer', respondedAt: null }));
        if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
      }, hub.config.timeoutHoldMs);
      timers.add(t);
      stream.on('close', () => {
        if (timers.has(t)) {
          clearTimeout(t);
          timers.delete(t);
          quiet(() => hub.traffic.finish(logId, { outcome: 'network_error', errorType: 'client_aborted', errorMessage: 'Client reset the stream during a held (timeout fault) request', respondedAt: null }));
        }
      });
      return;
    }
    const send = () => {
      if (stream.destroyed || stream.closed) return;
      try {
        stream.respond({ ':status': result.status, ...result.headers });
        stream.end(result.body ?? undefined);
      } catch {
        /* client went away */
      }
      const clipRes = hub.traffic.clip(result.body);
      hub.traffic.update(logId, { resHeaders: result.headers, resBody: clipRes.text, resBodySize: clipRes.size, resTruncated: clipRes.truncated });
      hub.traffic.finish(logId, { resStatus: result.status, outcome: outcomeOf(result) });
    };
    if (result.delayMs) {
      const t = setTimeout(() => {
        timers.delete(t);
        try {
          send();
        } catch {
          /* logged traffic could not be updated */
        }
      }, result.delayMs);
      timers.add(t);
    } else send();
  };
}

function outcomeOf(r: ApnsResult): LogOutcome {
  if (r.status === 200) return 'ok';
  if (r.resolved.fault) return 'forced_error';
  if (r.status === 404) return 'unmatched';
  if (r.status >= 500) return 'internal_error';
  return 'rejected';
}

/** /run/<key> and /push/<project>/<instance> prefixes, then the APNs request itself. */
function route(hub: Hub, r: { method: string; rawPath: string; headers: http2.IncomingHttpHeaders; body: Buffer; transport: 'h2' | 'h2c'; logId: string; connection?: object }): ApnsResult {
  let p = r.rawPath;
  let runKey: string | null = null;
  const rm = /^\/run\/([a-z0-9]{1,24})(\/.*)$/i.exec(p);
  if (rm) {
    runKey = rm[1].toLowerCase();
    p = rm[2];
  }
  const hdrRun = r.headers['x-hub-run'];
  runKey ??= (Array.isArray(hdrRun) ? hdrRun[0] : hdrRun)?.trim() || null;
  let project: Project | null = null;
  let instance: PushInstance | null = null;
  const pm = /^\/push\/([^/]+)\/([^/]+)(\/.*)$/.exec(p);
  const bad = (reason: string): ApnsResult => ({
    status: 404,
    headers: { 'content-type': 'application/json', 'x-stubyard-reason': reason },
    body: JSON.stringify({ reason: 'BadPath' }),
    projectId: project?.id ?? null,
    runId: null,
    resolved: { kind: 'push', provider: 'apns', status: 'rejected', errorCode: 'BadPath', reason },
  });
  if (pm) {
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    project = hub.projects.getBySlug(dec(pm[1]).toLowerCase());
    if (!project) return bad(`stubyard has no project "${pm[1]}"`);
    instance = hub.push.repo.instanceBySlug(project.id, dec(pm[2]).toLowerCase());
    if (!instance || instance.preset !== 'apns') return bad(`Project "${project.slug}" has no APNs instance "${pm[2]}"`);
    hub.traffic.update(r.logId, { projectId: project.id });
    p = pm[3];
  }
  let run: Run | null = null;
  // With the /push/<p>/<i> prefix the run is resolved here; otherwise handleApns resolves it in the project the
  // provider token / device token points at (run keys are unique per project only).
  if (runKey && project) {
    run = hub.runs.resolver.explicit(project.id, runKey);
    if (!run) return bad(`Unknown run "${runKey}" (unknown, stopped or expired)`);
  }
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(r.headers)) headers[k] = v as string | string[] | undefined;
  return handleApns(hub, { method: r.method, path: p, headers, body: r.body, transport: r.transport, connection: r.connection, logId: r.logId, project, instance, run, runKey: run ? null : runKey });
}
