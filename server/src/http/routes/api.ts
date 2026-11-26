import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../../hub.js';
import { LABELS, PRESETS, type Channel } from '../../providers/catalog.js';
import type { Project } from '../../repos/projects.js';
import { EMPTY_CURSOR, type Message, type MessageQuery } from '../../repos/messages.js';
import type { TestUser } from '../../repos/users.js';
import { HttpError, normalizeEmail, normalizePhone } from '../../util.js';
import { httpsGuide, setupGuide } from '../../setup/guide.js';
import { resetCounters } from '../../maintenance/retention.js';
import { relintOnSettingsChange } from '../../lint/recheck.js';
import type { Run } from '../../repos/runs.js';
import { runParam } from './runs.js';
import { requireProjectVisible, requireRecordAccess, visibleProjectIds } from '../../access/scope.js';
import { Readable } from 'node:stream';

type Params = { slug: string; id: string; instance: string };
type Q = Record<string, string | undefined>;

/** The hub version (GET /api, exported specs). */
export const VERSION = '0.18.0';

/** Mail parts shown inline (raster images only: SVG can carry script). Everything else is served as a download. */
const SAFE_INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function registerApiRoutes(app: FastifyInstance, hub: Hub): Promise<void> {
  const body = (b: unknown) => (b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {});

  // ---------- System ----------
  app.get('/api/system', async (req) => {
    // Sign-in on and anonymous (health checks, the login page, the extension): name and version only.
    if (hub.access.enabled && !req.principal) return { name: 'stubyard', version: VERSION, authRequired: true };
    return {
      name: 'stubyard',
      version: VERSION,
      ports: { http: hub.config.httpPort, https: hub.config.httpsPort, smtp: hub.config.smtpPort },
      tls: hub.tls ? { names: hub.tls.names, caFingerprint: hub.tls.caFingerprint, caCreatedAt: hub.tls.caCreatedAt } : null,
      mailpit: !!hub.mailpit,
      presets: PRESETS,
      labels: LABELS,
      ...(hub.access.enabled ? { authRequired: true } : {}),
      ...(hub.access.teams ? { teams: true, postgres: await postgresHealth(hub, req) } : {}),
    };
  });

  app.get('/api/ca.crt', async (_req, reply) => {
    if (!hub.tls) throw new HttpError(404, 'HTTPS is disabled');
    return reply
      .type('application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="stubyard-ca.crt"')
      .send(hub.tls.caCertPem);
  });

  app.get('/api/https-guide', async () => httpsGuide(hub));

  // ---------- Projects ----------
  app.get('/api/projects', async (req) => {
    // Teams mode: a member sees only the projects they belong to.
    return hub.projects
      .list()
      .filter((p) => hub.access.sees(req.principal, p.slug))
      .map((p) => ({ ...p, stats: projectStats(hub, p) }));
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
    const before = hub.projects.require(req.params.slug);
    const p = hub.projects.update(req.params.slug, {
      name: b.name !== undefined ? String(b.name) : undefined,
      description: b.description !== undefined ? String(b.description) : undefined,
      settings: b.settings as Project['settings'] | undefined,
    });
    hub.bus.publish({ type: 'project.updated', projectId: p.id, data: p });
    void relintOnSettingsChange(hub, before, p, req.log); // lintDisabled / productionDomains changed → re-check recent messages
    return p;
  });

  app.delete<{ Params: Params }>('/api/projects/:slug', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const mailpitIds = hub.messages.allMailpitIds(p.id);
    hub.projects.delete(p.slug);
    await hub.access.onProjectDeleted(p.slug); // Teams mode: its memberships go
    await hub.mailpit?.deleteMessages(mailpitIds).catch((err) => req.log.warn({ err }, 'could not delete Mailpit messages'));
    hub.bus.publish({ type: 'project.deleted', projectId: p.id, data: { slug: p.slug } });
    return { deleted: p.slug };
  });

  /** Wipe captured data (messages, emails, logs) but keep configuration. */
  app.post<{ Params: Params }>('/api/projects/:slug/reset', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const { deleted, orphanMailpitIds } = hub.messages.delete(p.id);
    const logs = hub.logs.deleteForProject(p.id);
    // Storage: uploads in progress and run objects; every object only with { "storage": true }.
    const storage = hub.storage?.resetProject(p.id, { all: (req.body as { storage?: unknown } | undefined)?.storage === true });
    hub.schedules?.cancelAll(p.id); // pending / paused scheduled actions are cancelled
    hub.chat?.resetProject(p.id); // chat conversations go; agents and saved prompts stay
    hub.payments?.resetProject(p.id); // payments go; providers and rules stay (rule hits back to 0)
    hub.llm?.resetProject(p.id); // LLM calls and recordings go; mocks and settings stay
    hub.push?.resetProject(p.id); // push notifications and auto-created devices go; instances and registered devices stay
    hub.autoReplies?.resetProject(p.id); // pending auto-replies cancelled, fires go, uses back to 0; rules stay
    hub.personas?.resetProject(p.id); // persona threads and turns go; personas stay
    hub.storyboards?.resetProject(p.id); // page snapshots go; storyboards, data sets and login recipes stay
    hub.walkthroughs?.resetProject(p.id); // walkthroughs, their steps and screenshots go; users fresh actors created stay
    // The features board (features, tasks, images) is planning content, like storyboards: a reset keeps it.
    await hub.runs.deleteAllForProject(p.id); // test runs and their ephemeral users go too
    resetCounters(hub, p.id); // rule + mock hit counters back to 0
    await hub.mailpit?.deleteMessages(orphanMailpitIds).catch((err) => req.log.warn({ err }, 'could not delete Mailpit messages'));
    hub.bus.publish({ type: 'project.reset', projectId: p.id, data: { messages: deleted, logs } });
    return { messages: deleted, logs, emails: orphanMailpitIds.length, ...(storage ? { storage } : {}) };
  });

  app.get<{ Params: Params }>('/api/projects/:slug/overview', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p);
    const counts = hub.messages.unreadCounts(p.id);
    const latest = hub.messages.latestPerUser(p.id);
    const rules = hub.rules.activeUserRuleCounts(p.id, run?.id ?? null);
    const users = hub.users.list(p.id, { runId: run?.id ?? null }).map((u) => ({
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
      providerCounts: providerCounts(hub, p.id),
      authenticators: hub.authenticators.list(p.id, run?.id ?? null),
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
    // Ephemeral run users only with ?run= (that run's users first).
    return hub.users.list(p.id, { runId: runParam(hub, req, p)?.id ?? null }).map((u) => withPassword(p, u));
  });

  /** One user by id, email, phone, name or role (e.g. /users/admin), with inbox counts and the latest code. */
  app.get<{ Params: Params }>('/api/projects/:slug/users/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.requireRef(p.id, req.params.id, runParam(hub, req, p)?.id);
    const counts = hub.messages.unreadCounts(p.id);
    return { ...withPassword(p, u), inbox: countsFor(counts, u.id), latest: hub.messages.latestPerUser(p.id).get(u.id) ?? null };
  });

  /** Latest message for a user (optionally only with an OTP / one channel): { message, otp, link, links }. */
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/users/:id/latest', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p);
    const u = hub.users.requireRef(p.id, req.params.id, run?.id);
    const [m] = hub.messages.list(p.id, {
      testUserId: u.id,
      runId: run?.id,
      channel: (req.query.channel as Channel) || undefined,
      hasOtp: flag(req.query.otp),
      limit: 1,
    });
    if (!m) throw new HttpError(404, `No ${req.query.otp ? 'code' : 'message'} for "${u.name}" yet`);
    return { message: m, otp: m.otp, link: m.links[0] ?? null, links: m.links };
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
      keep: b.keep === true,
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
    const before = typeof b.keep === 'boolean' ? hub.users.requireRef(p.id, req.params.id) : null;
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
      keep: typeof b.keep === 'boolean' ? b.keep : undefined,
    });
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: u });
    // Keep pin changed: the run that created the user is settled (kept) or pending again (un-kept).
    if (before && before.keep !== u.keep) hub.walkthroughs?.cleanupUserChanged(p, u.id, u.keep ? 'kept' : 'unkept');
    return withPassword(p, u);
  });

  app.delete<{ Params: Params }>('/api/projects/:slug/users/:id', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const u = hub.users.delete(p.id, req.params.id);
    hub.bus.publish({ type: 'user.changed', projectId: p.id, data: { deleted: u.id } });
    hub.walkthroughs?.cleanupUserChanged(p, u.id, 'deleted'); // the run that created it may have nothing left to clean
    return { deleted: u.id };
  });

  /** Clear one user's inbox ("unassigned" clears the Unassigned inbox). */
  app.post<{ Params: Params }>('/api/projects/:slug/users/:id/clear', async (req) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p);
    const testUserId = req.params.id === 'unassigned' ? null : hub.users.requireRef(p.id, req.params.id, run?.id).id;
    // With a run: only the messages this run produced for the user.
    const { deleted, orphanMailpitIds } = hub.messages.delete(p.id, { testUserId, runId: run?.id });
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
  // Every messages response carries a cursor (body field and X-Stubyard-Cursor header): the newest message id it covers.
  // Robust pattern: GET /messages/cursor → trigger the action → GET /messages/wait?after=<cursor>.
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/messages', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const q = messageQuery(hub, p, req.query, runParam(hub, req, p));
    reply.header(CURSOR_HEADER, hub.messages.cursor(p.id, filterOnly(q)));
    return hub.messages.list(p.id, q);
  });

  /** Current position of the message stream (optionally for one user / channel / recipient): { cursor }. */
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/messages/cursor', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const q = filterOnly(messageQuery(hub, p, req.query, runParam(hub, req, p)));
    const [newest] = hub.messages.list(p.id, { ...q, limit: 1 });
    const cursor = newest?.id ?? EMPTY_CURSOR;
    reply.header(CURSOR_HEADER, cursor);
    return { cursor, newestAt: newest?.createdAt ?? null };
  });

  /**
   * Long-poll until a matching message arrives, then return it (408 on timeout).
   * Filters as for /messages, plus timeout (seconds, default 30, max 120). Without since/after, messages from the
   * last `lookback` seconds (default 10) also count, so a code sent just before the call is not missed.
   * count=N: wait until at least N match, exactly=N: until N match and no more arrive within `settle` seconds
   * (default 2) — both answer { count, expected, messages (oldest first), cursor }; 409 when more than N arrived.
   */
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/messages/wait', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const run = runParam(hub, req, p);
    const q = messageQuery(hub, p, req.query, run);
    // Inside a run the window starts when the run started (instead of the 10 s lookback).
    if (run && !q.since && !q.after && req.query.lookback === undefined) q.since = run.startedAt;
    else applyWindow(q, req.query, 10);
    const timeoutMs = Math.min(Math.max(num(req.query.timeout) ?? 30, 0), 120) * 1000;
    const atLeast = intParam(req.query.count, 'count');
    const exactly = intParam(req.query.exactly, 'exactly');
    if (atLeast !== undefined && exactly !== undefined) throw new HttpError(400, 'Use either count or exactly, not both');
    if (exactly === 0 || atLeast === 0) throw new HttpError(400, 'For "no message" use GET /api/projects/:p/messages/expect-none?within=<seconds>');
    const cursorOf = (msgs: Message[]) => maxId(q.after, msgs.at(-1)?.id, hub.messages.cursor(p.id, filterOnly(q)));
    const secs = timeoutMs / 1000;

    if (atLeast === undefined && exactly === undefined) {
      return watch(hub, req, reply, p.id, q, timeoutMs, {
        check: (msgs) => (msgs.length ? { status: 200, body: { ...msgs.at(-1)!, cursor: msgs.at(-1)!.id }, cursor: msgs.at(-1)!.id } : null),
        expire: (msgs) => ({ status: 408, body: { error: `No matching message within ${secs}s`, timeout: secs, cursor: cursorOf(msgs) }, cursor: cursorOf(msgs) }),
      });
    }

    const expected = (exactly ?? atLeast)!;
    const settleMs = Math.min(Math.max(num(req.query.settle) ?? 2, 0), 60) * 1000;
    const result = (status: number, msgs: Message[], error?: string): WatchReply => {
      const cursor = cursorOf(msgs);
      return { status, cursor, body: { ...(error ? { error } : {}), expected, count: msgs.length, messages: msgs, cursor } };
    };
    let settling = false;
    return watch(hub, req, reply, p.id, q, timeoutMs, {
      check: (msgs, rearm) => {
        if (exactly !== undefined) {
          if (msgs.length > exactly) return result(409, msgs, `Expected exactly ${exactly} matching message${exactly === 1 ? '' : 's'}, got ${msgs.length}: ${describe(msgs)}`);
          if (msgs.length === exactly && !settling) {
            settling = true; // N arrived: keep listening for `settle` seconds to catch extra ones
            rearm(settleMs);
          }
          return null;
        }
        return msgs.length >= atLeast! ? result(200, msgs) : null;
      },
      expire: (msgs) =>
        msgs.length >= expected ? result(200, msgs) : result(408, msgs, `Only ${msgs.length} of ${expected} matching message${expected === 1 ? '' : 's'} within ${secs}s`),
    });
  });

  /**
   * Negative assertion: 200 when no matching message arrives within `within` seconds (default 5, max 120),
   * 409 with the offending messages as soon as one does. Counts from now unless after/since/lookback is given;
   * pass after=<cursor> taken before the action so a message sent before this call is caught too.
   */
  app.get<{ Params: Params; Querystring: Q }>('/api/projects/:slug/messages/expect-none', async (req, reply) => {
    const p = hub.projects.require(req.params.slug);
    const q = messageQuery(hub, p, req.query, runParam(hub, req, p));
    applyWindow(q, req.query, 0);
    const withinMs = Math.min(Math.max(num(req.query.within) ?? num(req.query.timeout) ?? 5, 0), 120) * 1000;
    const cursorOf = (msgs: Message[]) => maxId(q.after, msgs.at(-1)?.id, hub.messages.cursor(p.id, filterOnly(q)));
    return watch(hub, req, reply, p.id, q, withinMs, {
      check: (msgs) => {
        if (!msgs.length) return null;
        const cursor = cursorOf(msgs);
        const error = `Expected no matching message within ${withinMs / 1000}s, got ${msgs.length}: ${describe(msgs)}`;
        return { status: 409, cursor, body: { error, count: msgs.length, messages: msgs, cursor } };
      },
      expire: (msgs) => {
        const cursor = cursorOf(msgs);
        return { status: 200, cursor, body: { ok: true, within: withinMs / 1000, count: 0, cursor } };
      },
    });
  });

  app.get<{ Params: Params }>('/api/messages/:id', async (req) => {
    const m = hub.messages.get(req.params.id);
    if (!m) throw new HttpError(404, 'Message not found');
    requireRecordAccess(hub, req, m.projectId, 'project.view', 'Message not found');
    const mine = `/api/messages/${encodeURIComponent(m.id)}/mail`;
    return {
      ...m,
      mailpit: m.mailpitId
        ? hub.access.teams
          ? // Teams mode: the raw /mailpit proxy is for instance admins; mail is read through the message's project.
            { html: `${mine}/html`, text: `${mine}/text`, raw: `${mine}/raw`, detail: `${mine}/detail`, part: `${mine}/part/` }
          : {
            html: `/mailpit/view/${m.mailpitId}.html`,
            text: `/mailpit/view/${m.mailpitId}.txt`,
            raw: `/mailpit/api/v1/message/${m.mailpitId}/raw`,
            detail: `/mailpit/api/v1/message/${m.mailpitId}`,
            part: `/mailpit/api/v1/message/${m.mailpitId}/part/`,
          }
        : null,
    };
  });

  /** The e-mail behind a message, from Mailpit, checked against the message's project (Teams mode needs it). */
  app.get<{ Params: { id: string; kind: string; part?: string } }>('/api/messages/:id/mail/:kind', async (req, reply) => mailOf(req, reply, req.params.kind));
  app.get<{ Params: { id: string; part: string } }>('/api/messages/:id/mail/part/:part', async (req, reply) => mailOf(req, reply, 'part', req.params.part));

  const mailOf = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, kind: string, part?: string) => {
    const m = hub.messages.get(req.params.id);
    if (!m) throw new HttpError(404, 'Message not found');
    requireRecordAccess(hub, req, m.projectId, 'project.view', 'Message not found');
    if (!m.mailpitId || !hub.mailpit) throw new HttpError(404, 'This message has no e-mail in Mailpit');
    const mid = encodeURIComponent(m.mailpitId);
    const paths: Record<string, string> = {
      html: `/mailpit/view/${mid}.html`,
      text: `/mailpit/view/${mid}.txt`,
      raw: `/mailpit/api/v1/message/${mid}/raw`,
      detail: `/mailpit/api/v1/message/${mid}`,
      part: `/mailpit/api/v1/message/${mid}/part/${encodeURIComponent(part ?? '')}`,
    };
    const target = paths[kind];
    if (!target || (kind === 'part' && !/^[\w.-]{1,40}$/.test(part ?? ''))) throw new HttpError(404, `Unknown mail view "${kind}" (html, text, raw, detail, part/<id>)`);
    let upstream: Response;
    try {
      upstream = await fetch(new URL(hub.mailpit.baseUrl).origin + target, { headers: { 'accept-encoding': 'identity', ...hub.mailpit.authHeaders() }, redirect: 'manual' });
    } catch (err) {
      throw new HttpError(502, `Mailpit is not reachable: ${(err as Error).message}`);
    }
    reply.status(upstream.status === 200 ? 200 : upstream.status >= 500 ? 502 : 404);
    // Mail content is chosen by whoever sent the mail: never let it run as a page on stubyard's origin. Every view is
    // sandboxed with nothing allowed (the HTML view may load its own inline images through the part route), raw is
    // plain text, and a part is shown inline only when it is a raster image (never SVG); anything else downloads.
    const upstreamType = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const cache = upstream.headers.get('cache-control');
    if (cache) reply.header('cache-control', cache);
    reply.header('x-content-type-options', 'nosniff');
    if (kind === 'detail') {
      reply.header('content-type', 'application/json; charset=utf-8');
    } else if (kind === 'html') {
      reply.header('content-type', 'text/html; charset=utf-8');
      // Remote images (an app's logo, e.g. http://localhost:3183/logo.png) load as in a mail client; no scripts, frames or
      // forms, and no Referer leaks the stubyard URL to the image host.
      reply.header('content-security-policy', "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src 'self' data: http: https:; style-src 'unsafe-inline'; font-src data:");
      reply.header('referrer-policy', 'no-referrer');
    } else if (kind === 'text' || kind === 'raw') {
      reply.header('content-type', 'text/plain; charset=utf-8');
      reply.header('content-security-policy', "sandbox; default-src 'none'");
      if (kind === 'raw') reply.header('content-disposition', `inline; filename="${m.id.replace(/[^\w.-]/g, '_')}.eml.txt"`);
    } else {
      const safeImage = SAFE_INLINE_IMAGES.has(upstreamType);
      reply.header('content-type', safeImage ? upstreamType : upstreamType && /^[\w.+-]+\/[\w.+-]+$/.test(upstreamType) ? upstreamType : 'application/octet-stream');
      reply.header('content-security-policy', "sandbox; default-src 'none'");
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(upstream.headers.get('content-disposition') ?? '')?.[1] ?? `part-${part}`;
      const ascii = decodeURIComponentSafe(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 150);
      reply.header('content-disposition', `${safeImage ? 'inline' : 'attachment'}; filename="${ascii}"`);
    }
    if (kind === 'html') {
      // Inline images point at Mailpit's part URLs: send them through this route as well.
      const html = (await upstream.text()).replace(new RegExp(`(?:/mailpit/)?api/v1/message/${mid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/part/`, 'g'), `/api/messages/${encodeURIComponent(m.id)}/mail/part/`);
      return reply.send(html);
    }
    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  };

  app.post<{ Params: Params }>('/api/messages/:id/read', async (req) => {
    const m = hub.messages.get(req.params.id);
    if (!m) throw new HttpError(404, 'Message not found');
    requireRecordAccess(hub, req, m.projectId, 'project.view', 'Message not found');
    const n = hub.messages.markRead(m.projectId, { ids: [m.id] });
    if (n) hub.bus.publish({ type: 'message.updated', projectId: m.projectId, data: { id: m.id, read: true } });
    return { read: n };
  });

  // ---------- Traffic log ----------
  app.get<{ Querystring: Q }>('/api/logs', async (req) => {
    const q = req.query;
    if (q.project && q.project !== 'none') requireProjectVisible(hub, req, q.project);
    // Project-less traffic (unknown project slugs, …) is for instance admins; members see their projects' logs only.
    if (q.project === 'none' && !hub.access.sees(req.principal, null)) throw new HttpError(404, 'Not found');
    const project = q.project && q.project !== 'none' ? hub.projects.require(q.project) : null;
    const runHeader = req.headers['x-hub-run'];
    const runRef = q.run || (Array.isArray(runHeader) ? runHeader[0] : runHeader);
    let run: Run | null = null;
    if (runRef) {
      // A key needs the project; a run id works on its own.
      run = project ? runParam(hub, req, project) : hub.runs.repo.get(runRef);
      if (!run) throw new HttpError(404, `Unknown run "${runRef}"${project ? '' : ' (pass ?project= to look a run up by key)'}`);
      requireRecordAccess(hub, req, run.projectId, 'project.view', `Unknown run "${runRef}"`);
    }
    const visible = project ? null : visibleProjectIds(hub, req);
    return hub.logs.list({
      projectIds: visible ?? undefined,
      runId: run?.id,
      projectId: project?.id,
      noProject: q.project === 'none',
      direction: (q.direction as 'inbound' | 'outbound') || undefined,
      protocol: (q.protocol as 'http' | 'smtp') || undefined,
      outcome: q.outcome || undefined,
      status: q.status ? Number(q.status) : undefined,
      q: q.q || undefined,
      before: q.before || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      testUserId: q.user ? (project ? hub.users.requireRef(project.id, q.user, run?.id).id : q.user) : undefined,
      instance: q.instance || undefined,
    });
  });

  app.get<{ Params: Params }>('/api/logs/:id', async (req) => {
    const l = hub.logs.get(req.params.id);
    if (!l) throw new HttpError(404, 'Log entry not found');
    requireRecordAccess(hub, req, l.projectId, 'project.view', 'Log entry not found');
    return l;
  });

  app.all('/api/*', async (req) => {
    throw new HttpError(404, `Unknown API route ${req.method} ${req.url.split('?')[0]}`);
  });
}

