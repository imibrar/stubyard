import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.js';
import { LABELS, PRESETS, type Channel } from '../../providers/catalog.js';
import type { Project } from '../../repos/projects.js';
import type { Message, MessageQuery } from '../../repos/messages.js';
import type { TestUser } from '../../repos/users.js';
import { HttpError, normalizeEmail, normalizePhone } from '../../util.js';
import { httpsGuide, setupGuide } from '../../setup/guide.js';
import { resetCounters } from '../../maintenance/retention.js';

type Params = { slug: string; id: string; instance: string };
type Q = Record<string, string | undefined>;

const VERSION = '0.3.0';

export async function registerApiRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});

  // ---------- System ----------
  app.get('/api/system', async () => ({
    name: 'devhub',
    version: VERSION,
    ports: { http: hub.config.httpPort, https: hub.config.httpsPort, smtp: hub.config.smtpPort },
    tls: hub.tls ? { names: hub.tls.names, caFingerprint: hub.tls.caFingerprint, caCreatedAt: hub.tls.caCreatedAt } : null,
    mailpit: !!hub.mailpit,
    presets: PRESETS,
    labels: LABELS,
  }));

  app.get('/api/ca.crt', async (_req, reply) => {
    if (!hub.tls) throw new HttpError(404, 'HTTPS is disabled');
    return reply
      .type('application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="devhub-ca.crt"')
      .send(hub.tls.caCertPem);
  });

  app.get('/api/https-guide', async () => httpsGuide(hub));

  // ---------- Projects ----------
  app.get('/api/projects', async () => {
    return hub.projects.list().map((p) => ({ ...p, stats: projectStats(hub, p) }));
  });

  app.post('/api/projects', async (req, reply) => {
    const b = body(req.body);
    const project = hub.db.transaction(() => {
      const p = hub.projects.create({
        name: String(b.name ?? ''),
        slug: b.slug ? String(b.slug) : undefined,
        description: b.description ? String(b.description) : undefined,
        settings: (b.settings as Project['settings']) ?? undefined,
      });
      // Every project starts with an SMTP email instance so email works immediately.
      hub.providers.create(p.id, { preset: 'smtp', slug: 'mail', name: 'SMTP', labels: ['transactional'], isDefault: true });
      const gen = b.generateUsers as GenerateOpts | undefined;
      if (gen) generateUsers(hub, p, gen);
      return p;
    })();
    hub.bus.publish({ type: 'project.created', projectId: project.id, data: project });
    return reply.status(201).send(project);
  });

  app.get<{ Params: Params }>('/api/projects/:slug', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return { ...p, stats: projectStats(hub, p) };
  });

  app.patch<{ Params: Params }>('/api/projects/:slug', async (req) => {
    const b = body(req.body);
    const p = hub.projects.update(req.params.slug, {
      name: b.name !== undefined ? String(b.name) : undefined,
      description: b.description !== undefined ? String(b.description) : undefined,
      settings: b.settings as Project['settings'] | undefined,
    });
    hub.bus.publish({ type: 'project.updated', projectId: p.id, data: p });
    return p;
  });

  app.delete<{ Params: Params }>('/api/projects/:slug', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const mailpitIds = hub.messages.allMailpitIds(p.id);
    hub.projects.delete(p.slug);
    await hub.mailpit?.deleteMessages(mailpitIds).catch((err) => req.log.warn({ err }, 'could not delete Mailpit messages'));
    hub.bus.publish({ type: 'project.deleted', projectId: p.id, data: { slug: p.slug } });
    return { deleted: p.slug };
  });

  /** Wipe captured data (messages, emails, logs) but keep configuration. */
  app.post<{ Params: Params }>('/api/projects/:slug/reset', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const { deleted, orphanMailpitIds } = hub.messages.delete(p.id);
    const logs = hub.logs.deleteForProject(p.id);
    resetCounters(hub, p.id); // rule + mock hit counters back to 0
    await hub.mailpit?.deleteMessages(orphanMailpitIds).catch((err) => req.log.warn({ err }, 'could not delete Mailpit messages'));
    hub.bus.publish({ type: 'project.reset', projectId: p.id, data: { messages: deleted, logs } });
    return { messages: deleted, logs, emails: orphanMailpitIds.length };
  });

  app.get<{ Params: Params }>('/api/projects/:slug/overview', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const counts = hub.messages.unreadCounts(p.id);
    const latest = hub.messages.latestPerUser(p.id);
    const rules = hub.rules.activeUserRuleCounts(p.id);
    const users = hub.users.list(p.id).map((u) => ({
      ...withPassword(p, u),
      inbox: countsFor(counts, u.id),
      latest: latest.get(u.id) ?? null,
      activeRules: rules.get(u.id) ?? 0,
    }));
    return {
      project: p,
      users,
      unassigned: countsFor(counts, null),
      providers: hub.providers.list(p.id),
      authenticators: hub.authenticators.list(p.id),
      stats: projectStats(hub, p),
    };
  });

  app.get<{ Params: Params }>('/api/projects/:slug/setup', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return setupGuide(hub, p, hub.providers.list(p.id));
  });

  // ---------- Test users ----------
  app.get<{ Params: Params }>('/api/projects/:slug/users', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.users.list(p.id).map((u) => withPassword(p, u));
  });

  /** One user by id, email, phone, name or role (e.g. /users/admin), with inbox counts and the latest code. */
  app.get<{ Params: Params }>('/api/projects/:slug/users/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.requireRef(p.id, req.params.id);
    const counts = hub.messages.unreadCounts(p.id);
    return { ...withPassword(p, u), inbox: countsFor(counts, u.id), latest: hub.messages.latestPerUser(p.id).get(u.id) ?? null };
  });

  /** Latest message for a user (optionally only with an OTP / one channel): { message, otp, link }. */
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/users/:id/latest', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.requireRef(p.id, req.params.id);
    const [m] = hub.messages.list(p.id, {
      testUserId: u.id,
      channel: (req.query.channel as Channel) || undefined,
      hasOtp: flag(req.query.otp),
      limit: 1,
    });
    if (!m) throw new HttpError(404, `No ${req.query.otp ? 'code' : 'message'} for "${u.name}" yet`);
    return { message: m, otp: m.otp, link: m.links[0] ?? null };
  });

  /** Set the pinned bar: { ids: [...] } in display order. */
  app.put<{ Params: Params }>('/api/projects/:slug/pins', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    hub.users.reorderPins(p.id, ids.map((ref) => hub.users.requireRef(p.id, ref).id));
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: { pins: ids } });
    return hub.users.list(p.id).filter((u) => u.pinned > 0);
  });

  app.post<{ Params: Params }>('/api/projects/:slug/users', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const u = hub.users.create(p.id, {
      name: str(b.name),
      role: str(b.role),
      email: nullableStr(b.email),
      phone: nullableStr(b.phone),
      whatsapp: b.whatsapp === undefined ? undefined : nullableStr(b.whatsapp),
      marketingOptOut: b.marketingOptOut === true,
      notes: str(b.notes),
      password: b.password !== undefined ? nullableStr(b.password) : null,
      pinned: b.pinned === true,
    });
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: u });
    return reply.status(201).send(withPassword(p, u));
  });

  app.post<{ Params: Params }>('/api/projects/:slug/users/generate', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const created = generateUsers(hub, p, {
      roles: Array.isArray(b.roles) ? (b.roles as { role: string; count: number }[]) : undefined,
      admins: num(b.admins),
      customers: num(b.customers),
    });
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: created });
    return reply.status(201).send(created);
  });

  app.patch<{ Params: Params }>('/api/projects/:slug/users/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const u = hub.users.update(p.id, req.params.id, {
      name: b.name !== undefined ? String(b.name) : undefined,
      role: b.role !== undefined ? String(b.role) : undefined,
      email: b.email !== undefined ? nullableStr(b.email) : undefined,
      phone: b.phone !== undefined ? nullableStr(b.phone) : undefined,
      whatsapp: b.whatsapp !== undefined ? nullableStr(b.whatsapp) : undefined,
      marketingOptOut: typeof b.marketingOptOut === 'boolean' ? b.marketingOptOut : undefined,
      notes: b.notes !== undefined ? String(b.notes) : undefined,
      password: b.password !== undefined ? nullableStr(b.password) : undefined,
      pinned: typeof b.pinned === 'boolean' ? b.pinned : undefined,
    });
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: u });
    return withPassword(p, u);
  });

  app.delete<{ Params: Params }>('/api/projects/:slug/users/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.delete(p.id, req.params.id);
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: { deleted: u.id } });
    return { deleted: u.id };
  });

  /** Clear one user's inbox ("unassigned" clears the Unassigned inbox). */
  app.post<{ Params: Params }>('/api/projects/:slug/users/:id/clear', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const testUserId = req.params.id === 'unassigned' ? null : hub.users.requireRef(p.id, req.params.id).id;
    const { deleted, orphanMailpitIds } = hub.messages.delete(p.id, { testUserId });
    await hub.mailpit?.deleteMessages(orphanMailpitIds).catch((err) => req.log.warn({ err }, 'could not delete Mailpit messages'));
    hub.bus.publish({ type: 'project.reset', projectId: p.id, data: { testUserId, messages: deleted } });
    return { messages: deleted };
  });

  app.post<{ Params: Params }>('/api/projects/:slug/users/:id/read', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const testUserId = req.params.id === 'unassigned' ? null : hub.users.requireRef(p.id, req.params.id).id;
    const n = hub.messages.markRead(p.id, { testUserId });
    if (n) hub.bus.publish({ type: 'message.updated', projectId: p.id, data: { testUserId, read: n } });
    return { read: n };
  });

  // ---------- Provider instances ----------
  app.get<{ Params: Params }>('/api/projects/:slug/providers', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.providers.list(p.id);
  });

  app.post<{ Params: Params }>('/api/projects/:slug/providers', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const inst = hub.providers.create(p.id, {
      preset: str(b.preset),
      slug: b.slug ? String(b.slug) : undefined,
      name: b.name ? String(b.name) : undefined,
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
      isDefault: typeof b.isDefault === 'boolean' ? b.isDefault : undefined,
      config: (b.config as Record<string, unknown>) ?? undefined,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    });
    hub.bus.publish({ type: 'provider.changed', projectId: p.id, data: inst });
    return reply.status(201).send(inst);
  });

  app.patch<{ Params: Params }>('/api/projects/:slug/providers/:instance', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const b = body(req.body);
    const inst = hub.providers.update(p.id, req.params.instance, {
      preset: b.preset ? String(b.preset) : undefined,
      name: b.name !== undefined ? String(b.name) : undefined,
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
      isDefault: typeof b.isDefault === 'boolean' ? b.isDefault : undefined,
      config: (b.config as Record<string, unknown>) ?? undefined,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    });
    hub.bus.publish({ type: 'provider.changed', projectId: p.id, data: inst });
    return inst;
  });

  app.delete<{ Params: Params }>('/api/projects/:slug/providers/:instance', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const inst = hub.providers.delete(p.id, req.params.instance);
    hub.bus.publish({ type: 'provider.changed', projectId: p.id, data: { deleted: inst.slug } });
    return { deleted: inst.slug };
  });

  // ---------- Messages ----------
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/messages', async (req) => {
    const p = hub.projects.require(req.params.slug);
    return hub.messages.list(p.id, messageQuery(hub, p, req.query));
  });

  /**
   * Long-poll until a matching message arrives, then return it (408 on timeout).
   * Filters as for /messages, plus timeout (seconds, default 30, max 120). Without since/after, messages from the
   * last `lookback` seconds (default 10) also count, so a code sent just before the call is not missed.
   */
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/messages/wait', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const q = messageQuery(hub, p, req.query);
    if (!q.since && !q.after) {
      const lookback = Math.min(Math.max(num(req.query.lookback) ?? 10, 0), 3600);
      q.since = new Date(Date.now() - lookback * 1000).toISOString();
    }
    const timeout = Math.min(Math.max(num(req.query.timeout) ?? 30, 0), 120);
    const [existing] = hub.messages.list(p.id, { ...q, limit: 1 });
    if (existing) return existing;
    return new Promise<unknown>((resolve) => {
      let done = false;
      const finish = (value: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        req.raw.off('close', onClose);
        resolve(value);
      };
      // Delayed deliveries arrive as updates (status scheduled → delivered).
      const off = hub.bus.subscribe((e) => {
        if ((e.type === 'message.created' || e.type === 'message.updated') && isMessage(e.data) && hub.messages.matches(e.data, p.id, q)) finish(e.data);
      });
      const timer = setTimeout(
        () => finish(reply.status(408).send({ error: `No matching message within ${timeout}s`, timeout })),
        timeout * 1000,
      );
      const onClose = () => finish(reply.status(499).send({ error: 'Client closed the request' }));
      req.raw.on('close', onClose);
    });
  });

  app.get<{ Params: Params }>('/api/messages/:id', async (req) => {
    const m = hub.messages.get(req.params.id);
    if (!m) throw new HttpError(404, 'Message not found');
    return {
      ...m,
      mailpit: m.mailpitId
        ? {
            html: `/mailpit/view/${m.mailpitId}.html`,
            text: `/mailpit/view/${m.mailpitId}.txt`,
            raw: `/mailpit/api/v1/message/${m.mailpitId}/raw`,
            detail: `/mailpit/api/v1/message/${m.mailpitId}`,
            part: `/mailpit/api/v1/message/${m.mailpitId}/part/`,
          }
        : null,
    };
  });

  app.post<{ Params: Params }>('/api/messages/:id/read', async (req) => {
    const m = hub.messages.get(req.params.id);
    if (!m) throw new HttpError(404, 'Message not found');
    const n = hub.messages.markRead(m.projectId, { ids: [m.id] });
    if (n) hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: { id: m.id, read: true } });
    return { read: n };
  });

  // ---------- Traffic log ----------
  app.get<{ Querystring: Q }>('/api/logs', async (req) => {
    const q = req.query;
    const project = q.project && q.project !== 'none' ? hub.projects.require(q.project) : null;
    return hub.logs.list({
      projectId: project?.id,
      noProject: q.project === 'none',
      direction: (q.direction as 'inbound' | 'outbound') || undefined,
      protocol: (q.protocol as 'http' | 'smtp') || undefined,
      outcome: q.outcome || undefined,
      status: q.status ? Number(q.status) : undefined,
      q: q.q || undefined,
      before: q.before || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      testUserId: q.user ? (project ? hub.users.requireRef(project.id, q.user).id : q.user) : undefined,
      instance: q.instance || undefined,
    });
  });

  app.get<{ Params: Params }>('/api/logs/:id', async (req) => {
    const l = hub.logs.get(req.params.id);
    if (!l) throw new HttpError(404, 'Log entry not found');
    return l;
  });

  app.all('/api/*', async (req) => {
    throw new HttpError(404, `Unknown API route ${req.method} ${req.url.split('?')[0]}`);
  });
}

