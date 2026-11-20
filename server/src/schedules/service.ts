import type { Hub } from '../hub.js';
import type { Job } from '../jobs/scheduler.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import { HttpError } from '../util.js';
import { matchAllowed, toSuffix } from './actions.js';
import { ACTIVE_STATUSES, ScheduleRepo, type Schedule, type SchedulePatch, type ScheduleStatus } from './repo.js';

/** Minimal shape of Fastify's app.inject (attached by registerScheduleRoutes). */
export type InjectFn = (o: { method: string; url: string; payload?: string; headers: Record<string, string> }) => Promise<{ statusCode: number; body: string }>;

export const MAX_AHEAD_MS = 30 * 86_400_000;
export const MIN_EVERY_MS = 1000;
export const MAX_FIRES_CAP = 100;
export const MAX_ACTIVE_PER_PROJECT = 500;
const RESULT_CLIP = 2048;
const JOB = 'schedule.fire';

type Json = Record<string, unknown>;

export interface ScheduleInput {
  method?: unknown;
  path?: unknown;
  body?: unknown;
  label?: unknown;
  delayMs?: unknown;
  delaySeconds?: unknown;
  at?: unknown;
  everyMs?: unknown;
  maxFires?: unknown;
}

export interface FireResult {
  id: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  result: unknown;
}

const num = (v: unknown, name: string): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
};
const has = (b: ScheduleInput, k: keyof ScheduleInput) => b[k] !== undefined && b[k] !== null && b[k] !== '';

/**
 * Scheduled actions: an allowlisted dashboard API call (send a webhook, run a sequence, reply as a user, set / clear rules,
 * switch a mock scenario) made later, once or on a fixed-rate repeat. Fired through the durable job queue (type
 * "schedule.fire"); the schedules row is the source of truth and `gen` / `fired` guard against stale or double fires.
 */
export class ScheduleService {
  readonly repo: ScheduleRepo;
  private inject: InjectFn | null = null;

  constructor(private hub: Hub) {
    this.repo = new ScheduleRepo(hub.db);
    hub.scheduler.register(JOB, (job) => this.onJob(job));
  }

  /** Late fires within this window still fire; older ones count as missed (DEVHUB_SCHEDULE_GRACE_MS, default 10 min). */
  get graceMs(): number {
    const n = Number(process.env.DEVHUB_SCHEDULE_GRACE_MS ?? 600_000);
    return Number.isFinite(n) && n >= 0 ? n : 600_000;
  }

  attach(inject: InjectFn): void {
    this.inject = inject;
    this.recover();
  }

  /**
   * After a crash: a pending schedule whose queued job is gone, finished or stale (its fire was claimed but never
   * completed) gets a fresh job. The interrupted fire is not repeated (no double fire).
   */
  recover(): number {
    const rows = this.hub.db.prepare("SELECT id FROM schedules WHERE status = 'pending'").all() as { id: string }[];
    let n = 0;
    for (const { id } of rows) {
      const s = this.repo.get(id);
      if (!s) continue;
      const job = s.jobId ? (this.hub.db.prepare('SELECT status, payload FROM scheduled_jobs WHERE id = ?').get(s.jobId) as { status: string; payload: string } | undefined) : undefined;
      const p = job ? (JSON.parse(job.payload) as Json) : null;
      const live = job && (job.status === 'pending' || job.status === 'running') && Number(p?.gen) === s.gen && Number(p?.seq) === s.fired;
      if (live) continue;
      n++;
      if (s.jobId) this.hub.scheduler.cancel(s.jobId);
      if (s.fired >= s.maxFires) {
        this.finish(s, 'done', { lastError: s.lastStatus === null ? 'The last fire was interrupted (devhub restarted)' : s.lastError });
        continue;
      }
      let next = this.repo.update(s.id, { gen: s.gen + 1, jobId: null })!;
      if (next.everyMs && next.nextAt && s.lastFiredAt && Date.parse(next.nextAt) <= Date.parse(s.lastFiredAt)) {
        next = this.repo.update(s.id, { nextAt: new Date(Date.parse(next.nextAt) + next.everyMs).toISOString() })!;
      }
      // Not before every job handler is registered and the scheduler has started.
      this.enqueue(next, 1000);
    }
    return n;
  }

