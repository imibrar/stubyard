import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { HttpError, newId } from '../util.js';
import { contentBlockProblems, runMcpChecks, validateStructured, type CallObservation, type CheckInput, type CheckReport } from './checks.js';
import { McpClient, TransportError, maskHeaders, type LogEntry, type RequestOutcome, type RpcError, type TransportPref } from './client.js';
import { McpTesterRepo, normalizeHeaders, publicTarget, validateUrl, type McpTarget, type SavedCall, type SavedCallResult } from './repo.js';

type Json = Record<string, unknown>;
type ListKind = 'tools' | 'resources' | 'resourceTemplates' | 'prompts';

const LIST: Record<ListKind, { method: string; key: string; cap: string }> = {
  tools: { method: 'tools/list', key: 'tools', cap: 'tools' },
  resources: { method: 'resources/list', key: 'resources', cap: 'resources' },
  resourceTemplates: { method: 'resources/templates/list', key: 'resourceTemplates', cap: 'resources' },
  prompts: { method: 'prompts/list', key: 'prompts', cap: 'prompts' },
};

const VERSION = '0.7.0';
const MAX_SESSIONS = 30;
const MAX_PAGES = 50;

export interface ListState {
  items: Json[] | null;
  error: RpcError | string | null;
  ms: number;
  pages: number;
  repeatedCursor?: boolean;
  fetchedAt: string;
}

export interface TesterSession {
  id: string;
  projectId: string;
  targetId: string | null;
  label: string;
  url: string;
  transportPref: TransportPref;
  client: McpClient;
  init: Json;
  initMs: number;
  connectedAt: string;
  lastUsedAt: number;
  lists: Partial<Record<ListKind, ListState>>;
  calls: CallObservation[];
  ping: { ok: boolean; ms: number; error?: string } | null;
  probe: CheckInput['unknownToolProbe'];
  checks: CheckReport | null;
  subscriptions: Set<string>;
  /** Server notifications/message (logging) entries, newest last. */
  logs: { at: string; level: string; logger?: string; data: unknown }[];
  /** list_changed notifications seen since the list was last fetched. */
  stale: Set<ListKind>;
}

export interface CallOutcome {
  tool: string;
  arguments: Json;
  /** result = tools/call answered (check isError); rpc_error = JSON-RPC error; transport_error = no answer. */
  kind: 'result' | 'rpc_error' | 'transport_error';
  durationMs: number;
  result?: Json;
  isError?: boolean;
  rpcError?: RpcError;
  error?: string;
  /** structuredContent vs. outputSchema: null = the tool has no outputSchema. */
  validation: { hasOutputSchema: boolean; hasStructured: boolean; errors: string[] } | null;
  contentProblems: string[];
  progress: Json[];
  logSeq: { from: number; to: number };
}

/** What an embedding feature (e.g. a later chat page) gets from openClient(). */
export interface McpClientHandle {
  session: TesterSession;
  listTools(refresh?: boolean): Promise<Json[]>;
  callTool(name: string, args: Json, opts?: { timeoutMs?: number }): Promise<CallOutcome>;
}

export class McpTesterService {
  readonly repo: McpTesterRepo;
  private sessions = new Map<string, TesterSession>();
  private sweep: NodeJS.Timeout;
  private publishTimers = new Map<string, NodeJS.Timeout>();
  idleMs = 30 * 60_000;

  constructor(private hub: Hub) {
    this.repo = new McpTesterRepo(hub.db);
    this.sweep = setInterval(() => this.sweepIdle(), 60_000);
    this.sweep.unref();
    hub.bus.subscribe((e) => {
      if (e.type === 'project.deleted' && e.projectId) for (const s of this.sessions.values()) if (s.projectId === e.projectId) void this.close(s);
    });
  }

  /** URL of stubyard's own MCP endpoint, as reachable from stubyard itself. */
  selfUrl(): string {
    return `http://127.0.0.1:${this.hub.config.httpPort}/mcp`;
  }

  // ------------------------------------------------------------------ sessions

  sessionsOf(projectId: string): TesterSession[] {
    return [...this.sessions.values()].filter((s) => s.projectId === projectId);
  }

  requireSession(project: Project, sid: string): TesterSession {
    const s = this.sessions.get(sid);
    if (!s || s.projectId !== project.id) throw new HttpError(404, `MCP tester session "${sid}" not found (it may have timed out after ${Math.round(this.idleMs / 60000)} minutes idle; connect again)`);
    s.lastUsedAt = Date.now();
    return s;
  }

