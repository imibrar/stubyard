/** Types and helpers of the LLM mocks API (/api/projects/:slug/llm/…, /llm/<project>/<provider>/…). */
import { api, qs } from './api';

export type LlmProvider = 'openai' | 'anthropic';
export type LlmEndpoint = 'chat' | 'responses' | 'messages' | 'embeddings' | 'count_tokens' | 'models';
export type LlmMockMode = 'first' | 'sequence' | 'cycle';
export type LlmCallMode = 'mock' | 'record' | 'fallback' | 'unmatched' | 'fault';
export type LlmStop = 'stop' | 'tool_calls' | 'length' | 'stop_sequence';

export const llmBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/llm`;

export interface LlmTextMatch {
  contains?: string;
  equals?: string;
  regex?: string;
}

export interface LlmMatch {
  endpoint?: LlmEndpoint;
  model?: string;
  lastUser?: LlmTextMatch;
  system?: { contains?: string };
  toolResult?: { name?: string; contains?: string };
  hasTool?: string;
  turn?: number;
  stream?: boolean;
}

export interface LlmToolCall {
  id?: string;
  name: string;
  arguments: unknown;
}

export interface LlmResponse {
  text?: string;
  toolCalls?: LlmToolCall[];
  stopReason?: LlmStop;
  usage?: { input?: number; output?: number };
  chunk?: { size?: number; delayMs?: number };
  raw?: { provider: string; endpoint: string; stream: boolean; status: number; contentType: string; body: string };
}

export interface LlmMock {
  id: string;
  runId: string | null;
  run: string | null;
  name: string;
  position: number;
  enabled: boolean;
  provider: LlmProvider | 'any';
  match: LlmMatch;
  responses: LlmResponse[];
  mode: LlmMockMode;
  fault: string | null;
  remaining: number | null;
  hits: number;
  source: 'manual' | 'recorded';
  recordingId: string | null;
  requestHash: string | null;
  kind: 'mock' | 'fault';
  createdAt: string;
  updatedAt: string;
}

export interface LlmCall {
  id: string;
  provider: string;
  endpoint: string;
  model: string | null;
  stream: boolean;
  mode: LlmCallMode;
  mock: { id: string; name: string } | null;
  fault: string | null;
  status: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  run: string | null;
  logId: string | null;
  lastUser: string;
  turn: number | null;
  reply: string;
  toolCalls: string[];
  createdAt: string;
  request?: unknown;
  response?: unknown;
}

export interface LlmRecording {
  id: string;
  runId: string | null;
  run: string | null;
  name: string;
  providerRef: string;
  kind: LlmProvider;
  mode: 'new' | 'all';
  status: 'active' | 'stopped';
  calls: number;
  /** Requests sent to the real provider; the recording stops at maxCalls. */
  forwarded: number;
  maxCalls: number;
  /** Requests still allowed while active (0 once stopped). */
  callsLeft: number;
  ttlMinutes: number | null;
  /** Auto-stop time (null only for recordings from before migration 19). */
  expiresAt: string | null;
  /** manual | max-calls | expired | run-stopped */
  stopReason: string | null;
  createdAt: string;
  stoppedAt: string | null;
}

export interface LlmSettings {
  fallback: 'error' | 'echo' | 'text';
  fallbackText: string;
  defaultChunk: { size: number; delayMs: number };
  models: string[];
}

export interface LlmOverview {
  mocks: number;
  faults: number;
  calls: number;
  recordings: LlmRecording[];
  settings: LlmSettings;
}

export interface LlmConnect {
  openai: { baseUrl: string; env: Record<string, string> };
  anthropic: { baseUrl: string; env: Record<string, string> };
  runPrefix: string;
  endpoints: string[];
  faults: { fault: string; does: string }[];
  recordings: LlmRecording[];
  snippets: { title: string; code: string }[];
}

export const FAULT_KINDS = ['rate_limit', 'error', 'overloaded', 'timeout', 'drop', 'malformed', 'cut', 'stream_error', 'slow', 'auth', 'context_length'] as const;
/** Faults that take a number after the colon, with its meaning and default. */
export const FAULT_ARG: Partial<Record<(typeof FAULT_KINDS)[number], { label: string; placeholder: string; required?: boolean }>> = {
  rate_limit: { label: 'retry after (s)', placeholder: '1' },
  error: { label: 'status', placeholder: '500' },
  cut: { label: 'after frames', placeholder: '3' },
  stream_error: { label: 'after frames', placeholder: '2' },
  slow: { label: 'delay (ms)', placeholder: '1500', required: true },
};

export const MODE_KIND: Record<LlmCallMode, string> = { mock: 'ok', record: 'accent', fallback: '', unmatched: 'bad', fault: 'warn' };

/** One-line summary of a match ("chat · gpt-* · user ~ hello · turn 0"). */
export function matchSummary(m: LlmMatch): string {
  const parts: string[] = [];
  if (m.endpoint) parts.push(m.endpoint);
  if (m.model) parts.push(m.model);
  if (m.lastUser?.equals !== undefined) parts.push(`user = "${m.lastUser.equals}"`);
  if (m.lastUser?.contains) parts.push(`user ~ "${m.lastUser.contains}"`);
  if (m.lastUser?.regex) parts.push(`user /${m.lastUser.regex.replace(/^\/|\/[a-z]*$/g, '')}/`);
  if (m.system?.contains) parts.push(`system ~ "${m.system.contains}"`);
  if (m.hasTool) parts.push(`tool ${m.hasTool}`);
  if (m.toolResult) parts.push(`after ${m.toolResult.name ?? 'any'} result${m.toolResult.contains ? ` ~ "${m.toolResult.contains}"` : ''}`);
  if (m.turn !== undefined) parts.push(`turn ${m.turn}`);
  if (m.stream !== undefined) parts.push(m.stream ? 'stream' : 'non-stream');
  return parts.join(' · ') || 'any request';
}

/** One-line summary of a scripted reply. */
export function responseSummary(r: LlmResponse | undefined): string {
  if (!r) return '';
  const tools = (r.toolCalls ?? []).map((t) => `${t.name}()`).join(', ');
  const text = (r.text ?? '').replace(/\s+/g, ' ').trim();
  return [tools && `→ ${tools}`, text && `"${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`].filter(Boolean).join(' ') || (r.raw ? '(raw recorded reply)' : '(empty)');
}

