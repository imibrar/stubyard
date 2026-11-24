import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { AuditEntry, AuditFilter } from '../../access/pg-store.js';
import { HttpError } from '../../util.js';

type Query = { user?: string; project?: string; action?: string; from?: string; to?: string; q?: string; before?: string; limit?: string; format?: string };

/** Rows a CSV export holds at most. */
const CSV_MAX_ROWS = 50_000;
const PAGE_MAX = 500;

/**
 * The audit log (Teams mode, docs/GUIDE.md "Audit log"): GET /api/audit for instance admins (every row) and
 * GET /api/projects/:slug/audit for project admins (rows of that project only, from the project's creation on, without
 * client addresses). Newest first, paged by id (`before` = `nextBefore` of the previous page); ?format=csv
 * downloads the filtered rows. In Open and Single admin mode they answer 404 (there is no audit log there).
 */
export async function registerAuditRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const access = hub.access;
  const teamsOnly = (req: FastifyRequest) => {
    if (!access.teams) throw new HttpError(404, 'The audit log needs Teams mode: set STUBYARD_DATABASE_URL (with the env admin)');
    if (!req.principal) throw new HttpError(401, 'Sign in required');
  };

  app.get<{ Querystring: Query }>('/api/audit', async (req, reply) => {
    teamsOnly(req);
    return answer(req.query, reply, { project: str(req.query.project) }, true);
  });

  app.get('/api/audit/actions', async (req) => {
    teamsOnly(req);
    return { actions: await access.auditActions(null) };
  });

  app.get<{ Params: { slug: string }; Querystring: Query }>('/api/projects/:slug/audit', async (req, reply) => {
    teamsOnly(req);
    const p = hub.projects.require(req.params.slug);
    // A slug can be reused after a delete: rows of an earlier project with the same slug stay hidden.
    const floor = new Date(Date.parse(p.createdAt) - 60_000).toISOString();
    return answer(req.query, reply, { project: p.slug, floor }, false);
  });

  app.get<{ Params: { slug: string } }>('/api/projects/:slug/audit/actions', async (req) => {
    teamsOnly(req);
    const p = hub.projects.require(req.params.slug);
    return { actions: await access.auditActions(p.slug) };
  });

  async function answer(q: Query, reply: FastifyReply, scope: { project: string | null; floor?: string }, withIp: boolean) {
    const f = parseFilter(q, scope);
    const view = (e: AuditEntry) => ({
      id: e.id,
      at: e.at,
      user: e.userId || e.userEmail ? { id: e.userId, email: e.userEmail } : null,
      action: e.action,
      project: e.projectSlug ?? null,
      target: e.target ?? null,
      detail: e.detail ?? {},
      ...(withIp ? { ip: e.ip ?? null } : {}),
    });
    reply.header('cache-control', 'no-store');
    if (q.format === 'csv') {
      const rows: AuditEntry[] = [];
      let before = f.before ?? null;
      while (rows.length < CSV_MAX_ROWS) {
        const page = await access.queryAudit({ ...f, before, limit: 1000 });
        rows.push(...page.entries);
        if (page.nextBefore === null) break;
        before = page.nextBefore;
      }
      const head = ['id', 'at', 'user_email', 'user_id', 'action', 'project', 'target', ...(withIp ? ['ip'] : []), 'detail'];
      const lines = [head.join(',')];
      for (const e of rows.slice(0, CSV_MAX_ROWS)) {
        lines.push([e.id, e.at, e.userEmail, e.userId, e.action, e.projectSlug, e.target, ...(withIp ? [e.ip] : []), JSON.stringify(e.detail ?? {})].map(csvCell).join(','));
      }
      const name = `stubyard-audit${scope.project ? '-' + scope.project : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`);
      return reply.send(lines.join('\r\n') + '\r\n');
    }
    const page = await access.queryAudit(f);
    return { entries: page.entries.map(view), nextBefore: page.nextBefore };
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A time filter: an ISO time, or a date (YYYY-MM-DD; for `to` the whole day counts). */
function time(v: unknown, name: 'from' | 'to'): string | null {
  const s = str(v);
  if (!s) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const t = Date.parse(dateOnly ? s + 'T00:00:00Z' : s);
  if (Number.isNaN(t)) throw new HttpError(400, `${name} must be an ISO time or a date (YYYY-MM-DD)`);
  return new Date(dateOnly && name === 'to' ? t + 86_400_000 : t).toISOString();
}

export function parseFilter(q: Query, scope: { project: string | null; floor?: string }): AuditFilter {
  const actions = (str(q.action) ?? '')
    .split(',')
    .map((a) => a.trim().replace(/\*$/, ''))
    .filter(Boolean);
  if (actions.some((a) => !/^[a-z0-9_.]{1,80}$/i.test(a))) throw new HttpError(400, 'action: one or more action names (e.g. "member.add" or the prefix "member.*"), comma-separated');
  const text = str(q.q);
  if (text && text.length > 200) throw new HttpError(400, 'q: at most 200 characters');
  const user = str(q.user);
  if (user && user.length > 320) throw new HttpError(400, 'user: a user id or e-mail');
  let before: number | null = null;
  if (str(q.before)) {
    before = Number(q.before);
    if (!Number.isSafeInteger(before) || before < 1) throw new HttpError(400, 'before: the nextBefore value of the previous page');
  }
  let limit = 100;
  if (str(q.limit)) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new HttpError(400, `limit: 1 to ${PAGE_MAX}`);
  }
  let from = time(q.from, 'from');
  const to = time(q.to, 'to');
  if (scope.floor && (!from || from < scope.floor)) from = scope.floor;
  return { user, project: scope.project, actions: actions.map((a) => a.toLowerCase()), from, to, text, before, limit };
}

/** One CSV cell (RFC 4180). Cells a spreadsheet would read as a formula get a leading apostrophe. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
