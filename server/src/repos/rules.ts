import type { DB } from '../db/index.js';
import { HttpError, newId, nowIso } from '../util.js';

export const RULE_ACTIONS = [
  'deliver',
  'fail',
  'reject',
  'rate_limit',
  'delay',
  'timeout',
  'drop',
  'blocked',
  'fail_rate',
  // instance-level
  'down',
  'slow',
  // email only
  'bounce_hard',
  'bounce_soft',
  'defer',
  'complaint',
  'bounce_delayed',
] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export type RuleChannel = 'all' | 'email' | 'sms' | 'whatsapp';
export type RuleScope = 'user' | 'instance';

export interface Rule {
  id: string;
  projectId: string;
  scope: RuleScope;
  testUserId: string | null;
  providerInstanceId: string | null;
  channel: RuleChannel;
  position: number;
  action: RuleAction;
  errorCode: string | null;
  errorMessage: string | null;
  delayMs: number | null;
  failRate: number | null;
  /** null = unlimited ("always"). */
  remainingCount: number | null;
  /** Let this many messages pass (unmatched) before the rule starts applying. */
  skipCount: number;
  expiresAt: string | null;
  label: string | null;
  hits: number;
  enabled: boolean;
  createdAt: string;
  /** Computed: enabled, not expired, count not used up. */
  active: boolean;
}

interface Row {
  id: string;
  project_id: string;
  scope: RuleScope;
  test_user_id: string | null;
  provider_instance_id: string | null;
  channel: RuleChannel;
  position: number;
  action: RuleAction;
  error_code: string | null;
  error_message: string | null;
  delay_ms: number | null;
  fail_rate: number | null;
  remaining_count: number | null;
  skip_count: number;
  expires_at: string | null;
  label: string | null;
  hits: number;
  enabled: number;
  created_at: string;
}

function toRule(r: Row): Rule {
  const expired = !!r.expires_at && r.expires_at <= nowIso();
  return {
    id: r.id,
    projectId: r.project_id,
    scope: r.scope,
    testUserId: r.test_user_id,
    providerInstanceId: r.provider_instance_id,
    channel: r.channel,
    position: r.position,
    action: r.action,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    delayMs: r.delay_ms,
    failRate: r.fail_rate,
    remainingCount: r.remaining_count,
    skipCount: r.skip_count,
    expiresAt: r.expires_at,
    label: r.label,
    hits: r.hits,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    active: r.enabled === 1 && !expired && (r.remaining_count === null || r.remaining_count > 0),
  };
}

export interface RuleInput {
  channel?: RuleChannel;
  action: string;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  delayMs?: number | null;
  failRate?: number | null;
  /** Applies to the next N messages, then switches off. Omit for "always". */
  count?: number | null;
  /** Applies for X minutes from now. */
  minutes?: number | null;
  /** Applies until this time (ISO). */
  until?: string | null;
  /** Starts applying after N messages went through normally. */
  after?: number | null;
  /** User rules only: limit to one provider instance (id). */
  providerInstanceId?: string | null;
  label?: string | null;
  enabled?: boolean;
}

export interface RuleOwner {
  scope: RuleScope;
  testUserId?: string | null;
  providerInstanceId?: string | null;
}

const EMAIL_ONLY: RuleAction[] = ['bounce_hard', 'bounce_soft', 'defer', 'complaint', 'bounce_delayed'];

export class RuleRepo {
  constructor(private db: DB) {}

  list(projectId: string, owner: RuleOwner): Rule[] {
    const [col, val] = ownerKey(owner);
    return (
      this.db
        .prepare(`SELECT * FROM rules WHERE project_id = ? AND scope = ? AND ${col} = ? ORDER BY position, created_at`)
        .all(projectId, owner.scope, val) as Row[]
    ).map(toRule);
  }

  /** All user rules of a project, keyed by user id (for overview badges). */
  activeUserRuleCounts(projectId: string): Map<string, number> {
    const rows = this.db.prepare("SELECT * FROM rules WHERE project_id = ? AND scope = 'user'").all(projectId) as Row[];
    const out = new Map<string, number>();
    for (const r of rows.map(toRule)) if (r.active && r.testUserId) out.set(r.testUserId, (out.get(r.testUserId) ?? 0) + 1);
    return out;
  }

  get(id: string): Rule | null {
    const r = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as Row | undefined;
    return r ? toRule(r) : null;
  }

  add(projectId: string, owner: RuleOwner, input: RuleInput): Rule {
    const v = validate(input, owner.scope);
    const [col, val] = ownerKey(owner);
    const pos = (this.db.prepare(`SELECT COALESCE(MAX(position), 0) AS m FROM rules WHERE project_id = ? AND scope = ? AND ${col} = ?`).get(projectId, owner.scope, val) as { m: number }).m + 1;
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO rules (id, project_id, scope, test_user_id, provider_instance_id, channel, position, action, error_code, error_message,
           delay_ms, fail_rate, remaining_count, skip_count, expires_at, label, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, projectId, owner.scope, owner.testUserId ?? null,
        owner.scope === 'instance' ? owner.providerInstanceId ?? null : v.providerInstanceId,
        v.channel, pos, v.action, v.errorCode, v.errorMessage, v.delayMs, v.failRate, v.remainingCount, v.skipCount, v.expiresAt, v.label,
        v.enabled ? 1 : 0, nowIso(),
      );
    return this.get(id)!;
  }

