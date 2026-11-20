import vm from 'node:vm';
import type { Message } from '../repos/messages.js';
import type { TestUser } from '../repos/users.js';
import { HttpError } from '../util.js';
import { AUTO_REPLY_CHANNELS, type AutoReplyChannel, type AutoReplyMatch, type AutoReplyRule, type TextCondition } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);

/** Regex guards: pattern length, how much text is matched, and how long one match may run. */
export const MAX_PATTERN = 500;
export const MAX_TEXT = 8 * 1024;
export const REGEX_TIMEOUT_MS = 100;
/** At most this many unbounded quantifiers (*, +, {n,}) in one pattern. */
export const MAX_UNBOUNDED = 4;
const TEXT_FIELDS = ['to', 'from', 'subject', 'body'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export const splitRegex = (src: string) => {
  const m = /^\/(.*)\/([dgimsuy]*)$/s.exec(src);
  return m ? { source: m[1], flags: m[2].replace('g', '') } : { source: src, flags: 'i' };
};

/** Compiles a stored pattern without the save-time checks (throws a plain Error when invalid). */
export function compileRegex(src: string): RegExp {
  const { source, flags } = splitRegex(src);
  return new RegExp(source, flags);
}

/**
 * Save-time check against catastrophic backtracking (no RE2 here): rejects backreferences, nested quantifiers such as
 * (a+)+ or (.*a){20}, alternation inside a repeated group such as (a|aa)+, and more than MAX_UNBOUNDED unbounded
 * quantifiers. Returns why the pattern is refused, or null. Polynomial cases that slip through are stopped by the
 * REGEX_TIMEOUT_MS limit at match time.
 */
export function regexSafetyProblem(source: string): string | null {
  type Frame = { unbounded: boolean; variable: boolean; alt: boolean };
  const frame = (): Frame => ({ unbounded: false, variable: false, alt: false });
  const stack: Frame[] = [frame()];
  const top = () => stack[stack.length - 1];
  // The atom a quantifier would apply to: for a group, what its content holds.
  let last: Frame | null = null;
  let unbounded = 0;
  const n = source.length;
  const skipBraces = (j: number) => (source[j] === '{' ? (source.indexOf('}', j) + 1 || n) : j);
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === '\\') {
      const d = source[i + 1] ?? '';
      if (/[1-9]/.test(d) || (d === 'k' && source[i + 2] === '<')) return 'backreferences (\\1, \\k<name>) are not allowed';
      i += 2;
      if (d === 'u' || d === 'p' || d === 'P') i = skipBraces(i);
      last = frame();
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      while (j < n && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
      i = j + 1;
      last = frame();
      continue;
    }
    if (c === '(') {
      let j = i + 1;
      if (source[j] === '?') {
        if (source[j + 1] === '<' && source[j + 2] !== '=' && source[j + 2] !== '!') j = source.indexOf('>', j) + 1 || n;
        else j += source[j + 1] === '<' ? 3 : 2;
      }
      stack.push(frame());
      last = null;
      i = j;
      continue;
    }
    if (c === ')') {
      const f = stack.length > 1 ? stack.pop()! : frame();
      const t = top();
      t.unbounded ||= f.unbounded;
      t.variable ||= f.variable;
      t.alt ||= f.alt;
      last = f;
      i++;
      continue;
    }
    if (c === '|') {
      top().alt = true;
      last = null;
      i++;
      continue;
    }
    let q: { min: number; max: number; len: number } | null = null;
    if (c === '*') q = { min: 0, max: Infinity, len: 1 };
    else if (c === '+') q = { min: 1, max: Infinity, len: 1 };
    else if (c === '?') q = { min: 0, max: 1, len: 1 };
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i, i + 24));
      if (m) q = { min: Number(m[1]), max: m[2] ? (m[3] ? Number(m[3]) : Infinity) : Number(m[1]), len: m[0].length };
    }
    if (q) {
      if (source[i + q.len] === '?') q.len++;
      if (last) {
        if (last.unbounded && q.max > 1) return 'nested quantifiers such as (a+)+, (\\w*)* or (.*x){9} are not allowed';
        if (last.variable && q.max > 10) return 'a repeated group whose length varies, such as (a?)+, (a?){30} or (\\d{1,3})*, is not allowed';
        if (last.alt && q.max > 10) return 'alternation inside a repeated group, such as (a|ab)+, is not allowed (use a character class such as [ab]+)';
        const t = top();
        if (q.max === Infinity) {
          t.unbounded = true;
          if (++unbounded > MAX_UNBOUNDED) return `at most ${MAX_UNBOUNDED} unbounded quantifiers (*, +, {n,}) are allowed`;
        }
        if (q.min !== q.max) t.variable = true;
      }
      last = null;
      i += q.len;
      continue;
    }
    last = c === '^' || c === '$' ? null : frame();
    i++;
  }
  return null;
}