  /** Session for a saved target: an open one is reused unless `fresh`. */
  sessionForTarget(projectId: string, targetId: string): TesterSession | null {
    return [...this.sessions.values()].find((s) => s.projectId === projectId && s.targetId === targetId && !s.client.closed) ?? null;
  }

  async connect(project: Project, opts: { target?: string; url?: string; headers?: unknown; transport?: string; name?: string; reuse?: boolean; source?: string }): Promise<TesterSession> {
    let target: McpTarget | null = null;
    if (opts.target) {
      target = this.repo.requireTarget(project.id, opts.target);
      if (opts.reuse) {
        const existing = this.sessionForTarget(project.id, target.id);
        if (existing) {
          existing.lastUsedAt = Date.now();
          return existing;
        }
      } else {
        const existing = this.sessionForTarget(project.id, target.id);
        if (existing) await this.close(existing);
      }
    } else if (!opts.url) throw new HttpError(400, 'Pass a saved `target` (id or name) or a `url`');
    const url = target ? target.url : validateUrl(opts.url);
    const headers = target ? target.headers : normalizeHeaders(opts.headers);
    const transport = (target ? target.transport : ((opts.transport as TransportPref) ?? 'auto')) as TransportPref;
    if (!['auto', 'streamable', 'sse'].includes(transport)) throw new HttpError(400, 'transport must be auto, streamable or sse');
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) await this.close(oldest);
    }
    const id = `mt_${newId()}`;
    const label = target?.name ?? opts.name ?? new URL(url).host;
    let session: TesterSession | null = null;
    const client = new McpClient({
      url,
      headers,
      transport,
      projectId: project.id,
      traffic: this.hub.traffic,
      label,
      testerSessionId: id,
      clientVersion: VERSION,
      onActivity: (kind, data) => {
        if (session && kind === 'notification') this.onNotification(session, data as { method: string; params: Json });
        this.publish(project.id, id, kind);
      },
    });
    let init: { result: Json; durationMs: number };
    try {
      init = await client.connect();
    } catch (err) {
      await client.close().catch(() => undefined);
      const e = err as TransportError;
      throw new HttpError(e.code === 'blocked' ? 403 : 502, e.message, { code: e.code, status: e.status, log: client.log.slice(-20) });
    }
    session = {
      id,
      projectId: project.id,
      targetId: target?.id ?? null,
      label,
      url,
      transportPref: transport,
      client,
      init: init.result,
      initMs: init.durationMs,
      connectedAt: new Date().toISOString(),
      lastUsedAt: Date.now(),
      lists: {},
      calls: [],
      ping: null,
      probe: null,
      checks: null,
      subscriptions: new Set(),
      logs: [],
      stale: new Set(),
    };
    this.sessions.set(id, session);
    if (target) this.repo.touchTarget(target.id);
    this.publish(project.id, id, 'connected');
    return session;
  }

  /**
   * Reusable entry point for other features (e.g. an AI chat page whose model calls a target's tools): returns an
   * open session for a saved target (reused when one is open) with list/call helpers. Every exchange lands in the
   * same session log, tagged with `source`.
   */
  async openClient(project: Project, targetRef: string, opts: { source?: string } = {}): Promise<McpClientHandle> {
    const session = await this.connect(project, { target: targetRef, reuse: true, source: opts.source });
    const source = opts.source ?? 'tester';
    return {
      session,
      listTools: async (refresh = false) => (await this.list(session, 'tools', { refresh, source })).items ?? [],
      callTool: (name, args, o = {}) => this.callTool(session, name, args, { ...o, source }),
    };
  }

  async close(s: TesterSession): Promise<void> {
    this.sessions.delete(s.id);
    await s.client.close().catch(() => undefined);
    this.publish(s.projectId, s.id, 'closed');
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweep);
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) if (now - s.lastUsedAt > this.idleMs) void this.close(s);
  }

  private publish(projectId: string, sessionId: string, kind: string): void {
    const key = `${sessionId}`;
    if (kind === 'log' && this.publishTimers.has(key)) return;
    clearTimeout(this.publishTimers.get(key));
    this.publishTimers.set(
      key,
      setTimeout(() => {
        this.publishTimers.delete(key);
        this.hub.bus.publish({ type: 'mcptester.changed', projectId, data: { session: sessionId, kind } });
      }, kind === 'log' ? 300 : 0),
    );
  }

  private onNotification(s: TesterSession, n: { method: string; params: Json }): void {
    const m = /^notifications\/(tools|resources|prompts)\/list_changed$/.exec(n.method);
    if (m) {
      const kinds: ListKind[] = m[1] === 'resources' ? ['resources', 'resourceTemplates'] : [m[1] as ListKind];
      for (const k of kinds) s.stale.add(k);
    }
    if (n.method === 'notifications/message') {
      s.logs.push({ at: new Date().toISOString(), level: String(n.params?.level ?? 'info'), logger: n.params?.logger as string | undefined, data: n.params?.data });
      if (s.logs.length > 500) s.logs.splice(0, s.logs.length - 500);
    }
  }

  /** Run a JSON-RPC request; transparently starts a new MCP session once if the server ended it (HTTP 404). */
  private async rpc(s: TesterSession, method: string, params: Json | undefined, opts: { timeoutMs?: number; progress?: boolean; source?: string } = {}): Promise<RequestOutcome> {
    s.lastUsedAt = Date.now();
    try {
      return await s.client.request(method, params, opts);
    } catch (err) {
      if ((err as TransportError).code === 'session_expired') {
        const init = await s.client.reinitialize();
        s.init = init.result;
        s.initMs = init.durationMs;
        this.publish(s.projectId, s.id, 'reinitialized');
        return s.client.request(method, params, opts);
      }
      throw err;
    }
  }

  private transportFail(err: unknown): HttpError {
    const e = err as TransportError;
    return new HttpError(e instanceof TransportError ? 502 : 500, e.message, { code: (e as TransportError).code });
  }

  // ------------------------------------------------------------------ lists

  capable(s: TesterSession, kind: ListKind): boolean {
    return ((s.init.capabilities ?? {}) as Json)[LIST[kind].cap] !== undefined;
  }

  async list(s: TesterSession, kind: ListKind, opts: { refresh?: boolean; force?: boolean; source?: string } = {}): Promise<ListState> {
    const cached = s.lists[kind];
    if (cached && !opts.refresh && !s.stale.has(kind)) return cached;
    const spec = LIST[kind];
    if (!this.capable(s, kind) && !opts.force) {
      const st: ListState = { items: null, error: `The server does not declare the ${spec.cap} capability`, ms: 0, pages: 0, fetchedAt: new Date().toISOString() };
      s.lists[kind] = st;
      return st;
    }
    const items: Json[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let ms = 0;
    let pages = 0;
    let repeatedCursor = false;
    let error: RpcError | string | null = null;
    try {
      for (;;) {
        const out = await this.rpc(s, spec.method, cursor ? { cursor } : undefined, { source: opts.source ?? 'tester' });
        ms += out.durationMs;
        pages++;
        if (out.error) {
          error = out.error;
          break;
        }
        const arr = (out.result ?? {})[spec.key];
        if (!Array.isArray(arr)) {
          error = `${spec.method} result has no "${spec.key}" array`;
          break;
        }
        items.push(...(arr as Json[]));
        const next = (out.result ?? {}).nextCursor;
        if (typeof next !== 'string' || !next) break;
        if (seen.has(next)) {
          repeatedCursor = true;
          break;
        }
        seen.add(next);
        cursor = next;
        if (pages >= MAX_PAGES) break;
      }
    } catch (err) {
      error = (err as Error).message;
    }
    const st: ListState = { items: error && !items.length ? null : items, error, ms, pages, ...(repeatedCursor ? { repeatedCursor } : {}), fetchedAt: new Date().toISOString() };
    s.lists[kind] = st;
    s.stale.delete(kind);
    return st;
  }

  // ------------------------------------------------------------------ calls

  async callTool(s: TesterSession, name: string, args: Json, opts: { timeoutMs?: number; source?: string } = {}): Promise<CallOutcome> {
    if (!name) throw new HttpError(400, 'name is required');
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new HttpError(400, 'arguments must be a JSON object');
    const tools = (await this.list(s, 'tools', { source: opts.source })).items ?? [];
    const tool = tools.find((t) => t.name === name);
    const from = s.client.log.at(-1)?.seq ?? 0;
    const t0 = Date.now();
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs ?? 60_000), 1000), 300_000);
    let out: RequestOutcome;
    try {
      out = await this.rpc(s, 'tools/call', { name, arguments: args ?? {} }, { timeoutMs, progress: true, source: opts.source ?? 'tester' });
    } catch (err) {
      const o: CallOutcome = { tool: name, arguments: args ?? {}, kind: 'transport_error', durationMs: Date.now() - t0, error: (err as Error).message, validation: null, contentProblems: [], progress: [], logSeq: { from: from + 1, to: s.client.log.at(-1)?.seq ?? from } };
      return o;
    }
    const logSeq = { from: from + 1, to: s.client.log.at(-1)?.seq ?? from };
    if (out.error) {
      this.observe(s, { tool: name, at: new Date().toISOString(), durationMs: out.durationMs, rpcError: { code: out.error.code, message: out.error.message } });
      return { tool: name, arguments: args ?? {}, kind: 'rpc_error', durationMs: out.durationMs, rpcError: out.error, validation: null, contentProblems: [], progress: out.progress, logSeq };
    }
    const r = out.result ?? {};
    const content = Array.isArray(r.content) ? r.content : null;
    const contentProblems = content ? content.flatMap(contentBlockProblems) : ['result has no "content" array'];
    const hasStructured = r.structuredContent !== undefined && r.structuredContent !== null;
    const isError = r.isError === true;
    let validation: CallOutcome['validation'] = null;
    if (tool?.outputSchema !== undefined) {
      const errors = hasStructured ? validateStructured(tool.outputSchema, r.structuredContent) : isError ? [] : ['no structuredContent'];
      validation = { hasOutputSchema: true, hasStructured, errors };
    }
    this.observe(s, {
      tool: name,
      at: new Date().toISOString(),
      durationMs: out.durationMs,
      isError,
      hasStructured,
      hasText: !!content?.some((b) => (b as Json)?.type === 'text'),
      schemaErrors: validation && hasStructured ? validation.errors : null,
      contentProblems,
    });
    return { tool: name, arguments: args ?? {}, kind: 'result', durationMs: out.durationMs, result: r, isError, validation, contentProblems, progress: out.progress, logSeq };
  }

  private observe(s: TesterSession, o: CallObservation): void {
    s.calls.push(o);
    if (s.calls.length > 200) s.calls.splice(0, s.calls.length - 200);
  }

  async simple(s: TesterSession, method: string, params: Json | undefined, source = 'tester'): Promise<{ result?: Json; error?: RpcError; durationMs: number }> {
    try {
      const out = await this.rpc(s, method, params, { source });
      return { result: out.result, error: out.error, durationMs: out.durationMs };
    } catch (err) {
      throw this.transportFail(err);
    }
  }

  async ping(s: TesterSession, source = 'tester'): Promise<{ ok: boolean; ms: number; error?: string }> {
    try {
      const out = await this.rpc(s, 'ping', undefined, { timeoutMs: 10_000, source });
      s.ping = out.error ? { ok: false, ms: out.durationMs, error: `${out.error.message} (JSON-RPC ${out.error.code})` } : { ok: true, ms: out.durationMs };
    } catch (err) {
      s.ping = { ok: false, ms: 0, error: (err as Error).message };
    }
    return s.ping;
  }

  async subscribe(s: TesterSession, uri: string, on: boolean): Promise<{ result?: Json; error?: RpcError; durationMs: number }> {
    const r = await this.simple(s, on ? 'resources/subscribe' : 'resources/unsubscribe', { uri });
    if (!r.error) on ? s.subscriptions.add(uri) : s.subscriptions.delete(uri);
    return r;
  }

  // ------------------------------------------------------------------ checks

  async runChecks(s: TesterSession, source = 'checks'): Promise<CheckReport> {
    const lists: CheckInput['lists'] = { tools: undefined, resources: undefined, resourceTemplates: undefined, prompts: undefined };
    for (const k of Object.keys(LIST) as ListKind[]) {
      // The tools list is always fetched (to catch an undeclared capability); the others only when declared.
      if (k !== 'tools' && !this.capable(s, k)) continue;
      const st = await this.list(s, k, { refresh: true, force: k === 'tools', source });
      lists[k] = { items: st.items, error: st.error, ms: st.ms, repeatedCursor: st.repeatedCursor };
    }
    await this.ping(s, source);
    if (this.capable(s, 'tools')) {
      try {
        const out = await this.rpc(s, 'tools/call', { name: '__stubyard_probe_unknown_tool__', arguments: {} }, { timeoutMs: 10_000, source });
        s.probe = { rpcError: out.error ? { code: out.error.code, message: out.error.message } : null, isError: out.result?.isError === true, ms: out.durationMs };
      } catch {
        s.probe = null;
      }
    }
    s.checks = runMcpChecks({
      init: s.init,
      protocolVersion: s.client.protocolVersion,
      initMs: s.initMs,
      ping: s.ping,
      lists,
      calls: s.calls,
      unknownToolProbe: s.probe,
      notifications: s.client.stats.notifications,
      invalidMessages: s.client.stats.invalidMessages,
    });
    this.publish(s.projectId, s.id, 'checks');
    return s.checks;
  }

  // ------------------------------------------------------------------ saved calls

  evaluate(call: SavedCall, o: CallOutcome): SavedCallResult {
    const failures: string[] = [];
    const e = call.expect;
    if (o.kind === 'transport_error') failures.push(`No answer: ${o.error}`);
    else if (o.kind === 'rpc_error') failures.push(`JSON-RPC error ${o.rpcError?.code}: ${o.rpcError?.message}`);
    else {
      const wantErr = e.isError ?? false;
      if (!!o.isError !== wantErr) failures.push(wantErr ? 'expected isError: true, got a successful result' : `isError: true${previewOf(o.result) ? ` (${previewOf(o.result).slice(0, 160)})` : ''}`);
      if (e.contains && !resultText(o.result).includes(e.contains)) failures.push(`result does not contain "${e.contains}"`);
      if (e.validOutput !== false && o.validation && o.validation.errors.length && !o.isError) failures.push(`structuredContent vs outputSchema: ${o.validation.errors.slice(0, 3).join('; ')}`);
    }
    if (e.maxMs && o.durationMs > e.maxMs) failures.push(`took ${o.durationMs} ms (limit ${e.maxMs} ms)`);
    return {
      pass: failures.length === 0,
      ranAt: new Date().toISOString(),
      durationMs: o.durationMs,
      failures,
      isError: o.isError,
      rpcError: o.rpcError ? { code: o.rpcError.code, message: o.rpcError.message } : null,
      error: o.error ?? null,
      preview: previewOf(o.result).slice(0, 400),
    };
  }

  async runSaved(project: Project, targetRef: string, opts: { ids?: string[]; source?: string } = {}): Promise<{ target: string; session: string; passed: number; failed: number; durationMs: number; results: (SavedCallResult & { id: string; name: string; tool: string })[] }> {
    const target = this.repo.requireTarget(project.id, targetRef);
    const calls = this.repo.listCalls(target.id).filter((c) => !opts.ids?.length || opts.ids.includes(c.id));
    const s = await this.connect(project, { target: target.id, reuse: true, source: opts.source });
    const t0 = Date.now();
    const results = [];
    for (const c of calls) {
      const o = await this.callTool(s, c.tool, c.arguments, { source: opts.source ?? 'saved' });
      const r = this.evaluate(c, o);
      this.repo.setCallResult(c.id, r);
      results.push({ id: c.id, name: c.name, tool: c.tool, ...r });
    }
    this.publish(project.id, s.id, 'saved');
    return { target: target.name, session: s.id, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, durationMs: Date.now() - t0, results };
  }

  // ------------------------------------------------------------------ views

  summary(s: TesterSession) {
    const c = s.client;
    return {
      id: s.id,
      targetId: s.targetId,
      label: s.label,
      url: s.url,
      transport: c.transport,
      transportPref: s.transportPref,
      protocolVersion: c.protocolVersion,
      mcpSessionId: c.sessionId,
      getStream: c.getStream,
      endpoint: c.endpoint,
      serverInfo: (s.init.serverInfo ?? null) as Json | null,
      capabilities: (s.init.capabilities ?? {}) as Json,
      instructions: typeof s.init.instructions === 'string' ? s.init.instructions : null,
      initMs: s.initMs,
      connectedAt: s.connectedAt,
      lastUsedAt: new Date(s.lastUsedAt).toISOString(),
      idleTimeoutMs: this.idleMs,
      closed: c.closed,
      stats: { ...c.stats, messages: c.log.length, lastSeq: c.log.at(-1)?.seq ?? 0 },
      stale: [...s.stale],
      subscriptions: [...s.subscriptions],
      checks: s.checks ? { ranAt: s.checks.ranAt, summary: s.checks.summary } : null,
      headers: maskHeaders(c.opts.headers, true),
    };
  }

  logAfter(s: TesterSession, after = 0, limit = 500): LogEntry[] {
    const out = s.client.log.filter((e) => e.seq > after);
    return out.slice(-limit);
  }

  targetView(t: McpTarget) {
    const s = this.sessionForTarget(t.projectId, t.id);
    return { ...publicTarget(t), savedCalls: this.repo.listCalls(t.id).length, session: s ? s.id : null };
  }
}

function resultText(r: Json | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  for (const b of (Array.isArray(r.content) ? r.content : []) as Json[]) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    if (b?.type === 'resource' && typeof (b.resource as Json)?.text === 'string') parts.push(String((b.resource as Json).text));
    if (b?.type === 'resource_link') parts.push(String(b.uri ?? ''));
  }
  if (r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return parts.join('\n');
}

function previewOf(r: Json | undefined): string {
  return resultText(r).replace(/\s+/g, ' ').trim();
}
