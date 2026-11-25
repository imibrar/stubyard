import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { getAdapter } from '../../providers/adapters/index.js';
import { getEmailAdapter } from '../../providers/email-adapters/index.js';
import type { Channel } from '../../providers/catalog.js';
import type { RuleInput, RuleOwner } from '../../repos/rules.js';
import { RULE_PRESETS, describeRule } from '../../rules/engine.js';
import { HttpError } from '../../util.js';
import type { FastifyRequest } from 'fastify';
import { runParam } from './runs.js';
import { inboundEmailFields, parseReplyAttachments } from '../../messages/email-inbound.js';

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

  // ?run= / X-Hub-Run scope rules to a test run. Rules on a run's own user always belong to that run.
  const userOwner = (slug: string, ref: string, req: FastifyRequest, write: boolean) => {
    const p = hub.projects.require(slug);
    const run = runParam(hub, req, p, { active: write });
    const u = hub.users.requireRef(p.id, ref, run?.id);
    if (write && !run && u.runId && !hub.runs.resolver.activeById(u.runId)) throw new HttpError(409, `${u.name} belongs to a stopped test run`);
    return { p, owner: { scope: 'user', testUserId: u.id } as RuleOwner, name: u.name, runId: run?.id ?? u.runId ?? null };
  };
  const instanceOwner = (slug: string, inst: string, req: FastifyRequest, write: boolean) => {
    const p = hub.projects.require(slug);
    const run = runParam(hub, req, p, { active: write });
    const i = hub.providers.require(p.id, inst);
    return { p, owner: { scope: 'instance', providerInstanceId: i.id } as RuleOwner, name: i.slug, runId: run?.id ?? null };
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
    const owner = (req: FastifyRequest<{ Params: P }>, write = false) =>
      kind === 'users' ? userOwner(req.params.slug, req.params.id, req, write) : instanceOwner(req.params.slug, req.params.instance, req, write);
    const base = kind === 'users' ? '/api/projects/:slug/users/:id/rules' : '/api/projects/:slug/providers/:instance/rules';

    app.get<{ Params: P }>(base, async (req) => {
      const { p, owner: o, runId } = owner(req);
      return hub.rules.list(p.id, o, runId).map(withText);
    });
    app.post<{ Params: P }>(base, async (req, reply) => {
      const { p, owner: o, runId } = owner(req, true);
      const r = hub.rules.add(p.id, o, toInput(p.id, body(req.body)), runId);
      changed(p.id, r);
      return reply.status(201).send(withText(r));
    });
    app.put<{ Params: P }>(base, async (req) => {
      const { p, owner: o, runId } = owner(req, true);
      const b = req.body;
      const list = Array.isArray(b) ? b : Array.isArray(body(b).rules) ? (body(b).rules as unknown[]) : null;
      if (!list) throw new HttpError(400, 'Send an array of rules (or { "rules": [...] })');
      const rules = hub.rules.replace(p.id, o, list.map((x) => toInput(p.id, body(x))), runId);
      changed(p.id, rules);
      return rules.map(withText);
    });
    app.delete<{ Params: P }>(base, async (req) => {
      const { p, owner: o, runId } = owner(req);
      const n = hub.rules.clear(p.id, o, runId);
      changed(p.id, { cleared: n });
      return { deleted: n };
    });
    app.post<{ Params: P; Querystring: { channel?: string } }>(`${base}/preset/:preset`, async (req, reply) => {
      const { p, owner: o, runId } = owner(req, true);
      const preset = RULE_PRESETS.find((x) => x.id === req.params.preset);
      if (!preset) throw new HttpError(404, `Unknown preset "${req.params.preset}". See GET /api/rule-presets`);
      if (preset.scope !== o.scope) throw new HttpError(400, `"${preset.id}" is a ${preset.scope} preset`);
      const channel = String(body(req.body).channel ?? req.query.channel ?? 'all') as RuleInput['channel'];
      const added = preset.rules.map((r) => hub.rules.add(p.id, o, toInput(p.id, { ...r, channel: r.channel === '*' ? channel : r.channel, label: preset.name } as Record<string, unknown>), runId));
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
  app.get<{ Params: P }>('/api/presets/:preset/fields', async (req) => {
    const preset = req.params.preset;
    const sms = getAdapter(preset);
    if (sms) return sms.configFields;
    const email = getEmailAdapter(preset);
    if (email || preset === 'smtp') return [...(email?.configFields ?? []), ...inboundEmailFields(preset)];
    return [];
  });

  // ---------- inbound replies ----------
  app.post<{ Params: P }>('/api/projects/:slug/users/:id/reply', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.requireRef(p.id, req.params.id, runParam(hub, req, p)?.id);
    const b = body(req.body);
    const opt = (k: string) => (b[k] === undefined || b[k] === null || b[k] === '' ? null : String(b[k]));
    const br = b.buttonReply && typeof b.buttonReply === 'object' ? (b.buttonReply as Record<string, unknown>) : null;
    const r = await hub.simulator.reply(p, u, {
      channel: String(b.channel ?? 'sms') as Channel,
      text: String(b.text ?? b.body ?? ''),
      instance: opt('instance'),
      button: opt('button'),
      buttonReply: br && br.id !== undefined ? { id: String(br.id), title: br.title === undefined ? null : String(br.title) } : null,
      contextMessageId: opt('contextMessageId'),
      subject: opt('subject'),
      html: opt('html'),
      inReplyTo: opt('inReplyTo'),
      to: opt('to'),
      // Email: [{ filename, contentType, contentBase64 }], at most 10 files / 5 MB.
      attachments: parseReplyAttachments(b.attachments),
    });
    return reply.status(201).send(r);
  });

  /** "Mark as read": the test user read an outbound WhatsApp message → "read" status callback. */
  app.post<{ Params: P }>('/api/projects/:slug/messages/:id/read-receipt', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    return reply.status(202).send(hub.simulator.readReceipt(p, req.params.id));
  });

  // ---------- WhatsApp message templates (per provider instance) ----------
  const waInstance = (slug: string, ref: string) => {
    const p = hub.projects.require(slug);
    const inst = hub.providers.require(p.id, ref);
    if (inst.channel !== 'whatsapp') throw new HttpError(400, `${inst.slug} is not a WhatsApp provider instance`);
    return { p, inst };
  };
  app.get<{ Params: P }>('/api/projects/:slug/providers/:instance/templates', async (req) => {
    const { inst } = waInstance(req.params.slug, req.params.instance);
    return hub.simulator.templates.repo.list(inst.id);
  });
  /** Create a template as the app would (starts PENDING unless the instance reviews automatically). */
  app.post<{ Params: P }>('/api/projects/:slug/providers/:instance/templates', async (req, reply) => {
    const { p, inst } = waInstance(req.params.slug, req.params.instance);
    const b = body(req.body);
    const adapter = getAdapter(inst.preset);
    if (!adapter) throw new HttpError(400, `The "${inst.preset}" preset has no template support`);
    const components = Array.isArray(b.components) ? b.components : b.body ? [{ type: 'BODY', text: String(b.body) }] : [];
    const t = hub.simulator.templates.create(p, inst, adapter, { name: String(b.name ?? ''), language: String(b.language ?? 'en_US'), category: String(b.category ?? 'UTILITY'), components });
    return reply.status(201).send(t);
  });
  /** Approve / reject / pause / disable, or change the quality rating: sends the vendor's template webhook. */
  app.patch<{ Params: P }>('/api/projects/:slug/providers/:instance/templates/:id', async (req) => {
    const { p, inst } = waInstance(req.params.slug, req.params.instance);
    const b = body(req.body);
    const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
    return hub.simulator.templates.setStatus(p, inst, req.params.id, { status: s(b.status), reason: s(b.reason), quality: s(b.quality) });
  });
  app.delete<{ Params: P }>('/api/projects/:slug/providers/:instance/templates/:id', async (req) => {
    const { p, inst } = waInstance(req.params.slug, req.params.instance);
    if (!hub.simulator.templates.delete(p, inst, [req.params.id])) throw new HttpError(404, `Template ${req.params.id} not found`);
    return { deleted: req.params.id };
  });

  /** Verify API state (Twilio Verify / Vonage Verify v2), newest first. Codes included: this is a test tool. */
  app.get<{ Params: P }>('/api/projects/:slug/verifications', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.verify.list(p.id).map((v) => ({ ...v, instance: hub.providers.getById(v.providerInstanceId)?.slug ?? null }));
  });

  app.get<{ Params: P }>('/api/projects/:slug/jobs', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.scheduler.pending(p.id);
  });
}