  /** Replace the whole list (order = array order). */
  replace(projectId: string, owner: RuleOwner, inputs: RuleInput[]): Rule[] {
    return this.db.transaction(() => {
      this.clear(projectId, owner);
      for (const i of inputs) this.add(projectId, owner, i);
      return this.list(projectId, owner);
    })();
  }

  clear(projectId: string, owner: RuleOwner): number {
    const [col, val] = ownerKey(owner);
    return this.db.prepare(`DELETE FROM rules WHERE project_id = ? AND scope = ? AND ${col} = ?`).run(projectId, owner.scope, val).changes;
  }

  update(id: string, patch: { enabled?: boolean; position?: number; label?: string | null }): Rule {
    const r = this.get(id);
    if (!r) throw new HttpError(404, `Rule "${id}" not found`);
    if (patch.enabled !== undefined) this.db.prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.label !== undefined) this.db.prepare('UPDATE rules SET label = ? WHERE id = ?').run(patch.label, id);
    if (patch.position !== undefined) this.move(r, patch.position);
    return this.get(id)!;
  }

  /** Move a rule to a 1-based position within its list. */
  private move(r: Rule, position: number): void {
    const list = this.list(r.projectId, { scope: r.scope, testUserId: r.testUserId, providerInstanceId: r.providerInstanceId }).filter((x) => x.id !== r.id);
    const at = Math.max(0, Math.min(list.length, Math.round(position) - 1));
    list.splice(at, 0, r);
    const stmt = this.db.prepare('UPDATE rules SET position = ? WHERE id = ?');
    this.db.transaction(() => list.forEach((x, i) => stmt.run(i + 1, x.id)))();
  }

  delete(id: string): Rule {
    const r = this.get(id);
    if (!r) throw new HttpError(404, `Rule "${id}" not found`);
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return r;
  }

  /** A message matched this rule: count it and switch the rule off when its count is used up. */
  consume(id: string): void {
    this.db
      .prepare(
        `UPDATE rules SET hits = hits + 1,
           remaining_count = CASE WHEN remaining_count IS NULL THEN NULL ELSE remaining_count - 1 END,
           enabled = CASE WHEN remaining_count IS NOT NULL AND remaining_count - 1 <= 0 THEN 0 ELSE enabled END
         WHERE id = ?`,
      )
      .run(id);
  }

  /** A message passed a rule that is still waiting ("after N messages"). */
  skip(id: string): void {
    this.db.prepare('UPDATE rules SET skip_count = MAX(skip_count - 1, 0) WHERE id = ?').run(id);
  }
}

function ownerKey(o: RuleOwner): [string, string] {
  if (o.scope === 'user') {
    if (!o.testUserId) throw new HttpError(400, 'User rules need a test user');
    return ['test_user_id', o.testUserId];
  }
  if (!o.providerInstanceId) throw new HttpError(400, 'Instance rules need a provider instance');
  return ['provider_instance_id', o.providerInstanceId];
}

function validate(i: RuleInput, scope: RuleScope) {
  const action = String(i.action ?? '').trim().toLowerCase().replace(/-/g, '_') as RuleAction;
  if (!RULE_ACTIONS.includes(action)) throw new HttpError(400, `Unknown action "${i.action}". Use one of: ${RULE_ACTIONS.join(', ')}`);
  let channel = (i.channel ?? 'all') as RuleChannel;
  if (!['all', 'email', 'sms', 'whatsapp'].includes(channel)) throw new HttpError(400, `Unknown channel "${i.channel}"`);
  if (EMAIL_ONLY.includes(action)) {
    if (channel === 'all') channel = 'email';
    if (channel !== 'email') throw new HttpError(400, `Action "${action}" only applies to email`);
  }
  if (scope === 'user' && (action === 'down' || action === 'slow')) {
    throw new HttpError(400, `"${action}" is a provider-instance rule; for a user use "fail" or "delay"`);
  }
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  const failRate = num(i.failRate);
  if (action === 'fail_rate' && (failRate === null || !(failRate > 0 && failRate <= 100))) throw new HttpError(400, 'fail_rate needs failRate between 1 and 100 (percent)');
  const delayMs = num(i.delayMs);
  if ((action === 'delay' || action === 'slow') && (delayMs === null || delayMs < 0)) throw new HttpError(400, `"${action}" needs delayMs`);
  if (delayMs !== null && delayMs > 600_000) throw new HttpError(400, 'delayMs can be at most 600000 (10 minutes)');
  const count = num(i.count);
  if (count !== null && !(count >= 1)) throw new HttpError(400, 'count must be at least 1 (omit it for "always")');
  let expiresAt: string | null = null;
  const minutes = num(i.minutes);
  if (minutes !== null) {
    if (!(minutes > 0)) throw new HttpError(400, 'minutes must be positive');
    expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  } else if (i.until) {
    const d = new Date(i.until);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid "until" time "${i.until}"`);
    expiresAt = d.toISOString();
  }
  return {
    action,
    channel,
    errorCode: i.errorCode === null || i.errorCode === undefined || i.errorCode === '' ? null : String(i.errorCode),
    errorMessage: i.errorMessage ? String(i.errorMessage) : null,
    delayMs,
    failRate,
    remainingCount: count === null ? null : Math.floor(count),
    skipCount: Math.max(0, Math.floor(num(i.after) ?? 0)),
    expiresAt,
    label: i.label ? String(i.label) : null,
    providerInstanceId: i.providerInstanceId ?? null,
    enabled: i.enabled !== false,
  };
}
