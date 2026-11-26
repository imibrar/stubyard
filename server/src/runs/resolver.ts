import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Hub } from '../hub.js';
import type { Channel } from '../providers/catalog.js';
import { RUN_KEY_RE, type Run, type RunRepo } from '../repos/runs.js';
import type { TestUser, UserRepo } from '../repos/users.js';
import { normalizeEmail, normalizePhone } from '../util.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Run named explicitly by X-Hub-Run or a /run/<key>/ URL prefix (checked in the onRequest hook). */
    hubRun?: Run | null;
  }
}

/** How a message / request was attributed to its run. */
export type RunVia = 'header' | 'prefix' | 'smtp-username' | 'user' | 'plus-tag' | 'claim' | 'default';

export interface Attribution {
  run: Run | null;
  via: RunVia | null;
}

/** Only the first 64 KB of a body are searched for claims. */
const CLAIM_BODY_BYTES = 64 * 1024;

/**
 * Decides which test run a message or request belongs to. First hit wins:
 * 1-3 explicit (X-Hub-Run header, /run/<key>/ prefix, SMTP username "project+key"), 4 recipient is a run user,
 * 5 plus-tag (admin+w3@…), 6 content claim (API mocks and hooks only), 7 the project's default run, 8 none.
 */
export class RunResolver {
  constructor(
    private runs: RunRepo,
    private users: UserRepo,
  ) {}

  /** An explicit key or id: only an active run counts (callers fail loudly when this returns null). */
  explicit(projectId: string, ref: string): Run | null {
    const r = ref.trim().toLowerCase();
    if (!r) return null;
    const byKey = RUN_KEY_RE.test(r) ? this.runs.activeByKey(projectId, r) : null;
    if (byKey) return byKey;
    const byId = this.runs.get(ref.trim());
    return byId && byId.projectId === projectId && byId.status === 'active' ? byId : null;
  }

  activeById(id: string | null | undefined): Run | null {
    if (!id) return null;
    const r = this.runs.get(id);
    return r && r.status === 'active' ? r : null;
  }

  /**
   * Test user and run for one recipient. Users are matched by exact address first (run users included);
   * an email "admin+w3@hyper.test" whose tag is an active run key means user admin@hyper.test inside run w3.
   */
  forRecipient(projectId: string, channel: Channel, address: string, explicit: { run: Run | null; via: RunVia | null } | null = null): { user: TestUser | null } & Attribution {
    let user: TestUser | null = null;
    let tagRun: Run | null = null;
    if (channel === 'email') {
      const e = normalizeEmail(address);
      if (e) {
        user = this.users.findByEmail(projectId, e);
        if (!user) {
          const tag = plusTag(e);
          if (tag) {
            tagRun = this.runs.activeByKey(projectId, tag.key);
            if (tagRun) user = this.users.findByEmail(projectId, tag.base);
          }
        }
      }
    } else {
      const p = normalizePhone(address);
      user = p ? this.users.findByPhone(projectId, p, channel) : null;
    }
    if (explicit?.run) return { user, run: explicit.run, via: explicit.via };
    const userRun = this.activeById(user?.runId);
    if (userRun) return { user, run: userRun, via: 'user' };
    if (tagRun) return { user, run: tagRun, via: 'plus-tag' };
    const def = this.runs.defaultRun(projectId);
    return { user, run: def, via: def ? 'default' : null };
  }

  /** The one active run whose claim strings occur in the text (none, or several → null). */
  byClaims(projectId: string, haystack: string): Run | null {
    if (!haystack) return null;
    const text = haystack.toLowerCase();
    const hits = this.runs.active(projectId).filter((r) =>
      r.claims.some((c) => {
        const needle = String(c).trim().toLowerCase();
        if (needle.length < 3) return false;
        return text.includes(needle) || (needle.startsWith('+') && needle.length > 6 && text.includes(needle.slice(1)));
      }),
    );
    return hits.length === 1 ? hits[0] : null;
  }

  /** API mocks and hooks: explicit run, else a content claim, else the default run. */
  forRequest(projectId: string, req: FastifyRequest): Attribution {
    if (req.hubRun) return { run: req.hubRun, via: explicitVia(req) };
    if (!this.runs.hasActive(projectId)) return { run: null, via: null };
    const claimed = this.byClaims(projectId, requestHaystack(req));
    if (claimed) return { run: claimed, via: 'claim' };
    const def = this.runs.defaultRun(projectId);
    return { run: def, via: def ? 'default' : null };
  }

  /** Explicit run of an HTTP request in the shape forRecipient takes. */
  explicitOf(req: FastifyRequest): { run: Run | null; via: RunVia | null } | null {
    return req.hubRun ? { run: req.hubRun, via: explicitVia(req) } : null;
  }

