import type { Hub } from '../hub.js';
import { LINT_CHECKS, type LintFinding, type LintSeverity } from './checks.js';
import { parseJson } from '../util.js';

export interface LintCounts {
  error: number;
  warn: number;
  info: number;
}

export interface LintSummary {
  /** Outbound messages looked at / with at least one finding. Counts are per message (by its highest severity). */
  totals: { messages: number; withFindings: number } & LintCounts;
  /** Findings per check id. */
  byCheck: { check: string; label: string; count: number; error: number; warn: number; info: number }[];
  byUser: ({ testUserId: string | null; name: string } & LintCounts)[];
  /** Newest messages with findings. */
  recent: { id: string; channel: string; to: string; subject: string | null; testUserId: string | null; createdAt: string; level: LintSeverity; findings: LintFinding[] }[];
}

interface Row {
  id: string;
  channel: string;
  to_addr: string;
  subject: string | null;
  test_user_id: string | null;
  created_at: string;
  lint: string;
  lint_level: LintSeverity | null;
}

/** Content-check counters for a project (optionally one user / one run / since a time). */
export function lintSummary(hub: Hub, projectId: string, opts: { testUserId?: string; runId?: string; since?: string; limit?: number } = {}): LintSummary {
  const where = ["project_id = ?", "direction = 'outbound'"];
  const args: string[] = [projectId];
  if (opts.testUserId) {
    where.push('test_user_id = ?');
    args.push(opts.testUserId);
  }
  if (opts.runId) {
    where.push('run_id = ?');
    args.push(opts.runId);
  }
  if (opts.since) {
    where.push('created_at >= ?');
    args.push(opts.since);
  }
  const total = (hub.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
  const rows = hub.db
    .prepare(`SELECT id, channel, to_addr, subject, test_user_id, created_at, lint, lint_level FROM messages WHERE ${where.join(' AND ')} AND lint_level IS NOT NULL ORDER BY id DESC LIMIT 5000`)
    .all(...args) as unknown as Row[];

  const totals = { messages: total, withFindings: rows.length, error: 0, warn: 0, info: 0 };
  const byCheck = new Map<string, { count: number } & LintCounts>();
  const byUser = new Map<string | null, LintCounts>();
  for (const r of rows) {
    const level = r.lint_level!;
    totals[level]++;
    const u = byUser.get(r.test_user_id) ?? { error: 0, warn: 0, info: 0 };
    u[level]++;
    byUser.set(r.test_user_id, u);
    for (const f of parseJson<LintFinding[]>(r.lint, [])) {
      const c = byCheck.get(f.check) ?? { count: 0, error: 0, warn: 0, info: 0 };
      c.count++;
      c[f.severity]++;
      byCheck.set(f.check, c);
    }
  }
  const label = (id: string) => LINT_CHECKS.find((c) => c.id === id)?.label ?? id;
  const userName = (id: string | null) => (id ? hub.users.get(projectId, id)?.name ?? id : 'Unassigned');
  const limit = Math.min(Math.max(opts.limit ?? 50, 0), 500);
  return {
    totals,
    byCheck: [...byCheck].map(([check, c]) => ({ check, label: label(check), ...c })).sort((a, b) => b.error - a.error || b.warn - a.warn || b.count - a.count),
    byUser: [...byUser].map(([testUserId, c]) => ({ testUserId, name: userName(testUserId), ...c })).sort((a, b) => b.error - a.error || b.warn - a.warn || b.info - a.info),
    recent: rows.slice(0, limit).map((r) => ({
      id: r.id,
      channel: r.channel,
      to: r.to_addr,
      subject: r.subject,
      testUserId: r.test_user_id,
      createdAt: r.created_at,
      level: r.lint_level!,
      findings: parseJson<LintFinding[]>(r.lint, []),
    })),
  };
}
