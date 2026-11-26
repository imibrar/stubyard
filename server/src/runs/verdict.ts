import type { Hub } from '../hub.js';
import type { LintFinding, LintSeverity } from '../lint/checks.js';
import { formatMoney, fromDecimal } from '../payments/engine.js';
import type { Run } from '../repos/runs.js';
import type { TestUser } from '../repos/users.js';
import { normalizeEmail, normalizePhone, parseJson } from '../util.js';
import { DEFAULT_CHECK_NAMES, defaultOn, type DefaultCheckName, type Expectation, type ExpectationCount, type ExpectationDoc, type HttpStatusSelector } from './expectations.js';

/**
 * The run verdict (A2): declared expectations plus the default "nothing unexpected" checks, evaluated over the run's
 * own data (`WHERE run_id = ?` on messages, traffic_logs, payments and schedules) into one pass / fail / pending answer.
 */

export type ItemStatus = 'pass' | 'fail' | 'warn' | 'pending';
export interface Evidence {
  type: 'message' | 'log' | 'payment' | 'schedule';
  id: string;
  summary: string;
  url: string;
}
export interface VerdictItem {
  /** "e1".."eN" for declared items, "default:<name>" for the default checks. */
  id: string;
  name: string;
  kind: string;
  source: 'declared' | 'default';
  status: ItemStatus;
  expected: string;
  actual: number;
  message: string;
  /** At most MAX_EVIDENCE entries; `more` holds the rest of the count. */
  evidence: Evidence[];
  more?: number;
}
export interface RunVerdict {
  run: { id: string; key: string; status: string; startedAt: string; stoppedAt: string | null };
  /** A stopped run is only pass or fail. */
  verdict: 'pass' | 'fail' | 'pending';
  summary: string;
  counts: { pass: number; fail: number; warn: number; pending: number };
  items: VerdictItem[];
  evaluatedAt: string;
  frozen: boolean;
  notes: string[];
}

/** Rows loaded per source (one more is read to detect the cap). */
export const SOURCE_CAP = 5000;
export const MAX_EVIDENCE = 20;
/** RunService.verdict / stop: the longest settle wait. */
export const SETTLE_MAX_MS = 60_000;

const FAILED_STATUSES = ['failed', 'rejected', 'bounced', 'timeout'];
/** Message statuses that, named by a declared item, mark the matched messages as expected failures. */
const FAILURE_MESSAGE_STATUSES = [...FAILED_STATUSES, 'undelivered', 'dropped'];
const PROVIDER_PROBLEMS = ['unmatched', 'invalid', 'rejected', 'internal_error'];
const CALLBACK_PROBLEMS = ['rejected', 'network_error'];
const LINT_RANK: Record<LintSeverity, number> = { info: 1, warn: 2, error: 3 };

const DEFAULT_LABELS: Record<DefaultCheckName, { name: string; kind: string }> = {
  providerCalls: { name: 'No failed calls from the app to stubyard', kind: 'provider_call' },
  appCallbacks: { name: 'No failed callbacks to the app', kind: 'webhook' },
  lintErrors: { name: 'No lint errors', kind: 'lint' },
  duplicateMessages: { name: 'No duplicate messages', kind: 'message' },
  unassignedMessages: { name: 'No messages without a test user', kind: 'message' },
  failedMessages: { name: 'No unexpected failed messages', kind: 'message' },
  pendingWork: { name: 'No queued work left', kind: 'schedule' },
};

interface MsgRow {
  id: string;
  channel: string;
  direction: string;
  to: string;
  testUserId: string | null;
  subject: string | null;
  text: string | null;
  status: string;
  appliedRule: boolean;
  otp: string | null;
  duplicateOfId: string | null;
  logId: string | null;
  template: string | null;
  lint: LintFinding[];
  lintLevel: string | null;
  createdAt: string;
}
interface LogRow {
  id: string;
  direction: string;
  protocol: string;
  method: string | null;
  url: string | null;
  resStatus: number | null;
  outcome: string;
  errorType: string | null;
  resolved: Record<string, unknown>;
  receivedAt: string;
}
interface PayRow {
  id: string;
  gateway: string;
  testUserId: string | null;
  status: string;
  amount: number;
  currency: string;
  reference: string | null;
  customerEmail: string | null;
  lint: LintFinding[];
  lintLevel: string | null;
  createdAt: string;
}
interface SchedRow {
  id: string;
  label: string;
  method: string;
  path: string;
  status: string;
  nextAt: string | null;
  createdAt: string;
}