type GenerateOpts = { roles?: { role: string; count: number }[]; admins?: number; customers?: number; [role: string]: unknown };

const DEFAULT_PASSWORD = 'Password123!';

function withPassword(p: Project, u: TestUser): TestUser {
  return { ...u, password: u.password ?? p.settings.defaultPassword ?? DEFAULT_PASSWORD };
}

const CURSOR_HEADER = 'x-stubyard-cursor';

interface WatchReply {
  status: number;
  body: unknown;
  cursor: string;
}

interface WatchSpec {
  /** Called with the matching messages (oldest first) at the start and after every change; a reply ends the wait. */
  check: (msgs: Message[], rearm: (ms: number) => void) => WatchReply | null;
  /** Reply when the deadline (timeout, or a rearmed settle time) passes. */
  expire: (msgs: Message[]) => WatchReply;
}

/**
 * Keep the set of messages matching `q` (existing ones plus new ones and status changes from the event bus)
 * and let `spec` decide when the request is answered.
 */
function watch(hub: Hub, req: FastifyRequest, reply: FastifyReply, projectId: string, q: MessageQuery, timeoutMs: number, spec: WatchSpec): Promise<unknown> {
  const set = new Map<string, Message>();
  for (const m of hub.messages.listAscending(projectId, q)) set.set(m.id, m);
  const current = () => [...set.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const send = (r: WatchReply) => reply.status(r.status).header(CURSOR_HEADER, r.cursor).send(r.body);
  return new Promise<unknown>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: () => void = () => {};
    const finish = (r: WatchReply | null, raw?: () => unknown) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      req.raw.off('close', onClose);
      resolve(raw ? raw() : send(r!));
    };
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(spec.expire(current())), ms);
    };
    const onClose = () => finish(null, () => reply.status(499).send({ error: 'Client closed the request' }));
    const first = spec.check(current(), arm);
    if (first) return resolve(send(first));
    if (!timer) arm(timeoutMs);
    // Delayed deliveries arrive as updates (status scheduled → delivered).
    off = hub.bus.subscribe((e) => {
      if (done || (e.type !== 'message.created' && e.type !== 'message.updated') || !isMessage(e.data) || e.data.projectId !== projectId) return;
      if (hub.messages.matches(e.data, projectId, q)) set.set(e.data.id, e.data);
      else if (!set.delete(e.data.id)) return;
      const r = spec.check(current(), arm);
      if (r) finish(r);
    });
    req.raw.on('close', onClose);
  });
}

