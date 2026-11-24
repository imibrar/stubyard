import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import type { ScheduleAction } from './actions.js';

/** Scheduled actions (migration 14). */

export type ScheduleStatus = 'pending' | 'paused' | 'done' | 'failed' | 'cancelled' | 'missed';
export const ACTIVE_STATUSES: ScheduleStatus[] = ['pending', 'paused'];

export interface Schedule {
  id: string;
  projectId: string;
  runId: string | null;
  label: string;
  action: ScheduleAction;
  method: string;
  /** Suffix after /api/projects/<slug>. */
  path: string;
  body: unknown;
  status: ScheduleStatus;
  nextAt: string | null;
  everyMs: number | null;
  maxFires: number;
  fired: number;
  missed: number;
  gen: number;
  jobId: string | null;
  lastFiredAt: string | null;
  lastStatus: number | null;
  lastResult: unknown;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Teams mode: the user whose permissions the fires use (null: stubyard itself). */
  createdBy: string | null;
}

interface Row {
  id: string;
  project_id: string;
  run_id: string | null;
  label: string;
  action: ScheduleAction;
  method: string;
  path: string;
  body: string | null;
  status: ScheduleStatus;
  next_at: string | null;
  every_ms: number | null;
  max_fires: number;
  fired: number;
  missed: number;
  gen: number;
  job_id: string | null;
  last_fired_at: string | null;
  last_status: number | null;
  last_result: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id,
  label: r.label,
  action: r.action,
  method: r.method,
  path: r.path,
  body: r.body === null ? null : parseJson<unknown>(r.body, r.body),
  status: r.status,
  nextAt: r.next_at,
  everyMs: r.every_ms,
  maxFires: r.max_fires,
  fired: r.fired,
  missed: r.missed,
  gen: r.gen,
  jobId: r.job_id,
  lastFiredAt: r.last_fired_at,
  lastStatus: r.last_status,
  lastResult: r.last_result === null ? null : parseJson<unknown>(r.last_result, r.last_result),
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  createdBy: r.created_by ?? null,
});

const COLS: Record<string, string> = {
  label: 'label',
  body: 'body',
  status: 'status',
  nextAt: 'next_at',
  everyMs: 'every_ms',
  maxFires: 'max_fires',
  fired: 'fired',
  missed: 'missed',
  gen: 'gen',
  jobId: 'job_id',
  lastFiredAt: 'last_fired_at',
  lastStatus: 'last_status',
  lastResult: 'last_result',
  lastError: 'last_error',
  createdBy: 'created_by',
};

export type SchedulePatch = Partial<Pick<Schedule, 'label' | 'status' | 'nextAt' | 'everyMs' | 'maxFires' | 'fired' | 'missed' | 'gen' | 'jobId' | 'lastFiredAt' | 'lastStatus' | 'lastError' | 'createdBy'>> & {
  /** JSON text (or null). */
  body?: string | null;
  /** JSON text (or null). */
  lastResult?: string | null;
};

export class ScheduleRepo {
  constructor(private db: DB) {}

  create(i: { projectId: string; runId: string | null; label: string; action: ScheduleAction; method: string; path: string; body: string | null; nextAt: string; everyMs: number | null; maxFires: number; createdBy?: string | null }): Schedule {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        'INSERT INTO schedules (id, project_id, run_id, label, action, method, path, body, next_at, every_ms, max_fires, created_at, updated_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, i.projectId, i.runId, i.label, i.action, i.method, i.path, i.body, i.nextAt, i.everyMs, i.maxFires, now, now, i.createdBy ?? null);
    return this.get(id)!;
  }

  get(id: string): Schedule | null {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    return r ? toSchedule(r) : null;
  }

  require(projectId: string, id: string): Schedule {
    const s = this.get(id);
    if (!s || s.projectId !== projectId) throw new HttpError(404, `Unknown schedule "${id}"`);
    return s;
  }

  list(projectId: string, f: { status?: ScheduleStatus[]; runId?: string } = {}): Schedule[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      args.push(...f.status);
    }
    if (f.runId) {
      where.push('run_id = ?');
      args.push(f.runId);
    }
    // Active first (soonest next), then finished (newest first).
    const rows = this.db
      .prepare(
        `SELECT * FROM schedules WHERE ${where.join(' AND ')} ORDER BY CASE WHEN status IN ('pending','paused') THEN 0 ELSE 1 END, CASE WHEN status IN ('pending','paused') THEN next_at END ASC, updated_at DESC LIMIT 1000`,
      )
      .all(...args) as Row[];
    return rows.map(toSchedule);
  }

  countActive(projectId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE project_id = ? AND status IN ('pending','paused')").get(projectId) as { n: number }).n;
  }

  /** Active (pending / paused) schedules of a project or a run. */
  active(f: { projectId?: string; runId?: string }): Schedule[] {
    const rows = f.runId
      ? this.db.prepare("SELECT * FROM schedules WHERE run_id = ? AND status IN ('pending','paused')").all(f.runId)
      : this.db.prepare("SELECT * FROM schedules WHERE project_id = ? AND status IN ('pending','paused')").all(f.projectId ?? '');
    return (rows as Row[]).map(toSchedule);
  }

  update(id: string, patch: SchedulePatch): Schedule | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(v);
    }
    sets.push('updated_at = ?');
    args.push(nowIso(), id);
    this.db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return this.get(id);
  }

  /** Claim fire number `seq` (compare-and-set on fired): false when someone else fired it already. */
  claimFire(id: string, seq: number, at: string): boolean {
    return (
      this.db
        .prepare("UPDATE schedules SET fired = fired + 1, last_fired_at = ?, updated_at = ? WHERE id = ? AND fired = ? AND status IN ('pending','paused')")
        .run(at, at, id, seq).changes === 1
    );
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  /** Delete finished schedules last changed before the cutoff. */
  purgeFinished(cutoffIso: string): number {
    return Number(this.db.prepare("DELETE FROM schedules WHERE status NOT IN ('pending','paused') AND updated_at < ?").run(cutoffIso).changes);
  }
}