type Entry = { t: 'message'; m: MsgRow } | { t: 'log'; l: LogRow } | { t: 'payment'; p: PayRow } | { t: 'schedule'; s: SchedRow };

interface RunData {
  messages: MsgRow[];
  logs: LogRow[];
  payments: PayRow[];
  schedules: SchedRow[];
}

interface Ctx {
  hub: Hub;
  run: Run;
  slug: string;
  data: RunData;
  users: Map<string, TestUser | null>;
}

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Pending run work: run schedules still pending and run messages still scheduled (what settle waits for). */
export function pendingWorkCount(hub: Hub, runId: string): number {
  const s = hub.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE run_id = ? AND status = 'pending'").get(runId) as { n: number };
  const m = hub.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND status = 'scheduled'").get(runId) as { n: number };
  return s.n + m.n;
}

/** Whether the run still has captured messages or traffic (false once it was purged). */
export function runHasData(hub: Hub, runId: string): boolean {
  return !!(hub.db.prepare('SELECT 1 FROM messages WHERE run_id = ? LIMIT 1').get(runId) ?? hub.db.prepare('SELECT 1 FROM traffic_logs WHERE run_id = ? LIMIT 1').get(runId));
}

function loadRunData(hub: Hub, runId: string, notes: string[]): RunData {
  const capped = <T>(rows: T[], what: string): T[] => {
    if (rows.length <= SOURCE_CAP) return rows;
    notes.push(`Only the first ${SOURCE_CAP} ${what} of the run were checked`);
    return rows.slice(0, SOURCE_CAP);
  };
  const lim = SOURCE_CAP + 1;
  type J = Record<string, unknown>;
  const messages = capped(
    (
      hub.db
        .prepare(
          `SELECT id, channel, direction, to_addr, test_user_id, subject, body_text, status, applied_rule, otp, duplicate_of_id, log_id, metadata, lint, lint_level, created_at
           FROM messages WHERE run_id = ? ORDER BY created_at, id LIMIT ?`,
        )
        .all(runId, lim) as J[]
    ).map(
      (r): MsgRow => ({
        id: String(r.id),
        channel: String(r.channel),
        direction: String(r.direction),
        to: String(r.to_addr ?? ''),
        testUserId: (r.test_user_id as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        text: (r.body_text as string | null) ?? null,
        status: String(r.status),
        appliedRule: r.applied_rule !== null && r.applied_rule !== undefined && r.applied_rule !== 'null',
        otp: (r.otp as string | null) ?? null,
        duplicateOfId: (r.duplicate_of_id as string | null) ?? null,
        logId: (r.log_id as string | null) ?? null,
        template: r.channel === 'whatsapp' ? templateName(parseJson<J>(r.metadata as string, {})) : null,
        lint: parseJson<LintFinding[]>(r.lint as string, []),
        lintLevel: (r.lint_level as string | null) ?? null,
        createdAt: String(r.created_at),
      }),
    ),
    'messages',
  );
  const logs = capped(
    (
      hub.db
        .prepare(`SELECT id, direction, protocol, method, url, res_status, outcome, error_type, resolved, received_at FROM traffic_logs WHERE run_id = ? ORDER BY received_at, id LIMIT ?`)
        .all(runId, lim) as J[]
    ).map(
      (r): LogRow => ({
        id: String(r.id),
        direction: String(r.direction),
        protocol: String(r.protocol),
        method: (r.method as string | null) ?? null,
        url: (r.url as string | null) ?? null,
        resStatus: typeof r.res_status === 'number' ? r.res_status : null,
        outcome: String(r.outcome),
        errorType: (r.error_type as string | null) ?? null,
        resolved: parseJson<J>(r.resolved as string, {}),
        receivedAt: String(r.received_at),
      }),
    ),
    'traffic log entries',
  );
  const payments = capped(
    (
      hub.db
        .prepare(
          `SELECT p.id, i.slug AS gateway, p.test_user_id, p.status, p.amount, p.currency, p.reference, p.customer_email, p.lint, p.lint_level, p.created_at
           FROM payments p LEFT JOIN payment_instances i ON i.id = p.instance_id WHERE p.run_id = ? ORDER BY p.created_at, p.id LIMIT ?`,
        )
        .all(runId, lim) as J[]
    ).map(
      (r): PayRow => ({
        id: String(r.id),
        gateway: String(r.gateway ?? ''),
        testUserId: (r.test_user_id as string | null) ?? null,
        status: String(r.status),
        amount: Number(r.amount),
        currency: String(r.currency ?? ''),
        reference: (r.reference as string | null) ?? null,
        customerEmail: (r.customer_email as string | null) ?? null,
        lint: parseJson<LintFinding[]>(r.lint as string, []),
        lintLevel: (r.lint_level as string | null) ?? null,
        createdAt: String(r.created_at),
      }),
    ),
    'payments',
  );
  const schedules = capped(
    (hub.db.prepare('SELECT id, label, method, path, status, next_at, created_at FROM schedules WHERE run_id = ? ORDER BY created_at, id LIMIT ?').all(runId, lim) as J[]).map(
      (r): SchedRow => ({
        id: String(r.id),
        label: String(r.label ?? ''),
        method: String(r.method),
        path: String(r.path),
        status: String(r.status),
        nextAt: (r.next_at as string | null) ?? null,
        createdAt: String(r.created_at),
      }),
    ),
    'schedules',
  );
  return { messages, logs, payments, schedules };
}

function templateName(meta: Record<string, unknown>): string | null {
  const name = ((meta.wa as { template?: { name?: unknown } } | undefined)?.template)?.name;
  return typeof name === 'string' ? name : null;
}

// ---------------- entries ----------------

const keyOf = (e: Entry) => `${e.t}:${e.t === 'message' ? e.m.id : e.t === 'log' ? e.l.id : e.t === 'payment' ? e.p.id : e.s.id}`;
const atOf = (e: Entry) => (e.t === 'message' ? e.m.createdAt : e.t === 'log' ? e.l.receivedAt : e.t === 'payment' ? e.p.createdAt : e.s.createdAt);

const CHANNEL_LABEL: Record<string, string> = { email: 'email', sms: 'SMS', whatsapp: 'WhatsApp' };

function evidenceOf(ctx: Ctx, e: Entry): Evidence {
  const p = `/api/projects/${ctx.slug}`;
  switch (e.t) {
    case 'message': {
      const m = e.m;
      const what = m.subject ? ` · "${clip(m.subject, 60)}"` : m.text ? ` · "${clip(m.text.replace(/\s+/g, ' ').trim(), 60)}"` : '';
      return { type: 'message', id: m.id, summary: `${CHANNEL_LABEL[m.channel] ?? m.channel} ${m.direction === 'inbound' ? 'from' : 'to'} ${m.to} · ${m.status}${what}`, url: `/api/messages/${m.id}` };
    }
    case 'log': {
      const l = e.l;
      const res = l.resStatus ?? l.errorType ?? 'no response';
      return { type: 'log', id: l.id, summary: clip(`${l.direction} ${l.method ?? l.protocol.toUpperCase()} ${l.url ?? ''} → ${res} (${l.outcome})`, 200), url: `/api/logs/${l.id}` };
    }
    case 'payment': {
      const x = e.p;
      return { type: 'payment', id: x.id, summary: `${x.gateway} ${formatMoney(x.amount, x.currency)} · ${x.status}${x.reference ? ` · ${x.reference}` : ''}`, url: `${p}/payments/${x.id}` };
    }
    case 'schedule': {
      const s = e.s;
      return { type: 'schedule', id: s.id, summary: `${s.label || `${s.method} ${s.path}`} · ${s.status}${s.nextAt ? ` (due ${s.nextAt})` : ''}`, url: `${p}/schedules/${s.id}` };
    }
  }
}

function withEvidence(ctx: Ctx, entries: Entry[]): Pick<VerdictItem, 'evidence' | 'more'> {
  const evidence = entries.slice(0, MAX_EVIDENCE).map((e) => evidenceOf(ctx, e));
  return entries.length > MAX_EVIDENCE ? { evidence, more: entries.length - MAX_EVIDENCE } : { evidence };
}

/** The request path without a /run/<key> prefix. */
const pathOf = (url: string | null) => {
  let p = url ?? '';
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* keep it */
  }
  return p.replace(/^\/run\/[^/]+(?=\/)/, '');
};
const isHookPath = (url: string | null) => pathOf(url).startsWith('/hook/');

