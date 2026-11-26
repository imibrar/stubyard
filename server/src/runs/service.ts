import { randomBytes, randomInt } from 'node:crypto';
import { envVar } from '../config.js';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { RunRepo, checkRunKey, ttlToExpiry, type Run, type RunCounts } from '../repos/runs.js';
import type { TestUser } from '../repos/users.js';
import { HttpError } from '../util.js';
import { mergeExpectations, parseExpectationPatch, parseExpectations, type ExpectationDoc } from './expectations.js';
import { buildReport, type RunReport } from './report.js';
import { RunResolver } from './resolver.js';
import { SETTLE_MAX_MS, evaluateRun, pendingWorkCount, runHasData, type RunVerdict } from './verdict.js';

export interface StartRunInput {
  key?: string;
  label?: string;
  ttlMinutes?: number;
  captureUnattributed?: boolean;
  claims?: string[];
  meta?: Record<string, unknown>;
  /** Stop and purge an active run with the same key (a crashed worker). */
  replace?: boolean;
  users?: { role?: string; count?: number; name?: string }[];
  /** `{items, defaults}` or a bare array of items (validated; 400 on error). */
  expectations?: unknown;
}

export interface MintInput {
  role?: string;
  name?: string;
  count?: number;
  /** Give the user an email address (default true). */
  email?: boolean;
  /** Give the user a phone / WhatsApp number (default true). */
  phone?: boolean;
}

export interface PurgeCounts {
  users: number;
  messages: number;
  logs: number;
  rules: number;
  emails: number;
}

const DEFAULT_PASSWORD = 'Password123!';
const HOUR = 3_600_000;

/** Test runs: start / mint / stop / purge, expiry, and the view returned by the API. */
export class RunService {
  readonly repo: RunRepo;
  readonly resolver: RunResolver;

  constructor(private hub: Hub) {
    this.repo = new RunRepo(hub.db);
    this.resolver = new RunResolver(this.repo, hub.users);
  }

  /** Hours a stopped run is kept before it is purged (STUBYARD_RUN_RETENTION_HOURS, default 24). */
  get retentionHours(): number {
    const n = Number(envVar('STUBYARD_RUN_RETENTION_HOURS') ?? 24);
    return Number.isFinite(n) && n >= 0 ? n : 24;
  }

  /** By id or key (active first, else the newest stopped one); 404 when there is none. */
  require(projectId: string, ref: string): Run {
    const r = this.repo.find(projectId, ref);
    if (!r) throw new HttpError(404, `Unknown run "${ref}"`, { run: ref });
    return r;
  }

  requireActive(projectId: string, ref: string): Run {
    const r = this.require(projectId, ref);
    if (r.status !== 'active') throw new HttpError(409, `Run "${r.key}" is stopped`);
    return r;
  }

  async start(project: Project, i: StartRunInput): Promise<{ run: Run; users: TestUser[] }> {
    const key = i.key ? checkRunKey(String(i.key)) : this.freeKey(project.id);
    const expiresAt = ttlToExpiry(i.ttlMinutes);
    const claims = Array.isArray(i.claims) ? i.claims.map(String).filter(Boolean) : [];
    const expectations = i.expectations === undefined || i.expectations === null ? undefined : parseExpectations(i.expectations);
    const existing = this.repo.activeByKey(project.id, key);
    if (existing && !i.replace) throw new HttpError(409, `Run "${key}" is already active. Stop it first, or pass "replace": true (stops and purges it)`, { run: this.view(existing) });
    if (i.captureUnattributed) {
      const def = this.repo.defaultRun(project.id);
      if (def && !(i.replace && def.id === existing?.id)) {
        throw new HttpError(409, `Run "${def.key}" already captures unattributed traffic; only one run per project can`, { run: this.view(def) });
      }
    }
    if (existing) await this.stop(existing, { purge: true });
    const run = this.hub.db.transaction(() => {
      const r = this.repo.create(project.id, { key, label: i.label ? String(i.label) : '', expiresAt, captureUnattributed: !!i.captureUnattributed, claims, meta: i.meta ?? {}, expectations });
      const users = (i.users ?? []).flatMap((u) => this.mintIn(project, r, { role: u.role, name: u.name, count: u.count ?? 1 }));
      return { run: this.repo.get(r.id)!, users };
    })();
    this.changed(project.id, run.run);
    return run;
  }