/** "/src/flags" or a plain pattern (flag i), like chat/expectations.ts parseRegex. Throws a 400 naming the field. */
export function parseRegex(src: string, field = 'regex'): RegExp {
  if (src.length > MAX_PATTERN) throw new HttpError(400, `${field}: the pattern is longer than ${MAX_PATTERN} characters`);
  let re: RegExp;
  try {
    re = compileRegex(src);
  } catch (err) {
    throw new HttpError(400, `${field} is not a valid regular expression: ${(err as Error).message}`);
  }
  const problem = regexSafetyProblem(splitRegex(src).source);
  if (problem) throw new HttpError(400, `${field}: ${problem} (they can freeze stubyard on a crafted message)`);
  return re;
}

// One sandbox for every bounded match: vm's timeout interrupts a runaway regex (no worker, no dependency).
const sandbox = vm.createContext({});
const EXEC = new vm.Script('r.exec(t)');

/** re.exec(text), stopped after REGEX_TIMEOUT_MS: 'timeout' when it ran too long. */
export function execBounded(re: RegExp, text: string, timeoutMs = REGEX_TIMEOUT_MS): RegExpExecArray | null | 'timeout' {
  sandbox.r = re;
  sandbox.t = text;
  try {
    return EXEC.runInContext(sandbox, { timeout: timeoutMs }) as RegExpExecArray | null;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout';
    throw err;
  } finally {
    sandbox.r = undefined;
    sandbox.t = undefined;
  }
}

