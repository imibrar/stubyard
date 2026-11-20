import http from 'node:http';
import https from 'node:https';
import { checkOutboundUrl, hostMatches, outboundPolicy } from '../traffic/outbound.js';
import type { TrafficLogger } from '../traffic/logger.js';

/**
 * A small MCP client used by the MCP tester (devhub is the client, the developer's MCP server is the target).
 *
 * Not the SDK's Client on purpose: the tester must survive servers that break the spec (the SDK validates every
 * response with zod and throws), and it must see and record every raw JSON-RPC message with timing and size.
 *
 * Transports:
 *  - Streamable HTTP (2025-03-26, 2025-06-18, 2025-11-25): POST per message, JSON or SSE responses, Mcp-Session-Id,
 *    MCP-Protocol-Version, optional GET stream for server-initiated messages, resume with Last-Event-ID, DELETE on close.
 *  - Legacy HTTP+SSE (2024-11-05): GET event stream, `endpoint` event, POST messages to that endpoint.
 */

export const CLIENT_PROTOCOL_VERSION = '2025-11-25';
export const KNOWN_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export type TransportKind = 'streamable' | 'sse';
export type TransportPref = 'auto' | TransportKind;
type Json = Record<string, unknown>;
type RpcId = string | number;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface LogEntry {
  seq: number;
  at: string;
  dir: 'out' | 'in' | 'local';
  /** request / response / error (JSON-RPC error response) / notification / transport (HTTP-level event) / invalid. */
  kind: 'request' | 'response' | 'error' | 'notification' | 'transport' | 'invalid';
  method?: string;
  id?: RpcId | null;
  /** For responses: time since the request was sent. */
  durationMs?: number;
  size: number;
  status?: number;
  note?: string;
  /** Traffic-log entry of the HTTP exchange (Streamable HTTP POSTs). */
  logId?: string;
  /** Who caused the exchange: "tester" (dashboard / API), "saved" (saved-call runs), "checks", "agent" (devhub MCP tools), later "chat". */
  source?: string;
  payload: unknown;
}

export interface RequestOutcome {
  result?: Json;
  error?: RpcError;
  durationMs: number;
  /** notifications/progress received for this request. */
  progress: Json[];
}

/** Transport-level failure (not a JSON-RPC error): connection refused, HTTP 500, timeout, session expired… */
export class TransportError extends Error {
  constructor(
    message: string,
    public code: 'blocked' | 'connect' | 'http' | 'timeout' | 'session_expired' | 'closed' | 'protocol',
    public status?: number,
    public body?: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  url: string;
  headers: Record<string, string>;
  transport: TransportPref;
  projectId: string | null;
  traffic: TrafficLogger | null;
  /** Label for the traffic log (target name or URL). */
  label: string;
  testerSessionId: string;
  clientVersion: string;
  /** Called (often) when something was logged or a notification arrived. */
  onActivity?: (kind: string, data?: unknown) => void;
  maxLog?: number;
}

const MAX_PAYLOAD = 256 * 1024;
const ACCEPT_POST = 'application/json, text/event-stream';

interface Pending {
  method: string;
  t0: number;
  resolve: (o: RequestOutcome) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  progressToken?: string;
  progress: Json[];
  source?: string;
}

interface SseEvent {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
}

/** Incremental text/event-stream parser. */
class SseParser {
  private buf = '';
  private ev: { event: string; data: string[]; id: string | null; retry: number | null } = { event: '', data: [], id: null, retry: null };
  private hasData = false;
  constructor(private onEvent: (e: SseEvent) => void) {}
  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      // A lone \r at the end may be the first half of \r\n: wait for more data.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line);
    }
  }
  end(): void {
    if (this.buf) this.line(this.buf);
    this.buf = '';
    this.line('');
  }
  private line(line: string): void {
    if (line === '') {
      if (this.hasData || this.ev.id !== null || this.ev.retry !== null) {
        this.onEvent({ event: this.ev.event || 'message', data: this.ev.data.join('\n'), id: this.ev.id, retry: this.ev.retry });
      }
      this.ev = { event: '', data: [], id: null, retry: null };
      this.hasData = false;
      return;
    }
    if (line.startsWith(':')) return;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      this.ev.data.push(value);
      this.hasData = true;
    } else if (field === 'event') this.ev.event = value;
    else if (field === 'id') this.ev.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.ev.retry = Number(value);
  }
}

