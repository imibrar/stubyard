import type { Channel } from '../providers/catalog.js';

/** AI personas (§AE): a test user who answers the app's messages in character, written by an LLM. */

export type PersonaThreadState = 'active' | 'done' | 'limit' | 'error' | 'stopped';
export const THREAD_STATES: PersonaThreadState[] = ['active', 'done', 'limit', 'error', 'stopped'];
/** Thread states that end a conversation (the default of POST /threads/wait). */
export const ENDED_STATES: PersonaThreadState[] = ['done', 'limit', 'error', 'stopped'];

export type PersonaTurnStatus = 'replied' | 'silent' | 'fallback' | 'error' | 'capped' | 'dry-run';
export type GoalState = 'open' | 'reached' | 'failed';

export interface PersonaGoal {
  id: string;
  text: string;
}

export interface PersonaStyle {
  language?: string;
  tone?: string;
  /** Reply length cap in characters (default per channel: SMS 320, WhatsApp 1000, email 4000; hard 4000). */
  maxChars?: number;
}

export interface PersonaLimits {
  /** Replies per thread. */
  maxReplies: number;
  /** Tokens per thread, input + output. */
  maxTokens: number;
  /** Output tokens per reply. */
  maxOutputTokens: number;
  /** Messages of history sent to the model. */
  maxHistory: number;
  /** Model calls per project and UTC day (all personas of the project). */
  dailyCalls: number;
  timeoutMs: number;
  temperature: number;
  /** All goals closed → the thread is done and the persona stops answering. */
  endWhenDone: boolean;
}

export const LIMIT_DEFAULTS: PersonaLimits = { maxReplies: 10, maxTokens: 20_000, maxOutputTokens: 300, maxHistory: 20, dailyCalls: 200, timeoutMs: 30_000, temperature: 0.7, endWhenDone: true };
export const LIMIT_MAX: Omit<PersonaLimits, 'endWhenDone'> = { maxReplies: 50, maxTokens: 200_000, maxOutputTokens: 2000, maxHistory: 60, dailyCalls: 2000, timeoutMs: 60_000, temperature: 2 };

export interface Persona {
  id: string;
  projectId: string;
  runId: string | null;
  slug: string;
  name: string;
  enabled: boolean;
  provider: string;
  model: string;
  /** Who the user is and how they write. */
  prompt: string;
  goals: PersonaGoal[];
  style: PersonaStyle;
  limits: PersonaLimits;
  fallback: string | null;
  opener: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaThread {
  id: string;
  projectId: string;
  personaId: string;
  testUserId: string;
  channel: Channel;
  runId: string | null;
  state: PersonaThreadState;
  stopReason: string | null;
  replies: number;
  tokensIn: number;
  tokensOut: number;
  /** Model errors in a row (3 → state error). */
  errors: number;
  /** The fallback text was sent for a reached cap (sent once). */
  fallbackSent: boolean;
  goals: Record<string, GoalState>;
  /** The persona's own short memory (≤ 2 KB), rewritten with [[NOTE: …]]. */
  notes: string;
  lastTurnAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaControls {
  goals: { id: string; is: 'reached' | 'failed' }[];
  note?: string;
  button?: string;
  subject?: string;
  noReply: boolean;
  done: boolean;
}

export interface PersonaTurn {
  id: string;
  projectId: string;
  personaId: string;
  threadId: string | null;
  fireId: string | null;
  triggerMessageId: string | null;
  replyMessageId: string | null;
  status: PersonaTurnStatus;
  text: string;
  raw: string;
  controls: PersonaControls | null;
  warnings: string[];
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  finishReason: string | null;
  error: string | null;
  /** Counted against dailyCalls (a model call was made). */
  called: boolean;
  createdAt: string;
}