// ---------------- matching ----------------

function user(ctx: Ctx, ref: string): TestUser | null {
  if (!ctx.users.has(ref)) ctx.users.set(ref, ctx.hub.users.resolve(ctx.run.projectId, ref, ctx.run.id));
  return ctx.users.get(ref) ?? null;
}

const normAddr = (v: string | null | undefined) => (v ? (v.includes('@') ? normalizeEmail(v) : normalizePhone(v)) : null);

function recipientMatches(ctx: Ctx, ref: string, m: MsgRow): boolean {
  const u = user(ctx, ref);
  const to = normAddr(m.to);
  if (u) return m.testUserId === u.id || (!!to && [normalizeEmail(u.email), normalizePhone(u.phone), normalizePhone(u.whatsapp)].includes(to));
  return !!to && to === normAddr(ref);
}

function statusMatches(sel: HttpStatusSelector, s: number | null): boolean {
  return list(sel).some((v) => (v === 'error' ? s === null : typeof v === 'number' ? s === v : s !== null && Math.floor(s / 100) === Number(v[0])));
}

const eqi = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function webhookSource(l: LogRow): string {
  const r = l.resolved;
  const purpose = typeof r.purpose === 'string' ? r.purpose : '';
  if (r.kind === 'payment-webhook') return 'payment';
  if (r.sequenceId || r.sequence) return 'sequence';
  if (r.templateId) return 'template';
  if (purpose.startsWith('status callback') || purpose.startsWith('template ')) return 'status_callback';
  if (purpose.startsWith('email event')) return 'email_event';
  if (purpose.startsWith('inbound ')) return 'inbound';
  if (purpose.startsWith('verify callback')) return 'verify';
  return 'other';
}