function textCondition(v: unknown, field: string): TextCondition | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') return { contains: v };
  if (!isObj(v)) throw new HttpError(400, `match.${field} must be a string or {equals|contains|regex}`);
  const out: TextCondition = {};
  for (const k of ['equals', 'contains', 'regex'] as const) if (v[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = String(v[k]);
  for (const k of Object.keys(v)) if (!['equals', 'contains', 'regex'].includes(k)) throw new HttpError(400, `match.${field}.${k} is not supported (use equals, contains or regex)`);
  if (out.regex !== undefined) parseRegex(out.regex, `match.${field}.regex`);
  return Object.keys(out).length ? out : undefined;
}

const KNOWN_MATCH = ['to', 'from', 'subject', 'body', 'user', 'role', 'instance', 'hasOtp', 'hasLink'];

/** Validates and normalises a match object from the API (400 on bad input). */
export function normalizeMatch(v: unknown): AutoReplyMatch {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new HttpError(400, 'match must be an object');
  for (const k of Object.keys(v)) if (!KNOWN_MATCH.includes(k)) throw new HttpError(400, `match.${k} is not a match field (${KNOWN_MATCH.join(', ')})`);
  const out: AutoReplyMatch = {};
  for (const f of TEXT_FIELDS) {
    const c = textCondition(v[f], f);
    if (c) out[f] = c;
  }
  for (const f of ['user', 'role', 'instance'] as const) if (v[f] !== undefined && v[f] !== null && String(v[f]).trim()) out[f] = String(v[f]).trim();
  for (const f of ['hasOtp', 'hasLink'] as const) {
    if (v[f] === undefined || v[f] === null || v[f] === '') continue;
    if (typeof v[f] !== 'boolean') throw new HttpError(400, `match.${f} must be true or false`);
    out[f] = v[f] as boolean;
  }
  return out;
}

export function normalizeChannel(v: unknown, field = 'channel'): AutoReplyChannel {
  const c = v === undefined || v === null || v === '' ? 'any' : String(v).toLowerCase();
  if (!AUTO_REPLY_CHANNELS.includes(c as AutoReplyChannel)) throw new HttpError(400, `${field} must be one of ${AUTO_REPLY_CHANNELS.join(', ')}`);
  return c as AutoReplyChannel;
}

/** The parts of an outbound message a rule looks at (a stored message or an inline test message). */
export interface MatchSubject {
  channel: Message['channel'];
  to: string;
  from: string | null;
  subject: string | null;
  body: string | null;
  otp: string | null;
  links: string[];
  instanceSlug: string | null;
  user: Pick<TestUser, 'id' | 'name' | 'email' | 'phone' | 'whatsapp' | 'role'> | null;
}

export interface MatchResult {
  matched: boolean;
  /** A regex ran longer than REGEX_TIMEOUT_MS and was stopped (counts as no match). */
  timedOut?: boolean;
  /** Why it did not match (empty when matched). */
  reasons: string[];
  /** Capture groups of the body / subject regex: body.1, body.<name>, subject.1 … */
  captures: Record<string, string>;
}

const clip = (s: string | null | undefined) => (s ?? '').slice(0, MAX_TEXT);

function testText(field: TextField, cond: TextCondition, value: string | null, captures: Record<string, string>, flags: { timedOut?: boolean }): string | null {
  const v = clip(value);
  const lower = v.toLowerCase();
  if (cond.equals !== undefined && lower.trim() !== cond.equals.toLowerCase().trim()) return `${field} is not "${cond.equals}"`;
  if (cond.contains !== undefined && !lower.includes(cond.contains.toLowerCase())) return `${field} does not contain "${cond.contains}"`;
  if (cond.regex !== undefined) {
    let re: RegExp;
    try {
      re = compileRegex(cond.regex);
    } catch {
      return `match.${field}.regex is not a valid regular expression`;
    }
    const unsafe = regexSafetyProblem(splitRegex(cond.regex).source);
    if (unsafe) return `match.${field}.regex is refused: ${unsafe}`;
    const m = execBounded(re, v);
    if (m === 'timeout') {
      flags.timedOut = true;
      return `match.${field}.regex took longer than ${REGEX_TIMEOUT_MS} ms on this message and was stopped`;
    }
    if (!m) return `${field} does not match ${cond.regex}`;
    if (field === 'body' || field === 'subject') {
      m.forEach((g, i) => {
        if (i > 0 && g !== undefined) captures[`${field}.${i}`] = g;
      });
      for (const [k, g] of Object.entries(m.groups ?? {})) if (g !== undefined) captures[`${field}.${k}`] = g;
    }
  }
  return null;
}

const userRefMatches = (ref: string, u: NonNullable<MatchSubject['user']>) => {
  const r = ref.trim().toLowerCase();
  const digits = (s: string | null) => (s ?? '').replace(/[^\d]/g, '');
  const rd = digits(r);
  return (
    u.id === ref.trim() ||
    u.name.toLowerCase() === r ||
    (u.email ?? '').toLowerCase() === r ||
    (!!rd && rd.length >= 6 && (digits(u.phone) === rd || digits(u.whatsapp) === rd))
  );
};

/** Does a rule's channel + match accept this message? Pure: no enabled / max-uses checks. */
export function matchRule(rule: Pick<AutoReplyRule, 'channel' | 'match'>, s: MatchSubject): MatchResult {
  const reasons: string[] = [];
  const captures: Record<string, string> = {};
  const flags: { timedOut?: boolean } = {};
  const m = rule.match;
  if (rule.channel !== 'any' && rule.channel !== s.channel) reasons.push(`channel is ${s.channel}, the rule listens on ${rule.channel}`);
  for (const f of TEXT_FIELDS) {
    const c = m[f];
    if (!c) continue;
    const why = testText(f, c, s[f], captures, flags);
    if (why) reasons.push(why);
  }
  if (m.user) {
    if (!s.user) reasons.push('the message has no test user');
    else if (!userRefMatches(m.user, s.user)) reasons.push(`the test user is ${s.user.name}, not "${m.user}"`);
  }
  if (m.role && (s.user?.role ?? '').toLowerCase() !== m.role.toLowerCase()) reasons.push(`the user's role is ${s.user?.role ?? '(none)'}, not "${m.role}"`);
  if (m.instance && (s.instanceSlug ?? '') !== m.instance) reasons.push(`sent through ${s.instanceSlug ?? '(no instance)'}, not "${m.instance}"`);
  if (m.hasOtp !== undefined && !!s.otp !== m.hasOtp) reasons.push(m.hasOtp ? 'no code (OTP) found in the message' : 'the message contains a code (OTP)');
  if (m.hasLink !== undefined && s.links.length > 0 !== m.hasLink) reasons.push(m.hasLink ? 'no link in the message' : 'the message contains a link');
  return { matched: reasons.length === 0, reasons, captures: reasons.length ? {} : captures, ...(flags.timedOut ? { timedOut: true } : {}) };
}

/** One-line summary of a match ("sms · body ~ code · has OTP"), for list_auto_replies and logs. */
export function matchSummary(rule: Pick<AutoReplyRule, 'channel' | 'match'>): string {
  const m = rule.match;
  const parts: string[] = [rule.channel === 'any' ? 'any channel' : rule.channel];
  for (const f of TEXT_FIELDS) {
    const c = m[f];
    if (!c) continue;
    if (c.equals !== undefined) parts.push(`${f} = "${c.equals}"`);
    if (c.contains !== undefined) parts.push(`${f} ~ "${c.contains}"`);
    if (c.regex !== undefined) parts.push(`${f} =~ ${c.regex}`);
  }
  if (m.user) parts.push(`user ${m.user}`);
  if (m.role) parts.push(`role ${m.role}`);
  if (m.instance) parts.push(`via ${m.instance}`);
  if (m.hasOtp !== undefined) parts.push(m.hasOtp ? 'has code' : 'no code');
  if (m.hasLink !== undefined) parts.push(m.hasLink ? 'has link' : 'no link');
  return parts.join(' · ');
}