  /** Run for a message captured without an explicit attribution (replies, bounce reports, other paths). */
  captureRun(projectId: string, channel: Channel, to: string, testUserId: string | null | undefined, direction: 'inbound' | 'outbound'): string | null {
    if (!this.runs.hasActive(projectId)) return null;
    if (testUserId) {
      const u = this.users.get(projectId, testUserId);
      const r = this.activeById(u?.runId);
      if (r) return r.id;
      return this.runs.defaultRun(projectId)?.id ?? null;
    }
    if (direction === 'inbound') return this.runs.defaultRun(projectId)?.id ?? null;
    return this.forRecipient(projectId, channel, to).run?.id ?? null;
  }
}

function explicitVia(req: FastifyRequest): RunVia {
  return (req.originalUrl ?? req.url).startsWith('/run/') ? 'prefix' : 'header';
}

/** "admin+w3@hyper.test" → { base: "admin@hyper.test", key: "w3" } when the tag looks like a run key. */
export function plusTag(email: string): { base: string; key: string } | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const local = email.slice(0, at);
  const plus = local.lastIndexOf('+');
  if (plus <= 0) return null;
  const key = local.slice(plus + 1);
  if (!RUN_KEY_RE.test(key)) return null;
  return { base: local.slice(0, plus) + email.slice(at), key };
}

/** Path, decoded query and the first 64 KB of the body of a request, for claim matching. */
export function requestHaystack(req: FastifyRequest): string {
  let url = req.url;
  try {
    url = decodeURIComponent(req.url.replace(/\+/g, ' '));
  } catch {
    /* keep raw */
  }
  const raw = req.rawBody ? req.rawBody.subarray(0, CLAIM_BODY_BYTES).toString('utf8') : typeof req.body === 'string' ? req.body.slice(0, CLAIM_BODY_BYTES) : '';
  let body = raw;
  // Form bodies are URL-encoded ("to=%2B92300…"): search the decoded form too.
  if (raw && /application\/x-www-form-urlencoded/i.test(String(req.headers['content-type'] ?? ''))) {
    try {
      body = raw + '\n' + decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      /* keep raw */
    }
  }
  return `${url}\n${body}`;
}

/** /run/<key>/mock/… or /run/<key>/hook/… → the URL without the prefix, and the key. */
export function stripRunPrefix(url: string): { url: string; key: string } | null {
  const m = /^\/run\/([a-z0-9]{1,24})(\/(?:mock|hook|storage|pay|llm|push|einvoice)\/.*)$/i.exec(url);
  return m ? { key: m[1].toLowerCase(), url: m[2] } : null;
}

/** Fastify rewriteUrl: strip /run/<key> and pass the key on as X-Hub-Run, so downstream code only reads the header. */
export function rewriteRunUrl(req: { url?: string; headers: Record<string, string | string[] | undefined> }): string {
  const url = req.url ?? '/';
  const s = stripRunPrefix(url);
  if (!s) return url;
  req.headers['x-hub-run'] = s.key;
  return s.url;
}

/**
 * onRequest hook for /mock and /hook: resolve an explicit run (header or prefix). An unknown or stopped run fails
 * loudly with 404 { error: "Unknown run" } instead of silently mixing the traffic into another run.
 */
export function registerRunHook(app: { addHook: (name: 'onRequest', fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => unknown }, hub: Hub): void {
  app.addHook('onRequest', async (req, reply) => {
    const raw = req.headers['x-hub-run'];
    const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!key) return;
    const m = /^\/(?:mock|hook|storage|pay|llm|push|einvoice)\/([^/?]+)/.exec(req.url);
    if (!m) return;
    let slug = m[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* keep */
    }
    const project = hub.projects.getBySlug(slug.toLowerCase());
    if (!project) return; // the route answers "unknown project"
    const run = hub.runs.resolver.explicit(project.id, key);
    const id = req.trafficLogId;
    if (!run) {
      req.trafficOutcome = 'unmatched';
      req.trafficResolved = { project: project.slug, unknownRun: key };
      if (id) hub.traffic.update(id, { projectId: project.id });
      return reply.status(404).send({
        error: 'Unknown run',
        run: key,
        message: `Project "${project.slug}" has no active test run "${key}" (unknown, stopped or expired). Start it with POST /api/projects/${project.slug}/runs.`,
        requestId: id,
      });
    }
    req.hubRun = run;
    if (id) {
      hub.traffic.update(id, { projectId: project.id, runId: run.id });
      hub.traffic.mergeResolved(id, { run: run.key, runVia: explicitVia(req) });
    }
    return;
  });
}

/** Record a run on a traffic log entry (column + resolved.run). */
export function tagLog(hub: Hub, logId: string | null | undefined, a: Attribution): void {
  if (!logId || !a.run) return;
  hub.traffic.update(logId, { runId: a.run.id });
  hub.traffic.mergeResolved(logId, { run: a.run.key, runVia: a.via });
}