function instanceOf(l: LogRow): string | null {
  if (typeof l.resolved.instance === 'string') return l.resolved.instance;
  const seg = pathOf(l.url).split('?')[0].split('/');
  // /mock|/pay|/storage|/push|/auth/<project>/<instance>/…, /llm/<project>/<provider>/…
  return seg[3] ?? null;
}

type Sel = Record<string, unknown>;
type Kind = Expectation['kind'];

function lintFindings(e: Entry): LintFinding[] {
  return e.t === 'message' ? e.m.lint : e.t === 'payment' ? e.p.lint : [];
}

/** Whether an entry meets a selector; `main` applies the selector defaults (messages: outbound). */
function matches(ctx: Ctx, kind: Kind, s: Sel, e: Entry, main: boolean): boolean {
  switch (kind) {
    case 'message': {
      if (e.t !== 'message') return false;
      const m = e.m;
      const dir = (s.direction as string | undefined) ?? (main ? 'outbound' : undefined);
      if (s.channel !== undefined && m.channel !== s.channel) return false;
      if (dir !== undefined && m.direction !== dir) return false;
      if (s.to !== undefined && !recipientMatches(ctx, String(s.to), m)) return false;
      if (s.unassigned === true && m.testUserId) return false;
      if (s.otp === true && !m.otp) return false;
      if (s.otp === false && m.otp) return false;
      if (typeof s.otp === 'string' && m.otp !== s.otp) return false;
      if (s.contains !== undefined) {
        const hay = `${m.subject ?? ''}\n${m.text ?? ''}`.toLowerCase();
        if (!list(s.contains as string | string[]).every((c) => hay.includes(c.toLowerCase()))) return false;
      }
      if (s.subject !== undefined && !(m.subject ?? '').toLowerCase().includes(String(s.subject).toLowerCase())) return false;
      if (s.template !== undefined && !eqi(m.template, String(s.template))) return false;
      if (s.status !== undefined && !list(s.status as string | string[]).includes(m.status)) return false;
      if (s.rule !== undefined && m.appliedRule !== s.rule) return false;
      return true;
    }
    case 'payment': {
      if (e.t !== 'payment') return false;
      const p = e.p;
      if (s.gateway !== undefined && !eqi(p.gateway, String(s.gateway))) return false;
      if (s.status !== undefined && !list(s.status as string | string[]).includes(p.status)) return false;
      if (s.currency !== undefined && !eqi(p.currency, String(s.currency))) return false;
      if (s.amount !== undefined) {
        const want = fromDecimal(s.amount, p.currency);
        if (!want.ok || want.minor !== p.amount) return false;
      }
      if (s.reference !== undefined && p.reference !== s.reference) return false;
      if (s.user !== undefined) {
        const ref = String(s.user);
        const u = user(ctx, ref);
        const email = normalizeEmail(p.customerEmail);
        if (u ? !(p.testUserId === u.id || (!!email && email === normalizeEmail(u.email))) : !(email && email === normalizeEmail(ref))) return false;
      }
      return true;
    }
    case 'webhook': {
      if (e.t !== 'log' || e.l.direction !== 'outbound') return false;
      const l = e.l;
      if (s.url !== undefined && !(l.url ?? '').includes(String(s.url))) return false;
      if (s.source !== undefined && s.source !== 'any' && webhookSource(l) !== s.source) return false;
      if (s.event !== undefined) {
        const r = l.resolved;
        if (![r.event, r.template, r.sequence, r.status].some((v) => eqi(v, String(s.event)))) return false;
      }
      if (s.status !== undefined && !statusMatches(s.status as HttpStatusSelector, l.resStatus)) return false;
      return true;
    }
    case 'provider_call': {
      if (e.t !== 'log' || e.l.direction !== 'inbound' || isHookPath(e.l.url)) return false;
      const l = e.l;
      if (s.instance !== undefined && !eqi(instanceOf(l), String(s.instance))) return false;
      if (s.method !== undefined && !eqi(l.method, String(s.method))) return false;
      if (s.path !== undefined && !(l.url ?? '').includes(String(s.path))) return false;
      if (s.status !== undefined && !statusMatches(s.status as HttpStatusSelector, l.resStatus)) return false;
      if (s.outcome !== undefined && !list(s.outcome as string | string[]).includes(l.outcome)) return false;
      return true;
    }
    case 'traffic': {
      if (e.t !== 'log') return false;
      const l = e.l;
      if (s.direction !== undefined && l.direction !== s.direction) return false;
      if (s.protocol !== undefined && !eqi(l.protocol, String(s.protocol))) return false;
      if (s.outcome !== undefined && !list(s.outcome as string | string[]).includes(l.outcome)) return false;
      if (s.status !== undefined && !statusMatches(s.status as HttpStatusSelector, l.resStatus)) return false;
      if (s.url !== undefined && !(l.url ?? '').includes(String(s.url))) return false;
      return true;
    }
    case 'lint': {
      if (e.t !== 'message' && e.t !== 'payment') return false;
      const source = (s.source as string | undefined) ?? 'all';
      if (source === 'messages' && e.t !== 'message') return false;
      if (source === 'payments' && e.t !== 'payment') return false;
      const min = LINT_RANK[(s.severity as LintSeverity | undefined) ?? 'error'];
      return lintFindings(e).some((f) => (LINT_RANK[f.severity] ?? 0) >= min && (s.check === undefined || f.check === s.check));
    }
  }
}

