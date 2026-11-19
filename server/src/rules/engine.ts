import type { Channel } from '../providers/catalog.js';
import type { ProviderInstance } from '../repos/providers.js';
import { RULE_ACTIONS, type Rule, type RuleAction, type RuleInput, type RuleRepo } from '../repos/rules.js';
import type { TestUser } from '../repos/users.js';

export type RuleLevel = 'header' | 'instance' | 'opt_out' | 'user' | 'default';

/** What to do with one message, and why. */
export interface Decision {
  /** Effective action (a fail_rate rule resolves to "fail" or "deliver"). */
  action: RuleAction;
  errorCode: string | null;
  errorMessage: string | null;
  delayMs: number | null;
  level: RuleLevel;
  rule: { id: string | null; position: number | null; action: RuleAction; label: string } | null;
}

export interface EvaluateInput {
  projectId: string;
  channel: Channel;
  instance: ProviderInstance | null;
  user: TestUser | null;
  /** X-Hub-Scenario header, e.g. "fail:30003:Number unreachable", "delay:5000", "reject". */
  header?: string | null;
  /** Test run the message belongs to: its rules come before the project's; other runs' rules are never read. */
  runId?: string | null;
}

/**
 * Picks the rule for a message. First match wins:
 * 1. X-Hub-Scenario header  2. instance rules of the run  3. instance rules of the project  4. marketing opt-out
 * 5. user rules of the run (instance-specific first)  6. user rules of the project  7. the instance's default action.
 */
export class RuleEngine {
  constructor(
    private rules: RuleRepo,
    private random: () => number = Math.random,
  ) {}

  evaluate(i: EvaluateInput): Decision {
    const { decision, commit } = this.peek(i);
    commit();
    return decision;
  }

  /**
   * Like evaluate(), but rule counters ("next N", "after N") are only updated when `commit` is called.
   * SMTP uses this: the decision is made at RCPT TO, but an accepted email only counts once DATA is accepted,
   * so an abandoned transaction does not burn a "fail next 1" rule.
   */
  peek(i: EvaluateInput): { decision: Decision; commit: () => void } {
    const ops: (() => void)[] = [];
    const decision = this.decide(i, ops);
    let committed = false;
    return {
      decision,
      commit: () => {
        if (committed) return;
        committed = true;
        for (const op of ops) op();
      },
    };
  }

  private decide(i: EvaluateInput, ops: (() => void)[]): Decision {
    const h = i.header ? parseScenarioHeader(i.header) : null;
    if (h) return { ...h, level: 'header', rule: { id: null, position: null, action: h.action, label: `X-Hub-Scenario: ${i.header}` } };

    const runId = i.runId ?? null;
    if (i.instance) {
      const owner = { scope: 'instance' as const, providerInstanceId: i.instance.id };
      const d =
        (runId ? this.firstMatch(this.rules.list(i.projectId, owner, runId), i.channel, 'instance', ops) : null) ??
        this.firstMatch(this.rules.list(i.projectId, owner), i.channel, 'instance', ops);
      if (d) return d;
      if (i.user?.marketingOptOut && i.instance.labels.includes('marketing')) {
        return {
          action: 'reject',
          errorCode: null,
          errorMessage: `${i.user.name} opted out of marketing messages (DND)`,
          delayMs: null,
          level: 'opt_out',
          rule: { id: null, position: null, action: 'reject', label: 'Marketing opt-out (DND) on a marketing instance' },
        };
      }
    }

    if (i.user) {
      for (const scope of runId ? [runId, null] : [null]) {
        const all = this.rules.list(i.projectId, { scope: 'user', testUserId: i.user.id }, scope);
        const specific = i.instance ? all.filter((r) => r.providerInstanceId === i.instance!.id) : [];
        const general = all.filter((r) => !r.providerInstanceId);
        const d = this.firstMatch(specific, i.channel, 'user', ops) ?? this.firstMatch(general, i.channel, 'user', ops);
        if (d) return d;
      }
    }

    const def = (i.instance?.defaultAction ?? 'deliver') as RuleAction;
    return { action: RULE_ACTIONS.includes(def) ? def : 'deliver', errorCode: null, errorMessage: null, delayMs: null, level: 'default', rule: null };
  }

  private firstMatch(list: Rule[], channel: Channel, level: RuleLevel, ops: (() => void)[]): Decision | null {
    for (const r of list) {
      if (!r.active) continue;
      if (r.channel !== 'all' && r.channel !== channel) continue;
      if (r.skipCount > 0) {
        ops.push(() => this.rules.skip(r.id));
        continue;
      }
      ops.push(() => this.rules.consume(r.id));
      let action = r.action;
      if (action === 'fail_rate') action = this.random() * 100 < (r.failRate ?? 0) ? 'fail' : 'deliver';
      return {
        action,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        delayMs: r.delayMs,
        level,
        rule: { id: r.id, position: r.position, action: r.action, label: describeRule(r) },
      };
    }
    return null;
  }
}

