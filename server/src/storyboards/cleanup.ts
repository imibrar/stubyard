import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { RUN_MODES, type RunMode, type WalkthroughStatus } from './schema.js';
import type {
  CleanupConflict,
  CleanupInput,
  CleanupItem,
  CleanupKept,
  CleanupList,
  CleanupListStatus,
  CleanupLog,
  CleanupResult,
  CleanupRunRef,
  CleanupRunResult,
  CleanupStatus,
  CleanupUser,
  StoredWalkthroughActor,
  WalkthroughListMode,
  WalkthroughSnapshot,
} from './types.js';

/**
 * Manual cleanup of the test data walkthroughs create (docs/design/storyboards.md, "Cleanup of test data"):
 *  - a run's fresh users (actors with created: true) and each one's messages;
 *  - for quick runs, the walkthrough record itself once every fresh user is gone (steps and shots cascade).
 * Tracked runs keep their record and evidence. Nothing runs automatically: the user presses the button.
 * Captured vars are shown as information only (values from the app under test; stubyard cannot remove them).
 *
 * Dependencies (walkthrough_uses, migration 26): run B "uses" run A when one of B's actors resolved to A's fresh user
 * (kind actor, that user only) or when B was started with uses: [A] (kind declared, all of A's fresh users). A
 * dependent still needs the data while it is active or while its own cleanup is pending (a finished run that created
 * nothing, cleanup none, no longer needs it).
 *
 * Settling: a pending run with no existing, non-Keep fresh user left is set to cleaned (lazily when listing or
 * previewing, after a user is deleted or Keep-pinned through the API, and at startup). Un-keeping a user sets its
 * creating run back to pending.
 */

const CLEANUP_STATUSES: readonly CleanupStatus[] = ['none', 'pending', 'cleaned', 'dismissed'];
const LIST_STATUSES: readonly CleanupListStatus[] = ['pending', 'cleaned', 'dismissed', 'all'];
const ON_CONFLICT = ['ask', 'keep', 'include'] as const;
const MAX_SELECTION = 100;
const MAX_SKIP_USERS = 500;
const LIST_CAP = 500;

interface Row {
  id: string;
  project_id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  snapshot: string;
  actors: string;
  vars: string;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
  cleanup_status: CleanupStatus;
  cleanup_at: string | null;
  cleanup_report: string | null;
}

