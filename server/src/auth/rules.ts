import type { AuthProvider, AuthRepo, AuthRule, AuthStage } from '../repos/auth.js';
import { AUTH_ACTION_GROUPS, AUTH_ACTIONS } from '../repos/auth.js';

export const AUTHORIZE_ACTIONS: readonly string[] = AUTH_ACTION_GROUPS.authorize;
export const TOKEN_ACTIONS: readonly string[] = AUTH_ACTION_GROUPS.token;
export const CLAIM_ACTIONS: readonly string[] = AUTH_ACTION_GROUPS.claims;
export const DEFECT_ACTIONS: readonly string[] = AUTH_ACTION_GROUPS.defect;
export const TRANSPORT_ACTIONS: readonly string[] = AUTH_ACTION_GROUPS.transport;

/** Scenario effects for one request: from X-Hub-Scenario / hub_scenario, a rule, or carried over from the authorize step. */
export interface Effects {
  actions: Set<string>;
  delayMs?: number;
  ttl?: number;
  source: 'header' | 'query' | 'rule' | 'authorize' | 'grant';
  ruleId?: string;
  ruleLabel?: string | null;
}

export const hasAny = (e: Effects | null | undefined, list: readonly string[]) => !!e && list.some((a) => e.actions.has(a));

/** "no_email, short_lived=30, slow=2000" → effects. Unknown names are returned separately. */
export function parseScenario(value: string, source: Effects['source']): { effects: Effects | null; unknown: string[] } {
  const actions = new Set<string>();
  const unknown: string[] = [];
  const e: Effects = { actions, source };
  for (const raw of value.split(/[,\s]+/).filter(Boolean)) {
    const [nameRaw, arg] = raw.split(/[=:]/, 2);
    const name = nameRaw.trim().toLowerCase().replace(/-/g, '_');
    if (!AUTH_ACTIONS.includes(name)) {
      unknown.push(raw);
      continue;
    }
    actions.add(name);
    if (name === 'slow') e.delayMs = Number(arg) >= 0 ? Number(arg) : 2000;
    if (name === 'short_lived') e.ttl = Number(arg) > 0 ? Number(arg) : 5;
  }
  return { effects: actions.size ? e : null, unknown };
}

export function effectsFromRule(r: AuthRule): Effects {
  return {
    actions: new Set([r.action]),
    delayMs: r.action === 'slow' ? Number(r.params.delayMs ?? 2000) : undefined,
    ttl: r.action === 'short_lived' ? Number(r.params.ttl ?? 5) : undefined,
    source: 'rule',
    ruleId: r.id,
    ruleLabel: r.label,
  };
}

/** Serialisable form stored on grants (so userinfo sees the claim effects chosen at token time). */
export function effectsToJson(e: Effects | null): { actions: string[]; ttl?: number } | null {
  if (!e) return null;
  return { actions: [...e.actions], ...(e.ttl !== undefined ? { ttl: e.ttl } : {}) };
}

export function effectsFromJson(v: unknown, source: Effects['source']): Effects | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { actions?: unknown; ttl?: unknown };
  if (!Array.isArray(o.actions) || !o.actions.length) return null;
  return { actions: new Set(o.actions.map(String)), ttl: typeof o.ttl === 'number' ? o.ttl : undefined, source };
}

export function mergeEffects(a: Effects | null, b: Effects | null): Effects | null {
  if (!a) return b;
  if (!b) return a;
  return { ...b, ...a, actions: new Set([...b.actions, ...a.actions]), ttl: a.ttl ?? b.ttl, delayMs: a.delayMs ?? b.delayMs };
}

/**
 * First matching rule: the user's rules, then the provider's. Same count / skip / expiry semantics as RuleRepo.
 * Only rules whose action is in `allowed` (what can happen at this point of the flow) are considered.
 */
export function pickRule(repo: AuthRepo, p: AuthProvider, userId: string | null, stage: AuthStage, allowed: readonly string[]): AuthRule | null {
  const lists = [...(userId ? repo.listRules(p.id, userId) : []), ...repo.listRules(p.id, null)];
  for (const r of lists) {
    if (!r.active) continue;
    if (r.stage !== 'any' && r.stage !== stage) continue;
    if (!allowed.includes(r.action)) continue;
    if (r.skipCount > 0) {
      repo.skipRule(r.id);
      continue;
    }
    repo.consumeRule(r.id);
    return r;
  }
  return null;
}
