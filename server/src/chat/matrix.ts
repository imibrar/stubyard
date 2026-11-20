import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { runOnce, type ChatUIMessage, type ToolSpec } from './engine.js';
import { evaluateExpectations, normalizeExpectations, type CheckResult, type Expectations } from './expectations.js';
import { MAX_OUTPUT_TOKENS_CAP, MAX_STEPS_CAP, type AgentTools, type ChatAgent } from './repo.js';
import type { ChatService } from './service.js';

/**
 * Model matrix (table chat_matrix_runs, migration 21): one prompt sent to 2–6 models side by side. Columns run through
 * runOnce (engine.ts) at most 3 at a time, each with its own AbortController; a failing column never fails the run.
 * Tokens and time only, no cost estimates. Newest 50 runs per project are kept; reset deletes them; not exported.
 */

type Json = Record<string, unknown>;

export const MATRIX_MIN_MODELS = 2;
export const MATRIX_MAX_MODELS = 6;
export const MATRIX_CONCURRENCY = 3;
export const MATRIX_KEEP = 50;
/** Running matrix runs at a time (each fans out to up to 6 models on real keys): per project and in all of stubyard. */
export const MATRIX_ACTIVE_PER_PROJECT = 3;
export const MATRIX_ACTIVE_GLOBAL = 10;
const COLUMN_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_CLIP = 4 * 1024;
const TEXT_CLIP = 32 * 1024;

export type MatrixTools = 'none' | 'builtin' | 'agent';
export interface MatrixModel {
  provider: string;
  model: string;
}
export interface MatrixConfig {
  models: MatrixModel[];
  system?: string;
  tools: MatrixTools;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  maxSteps?: number;
  expectations?: Expectations;
}
export type ColumnStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
export interface MatrixToolCall {
  name: string;
  input: unknown;
  output: unknown;
  error: string | null;
}
export interface MatrixColumn {
  provider: string;
  model: string;
  status: ColumnStatus;
  text: string;
  toolCalls: MatrixToolCall[];
  steps: number;
  usage: { input: number; output: number };
  finishReason: string | null;
  durationMs: number | null;
  error: string | null;
  expectations?: { passed: boolean; checks: CheckResult[] };
  /** Tool sources that could not be loaded (e.g. an MCP tester target that is down). */
  toolErrors?: { target: string; error: string }[];
}
export type MatrixStatus = 'running' | 'done' | 'cancelled';
export interface MatrixRun {
  id: string;
  projectId: string;
  agentId: string | null;
  promptId: string | null;
  name: string;
  prompt: string;
  config: MatrixConfig;
  status: MatrixStatus;
  columns: MatrixColumn[];
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  finishedAt: string | null;
}

const toRun = (r: Json): MatrixRun => ({
  id: String(r.id),
  projectId: String(r.project_id),
  agentId: (r.agent_id as string | null) ?? null,
  promptId: (r.prompt_id as string | null) ?? null,
  name: String(r.name ?? ''),
  prompt: String(r.prompt ?? ''),
  config: parseJson<MatrixConfig>(r.config as string, { models: [], tools: 'none' }),
  status: r.status as MatrixStatus,
  columns: parseJson<MatrixColumn[]>(r.columns as string, []),
  tokensIn: Number(r.tokens_in ?? 0),
  tokensOut: Number(r.tokens_out ?? 0),
  createdAt: String(r.created_at),
  finishedAt: (r.finished_at as string | null) ?? null,
});

