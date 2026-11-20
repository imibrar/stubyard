import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';
import type { AutoReplyFire, AutoReplyRule, FirePlan, FireStatus } from './types.js';

interface RuleRow {
  id: string;
  project_id: string;
  run_id: string | null;
  name: string;
  position: number;
  enabled: number;
  channel: string;
  match: string;
  reply: string;
  delay_ms: number;
  jitter_ms: number;
  max_uses: number | null;
  uses: number;
  stop: number;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface FireRow {
  id: string;
  project_id: string;
  rule_id: string;
  run_id: string | null;
  trigger_message_id: string;
  test_user_id: string | null;
  job_id: string | null;
  status: string;
  due_at: string;
  fired_at: string | null;
  plan: string;
  reply_message_id: string | null;
  webhook_status: number | null;
  webhook_ok: number | null;
  error: string | null;
  created_at: string;
}

const toRule = (r: RuleRow): AutoReplyRule => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id,
  name: r.name,
  position: r.position,
  enabled: r.enabled === 1,
  channel: r.channel as AutoReplyRule['channel'],
  match: parseJson(r.match, {}),
  reply: parseJson(r.reply, { text: '' }),
  delayMs: r.delay_ms,
  jitterMs: r.jitter_ms,
  maxUses: r.max_uses,
  uses: r.uses,
  stop: r.stop === 1,
  disabledReason: r.disabled_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toFire = (r: FireRow): AutoReplyFire => ({
  id: r.id,
  projectId: r.project_id,
  ruleId: r.rule_id,
  runId: r.run_id,
  triggerMessageId: r.trigger_message_id,
  testUserId: r.test_user_id,
  jobId: r.job_id,
  status: r.status as FireStatus,
  dueAt: r.due_at,
  firedAt: r.fired_at,
  plan: parseJson<FirePlan>(r.plan, { captures: {}, warnings: [] }),
  replyMessageId: r.reply_message_id,
  webhookStatus: r.webhook_status,
  webhookOk: r.webhook_ok === null ? null : r.webhook_ok === 1,
  error: r.error,
  createdAt: r.created_at,
});

export type RuleFields = Omit<AutoReplyRule, 'id' | 'projectId' | 'runId' | 'createdAt' | 'updatedAt'>;

export interface FireQuery {
  ruleId?: string;
  runId?: string;
  status?: string[];
  testUserId?: string;
  after?: string;
  limit?: number;
}

/** auto_reply_rules and auto_reply_fires (migration 20). */
export class AutoReplyRepo {
  constructor(private db: DB) {}

  // ---------------- rules

  listRules(projectId: string, opts: { runId?: string | null; all?: boolean } = {}): AutoReplyRule[] {
    let rows: RuleRow[];
    if (opts.runId) rows = this.db.prepare('SELECT * FROM auto_reply_rules WHERE project_id = ? AND run_id = ? ORDER BY position, created_at').all(projectId, opts.runId) as RuleRow[];
    else if (opts.all) rows = this.db.prepare('SELECT * FROM auto_reply_rules WHERE project_id = ? ORDER BY run_id IS NOT NULL, position, created_at').all(projectId) as RuleRow[];
    else rows = this.db.prepare('SELECT * FROM auto_reply_rules WHERE project_id = ? AND run_id IS NULL ORDER BY position, created_at').all(projectId) as RuleRow[];
    return rows.map(toRule);
  }

  /** Rules that see a message of this run: the run's own rules first, then project rules; each by position. */
  rulesFor(projectId: string, runId: string | null): AutoReplyRule[] {
    const run = runId ? this.listRules(projectId, { runId }) : [];
    return [...run, ...this.listRules(projectId)];
  }

  getRule(projectId: string, id: string): AutoReplyRule | null {
    const r = this.db.prepare('SELECT * FROM auto_reply_rules WHERE project_id = ? AND id = ?').get(projectId, id) as RuleRow | undefined;
    return r ? toRule(r) : null;
  }

  ruleById(id: string): AutoReplyRule | null {
    const r = this.db.prepare('SELECT * FROM auto_reply_rules WHERE id = ?').get(id) as RuleRow | undefined;
    return r ? toRule(r) : null;
  }

  createRule(projectId: string, runId: string | null, f: RuleFields): AutoReplyRule {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO auto_reply_rules (id, project_id, run_id, name, position, enabled, channel, match, reply, delay_ms, jitter_ms, max_uses, uses, stop, disabled_reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, projectId, runId, f.name, f.position, f.enabled ? 1 : 0, f.channel, JSON.stringify(f.match), JSON.stringify(f.reply), f.delayMs, f.jitterMs, f.maxUses, f.uses, f.stop ? 1 : 0, f.disabledReason, now, now);
    return this.getRule(projectId, id)!;
  }