  // ---------------- views ----------------

  view(s: Schedule) {
    const project = this.hub.projects.get(s.projectId);
    const run = s.runId ? this.hub.runs.repo.get(s.runId) : null;
    const { gen: _gen, jobId: _job, ...rest } = s;
    return {
      ...rest,
      url: `/api/projects/${project?.slug ?? '?'}${s.path}`,
      run: run ? run.key : null,
      repeat: s.everyMs ? { everyMs: s.everyMs, fired: s.fired, max: s.maxFires } : null,
    };
  }

  // ---------------- create / edit ----------------

  /** Time of the next fire from delayMs | delaySeconds | at (exactly one). */
  private when(b: ScheduleInput, now: number): number {
    const given = (['delayMs', 'delaySeconds', 'at'] as const).filter((k) => has(b, k));
    if (given.length !== 1) throw new HttpError(400, 'Give exactly one of delayMs, delaySeconds or at (ISO time)');
    let t: number;
    if (given[0] === 'at') {
      t = Date.parse(String(b.at));
      if (!Number.isFinite(t)) throw new HttpError(400, `at must be an ISO date-time, got "${String(b.at)}"`);
      if (t < now - this.graceMs) throw new HttpError(400, `at (${String(b.at)}) is in the past`);
      t = Math.max(t, now);
    } else {
      const d = given[0] === 'delayMs' ? num(b.delayMs, 'delayMs') : num(b.delaySeconds, 'delaySeconds') * 1000;
      if (d < 0) throw new HttpError(400, 'delay must not be negative');
      t = now + Math.round(d);
    }
    if (t - now > MAX_AHEAD_MS) throw new HttpError(400, 'A schedule can be at most 30 days ahead');
    return t;
  }

  private repeat(b: ScheduleInput, cur?: { everyMs: number | null; maxFires: number; fired: number }): { everyMs: number | null; maxFires: number } {
    let everyMs = cur?.everyMs ?? null;
    if (b.everyMs !== undefined) {
      if (b.everyMs === null || b.everyMs === 0 || b.everyMs === '') everyMs = null;
      else {
        everyMs = Math.round(num(b.everyMs, 'everyMs'));
        if (everyMs < MIN_EVERY_MS) throw new HttpError(400, `everyMs must be at least ${MIN_EVERY_MS}`);
      }
    }
    let maxFires: number;
    if (has(b, 'maxFires')) {
      maxFires = num(b.maxFires, 'maxFires');
      if (!Number.isInteger(maxFires) || maxFires < 1) throw new HttpError(400, 'maxFires must be a whole number >= 1');
      if (maxFires > MAX_FIRES_CAP) throw new HttpError(400, `maxFires is capped at ${MAX_FIRES_CAP}`);
    } else if (cur && (cur.everyMs === null) === (everyMs === null)) maxFires = cur.maxFires;
    else maxFires = everyMs ? 10 : 1;
    if (!everyMs && maxFires > 1) throw new HttpError(400, 'maxFires > 1 needs everyMs (a repeat interval)');
    if (cur && maxFires <= cur.fired) throw new HttpError(400, `maxFires must be more than the ${cur.fired} fire(s) so far`);
    return { everyMs, maxFires };
  }

  private bodyText(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    const t = JSON.stringify(v);
    if (t.length > 256 * 1024) throw new HttpError(400, 'body is too large (max 256 KB)');
    return t;
  }