/** "fail:30003:Number unreachable" → fail with code and message; "delay:5000"; "fail_rate:30". */
export function parseScenarioHeader(v: string): Omit<Decision, 'level' | 'rule'> | null {
  const [rawAction, a1, ...rest] = v.split(':');
  const action = rawAction.trim().toLowerCase().replace(/-/g, '_') as RuleAction;
  if (!RULE_ACTIONS.includes(action)) return null;
  const numeric = a1 !== undefined && /^\d+(\.\d+)?$/.test(a1.trim());
  if (action === 'delay' || action === 'slow') return { action, errorCode: null, errorMessage: null, delayMs: numeric ? Number(a1) : 3000 };
  if (action === 'fail_rate') {
    const rate = numeric ? Number(a1) : 50;
    return { action: Math.random() * 100 < rate ? 'fail' : 'deliver', errorCode: null, errorMessage: null, delayMs: null };
  }
  return { action, errorCode: a1?.trim() || null, errorMessage: rest.join(':').trim() || null, delayMs: null };
}

const ACTION_TEXT: Record<RuleAction, string> = {
  deliver: 'Deliver',
  fail: 'Fail',
  reject: 'Reject',
  rate_limit: 'Rate limit (429)',
  delay: 'Delay',
  timeout: 'Time out',
  drop: 'Drop silently',
  blocked: 'Blocked',
  fail_rate: 'Random failures',
  down: 'Provider down (503)',
  slow: 'Slow responses',
  bounce_hard: 'Hard bounce (550)',
  bounce_soft: 'Soft bounce (450)',
  defer: 'Defer (421)',
  complaint: 'Spam complaint',
  bounce_delayed: 'Bounce later (DSN)',
};

export function describeRule(r: Pick<Rule, 'action' | 'errorCode' | 'errorMessage' | 'delayMs' | 'failRate' | 'label' | 'position'>): string {
  if (r.label) return r.label;
  let s = ACTION_TEXT[r.action] ?? r.action;
  if (r.action === 'fail_rate' && r.failRate) s = `${r.failRate}% random failures`;
  if ((r.action === 'delay' || r.action === 'slow') && r.delayMs) s += ` ${r.delayMs >= 1000 ? `${r.delayMs / 1000}s` : `${r.delayMs}ms`}`;
  if (r.errorCode || r.errorMessage) s += ` (${[r.errorCode, r.errorMessage].filter(Boolean).join(' ')})`;
  return `#${r.position} ${s}`;
}

// ---------- presets ----------

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  scope: 'user' | 'instance';
  /** Rules to add; channel "*" means "the channel you pick when applying". */
  rules: (Omit<RuleInput, 'channel'> & { channel?: RuleInput['channel'] | '*' })[];
}

export const RULE_PRESETS: RulePreset[] = [
  { id: 'unreachable', scope: 'user', name: 'Unreachable', description: 'Every message fails with "unreachable".', rules: [{ channel: '*', action: 'fail' }] },
  { id: 'retry-once', scope: 'user', name: 'Fail once, then OK', description: 'The next message fails; the retry is delivered.', rules: [{ channel: '*', action: 'fail', count: 1 }] },
  {
    id: 'first-ok-then-fail',
    scope: 'user',
    name: 'First OK, then fail',
    description: 'The first message is delivered, every later one fails.',
    rules: [{ channel: '*', action: 'fail', after: 1 }],
  },
  { id: 'flaky', scope: 'user', name: 'Flaky network', description: '30% of messages fail at random.', rules: [{ channel: '*', action: 'fail_rate', failRate: 30 }] },
  { id: 'slow', scope: 'user', name: 'Slow delivery', description: 'Messages arrive 8 seconds late.', rules: [{ channel: '*', action: 'delay', delayMs: 8000 }] },
  { id: 'blocked', scope: 'user', name: 'Blocked user', description: 'The user cannot receive anything on this channel.', rules: [{ channel: '*', action: 'blocked' }] },
  { id: 'rate-limited', scope: 'user', name: 'Rate limited ×3', description: 'The next 3 sends get 429 Too Many Requests.', rules: [{ channel: '*', action: 'rate_limit', count: 3 }] },
  { id: 'hard-bounce', scope: 'user', name: 'Email hard bounce', description: 'Emails are rejected with 550 (mailbox does not exist).', rules: [{ channel: 'email', action: 'bounce_hard' }] },
  { id: 'bounce-later', scope: 'user', name: 'Email bounces later', description: 'Emails are accepted, then a bounce (DSN) arrives 10 seconds later.', rules: [{ channel: 'email', action: 'bounce_delayed', delayMs: 10_000 }] },

  { id: 'down-10m', scope: 'instance', name: 'Down for 10 minutes', description: 'Every send gets 503 for 10 minutes (test your fallback).', rules: [{ action: 'down', minutes: 10 }] },
  { id: 'slow-5s', scope: 'instance', name: 'Slow (5 s)', description: 'Every API call takes 5 seconds to answer.', rules: [{ action: 'slow', delayMs: 5000 }] },
  { id: 'timeouts', scope: 'instance', name: 'Timeouts', description: 'Calls never get an answer (client timeout).', rules: [{ action: 'timeout' }] },
  { id: 'half-fail', scope: 'instance', name: '50% failures', description: 'Half of all messages fail at random.', rules: [{ action: 'fail_rate', failRate: 50 }] },
  { id: 'rate-limit', scope: 'instance', name: 'Rate limited', description: 'Every send gets 429 for 5 minutes.', rules: [{ action: 'rate_limit', minutes: 5 }] },
];