  updateRule(projectId: string, id: string, f: Partial<RuleFields>): AutoReplyRule | null {
    const cols: Record<keyof RuleFields, string> = {
      name: 'name', position: 'position', enabled: 'enabled', channel: 'channel', match: 'match', reply: 'reply', delayMs: 'delay_ms',
      jitterMs: 'jitter_ms', maxUses: 'max_uses', uses: 'uses', stop: 'stop', disabledReason: 'disabled_reason',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(f) as [keyof RuleFields, unknown][]) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
    }
    if (sets.length) this.db.prepare(`UPDATE auto_reply_rules SET ${sets.join(', ')}, updated_at = ? WHERE project_id = ? AND id = ?`).run(...vals, nowIso(), projectId, id);
    return this.getRule(projectId, id);
  }

  deleteRule(projectId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM auto_reply_rules WHERE project_id = ? AND id = ?').run(projectId, id).changes === 1;
  }

  deleteRules(projectId: string, runId: string | null): number {
    return Number(
      (runId
        ? this.db.prepare('DELETE FROM auto_reply_rules WHERE project_id = ? AND run_id = ?').run(projectId, runId)
        : this.db.prepare('DELETE FROM auto_reply_rules WHERE project_id = ? AND run_id IS NULL').run(projectId)
      ).changes,
    );
  }

  nextPosition(projectId: string, runId: string | null): number {
    const r = (
      runId
        ? this.db.prepare('SELECT MAX(position) AS p FROM auto_reply_rules WHERE project_id = ? AND run_id = ?').get(projectId, runId)
        : this.db.prepare('SELECT MAX(position) AS p FROM auto_reply_rules WHERE project_id = ? AND run_id IS NULL').get(projectId)
    ) as { p: number | null };
    return (r.p ?? -1) + 1;
  }

  /** Atomically count one use. false when max_uses is already reached. */
  takeUse(id: string): boolean {
    return this.db.prepare('UPDATE auto_reply_rules SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)').run(id).changes === 1;
  }

  // ---------------- fires

  /** Inserts a pending fire; null when this rule already fired for this message (UNIQUE rule_id, trigger_message_id). */
  insertFire(f: Omit<AutoReplyFire, 'id' | 'createdAt' | 'firedAt' | 'replyMessageId' | 'webhookStatus' | 'webhookOk' | 'error' | 'jobId'>): AutoReplyFire | null {
    const id = newId();
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO auto_reply_fires (id, project_id, rule_id, run_id, trigger_message_id, test_user_id, status, due_at, plan, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, f.projectId, f.ruleId, f.runId, f.triggerMessageId, f.testUserId, f.status, f.dueAt, JSON.stringify(f.plan), nowIso());
    return r.changes === 1 ? this.getFire(f.projectId, id) : null;
  }

  hasFire(ruleId: string, triggerMessageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auto_reply_fires WHERE rule_id = ? AND trigger_message_id = ?').get(ruleId, triggerMessageId);
  }

  getFire(projectId: string, id: string): AutoReplyFire | null {
    const r = this.db.prepare('SELECT * FROM auto_reply_fires WHERE project_id = ? AND id = ?').get(projectId, id) as FireRow | undefined;
    return r ? toFire(r) : null;
  }

  fireById(id: string): AutoReplyFire | null {
    const r = this.db.prepare('SELECT * FROM auto_reply_fires WHERE id = ?').get(id) as FireRow | undefined;
    return r ? toFire(r) : null;
  }

  listFires(projectId: string, q: FireQuery = {}): AutoReplyFire[] {
    const where = ['project_id = ?'];
    const vals: unknown[] = [projectId];
    if (q.ruleId) (where.push('rule_id = ?'), vals.push(q.ruleId));
    if (q.runId) (where.push('run_id = ?'), vals.push(q.runId));
    if (q.testUserId) (where.push('test_user_id = ?'), vals.push(q.testUserId));
    if (q.after) (where.push('id > ?'), vals.push(q.after));
    if (q.status?.length) (where.push(`status IN (${q.status.map(() => '?').join(',')})`), vals.push(...q.status));
    const limit = Math.min(500, Math.max(1, q.limit ?? 50));
    // "after" lists oldest first (a cursor walks forward); otherwise newest first.
    const order = q.after ? 'ORDER BY id ASC' : 'ORDER BY id DESC';
    return (this.db.prepare(`SELECT * FROM auto_reply_fires WHERE ${where.join(' AND ')} ${order} LIMIT ${limit}`).all(...vals) as FireRow[]).map(toFire);
  }