function candidates(ctx: Ctx, kind: Kind): Entry[] {
  const d = ctx.data;
  switch (kind) {
    case 'message':
      return d.messages.map((m) => ({ t: 'message', m }));
    case 'payment':
      return d.payments.map((p) => ({ t: 'payment', p }));
    case 'webhook':
    case 'provider_call':
    case 'traffic':
      return d.logs.map((l) => ({ t: 'log', l }));
    case 'lint':
      return [...d.messages.map((m): Entry => ({ t: 'message', m })), ...d.payments.map((p): Entry => ({ t: 'payment', p }))];
  }
}

/** The selector fields of an item (lint items keep `severity`: there it is the minimum lint level). */
function selectorOf(e: Expectation): Sel {
  const { kind: _k, name: _n, count: _c, since: _s, each: _e, ...rest }: Sel = e;
  if (e.kind !== 'lint') delete rest.severity;
  return rest;
}

const failureStatus = (v: HttpStatusSelector | undefined) => list(v).some((x) => x === 'error' || x === '4xx' || x === '5xx' || (typeof x === 'number' && x >= 400));

/** Whether a declared item expects failures: the entries it matches are then not counted by the default checks. */
function namesFailure(e: Expectation): boolean {
  switch (e.kind) {
    case 'message':
      return list(e.status).some((s) => typeof s === 'string' && FAILURE_MESSAGE_STATUSES.includes(s));
    case 'webhook':
      return failureStatus(e.status);
    case 'provider_call':
    case 'traffic':
      return failureStatus(e.status) || list(e.outcome).some((o) => o !== 'ok' && o !== 'pending');
    case 'lint': {
      const r = range(e.count);
      return r.max === undefined || r.max > 0;
    }
    case 'payment':
      return false;
  }
}

// ---------------- counts and wording ----------------

function range(c: ExpectationCount | undefined): { min?: number; max?: number } {
  if (c === undefined) return { min: 1 };
  if (typeof c === 'number') return { min: c, max: c };
  return { min: c.min, max: c.max };
}

function expectedText(c: ExpectationCount | undefined): string {
  const { min, max } = range(c);
  if (max === 0) return 'none';
  if (min !== undefined && min === max) return `exactly ${min}`;
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  if (max !== undefined) return `at most ${max}`;
  return `at least ${min ?? 0}`;
}

const NOUNS: Record<string, [string, string]> = {
  email: ['email', 'emails'],
  sms: ['SMS', 'SMS'],
  whatsapp: ['WhatsApp message', 'WhatsApp messages'],
};