export const llmApi = {
  createMock: (slug: string, body: Partial<LlmMock> & { times?: number | null }) => api.post<LlmMock>(`${llmBase(slug)}/mocks`, body),
  updateMock: (slug: string, id: string, body: Partial<LlmMock> & { times?: number | null }) => api.patch<LlmMock>(`${llmBase(slug)}/mocks/${id}`, body),
  deleteMock: (slug: string, id: string) => api.del<void>(`${llmBase(slug)}/mocks/${id}`),
  deleteMocks: (slug: string, source?: 'recorded' | 'manual') => api.del<{ deleted: number }>(`${llmBase(slug)}/mocks${qs({ source })}`),
  reorder: (slug: string, ids: string[]) => api.post<LlmMock[]>(`${llmBase(slug)}/mocks/reorder`, { ids }),
  addFault: (slug: string, body: { fault: string; times?: number | null; provider?: string; match?: LlmMatch }) => api.post<LlmMock>(`${llmBase(slug)}/faults`, body),
  clearFaults: (slug: string) => api.del<{ deleted: number }>(`${llmBase(slug)}/faults`),
  call: (slug: string, id: string) => api.get<LlmCall>(`${llmBase(slug)}/calls/${id}`),
  clearCalls: (slug: string) => api.del<{ deleted: number }>(`${llmBase(slug)}/calls`),
  startRecording: (slug: string, body: { provider: string; mode?: 'new' | 'all'; name?: string; run?: string; maxCalls?: number; ttlMinutes?: number }) => api.post<LlmRecording>(`${llmBase(slug)}/recordings`, body),
  stopRecording: (slug: string, id: string) => api.post<LlmRecording>(`${llmBase(slug)}/recordings/${id}/stop`),
  saveSettings: (slug: string, body: Partial<LlmSettings>) => api.patch<LlmSettings>(`${llmBase(slug)}/settings`, body),
};