/** Without since/after, look back `lookback` seconds (query param, else the default). */
function applyWindow(q: MessageQuery, query: Q, defaultLookback: number): void {
  if (q.since || q.after) return;
  const lookback = Math.min(Math.max(num(query.lookback) ?? defaultLookback, 0), 3600);
  q.since = new Date(Date.now() - lookback * 1000).toISOString();
}

/** The filter part of a query (who / what), without the time window or paging. */
function filterOnly(q: MessageQuery): MessageQuery {
  const { since: _s, after: _a, before: _b, limit: _l, ...rest } = q;
  return rest;
}

function maxId(...ids: (string | undefined | null)[]): string {
  return ids.reduce<string>((m, id) => (id && id > m ? id : m), EMPTY_CURSOR);
}

function intParam(v: string | undefined, name: string): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(400, `${name} must be a whole number from 0 to 100`);
  return n;
}

/** Short human summary of messages for assertion errors. */
function describe(msgs: Message[]): string {
  return msgs
    .slice(0, 3)
    .map((m) => `${m.channel} to ${m.to}${m.subject ? ` "${m.subject}"` : m.bodyText ? ` "${m.bodyText.slice(0, 40)}"` : ''} (${m.status}, id ${m.id})`)
    .join('; ') + (msgs.length > 3 ? ` and ${msgs.length - 3} more` : '');
}