  create(project: Project, b: ScheduleInput, run: Run | null): Schedule {
    const path = toSuffix(project.slug, String(b.path ?? ''));
    const method = String(b.method ?? 'POST').toUpperCase();
    const action = matchAllowed(method, path);
    const now = Date.now();
    const at = this.when(b, now);
    const { everyMs, maxFires } = this.repeat(b);
    if (this.repo.countActive(project.id) >= MAX_ACTIVE_PER_PROJECT) {
      throw new HttpError(409, `Project "${project.slug}" already has ${MAX_ACTIVE_PER_PROJECT} pending / paused schedules; cancel some first`);
    }
    const s = this.repo.create({
      projectId: project.id,
      runId: run?.id ?? null,
      label: b.label ? String(b.label).slice(0, 200) : '',
      action,
      method,
      path,
      body: this.bodyText(b.body),
      nextAt: new Date(at).toISOString(),
      everyMs,
      maxFires,
    });
    const out = this.enqueue(s);
    this.changed(project.id, { created: s.id });
    return out;
  }

  /** label, body, time (delayMs | delaySeconds | at), everyMs, maxFires; pending / paused only. */
  update(project: Project, id: string, b: ScheduleInput): Schedule {
    const s = this.repo.require(project.id, id);
    if (!ACTIVE_STATUSES.includes(s.status)) throw new HttpError(409, `Schedule is ${s.status}; only pending or paused schedules can be edited`);
    if (has(b, 'method') || has(b, 'path')) {
      const path = has(b, 'path') ? toSuffix(project.slug, String(b.path)) : s.path;
      const method = has(b, 'method') ? String(b.method).toUpperCase() : s.method;
      if (path !== s.path || method !== s.method) throw new HttpError(400, 'The action and target of a schedule cannot be changed; cancel it and create a new one');
    }
    const patch: SchedulePatch = { gen: s.gen + 1, jobId: null };
    if (b.label !== undefined) patch.label = b.label ? String(b.label).slice(0, 200) : '';
    if (b.body !== undefined) patch.body = this.bodyText(b.body);
    if (has(b, 'delayMs') || has(b, 'delaySeconds') || has(b, 'at')) patch.nextAt = new Date(this.when(b, Date.now())).toISOString();
    if (b.everyMs !== undefined || has(b, 'maxFires')) Object.assign(patch, this.repeat(b, s));
    if (s.jobId) this.hub.scheduler.cancel(s.jobId);
    let next = this.repo.update(s.id, patch)!;
    if (next.status === 'pending') next = this.enqueue(next);
    this.changed(project.id, { updated: s.id });
    return next;
  }

  pause(project: Project, id: string): Schedule {
    const s = this.repo.require(project.id, id);
    if (s.status === 'paused') return s;
    if (s.status !== 'pending') throw new HttpError(409, `Schedule is ${s.status}; only pending schedules can be paused`);
    if (s.jobId) this.hub.scheduler.cancel(s.jobId);
    const out = this.repo.update(s.id, { status: 'paused', gen: s.gen + 1, jobId: null })!;
    this.changed(project.id, { paused: s.id });
    return out;
  }

  /** Back to pending. A time that passed while paused: one-shot fires now, recurring skips to the next slot (not counted as missed). */
  resume(project: Project, id: string): Schedule {
    const s = this.repo.require(project.id, id);
    if (s.status === 'pending') return s;
    if (s.status !== 'paused') throw new HttpError(409, `Schedule is ${s.status}; only paused schedules can be resumed`);
    const now = Date.now();
    let at = s.nextAt ? Date.parse(s.nextAt) : now;
    if (at < now) at = s.everyMs ? at + Math.ceil((now - at) / s.everyMs) * s.everyMs : now;
    let out = this.repo.update(s.id, { status: 'pending', gen: s.gen + 1, nextAt: new Date(at).toISOString(), jobId: null })!;
    out = this.enqueue(out);
    this.changed(project.id, { resumed: s.id });
    return out;
  }

