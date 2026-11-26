import type { DB } from '../db/index.js';
import { storedExpectations, type ExpectationDoc } from '../runs/expectations.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';

/** A test run: one parallel test worker (or one CI job) with its own ephemeral users, rules and mock overrides. */
export interface Run {
  id: string;
  projectId: string;
  /** Short name used in headers, URLs and SMTP usernames, e.g. "w3". */
  key: string;
  label: string;
  status: 'active' | 'stopped';
  /** Messages / requests nobody else claims belong to this run (serial CI). */
  captureUnattributed: boolean;
  /** Strings that attribute API-mock and webhook calls to this run (minted addresses + custom). */
  claims: string[];
  meta: Record<string, unknown>;
  /** What the run should cause (A2); evaluated into the verdict. */
  expectations: ExpectationDoc;
  /** Frozen report (set when the run is stopped). */
  report: unknown;
  startedAt: string;
  stoppedAt: string | null;
  expiresAt: string;
}

interface Row {
  id: string;
  project_id: string;
  key: string;
  label: string;
  status: 'active' | 'stopped';
  capture_unattributed: number;
  claims: string;
  meta: string;
  expectations: string;
  report: string | null;
  started_at: string;
  stopped_at: string | null;
  expires_at: string;
}

function toRun(r: Row): Run {
  return {
    id: r.id,
    projectId: r.project_id,
    key: r.key,
    label: r.label,
    status: r.status,
    captureUnattributed: r.capture_unattributed === 1,
    claims: parseJson<string[]>(r.claims, []),
    meta: parseJson<Record<string, unknown>>(r.meta, {}),
    expectations: storedExpectations(parseJson<unknown>(r.expectations, {})),
    report: parseJson<unknown>(r.report, null),
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    expiresAt: r.expires_at,
  };
}

export const RUN_KEY_RE = /^[a-z0-9]{1,24}$/;
export const DEFAULT_TTL_MINUTES = 120;
export const MAX_TTL_MINUTES = 1440;

export function checkRunKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (!RUN_KEY_RE.test(k)) throw new HttpError(400, `Invalid run key "${key}": use 1-24 lowercase letters or digits, e.g. "w3"`);
  return k;
}

export function ttlToExpiry(ttlMinutes: unknown, from = Date.now()): string {
  const n = ttlMinutes === undefined || ttlMinutes === null || ttlMinutes === '' ? DEFAULT_TTL_MINUTES : Number(ttlMinutes);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'ttlMinutes must be a positive number');
  if (n > MAX_TTL_MINUTES) throw new HttpError(400, `ttlMinutes can be at most ${MAX_TTL_MINUTES} (24 hours)`);
  return new Date(from + n * 60_000).toISOString();
}

export interface RunCounts {
  users: number;
  messages: number;
  logs: number;
  /** Traffic with outcome unmatched, invalid, internal_error or network_error. */
  problems: number;
}

export const PROBLEM_OUTCOMES = ['unmatched', 'invalid', 'internal_error', 'network_error'];
const PROBLEM_SQL = PROBLEM_OUTCOMES.map((o) => `'${o}'`).join(',');

export class RunRepo {
  constructor(private db: DB) {}

