import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso, parseJson, slugify, SLUG_RE } from '../util.js';
import type { ExpectationResult, Expectations } from './expectations.js';

/** Chat agents, conversations, messages and saved prompts (migration 15). */

type Json = Record<string, unknown>;

export interface AgentTools {
  /** stubyard's own read-only tools: true = all, false = none, or a list of tool names (with or without "stubyard__"). */
  builtin: boolean | string[];
  /** MCP tester targets (id or name) and which of their tools ('*' = all). */
  targets: { target: string; tools: '*' | string[] }[];
}

export interface ChatAgent {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  /** AI provider name / id, or env:<id>. */
  provider: string;
  model: string;
  instructions: string;
  tools: AgentTools;
  maxSteps: number;
  maxOutputTokens: number | null;
  temperature: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  agentId: string | null;
  title: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  updatedAt: string;
  messages?: number;
}

export interface ChatMessageRow {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  parts: Json[];
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  finishReason: string | null;
  steps: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface SavedPrompt {
  id: string;
  projectId: string;
  agentId: string;
  name: string;
  prompt: string;
  expectations: Expectations;
  lastResult: ExpectationResult | null;
  lastRunAt: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

export const MAX_STEPS_CAP = 25;
export const MAX_OUTPUT_TOKENS_CAP = 64_000;

const num = (v: unknown, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};

export function normalizeTools(v: unknown, prev?: AgentTools): AgentTools {
  if (v === undefined) return prev ?? { builtin: true, targets: [] };
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'tools must be an object { builtin, targets }');
  const t = v as Json;
  let builtin: boolean | string[] = prev?.builtin ?? true;
  if (t.builtin !== undefined) {
    if (typeof t.builtin === 'boolean') builtin = t.builtin;
    else if (Array.isArray(t.builtin)) builtin = t.builtin.map((x) => String(x).trim()).filter(Boolean);
    else throw new HttpError(400, 'tools.builtin must be true, false or a list of tool names');
  }
  let targets = prev?.targets ?? [];
  if (t.targets !== undefined) {
    if (!Array.isArray(t.targets)) throw new HttpError(400, 'tools.targets must be a list of { target, tools }');
    targets = t.targets.map((x) => {
      const o = (x ?? {}) as Json;
      const target = String(o.target ?? '').trim();
      if (!target) throw new HttpError(400, 'every tools.targets entry needs "target" (MCP tester target id or name)');
      const tools = o.tools === undefined || o.tools === '*' ? '*' : Array.isArray(o.tools) ? o.tools.map((y) => String(y)).filter(Boolean) : null;
      if (tools === null) throw new HttpError(400, 'tools.targets[].tools must be "*" or a list of tool names');
      return { target, tools };
    });
  }
  return { builtin, targets };
}

interface AgentRow {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  provider: string;
  model: string;
  instructions: string;
  tools: string;
  max_steps: number;
  max_output_tokens: number | null;
  temperature: number | null;
  created_at: string;
  updated_at: string;
}

const toAgent = (r: AgentRow): ChatAgent => ({
  id: r.id,
  projectId: r.project_id,
  slug: r.slug,
  name: r.name,
  provider: r.provider,
  model: r.model,
  instructions: r.instructions,
  tools: normalizeTools(parseJson(r.tools, {})),
  maxSteps: r.max_steps,
  maxOutputTokens: r.max_output_tokens,
  temperature: r.temperature,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toConv = (r: Json): Conversation => ({
  id: String(r.id),
  projectId: String(r.project_id),
  agentId: (r.agent_id as string | null) ?? null,
  title: String(r.title ?? ''),
  tokensIn: Number(r.tokens_in ?? 0),
  tokensOut: Number(r.tokens_out ?? 0),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  ...(r.messages !== undefined ? { messages: Number(r.messages) } : {}),
});

const toMsg = (r: Json): ChatMessageRow => ({
  id: String(r.id),
  conversationId: String(r.conversation_id),
  seq: Number(r.seq),
  role: r.role as ChatMessageRow['role'],
  parts: parseJson<Json[]>(r.parts as string, []),
  provider: (r.provider as string | null) ?? null,
  model: (r.model as string | null) ?? null,
  tokensIn: (r.tokens_in as number | null) ?? null,
  tokensOut: (r.tokens_out as number | null) ?? null,
  finishReason: (r.finish_reason as string | null) ?? null,
  steps: (r.steps as number | null) ?? null,
  durationMs: (r.duration_ms as number | null) ?? null,
  error: (r.error as string | null) ?? null,
  createdAt: String(r.created_at),
});

const toPrompt = (r: Json): SavedPrompt => ({
  id: String(r.id),
  projectId: String(r.project_id),
  agentId: String(r.agent_id),
  name: String(r.name),
  prompt: String(r.prompt),
  expectations: parseJson<Expectations>(r.expectations as string, {}),
  lastResult: parseJson<ExpectationResult | null>(r.last_result as string | null, null),
  lastRunAt: (r.last_run_at as string | null) ?? null,
  sort: Number(r.sort ?? 0),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export interface AgentInput {
  slug?: unknown;
  name?: unknown;
  provider?: unknown;
  model?: unknown;
  instructions?: unknown;
  tools?: unknown;
  maxSteps?: unknown;
  maxOutputTokens?: unknown;
  temperature?: unknown;
}

export class ChatRepo {
  constructor(private db: DB) {}

  // ---------------------------------------------------------------- agents
  listAgents(projectId: string): ChatAgent[] {
    return (this.db.prepare('SELECT * FROM chat_agents WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(projectId) as unknown as AgentRow[]).map(toAgent);
  }

  getAgent(projectId: string, ref: string): ChatAgent | null {
    const r = this.db.prepare('SELECT * FROM chat_agents WHERE project_id = ? AND (id = ? OR slug = ? OR name = ? COLLATE NOCASE)').get(projectId, ref, ref.toLowerCase(), ref) as AgentRow | undefined;
    return r ? toAgent(r) : null;
  }

  requireAgent(projectId: string, ref: string): ChatAgent {
    const a = this.getAgent(projectId, ref);
    if (!a) throw new HttpError(404, `Chat agent "${ref}" not found`);
    return a;
  }

  private agentFields(input: AgentInput, prev?: ChatAgent) {
    const name = input.name === undefined ? prev?.name : String(input.name).trim();
    if (!name) throw new HttpError(400, 'name is required');
    const provider = input.provider === undefined ? prev?.provider : String(input.provider).trim();
    if (!provider) throw new HttpError(400, 'provider is required (an AI provider name, or env:openai / env:anthropic / …)');
    const model = input.model === undefined ? prev?.model : String(input.model).trim();
    if (!model) throw new HttpError(400, 'model is required (e.g. "gpt-5-mini", "claude-sonnet-4-5")');
    const instructions = input.instructions === undefined ? (prev?.instructions ?? '') : String(input.instructions ?? '');
    const tools = normalizeTools(input.tools, prev?.tools);
    const maxSteps = input.maxSteps === undefined || input.maxSteps === null ? (prev?.maxSteps ?? 10) : Math.round(num(input.maxSteps, 'maxSteps', 1, MAX_STEPS_CAP));
    const maxOutputTokens =
      input.maxOutputTokens === undefined ? (prev?.maxOutputTokens ?? null) : input.maxOutputTokens === null || input.maxOutputTokens === '' ? null : Math.round(num(input.maxOutputTokens, 'maxOutputTokens', 1, MAX_OUTPUT_TOKENS_CAP));
    const temperature = input.temperature === undefined ? (prev?.temperature ?? null) : input.temperature === null || input.temperature === '' ? null : num(input.temperature, 'temperature', 0, 2);
    return { name, provider, model, instructions, tools, maxSteps, maxOutputTokens, temperature };
  }

  createAgent(projectId: string, input: AgentInput): ChatAgent {
    const f = this.agentFields(input);
    const slug = input.slug ? String(input.slug).trim().toLowerCase() : slugify(f.name!);
    if (!SLUG_RE.test(slug)) throw new HttpError(400, `Invalid slug "${slug}" (lower-case letters, digits and -)`);
    if (this.getAgent(projectId, slug)) throw new HttpError(409, `A chat agent "${slug}" exists already`);
    const at = nowIso();
    const id = newId();
    this.db
      .prepare('INSERT INTO chat_agents (id, project_id, slug, name, provider, model, instructions, tools, max_steps, max_output_tokens, temperature, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, slug, f.name, f.provider, f.model, f.instructions, f.tools, f.maxSteps, f.maxOutputTokens, f.temperature, at, at);
    return this.requireAgent(projectId, id);
  }

  updateAgent(projectId: string, ref: string, input: AgentInput): ChatAgent {
    const a = this.requireAgent(projectId, ref);
    const f = this.agentFields(input, a);
    const slug = input.slug === undefined ? a.slug : String(input.slug).trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new HttpError(400, `Invalid slug "${slug}"`);
    const other = this.getAgent(projectId, slug);
    if (other && other.id !== a.id) throw new HttpError(409, `A chat agent "${slug}" exists already`);
    this.db
      .prepare('UPDATE chat_agents SET slug = ?, name = ?, provider = ?, model = ?, instructions = ?, tools = ?, max_steps = ?, max_output_tokens = ?, temperature = ?, updated_at = ? WHERE id = ?')
      .run(slug, f.name, f.provider, f.model, f.instructions, f.tools, f.maxSteps, f.maxOutputTokens, f.temperature, nowIso(), a.id);
    return this.requireAgent(projectId, a.id);
  }

  deleteAgent(projectId: string, ref: string): boolean {
    const a = this.requireAgent(projectId, ref);
    return this.db.prepare('DELETE FROM chat_agents WHERE id = ?').run(a.id).changes > 0;
  }

  // ---------------------------------------------------------------- conversations
  listConversations(projectId: string, opts: { agentId?: string; limit?: number } = {}): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS messages FROM chat_conversations c
         WHERE c.project_id = ? AND (? IS NULL OR c.agent_id = ?) ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(projectId, opts.agentId ?? null, opts.agentId ?? null, Math.min(Math.max(opts.limit ?? 200, 1), 1000)) as Json[];
    return rows.map(toConv);
  }

  getConversation(projectId: string, id: string): Conversation | null {
    const r = this.db.prepare('SELECT * FROM chat_conversations WHERE project_id = ? AND id = ?').get(projectId, id) as Json | undefined;
    return r ? toConv(r) : null;
  }

  requireConversation(projectId: string, id: string): Conversation {
    const c = this.getConversation(projectId, id);
    if (!c) throw new HttpError(404, `Conversation "${id}" not found`);
    return c;
  }

  createConversation(projectId: string, agentId: string | null, title = ''): Conversation {
    const at = nowIso();
    const id = newId();
    this.db.prepare('INSERT INTO chat_conversations (id, project_id, agent_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, projectId, agentId, title.slice(0, 200), at, at);
    return this.requireConversation(projectId, id);
  }

  updateConversation(projectId: string, id: string, input: { title?: unknown; agentId?: string | null }): Conversation {
    const c = this.requireConversation(projectId, id);
    const title = input.title === undefined ? c.title : String(input.title ?? '').slice(0, 200);
    const agentId = input.agentId === undefined ? c.agentId : input.agentId;
    this.db.prepare('UPDATE chat_conversations SET title = ?, agent_id = ?, updated_at = ? WHERE id = ?').run(title, agentId, nowIso(), c.id);
    return this.requireConversation(projectId, c.id);
  }

  addTokens(id: string, tokensIn: number, tokensOut: number): void {
    this.db.prepare('UPDATE chat_conversations SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, updated_at = ? WHERE id = ?').run(tokensIn, tokensOut, nowIso(), id);
  }

  deleteConversation(projectId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM chat_conversations WHERE project_id = ? AND id = ?').run(projectId, id).changes > 0;
  }

  deleteConversations(projectId: string): number {
    return this.db.prepare('DELETE FROM chat_conversations WHERE project_id = ?').run(projectId).changes;
  }

  // ---------------------------------------------------------------- messages
  messages(conversationId: string): ChatMessageRow[] {
    return (this.db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq').all(conversationId) as Json[]).map(toMsg);
  }

  messageExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_messages WHERE id = ?').get(id);
  }

  addMessage(
    conv: Conversation,
    m: { id?: string; role: ChatMessageRow['role']; parts: Json[]; provider?: string | null; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; finishReason?: string | null; steps?: number | null; durationMs?: number | null; error?: string | null },
  ): ChatMessageRow {
    const id = m.id && /^[A-Za-z0-9_-]{1,64}$/.test(m.id) && !this.messageExists(m.id) ? m.id : newId();
    const seq = ((this.db.prepare('SELECT MAX(seq) AS s FROM chat_messages WHERE conversation_id = ?').get(conv.id) as { s: number | null }).s ?? 0) + 1;
    this.db
      .prepare('INSERT INTO chat_messages (id, conversation_id, project_id, seq, role, parts, provider, model, tokens_in, tokens_out, finish_reason, steps, duration_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, conv.id, conv.projectId, seq, m.role, m.parts, m.provider ?? null, m.model ?? null, m.tokensIn ?? null, m.tokensOut ?? null, m.finishReason ?? null, m.steps ?? null, m.durationMs ?? null, m.error ?? null, nowIso());
    this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(nowIso(), conv.id);
    return toMsg(this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as Json);
  }

  /** Removes messages after `seq` (regenerate). */
  deleteMessagesAfter(conversationId: string, seq: number): number {
    return this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ? AND seq > ?').run(conversationId, seq).changes;
  }

  // ---------------------------------------------------------------- saved prompts
  listPrompts(projectId: string, agentId?: string): SavedPrompt[] {
    return (
      this.db.prepare('SELECT * FROM chat_prompts WHERE project_id = ? AND (? IS NULL OR agent_id = ?) ORDER BY sort, created_at').all(projectId, agentId ?? null, agentId ?? null) as Json[]
    ).map(toPrompt);
  }

  getPrompt(projectId: string, id: string): SavedPrompt | null {
    const r = this.db.prepare('SELECT * FROM chat_prompts WHERE project_id = ? AND (id = ? OR name = ? COLLATE NOCASE)').get(projectId, id, id) as Json | undefined;
    return r ? toPrompt(r) : null;
  }

  requirePrompt(projectId: string, id: string): SavedPrompt {
    const p = this.getPrompt(projectId, id);
    if (!p) throw new HttpError(404, `Saved prompt "${id}" not found`);
    return p;
  }

  createPrompt(projectId: string, agentId: string, input: { name?: unknown; prompt?: unknown; expectations?: Expectations; sort?: unknown }): SavedPrompt {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) throw new HttpError(400, 'prompt is required');
    const name = String(input.name ?? '').trim() || prompt.slice(0, 60);
    const sort = input.sort === undefined ? ((this.db.prepare('SELECT MAX(sort) AS s FROM chat_prompts WHERE agent_id = ?').get(agentId) as { s: number | null }).s ?? 0) + 1 : Number(input.sort) || 0;
    const at = nowIso();
    const id = newId();
    this.db
      .prepare('INSERT INTO chat_prompts (id, project_id, agent_id, name, prompt, expectations, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, agentId, name, prompt, input.expectations ?? {}, sort, at, at);
    return this.requirePrompt(projectId, id);
  }

  updatePrompt(projectId: string, id: string, input: { name?: unknown; prompt?: unknown; expectations?: Expectations; sort?: unknown; agentId?: string }): SavedPrompt {
    const p = this.requirePrompt(projectId, id);
    const prompt = input.prompt === undefined ? p.prompt : String(input.prompt).trim();
    if (!prompt) throw new HttpError(400, 'prompt is required');
    const name = input.name === undefined ? p.name : String(input.name).trim() || prompt.slice(0, 60);
    this.db
      .prepare('UPDATE chat_prompts SET name = ?, prompt = ?, expectations = ?, sort = ?, agent_id = ?, updated_at = ? WHERE id = ?')
      .run(name, prompt, input.expectations ?? p.expectations, input.sort === undefined ? p.sort : Number(input.sort) || 0, input.agentId ?? p.agentId, nowIso(), p.id);
    return this.requirePrompt(projectId, p.id);
  }

  setPromptResult(id: string, result: ExpectationResult): void {
    this.db.prepare('UPDATE chat_prompts SET last_result = ?, last_run_at = ? WHERE id = ?').run(result, nowIso(), id);
  }

  deletePrompt(projectId: string, id: string): boolean {
    const p = this.requirePrompt(projectId, id);
    return this.db.prepare('DELETE FROM chat_prompts WHERE id = ?').run(p.id).changes > 0;
  }
}
