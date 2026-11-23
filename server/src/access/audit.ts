import type { FastifyInstance } from 'fastify';
import type { Hub } from '../hub.js';

/**
 * Audit rows for project and settings changes made through the API (Teams mode; the audit page is T3). Identity and
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
];
/** Route prefixes whose writes are settings changes (system-wide AI keys, project setup). */
const SETTINGS_PREFIXES: { prefix: string; action: string }[] = [
  { prefix: '/api/system/ai-providers', action: 'system.ai_providers' },
  { prefix: '/api/projects/:slug/setup', action: 'project.settings' },
];
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function registerAuditHook(app: FastifyInstance, hub: Hub): void {
  if (!hub.access.teams) return;
  app.addHook('onResponse', async (req, reply) => {
    if (!WRITES.has(req.method) || reply.statusCode >= 400) return;
    const route = req.routeOptions.url ?? '';
    const hit = ACTIONS.find((a) => a.method === req.method && a.route === route)?.action ?? SETTINGS_PREFIXES.find((s) => route === s.prefix || route.startsWith(`${s.prefix}/`))?.action;
    if (!hit) return;
    const p = req.principal;
    const params = (req.params ?? {}) as Record<string, unknown>;
    let slug = typeof params.slug === 'string' ? params.slug : null;
    if (!slug && (hit === 'project.create' || hit === 'project.import')) {
      const b = req.body as { slug?: unknown; name?: unknown } | undefined;
      slug = typeof b?.slug === 'string' ? b.slug : null;
    }
    const via = !p ? 'anonymous' : p.kind === 'acting' ? 'internal (for the user)' : p.kind;
    void hub.access.audit(p?.user ?? null, hit, { projectSlug: slug, target: `${req.method} ${route}`, ip: req.ip, detail: { via, status: reply.statusCode } });
  });
}