  create(projectId: string, i: { key: string; label?: string; expiresAt: string; captureUnattributed?: boolean; claims?: string[]; meta?: Record<string, unknown>; expectations?: ExpectationDoc }): Run {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO runs (id, project_id, key, label, status, capture_unattributed, claims, meta, expectations, started_at, expires_at)
         VALUES (?,?,?,?, 'active', ?,?,?,?,?,?)`,
      )
      .run(id, projectId, i.key, i.label ?? '', i.captureUnattributed ? 1 : 0, JSON.stringify(i.claims ?? []), JSON.stringify(i.meta ?? {}), i.expectations ? JSON.stringify(i.expectations) : '{}', nowIso(), i.expiresAt);
    return this.get(id)!;
  }

  get(id: string): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }

  activeByKey(projectId: string, key: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE project_id = ? AND key = ? AND status = 'active'").get(projectId, key.toLowerCase()) as Row | undefined;
    return r ? toRun(r) : null;
  }

  /** By id, else the active run with this key, else the newest stopped run with this key. */
  find(projectId: string, ref: string): Run | null {
    const r = ref.trim();
    if (!r) return null;
    const byId = this.db.prepare('SELECT * FROM runs WHERE project_id = ? AND id = ?').get(projectId, r) as Row | undefined;
    if (byId) return toRun(byId);
    const byKey = this.db
      .prepare("SELECT * FROM runs WHERE project_id = ? AND key = ? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, started_at DESC LIMIT 1")
      .get(projectId, r.toLowerCase()) as Row | undefined;
    return byKey ? toRun(byKey) : null;
  }

  list(projectId: string, status?: string): Run[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM runs WHERE project_id = ? AND status = ? ORDER BY started_at DESC, id DESC').all(projectId, status)
      : this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, id DESC').all(projectId);
    return (rows as Row[]).map(toRun);
  }

  /** Active runs of a project (attribution only considers these). */
  active(projectId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE project_id = ? AND status = 'active' ORDER BY started_at").all(projectId) as Row[]).map(toRun);
  }

  hasActive(projectId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM runs WHERE project_id = ? AND status = 'active' LIMIT 1").get(projectId);
  }

  defaultRun(projectId: string): Run | null {
    const r = this.db.prepare("SELECT * FROM runs WHERE project_id = ? AND status = 'active' AND capture_unattributed = 1 LIMIT 1").get(projectId) as Row | undefined;
    return r ? toRun(r) : null;
  }

  update(id: string, patch: { label?: string; expiresAt?: string; claims?: string[]; meta?: Record<string, unknown> }): Run {
    const cur = this.get(id);
    if (!cur) throw new HttpError(404, 'Run not found');
    this.db
      .prepare('UPDATE runs SET label = ?, expires_at = ?, claims = ?, meta = ? WHERE id = ?')
      .run(patch.label ?? cur.label, patch.expiresAt ?? cur.expiresAt, JSON.stringify(patch.claims ?? cur.claims), JSON.stringify(patch.meta ?? cur.meta), id);
    return this.get(id)!;
  }

  addClaims(id: string, claims: string[]): void {
    const cur = this.get(id);
    if (!cur) return;
    const next = [...new Set([...cur.claims, ...claims.filter(Boolean)])];
    this.db.prepare('UPDATE runs SET claims = ? WHERE id = ?').run(JSON.stringify(next), id);
  }

  setExpectations(id: string, doc: ExpectationDoc): Run {
    this.db.prepare('UPDATE runs SET expectations = ? WHERE id = ?').run(JSON.stringify(doc), id);
    return this.get(id)!;
  }

  /** `at`: the stop time (the frozen report's stoppedAt), so the row and the report agree. */
  markStopped(id: string, report: unknown, at: string = nowIso()): Run {
    this.db.prepare("UPDATE runs SET status = 'stopped', stopped_at = ?, report = ? WHERE id = ?").run(at, JSON.stringify(report), id);
    return this.get(id)!;
  }

  setReport(id: string, report: unknown): void {
    this.db.prepare('UPDATE runs SET report = ? WHERE id = ?').run(JSON.stringify(report), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  /** Active runs whose TTL has passed. */
  expired(nowIsoTime: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = 'active' AND expires_at <= ?").all(nowIsoTime) as Row[]).map(toRun);
  }

  /** Stopped runs that stopped before `cutoff`. */
  stoppedBefore(cutoff: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status = 'stopped' AND COALESCE(stopped_at, started_at) < ?").all(cutoff) as Row[]).map(toRun);
  }

  counts(runId: string): RunCounts {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM test_users WHERE run_id = ?) AS users,
                (SELECT COUNT(*) FROM messages WHERE run_id = ?) AS messages,
                (SELECT COUNT(*) FROM traffic_logs WHERE run_id = ?) AS logs,
                (SELECT COUNT(*) FROM traffic_logs WHERE run_id = ? AND outcome IN (${PROBLEM_SQL})) AS problems`,
      )
      .get(runId, runId, runId, runId) as unknown as RunCounts;
  }

  // ---------- per-run API mock scenario overrides ----------

  mockOverride(runId: string, mockId: string): string | null {
    const r = this.db.prepare('SELECT scenario FROM run_mock_scenarios WHERE run_id = ? AND mock_id = ?').get(runId, mockId) as { scenario: string } | undefined;
    return r?.scenario ?? null;
  }

  setMockOverride(runId: string, mockId: string, scenario: string): void {
    this.db
      .prepare('INSERT INTO run_mock_scenarios (run_id, mock_id, scenario) VALUES (?,?,?) ON CONFLICT (run_id, mock_id) DO UPDATE SET scenario = excluded.scenario')
      .run(runId, mockId, scenario);
  }

  hitMockOverride(runId: string, mockId: string): void {
    this.db.prepare('UPDATE run_mock_scenarios SET hits = hits + 1 WHERE run_id = ? AND mock_id = ?').run(runId, mockId);
  }

  mockOverrides(runId: string): { mockId: string; scenario: string; hits: number }[] {
    return (this.db.prepare('SELECT mock_id, scenario, hits FROM run_mock_scenarios WHERE run_id = ?').all(runId) as { mock_id: string; scenario: string; hits: number }[]).map((r) => ({
      mockId: r.mock_id,
      scenario: r.scenario,
      hits: r.hits,
    }));
  }
}