  /** Cancel an active schedule; delete a finished one. */
  remove(project: Project, id: string): { cancelled?: Schedule; deleted?: string } {
    const s = this.repo.require(project.id, id);
    if (ACTIVE_STATUSES.includes(s.status)) {
      const out = this.finish(s, 'cancelled', { lastError: s.lastError });
      this.changed(project.id, { cancelled: s.id });
      return { cancelled: out };
    }
    this.repo.delete(s.id);
    this.changed(project.id, { deleted: s.id });
    return { deleted: s.id };
  }

  // ---------------- firing ----------------

  /** Fire now, outside the timetable (counts as a fire). Works for pending and paused schedules. */
  async runNow(project: Project, id: string): Promise<{ schedule: Schedule; fire: FireResult }> {
    const s = this.repo.require(project.id, id);
    if (!ACTIVE_STATUSES.includes(s.status)) throw new HttpError(409, `Schedule is ${s.status}; only pending or paused schedules can run`);
    // Invalidate the queued job first; afterFire queues a fresh one.
    if (s.jobId) this.hub.scheduler.cancel(s.jobId);
    const bumped = this.repo.update(s.id, { gen: s.gen + 1, jobId: null })!;
    const fire = await this.fire(bumped, false);
    return { schedule: this.repo.get(s.id) ?? bumped, fire };
  }

  /** Fire every pending schedule once (optionally of one run), in next_at order, one after the other. */
  async flush(project: Project, run: Run | null): Promise<{ fired: number; results: (FireResult & { label: string; action: string })[] }> {
    const list = this.repo.list(project.id, { status: ['pending'], runId: run?.id });
    list.sort((a, b) => (a.nextAt ?? '').localeCompare(b.nextAt ?? ''));
    const results: (FireResult & { label: string; action: string })[] = [];
    for (const s of list) {
      const cur = this.repo.get(s.id);
      if (!cur || cur.status !== 'pending') continue;
      const { fire } = await this.runNow(project, s.id);
      results.push({ ...fire, label: s.label, action: s.action });
    }
    return { fired: results.length, results };
  }

  private async onJob(job: Job): Promise<void> {
    const p = job.payload as Json;
    const s = this.repo.get(String(p.scheduleId ?? ''));
    if (!s || s.status !== 'pending' || s.gen !== Number(p.gen) || s.fired !== Number(p.seq)) return;
    const now = Date.now();
    const due = s.nextAt ? Date.parse(s.nextAt) : now;
    if (now - due > this.graceMs) {
      if (!s.everyMs) {
        this.finish(s, 'missed', { missed: s.missed + 1, lastError: `Missed: devhub was not running at ${s.nextAt} (grace ${this.graceMs} ms)` });
      } else {
        // Recurring: skip to the first slot after now, no burst of catch-up fires.
        const k = Math.floor((now - due) / s.everyMs) + 1;
        const next = this.repo.update(s.id, { missed: s.missed + k, nextAt: new Date(due + k * s.everyMs).toISOString() })!;
        this.enqueue(next);
      }
      this.changed(s.projectId, { missed: s.id });
      return;
    }
    await this.fire(s, true);
  }