/** "SMS to Customer 1 (w3) with an OTP" (`label` resolves user refs to names for the message). */
function describe(ctx: Ctx, e: Expectation, n: number, label: boolean): string {
  const who = (ref: string) => (label ? (user(ctx, ref)?.name ?? ref) : ref);
  const parts: string[] = [];
  const statuses = (v: unknown) => list(v as string | string[] | number).join('/');
  switch (e.kind) {
    case 'message': {
      const [one, many] = (e.channel && NOUNS[e.channel]) || ['message', 'messages'];
      parts.push(`${e.direction === 'inbound' ? 'inbound ' : ''}${plural(n, one, many)}`);
      if (e.to) parts.push(`to ${who(e.to)}`);
      if (e.unassigned) parts.push('with no test user');
      if (e.otp === true) parts.push('with an OTP');
      if (e.otp === false) parts.push('without an OTP');
      if (typeof e.otp === 'string') parts.push(`with OTP ${e.otp}`);
      if (e.contains) parts.push(`containing ${list(e.contains).map((c) => `"${clip(c, 40)}"`).join(' and ')}`);
      if (e.subject) parts.push(`with a subject containing "${clip(e.subject, 40)}"`);
      if (e.template) parts.push(`using template ${e.template}`);
      if (e.status) parts.push(`(${statuses(e.status)})`);
      if (e.rule !== undefined) parts.push(e.rule ? 'caused by a rule' : 'not caused by a rule');
      break;
    }
    case 'payment':
      parts.push(plural(n, 'payment'));
      if (e.gateway) parts.push(`on ${e.gateway}`);
      if (e.amount !== undefined) parts.push(`of ${e.amount}${e.currency ? ` ${e.currency.toUpperCase()}` : ''}`);
      else if (e.currency) parts.push(`in ${e.currency.toUpperCase()}`);
      if (e.user) parts.push(`by ${who(e.user)}`);
      if (e.reference) parts.push(`for ${e.reference}`);
      if (e.status) parts.push(`(${statuses(e.status)})`);
      break;
    case 'webhook':
      parts.push(e.source && e.source !== 'any' ? `${e.source.replace('_', ' ')} ${plural(n, 'callback')}` : plural(n, 'callback'));
      parts.push('to the app');
      if (e.event) parts.push(`for ${e.event}`);
      if (e.url) parts.push(`at ${e.url}`);
      if (e.status !== undefined) parts.push(`answered ${statuses(e.status)}`);
      break;
    case 'provider_call':
      parts.push(plural(n, 'call'), 'to stubyard');
      if (e.instance) parts.push(`on ${e.instance}`);
      if (e.method || e.path) parts.push(`${e.method ? e.method.toUpperCase() : ''}${e.method && e.path ? ' ' : ''}${e.path ?? ''}`);
      if (e.status !== undefined) parts.push(`answered ${statuses(e.status)}`);
      if (e.outcome) parts.push(`(${statuses(e.outcome)})`);
      break;
    case 'traffic':
      parts.push(`${e.direction ? `${e.direction} ` : ''}${e.protocol ? `${e.protocol.toUpperCase()} ` : ''}${plural(n, 'request')}`);
      if (e.url) parts.push(`to ${e.url}`);
      if (e.status !== undefined) parts.push(`answered ${statuses(e.status)}`);
      if (e.outcome) parts.push(`(${statuses(e.outcome)})`);
      break;
    case 'lint': {
      const src = e.source === 'messages' ? ['message', 'messages'] : e.source === 'payments' ? ['payment', 'payments'] : ['item', 'items'];
      parts.push(`${plural(n, src[0], src[1])} with ${e.severity ?? 'error'}-level lint findings${e.check ? ` (${e.check})` : ''}`);
      break;
    }
  }
  return parts.filter(Boolean).join(' ');
}

// ---------------- evaluation ----------------

