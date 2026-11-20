import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';
import type { CanonResponse, LlmMatch } from './types.js';

/** Tables of migration 17: llm_mocks, llm_recordings, llm_calls, llm_settings. */

export type LlmMockMode = 'first' | 'sequence' | 'cycle';
export const LLM_MOCK_MODES: LlmMockMode[] = ['first', 'sequence', 'cycle'];
export type LlmCallMode = 'mock' | 'record' | 'fallback' | 'unmatched' | 'fault';

export interface LlmMock {
  id: string;
  projectId: string;
  runId: string | null;
  name: string;
  position: number;
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'any';
  match: LlmMatch;
  responses: CanonResponse[];
  mode: LlmMockMode;
  fault: string | null;
  remaining: number | null;
  hits: number;
  source: 'manual' | 'recorded';
  recordingId: string | null;
  requestHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmRecording {
  id: string;
  projectId: string;
  runId: string | null;
  name: string;
  /** AI provider name / id ("env:openai", "my-openai"). */
  providerRef: string;
  /** openai | anthropic: which /llm/<project>/<kind>/ prefix it records. */
  kind: 'openai' | 'anthropic';
  mode: 'new' | 'all';
  status: 'active' | 'stopped';
  /** Saved exchanges. */
  calls: number;
  /** Requests sent to the real provider (stops at maxCalls). */
  forwarded: number;
  maxCalls: number;
  /** Auto-stop time (ISO); null only for rows from before migration 19. */
  expiresAt: string | null;
  /** Why it stopped: manual | max-calls | expired | run-stopped. */
  stopReason: string | null;
  createdAt: string;
  stoppedAt: string | null;
}

export interface LlmCall {
  id: string;
  projectId: string;
  runId: string | null;
  logId: string | null;
  provider: string;
  endpoint: string;
  model: string | null;
  stream: boolean;
  mode: LlmCallMode;
  mockId: string | null;
  fault: string | null;
  status: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  request: unknown;
  response: unknown;
  createdAt: string;
}

export interface LlmSettings {
  /** No mock matched: error = provider-shaped 404 listing the misses; echo = "Echo: <last user message>"; text = fallbackText. */
  fallback: 'error' | 'echo' | 'text';
  fallbackText: string;
  defaultChunk: { size: number; delayMs: number };
  /** Extra model ids for GET /v1/models. */
  models: string[];
}

export const DEFAULT_SETTINGS: LlmSettings = { fallback: 'error', fallbackText: 'This is a mocked reply from stubyard.', defaultChunk: { size: 12, delayMs: 5 }, models: [] };

type Row = Record<string, any>;

const toMock = (r: Row): LlmMock => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id ?? null,
  name: r.name,
  position: r.position,
  enabled: !!r.enabled,
  provider: r.provider,
  match: parseJson<LlmMatch>(r.match, {}),
  responses: parseJson<CanonResponse[]>(r.responses, []),
  mode: r.mode,
  fault: parseJson<string | null>(r.fault, null),
  remaining: r.remaining ?? null,
  hits: r.hits,
  source: r.source,
  recordingId: r.recording_id ?? null,
  requestHash: r.request_hash ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRecording = (r: Row): LlmRecording => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id ?? null,
  name: r.name,
  providerRef: r.provider_ref,
  kind: r.kind,
  mode: r.mode,
  status: r.status,
  calls: r.calls,
  forwarded: r.forwarded ?? 0,
  maxCalls: r.max_calls ?? 200,
  expiresAt: r.expires_at ?? null,
  stopReason: r.stop_reason ?? null,
  createdAt: r.created_at,
  stoppedAt: r.stopped_at ?? null,
});