  /** One fire: claim it (fired + 1), call the API in-process, record the result, then queue the next fire or finish. */
  private async fire(s: Schedule, advance: boolean): Promise<FireResult> {
    const base = { id: s.id, status: null, ok: false, result: null };
    const run = s.runId ? this.hub.runs.repo.get(s.runId) : null;
    if (s.runId && (!run || run.status !== 'active')) {
      const msg = `Run ${run ? `"${run.key}" ` : ''}is no longer active`;
      this.finish(s, 'cancelled', { lastError: msg });
      this.changed(s.projectId, { cancelled: s.id });
      return { ...base, error: msg };
    }
    const project = this.hub.projects.get(s.projectId);
    const at = new Date().toISOString();
    if (!project || !this.repo.claimFire(s.id, s.fired, at)) return { ...base, error: 'Already fired' };
    const headers: Record<string, string> = { 'x-devhub-schedule': s.id };
    if (run) headers['x-hub-run'] = run.key;
    const payload = s.body === null || s.body === undefined ? undefined : JSON.stringify(s.body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    let status: number | null = null;
    let text = '';
    let error: string | null = null;
    try {
      if (!this.inject) throw new Error('Scheduler is not attached to the HTTP app yet');
      const res = await this.inject({ method: s.method, url: `/api/projects/${project.slug}${s.path}`, payload, headers });
      status = res.statusCode;
      text = res.body ?? '';
    } catch (err) {
      error = (err as Error).message || 'Request failed';
    }
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* text */
    }
    if (!error && status !== null && status >= 400) error = `devhub answered ${status}: ${(parsed as { error?: string } | null)?.error ?? text.slice(0, 300)}`;
    const clipped = text.length > RESULT_CLIP ? JSON.stringify(`${text.slice(0, RESULT_CLIP)}…`) : text ? (typeof parsed === 'string' ? JSON.stringify(parsed) : text) : null;
    this.afterFire(s.id, s.gen, advance, { lastStatus: status, lastResult: clipped, lastError: error }, !!error);
    this.changed(s.projectId, { fired: s.id, status });
    return { id: s.id, status, ok: !error, error, result: text.length > RESULT_CLIP ? `${text.slice(0, RESULT_CLIP)}…` : parsed };
  }

  private afterFire(id: string, gen: number, advance: boolean, last: SchedulePatch, failed: boolean): void {
    const cur = this.repo.get(id);
    if (!cur) return;
    // Changed meanwhile (cancelled, paused, edited): only record the outcome.
    if (!ACTIVE_STATUSES.includes(cur.status) || cur.gen !== gen) {
      this.repo.update(id, last);
      return;
    }
    if (failed) {
      this.finish(cur, 'failed', last);
      return;
    }
    if (cur.fired >= cur.maxFires || !cur.everyMs) {
      this.finish(cur, 'done', last);
      return;
    }
    const patch: SchedulePatch = { ...last };
    if (advance && cur.nextAt) patch.nextAt = new Date(Date.parse(cur.nextAt) + cur.everyMs).toISOString();
    const next = this.repo.update(id, patch)!;
    if (next.status === 'pending') this.enqueue(next);
  }

  private enqueue(s: Schedule, minDelayMs = 0): Schedule {
    const delayMs = Math.max(minDelayMs, (s.nextAt ? Date.parse(s.nextAt) : Date.now()) - Date.now());
    const jobId = this.hub.scheduler.schedule(JOB, { scheduleId: s.id, gen: s.gen, seq: s.fired }, { projectId: s.projectId, delayMs });
    return this.repo.update(s.id, { jobId })!;
  }

  private finish(s: Schedule, status: ScheduleStatus, extra: SchedulePatch = {}): Schedule {
    if (s.jobId) this.hub.scheduler.cancel(s.jobId);
    return this.repo.update(s.id, { ...extra, status, gen: s.gen + 1, jobId: null, nextAt: null })!;
  }

  // ---------------- hooks ----------------

  /** RunService.stop(): the run's pending / paused schedules are cancelled. */
  cancelForRun(runId: string): number {
    const list = this.repo.active({ runId });
    for (const s of list) this.finish(s, 'cancelled', { lastError: 'Run stopped' });
    if (list.length) this.changed(list[0].projectId, { cancelledForRun: runId, count: list.length });
    return list.length;
  }

  /** Project reset: every pending / paused schedule is cancelled. */
  cancelAll(projectId: string): number {
    const list = this.repo.active({ projectId });
    for (const s of list) this.finish(s, 'cancelled', { lastError: 'Project reset' });
    if (list.length) this.changed(projectId, { cancelledAll: list.length });
    return list.length;
  }

  /** Maintenance: finished schedules older than 24 h are deleted. */
  purgeFinished(now = Date.now(), olderThanMs = 86_400_000): number {
    return this.repo.purgeFinished(new Date(now - olderThanMs).toISOString());
  }

  private changed(projectId: string, data: unknown): void {
    this.hub.bus.publish({ type: 'schedules.changed', projectId, data });
  }
}
