/** Types and helpers of the AI personas API (/api/projects/:slug/personas/…, §AE). */
import { api, qs, type Channel } from './api';

export type ThreadState = 'active' | 'done' | 'limit' | 'error' | 'stopped';
export type GoalState = 'open' | 'reached' | 'failed';
export type TurnStatus = 'replied' | 'silent' | 'fallback' | 'error' | 'capped' | 'dry-run';

export interface PersonaGoal {
  id: string;
  text: string;
}

export interface PersonaStyle {
  language?: string;
  tone?: string;
  maxChars?: number;
}

export interface PersonaLimits {
  maxReplies: number;
  maxTokens: number;
  maxOutputTokens: number;
  maxHistory: number;
  dailyCalls: number;
  timeoutMs: number;
  temperature: number;
  endWhenDone: boolean;
}

export interface PersonaInput {
  name?: string;
  slug?: string;
  enabled?: boolean;
  provider?: string;
  model?: string;
  prompt?: string;
  goals?: (PersonaGoal | string)[];
  style?: PersonaStyle;
  limits?: Partial<PersonaLimits>;
  fallback?: string | null;
  opener?: string | null;
}

export interface PersonaAssignment {
  ruleId: string;
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  channel: Channel | 'any';
  user: { id: string; name: string } | null;
  role: string | null;
  run: string | null;
}

export interface Persona {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  provider: string;
  model: string;
  prompt: string;
  goals: PersonaGoal[];
  style: PersonaStyle;
  limits: PersonaLimits;
  fallback: string | null;
  opener: string | null;
  runId: string | null;
  run: string | null;
  mock: boolean;
  sendsContentTo: string | null;
  providerOk: boolean;
  providerError: string | null;
  assigned: PersonaAssignment[];
  threads: { total: number; active: number };
  today: { calls: number; tokensIn: number; tokensOut: number; projectCalls: number; dailyCalls: number };
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PersonaThread {
  id: string;
  personaId: string;
  persona: { id: string; slug: string; name: string } | null;
  testUserId: string;
  user: { id: string; name: string } | null;
  channel: Channel;
  run: string | null;
  state: ThreadState;
  stopReason: string | null;
  replies: number;
  tokensIn: number;
  tokensOut: number;
  tokens: number;
  errors: number;
  fallbackSent: boolean;
  goals: Record<string, GoalState>;
  goalList: (PersonaGoal & { state: GoalState })[];
  limits: { maxReplies: number; maxTokens: number } | null;
  notes: string;
  lastTurnAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaTurn {
  id: string;
  fireId: string | null;
  triggerMessageId: string | null;
  replyMessageId: string | null;
  status: TurnStatus;
  text: string;
  raw: string;
  controls: { goals: { id: string; is: string }[]; note?: string; button?: string; subject?: string; noReply: boolean; done: boolean } | null;
  warnings: string[];
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

export interface ThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  subject: string | null;
  text: string;
  status: string;
  createdAt: string;
  turnId: string | null;
  opener: boolean;
}

export interface ThreadDetail extends PersonaThread {
  turns: PersonaTurn[];
  messages: ThreadMessage[];
}

export interface PersonaTestResult {
  reply: string | null;
  controls: string[];
  warnings: string[];
  error: string | null;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  system: string;
  messages: { role: string; content?: unknown; parts?: { type: string; text?: string }[] }[];
}

export interface PersonaPreset {
  id: string;
  name: string;
  description: string;
  persona: PersonaInput;
}

export interface PersonaReference {
  presets: PersonaPreset[];
  limits: { defaults: PersonaLimits; max: Omit<PersonaLimits, 'endWhenDone'> };
  states: ThreadState[];
}

export const peBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/personas`;
const id = (s: string) => encodeURIComponent(s);

export const peApi = {
  list: (slug: string) => api.get<Persona[]>(peBase(slug)),
  create: (slug: string, b: PersonaInput) => api.post<Persona>(peBase(slug), b),
  update: (slug: string, pid: string, b: PersonaInput) => api.patch<Persona>(`${peBase(slug)}/${id(pid)}`, b),
  remove: (slug: string, pid: string) => api.del<{ deleted: boolean; rules: number }>(`${peBase(slug)}/${id(pid)}`),
  assign: (slug: string, pid: string, b: { user?: string; role?: string; channel?: string; delaySeconds?: number; jitterSeconds?: number; instruction?: string }) => api.post<unknown>(`${peBase(slug)}/${id(pid)}/assign`, b),
  start: (slug: string, pid: string, b: { user: string; channel: string; text?: string }) => api.post<{ thread: PersonaThread }>(`${peBase(slug)}/${id(pid)}/start`, b),
  test: (slug: string, pid: string, b: Record<string, unknown>) => api.post<PersonaTestResult>(`${peBase(slug)}/${id(pid)}/test`, b),
  threads: (slug: string, q: { persona?: string; state?: string; limit?: number } = {}) => api.get<PersonaThread[]>(`${peBase(slug)}/threads${qs(q)}`),
  thread: (slug: string, tid: string) => api.get<ThreadDetail>(`${peBase(slug)}/threads/${id(tid)}`),
  stopThread: (slug: string, tid: string) => api.post<PersonaThread>(`${peBase(slug)}/threads/${id(tid)}/stop`, {}),
  resetThread: (slug: string, tid: string) => api.post<PersonaThread>(`${peBase(slug)}/threads/${id(tid)}/reset`, {}),
  deleteThreads: (slug: string, persona?: string) => api.del<{ deleted: number }>(`${peBase(slug)}/threads${qs({ persona })}`),
};

export const STATE_KIND: Record<ThreadState, string> = { active: 'accent', done: 'ok', limit: 'warn', error: 'bad', stopped: '' };
export const GOAL_KIND: Record<GoalState, string> = { open: '', reached: 'ok', failed: 'bad' };