function insecureFor(url: URL): boolean {
  return url.protocol === 'https:' && hostMatches(url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), outboundPolicy().insecureTls);
}

/** Open an HTTP request and resolve with the response head (the body is read by the caller). */
function openHttp(url: string, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const h = { ...headers };
    if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
    const req = mod.request(u, { method, headers: h, rejectUnauthorized: !insecureFor(u), signal });
    const timer = setTimeout(() => req.destroy(new TransportError(`No answer within ${Math.round(timeoutMs / 1000)}s`, 'timeout')), timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    req.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      if (err instanceof TransportError) return reject(err);
      if (err.name === 'AbortError') return reject(new TransportError('Connection closed', 'closed'));
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(`${err.code} ${err.message}`);
      reject(
        new TransportError(
          `${err.code ?? 'error'}: ${err.message}${tls ? ' (self-signed HTTPS? set DEVHUB_OUTBOUND_INSECURE_TLS=1 or a host list)' : ''}${err.code === 'ECONNREFUSED' ? ' (is the MCP server running and reachable from devhub?)' : ''}`,
          'connect',
        ),
      );
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function readBody(res: http.IncomingMessage, max = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    res.on('data', (c: Buffer) => {
      n += c.length;
      if (n <= max) chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
    res.on('aborted', () => reject(new TransportError('Response aborted', 'closed')));
  });
}

const flatHeaders = (res: http.IncomingMessage) => {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(', ') : String(v);
  return h;
};

export class McpClient {
  readonly log: LogEntry[] = [];
  private seq = 0;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  transport: TransportKind | null = null;
  sessionId: string | null = null;
  protocolVersion: string | null = null;
  /** Legacy SSE: the POST endpoint announced by the server. */
  endpoint: string | null = null;
  /** Streamable HTTP: whether the server offers the GET stream (null = not tried yet). */
  getStream: 'open' | 'unsupported' | 'closed' | null = null;
  closed = false;
  /** Counters the checks use. */
  stats = { invalidMessages: 0, serverRequests: 0, notifications: {} as Record<string, number>, sessionReinits: 0, lastEventIds: 0 };
  private abort = new AbortController();
  private lastEventId: string | null = null;
  private retryMs = 1000;

  constructor(readonly opts: ClientOptions) {}

  // ------------------------------------------------------------------ log

  private record(e: Omit<LogEntry, 'seq' | 'at' | 'size'> & { size?: number }): LogEntry {
    let size = e.size ?? 0;
    let payload = e.payload;
    if (e.size === undefined && payload !== undefined) {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      size = Buffer.byteLength(text ?? '');
      if (size > MAX_PAYLOAD) payload = { truncated: true, size, preview: (text ?? '').slice(0, 4096) };
    }
    const entry: LogEntry = { seq: ++this.seq, at: new Date().toISOString(), size, ...e, payload };
    this.log.push(entry);
    const max = this.opts.maxLog ?? 2000;
    if (this.log.length > max) this.log.splice(0, this.log.length - max);
    this.opts.onActivity?.('log');
    return entry;
  }

  clearLog(): void {
    this.log.length = 0;
    this.opts.onActivity?.('log');
  }

  // ------------------------------------------------------------------ public API

  /** Run initialize + notifications/initialized. Detects the transport when `auto`. */
  async connect(): Promise<{ result: Json; durationMs: number }> {
    const check = await checkOutboundUrl(this.opts.url);
    if (!check.allowed) throw new TransportError(`blocked_by_allowlist: ${check.reason}`, 'blocked');
    const pref = this.opts.transport;
    const looksLegacy = /\/sse\/?$/i.test(new URL(this.opts.url).pathname);
    const order: TransportKind[] = pref === 'auto' ? (looksLegacy ? ['sse', 'streamable'] : ['streamable', 'sse']) : [pref];
    let firstErr: Error | null = null;
    for (const t of order) {
      try {
        this.transport = t;
        if (t === 'sse') await this.openLegacyStream();
        const out = await this.initialize();
        return out;
      } catch (err) {
        const e = err as TransportError;
        // Fall back to the other transport only for the status codes the spec names (400 / 404 / 405) or no SSE endpoint.
        const fallback = pref === 'auto' && (e.code === 'http' ? [400, 404, 405].includes(e.status ?? 0) : e.code === 'protocol');
        firstErr ??= e;
        this.record({ dir: 'local', kind: 'transport', note: `${t === 'sse' ? 'HTTP+SSE' : 'Streamable HTTP'} failed: ${e.message}${fallback && t !== order[order.length - 1] ? ' — trying the other transport' : ''}`, payload: undefined });
        this.resetTransport();
        if (!fallback) throw e;
      }
    }
    throw firstErr ?? new TransportError('Could not connect', 'connect');
  }

  private resetTransport(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.endpoint = null;
    this.sessionId = null;
    this.protocolVersion = null;
    this.getStream = null;
  }

  private async initialize(): Promise<{ result: Json; durationMs: number }> {
    const out = await this.request(
      'initialize',
      { protocolVersion: CLIENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'devhub-mcp-tester', title: 'devhub MCP tester', version: this.opts.clientVersion } },
      { timeoutMs: 15_000 },
    );
    if (out.error) throw Object.assign(new TransportError(`initialize failed: ${out.error.message} (JSON-RPC ${out.error.code})`, 'protocol'), { rpc: out.error });
    const result = out.result ?? {};
    this.protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : null;
    await this.notify('notifications/initialized');
    if (this.transport === 'streamable') void this.openGetStream(false);
    return { result, durationMs: out.durationMs };
  }

  /** Re-run initialize after the server dropped the session (HTTP 404 with Mcp-Session-Id). */
  async reinitialize(): Promise<{ result: Json; durationMs: number }> {
    this.stats.sessionReinits++;
    this.abort.abort();
    this.abort = new AbortController();
    this.sessionId = null;
    this.protocolVersion = null;
    this.getStream = null;
    this.record({ dir: 'local', kind: 'transport', note: 'Session expired (HTTP 404): starting a new session with initialize', payload: undefined });
    if (this.transport === 'sse') await this.openLegacyStream();
    return this.initialize();
  }

  async request(method: string, params?: Json, opts: { timeoutMs?: number; progress?: boolean; source?: string } = {}): Promise<RequestOutcome> {
    if (this.closed) throw new TransportError('Session is closed', 'closed');
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const progressToken = opts.progress ? `devhub-${id}` : undefined;
    const p: Json | undefined = progressToken ? { ...(params ?? {}), _meta: { ...((params?._meta as Json) ?? {}), progressToken } } : params;
    const msg: Json = { jsonrpc: '2.0', id, method, ...(p !== undefined ? { params: p } : {}) };
    return new Promise<RequestOutcome>((resolve, reject) => {
      const t0 = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        this.record({ dir: 'local', kind: 'transport', method, id, note: `No response within ${Math.round(timeoutMs / 1000)}s: sent notifications/cancelled`, payload: undefined });
        if (method !== 'initialize') void this.notify('notifications/cancelled', { requestId: id, reason: 'timeout (devhub MCP tester)' }).catch(() => undefined);
        reject(new TransportError(`No response to ${method} within ${Math.round(timeoutMs / 1000)}s`, 'timeout'));
      }, timeoutMs);
      this.pending.set(String(id), { method, t0, resolve, reject, timer, progressToken, progress: [], source: opts.source });
      this.record({ dir: 'out', kind: 'request', method, id, source: opts.source, payload: msg });
      this.post(msg, method).catch((err) => {
        const pend = this.pending.get(String(id));
        if (!pend) return;
        clearTimeout(pend.timer);
        this.pending.delete(String(id));
        reject(err);
      });
    });
  }

  async notify(method: string, params?: Json): Promise<void> {
    const msg: Json = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.record({ dir: 'out', kind: 'notification', method, payload: msg });
    await this.post(msg, method);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [k, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError('Session closed', 'closed'));
      this.pending.delete(k);
    }
    if (this.transport === 'streamable' && this.sessionId) {
      try {
        const res = await openHttp(this.opts.url, 'DELETE', this.baseHeaders(), undefined, 3000);
        res.resume();
        this.record({ dir: 'out', kind: 'transport', status: res.statusCode, note: `DELETE session → HTTP ${res.statusCode}${res.statusCode === 405 ? ' (server does not allow clients to end sessions)' : ''}`, payload: undefined });
      } catch {
        /* best effort */
      }
    }
    this.abort.abort();
  }

  // ------------------------------------------------------------------ sending

  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': 'devhub-mcp-tester', ...this.opts.headers, ...extra };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  private async post(msg: Json, method: string): Promise<void> {
    if (this.transport === 'sse') return this.postLegacy(msg, method);
    return this.postStreamable(msg, method);
  }

  private trafficStart(url: string, httpMethod: string, headers: Record<string, string>, body: string | null, method: string): string | null {
    const t = this.opts.traffic;
    if (!t) return null;
    const logId = t.start({
      projectId: this.opts.projectId,
      direction: 'outbound',
      protocol: 'http',
      method: httpMethod,
      url,
      reqHeaders: maskHeaders(headers),
      resolved: { purpose: 'MCP tester', mcpTester: { session: this.opts.testerSessionId, target: this.opts.label, method, transport: this.transport } },
    });
    const c = t.clip(body);
    t.update(logId, { reqBody: c.text, reqBodySize: c.size, reqTruncated: c.truncated });
    return logId;
  }

  private trafficFinish(logId: string | null, status: number | null, headers: Record<string, string> | null, body: string | null, error?: string): void {
    const t = this.opts.traffic;
    if (!t || !logId) return;
    const c = t.clip(body);
    if (error) t.finish(logId, { outcome: 'network_error', errorType: 'connection_failed', errorMessage: error, resStatus: status });
    else
      t.finish(logId, {
        resStatus: status,
        resHeaders: headers,
        resBody: c.text,
        resBodySize: c.size,
        resTruncated: c.truncated,
        outcome: status !== null && status < 400 ? 'ok' : 'rejected',
        errorType: status !== null && status < 400 ? null : 'app_error',
        errorMessage: status !== null && status < 400 ? null : `MCP server answered ${status}`,
      });
  }

  private async postStreamable(msg: Json, method: string): Promise<void> {
    const body = JSON.stringify(msg);
    const headers = this.baseHeaders({ 'content-type': 'application/json', accept: ACCEPT_POST });
    if (method === 'initialize') delete headers['mcp-protocol-version'];
    const logId = this.trafficStart(this.opts.url, 'POST', headers, body, method);
    const isRequest = msg.id !== undefined && msg.method !== undefined;
    let res: http.IncomingMessage;
    try {
      res = await openHttp(this.opts.url, 'POST', headers, body, isRequest ? 30_000 : 10_000, this.abort.signal);
    } catch (err) {
      this.trafficFinish(logId, null, null, null, (err as Error).message);
      throw err;
    }
    const status = res.statusCode ?? 0;
    const resHeaders = flatHeaders(res);
    const sid = resHeaders['mcp-session-id'];
    if (method === 'initialize' && sid) {
      this.sessionId = sid;
      if (!/^[\x21-\x7e]+$/.test(sid)) this.record({ dir: 'local', kind: 'invalid', note: 'Mcp-Session-Id contains characters outside visible ASCII (0x21–0x7E)', payload: sid });
    }
    const ct = String(resHeaders['content-type'] ?? '').toLowerCase();
    if (status === 404 && this.sessionId && method !== 'initialize') {
      const text = await readBody(res).catch(() => '');
      this.trafficFinish(logId, status, resHeaders, text);
      this.record({ dir: 'in', kind: 'transport', status, logId: logId ?? undefined, note: 'HTTP 404 for a request with Mcp-Session-Id: the server ended the session', payload: text || undefined });
      throw new TransportError('The MCP server ended the session (HTTP 404)', 'session_expired', 404, text);
    }
    if (status >= 400) {
      const text = await readBody(res).catch(() => '');
      this.trafficFinish(logId, status, resHeaders, text);
      this.record({ dir: 'in', kind: 'transport', status, logId: logId ?? undefined, note: `HTTP ${status} for ${method}`, payload: tryJson(text) });
      // A JSON-RPC error response in the body still answers the request.
      const parsed = tryJson(text) as Json | null;
      if (isRequest && parsed && typeof parsed === 'object' && parsed.error && parsed.id === msg.id) {
        this.dispatch(parsed, logId);
        return;
      }
      throw new TransportError(`HTTP ${status} from the MCP server${text ? `: ${text.slice(0, 300)}` : ''}`, 'http', status, text);
    }
    if (!isRequest) {
      // Notifications / responses: 202 Accepted with no body.
      const text = await readBody(res).catch(() => '');
      this.trafficFinish(logId, status, resHeaders, text);
      if (status !== 202) this.record({ dir: 'in', kind: 'transport', status, logId: logId ?? undefined, note: `HTTP ${status} for ${method} (the spec expects 202 Accepted)`, payload: text || undefined });
      return;
    }
    if (ct.includes('text/event-stream')) {
      await this.consumeSse(res, logId, resHeaders, String(msg.id));
      return;
    }
    const text = await readBody(res);
    this.trafficFinish(logId, status, resHeaders, text);
    if (status === 202 && !text) {
      this.record({ dir: 'in', kind: 'transport', status, note: `HTTP 202 with no body for request ${method}: the response must come as JSON or an SSE stream`, payload: undefined });
      return;
    }
    if (!ct.includes('json')) this.record({ dir: 'in', kind: 'invalid', status, note: `Unexpected Content-Type "${ct || '(none)'}" (expected application/json or text/event-stream)`, payload: text.slice(0, 2000) });
    this.dispatchText(text, logId);
  }

  /** Read an SSE response (POST or GET stream). Resumes with Last-Event-ID when it ends before `waitFor` is answered. */
  private consumeSse(res: http.IncomingMessage, logId: string | null, resHeaders: Record<string, string>, waitFor: string | null): Promise<void> {
    return new Promise((resolve) => {
      let raw = '';
      const parser = new SseParser((e) => {
        if (e.id !== null) {
          this.lastEventId = e.id;
          this.stats.lastEventIds++;
        }
        if (e.retry !== null) this.retryMs = e.retry;
        if (!e.data.trim()) return; // priming event (id + empty data)
        if (e.event !== 'message') {
          this.record({ dir: 'in', kind: 'invalid', note: `SSE event type "${e.event}" (MCP messages use the default "message" event)`, payload: e.data.slice(0, 2000) });
        }
        this.dispatchText(e.data, logId);
      });
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        if (raw.length < 512 * 1024) raw += c;
        parser.push(c);
      });
      const done = () => {
        parser.end();
        this.trafficFinish(logId, res.statusCode ?? 200, resHeaders, raw);
        if (waitFor && this.pending.has(waitFor) && !this.closed) {
          if (this.lastEventId) {
            this.record({ dir: 'local', kind: 'transport', note: `SSE stream ended before the response: resuming with GET + Last-Event-ID ${this.lastEventId} in ${this.retryMs} ms`, payload: undefined });
            setTimeout(() => void this.resume(waitFor, 3), this.retryMs);
          } else {
            this.record({ dir: 'local', kind: 'invalid', note: 'SSE stream ended without a response and without event ids (cannot resume)', payload: undefined });
          }
        }
        resolve();
      };
      res.on('end', done);
      res.on('error', done);
      res.on('aborted', done);
    });
  }

  private async resume(waitFor: string, attempts: number): Promise<void> {
    if (this.closed || !this.pending.has(waitFor) || attempts <= 0) return;
    try {
      const headers = this.baseHeaders({ accept: 'text/event-stream', ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}) });
      const res = await openHttp(this.opts.url, 'GET', headers, undefined, 10_000, this.abort.signal);
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        this.record({ dir: 'in', kind: 'transport', status: res.statusCode, note: `Resume GET → HTTP ${res.statusCode}`, payload: undefined });
        return;
      }
      await this.consumeSse(res, null, flatHeaders(res), null);
      if (this.pending.has(waitFor)) setTimeout(() => void this.resume(waitFor, attempts - 1), this.retryMs);
    } catch (err) {
      this.record({ dir: 'local', kind: 'transport', note: `Resume failed: ${(err as Error).message}`, payload: undefined });
    }
  }

  /** Streamable HTTP: the optional GET stream for server-initiated notifications and requests. */
  private async openGetStream(reconnect: boolean): Promise<void> {
    if (this.closed || this.transport !== 'streamable') return;
    try {
      const headers = this.baseHeaders({ accept: 'text/event-stream', ...(reconnect && this.lastEventId ? { 'last-event-id': this.lastEventId } : {}) });
      const res = await openHttp(this.opts.url, 'GET', headers, undefined, 10_000, this.abort.signal);
      const status = res.statusCode ?? 0;
      const ct = String(res.headers['content-type'] ?? '');
      if (status === 405 || status >= 400 || !ct.includes('text/event-stream')) {
        res.resume();
        this.getStream = 'unsupported';
        if (!reconnect) this.record({ dir: 'in', kind: 'transport', status, note: status === 405 ? 'GET stream: 405 (the server sends no messages outside of responses; allowed by the spec)' : `GET stream not available (HTTP ${status}${ct ? `, ${ct}` : ''})`, payload: undefined });
        return;
      }
      this.getStream = 'open';
      this.record({ dir: 'in', kind: 'transport', status, note: reconnect ? 'GET stream reconnected' : 'GET stream open: server notifications and requests arrive here', payload: undefined });
      const t0 = Date.now();
      await this.consumeSse(res, null, flatHeaders(res), null);
      if (this.closed) return;
      this.getStream = 'closed';
      // Server closed the stream: reconnect after `retry` (only if it lived for a while, to avoid hot loops).
      if (Date.now() - t0 > 2000) setTimeout(() => void this.openGetStream(true), Math.max(this.retryMs, 500));
    } catch (err) {
      if (this.closed) return;
      this.getStream = 'closed';
      if ((err as TransportError).code !== 'closed') this.record({ dir: 'local', kind: 'transport', note: `GET stream: ${(err as Error).message}`, payload: undefined });
    }
  }

  // ------------------------------------------------------------------ legacy HTTP+SSE

  private openLegacyStream(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      const timer = setTimeout(() => fail(new TransportError('No `endpoint` event within 5 s (not an HTTP+SSE MCP server?)', 'protocol')), 5000);
      const headers = { 'user-agent': 'devhub-mcp-tester', ...this.opts.headers, accept: 'text/event-stream' };
      openHttp(this.opts.url, 'GET', headers, undefined, 10_000, this.abort.signal)
        .then((res) => {
          const status = res.statusCode ?? 0;
          const ct = String(res.headers['content-type'] ?? '');
          if (status >= 400 || !ct.includes('text/event-stream')) {
            res.resume();
            clearTimeout(timer);
            return fail(new TransportError(`GET ${this.opts.url} → HTTP ${status}${ct ? ` (${ct})` : ''}: not an SSE stream`, status >= 400 ? 'http' : 'protocol', status));
          }
          this.record({ dir: 'in', kind: 'transport', status, note: 'HTTP+SSE stream open (legacy 2024-11-05 transport)', payload: undefined });
          const parser = new SseParser((e) => {
            if (e.event === 'endpoint') {
              try {
                const ep = new URL(e.data.trim(), this.opts.url).toString();
                this.endpoint = ep;
                const sid = new URL(ep).searchParams.get('sessionId') ?? new URL(ep).searchParams.get('session_id');
                if (sid) this.sessionId = sid;
                this.record({ dir: 'in', kind: 'transport', note: `endpoint event: POST messages to ${ep}`, payload: e.data });
                checkOutboundUrl(ep).then((c) => {
                  clearTimeout(timer);
                  if (!c.allowed) return fail(new TransportError(`blocked_by_allowlist: the endpoint ${ep}: ${c.reason}`, 'blocked'));
                  if (!settled) {
                    settled = true;
                    resolve();
                  }
                }, fail);
              } catch {
                fail(new TransportError(`Invalid endpoint event: ${e.data}`, 'protocol'));
              }
              return;
            }
            if (!e.data.trim()) return;
            this.dispatchText(e.data, null);
          });
          res.setEncoding('utf8');
          res.on('data', (c: string) => parser.push(c));
          const end = () => {
            parser.end();
            clearTimeout(timer);
            if (!settled) fail(new TransportError('SSE stream closed before the endpoint event', 'protocol'));
            else if (!this.closed) {
              this.record({ dir: 'in', kind: 'transport', note: 'HTTP+SSE stream closed by the server', payload: undefined });
              for (const [k, p] of this.pending) {
                clearTimeout(p.timer);
                p.reject(new TransportError('The SSE stream closed', 'closed'));
                this.pending.delete(k);
              }
            }
          };
          res.on('end', end);
          res.on('error', end);
          res.on('aborted', end);
        })
        .catch((e) => {
          clearTimeout(timer);
          fail(e);
        });
    });
  }

  private async postLegacy(msg: Json, method: string): Promise<void> {
    if (!this.endpoint) throw new TransportError('No SSE endpoint', 'closed');
    const body = JSON.stringify(msg);
    const headers = { 'user-agent': 'devhub-mcp-tester', ...this.opts.headers, 'content-type': 'application/json' };
    const logId = this.trafficStart(this.endpoint, 'POST', headers, body, method);
    let res: http.IncomingMessage;
    try {
      res = await openHttp(this.endpoint, 'POST', headers, body, 10_000, this.abort.signal);
    } catch (err) {
      this.trafficFinish(logId, null, null, null, (err as Error).message);
      throw err;
    }
    const text = await readBody(res).catch(() => '');
    const status = res.statusCode ?? 0;
    this.trafficFinish(logId, status, flatHeaders(res), text);
    if (status >= 400) {
      this.record({ dir: 'in', kind: 'transport', status, note: `HTTP ${status} for ${method}`, payload: tryJson(text) });
      if (status === 404) throw new TransportError('The MCP server does not know this SSE session (HTTP 404)', 'session_expired', 404, text);
      throw new TransportError(`HTTP ${status} from the MCP server${text ? `: ${text.slice(0, 300)}` : ''}`, 'http', status, text);
    }
    // Some servers answer in the POST body too; responses normally arrive on the SSE stream.
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) this.dispatchText(text, logId);
  }

  // ------------------------------------------------------------------ receiving

  private dispatchText(text: string, logId: string | null): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.stats.invalidMessages++;
      this.record({ dir: 'in', kind: 'invalid', note: 'Not valid JSON', payload: text.slice(0, 4000) });
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const m of list) this.dispatch(m as Json, logId);
  }

  private dispatch(m: Json, logId: string | null): void {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      this.stats.invalidMessages++;
      this.record({ dir: 'in', kind: 'invalid', note: 'JSON-RPC message must be an object', payload: m });
      return;
    }
    if (m.jsonrpc !== '2.0') {
      this.stats.invalidMessages++;
      this.record({ dir: 'in', kind: 'invalid', note: 'Missing "jsonrpc": "2.0"', payload: m });
    }
    const hasId = m.id !== undefined && m.id !== null;
    const method = typeof m.method === 'string' ? m.method : undefined;
    if (method && hasId) return this.onServerRequest(m, method, logId);
    if (method) return this.onNotification(m, method, logId);
    if (hasId && ('result' in m || 'error' in m)) {
      const key = String(m.id);
      const p = this.pending.get(key);
      const durationMs = p ? Date.now() - p.t0 : undefined;
      const isErr = m.error !== undefined;
      this.record({ dir: 'in', kind: isErr ? 'error' : 'response', method: p?.method, id: m.id as RpcId, durationMs, logId: logId ?? undefined, source: p?.source, payload: m });
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(key);
      const err = m.error as RpcError | undefined;
      p.resolve({
        result: isErr ? undefined : ((m.result as Json) ?? {}),
        error: isErr ? { code: Number(err?.code ?? 0), message: String(err?.message ?? ''), ...(err?.data !== undefined ? { data: err.data } : {}) } : undefined,
        durationMs: durationMs ?? 0,
        progress: p.progress,
      });
      return;
    }
    if ('error' in m && !hasId) {
      // Error without id (e.g. a parse error the server could not attribute).
      this.record({ dir: 'in', kind: 'error', logId: logId ?? undefined, note: 'JSON-RPC error without id', payload: m });
      return;
    }
    this.stats.invalidMessages++;
    this.record({ dir: 'in', kind: 'invalid', note: 'Neither a request, a notification nor a response', payload: m });
  }

  private onNotification(m: Json, method: string, logId: string | null): void {
    this.stats.notifications[method] = (this.stats.notifications[method] ?? 0) + 1;
    this.record({ dir: 'in', kind: 'notification', method, logId: logId ?? undefined, payload: m });
    const params = (m.params ?? {}) as Json;
    if (method === 'notifications/progress') {
      for (const p of this.pending.values()) if (p.progressToken !== undefined && String(params.progressToken) === p.progressToken) p.progress.push(params);
    }
    this.opts.onActivity?.('notification', { method, params });
  }

  private onServerRequest(m: Json, method: string, _logId: string | null): void {
    this.stats.serverRequests++;
    this.record({ dir: 'in', kind: 'request', method, id: m.id as RpcId, payload: m });
    // devhub declares no client capabilities (no sampling, roots or elicitation): only ping is answered with a result.
    const reply: Json =
      method === 'ping'
        ? { jsonrpc: '2.0', id: m.id, result: {} }
        : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `devhub MCP tester does not support ${method} (no client capabilities were declared)` } };
    this.record({ dir: 'out', kind: reply.error ? 'error' : 'response', method, id: m.id as RpcId, payload: reply });
    void this.post(reply, method).catch(() => undefined);
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text || undefined;
  }
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$|token|secret|key/i;

/** Mask a secret value: keeps the auth scheme and the last 4 characters ("Bearer ••••3f9a"). */
export function maskValue(v: string): string {
  if (!v) return v;
  const scheme = /^(Bearer|Basic|Token|Bot)\s+/i.exec(v)?.[0] ?? '';
  const rest = v.slice(scheme.length);
  return rest.length <= 8 ? `${scheme}••••••••` : `${scheme}••••${rest.slice(-4)}`;
}

export const isMasked = (v: unknown) => typeof v === 'string' && v.includes('••••');

/** Header map with secret-looking values masked (for logs and list responses). */
export function maskHeaders(h: Record<string, string>, all = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = all || SECRET_HEADER.test(k) ? maskValue(v) : v;
  return out;
}
