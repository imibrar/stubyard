import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import type { AuthRuleInput } from '../../repos/auth.js';
import { AUTH_ACTION_GROUPS, AUTH_STAGES } from '../../repos/auth.js';
import { HttpError } from '../../util.js';

type P = { slug: string; provider: string; id: string; rule: string; user: string };

/**
 * Login providers: control API under /api/projects/:slug/auth and the fake identity providers themselves under
 * /auth/<project>/<provider>/… (not under /api: token endpoints are form-encoded and called by apps, so the
 * JSON-only / Host guard of /api must not apply).
 */
export async function registerAuthRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});
  const svc = hub.auth;
  const changed = (projectId: string, data: unknown) => hub.bus.publish({ type: 'auth.changed', projectId, data });
  const load = (req: FastifyRequest<{ Params: P }>) => {
    const project = hub.projects.require(req.params.slug);
    const provider = svc.repo.requireProvider(project.id, req.params.provider);
    return { project, provider };
  };

  // ---------- presets ----------
  app.get('/api/auth-presets', async () => ({
    presets: svc.presets(),
    actions: AUTH_ACTION_GROUPS,
    stages: AUTH_STAGES,
  }));

  // ---------- providers ----------
  app.get<{ Params: P }>('/api/projects/:slug/auth', async (req) => {
    const project = hub.projects.require(req.params.slug);
    return svc.repo.listProviders(project.id).map((p) => svc.view(project, p));
  });

  app.post<{ Params: P }>('/api/projects/:slug/auth', async (req, reply) => {
    const project = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const flavorAlias = ['auth0', 'okta', 'keycloak', 'cognito'].includes(String(b.preset ?? '').toLowerCase()) ? String(b.preset).toLowerCase() : null;
    const config = { ...(flavorAlias ? { flavor: flavorAlias } : {}), ...body(b.config) };
    const p = svc.create(project, { ...b, slug: b.slug ?? flavorAlias ?? undefined, config });
    changed(project.id, { created: p.slug });
    return reply.status(201).send(svc.view(project, p));
  });

  app.get<{ Params: P }>('/api/projects/:slug/auth/:provider', async (req) => {
    const { project, provider } = load(req);
    return svc.view(project, provider);
  });

  app.patch<{ Params: P }>('/api/projects/:slug/auth/:provider', async (req) => {
    const { project, provider } = load(req);
    const p = svc.update(provider, body(req.body));
    changed(project.id, { updated: p.slug });
    return svc.view(project, p);
  });

  app.delete<{ Params: P }>('/api/projects/:slug/auth/:provider', async (req) => {
    const { project, provider } = load(req);
    svc.repo.deleteProvider(provider);
    changed(project.id, { deleted: provider.slug });
    return { deleted: provider.slug };
  });

  // ---------- SSO sessions ----------
  // Server-side sign-out: revokes the sessions behind stubyard_sso_<provider> cookies on any host, so the next
  // authorize shows the picker again. The static "sessions" segment wins over :provider in the router.
  app.delete<{ Params: P }>('/api/projects/:slug/auth/sessions', async (req) => {
    const project = hub.projects.require(req.params.slug);
    const revoked = svc.repo.revokeSessions(svc.repo.listProviders(project.id).map((p) => p.id));
    changed(project.id, { sessionsRevoked: revoked });
    return { revoked };
  });

  app.delete<{ Params: P }>('/api/projects/:slug/auth/:provider/sessions', async (req) => {
    const { project, provider } = load(req);
    const revoked = svc.repo.revokeSessions([provider.id]);
    changed(project.id, { sessionsRevoked: revoked, provider: provider.slug });
    return { revoked };
  });

  app.get<{ Params: P }>('/api/projects/:slug/auth/:provider/sessions', async (req) => {
    const { project, provider } = load(req);
    return svc.signedInUsers(project, provider);
  });

  app.delete<{ Params: P }>('/api/projects/:slug/auth/:provider/sessions/:user', async (req) => {
    const { project, provider } = load(req);
    const user = hub.users.requireRef(project.id, req.params.user);
    const revoked = svc.repo.revokeSessions([provider.id], user.id);
    changed(project.id, { sessionsRevoked: revoked, provider: provider.slug, user: user.id });
    return { revoked };
  });

  // ---------- rules ----------
  const ruleRoutes = (url: string, withUser: boolean) => {
    const owner = (req: FastifyRequest<{ Params: P }>) => {
      const { project, provider } = load(req);
      const user = withUser ? hub.users.requireRef(project.id, req.params.id) : null;
      return { project, provider, userId: user?.id ?? null };
    };
    app.get<{ Params: P }>(url, async (req) => {
      const o = owner(req);
      return svc.repo.listRules(o.provider.id, o.userId);
    });
    app.post<{ Params: P }>(url, async (req, reply) => {
      const o = owner(req);
      const r = svc.repo.addRule(o.provider, o.userId, body(req.body) as unknown as AuthRuleInput);
      changed(o.project.id, { rule: r.id });
      return reply.status(201).send(r);
    });
    app.put<{ Params: P }>(url, async (req) => {
      const o = owner(req);
      const b = req.body;
      const list = Array.isArray(b) ? b : Array.isArray(body(b).rules) ? (body(b).rules as unknown[]) : null;
      if (!list) throw new HttpError(400, 'Send an array of rules (or { "rules": [...] })');
      const out = svc.repo.replaceRules(o.provider, o.userId, list as AuthRuleInput[]);
      changed(o.project.id, { rules: out.length });
      return out;
    });
    app.delete<{ Params: P }>(url, async (req) => {
      const o = owner(req);
      const n = svc.repo.clearRules(o.provider.id, o.userId);
      changed(o.project.id, { cleared: n });
      return { deleted: n };
    });
  };
  ruleRoutes('/api/projects/:slug/auth/:provider/rules', false);
  ruleRoutes('/api/projects/:slug/auth/:provider/users/:id/rules', true);

  app.delete<{ Params: P }>('/api/projects/:slug/auth/:provider/all-rules', async (req) => {
    const { project, provider } = load(req);
    const n = svc.repo.clearRules(provider.id, 'all');
    changed(project.id, { cleared: n });
    return { deleted: n };
  });

  app.patch<{ Params: P }>('/api/projects/:slug/auth/:provider/rules/:rule', async (req) => {
    const { project, provider } = load(req);
    const r = svc.repo.getRule(req.params.rule);
    if (!r || r.providerId !== provider.id) throw new HttpError(404, `Rule "${req.params.rule}" not found`);
    const b = body(req.body);
    const out = svc.repo.updateRule(r.id, { enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined, label: b.label !== undefined ? (b.label as string | null) : undefined });
    changed(project.id, { rule: r.id });
    return out;
  });

  app.delete<{ Params: P }>('/api/projects/:slug/auth/:provider/rules/:rule', async (req) => {
    const { project, provider } = load(req);
    const r = svc.repo.getRule(req.params.rule);
    if (!r || r.providerId !== provider.id) throw new HttpError(404, `Rule "${req.params.rule}" not found`);
    svc.repo.deleteRule(r.id);
    changed(project.id, { rule: r.id });
    return { deleted: r.id };
  });

  // ---------- keys / identities / warnings ----------
  app.post<{ Params: P }>('/api/projects/:slug/auth/:provider/keys/rotate', async (req) => {
    const { project, provider } = load(req);
    const out = svc.rotateKey(provider, body(req.body).dropOld === true);
    changed(project.id, { rotated: out.kid });
    return out;
  });

  app.get<{ Params: P }>('/api/projects/:slug/auth/:provider/identities', async (req) => {
    const { project, provider } = load(req);
    return hub.users.list(project.id).map((u) => svc.identityView(provider, u));
  });

  app.get<{ Params: P }>('/api/projects/:slug/auth/:provider/identities/:user', async (req) => {
    const { project, provider } = load(req);
    return svc.identityView(provider, hub.users.requireRef(project.id, req.params.user));
  });

  app.patch<{ Params: P }>('/api/projects/:slug/auth/:provider/identities/:user', async (req) => {
    const { project, provider } = load(req);
    const user = hub.users.requireRef(project.id, req.params.user);
    const b = body(req.body);
    const i = svc.ensureIdentity(provider, user);
    if (b.claims !== undefined && (typeof b.claims !== 'object' || Array.isArray(b.claims))) throw new HttpError(400, '"claims" must be an object (null values remove a key)');
    const claims = b.claims ? Object.fromEntries(Object.entries({ ...i.claims, ...(b.claims as Record<string, unknown>) }).filter(([, v]) => v !== null)) : undefined;
    svc.repo.updateIdentity(i, { sub: b.sub !== undefined ? String(b.sub) : undefined, claims, consented: typeof b.consented === 'boolean' ? b.consented : undefined });
    changed(project.id, { identity: user.id });
    return svc.identityView(provider, user);
  });

  app.get<{ Params: P }>('/api/projects/:slug/auth/:provider/warnings', async (req) => {
    const { project, provider } = load(req);
    return svc.warnings(project, provider);
  });

  // ---------- tokens without a browser ----------
  app.post<{ Params: P }>('/api/projects/:slug/auth/:provider/token', async (req) => {
    const { project, provider } = load(req);
    const b = body(req.body);
    if (!b.user) throw new HttpError(400, '"user" is required (id, email, name or role)');
    return svc.apiToken(req, project, provider, b as never);
  });

  app.post<{ Params: P }>('/api/projects/:slug/auth/:provider/code', async (req) => {
    const { project, provider } = load(req);
    const b = body(req.body);
    if (!b.user) throw new HttpError(400, '"user" is required (id, email, name or role)');
    return svc.apiCode(project, provider, b as never);
  });

  // ---------- the fake identity providers ----------
  const handler = (req: FastifyRequest, reply: Parameters<typeof svc.handle>[1]) => svc.handle(req as never, reply);
  app.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/auth/:project/:provider/*', handler });
  app.route({ method: ['GET', 'HEAD', 'POST', 'OPTIONS'], url: '/auth/:project/:provider', handler });
}