function isMessage(d: unknown): d is Message {
  return !!d && typeof d === 'object' && 'channel' in d && 'projectId' in d && 'status' in d;
}

function flag(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

/** Shared filters for /messages and /messages/wait. `user` accepts an id, email, phone, name, role or "unassigned". */
function messageQuery(hub: Hub, p: Project, q: Q, run: Run | null = null): MessageQuery {
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
  if (run) out.runId = run.id;
  if (q.lint) {
    const level = q.lint === 'any' || q.lint === '1' ? 'info' : q.lint;
    if (level !== 'error' && level !== 'warn' && level !== 'info') throw new HttpError(400, 'lint must be error, warn, info or any');
    out.lint = level;
  }
  if (q.user === 'unassigned') out.unassigned = true;
  else if (q.user) out.testUserId = hub.users.requireRef(p.id, q.user, run?.id).id;
  if (q.to) out.to = (q.to.includes('@') ? normalizeEmail(q.to) : normalizePhone(q.to)) ?? undefined;
  if (q.provider) out.providerInstanceId = hub.providers.require(p.id, q.provider).id;
  return out;
}

/**
 * Accepts { roles: [{role, count}] } or the shorthand { admins: 1, sales: 2, customers: 5, … }: any numeric key is a
 * role ("admins" → admin, "customers" → customer; "sales" stays "sales").
 */
function shorthandRoles(opts: GenerateOpts): { role: string; count: number }[] | undefined {
  if (opts.roles) return opts.roles;
  const entries = Object.entries(opts as Record<string, unknown>).filter(([k, v]) => k !== 'roles' && (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))));
  if (!entries.length) return undefined;
  const singular = (k: string) => (k === 'sales' || k.endsWith('ss') || !k.endsWith('s') ? k : k.slice(0, -1));
  return entries.map(([k, v]) => ({ role: singular(k.toLowerCase()), count: Number(v) }));
}

function generateUsers(hub: Hub, p: Project, opts: GenerateOpts) {
  return hub.users.generate(p.id, {
    roles: shorthandRoles(opts),
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

/** Instances per Providers-page tab (the sidebar badge sums them). LLM APIs: the fake OpenAI + Anthropic, always there. */
function providerCounts(hub: Hub, projectId: string): Record<string, number> {
  const channel = (c: string) => hub.providers.list(projectId).filter((x) => x.channel === c).length;
  return {
    email: channel('email'),
    sms: channel('sms'),
    whatsapp: channel('whatsapp'),
    login: hub.auth.repo.listProviders(projectId).length,
    payments: hub.payments.repo.listInstances(projectId).length,
    llm: 2,
    push: hub.push.listInstances(projectId).length,
  };
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

/** Teams mode: Postgres health for /api/system (details for instance admins only). */
async function postgresHealth(hub: Hub, req: FastifyRequest): Promise<Record<string, unknown>> {
  const h = await hub.access.health();
  if (!h) return { ok: false };
  return req.principal && hub.access.can(req.principal, 'instance.admin', null) ? { ...h } : { ok: h.ok };
}