const clipStr = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[clipped: ${s.length} characters]` : s);
const clipOutput = (v: unknown): unknown => {
  if (typeof v === 'string') return clipStr(v, OUTPUT_CLIP);
  if (v === null || v === undefined) return v ?? null;
  const s = JSON.stringify(v);
  return s.length > OUTPUT_CLIP ? clipStr(s, OUTPUT_CLIP) : v;
};
const optNum = (v: unknown, name: string, min: number, max: number): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};

export function normalizeModels(v: unknown): MatrixModel[] {
  if (!Array.isArray(v)) throw new HttpError(400, `models is required: a list of ${MATRIX_MIN_MODELS}–${MATRIX_MAX_MODELS} {provider, model}, e.g. [{"provider":"mock:openai","model":"gpt-5-mini"}, …]`);
  const out = v.map((x, i) => {
    const o = (typeof x === 'string' ? { provider: x.split('/')[0], model: x.split('/').slice(1).join('/') } : (x ?? {})) as Json;
    const provider = String(o.provider ?? '').trim();
    const model = String(o.model ?? '').trim();
    if (!provider || !model) throw new HttpError(400, `models[${i}] needs provider and model`);
    return { provider, model };
  });
  if (out.length < MATRIX_MIN_MODELS || out.length > MATRIX_MAX_MODELS) throw new HttpError(400, `models must have ${MATRIX_MIN_MODELS} to ${MATRIX_MAX_MODELS} entries (got ${out.length})`);
  return out;
}

const pendingColumn = (m: MatrixModel): MatrixColumn => ({ provider: m.provider, model: m.model, status: 'pending', text: '', toolCalls: [], steps: 0, usage: { input: 0, output: 0 }, finishReason: null, durationMs: null, error: null });

interface Active {
  projectId: string;
  controllers: Set<AbortController>;
  cancelled: boolean;
  done: Promise<void>;
}

export class MatrixService {
  private active = new Map<string, Active>();

  constructor(
    private hub: Hub,
    private chat: ChatService,
  ) {
    // Runs left "running" by a previous process cannot finish any more.
    try {
      for (const r of hub.db.prepare("SELECT * FROM chat_matrix_runs WHERE status = 'running'").all() as Json[]) {
        const run = toRun(r);
        const cols = run.columns.map((c) => (c.status === 'pending' || c.status === 'running' ? { ...c, status: 'cancelled' as const, error: 'stubyard restarted while this column ran' } : c));
        hub.db.prepare("UPDATE chat_matrix_runs SET status = 'cancelled', columns = ?, finished_at = ? WHERE id = ?").run(cols, nowIso(), run.id);
      }
    } catch {
      /* table missing before migration 21 (never in practice) */
    }
  }

  // ------------------------------------------------------------------ storage
  list(projectId: string, limit = MATRIX_KEEP): MatrixRun[] {
    return (this.hub.db.prepare('SELECT * FROM chat_matrix_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, Math.min(Math.max(limit, 1), 200)) as Json[]).map(toRun);
  }

  get(projectId: string, id: string): MatrixRun | null {
    const r = this.hub.db.prepare('SELECT * FROM chat_matrix_runs WHERE project_id = ? AND id = ?').get(projectId, id) as Json | undefined;
    return r ? toRun(r) : null;
  }

  require(projectId: string, id: string): MatrixRun {
    const r = this.get(projectId, id);
    if (!r) throw new HttpError(404, `Model matrix run "${id}" not found`);
    return r;
  }

  private save(run: MatrixRun): void {
    const tin = run.columns.reduce((n, c) => n + (c.usage?.input ?? 0), 0);
    const tout = run.columns.reduce((n, c) => n + (c.usage?.output ?? 0), 0);
    this.hub.db.prepare('UPDATE chat_matrix_runs SET columns = ?, status = ?, tokens_in = ?, tokens_out = ?, finished_at = ? WHERE id = ?').run(run.columns, run.status, tin, tout, run.finishedAt, run.id);
    run.tokensIn = tin;
    run.tokensOut = tout;
  }

  delete(projectId: string, id: string): boolean {
    const run = this.require(projectId, id);
    this.abort(run.id);
    return this.hub.db.prepare('DELETE FROM chat_matrix_runs WHERE id = ?').run(run.id).changes > 0;
  }

  /** Project reset: every matrix run goes (running ones are aborted first). */
  resetProject(projectId: string): number {
    for (const r of this.hub.db.prepare("SELECT id FROM chat_matrix_runs WHERE project_id = ? AND status = 'running'").all(projectId) as { id: string }[]) this.abort(r.id);
    return this.hub.db.prepare('DELETE FROM chat_matrix_runs WHERE project_id = ?').run(projectId).changes;
  }

  private prune(projectId: string): void {
    const old = this.hub.db.prepare('SELECT id FROM chat_matrix_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?').all(projectId, MATRIX_KEEP) as { id: string }[];
    for (const r of old) {
      this.abort(r.id);
      this.hub.db.prepare('DELETE FROM chat_matrix_runs WHERE id = ?').run(r.id);
    }
  }

  private abort(id: string): void {
    const a = this.active.get(id);
    if (!a) return;
    a.cancelled = true;
    for (const c of a.controllers) c.abort();
  }

  view(run: MatrixRun) {
    const agent = run.agentId ? this.chat.repo.getAgent(run.projectId, run.agentId) : null;
    return { ...run, agent: agent ? { id: agent.id, slug: agent.slug, name: agent.name } : null };
  }

  // ------------------------------------------------------------------ start / run
  /**
   * Validates and starts a run. Body: {prompt | promptId, agent?, models, system?, tools?, expectations?, temperature?,
   * maxOutputTokens?, maxSteps?, name?, confirmSideEffects?}. Returns the stored run and a promise for its end.
   */
  start(project: Project, body: Json): { run: MatrixRun; done: Promise<void> } {
    const repo = this.chat.repo;
    const saved = body.promptId ? repo.requirePrompt(project.id, String(body.promptId)) : null;
    const agentRef = body.agent ? String(body.agent) : saved?.agentId;
    const agent = agentRef ? repo.requireAgent(project.id, agentRef) : null;
    const prompt = String(body.prompt ?? saved?.prompt ?? '').trim();
    if (!prompt) throw new HttpError(400, 'prompt (or promptId of a saved prompt) is required');
    const models = normalizeModels(body.models);
    const tools = String(body.tools ?? (agent ? 'builtin' : 'none')) as MatrixTools;
    if (!['none', 'builtin', 'agent'].includes(tools)) throw new HttpError(400, 'tools must be "none", "builtin" or "agent"');
    if (tools === 'agent') {
      if (!agent) throw new HttpError(400, 'tools "agent" needs an agent (its MCP tester targets are offered to every model)');
      if (body.confirmSideEffects !== true)
        throw new HttpError(400, `tools "agent" offers the agent's MCP server tools to every model: a tool that changes state may run once per model (${models.length} times). Send "confirmSideEffects": true to go ahead, or use tools "builtin" (stubyard's read-only tools).`);
    }
    const expectations = body.expectations !== undefined ? normalizeExpectations(body.expectations) : (saved?.expectations ?? {});
    const mine = [...this.active.values()].filter((x) => x.projectId === project.id).length;
    if (mine >= MATRIX_ACTIVE_PER_PROJECT || this.active.size >= MATRIX_ACTIVE_GLOBAL)
      throw new HttpError(
        429,
        mine >= MATRIX_ACTIVE_PER_PROJECT
          ? `${mine} model matrix runs are already running in this project (at most ${MATRIX_ACTIVE_PER_PROJECT}): wait for one to finish or cancel it`
          : `${this.active.size} model matrix runs are already running in stubyard (at most ${MATRIX_ACTIVE_GLOBAL}): try again shortly`,
      );
    const config: MatrixConfig = {
      models,
      tools,
      system: body.system !== undefined && body.system !== null ? String(body.system) : (agent?.instructions ?? ''),
      temperature: optNum(body.temperature, 'temperature', 0, 2) ?? agent?.temperature ?? null,
      maxOutputTokens: optNum(body.maxOutputTokens, 'maxOutputTokens', 1, MAX_OUTPUT_TOKENS_CAP) ?? agent?.maxOutputTokens ?? null,
      maxSteps: Math.round(optNum(body.maxSteps, 'maxSteps', 1, MAX_STEPS_CAP) ?? agent?.maxSteps ?? 10),
      ...(Object.keys(expectations).length ? { expectations } : {}),
    };
    const name = String(body.name ?? '').trim().slice(0, 120) || (saved ? saved.name : prompt.replace(/\s+/g, ' ').slice(0, 60));
    const id = newId();
    const columns = models.map(pendingColumn);
    this.hub.db
      .prepare('INSERT INTO chat_matrix_runs (id, project_id, agent_id, prompt_id, name, prompt, config, status, columns, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, project.id, agent?.id ?? null, saved?.id ?? null, name, prompt, config, 'running', columns, nowIso());
    this.prune(project.id);
    const run = this.require(project.id, id);
    const a: Active = { projectId: project.id, controllers: new Set(), cancelled: false, done: Promise.resolve() };
    this.active.set(id, a);
    // Never rejects: without ?wait nobody awaits it, and an unhandled rejection (a DB error in save) would end the process.
    a.done = this.execute(project, run, agent, a)
      .catch((err) => this.failRun(project.id, id, err))
      .finally(() => this.active.delete(id));
    this.chat.publish(project.id, { matrix: id, kind: 'matrix' });
    return { run, done: a.done };
  }

  rerun(project: Project, id: string, body: Json): { run: MatrixRun; done: Promise<void> } {
    const prev = this.require(project.id, id);
    const c = prev.config;
    return this.start(project, {
      prompt: prev.prompt,
      promptId: undefined,
      agent: prev.agentId ?? undefined,
      models: body.models ?? c.models,
      tools: c.tools,
      system: c.system,
      temperature: c.temperature,
      maxOutputTokens: c.maxOutputTokens,
      maxSteps: c.maxSteps,
      expectations: c.expectations ?? {},
      name: prev.name,
      confirmSideEffects: c.tools === 'agent' ? body.confirmSideEffects : undefined,
    });
  }

  /** Aborts every running column; columns not started yet end as cancelled. Waits (up to 5 s) for the run to settle. */
  async cancel(project: Project, id: string): Promise<MatrixRun> {
    const run = this.require(project.id, id);
    if (run.status !== 'running') return run;
    const a = this.active.get(id);
    if (!a) {
      // Not running in this process (should not happen after the boot sweep): close it here.
      run.columns = run.columns.map((c) => (c.status === 'pending' || c.status === 'running' ? { ...c, status: 'cancelled' } : c));
      run.status = 'cancelled';
      run.finishedAt = nowIso();
      this.save(run);
      this.chat.publish(project.id, { matrix: id, kind: 'matrix' });
      return run;
    }
    this.abort(id);
    await Promise.race([a.done, new Promise((r) => setTimeout(r, 5000))]);
    return this.require(project.id, id);
  }

  /** execute() threw (DB error, bug): close the run so it does not stay "running". Never throws. */
  private failRun(projectId: string, id: string, err: unknown): void {
    try {
      const run = this.get(projectId, id);
      if (!run || run.status !== 'running') return;
      const msg = this.chat.errorText(err);
      run.columns = run.columns.map((c) => (c.status === 'pending' || c.status === 'running' ? { ...c, status: 'error', error: msg } : c));
      run.status = 'done';
      run.finishedAt = nowIso();
      this.save(run);
      this.chat.publish(projectId, { matrix: id, kind: 'matrix' });
    } catch {
      /* the database itself is failing: nothing more to do here */
    }
  }

  private async toolsFor(project: Project, agent: ChatAgent | null, mode: MatrixTools): Promise<{ tools: ToolSpec[]; errors: { target: string; error: string }[] }> {
    if (mode === 'none') return { tools: [], errors: [] };
    const builtin = agent && agent.tools.builtin !== false ? agent.tools.builtin : true;
    const tools: AgentTools = mode === 'agent' && agent ? agent.tools : { builtin, targets: [] };
    const fake = (agent ?? { id: 'matrix', projectId: project.id, slug: 'matrix', name: 'matrix', provider: '', model: '', instructions: '', maxSteps: 10, maxOutputTokens: null, temperature: null, createdAt: '', updatedAt: '' }) as ChatAgent;
    const built = await this.chat.tools(project, { ...fake, tools });
    return { tools: built.tools, errors: built.errors };
  }

  private async execute(project: Project, run: MatrixRun, agent: ChatAgent | null, a: Active): Promise<void> {
    const cfg = run.config;
    let tools: ToolSpec[] = [];
    let toolErrors: { target: string; error: string }[] = [];
    try {
      ({ tools, errors: toolErrors } = await this.toolsFor(project, agent, cfg.tools));
    } catch (err) {
      toolErrors = [{ target: 'tools', error: this.chat.errorText(err) }];
    }
    const cols = run.columns;
    const publish = () => {
      // The run may have been deleted (reset, pruning, DELETE) meanwhile: then there is nothing to update.
      if (!this.get(project.id, run.id)) return;
      this.save(run);
      this.chat.publish(project.id, { matrix: run.id, kind: 'matrix' });
    };
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= cols.length) return;
        if (a.cancelled) {
          cols[i] = { ...cols[i], status: 'cancelled' };
          continue;
        }
        cols[i] = { ...cols[i], status: 'running' };
        publish();
        cols[i] = await this.runColumn(project, run, cols[i], tools, toolErrors, a);
        publish();
      }
    };
    await Promise.all(Array.from({ length: Math.min(MATRIX_CONCURRENCY, cols.length) }, () => worker()));
    run.status = a.cancelled ? 'cancelled' : 'done';
    run.finishedAt = nowIso();
    publish();
  }

  private async runColumn(project: Project, run: MatrixRun, col: MatrixColumn, tools: ToolSpec[], toolErrors: { target: string; error: string }[], a: Active): Promise<MatrixColumn> {
    const cfg = run.config;
    const ctrl = new AbortController();
    a.controllers.add(ctrl);
    const t0 = Date.now();
    try {
      const h = this.chat.modelFor(col.provider, col.model, project);
      const r = await runOnce({
        model: h.model,
        system: cfg.system || undefined,
        messages: [{ id: 'matrix', role: 'user', parts: [{ type: 'text', text: run.prompt }] } as ChatUIMessage],
        tools,
        maxSteps: cfg.maxSteps ?? 10,
        maxOutputTokens: cfg.maxOutputTokens ?? null,
        temperature: cfg.temperature ?? null,
        abortSignal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(COLUMN_TIMEOUT_MS)]),
        errorText: this.chat.errorText,
      });
      const toolCalls: MatrixToolCall[] = r.toolCalls.map((c) => {
        const out = typeof c.output === 'string' ? c.output : c.output;
        const err = typeof out === 'string' && out.startsWith('Error: ') ? out.slice(7, 7 + 1000) : null;
        return { name: c.name, input: c.input, output: clipOutput(out), error: err };
      });
      const done: MatrixColumn = {
        ...col,
        status: 'done',
        text: clipStr(r.text, TEXT_CLIP),
        toolCalls,
        steps: r.steps,
        usage: { input: r.usage.inputTokens, output: r.usage.outputTokens },
        finishReason: r.finishReason,
        durationMs: r.durationMs,
        error: null,
      };
      if (cfg.expectations && Object.keys(cfg.expectations).length) {
        done.expectations = evaluateExpectations(cfg.expectations, { text: r.text, toolCalls, steps: r.steps, usage: r.usage, finishReason: r.finishReason, durationMs: r.durationMs, error: null });
      }
      if (toolErrors.length) done.toolErrors = toolErrors;
      return done;
    } catch (err) {
      const cancelled = a.cancelled || ctrl.signal.aborted;
      const error = cancelled ? 'cancelled' : this.chat.errorText(err);
      const out: MatrixColumn = { ...col, status: cancelled ? 'cancelled' : 'error', error, durationMs: Date.now() - t0, finishReason: cancelled ? 'aborted' : 'error' };
      if (!cancelled && cfg.expectations && Object.keys(cfg.expectations).length)
        out.expectations = evaluateExpectations(cfg.expectations, { text: '', toolCalls: [], steps: 0, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'error', durationMs: out.durationMs ?? 0, error });
      return out;
    } finally {
      a.controllers.delete(ctrl);
    }
  }

  // ------------------------------------------------------------------ results
  private column(run: MatrixRun, ref: unknown): { col: MatrixColumn; index: number } {
    if (ref === undefined || ref === null || ref === '') throw new HttpError(400, 'column is required: its index (0-based) or "provider/model"');
    const n = Number(ref);
    const index = Number.isInteger(n) ? n : run.columns.findIndex((c) => `${c.provider}/${c.model}` === String(ref));
    const col = run.columns[index];
    if (!col) throw new HttpError(404, `Column "${String(ref)}" not found in this run (${run.columns.length} columns)`);
    return { col, index };
  }

  /** Use one column's provider + model for an agent (PATCH of that agent). */
  adopt(project: Project, id: string, body: Json): ChatAgent {
    const run = this.require(project.id, id);
    const { col } = this.column(run, body.column);
    const agentRef = body.agent ? String(body.agent) : run.agentId;
    if (!agentRef) throw new HttpError(400, 'agent is required (slug or id)');
    const a = this.chat.repo.updateAgent(project.id, agentRef, { provider: col.provider, model: col.model });
    this.chat.publish(project.id, { agent: a.id, kind: 'agent' });
    return a;
  }

  /** One column as a normal conversation (prompt + that model's answer), so it can be continued. */
  openAsConversation(project: Project, id: string, body: Json) {
    const run = this.require(project.id, id);
    const { col } = this.column(run, body.column);
    if (col.status !== 'done' && col.status !== 'error') throw new HttpError(409, `Column ${col.provider}/${col.model} has not finished (${col.status})`);
    const agentId = body.agent ? this.chat.repo.requireAgent(project.id, String(body.agent)).id : run.agentId;
    const repo = this.chat.repo;
    const conv = repo.createConversation(project.id, agentId, `${run.name || run.prompt.slice(0, 40)} · ${col.model}`);
    repo.addMessage(conv, { role: 'user', parts: [{ type: 'text', text: run.prompt }] });
    const parts: Json[] = [{ type: 'step-start' }];
    col.toolCalls.forEach((c, i) => parts.push({ type: 'dynamic-tool', toolName: c.name, toolCallId: `matrix_${i}`, state: c.error ? 'output-error' : 'output-available', input: c.input, ...(c.error ? { errorText: c.error } : { output: c.output }) }));
    if (col.toolCalls.length && col.text) parts.push({ type: 'step-start' });
    if (col.text) parts.push({ type: 'text', text: col.text, state: 'done' });
    repo.addMessage(conv, {
      role: 'assistant',
      parts,
      provider: col.provider,
      model: col.model,
      tokensIn: col.usage.input,
      tokensOut: col.usage.output,
      finishReason: col.finishReason,
      steps: col.steps,
      durationMs: col.durationMs,
      error: col.status === 'error' ? col.error : null,
    });
    repo.addTokens(conv.id, col.usage.input, col.usage.output);
    this.chat.publish(project.id, { conversation: conv.id, kind: 'conversation' });
    return this.chat.conversationView(repo.requireConversation(project.id, conv.id));
  }
}
