import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';
import { LIMIT_DEFAULTS, type Persona, type PersonaThread, type PersonaThreadState, type PersonaTurn } from './types.js';

type Row = Record<string, any>;

const toPersona = (r: Row): Persona => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id ?? null,
  slug: r.slug,
  name: r.name,
  enabled: r.enabled === 1,
  provider: r.provider,
  model: r.model,
  prompt: r.prompt,
  goals: parseJson(r.goals, []),
  style: parseJson(r.style, {}),
  limits: { ...LIMIT_DEFAULTS, ...parseJson(r.limits, {}) },
  fallback: r.fallback ?? null,
  opener: r.opener ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toThread = (r: Row): PersonaThread => ({
  id: r.id,
  projectId: r.project_id,
  personaId: r.persona_id,
  testUserId: r.test_user_id,
  channel: r.channel,
  runId: r.run_id ?? null,
  state: r.state,
  stopReason: r.stop_reason ?? null,
  replies: r.replies,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  errors: r.errors,
  fallbackSent: r.fallback_sent === 1,
  goals: parseJson(r.goals, {}),
  notes: r.notes ?? '',
  lastTurnAt: r.last_turn_at ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTurn = (r: Row): PersonaTurn => ({
  id: r.id,
  projectId: r.project_id,
  personaId: r.persona_id,
  threadId: r.thread_id ?? null,
  fireId: r.fire_id ?? null,
  triggerMessageId: r.trigger_message_id ?? null,
  replyMessageId: r.reply_message_id ?? null,
  status: r.status,
  text: r.text ?? '',
  raw: r.raw ?? '',
  controls: parseJson(r.controls, null),
  warnings: parseJson(r.warnings, []),
  provider: r.provider ?? null,
  model: r.model ?? null,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  durationMs: r.duration_ms,
  finishReason: r.finish_reason ?? null,
  error: r.error ?? null,
  called: r.called === 1,
  createdAt: r.created_at,
});

export type PersonaFields = Omit<Persona, 'id' | 'projectId' | 'runId' | 'createdAt' | 'updatedAt'>;
/** Turns kept per project (older ones are pruned on insert). */
export const KEEP_TURNS = 500;

const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** personas, persona_threads, persona_turns, persona_daily (migration 23). */
export class PersonaRepo {
  constructor(private db: DB) {}

  // ---------------- personas

  list(projectId: string, opts: { runId?: string | null; all?: boolean } = {}): Persona[] {
    let rows: Row[];
    if (opts.runId) rows = this.db.prepare('SELECT * FROM personas WHERE project_id = ? AND run_id = ? ORDER BY name COLLATE NOCASE').all(projectId, opts.runId) as Row[];
    else if (opts.all) rows = this.db.prepare('SELECT * FROM personas WHERE project_id = ? ORDER BY run_id IS NOT NULL, name COLLATE NOCASE').all(projectId) as Row[];
    else rows = this.db.prepare('SELECT * FROM personas WHERE project_id = ? AND run_id IS NULL ORDER BY name COLLATE NOCASE').all(projectId) as Row[];
    return rows.map(toPersona);
  }

  /** By id or slug. */
  get(projectId: string, ref: string): Persona | null {
    const r = this.db.prepare('SELECT * FROM personas WHERE project_id = ? AND (id = ? OR slug = ?) ORDER BY id = ? DESC LIMIT 1').get(projectId, ref, ref, ref) as Row | undefined;
    return r ? toPersona(r) : null;
  }

  byId(id: string): Persona | null {
    const r = this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Row | undefined;
    return r ? toPersona(r) : null;
  }

  slugTaken(projectId: string, slug: string, exceptId?: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM personas WHERE project_id = ? AND slug = ? AND id != ?').get(projectId, slug, exceptId ?? '');
  }

  create(projectId: string, runId: string | null, f: PersonaFields): Persona {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO personas (id, project_id, run_id, slug, name, enabled, provider, model, prompt, goals, style, limits, fallback, opener, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, projectId, runId, f.slug, f.name, f.enabled ? 1 : 0, f.provider, f.model, f.prompt, JSON.stringify(f.goals), JSON.stringify(f.style), JSON.stringify(f.limits), f.fallback, f.opener, now, now);
    return this.byId(id)!;
  }

  update(id: string, f: Partial<PersonaFields>): Persona | null {
    const cols: Record<string, unknown> = {};
    if (f.slug !== undefined) cols.slug = f.slug;
    if (f.name !== undefined) cols.name = f.name;
    if (f.enabled !== undefined) cols.enabled = f.enabled ? 1 : 0;
    if (f.provider !== undefined) cols.provider = f.provider;
    if (f.model !== undefined) cols.model = f.model;
    if (f.prompt !== undefined) cols.prompt = f.prompt;
    if (f.goals !== undefined) cols.goals = JSON.stringify(f.goals);
    if (f.style !== undefined) cols.style = JSON.stringify(f.style);
    if (f.limits !== undefined) cols.limits = JSON.stringify(f.limits);
    if (f.fallback !== undefined) cols.fallback = f.fallback;
    if (f.opener !== undefined) cols.opener = f.opener;
    cols.updated_at = nowIso();
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE personas SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k] as never), id);
    return this.byId(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM persona_turns WHERE persona_id = ?').run(id);
    this.db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  }

  // ---------------- threads

  findThread(personaId: string, testUserId: string, channel: string, runId: string | null): PersonaThread | null {
    const r = this.db
      .prepare("SELECT * FROM persona_threads WHERE persona_id = ? AND test_user_id = ? AND channel = ? AND COALESCE(run_id, '') = ?")
      .get(personaId, testUserId, channel, runId ?? '') as Row | undefined;
    return r ? toThread(r) : null;
  }

  /** The thread of persona + user + channel + run, created on first use (UNIQUE index on COALESCE(run_id, '')). */
  ensureThread(p: { projectId: string; personaId: string; testUserId: string; channel: string; runId: string | null; goals: Record<string, string> }): PersonaThread {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO persona_threads (id, project_id, persona_id, test_user_id, channel, run_id, state, goals, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'active',?,?,?)`,
      )
      .run(newId(), p.projectId, p.personaId, p.testUserId, p.channel, p.runId, JSON.stringify(p.goals), now, now);
    return this.findThread(p.personaId, p.testUserId, p.channel, p.runId)!;
  }

  thread(projectId: string, id: string): PersonaThread | null {
    const r = this.db.prepare('SELECT * FROM persona_threads WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    return r ? toThread(r) : null;
  }

  threadById(id: string): PersonaThread | null {
    const r = this.db.prepare('SELECT * FROM persona_threads WHERE id = ?').get(id) as Row | undefined;
    return r ? toThread(r) : null;
  }

  threads(projectId: string, q: { personaId?: string; testUserId?: string; state?: string[]; runId?: string; after?: string; limit?: number } = {}): PersonaThread[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (q.personaId) (where.push('persona_id = ?'), args.push(q.personaId));
    if (q.testUserId) (where.push('test_user_id = ?'), args.push(q.testUserId));
    if (q.runId) (where.push('run_id = ?'), args.push(q.runId));
    if (q.after) (where.push('updated_at > ?'), args.push(q.after));
    if (q.state?.length) (where.push(`state IN (${q.state.map(() => '?').join(',')})`), args.push(...q.state));
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    return (this.db.prepare(`SELECT * FROM persona_threads WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ${limit}`).all(...(args as never[])) as Row[]).map(toThread);
  }

  updateThread(id: string, f: Partial<Pick<PersonaThread, 'state' | 'stopReason' | 'replies' | 'tokensIn' | 'tokensOut' | 'errors' | 'fallbackSent' | 'goals' | 'notes' | 'lastTurnAt'>>): PersonaThread | null {
    const map: Record<string, string> = { state: 'state', stopReason: 'stop_reason', replies: 'replies', tokensIn: 'tokens_in', tokensOut: 'tokens_out', errors: 'errors', fallbackSent: 'fallback_sent', goals: 'goals', notes: 'notes', lastTurnAt: 'last_turn_at' };
    const cols: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      cols[map[k]] = k === 'goals' ? JSON.stringify(v) : k === 'fallbackSent' ? (v ? 1 : 0) : v;
    }
    cols.updated_at = nowIso();
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE persona_threads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k] as never), id);
    return this.threadById(id);
  }

  setThreadsState(where: { projectId?: string; personaId?: string; testUserId?: string; runId?: string; ids?: string[] }, from: PersonaThreadState[], to: PersonaThreadState, reason: string): PersonaThread[] {
    const w: string[] = [`state IN (${from.map(() => '?').join(',')})`];
    const args: unknown[] = [...from];
    if (where.projectId) (w.push('project_id = ?'), args.push(where.projectId));
    if (where.personaId) (w.push('persona_id = ?'), args.push(where.personaId));
    if (where.testUserId) (w.push('test_user_id = ?'), args.push(where.testUserId));
    if (where.runId) (w.push('run_id = ?'), args.push(where.runId));
    if (where.ids) (w.push(`id IN (${where.ids.map(() => '?').join(',') || "''"})`), args.push(...where.ids));
    const rows = (this.db.prepare(`SELECT * FROM persona_threads WHERE ${w.join(' AND ')}`).all(...(args as never[])) as Row[]).map(toThread);
    const now = nowIso();
    for (const t of rows) this.db.prepare('UPDATE persona_threads SET state = ?, stop_reason = ?, updated_at = ? WHERE id = ?').run(to, reason, now, t.id);
    return rows;
  }

  deleteThreads(projectId: string, q: { personaId?: string; runId?: string } = {}): number {
    const w = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (q.personaId) (w.push('persona_id = ?'), args.push(q.personaId));
    if (q.runId) (w.push('run_id = ?'), args.push(q.runId));
    this.db.prepare(`DELETE FROM persona_turns WHERE thread_id IN (SELECT id FROM persona_threads WHERE ${w.join(' AND ')})`).run(...(args as never[]));
    return Number(this.db.prepare(`DELETE FROM persona_threads WHERE ${w.join(' AND ')}`).run(...(args as never[])).changes);
  }

  // ---------------- turns

  insertTurn(t: Omit<PersonaTurn, 'id' | 'createdAt'>): PersonaTurn {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO persona_turns (id, project_id, persona_id, thread_id, fire_id, trigger_message_id, reply_message_id, status, text, raw, controls, warnings,
           provider, model, tokens_in, tokens_out, duration_ms, finish_reason, error, called, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, t.projectId, t.personaId, t.threadId, t.fireId, t.triggerMessageId, t.replyMessageId, t.status, t.text, t.raw,
        t.controls ? JSON.stringify(t.controls) : null, JSON.stringify(t.warnings), t.provider, t.model, t.tokensIn, t.tokensOut,
        t.durationMs, t.finishReason, t.error, t.called ? 1 : 0, nowIso(),
      );
    this.db
      .prepare('DELETE FROM persona_turns WHERE project_id = ? AND id NOT IN (SELECT id FROM persona_turns WHERE project_id = ? ORDER BY id DESC LIMIT ?)')
      .run(t.projectId, t.projectId, KEEP_TURNS);
    return this.turn(id)!;
  }

  turn(id: string): PersonaTurn | null {
    const r = this.db.prepare('SELECT * FROM persona_turns WHERE id = ?').get(id) as Row | undefined;
    return r ? toTurn(r) : null;
  }

  updateTurn(id: string, f: { replyMessageId?: string | null; status?: string; error?: string | null }): void {
    if (f.replyMessageId !== undefined) this.db.prepare('UPDATE persona_turns SET reply_message_id = ? WHERE id = ?').run(f.replyMessageId, id);
    if (f.status !== undefined) this.db.prepare('UPDATE persona_turns SET status = ? WHERE id = ?').run(f.status, id);
    if (f.error !== undefined) this.db.prepare('UPDATE persona_turns SET error = ? WHERE id = ?').run(f.error, id);
  }

  turnsOf(threadId: string, limit = 200): PersonaTurn[] {
    return (this.db.prepare('SELECT * FROM persona_turns WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(threadId, limit) as Row[]).map(toTurn).reverse();
  }

  /**
   * Reserve one model call against the project's dailyCalls cap (UTC day), before the call is made. Synchronous and
   * conditional, so concurrent turns / tests cannot overshoot the cap; every attempt (a retry too) takes one.
   */
  reserveCall(projectId: string, max: number): boolean {
    const day = utcDay();
    this.db.prepare('INSERT INTO persona_daily (project_id, day, calls) VALUES (?, ?, 0) ON CONFLICT(project_id, day) DO NOTHING').run(projectId, day);
    return Number(this.db.prepare('UPDATE persona_daily SET calls = calls + 1 WHERE project_id = ? AND day = ? AND calls < ?').run(projectId, day, max).changes) === 1;
  }

  /** Model calls today (UTC) for the project: the dailyCalls counter (survives turn pruning). */
  callsToday(projectId: string): number {
    const r = this.db.prepare('SELECT calls FROM persona_daily WHERE project_id = ? AND day = ?').get(projectId, utcDay()) as { calls: number } | undefined;
    return r?.calls ?? 0;
  }

  /** Tokens and calls of one persona today (UTC), from the kept turns. */
  usageToday(personaId: string): { calls: number; tokensIn: number; tokensOut: number } {
    const r = this.db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS ti, COALESCE(SUM(tokens_out), 0) AS tout FROM persona_turns WHERE persona_id = ? AND called = 1 AND created_at >= ?')
      .get(personaId, startOfUtcDay()) as { calls: number; ti: number; tout: number };
    return { calls: r.calls, tokensIn: r.ti, tokensOut: r.tout };
  }

  deleteTurnsBefore(projectId: string, cutoffIso: string): number {
    return Number(this.db.prepare('DELETE FROM persona_turns WHERE project_id = ? AND created_at < ?').run(projectId, cutoffIso).changes);
  }

  resetProject(projectId: string): void {
    this.db.prepare('DELETE FROM persona_turns WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM persona_threads WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM persona_daily WHERE project_id = ?').run(projectId);
  }

  purgeRun(runId: string): void {
    this.db.prepare('DELETE FROM persona_turns WHERE thread_id IN (SELECT id FROM persona_threads WHERE run_id = ?) OR persona_id IN (SELECT id FROM personas WHERE run_id = ?)').run(runId, runId);
    this.db.prepare('DELETE FROM persona_threads WHERE run_id = ? OR persona_id IN (SELECT id FROM personas WHERE run_id = ?)').run(runId, runId);
    this.db.prepare('DELETE FROM personas WHERE run_id = ?').run(runId);
  }
}