type GenerateOpts = { roles?: { role: string; count: number }[]; admins?: number; customers?: number };

const DEFAULT_PASSWORD = 'Password123!';

function withPassword(p: Project, u: TestUser): TestUser {
  return { ...u, password: u.password ?? p.settings.defaultPassword ?? DEFAULT_PASSWORD };
}

function isMessage(d: unknown): d is Message {
  return !!d && typeof d === 'object' && 'channel' in d && 'projectId' in d && 'status' in d;
}

function flag(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

/** Shared filters for /messages and /messages/wait. `user` accepts an id, email, phone, name, role or "unassigned". */
function messageQuery(hub: Hub, p: Project, q: Q): MessageQuery {
  const out: MessageQuery = {
    channel: (q.channel as Channel) || undefined,
    since: q.since || undefined,
    before: q.before || undefined,
    after: q.after || undefined,
    q: q.q || undefined,
    hasOtp: flag(q.otp),
    status: q.status || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  };
  if (q.user === 'unassigned') out.unassigned = true;
  else if (q.user) out.testUserId = hub.users.requireRef(p.id, q.user).id;
  if (q.to) out.to = (q.to.includes('@') ? normalizeEmail(q.to) : normalizePhone(q.to)) ?? undefined;
  if (q.provider) out.providerInstanceId = hub.providers.require(p.id, q.provider).id;
  return out;
}

function generateUsers(hub: Hub, p: Project, opts: GenerateOpts) {
  return hub.users.generate(p.id, {
    roles: opts.roles,
    admins: opts.admins,
    customers: opts.customers,
    password: null,
    emailDomain: p.settings.emailDomain || `${p.slug}.test`,
    phonePrefix: p.settings.phonePrefix || '+92300',
  });
}

function countsFor(counts: ReturnType<Hub['messages']['unreadCounts']>, testUserId: string | null) {
  const out: Record<Channel, { unread: number; total: number }> = {
    email: { unread: 0, total: 0 },
    sms: { unread: 0, total: 0 },
    whatsapp: { unread: 0, total: 0 },
  };
  for (const c of counts) if (c.testUserId === testUserId) out[c.channel] = { unread: c.unread, total: c.total };
  return out;
}

function projectStats(hub: Hub, p: Project) {
  const row = hub.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM test_users WHERE project_id = ?) AS users,
              (SELECT COUNT(*) FROM messages WHERE project_id = ?) AS messages,
              (SELECT COUNT(*) FROM messages WHERE project_id = ? AND read_at IS NULL) AS unread,
              (SELECT COUNT(*) FROM traffic_logs WHERE project_id = ?) AS logs,
              (SELECT COUNT(*) FROM provider_instances WHERE project_id = ?) AS providers`,
    )
    .get(p.id, p.id, p.id, p.id, p.id) as Record<string, number>;
  return row;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}
function nullableStr(v: unknown): string | null {
  return v === undefined || v === null || v === '' ? null : String(v);
}
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