function evalDeclared(ctx: Ctx, e: Expectation, index: number, exempt: Set<string>, mayPend: boolean): VerdictItem {
  const sel = selectorOf(e);
  const since = e.since ? Date.parse(e.since) : null;
  const matched = candidates(ctx, e.kind).filter((x) => (since === null || Date.parse(atOf(x)) >= since) && matches(ctx, e.kind, sel, x, true));
  if (namesFailure(e)) for (const x of matched) exempt.add(keyOf(x));
  const bad = e.each ? matched.filter((x) => !matches(ctx, e.kind, e.each as Sel, x, false)) : [];
  const { min, max } = range(e.count);
  const actual = matched.length;
  const countOk = (min === undefined || actual >= min) && (max === undefined || actual <= max);
  const expected = expectedText(e.count);
  const severity: ItemStatus = e.kind !== 'lint' && e.severity === 'warn' ? 'warn' : 'fail';
  let status: ItemStatus = countOk && !bad.length ? 'pass' : severity;
  // Too few (or not all as required yet) while the run still has queued work: wait for it.
  if (status !== 'pass' && mayPend && (max === undefined || actual <= max) && ((min !== undefined && actual < min) || bad.length)) status = 'pending';
  let message = `${actual} ${describe(ctx, e, actual, true)} (expected ${expected})`;
  if (bad.length) message += `; ${bad.length} of them ${bad.length === 1 ? 'does' : 'do'} not meet "each"`;
  if (status === 'pending') message += '; waiting for queued work';
  return {
    id: `e${index + 1}`,
    name: e.name ?? `${expected} ${describe(ctx, e, min === 1 && max === 1 ? 1 : 2, false)}`,
    kind: e.kind,
    source: 'declared',
    status,
    expected,
    actual,
    message,
    ...withEvidence(ctx, bad.length ? bad : matched),
  };
}

function defaultItem(ctx: Ctx, name: DefaultCheckName, status: ItemStatus, entries: Entry[], message: string): VerdictItem {
  const label = DEFAULT_LABELS[name];
  return { id: `default:${name}`, name: label.name, kind: label.kind, source: 'default', status, expected: 'none', actual: entries.length, message, ...withEvidence(ctx, entries) };
}

function evalDefault(ctx: Ctx, name: DefaultCheckName, exempt: Set<string>, active: boolean, stopping: boolean): VerdictItem {
  const d = ctx.data;
  const free = (e: Entry) => !exempt.has(keyOf(e));
  const msgs = d.messages.map((m): Entry => ({ t: 'message', m }));
  const logs = d.logs.map((l): Entry => ({ t: 'log', l }));
  const result = (entries: Entry[], none: string, some: (n: number) => string) => defaultItem(ctx, name, entries.length ? 'fail' : 'pass', entries, entries.length ? some(entries.length) : none);
  switch (name) {
    case 'providerCalls': {
      // A request a rule refused on purpose (its message has an applied rule) is not unexpected either.
      const ruled = new Set(d.messages.filter((m) => m.appliedRule && m.logId).map((m) => m.logId));
      const bad = logs.filter((e) => e.t === 'log' && e.l.direction === 'inbound' && PROVIDER_PROBLEMS.includes(e.l.outcome) && !ruled.has(e.l.id) && free(e));
      return result(bad, 'No failed calls from the app to stubyard', (n) => `${n} ${plural(n, 'call')} from the app to stubyard failed (${[...new Set(bad.map((e) => (e as { l: LogRow }).l.outcome))].join(', ')})`);
    }
    case 'appCallbacks': {
      const out = d.logs.filter((l) => l.direction === 'outbound');
      const last = new Map<string, LogRow>();
      for (const l of out) {
        const id = l.resolved.eventId;
        if (typeof id === 'string' && id) last.set(id, l); // rows are in time order: the last one wins
      }
      const failed = out.filter((l) => CALLBACK_PROBLEMS.includes(l.outcome)).map((l): Entry => ({ t: 'log', l })).filter(free);
      const fixed = (e: Entry) => {
        const id = (e as { l: LogRow }).l.resolved.eventId;
        return typeof id === 'string' && !!id && last.get(id)?.outcome === 'ok';
      };
      const hard = failed.filter((e) => !fixed(e));
      const soft = failed.filter(fixed);
      if (hard.length) return defaultItem(ctx, name, 'fail', [...hard, ...soft], `${hard.length} ${plural(hard.length, 'callback')} to the app failed (rejected or not delivered)${soft.length ? `; ${soft.length} more succeeded on a retry` : ''}`);
      if (soft.length) return defaultItem(ctx, name, 'warn', soft, `${soft.length} ${plural(soft.length, 'callback')} to the app failed, then succeeded on a retry`);
      return defaultItem(ctx, name, 'pass', [], 'No failed callbacks to the app');
    }
    case 'lintErrors': {
      const bad = [...msgs.filter((e) => e.t === 'message' && e.m.lintLevel === 'error'), ...d.payments.filter((p) => p.lintLevel === 'error').map((p): Entry => ({ t: 'payment', p }))].filter(free);
      return result(bad, 'No lint errors', (n) => `${n} ${plural(n, 'message or payment', 'messages or payments')} with lint errors`);
    }
    case 'duplicateMessages': {
      const groups = new Map<string, MsgRow[]>();
      for (const m of d.messages) {
        if (m.direction !== 'outbound') continue;
        const k = JSON.stringify([m.channel, normAddr(m.to) ?? m.to, m.subject ?? '', m.text ?? '']);
        groups.set(k, [...(groups.get(k) ?? []), m]);
      }
      const ids = new Set<string>();
      for (const g of groups.values()) if (g.length > 1) for (const m of g) ids.add(m.id);
      const inRun = new Set(d.messages.map((m) => m.id));
      for (const m of d.messages) {
        if (!m.duplicateOfId) continue;
        ids.add(m.id);
        if (inRun.has(m.duplicateOfId)) ids.add(m.duplicateOfId);
      }
      const bad = msgs.filter((e) => e.t === 'message' && ids.has(e.m.id) && free(e));
      return result(bad, 'No duplicate messages', (n) => `${n} duplicate ${plural(n, 'message')} (same channel, recipient, subject and text, or flagged as a duplicate)`);
    }
    case 'unassignedMessages': {
      const bad = msgs.filter((e) => e.t === 'message' && !e.m.testUserId && free(e));
      return result(bad, 'Every message reached a test user', (n) => `${n} ${plural(n, 'message')} reached no test user`);
    }
    case 'failedMessages': {
      const bad = msgs.filter((e) => e.t === 'message' && FAILED_STATUSES.includes(e.m.status) && !e.m.appliedRule && free(e));
      return result(bad, 'No unexpected failed messages', (n) => `${n} ${plural(n, 'message')} failed, bounced, timed out or were rejected without a rule causing it`);
    }
    case 'pendingWork': {
      const work = [
        ...d.schedules.filter((s) => s.status === 'pending').map((s): Entry => ({ t: 'schedule', s })),
        ...msgs.filter((e) => e.t === 'message' && e.m.status === 'scheduled'),
      ];
      const n = work.length;
      if (!n) return defaultItem(ctx, name, 'pass', [], 'No queued work left');
      const what = `${n} queued ${plural(n, 'delivery', 'deliveries')}`;
      if (active) return defaultItem(ctx, name, 'pending', work, `${what} still pending`);
      return defaultItem(ctx, name, 'warn', work, stopping ? `cancelled at stop: ${what}` : `${what} left when the run stopped`);
    }
  }
}

