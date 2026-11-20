import { HttpError } from '../util.js';

/**
 * Deterministic checks for saved prompts (no LLM judge). Text checks are case-insensitive. Tool names match
 * exactly or by the part after "__" (so "add" matches "calc__add" and "stubyard__list_test_users").
 */

export interface Expectations {
  contains?: string[];
  notContains?: string[];
  /** Regular expression ("/re/flags" or a plain pattern, case-insensitive). */
  matches?: string;
  toolCalled?: string[];
  toolNotCalled?: string[];
  /** At most this many steps (model calls). */
  maxSteps?: number;
  /** At most this many tokens in total (input + output). */
  maxTokens?: number;
  /** e.g. "stop", "length", "tool-calls". */
  finishReason?: string;
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface RunObservation {
  text: string;
  toolCalls: { name: string; input?: unknown; output?: unknown }[];
  steps: number;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
  durationMs: number;
  error?: string | null;
}

export interface ExpectationResult extends RunObservation {
  passed: boolean;
  checks: CheckResult[];
  ranAt: string;
}

const list = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) throw new HttpError(400, `expectations.${name} must be a list of strings`);
  const out = v.map((x) => String(x)).filter((x) => x !== '');
  return out.length ? out : undefined;
};

const posInt = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `expectations.${name} must be a positive number`);
  return Math.round(n);
};

export function parseRegex(src: string): RegExp {
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(src);
  try {
    return m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(src, 'i');
  } catch (err) {
    throw new HttpError(400, `expectations.matches is not a valid regular expression: ${(err as Error).message}`);
  }
}

/** Validates and normalises an expectations object from the API. */
export function normalizeExpectations(v: unknown): Expectations {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'expectations must be an object');
  const e = v as Record<string, unknown>;
  const out: Expectations = {};
  const c = list(e.contains, 'contains');
  if (c) out.contains = c;
  const nc = list(e.notContains, 'notContains');
  if (nc) out.notContains = nc;
  if (e.matches !== undefined && e.matches !== null && e.matches !== '') {
    out.matches = String(e.matches);
    parseRegex(out.matches);
  }
  const tc = list(e.toolCalled, 'toolCalled');
  if (tc) out.toolCalled = tc;
  const tnc = list(e.toolNotCalled, 'toolNotCalled');
  if (tnc) out.toolNotCalled = tnc;
  const ms = posInt(e.maxSteps, 'maxSteps');
  if (ms !== undefined) out.maxSteps = ms;
  const mt = posInt(e.maxTokens, 'maxTokens');
  if (mt !== undefined) out.maxTokens = mt;
  if (e.finishReason !== undefined && e.finishReason !== null && e.finishReason !== '') out.finishReason = String(e.finishReason);
  return out;
}

export const toolMatches = (called: string, wanted: string): boolean => called === wanted || called.split('__').slice(1).join('__') === wanted;

/** Evaluate expectations against one run. A run that failed (error) never passes. */
export function evaluateExpectations(e: Expectations, o: RunObservation): { passed: boolean; checks: CheckResult[] } {
  const checks: CheckResult[] = [];
  const text = o.text ?? '';
  const lower = text.toLowerCase();
  const called = o.toolCalls.map((t) => t.name);
  if (o.error) checks.push({ id: 'error', ok: false, detail: o.error });
  for (const s of e.contains ?? []) checks.push({ id: `contains:${s}`, ok: lower.includes(s.toLowerCase()), detail: lower.includes(s.toLowerCase()) ? `reply contains "${s}"` : `reply does not contain "${s}"` });
  for (const s of e.notContains ?? []) {
    const hit = lower.includes(s.toLowerCase());
    checks.push({ id: `notContains:${s}`, ok: !hit, detail: hit ? `reply contains "${s}"` : `reply does not contain "${s}"` });
  }
  if (e.matches) {
    const ok = parseRegex(e.matches).test(text);
    checks.push({ id: 'matches', ok, detail: ok ? `reply matches ${e.matches}` : `reply does not match ${e.matches}` });
  }
  for (const t of e.toolCalled ?? []) {
    const ok = called.some((c) => toolMatches(c, t));
    checks.push({ id: `toolCalled:${t}`, ok, detail: ok ? `${t} was called` : `${t} was not called (called: ${called.join(', ') || 'none'})` });
  }
  for (const t of e.toolNotCalled ?? []) {
    const ok = !called.some((c) => toolMatches(c, t));
    checks.push({ id: `toolNotCalled:${t}`, ok, detail: ok ? `${t} was not called` : `${t} was called` });
  }
  if (e.maxSteps !== undefined) checks.push({ id: 'maxSteps', ok: o.steps <= e.maxSteps, detail: `${o.steps} step(s), limit ${e.maxSteps}` });
  if (e.maxTokens !== undefined) {
    const total = o.usage.inputTokens + o.usage.outputTokens;
    checks.push({ id: 'maxTokens', ok: total <= e.maxTokens, detail: `${total} token(s), limit ${e.maxTokens}` });
  }
  if (e.finishReason) checks.push({ id: 'finishReason', ok: o.finishReason === e.finishReason, detail: `finish reason "${o.finishReason}", expected "${e.finishReason}"` });
  return { passed: checks.every((c) => c.ok), checks };
}