/** Per selected run: what to delete and what stays. */
interface RunPlan {
  row: Row;
  toDelete: string[];
  kept: CleanupKept[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "run K" / "runs K1, K2". */
const runsText = (runs: { key: string }[]) => `${runs.length === 1 ? 'run' : 'runs'} ${runs.map((d) => d.key).join(', ')}`;
/** LIKE pattern matching `"userId":"<id>"` in an actors JSON (ESCAPE '\\'). */
const likeUserId = (userId: string) => `%"userId":${JSON.stringify(userId).replace(/[\\%_]/g, (c) => '\\' + c)}%`;

export class WalkthroughCleanup {
  constructor(private hub: Hub) {}

  // -------------------------------------------------------------------------------------------------------------
  // Rows and refs

  private row(projectId: string, idOrKey: string): Row | null {
    return (this.hub.db.prepare('SELECT * FROM walkthroughs WHERE project_id = ? AND (id = ? OR key = ?)').get(projectId, idOrKey, idOrKey) as Row | undefined) ?? null;
  }

  private requireRow(project: Project, idOrKey: string): Row {
    const r = typeof idOrKey === 'string' ? this.row(project.id, idOrKey) : null;
    if (!r) throw new HttpError(404, `Walkthrough "${String(idOrKey)}" not found`);
    return r;
  }

  private rowById(id: string): Row | null {
    return (this.hub.db.prepare('SELECT * FROM walkthroughs WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  ref(r: Row): CleanupRunRef {
    const snap = parseJson<Partial<WalkthroughSnapshot>>(r.snapshot, {});
    const sb = snap.storyboard;
    return { id: r.id, key: r.key, label: r.label, status: r.status, mode: r.mode, storyboard: sb && sb.slug ? { slug: sb.slug, name: sb.name } : null };
  }

  private name(r: Row): string {
    return r.label || this.ref(r).storyboard?.name || r.key;
  }

  /** The users this run created (actors with created: true), once each. */
  freshUsers(r: Row): StoredWalkthroughActor[] {
    const seen = new Set<string>();
    const out: StoredWalkthroughActor[] = [];
    for (const a of Object.values(parseJson<Record<string, StoredWalkthroughActor>>(r.actors, {}))) {
      if (!a?.created || !a.userId || seen.has(a.userId)) continue;
      seen.add(a.userId);
      out.push(a);
    }
    return out;
  }

  /** A dependent still needs the data while it is active, or while its own cleanup is pending. */
  private stillNeeds(d: Row): boolean {
    return d.status === 'active' || d.cleanup_status === 'pending';
  }

  /** Runs other than `source` that still need its fresh user `userId` (actor uses of that user, declared uses of the run). */
  dependents(source: Row, userId: string): Row[] {
    const rows = this.hub.db
      .prepare(
        `SELECT DISTINCT w.* FROM walkthrough_uses u JOIN walkthroughs w ON w.id = u.walkthrough_id
         WHERE u.source_walkthrough_id = ? AND w.id != ? AND (u.kind = 'declared' OR u.user_id = ?)
         ORDER BY w.started_at, w.id`,
      )
      .all(source.id, source.id, userId) as Row[];
    return rows.filter((d) => this.stillNeeds(d));
  }

  private usesOf(r: Row): CleanupRunRef[] {
    const rows = this.hub.db
      .prepare(
        `SELECT DISTINCT w.* FROM walkthrough_uses u JOIN walkthroughs w ON w.id = u.source_walkthrough_id
         WHERE u.walkthrough_id = ? ORDER BY w.started_at, w.id`,
      )
      .all(r.id) as Row[];
    return rows.map((x) => this.ref(x));
  }

  private messageCount(projectId: string, userId: string): number {
    return (this.hub.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND test_user_id = ?').get(projectId, userId) as { n: number }).n;
  }

  private lastReport(r: Row): CleanupRunResult | null {
    const x = parseJson<Record<string, unknown> | null>(r.cleanup_report ?? '', null);
    return isObj(x) && isObj(x.removed) ? (x as unknown as CleanupRunResult) : null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Dependency recording (walkthroughs.ts calls these inside its start / refresh transaction)

  /** The walkthrough (other than `exceptId`) whose fresh user `userId` is, if any. LIKE prefilter, confirmed by parsing. */
  creatorOf(projectId: string, userId: string, exceptId: string): string | null {
    const rows = this.hub.db
      .prepare("SELECT id, actors FROM walkthroughs WHERE project_id = ? AND id != ? AND actors LIKE ? ESCAPE '\\'")
      .all(projectId, exceptId, likeUserId(userId)) as { id: string; actors: string }[];
    for (const r of rows) {
      const actors = parseJson<Record<string, StoredWalkthroughActor>>(r.actors, {});
      if (Object.values(actors).some((a) => a?.created && a.userId === userId)) return r.id;
    }
    return null;
  }

  recordUse(projectId: string, walkthroughId: string, sourceId: string, kind: 'actor' | 'declared', userId: string | null): void {
    if (walkthroughId === sourceId) return;
    this.hub.db
      .prepare('INSERT OR IGNORE INTO walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at) VALUES (?,?,?,?,?,?)')
      .run(walkthroughId, projectId, sourceId, userId, kind, nowIso());
  }

  /** StartWalkthroughInput.uses → walkthrough ids (400 for anything that is not a walkthrough of the project). */
  resolveUses(project: Project, uses: unknown): string[] {
    if (uses === undefined || uses === null) return [];
    if (!Array.isArray(uses)) throw new HttpError(400, 'uses must be an array of walkthrough ids or keys');
    if (uses.length > 20) throw new HttpError(400, 'uses can list at most 20 walkthroughs');
    const out: string[] = [];
    for (const u of uses) {
      if (typeof u !== 'string' || !u.trim()) throw new HttpError(400, 'uses must be an array of walkthrough ids or keys');
      const r = this.row(project.id, u.trim());
      if (!r) throw new HttpError(400, `uses: walkthrough "${u}" not found in this project`, { uses: u });
      if (!out.includes(r.id)) out.push(r.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Items

  private users(r: Row): CleanupUser[] {
    return this.freshUsers(r).map((a) => {
      const u = this.hub.users.get(r.project_id, a.userId);
      return {
        userId: a.userId,
        name: u?.name ?? a.name,
        email: u?.email ?? a.email,
        role: u?.role ?? a.role,
        exists: !!u,
        keep: !!u?.keep,
        messages: u ? this.messageCount(r.project_id, a.userId) : 0,
        usedBy: u ? this.dependents(r, a.userId).map((d) => this.ref(d)) : [],
      };
    });
  }

  item(r: Row): CleanupItem {
    const users = this.users(r);
    const warnings: string[] = [];
    if (r.status === 'active') warnings.push('Still active: finish or abandon it before cleaning up');
    for (const u of users) {
      if (!u.exists) continue;
      if (u.keep) warnings.push(`User ${u.email ?? u.name} is kept (Keep pin): cleanup leaves it`);
      else if (u.usedBy.length) warnings.push(`User ${u.email ?? u.name} is used by ${runsText(u.usedBy)}`);
    }
    if (r.cleanup_status === 'dismissed') {
      const note = parseJson<Record<string, unknown> | null>(r.cleanup_report ?? '', null);
      warnings.push(`Dismissed: the data stays${isObj(note) && typeof note.dismissNote === 'string' && note.dismissNote ? ` (${note.dismissNote})` : ''}`);
    }
    const removableUsers = users.filter((u) => u.exists && !u.keep && !u.usedBy.length);
    // A quick run's record goes only once none of its users remains (a Keep-pinned one keeps the record too).
    const remaining = users.filter((u) => u.exists).length - removableUsers.length;
    return {
      walkthrough: { ...this.ref(r), cleanupStatus: r.cleanup_status, cleanupAt: r.cleanup_at, startedAt: r.started_at, finishedAt: r.finished_at },
      users,
      vars: parseJson<Record<string, string>>(r.vars, {}),
      uses: this.usesOf(r),
      removable: {
        users: removableUsers.length,
        messages: removableUsers.reduce((n, u) => n + u.messages, 0),
        record: r.mode === 'quick' && r.status !== 'active' && r.cleanup_status !== 'none' && remaining === 0,
      },
      warnings,
      lastReport: this.lastReport(r),
    };
  }

  list(project: Project, opts: { status?: CleanupListStatus; mode?: WalkthroughListMode } = {}): CleanupList {
    const status = opts.status ?? 'pending';
    if (!LIST_STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${LIST_STATUSES.join(', ')}`);
    const mode = opts.mode ?? 'all';
    if (mode !== 'all' && !(RUN_MODES as readonly string[]).includes(mode)) throw new HttpError(400, `mode must be one of ${RUN_MODES.join(', ')}, all`);
    this.settleProject(project);
    const modeSql = mode === 'all' ? '' : ' AND mode = ?';
    const modeArgs = mode === 'all' ? [] : [mode];
    const counted = this.hub.db
      .prepare(`SELECT cleanup_status AS s, status = 'active' AS active, COUNT(*) AS n FROM walkthroughs WHERE project_id = ?${modeSql} GROUP BY 1, 2`)
      .all(project.id, ...modeArgs) as { s: CleanupStatus; active: number; n: number }[];
    const counts = { pending: 0, active: 0, cleaned: 0, dismissed: 0 };
    for (const c of counted) {
      if (c.s === 'none') continue;
      if (c.active) {
        if (c.s === 'pending') counts.active += c.n;
      } else if (c.s in counts) counts[c.s as 'pending' | 'cleaned' | 'dismissed'] += c.n;
    }
    const statuses = status === 'all' ? ['pending', 'cleaned', 'dismissed'] : [status];
    const rows = this.hub.db
      .prepare(
        `SELECT * FROM walkthroughs WHERE project_id = ? AND status != 'active' AND cleanup_status IN (${statuses.map(() => '?').join(',')})${modeSql}
         ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC LIMIT ?`,
      )
      .all(project.id, ...statuses, ...modeArgs, LIST_CAP + 1) as Row[];
    const truncated = rows.length > LIST_CAP;
    return { items: rows.slice(0, LIST_CAP).map((r) => this.item(r)), counts, truncated };
  }

  get(project: Project, idOrKey: string): CleanupItem {
    const r = this.requireRow(project, idOrKey);
    return this.item(this.settle(project, r) ? this.rowById(r.id)! : r);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Settling (a pending run with nothing left to remove is cleaned) and Keep changes

  /** Whether the run has a fresh user that still exists and is not Keep-pinned. */
  private hasRemovableUser(r: Row): boolean {
    return this.freshUsers(r).some((a) => {
      const u = this.hub.users.get(r.project_id, a.userId);
      return !!u && !u.keep;
    });
  }

  /** A pending, non-active run with no existing non-Keep fresh user left becomes cleaned. True when it changed. */
  private settle(project: Project | null, r: Row): boolean {
    if (r.cleanup_status !== 'pending' || r.status === 'active' || this.hasRemovableUser(r)) return false;
    this.hub.db.prepare("UPDATE walkthroughs SET cleanup_status = 'cleaned', cleanup_at = ? WHERE id = ? AND cleanup_status = 'pending'").run(nowIso(), r.id);
    if (project) this.publish(project, r, 'cleaned');
    return true;
  }

  private settleProject(project: Project): void {
    const rows = this.hub.db.prepare("SELECT * FROM walkthroughs WHERE project_id = ? AND cleanup_status = 'pending' AND status != 'active'").all(project.id) as Row[];
    for (const r of rows) this.settle(project, r);
  }

  /** The runs whose fresh user `userId` is (LIKE prefilter, confirmed by parsing). */
  private creatorsOf(projectId: string, userId: string): Row[] {
    const rows = this.hub.db
      .prepare("SELECT * FROM walkthroughs WHERE project_id = ? AND actors LIKE ? ESCAPE '\\'")
      .all(projectId, likeUserId(userId)) as Row[];
    return rows.filter((r) => this.freshUsers(r).some((a) => a.userId === userId));
  }

  /**
   * A test user was deleted, Keep-pinned or un-pinned through the API. Deleted / kept: its creating run is settled
   * (cleaned when nothing is left to remove). Un-kept: a cleaned creating run is pending again.
   */
  userChanged(project: Project, userId: string, change: 'deleted' | 'kept' | 'unkept'): void {
    for (const r of this.creatorsOf(project.id, userId)) {
      if (change !== 'unkept') this.settle(project, r);
      else if (r.cleanup_status === 'cleaned') {
        this.hub.db.prepare("UPDATE walkthroughs SET cleanup_status = 'pending', cleanup_at = NULL WHERE id = ?").run(r.id);
        this.publish(project, r, 'pending');
      }
    }
  }

  /**
   * Startup (after migrations): actor dependencies of runs from before migration 26 (an actor with created: false whose
   * user is another run's fresh user, same project), then settle pending runs with nothing left. Idempotent.
   */
  backfill(): { uses: number; settled: number } {
    return this.hub.db.transaction(() => {
      const rows = this.hub.db.prepare('SELECT * FROM walkthroughs').all() as Row[];
      const creators = new Map<string, string>();
      const k = (projectId: string, userId: string) => `${projectId}|${userId}`;
      for (const r of rows) for (const a of this.freshUsers(r)) if (!creators.has(k(r.project_id, a.userId))) creators.set(k(r.project_id, a.userId), r.id);
      const ins = this.hub.db.prepare(
        "INSERT OR IGNORE INTO walkthrough_uses (walkthrough_id, project_id, source_walkthrough_id, user_id, kind, created_at) VALUES (?,?,?,?,'actor',?)",
      );
      const now = nowIso();
      let uses = 0;
      for (const r of rows) {
        if (!r.actors.includes('"created":false')) continue;
        for (const a of Object.values(parseJson<Record<string, StoredWalkthroughActor>>(r.actors, {}))) {
          if (!a || a.created || !a.userId) continue;
          const source = creators.get(k(r.project_id, a.userId));
          if (source && source !== r.id) uses += ins.run(r.id, r.project_id, source, a.userId, now).changes;
        }
      }
      let settled = 0;
      for (const r of rows) if (this.settle(null, r)) settled++;
      return { uses, settled };
    })();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Dismiss / reopen

  dismiss(project: Project, idOrKey: string, note?: unknown): CleanupItem {
    const r = this.requireRow(project, idOrKey);
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 4000)) throw new HttpError(400, 'note must be a string of at most 4000 characters');
    if (r.status === 'active') throw new HttpError(409, `Walkthrough ${r.key} is still active: finish or abandon it first`);
    if (r.cleanup_status === 'cleaned') throw new HttpError(409, `Walkthrough ${r.key} is already cleaned up`);
    if (r.cleanup_status === 'none') throw new HttpError(409, `Walkthrough ${r.key} created no test data: there is nothing to dismiss`);
    const report = { ...(this.lastReport(r) ?? {}), dismissNote: typeof note === 'string' ? note : '' };
    this.hub.db.prepare("UPDATE walkthroughs SET cleanup_status = 'dismissed', cleanup_at = ?, cleanup_report = ? WHERE id = ?").run(nowIso(), JSON.stringify(report), r.id);
    this.publish(project, r, 'dismissed');
    return this.item(this.rowById(r.id)!);
  }

  reopen(project: Project, idOrKey: string): CleanupItem {
    const r = this.requireRow(project, idOrKey);
    if (r.cleanup_status !== 'dismissed') throw new HttpError(409, `Walkthrough ${r.key} was not dismissed (cleanup ${r.cleanup_status})`);
    const last = this.lastReport(r);
    if (last) delete (last as unknown as Record<string, unknown>).dismissNote;
    this.hub.db.prepare("UPDATE walkthroughs SET cleanup_status = 'pending', cleanup_at = NULL, cleanup_report = ? WHERE id = ?").run(last ? JSON.stringify(last) : null, r.id);
    this.publish(project, r, 'pending');
    return this.item(this.rowById(r.id)!);
  }

  private publish(project: Project, r: Row, cleanup: CleanupStatus, deleted?: true): void {
    this.hub.bus.publish({ type: 'walkthrough.changed', projectId: project.id, data: { id: r.id, status: r.status, cleanup, ...(deleted ? { deleted } : {}) } });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Cleanup

  async cleanup(project: Project, input: CleanupInput, opts: { log?: CleanupLog } = {}): Promise<CleanupResult> {
    const b = (isObj(input) ? input : {}) as Record<string, unknown>;
    if (!Array.isArray(b.walkthroughs) || !b.walkthroughs.length || b.walkthroughs.length > MAX_SELECTION || b.walkthroughs.some((x) => typeof x !== 'string' || !x)) {
      throw new HttpError(400, `walkthroughs must be an array of 1 to ${MAX_SELECTION} walkthrough ids or keys`);
    }
    if (b.skipUsers !== undefined && (!Array.isArray(b.skipUsers) || b.skipUsers.some((x) => typeof x !== 'string'))) throw new HttpError(400, 'skipUsers must be an array of user ids');
    if (Array.isArray(b.skipUsers) && b.skipUsers.length > MAX_SKIP_USERS) throw new HttpError(400, `skipUsers can list at most ${MAX_SKIP_USERS} users`);
    if (b.onConflict !== undefined && !(ON_CONFLICT as readonly unknown[]).includes(b.onConflict)) throw new HttpError(400, `onConflict must be one of ${ON_CONFLICT.join(', ')}`);
    if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw new HttpError(400, 'dryRun must be a boolean');
    const onConflict = (b.onConflict ?? 'ask') as (typeof ON_CONFLICT)[number];
    const dryRun = b.dryRun === true;
    const skip = new Set(((b.skipUsers as string[] | undefined) ?? []).map((s) => s.trim().toLowerCase()));
    const skipped = (u: { id: string; email: string | null }) => skip.has(u.id.toLowerCase()) || (!!u.email && skip.has(u.email.toLowerCase()));

    const selection = new Map<string, Row>();
    for (const ref of b.walkthroughs as string[]) {
      const r = this.requireRow(project, ref);
      if (r.status === 'active') throw new HttpError(409, `Walkthrough ${r.key} is still active: finish or abandon it first`);
      selection.set(r.id, r);
    }

    // include: the non-active dependents join the selection, transitively.
    if (onConflict === 'include') {
      for (let changed = true; changed; ) {
        changed = false;
        for (const r of [...selection.values()]) {
          for (const a of this.freshUsers(r)) {
            // Only users this cleanup will actually delete pull their dependents in.
            const u = this.hub.users.get(project.id, a.userId);
            if (!u || u.keep || skipped(u)) continue;
            for (const d of this.dependents(r, a.userId)) {
              if (d.status === 'active' || selection.has(d.id)) continue;
              selection.set(d.id, d);
              changed = true;
            }
          }
        }
      }
    }

    // Plan: per run, the users to delete and the ones that stay (with why).
    const conflicts: CleanupConflict[] = [];
    const plans: RunPlan[] = [];
    for (const r of selection.values()) {
      const plan: RunPlan = { row: r, toDelete: [], kept: [] };
      for (const a of this.freshUsers(r)) {
        const u = this.hub.users.get(project.id, a.userId);
        if (!u) continue; // already gone
        if (u.keep) {
          plan.kept.push({ userId: u.id, email: u.email, reason: 'keep' });
          continue;
        }
        if (skipped(u)) {
          plan.kept.push({ userId: u.id, email: u.email, reason: 'skipped' });
          continue;
        }
        const outside = this.dependents(r, u.id).filter((d) => !selection.has(d.id));
        if (!outside.length) {
          plan.toDelete.push(u.id);
          continue;
        }
        const usedBy = outside.map((d) => this.ref(d));
        conflicts.push({ userId: u.id, email: u.email, walkthrough: this.ref(r), usedBy });
        const allActive = outside.every((d) => d.status === 'active');
        plan.kept.push({ userId: u.id, email: u.email, reason: onConflict === 'include' && allActive ? 'used-by-active' : 'used-by', usedBy });
      }
      plans.push(plan);
    }

    if (conflicts.length && onConflict === 'ask' && !dryRun) {
      const text = conflicts.map((c) => `user ${c.email ?? c.userId} is also used by ${runsText(c.usedBy)}`).join('; ');
      throw new HttpError(
        409,
        `${plural(conflicts.length, 'user')} to clean up ${conflicts.length === 1 ? 'is' : 'are'} still used by other runs: ${text} (onConflict "keep" leaves them, "include" cleans those runs too)`,
        { conflicts },
      );
    }

    const deletedUsers = new Set<string>();
    const results: CleanupRunResult[] = [];
    const orphanMailpitIds: string[] = [];
    const now = nowIso();
    const apply = () => {
      for (const plan of plans) {
        const r = plan.row;
        let messages = 0;
        let users = 0;
        for (const uid of plan.toDelete) {
          if (deletedUsers.has(uid)) continue;
          if (dryRun) messages += this.messageCount(project.id, uid);
          else {
            // Messages first: they reference users with ON DELETE SET NULL and would land in Unassigned.
            const m = this.hub.messages.delete(project.id, { testUserId: uid });
            messages += m.deleted;
            orphanMailpitIds.push(...m.orphanMailpitIds);
            this.hub.users.delete(project.id, uid);
          }
          deletedUsers.add(uid);
          users++;
        }
        // Cleaned when no created user remains that is not Keep-pinned. A run that created nothing (none) keeps its status.
        const none = r.cleanup_status === 'none';
        const cleaned = plan.kept.every((k) => k.reason === 'keep');
        // A quick run's record goes once none of its users remains: Keep-pinned users keep it (cleaned, hidden from
        // history) so un-pinning them can reopen it.
        const record = cleaned && !none && r.mode === 'quick' && plan.kept.length === 0;
        const result: CleanupRunResult = {
          id: r.id,
          key: r.key,
          label: r.label,
          mode: r.mode,
          status: cleaned ? 'cleaned' : 'partial',
          removed: { users, messages, record },
          kept: plan.kept,
          vars: parseJson<Record<string, string>>(r.vars, {}),
        };
        results.push(result);
        if (dryRun || none) continue;
        if (record) this.hub.db.prepare('DELETE FROM walkthroughs WHERE id = ?').run(r.id);
        else if (cleaned) this.hub.db.prepare("UPDATE walkthroughs SET cleanup_status = 'cleaned', cleanup_at = ?, cleanup_report = ? WHERE id = ?").run(now, JSON.stringify(result), r.id);
        else this.hub.db.prepare('UPDATE walkthroughs SET cleanup_report = ? WHERE id = ?').run(JSON.stringify(result), r.id);
      }
    };
    if (dryRun) apply();
    else this.hub.db.transaction(apply)();

    if (!dryRun) {
      await this.deleteMailpit(orphanMailpitIds, opts.log);
      for (const res of results) {
        const r = selection.get(res.id)!;
        this.publish(project, r, res.status === 'cleaned' && r.cleanup_status !== 'none' ? 'cleaned' : r.cleanup_status, res.removed.record || undefined);
      }
      for (const id of deletedUsers) this.hub.bus.publish({ type: 'user.changed', projectId: project.id, data: { deleted: id } });
    }
    return {
      dryRun,
      runs: results,
      conflicts: dryRun ? conflicts : [],
      totals: {
        users: results.reduce((n, x) => n + x.removed.users, 0),
        messages: results.reduce((n, x) => n + x.removed.messages, 0),
        records: results.filter((x) => x.removed.record).length,
      },
    };
  }

  /**
   * DELETE /walkthroughs/:id. A run with test data to clean up (cleanup pending) answers 409 unless users=1 (its fresh
   * users go with their messages, by the cleanup rules) or force=1 (the record goes, the data stays). With users=1, a
   * user another run still needs answers 409 listing them unless force=1 (they then stay). Keep-pinned users always stay.
   */
  async deleteRun(project: Project, idOrKey: string, opts: { users?: boolean; force?: boolean; log?: CleanupLog } = {}): Promise<{ deleted: string; users: number; kept: CleanupKept[] }> {
    const r = this.requireRow(project, idOrKey);
    if (r.cleanup_status === 'pending' && !opts.users && !opts.force) {
      throw new HttpError(409, `Walkthrough ${r.key} has test data to clean up: use Clean up, ?users=1, or ?force=1`, { code: 'cleanup_pending' });
    }
    const kept: CleanupKept[] = [];
    const toDelete: string[] = [];
    if (opts.users) {
      for (const a of this.freshUsers(r)) {
        const u = this.hub.users.get(project.id, a.userId);
        if (!u) continue;
        if (u.keep) {
          kept.push({ userId: u.id, email: u.email, reason: 'keep' });
          continue;
        }
        const deps = this.dependents(r, u.id);
        if (deps.length) {
          kept.push({ userId: u.id, email: u.email, reason: deps.every((d) => d.status === 'active') ? 'used-by-active' : 'used-by', usedBy: deps.map((d) => this.ref(d)) });
          continue;
        }
        toDelete.push(u.id);
      }
      const used = kept.filter((k) => k.reason === 'used-by' || k.reason === 'used-by-active');
      if (used.length && !opts.force) {
        const text = used.map((k) => `${k.email ?? k.userId} (${runsText(k.usedBy ?? [])})`).join('; ');
        throw new HttpError(409, `${plural(used.length, 'user')} of walkthrough ${r.key} ${used.length === 1 ? 'is' : 'are'} still used by other runs: ${text}. Clean up those runs too, or ?force=1 deletes the run and leaves these users`, {
          code: 'users_in_use',
          kept: used,
        });
      }
    }
    const orphanMailpitIds: string[] = [];
    this.hub.db.transaction(() => {
      for (const id of toDelete) {
        const m = this.hub.messages.delete(project.id, { testUserId: id });
        orphanMailpitIds.push(...m.orphanMailpitIds);
        this.hub.users.delete(project.id, id);
      }
      this.hub.db.prepare('DELETE FROM walkthroughs WHERE id = ?').run(r.id);
    })();
    await this.deleteMailpit(orphanMailpitIds, opts.log);
    this.publish(project, r, r.cleanup_status, true);
    for (const id of toDelete) this.hub.bus.publish({ type: 'user.changed', projectId: project.id, data: { deleted: id } });
    return { deleted: r.id, users: toDelete.length, kept };
  }

  private async deleteMailpit(ids: string[], log?: CleanupLog): Promise<void> {
    if (!ids.length || !this.hub.mailpit) return;
    try {
      await this.hub.mailpit.deleteMessages(ids);
    } catch (err) {
      (log ?? ((e, msg) => console.warn(msg, e)))(err, 'could not delete Mailpit messages');
    }
  }
}

export { CLEANUP_STATUSES };
