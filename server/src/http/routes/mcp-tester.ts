import type { FastifyInstance } from 'fastify';
import { inContainer } from '../../config.js';
import type { Hub } from '../../hub.js';
import { MCP_CHECKS } from '../../mcptester/checks.js';
import { KNOWN_PROTOCOL_VERSIONS } from '../../mcptester/client.js';
import type { TesterSession } from '../../mcptester/service.js';
import { HttpError } from '../../util.js';

type P = { slug: string };
type Q = Record<string, string | undefined>;
type Json = Record<string, unknown>;

const body = (req: { body?: unknown }): Json => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Json) : {});

/**
 * MCP tester: devhub acts as an MCP client of the developer's MCP server (Streamable HTTP or legacy HTTP+SSE).
 * Everything under /api/projects/:slug/mcp-tester.
 */
export async function registerMcpTesterRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const mt = hub.mcpTester;
  const base = '/api/projects/:slug/mcp-tester';
  const proj = (slug: string) => hub.projects.require(slug);
  const sess = (slug: string, sid: string): TesterSession => mt.requireSession(proj(slug), sid);
  const connectResult = async (s: TesterSession, checks: boolean) => {
    const report = checks ? await mt.runChecks(s).catch(() => null) : null;
    return { session: mt.summary(s), ...(report ? { checks: report } : {}) };
  };

  /** Overview: saved targets (header values masked), open sessions, devhub's own /mcp URL and the networking hints. */
  app.get<{ Params: P }>(base, async (req) => {
    const p = proj(req.params.slug);
    return {
      targets: mt.repo.listTargets(p.id).map((t) => mt.targetView(t)),
      sessions: mt.sessionsOf(p.id).map((s) => mt.summary(s)),
      self: { name: 'devhub (this server)', url: mt.selfUrl() },
      protocolVersions: KNOWN_PROTOCOL_VERSIONS,
      checks: MCP_CHECKS,
      idleTimeoutMs: mt.idleMs,
      inContainer: inContainer(),
    };
  });

  // ---------------- targets ----------------
  app.get<{ Params: P }>(`${base}/targets`, async (req) => mt.repo.listTargets(proj(req.params.slug).id).map((t) => mt.targetView(t)));
  app.post<{ Params: P }>(`${base}/targets`, async (req, reply) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const t = b.self === true ? mt.repo.getTarget(p.id, 'devhub') ?? mt.repo.createTarget(p.id, { name: 'devhub', url: mt.selfUrl(), notes: "devhub's own MCP server" }) : mt.repo.createTarget(p.id, b);
    hub.bus.publish({ type: 'mcptester.changed', projectId: p.id, data: { kind: 'targets' } });
    return reply.status(201).send(mt.targetView(t));
  });
  app.get<{ Params: P & { id: string } }>(`${base}/targets/:id`, async (req) => {
    const p = proj(req.params.slug);
    return mt.targetView(mt.repo.requireTarget(p.id, req.params.id));
  });
  app.patch<{ Params: P & { id: string } }>(`${base}/targets/:id`, async (req) => {
    const p = proj(req.params.slug);
    const t = mt.repo.updateTarget(p.id, req.params.id, body(req));
    hub.bus.publish({ type: 'mcptester.changed', projectId: p.id, data: { kind: 'targets' } });
    return mt.targetView(t);
  });
  app.delete<{ Params: P & { id: string } }>(`${base}/targets/:id`, async (req, reply) => {
    const p = proj(req.params.slug);
    const t = mt.repo.requireTarget(p.id, req.params.id);
    const s = mt.sessionForTarget(p.id, t.id);
    if (s) await mt.close(s);
    mt.repo.deleteTarget(p.id, t.id);
    hub.bus.publish({ type: 'mcptester.changed', projectId: p.id, data: { kind: 'targets' } });
    return reply.status(204).send();
  });

  // ---------------- connect / sessions ----------------
  /**
   * { target } (id or name) or { url, headers?, transport? } (ad hoc), or { self: true } for devhub's own /mcp.
   * reuse: keep an open session of that target; checks: run the checks right away (default true).
   */
  app.post<{ Params: P }>(`${base}/connect`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const s = await mt.connect(p, b.self === true ? { url: mt.selfUrl(), name: 'devhub (this server)' } : { target: b.target as string | undefined, url: b.url as string | undefined, headers: b.headers, transport: b.transport as string | undefined, name: b.name as string | undefined, reuse: b.reuse === true });
    return connectResult(s, b.checks !== false);
  });
  app.post<{ Params: P & { id: string } }>(`${base}/targets/:id/connect`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const s = await mt.connect(p, { target: req.params.id, reuse: b.reuse === true });
    return connectResult(s, b.checks !== false);
  });
  app.get<{ Params: P }>(`${base}/sessions`, async (req) => mt.sessionsOf(proj(req.params.slug).id).map((s) => mt.summary(s)));
  app.get<{ Params: P & { sid: string } }>(`${base}/sessions/:sid`, async (req) => mt.summary(sess(req.params.slug, req.params.sid)));
  app.delete<{ Params: P & { sid: string } }>(`${base}/sessions/:sid`, async (req, reply) => {
    await mt.close(sess(req.params.slug, req.params.sid));
    return reply.status(204).send();
  });

  // ---------------- lists ----------------
  const listRoute = (path: string, kind: 'tools' | 'resources' | 'resourceTemplates' | 'prompts') =>
    app.get<{ Params: P & { sid: string }; Querystring: Q }>(`${base}/sessions/:sid/${path}`, async (req) => {
      const s = sess(req.params.slug, req.params.sid);
      const st = await mt.list(s, kind, { refresh: req.query.refresh === '1' || req.query.refresh === 'true' });
      return { [kind]: st.items ?? [], supported: mt.capable(s, kind), error: st.error, ms: st.ms, pages: st.pages, fetchedAt: st.fetchedAt, stale: s.stale.has(kind) };
    });
  listRoute('tools', 'tools');
  listRoute('resources', 'resources');
  listRoute('resource-templates', 'resourceTemplates');
  listRoute('prompts', 'prompts');

  // ---------------- operations ----------------
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/call`, async (req) => {
    const s = sess(req.params.slug, req.params.sid);
    const b = body(req);
    return mt.callTool(s, String(b.name ?? ''), (b.arguments ?? {}) as Json, { timeoutMs: b.timeoutMs as number | undefined });
  });
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/read`, async (req) => {
    const s = sess(req.params.slug, req.params.sid);
    const uri = String(body(req).uri ?? '');
    if (!uri) throw new HttpError(400, 'uri is required');
    return mt.simple(s, 'resources/read', { uri });
  });
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/prompt`, async (req) => {
    const s = sess(req.params.slug, req.params.sid);
    const b = body(req);
    if (!b.name) throw new HttpError(400, 'name is required');
    const args = Object.fromEntries(Object.entries((b.arguments ?? {}) as Json).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    return mt.simple(s, 'prompts/get', { name: String(b.name), arguments: args });
  });
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/ping`, async (req) => mt.ping(sess(req.params.slug, req.params.sid)));
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/subscribe`, async (req) => {
    const b = body(req);
    if (!b.uri) throw new HttpError(400, 'uri is required');
    return mt.subscribe(sess(req.params.slug, req.params.sid), String(b.uri), b.subscribe !== false);
  });
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/logging-level`, async (req) => {
    const level = String(body(req).level ?? 'info');
    if (!['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'].includes(level)) throw new HttpError(400, 'level must be an RFC 5424 level (debug … emergency)');
    return mt.simple(sess(req.params.slug, req.params.sid), 'logging/setLevel', { level });
  });
  /** Raw JSON-RPC request (any method) for things the UI does not cover. */
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/request`, async (req) => {
    const b = body(req);
    if (!b.method) throw new HttpError(400, 'method is required');
    return mt.simple(sess(req.params.slug, req.params.sid), String(b.method), (b.params as Json) ?? undefined);
  });

  // ---------------- log ----------------
  app.get<{ Params: P & { sid: string }; Querystring: Q }>(`${base}/sessions/:sid/log`, async (req) => {
    const s = sess(req.params.slug, req.params.sid);
    const after = Number(req.query.after ?? 0) || 0;
    return { entries: mt.logAfter(s, after, Math.min(Number(req.query.limit ?? 500) || 500, 2000)), lastSeq: s.client.log.at(-1)?.seq ?? 0, serverLogs: s.logs.slice(-200) };
  });
  app.delete<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/log`, async (req, reply) => {
    sess(req.params.slug, req.params.sid).client.clearLog();
    return reply.status(204).send();
  });

  // ---------------- checks ----------------
  app.get(`/api/mcp-tester/checks`, async () => MCP_CHECKS);
  app.post<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/checks`, async (req) => mt.runChecks(sess(req.params.slug, req.params.sid)));
  app.get<{ Params: P & { sid: string } }>(`${base}/sessions/:sid/checks`, async (req) => {
    const s = sess(req.params.slug, req.params.sid);
    if (!s.checks) throw new HttpError(404, 'No checks have run in this session yet (POST to run them)');
    return s.checks;
  });

  // ---------------- saved calls ----------------
  app.get<{ Params: P & { id: string } }>(`${base}/targets/:id/saved`, async (req) => {
    const p = proj(req.params.slug);
    return mt.repo.listCalls(mt.repo.requireTarget(p.id, req.params.id).id);
  });
  app.post<{ Params: P & { id: string } }>(`${base}/targets/:id/saved`, async (req, reply) => {
    const p = proj(req.params.slug);
    const c = mt.repo.createCall(mt.repo.requireTarget(p.id, req.params.id), body(req));
    hub.bus.publish({ type: 'mcptester.changed', projectId: p.id, data: { kind: 'saved' } });
    return reply.status(201).send(c);
  });
  app.patch<{ Params: P & { cid: string } }>(`${base}/saved/:cid`, async (req) => {
    const p = proj(req.params.slug);
    return mt.repo.updateCall(p.id, req.params.cid, body(req));
  });
  app.delete<{ Params: P & { cid: string } }>(`${base}/saved/:cid`, async (req, reply) => {
    const p = proj(req.params.slug);
    mt.repo.deleteCall(p.id, req.params.cid);
    hub.bus.publish({ type: 'mcptester.changed', projectId: p.id, data: { kind: 'saved' } });
    return reply.status(204).send();
  });
  app.post<{ Params: P & { cid: string } }>(`${base}/saved/:cid/run`, async (req) => {
    const p = proj(req.params.slug);
    const c = mt.repo.requireCall(p.id, req.params.cid);
    return mt.runSaved(p, c.targetId, { ids: [c.id] });
  });
  /** Run all saved calls of a target (connects if needed): { passed, failed, results: [...] }. ?ids=a,b runs a subset. */
  app.post<{ Params: P & { id: string } }>(`${base}/targets/:id/run-saved`, async (req) => {
    const p = proj(req.params.slug);
    const b = body(req);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : undefined;
    return mt.runSaved(p, req.params.id, { ids });
  });
}