const toCall = (r: Row): LlmCall => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id ?? null,
  logId: r.log_id ?? null,
  provider: r.provider,
  endpoint: r.endpoint,
  model: r.model ?? null,
  stream: !!r.stream,
  mode: r.mode,
  mockId: r.mock_id ?? null,
  fault: r.fault ?? null,
  status: r.status ?? null,
  tokensIn: r.tokens_in ?? null,
  tokensOut: r.tokens_out ?? null,
  durationMs: r.duration_ms ?? null,
  request: parseJson<unknown>(r.request, null),
  response: parseJson<unknown>(r.response, null),
  createdAt: r.created_at,
});

export type MockFields = Omit<LlmMock, 'id' | 'projectId' | 'hits' | 'createdAt' | 'updatedAt'>;

export class LlmRepo {
  constructor(private db: DB) {}

  // ---------------- mocks
  /** Project rows plus the rows of runId (or every run with all), by position. */
  listMocks(projectId: string, o: { runId?: string | null; all?: boolean } = {}): LlmMock[] {
    const rows = o.all
      ? this.db.prepare('SELECT * FROM llm_mocks WHERE project_id = ? ORDER BY position, created_at').all(projectId)
      : this.db.prepare('SELECT * FROM llm_mocks WHERE project_id = ? AND (run_id IS NULL OR run_id = ?) ORDER BY position, created_at').all(projectId, o.runId ?? '');
    return (rows as Row[]).map(toMock);
  }

