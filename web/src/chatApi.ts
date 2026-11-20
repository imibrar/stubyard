/** Types and helpers of the AI chat API (/api/system/ai-providers, /api/projects/:slug/chat/…). */

export const chatBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/chat`;
export const AIP = '/api/system/ai-providers';

export type AiKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible';

export interface AiProvider {
  id: string;
  name: string;
  kind: AiKind;
  preset: 'openrouter' | 'ollama' | 'custom' | null;
  baseUrl: string | null;
  effectiveBaseUrl: string;
  enabled: boolean;
  /** Virtual provider built from environment variables (read-only). */
  env: boolean;
  /** Built-in keyless provider answered by the project's LLM mocks (mock:openai / mock:anthropic, read-only). */
  mock?: boolean;
  label?: string;
  hasKey: boolean;
  source: 'env' | 'stored' | 'mock' | null;
  envVar: string | null;
  /** "••••1234"; the key itself is never returned. */
  keyHint: string | null;
  needsKey: boolean;
  headerNames: string[];
  headers: Record<string, string>;
}

export interface AiPreset {
  id: string;
  label: string;
  kind: AiKind;
  preset: string | null;
  baseUrl: string;
  envVar: string | null;
  needsKey: boolean;
  modelHint: string;
}

export interface AgentTools {
  builtin: boolean | string[];
  targets: { target: string; tools: '*' | string[] }[];
}

export interface ChatAgent {
  id: string;
  slug: string;
  name: string;
  provider: string;
  model: string;
  instructions: string;
  tools: AgentTools;
  maxSteps: number;
  maxOutputTokens: number | null;
  temperature: number | null;
  createdAt: string;
  updatedAt: string;
  providerOk: boolean;
  providerError: string | null;
  prompts: number;
}

export interface ToolInfo {
  name: string;
  source: 'stubyard' | 'target';
  tool: string;
  description: string;
  target?: string;
  targetId?: string;
  sessionId?: string;
  inputSchema?: unknown;
}

export interface AgentRef {
  id: string;
  slug: string;
  name: string;
}

export interface Conversation {
  id: string;
  agentId: string | null;
  title: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  updatedAt: string;
  messages?: number;
  agent: AgentRef | null;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  parts: Record<string, unknown>[];
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

export type ConversationFull = Omit<Conversation, 'messages'> & { messages: StoredMessage[] };

export interface Expectations {
  contains?: string[];
  notContains?: string[];
  matches?: string;
  toolCalled?: string[];
  toolNotCalled?: string[];
  maxSteps?: number;
  maxTokens?: number;
  finishReason?: string;
}

export interface ExpectationCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface ExpectationResult {
  passed: boolean;
  checks: ExpectationCheck[];
  ranAt?: string;
  text?: string;
  error?: string | null;
  steps?: number;
  usage?: { inputTokens: number; outputTokens: number };
  durationMs?: number;
  toolCalls?: { name: string; input?: unknown; output?: unknown }[];
  finishReason?: string;
}

export interface SavedPrompt {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  expectations: Expectations;
  lastResult: ExpectationResult | null;
  lastRunAt: string | null;
  sort: number;
}

export interface PromptRun extends ExpectationResult {
  id: string;
  name: string;
}

export const fmtTokens = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());

export function expectationsSummary(e: Expectations): string[] {
  const out: string[] = [];
  for (const s of e.contains ?? []) out.push(`contains “${s}”`);
  for (const s of e.notContains ?? []) out.push(`not “${s}”`);
  if (e.matches) out.push(`matches ${e.matches}`);
  for (const s of e.toolCalled ?? []) out.push(`calls ${s}`);
  for (const s of e.toolNotCalled ?? []) out.push(`never ${s}`);
  if (e.maxSteps) out.push(`≤ ${e.maxSteps} steps`);
  if (e.maxTokens) out.push(`≤ ${e.maxTokens} tokens`);
  if (e.finishReason) out.push(`finish ${e.finishReason}`);
  return out;
}

/** "builtin: all" / "3 stubyard tools" etc. */
export function toolsSummary(t: AgentTools): string {
  const b = t.builtin === true ? 'all stubyard tools' : t.builtin === false || !t.builtin.length ? '' : `${t.builtin.length} stubyard tool${t.builtin.length === 1 ? '' : 's'}`;
  const tg = t.targets.map((x) => (x.tools === '*' ? x.target : `${x.target} (${x.tools.length})`));
  return [b, ...tg].filter(Boolean).join(' · ') || 'no tools';
}

// ---------------------------------------------------------------- model matrix, save tool call, explain (§AC)

export interface MatrixModel {
  provider: string;
  model: string;
}

export type MatrixTools = 'none' | 'builtin' | 'agent';

export interface MatrixColumn {
  provider: string;
  model: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  text: string;
  toolCalls: { name: string; input: unknown; output: unknown; error: string | null }[];
  steps: number;
  usage: { input: number; output: number };
  finishReason: string | null;
  durationMs: number | null;
  error: string | null;
  expectations?: { passed: boolean; checks: ExpectationCheck[] };
  toolErrors?: { target: string; error: string }[];
}

export interface MatrixRun {
  id: string;
  agentId: string | null;
  promptId: string | null;
  name: string;
  prompt: string;
  config: { models: MatrixModel[]; system?: string; tools: MatrixTools; temperature?: number | null; maxOutputTokens?: number | null; maxSteps?: number; expectations?: Expectations };
  status: 'running' | 'done' | 'cancelled';
  columns: MatrixColumn[];
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  finishedAt: string | null;
  agent: AgentRef | null;
}

export type ExplainKind = 'traffic' | 'message' | 'llm-call' | 'mcp-call' | 'payment' | 'fire';

/** Message the Explain button hands to the conversation it opens (sent on the normal stream endpoint). */
export const pendingKey = (convId: string) => `stubyard.chat.pending.${convId}`;

/** Parse "contains: a, b" style lines of the matrix expectations box (one rule per line). */
export function parseExpectationLines(src: string): Expectations {
  const e: Expectations = {};
  const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    const k = (i < 0 ? 'contains' : line.slice(0, i)).trim().toLowerCase();
    const v = (i < 0 ? line : line.slice(i + 1)).trim();
    if (k === 'contains') e.contains = [...(e.contains ?? []), ...list(v)];
    else if (k === 'not' || k === 'notcontains' || k === 'not contains') e.notContains = [...(e.notContains ?? []), ...list(v)];
    else if (k === 'matches' || k === 'regex') e.matches = v;
    else if (k === 'calls' || k === 'toolcalled') e.toolCalled = [...(e.toolCalled ?? []), ...list(v)];
    else if (k === 'never' || k === 'toolnotcalled') e.toolNotCalled = [...(e.toolNotCalled ?? []), ...list(v)];
    else if (k === 'maxsteps' || k === 'steps') e.maxSteps = Number(v) || undefined;
    else if (k === 'maxtokens' || k === 'tokens') e.maxTokens = Number(v) || undefined;
    else if (k === 'finish' || k === 'finishreason') e.finishReason = v;
  }
  return e;
}
