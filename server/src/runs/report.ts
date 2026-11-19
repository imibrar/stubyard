import type { Hub } from '../hub.js';
import type { Message } from '../repos/messages.js';
import { PROBLEM_OUTCOMES, type Run } from '../repos/runs.js';
import { describeRule } from '../rules/engine.js';
import { storageRunReport, type StorageRunReport } from '../storage/report.js';
import { highestSeverity, type LintSeverity } from '../lint/checks.js';

export interface RunReport {
  run: { id: string; key: string; label: string; status: string; startedAt: string; stoppedAt: string | null; durationMs: number; meta: Record<string, unknown> };
  users: { id: string; name: string; role: string; email: string | null; phone: string | null }[];
  messages: {
    total: number;
    byChannel: Record<string, number>;
    byStatus: Record<string, number>;
    items: { id: string; channel: string; to: string; subject: string | null; status: string; otp: string | null; appliedRule: string | null; lint: LintSeverity | null; createdAt: string }[];
  };
  /** Content checks of the run's outbound messages (messages counted by their highest severity). */
  lint: {
    messages: number;
    error: number;
    warn: number;
    info: number;
    byCheck: Record<string, number>;
    items: { messageId: string; channel: string; to: string; level: LintSeverity; findings: { check: string; severity: LintSeverity; message: string; excerpt?: string }[] }[];
  };
  traffic: {
    total: number;
    byOutcome: Record<string, number>;
    problems: { id: string; method: string | null; url: string | null; resStatus: number | null; outcome: string; errorMessage: string | null }[];
  };
  rules: { id: string; owner: string; description: string; hits: number }[];
  mocks: { mock: string; scenario: string; hits: number }[];
  /** File storage traffic of the run (absent when the run touched no storage). */
  storage?: StorageRunReport;
  warnings: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything a run produced: its users, messages, traffic (with problems), rules and mock overrides. */
export function buildReport(hub: Hub, run: Run, override: Partial<Pick<Run, 'status' | 'stoppedAt'>> & { expired?: boolean } = {}): RunReport {
  const status = override.status ?? run.status;
  const stoppedAt = override.stoppedAt !== undefined ? override.stoppedAt : run.stoppedAt;
  const end = stoppedAt ? Date.parse(stoppedAt) : Date.now();

  const users = hub.users.listForRun(run.id);
  const messages = (hub.db.prepare('SELECT id FROM messages WHERE run_id = ? ORDER BY id').all(run.id) as { id: string }[])
    .map((r) => hub.messages.get(r.id))
    .filter((m): m is Message => !!m);
  const byChannel: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const m of messages) {
    byChannel[m.channel] = (byChannel[m.channel] ?? 0) + 1;
    byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  }

  const outcomes = hub.db.prepare('SELECT outcome, COUNT(*) AS n FROM traffic_logs WHERE run_id = ? GROUP BY outcome').all(run.id) as { outcome: string; n: number }[];
  const byOutcome: Record<string, number> = {};
  let total = 0;
  for (const o of outcomes) {
    byOutcome[o.outcome] = o.n;
    total += o.n;
  }
  const problems = hub.db
    .prepare(
      `SELECT id, method, url, res_status, outcome, error_message FROM traffic_logs WHERE run_id = ? AND outcome IN (${PROBLEM_OUTCOMES.map(() => '?').join(',')}) ORDER BY id LIMIT 200`,
    )
    .all(run.id, ...PROBLEM_OUTCOMES) as { id: string; method: string | null; url: string | null; res_status: number | null; outcome: string; error_message: string | null }[];

  const userName = new Map<string, string>();
  const instanceSlug = new Map<string, string>();
  for (const p of hub.providers.list(run.projectId)) instanceSlug.set(p.id, p.slug);
  const rules = hub.rules.listForRun(run.id).map((r) => {
    let owner: string;
    if (r.scope === 'user') {
      if (r.testUserId && !userName.has(r.testUserId)) userName.set(r.testUserId, hub.users.get(run.projectId, r.testUserId)?.name ?? r.testUserId);
      owner = `user:${r.testUserId ? userName.get(r.testUserId) : '?'}`;
    } else owner = `instance:${(r.providerInstanceId && instanceSlug.get(r.providerInstanceId)) ?? r.providerInstanceId ?? '?'}`;
    return { id: r.id, owner, description: describeRule(r), hits: r.hits };
  });
  const mocks = hub.runs.repo.mockOverrides(run.id).map((o) => ({ mock: hub.mocks.get(o.mockId)?.name ?? o.mockId, scenario: o.scenario, hits: o.hits }));

  const storage = hub.storage ? storageRunReport(hub, run.id) : null;
  const lint: RunReport['lint'] = { messages: 0, error: 0, warn: 0, info: 0, byCheck: {}, items: [] };
  for (const m of messages) {
    const level = highestSeverity(m.lint ?? []);
    if (!level) continue;
    lint.messages++;
    lint[level]++;
    for (const f of m.lint) lint.byCheck[f.check] = (lint.byCheck[f.check] ?? 0) + 1;
    lint.items.push({ messageId: m.id, channel: m.channel, to: m.to, level, findings: m.lint.map((f) => ({ check: f.check, severity: f.severity, message: f.message, ...(f.excerpt ? { excerpt: f.excerpt } : {}) })) });
  }
  const warnings: string[] = [];
  const noUser = messages.filter((m) => !m.testUserId).length;
  if (noUser) warnings.push(`${plural(noUser, 'message')} had no test user`);
  if (problems.length) warnings.push(`${plural(problems.length, 'request')} had problems (${[...new Set(problems.map((p) => p.outcome))].join(', ')})`);
  const failed = messages.filter((m) => ['failed', 'rejected', 'bounced', 'timeout'].includes(m.status)).length;
  if (failed) warnings.push(`${plural(failed, 'message')} failed, bounced or were rejected (check that the scenario rules meant this)`);
  if (lint.error) warnings.push(`${plural(lint.error, 'message')} with content errors (${Object.keys(lint.byCheck).join(', ')}); see lint`);
  else if (lint.warn) warnings.push(`${plural(lint.warn, 'message')} with content warnings; see lint`);
  if (override.expired) warnings.push('The run was stopped because its TTL expired');

  return {
    run: { id: run.id, key: run.key, label: run.label, status, startedAt: run.startedAt, stoppedAt, durationMs: Math.max(0, end - Date.parse(run.startedAt)), meta: run.meta },
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email, phone: u.phone })),
    messages: {
      total: messages.length,
      byChannel,
      byStatus,
      items: messages.map((m) => ({
        id: m.id,
        channel: m.channel,
        to: m.to,
        subject: m.subject,
        status: m.status,
        otp: m.otp,
        appliedRule: ruleLabel(m.appliedRule),
        lint: highestSeverity(m.lint ?? []),
        createdAt: m.createdAt,
      })),
    },
    traffic: {
      total,
      byOutcome,
      problems: problems.map((p) => ({ id: p.id, method: p.method, url: p.url, resStatus: p.res_status, outcome: p.outcome, errorMessage: p.error_message })),
    },
    rules,
    mocks,
    lint,
    ...(storage ? { storage } : {}),
    warnings,
  };
}

function ruleLabel(r: unknown): string | null {
  if (!r || typeof r !== 'object') return null;
  const label = (r as { label?: unknown }).label;
  return typeof label === 'string' ? label : null;
}
