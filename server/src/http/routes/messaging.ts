import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { getAdapter } from '../../providers/adapters/index.js';
import { getEmailAdapter } from '../../providers/email-adapters/index.js';
import type { Channel } from '../../providers/catalog.js';
import type { RuleInput, RuleOwner } from '../../repos/rules.js';
import { RULE_PRESETS, describeRule } from '../../rules/engine.js';
import { HttpError } from '../../util.js';

type P = { slug: string; id: string; instance: string; rule: string; preset: string };

/** Provider mock endpoints, scenario rules (user + instance), presets and inbound replies. */
export async function registerMessagingRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});

  // ---------- provider mocks ----------
  type MockP = { project: string; instance: string; '*': string };
  app.all<{ Params: MockP }>('/mock/:project/:instance', (req, reply) => hub.simulator.handleMock(req, reply));
  app.all<{ Params: MockP }>('/mock/:project/:instance/*', (req, reply) => hub.simulator.handleMock(req, reply));

  // ---------- rules ----------
  const withText = <T extends { action: string }>(r: T & Parameters<typeof describeRule>[0]) => ({ ...r, description: describeRule(r) });

  const userOwner = (slug: string, ref: string) => {
    const p = hub.projects.require(slug);
    const u = hub.users.requireRef(p.id, ref);
    return { p, owner: { scope: 'user', testUserId: u.id } as RuleOwner, name: u.name };
  };
  const instanceOwner = (slug: string, inst: string) => {
    const p = hub.projects.require(slug);
    const i = hub.providers.require(p.id, inst);
    return { p, owner: { scope: 'instance', providerInstanceId: i.id } as RuleOwner, name: i.slug };
  };
  /** User rules may name an instance by slug. */
  const toInput = (projectId: string, b: Record<string, unknown>): RuleInput => {
    const inst = b.instance ?? b.provider;
    return {
      ...(b as unknown as RuleInput),
      providerInstanceId: inst ? hub.providers.require(projectId, String(inst)).id : ((b.providerInstanceId as string | undefined) ?? null),
    };
  };
  const changed = (projectId: string, data: unknown) => hub.bus.publish({ type: 'rules.changed', projectId, data });

  for (const kind of ['users', 'providers'] as const) {
    // Param names must match the other routes on the same path (users/:id, providers/:instance).
    const owner = (params: P) => (kind === 'users' ? userOwner(params.slug, params.id) : instanceOwner(params.slug, params.instance));
    const base = kind === 'users' ? '/api/projects/:slug/users/:id/rules' : '/api/projects/:slug/providers/:instance/rules';

    app.get<{ Params: P }>(base, async (req) => {
      const { p, owner: o } = owner(req.params);
      return hub.rules.list(p.id, o).map(withText);
    });
    app.post<{ Params: P }>(base, async (req, reply) => {
      const { p, owner: o } = owner(req.params);
      const r = hub.rules.add(p.id, o, toInput(p.id, body(req.body)));
      changed(p.id, r);
      return reply.status(201).send(withText(r));
    });
    app.put<{ Params: P }>(base, async (req) => {
      const { p, owner: o } = owner(req.params);
      const b = req.body;
      const list = Array.isArray(b) ? b : Array.isArray(body(b).rules) ? (body(b).rules as unknown[]) : null;
      if (!list) throw new HttpError(400, 'Send an array of rules (or { "rules": [...] })');
      const rules = hub.rules.replace(p.id, o, list.map((x) => toInput(p.id, body(x))));
      changed(p.id, rules);
      return rules.map(withText);
    });
    app.delete<{ Params: P }>(base, async (req) => {
      const { p, owner: o } = owner(req.params);
      const n = hub.rules.clear(p.id, o);
      changed(p.id, { cleared: n });
      return { deleted: n };
    });
    app.post<{ Params: P; Querystring: { channel?: string } }>(`${base}/preset/:preset`, async (req, reply) => {
      const { p, owner: o } = owner(req.params);
      const preset = RULE_PRESETS.find((x) => x.id === req.params.preset);
      if (!preset) throw new HttpError(404, `Unknown preset "${req.params.preset}". See GET /api/rule-presets`);
      if (preset.scope !== o.scope) throw new HttpError(400, `"${preset.id}" is a ${preset.scope} preset`);
      const channel = String(body(req.body).channel ?? req.query.channel ?? 'all') as RuleInput['channel'];
      const added = preset.rules.map((r) => hub.rules.add(p.id, o, toInput(p.id, { ...r, channel: r.channel === '*' ? channel : r.channel, label: preset.name } as Record<string, unknown>)));
      changed(p.id, added);
      return reply.status(201).send(added.map(withText));
    });
  }

  app.patch<{ Params: P }>('/api/projects/:slug/rules/:rule', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const existing = hub.rules.get(req.params.rule);
    if (!existing || existing.projectId !== p.id) throw new HttpError(404, 'Rule not found');
    const b = body(req.body);
    const r = hub.rules.update(existing.id, {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      position: typeof b.position === 'number' ? b.position : undefined,
      label: b.label !== undefined ? (b.label ? String(b.label) : null) : undefined,
    });
    changed(p.id, r);
    return withText(r);
  });

  app.delete<{ Params: P }>('/api/projects/:slug/rules/:rule', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const existing = hub.rules.get(req.params.rule);
    if (!existing || existing.projectId !== p.id) throw new HttpError(404, 'Rule not found');
    hub.rules.delete(existing.id);
    changed(p.id, { deleted: existing.id });
    return { deleted: existing.id };
  });

  app.get('/api/rule-presets', async () => RULE_PRESETS);

  /** Config fields per preset, for the dashboard. */
  app.get<{ Params: P }>('/api/presets/:preset/fields', async (req) => getAdapter(req.params.preset)?.configFields ?? getEmailAdapter(req.params.preset)?.configFields ?? []);

  // ---------- inbound replies ----------
  app.post<{ Params: P }>('/api/projects/:slug/users/:id/reply', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.requireRef(p.id, req.params.id);
    const b = body(req.body);
    const r = await hub.simulator.reply(p, u, {
      channel: String(b.channel ?? 'sms') as Channel,
      text: String(b.text ?? b.body ?? ''),
      instance: b.instance ? String(b.instance) : null,
    });
    return reply.status(201).send(r);
  });

  app.get<{ Params: P }>('/api/projects/:slug/jobs', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.scheduler.pending(p.id);
  });
}