  pendingFires(projectId: string, runId?: string | null): AutoReplyFire[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM auto_reply_fires WHERE project_id = ? AND run_id = ? AND status = 'pending' ORDER BY due_at, id").all(projectId, runId)
      : this.db.prepare("SELECT * FROM auto_reply_fires WHERE project_id = ? AND status = 'pending' ORDER BY due_at, id").all(projectId);
    return (rows as FireRow[]).map(toFire);
  }

  pendingForRun(runId: string): AutoReplyFire[] {
    return (this.db.prepare("SELECT * FROM auto_reply_fires WHERE run_id = ? AND status = 'pending'").all(runId) as FireRow[]).map(toFire);
  }

  countPending(ruleId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM auto_reply_fires WHERE rule_id = ? AND status IN ('pending','sending')").get(ruleId) as { n: number }).n;
  }

  lastFire(ruleId: string): AutoReplyFire | null {
    const r = this.db.prepare('SELECT * FROM auto_reply_fires WHERE rule_id = ? ORDER BY id DESC LIMIT 1').get(ruleId) as FireRow | undefined;
    return r ? toFire(r) : null;
  }

  /** Fires of one rule for one user since a time (loop guard). */
  recentFires(ruleId: string, testUserId: string, sinceIso: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM auto_reply_fires WHERE rule_id = ? AND test_user_id = ? AND created_at >= ?').get(ruleId, testUserId, sinceIso) as { n: number }).n;
  }

  setJob(id: string, jobId: string): void {
    this.db.prepare('UPDATE auto_reply_fires SET job_id = ? WHERE id = ?').run(jobId, id);
  }

  /** Compare-and-set the status; false when the fire was not in `from`. */
  claim(id: string, from: FireStatus, to: FireStatus): boolean {
    return this.db.prepare('UPDATE auto_reply_fires SET status = ? WHERE id = ? AND status = ?').run(to, id, from).changes === 1;
  }

  finish(id: string, p: { status: FireStatus; plan?: FirePlan; replyMessageId?: string | null; webhookStatus?: number | null; webhookOk?: boolean | null; error?: string | null }): void {
    const cur = this.fireById(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE auto_reply_fires SET status = ?, fired_at = ?, plan = ?, reply_message_id = ?, webhook_status = ?, webhook_ok = ?, error = ? WHERE id = ?')
      .run(
        p.status,
        nowIso(),
        JSON.stringify(p.plan ?? cur.plan),
        p.replyMessageId ?? null,
        p.webhookStatus ?? null,
        p.webhookOk === undefined || p.webhookOk === null ? null : p.webhookOk ? 1 : 0,
        p.error ?? null,
        id,
      );
  }

  deleteFiresForRun(runId: string): number {
    return Number(this.db.prepare('DELETE FROM auto_reply_fires WHERE run_id = ?').run(runId).changes);
  }

  deleteFires(projectId: string): number {
    return Number(this.db.prepare('DELETE FROM auto_reply_fires WHERE project_id = ?').run(projectId).changes);
  }

  deleteFiresBefore(projectId: string, cutoffIso: string): number {
    return Number(this.db.prepare("DELETE FROM auto_reply_fires WHERE project_id = ? AND created_at < ? AND status NOT IN ('pending','sending')").run(projectId, cutoffIso).changes);
  }

  /** Project reset: uses back to 0; rules the loop guard switched off are enabled again (other rules keep their switch). */
  resetUses(projectId: string): void {
    this.db
      .prepare(
        "UPDATE auto_reply_rules SET uses = 0, enabled = CASE WHEN disabled_reason IN ('loop','loop-hourly') THEN 1 ELSE enabled END, disabled_reason = NULL WHERE project_id = ?",
      )
      .run(projectId);
  }

  firesWithStatus(status: FireStatus): AutoReplyFire[] {
    return (this.db.prepare('SELECT * FROM auto_reply_fires WHERE status = ?').all(status) as FireRow[]).map(toFire);
  }

  /** Pending fires whose scheduled job is gone (e.g. the DB was copied without scheduled_jobs). */
  lostFires(): AutoReplyFire[] {
    return (
      this.db
        .prepare(
          "SELECT f.* FROM auto_reply_fires f WHERE f.status IN ('pending','sending') AND (f.job_id IS NULL OR NOT EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.id = f.job_id AND j.status IN ('pending','running')))",
        )
        .all() as FireRow[]
    ).map(toFire);
  }
}
