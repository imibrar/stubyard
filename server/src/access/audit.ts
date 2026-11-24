import type { FastifyInstance } from 'fastify';
import type { Hub } from '../hub.js';

/**
 * Audit rows for project and settings changes made through the API, and project exports (Teams mode; read with
 * GET /api/audit and /api/projects/:slug/audit). Identity and
 * access changes (sign-in, users, members, roles, tokens, invites) are written by the access service itself, with
 * their details. Written after a successful answer (status < 400), also for calls made by MCP tools or schedules for
 * a user (the acting user is recorded).
 */
const ACTIONS: { method: string; route: string; action: string }[] = [
  { method: 'POST', route: '/api/projects', action: 'project.create' },
  { method: 'POST', route: '/api/projects/import', action: 'project.import' },
  { method: 'PATCH', route: '/api/projects/:slug', action: 'project.settings' },
  { method: 'DELETE', route: '/api/projects/:slug', action: 'project.delete' },
  { method: 'POST', route: '/api/projects/:slug/reset', action: 'project.reset' },
  { method: 'POST', route: '/api/factory-reset', action: 'system.factory_reset' },
  { method: 'POST', route: '/api/system/maintenance', action: 'system.maintenance' },
  // A read, but it hands out the whole project configuration (with ?secrets=1 also authenticator keys).
  { method: 'GET', route: '/api/projects/:slug/export', action: 'project.export' },
];
/** Route prefixes whose writes are settings changes (system-wide AI keys, project setup). */
const SETTINGS_PREFIXES: { prefix: string; action: string }[] = [
  { prefix: '/api/system/ai-providers', action: 'system.ai_providers' },
  { prefix: '/api/projects/:slug/setup', action: 'project.settings' },
];
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CREATES = new Set(['project.create', 'project.import']);

/** The slug a project create / import answered with (the body may not name one). */
const createdSlug = new WeakMap<object, string>();

function matchAction(method: string, route: string): string | undefined {
  const exact = ACTIONS.find((a) => a.method === method && a.route === route)?.action;
  if (exact || !WRITES.has(method)) return exact;
  return SETTINGS_PREFIXES.find((s) => route === s.prefix || route.startsWith(`${s.prefix}/`))?.action;
}

/** Which settings a change touched (names only: values can be secrets such as the default test password). */
function changedFields(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) return undefined;
  const b = body as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (k === 'settings' && v && typeof v === 'object' && !Array.isArray(v)) out.push(...Object.keys(v).map((s) => `settings.${s}`));
    else out.push(k);
  }
  return out.slice(0, 50);
}

export function registerAuditHook(app: FastifyInstance, hub: Hub): void {
  if (!hub.access.teams) return;
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400 || typeof payload !== 'string' || payload.length > 1_000_000) return payload;
    const hit = matchAction(req.method, req.routeOptions.url ?? '');
    if (!hit || !CREATES.has(hit)) return payload;
    try {
      const r = JSON.parse(payload) as { slug?: unknown; project?: { slug?: unknown } };
      const slug = typeof r.slug === 'string' ? r.slug : typeof r.project?.slug === 'string' ? r.project.slug : null;
      if (slug) createdSlug.set(req, slug);
    } catch {
      /* not JSON */
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 400) return;
    const route = req.routeOptions.url ?? '';
    const hit = matchAction(req.method, route);
    if (!hit) return;
    const p = req.principal;
    const params = (req.params ?? {}) as Record<string, unknown>;
    let slug = typeof params.slug === 'string' ? params.slug : null;
    if (!slug && CREATES.has(hit)) slug = createdSlug.get(req) ?? null;
    const via = !p ? 'anonymous' : p.kind === 'acting' ? 'internal (for the user)' : p.kind;
    const detail: Record<string, unknown> = { via, status: reply.statusCode };
    if (hit === 'project.settings' || hit === 'system.ai_providers') {
      const fields = changedFields(req.body);
      if (fields?.length) detail.fields = fields;
    }
    if (hit === 'project.export') {
      const q = (req.query ?? {}) as Record<string, unknown>;
      detail.secrets = q.secrets === '1' || q.secrets === 'true' || q.secrets === 'yes';
    }
    if (hit === 'project.import') {
      const mode = (req.body as { mode?: unknown } | undefined)?.mode;
      detail.mode = mode === 'replace' ? 'replace' : 'create';
    }
    void hub.access.audit(p?.user ?? null, hit, { projectSlug: slug, target: `${req.method} ${route}`, ip: req.ip, detail });
  });
}