  getMock(projectId: string, id: string): LlmMock | null {
    const r = this.db.prepare('SELECT * FROM llm_mocks WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    return r ? toMock(r) : null;
  }

  byHash(projectId: string, hash: string): LlmMock[] {
    return (this.db.prepare('SELECT * FROM llm_mocks WHERE project_id = ? AND request_hash = ? ORDER BY position').all(projectId, hash) as Row[]).map(toMock);
  }

  nextPosition(projectId: string): number {
    const r = this.db.prepare('SELECT MAX(position) AS m FROM llm_mocks WHERE project_id = ?').get(projectId) as { m: number | null };
    return (r.m ?? -1) + 1;
  }

  minPosition(projectId: string): number {
    const r = this.db.prepare('SELECT MIN(position) AS m FROM llm_mocks WHERE project_id = ?').get(projectId) as { m: number | null };
    return r.m ?? 0;
  }

  insertMock(projectId: string, f: MockFields): LlmMock {
    const id = newId();
    const at = nowIso();
    this.db
      .prepare(
        'INSERT INTO llm_mocks (id, project_id, run_id, name, position, enabled, provider, match, responses, mode, fault, remaining, hits, source, recording_id, request_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)',
      )
      .run(id, projectId, f.runId, f.name, f.position, f.enabled, f.provider, f.match, f.responses, f.mode, f.fault === null ? null : JSON.stringify(f.fault), f.remaining, f.source, f.recordingId, f.requestHash, at, at);
    return this.getMock(projectId, id)!;
  }

  updateMock(m: LlmMock, f: Partial<MockFields>): LlmMock {
    const n = { ...m, ...f };
    this.db
      .prepare('UPDATE llm_mocks SET name = ?, position = ?, enabled = ?, provider = ?, match = ?, responses = ?, mode = ?, fault = ?, remaining = ?, request_hash = ?, updated_at = ? WHERE id = ?')
      .run(n.name, n.position, n.enabled, n.provider, n.match, n.responses, n.mode, n.fault === null ? null : JSON.stringify(n.fault), n.remaining, n.requestHash, nowIso(), m.id);
    return this.getMock(m.projectId, m.id)!;
  }

  deleteMock(id: string): boolean {
    return this.db.prepare('DELETE FROM llm_mocks WHERE id = ?').run(id).changes > 0;
  }

  deleteMocks(projectId: string, o: { runId?: string | null; faultsOnly?: boolean; source?: string } = {}): number {
    let sql = 'DELETE FROM llm_mocks WHERE project_id = ?';
    const args: unknown[] = [projectId];
    if (o.runId !== undefined) {
      sql += o.runId === null ? ' AND run_id IS NULL' : ' AND run_id = ?';
      if (o.runId !== null) args.push(o.runId);
    }
    if (o.faultsOnly) sql += " AND fault IS NOT NULL AND responses = '[]'";
    if (o.source) {
      sql += ' AND source = ?';
      args.push(o.source);
    }
    return this.db.prepare(sql).run(...args).changes;
  }

  deleteRunMocks(runId: string): number {
    return this.db.prepare('DELETE FROM llm_mocks WHERE run_id = ?').run(runId).changes;
  }

  /** Count a hit (and use up one of `remaining`). */
  hit(id: string): void {
    this.db.prepare('UPDATE llm_mocks SET hits = hits + 1, remaining = CASE WHEN remaining IS NULL THEN NULL WHEN remaining > 0 THEN remaining - 1 ELSE 0 END WHERE id = ?').run(id);
  }

  setPositions(ids: string[]): void {
    this.db.transaction(() => ids.forEach((id, i) => this.db.prepare('UPDATE llm_mocks SET position = ? WHERE id = ?').run(i, id)))();
  }

  resetHits(projectId: string): void {
    this.db.prepare('UPDATE llm_mocks SET hits = 0 WHERE project_id = ?').run(projectId);
  }

  // ---------------- recordings
  /** Stop recordings whose time is up (checked lazily on every read). Returns how many stopped. */
  expireRecordings(): number {
    const now = new Date().toISOString();
    return this.db.prepare("UPDATE llm_recordings SET status = 'stopped', stopped_at = ?, stop_reason = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").run(now, now).changes;
  }

  listRecordings(projectId: string): LlmRecording[] {
    this.expireRecordings();
    return (this.db.prepare('SELECT * FROM llm_recordings WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Row[]).map(toRecording);
  }

  getRecording(projectId: string, id: string): LlmRecording | null {
    this.expireRecordings();
    const r = this.db.prepare('SELECT * FROM llm_recordings WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    return r ? toRecording(r) : null;
  }

  activeRecording(projectId: string, kind: string): LlmRecording | null {
    this.expireRecordings();
    const r = this.db.prepare("SELECT * FROM llm_recordings WHERE project_id = ? AND kind = ? AND status = 'active' ORDER BY created_at DESC").get(projectId, kind) as Row | undefined;
    return r ? toRecording(r) : null;
  }

  insertRecording(projectId: string, f: Pick<LlmRecording, 'runId' | 'name' | 'providerRef' | 'kind' | 'mode' | 'maxCalls' | 'expiresAt'>): LlmRecording {
    const id = newId();
    this.db
      .prepare("INSERT INTO llm_recordings (id, project_id, run_id, name, provider_ref, kind, mode, status, calls, max_calls, expires_at, forwarded, created_at) VALUES (?,?,?,?,?,?,?,'active',0,?,?,0,?)")
      .run(id, projectId, f.runId, f.name, f.providerRef, f.kind, f.mode, f.maxCalls, f.expiresAt, nowIso());
    return this.getRecording(projectId, id)!;
  }

  stopRecording(id: string, reason = 'manual'): void {
    this.db.prepare("UPDATE llm_recordings SET status = 'stopped', stopped_at = ?, stop_reason = ? WHERE id = ? AND status = 'active'").run(nowIso(), reason, id);
  }

  stopRunRecordings(runId: string): number {
    return this.db.prepare("UPDATE llm_recordings SET status = 'stopped', stopped_at = ?, stop_reason = 'run-stopped' WHERE run_id = ? AND status = 'active'").run(nowIso(), runId).changes;
  }

  /**
   * Take one forwarding slot of an active recording: false when it is stopped or used up. The slot that reaches
   * max_calls stops the recording (stop_reason max-calls); that request is still forwarded.
   */
  claimForward(id: string): boolean {
    this.expireRecordings();
    const ok = this.db.prepare("UPDATE llm_recordings SET forwarded = forwarded + 1 WHERE id = ? AND status = 'active' AND forwarded < max_calls").run(id).changes > 0;
    if (!ok) {
      this.stopRecording(id, 'max-calls');
      return false;
    }
    this.db.prepare("UPDATE llm_recordings SET status = 'stopped', stopped_at = ?, stop_reason = 'max-calls' WHERE id = ? AND status = 'active' AND forwarded >= max_calls").run(nowIso(), id);
    return true;
  }

  countRecorded(id: string): void {
    this.db.prepare('UPDATE llm_recordings SET calls = calls + 1 WHERE id = ?').run(id);
  }

  deleteRecordings(projectId: string): number {
    return this.db.prepare('DELETE FROM llm_recordings WHERE project_id = ?').run(projectId).changes;
  }

  // ---------------- calls
  insertCall(c: Omit<LlmCall, 'id' | 'createdAt'>): LlmCall {
    const id = newId();
    this.db
      .prepare(
        'INSERT INTO llm_calls (id, project_id, run_id, log_id, provider, endpoint, model, stream, mode, mock_id, fault, status, tokens_in, tokens_out, duration_ms, request, response, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(id, c.projectId, c.runId, c.logId, c.provider, c.endpoint, c.model, c.stream, c.mode, c.mockId, c.fault, c.status, c.tokensIn, c.tokensOut, c.durationMs, JSON.stringify(c.request ?? null), JSON.stringify(c.response ?? null), nowIso());
    return this.getCall(c.projectId, id)!;
  }

  getCall(projectId: string, id: string): LlmCall | null {
    const r = this.db.prepare('SELECT * FROM llm_calls WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    return r ? toCall(r) : null;
  }

  listCalls(projectId: string, f: { runId?: string; mode?: string; provider?: string; mockId?: string; after?: string; limit?: number } = {}): LlmCall[] {
    let sql = 'SELECT * FROM llm_calls WHERE project_id = ?';
    const args: unknown[] = [projectId];
    if (f.runId) (sql += ' AND run_id = ?'), args.push(f.runId);
    if (f.mode) {
      const modes = f.mode.split(',').map((s) => s.trim()).filter(Boolean);
      sql += ` AND mode IN (${modes.map(() => '?').join(',')})`;
      args.push(...modes);
    }
    if (f.provider) (sql += ' AND provider = ?'), args.push(f.provider);
    if (f.mockId) (sql += ' AND mock_id = ?'), args.push(f.mockId);
    if (f.after) (sql += ' AND created_at > ?'), args.push(f.after);
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    args.push(Math.max(1, Math.min(500, Math.floor(f.limit ?? 50))));
    return (this.db.prepare(sql).all(...args) as Row[]).map(toCall);
  }

  deleteCalls(projectId: string): number {
    return this.db.prepare('DELETE FROM llm_calls WHERE project_id = ?').run(projectId).changes;
  }

  deleteRunCalls(runId: string): number {
    return this.db.prepare('DELETE FROM llm_calls WHERE run_id = ?').run(runId).changes;
  }

  // ---------------- settings
  settings(projectId: string): LlmSettings {
    const r = this.db.prepare('SELECT config FROM llm_settings WHERE project_id = ?').get(projectId) as { config: string } | undefined;
    const c = parseJson<Partial<LlmSettings>>(r?.config, {});
    return { ...DEFAULT_SETTINGS, ...c, defaultChunk: { ...DEFAULT_SETTINGS.defaultChunk, ...(c.defaultChunk ?? {}) }, models: Array.isArray(c.models) ? c.models : [] };
  }

  saveSettings(projectId: string, s: LlmSettings): void {
    this.db.prepare('INSERT INTO llm_settings (project_id, config) VALUES (?, ?) ON CONFLICT (project_id) DO UPDATE SET config = excluded.config').run(projectId, s);
  }
}