  /** Mint ephemeral users for a run: <role><n>.<key>@<emailDomain>, phone <prefix>9xxxxxx; their addresses become claims. */
  mint(project: Project, run: Run, i: MintInput): TestUser[] {
    if (run.status !== 'active') throw new HttpError(409, `Run "${run.key}" is stopped`);
    const users = this.hub.db.transaction(() => this.mintIn(project, run, i))();
    this.hub.bus.publish({ type: 'user.changed', projectId: project.id, data: users });
    this.changed(project.id, this.repo.get(run.id));
    return users;
  }

  private mintIn(project: Project, run: Run, i: MintInput): TestUser[] {
    const count = Math.floor(Number(i.count ?? 1));
    if (!(count >= 1 && count <= 100)) throw new HttpError(400, 'count must be from 1 to 100');
    const role = (i.role ?? 'user').trim().toLowerCase().replace(/\s+/g, '-') || 'user';
    const base = role.replace(/[^a-z0-9]+/g, '') || 'user';
    const domain = project.settings.emailDomain || `${project.slug}.test`;
    const prefix = '+' + (project.settings.phonePrefix || '+92300').replace(/[^\d]/g, '');
    const all = this.hub.users.list(project.id, { all: true });
    const emails = new Set(all.map((u) => u.email));
    const phones = new Set(all.flatMap((u) => [u.phone, u.whatsapp]));
    let n = this.hub.users.listForRun(run.id).filter((u) => u.role === role).length;
    const out: TestUser[] = [];
    for (let k = 0; k < count; k++) {
      let email: string | null = null;
      do {
        n++;
        email = `${base}${n}.${run.key}@${domain}`;
      } while (emails.has(email));
      emails.add(email);
      let phone: string | null = null;
      if (i.phone !== false) {
        for (let tries = 0; tries < 1000; tries++) {
          const p = `${prefix}9${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
          if (!phones.has(p)) {
            phone = p;
            break;
          }
        }
        if (!phone) throw new HttpError(409, 'Could not find a free phone number for the new test user');
        phones.add(phone);
      }
      const label = role.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const name = i.name ? (count > 1 ? `${i.name} ${k + 1}` : i.name) : `${label} ${n} (${run.key})`;
      out.push(
        this.hub.users.create(project.id, {
          name,
          role,
          email: i.email === false ? null : email,
          phone,
          whatsapp: phone,
          runId: run.id,
        }),
      );
    }
    this.repo.addClaims(run.id, out.flatMap((u) => [u.email ?? '', u.phone ?? '']));
    return out;
  }

  /** Replace the run's expectations, or (append) add items and overlay defaults; 409 once the run is stopped. */
  setExpectations(run: Run, input: unknown, opts: { append?: boolean } = {}): ExpectationDoc {
    if (run.status !== 'active') throw new HttpError(409, `Run "${run.key}" is stopped; its expectations can no longer change`);
    const doc = mergeExpectations(run.expectations, parseExpectationPatch(input), !!opts.append);
    const updated = this.repo.setExpectations(run.id, doc);
    this.changed(run.projectId, updated);
    return updated.expectations;
  }

  /**
   * Freeze the report (with the verdict), drop the run's rules and mock overrides; with purge also delete its users,
   * messages and logs. `settleMs` first waits (60 s at most) for the run's queued work to finish.
   */
  async stop(run0: Run, opts: { purge?: boolean; expired?: boolean; settleMs?: number } = {}): Promise<{ run: Run; report: RunReport }> {
    let run = run0;
    if (run.status === 'active' && opts.settleMs) {
      await this.settle(run, opts.settleMs);
      run = this.repo.get(run.id) ?? run;
    }
    let stopped = run;
    if (run.status === 'active') {
      const at = new Date().toISOString();
      const report = buildReport(this.hub, run, { status: 'stopped', stoppedAt: at, expired: opts.expired });
      stopped = this.hub.db.transaction(() => {
        const r = this.repo.markStopped(run.id, report, at);
        this.hub.rules.deleteForRun(run.id);
        this.hub.db.prepare('DELETE FROM run_mock_scenarios WHERE run_id = ?').run(run.id);
        this.hub.storage?.onRunStopped(run.id);
        this.hub.schedules?.cancelForRun(run.id);
        this.hub.payments?.onRunStopped(run.id);
        this.hub.llm?.onRunStopped(run.id);
        this.hub.autoReplies?.onRunStopped(run.id);
        this.hub.personas?.onRunStopped(run.id);
        this.hub.push?.onRunStopped(run.id);
        return r;
      })();
      this.hub.bus.publish({ type: 'rules.changed', projectId: run.projectId, data: { run: run.key, stopped: true } });
    }
    if (opts.purge) await this.purge(stopped);
    this.changed(run.projectId, this.repo.get(run.id));
    return { run: this.repo.get(run.id) ?? stopped, report: (this.repo.get(run.id)?.report ?? stopped.report) as RunReport };
  }

  /** Delete the run's captured data and users (the run row and its frozen report stay). */
  async purge(run: Run): Promise<PurgeCounts> {
    const counts = this.hub.db.transaction(() => {
      const m = this.hub.messages.deleteForRun(run.id);
      const logs = this.hub.logs.deleteForRun(run.id);
      const rules = this.hub.rules.deleteForRun(run.id);
      this.hub.db.prepare('DELETE FROM authenticators WHERE run_id = ?').run(run.id);
      const users = this.hub.db.prepare('DELETE FROM test_users WHERE run_id = ?').run(run.id).changes;
      this.hub.storage?.purgeRun(run.id); // explicitly attributed objects (rows + files) and uploads
      this.hub.payments?.purgeRun(run.id);
      this.hub.llm?.purgeRun(run.id);
      this.hub.autoReplies?.purgeRun(run.id);
      this.hub.personas?.purgeRun(run.id); // its threads, turns and run personas
      this.hub.push?.purgeRun(run.id); // its devices, notifications and push fault rules
      this.hub.einvoice?.purgeRun(run.id); // its invoices, CSIDs and e-invoicing fault rules
      this.hub.nafath?.purgeRun(run.id); // its Nafath requests and run fault rules
      return { users, messages: m.deleted, logs, rules, orphans: m.orphanMailpitIds };
    })();
    await this.hub.mailpit?.deleteMessages(counts.orphans).catch(() => undefined);
    if (counts.users) this.hub.bus.publish({ type: 'user.changed', projectId: run.projectId, data: { run: run.key, purged: counts.users } });
    if (counts.messages || counts.logs) this.hub.bus.publish({ type: 'project.reset', projectId: run.projectId, data: { run: run.key, messages: counts.messages, logs: counts.logs } });
    return { users: counts.users, messages: counts.messages, logs: counts.logs, rules: counts.rules, emails: counts.orphans.length };
  }

  /** Purge and remove the run entirely. */
  async delete(run: Run): Promise<PurgeCounts> {
    const counts = await this.purge(run);
    this.repo.delete(run.id);
    this.changed(run.projectId, { deleted: run.id, key: run.key });
    return counts;
  }

  /** Project reset / delete: remove every run (and its data). */
  async deleteAllForProject(projectId: string): Promise<number> {
    const runs = this.repo.list(projectId);
    for (const r of runs) await this.delete(r);
    return runs.length;
  }

  /** Maintenance pass: stop runs past their TTL, purge stopped runs older than the retention period. */
  async maintain(now = Date.now()): Promise<{ stopped: number; purged: number }> {
    let stopped = 0;
    let purged = 0;
    for (const r of this.repo.expired(new Date(now).toISOString())) {
      await this.stop(r, { expired: true });
      stopped++;
    }
    for (const r of this.repo.stoppedBefore(new Date(now - this.retentionHours * HOUR).toISOString())) {
      await this.delete(r);
      purged++;
    }
    return { stopped, purged };
  }

  /**
   * The run's verdict. Active: evaluated live, after waiting up to `settleMs` (60 s at most) for queued work. Stopped:
   * the verdict frozen in its report; a run stopped before verdicts existed is evaluated live (frozen: false) while
   * its data is still there, else 409. `expectations` evaluates another document instead (ad hoc, nothing saved).
   */
  async verdict(run0: Run, opts: { settleMs?: number; expectations?: ExpectationDoc } = {}): Promise<RunVerdict> {
    let run = run0;
    if (run.status === 'active') {
      await this.settle(run, opts.settleMs);
      run = this.repo.get(run.id) ?? run;
      if (run.status === 'active') return evaluateRun(this.hub, run, opts.expectations ?? run.expectations);
    }
    const report = run.report as RunReport | null;
    if (report?.verdict && !opts.expectations) return report.verdict;
    const had = (report?.messages?.total ?? 0) + (report?.traffic?.total ?? 0) > 0;
    if (had && !runHasData(this.hub, run.id)) {
      throw new HttpError(409, report?.verdict ? `Run "${run.key}" was purged: there is no data left to evaluate` : 'Run was stopped and purged before verdicts existed');
    }
    const v = evaluateRun(this.hub, run, opts.expectations ?? run.expectations);
    if (!report?.verdict) v.notes.push('Evaluated now: this run was stopped before verdicts were frozen in run reports');
    return v;
  }

  /** Wait (polling every 250 ms, 60 s at most) until the run has no pending schedules or scheduled messages. */
  private async settle(run: Run, settleMs?: number): Promise<void> {
    const wait = Math.min(Math.max(0, Number(settleMs) || 0), SETTLE_MAX_MS);
    const until = Date.now() + wait;
    while (Date.now() < until && pendingWorkCount(this.hub, run.id) > 0) {
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, until - Date.now()))));
    }
  }

  report(run: Run): RunReport {
    return run.status === 'active' || !run.report ? buildReport(this.hub, run) : (run.report as RunReport);
  }

  counts(run: Run): RunCounts {
    return this.repo.counts(run.id);
  }

  /** API shape of a run: fields, counts, the URLs / header / SMTP username to use. */
  view(run: Run) {
    const project = this.hub.projects.get(run.projectId);
    const slug = project?.slug ?? '';
    const { report, expectations, ...rest } = run;
    return {
      ...rest,
      expectations: { items: expectations.items.length },
      /** The frozen verdict's value (null while the run is active, or for runs stopped before verdicts existed). */
      verdict: (report as RunReport | null)?.verdict?.verdict ?? null,
      counts: this.counts(run),
      urls: { mockPrefix: `/run/${run.key}/mock/${slug}`, hookPrefix: `/run/${run.key}/hook/${slug}`, smtpUsername: `${slug}+${run.key}` },
      header: { 'X-Hub-Run': run.key },
    };
  }

  withPassword(project: Project, u: TestUser): TestUser {
    return { ...u, password: u.password ?? project.settings.defaultPassword ?? DEFAULT_PASSWORD };
  }

  private freeKey(projectId: string): string {
    for (;;) {
      const k = randomBytes(6).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6);
      if (k.length >= 4 && !this.repo.activeByKey(projectId, k)) return k;
    }
  }

  private changed(projectId: string, data: unknown): void {
    this.hub.bus.publish({ type: 'runs.changed', projectId, data });
  }
}