/** Evaluate a run's expectations (declared items, then the default checks that are on) over its own data. */
export function evaluateRun(hub: Hub, run: Run, doc: ExpectationDoc, opts: { stopping?: boolean } = {}): RunVerdict {
  const stopping = !!opts.stopping;
  const notes: string[] = [];
  const ctx: Ctx = { hub, run, slug: hub.projects.get(run.projectId)?.slug ?? '', data: loadRunData(hub, run.id, notes), users: new Map() };
  const active = run.status === 'active' && !stopping;
  const queued = ctx.data.schedules.some((s) => s.status === 'pending') || ctx.data.messages.some((m) => m.status === 'scheduled');
  const exempt = new Set<string>();
  const items = doc.items.map((e, i) => evalDeclared(ctx, e, i, exempt, active && queued));
  for (const name of DEFAULT_CHECK_NAMES) if (defaultOn(doc, name)) items.push(evalDefault(ctx, name, exempt, active, stopping));
  if (!active) for (const it of items) if (it.status === 'pending') it.status = 'warn';

  const counts = { pass: 0, fail: 0, warn: 0, pending: 0 };
  for (const it of items) counts[it.status]++;
  const verdict: RunVerdict['verdict'] = counts.fail ? 'fail' : counts.pending ? 'pending' : 'pass';
  const n = items.length;
  const first = (s: ItemStatus) =>
    items
      .filter((i) => i.status === s)
      .slice(0, 3)
      .map((i) => i.message)
      .join('; ');
  const summary =
    verdict === 'fail'
      ? `${counts.fail} of ${n} ${plural(n, 'check')} failed: ${first('fail')}${counts.fail > 3 ? '; …' : ''}`
      : verdict === 'pending'
        ? `${counts.pending} of ${n} ${plural(n, 'check')} pending: ${first('pending')}`
        : !n
          ? 'No checks: no expectations were declared and the default checks are off'
          : counts.warn
            ? `${counts.pass} of ${n} ${plural(n, 'check')} passed, ${counts.warn} with a warning: ${first('warn')}`
            : `All ${n} ${plural(n, 'check')} passed`;
  return {
    run: { id: run.id, key: run.key, status: run.status, startedAt: run.startedAt, stoppedAt: run.stoppedAt },
    verdict,
    summary,
    counts,
    items,
    evaluatedAt: new Date().toISOString(),
    frozen: stopping,
    notes,
  };
}
