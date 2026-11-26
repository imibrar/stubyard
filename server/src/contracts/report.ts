// OpenAPI contracts (C1): contract results across traffic, the interface A2 run verdicts and /contracts/issues use
// (§3.3). Read-only queries over traffic_logs.contract / contract_level.

import type { Hub } from '../hub.js';
import { parseJson } from '../util.js';
import { checkLabel, type ContractCheckId, type ContractIssue, type ContractResult, type ContractSeverity, type ContractSubject } from './types.js';

export interface ContractViolation {
  logId: string;
  receivedAt: string;
  method: string | null;
  url: string | null;
  subject: ContractSubject;
  spec: string | null;
  provider: string | null;
  operation: string | null;
  level: ContractSeverity;
  issues: ContractIssue[];
}

export interface ContractSummary {
  /** Logs with a contract result. */
  checked: number;
  /** Logs whose worst issue is error or warn. */
  withIssues: number;
  /** Logs by worst level. */
  error: number;
  warn: number;
  info: number;
  /** Issues per check (over the stored issues, at most 50 per log), most frequent first. */
  byCheck: { check: ContractCheckId; label: string; count: number }[];
  bySource: { spec: string | null; provider: string | null; checked: number; withIssues: number }[];
  /** Newest first; limit default 50, max 500. */
  violations: ContractViolation[];
}

export interface ContractSummaryOptions {
  runId?: string;
  /** ISO timestamps on received_at (inclusive). */
  since?: string;
  until?: string;
  /** Lowest level listed in `violations` (default warn). Counts are not filtered by it. */
  minLevel?: ContractSeverity;
  /** Spec name. */
  spec?: string;
  subject?: ContractSubject;
  limit?: number;
}

export const DEFAULT_VIOLATION_LIMIT = 50;
export const MAX_VIOLATION_LIMIT = 500;

const LEVELS_AT_LEAST: Record<ContractSeverity, ContractSeverity[]> = { error: ['error'], warn: ['error', 'warn'], info: ['error', 'warn', 'info'] };

interface ViolationRow {
  id: string;
  received_at: string;
  method: string | null;
  url: string | null;
  contract: string;
  contract_level: ContractSeverity;
}

/** Contract results of a project's traffic, optionally limited to a run, a time window, a spec or a subject. */
export function contractSummary(hub: Hub, projectId: string, opts: ContractSummaryOptions = {}): ContractSummary {
  const where = ['project_id = ?', 'contract IS NOT NULL'];
  const args: (string | number)[] = [projectId];
  if (opts.runId) {
    where.push('run_id = ?');
    args.push(opts.runId);
  }
  if (opts.since) {
    where.push('received_at >= ?');
    args.push(opts.since);
  }
  if (opts.until) {
    where.push('received_at <= ?');
    args.push(opts.until);
  }
  if (opts.spec) {
    where.push("json_extract(contract, '$.spec.name') = ?");
    args.push(opts.spec);
  }
  if (opts.subject) {
    where.push("json_extract(contract, '$.subject') = ?");
    args.push(opts.subject);
  }
  const w = where.join(' AND ');
  const db = hub.db;

  const out: ContractSummary = { checked: 0, withIssues: 0, error: 0, warn: 0, info: 0, byCheck: [], bySource: [], violations: [] };
  for (const r of db.prepare(`SELECT contract_level AS level, COUNT(*) AS n FROM traffic_logs WHERE ${w} GROUP BY contract_level`).all(...args) as { level: ContractSeverity | null; n: number }[]) {
    out.checked += r.n;
    if (r.level) out[r.level] += r.n;
  }
  out.withIssues = out.error + out.warn;

  out.bySource = (
    db
      .prepare(
        `SELECT json_extract(contract, '$.spec.name') AS spec, json_extract(contract, '$.provider.preset') AS provider, COUNT(*) AS checked,
           SUM(CASE WHEN contract_level IN ('error','warn') THEN 1 ELSE 0 END) AS withIssues
         FROM traffic_logs WHERE ${w} GROUP BY spec, provider ORDER BY checked DESC, spec, provider`,
      )
      .all(...args) as { spec: string | null; provider: string | null; checked: number; withIssues: number }[]
  ).map((r) => ({ spec: r.spec ?? null, provider: r.provider ?? null, checked: Number(r.checked), withIssues: Number(r.withIssues ?? 0) }));

  const byCheck = new Map<string, number>();
  for (const r of db.prepare(`SELECT contract FROM traffic_logs WHERE ${w} AND contract_level IS NOT NULL`).all(...args) as { contract: string }[]) {
    for (const i of parseJson<ContractResult | null>(r.contract, null)?.issues ?? []) byCheck.set(i.check, (byCheck.get(i.check) ?? 0) + 1);
  }
  out.byCheck = [...byCheck]
    .map(([check, count]) => ({ check: check as ContractCheckId, label: checkLabel(check), count }))
    .sort((a, b) => b.count - a.count || (a.check < b.check ? -1 : 1));

  const levels = LEVELS_AT_LEAST[opts.minLevel ?? 'warn'] ?? LEVELS_AT_LEAST.warn;
  const limit = Math.min(MAX_VIOLATION_LIMIT, Math.max(1, Math.round(Number(opts.limit ?? DEFAULT_VIOLATION_LIMIT)) || DEFAULT_VIOLATION_LIMIT));
  const rows = db
    .prepare(
      `SELECT id, received_at, method, url, contract, contract_level FROM traffic_logs
       WHERE ${w} AND contract_level IN (${levels.map(() => '?').join(',')}) ORDER BY received_at DESC, id DESC LIMIT ?`,
    )
    .all(...args, ...levels, limit) as unknown as ViolationRow[];
  for (const r of rows) {
    const c = parseJson<ContractResult | null>(r.contract, null);
    if (!c) continue;
    out.violations.push({
      logId: r.id,
      receivedAt: r.received_at,
      method: r.method,
      url: r.url,
      subject: c.subject,
      spec: c.spec?.name ?? null,
      provider: c.provider?.preset ?? null,
      operation: c.operation?.key ?? null,
      level: r.contract_level,
      issues: c.issues ?? [],
    });
  }
  return out;
}
