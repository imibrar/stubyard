import type { StorageRepo, StorageRule } from '../repos/storage.js';
import { HttpError } from '../util.js';
import { STORAGE_ACTIONS, STORAGE_OPS, type StorageAction, type StorageEffects, type StorageOp } from './types.js';

export interface StorageRuleInput {
  action: string;
  op?: string;
  bucket?: string | null;
  keyPrefix?: string | null;
  params?: Record<string, unknown>;
  delayMs?: number;
  bytesPerSec?: number;
  afterBytes?: number;
  maxBytes?: number;
  count?: number | null;
  after?: number | null;
  failRate?: number | null;
  minutes?: number | null;
  until?: string | null;
  label?: string | null;
  enabled?: boolean;
}

/** One-click presets shown in the dashboard and returned by GET /api/storage-presets. */
export const STORAGE_RULE_PRESETS: { id: string; label: string; rule: StorageRuleInput; note?: string }[] = [
  { id: 'deny-uploads', label: 'Uploads denied (403)', rule: { action: 'access_denied', op: 'put' } },
  { id: 'throttled', label: 'Throttled (slow_down) ×3', rule: { action: 'slow_down', count: 3 }, note: 'SDKs retry throttling (S3 503 SlowDown, GCS 429, Cloudinary 420, Azure 503), so count 1 is usually invisible to the app.' },
  { id: 'quota', label: 'Quota exceeded on upload', rule: { action: 'quota_exceeded', op: 'put' } },
  { id: 'too-large', label: 'Files over 1 MB rejected', rule: { action: 'entity_too_large', op: 'put', maxBytes: 1024 * 1024 } },
  { id: 'expired', label: 'Presigned URLs expired', rule: { action: 'expired_url' } },
  { id: 'slow-download', label: 'Slow downloads (64 KiB/s)', rule: { action: 'slow', op: 'get', bytesPerSec: 64 * 1024 } },
  { id: 'corrupt', label: 'Corrupted download (checksum)', rule: { action: 'checksum_mismatch', op: 'get', count: 1 } },
  { id: 'reset', label: 'Connection reset mid-upload', rule: { action: 'reset', op: 'put', afterBytes: 64 * 1024, count: 1 } },
];

export function normalizeAction(a: string): StorageAction | null {
  const n = a.trim().toLowerCase().replace(/-/g, '_');
  return (STORAGE_ACTIONS as readonly string[]).includes(n) ? (n as StorageAction) : null;
}

export function validateRule(i: StorageRuleInput): Omit<StorageRule, 'id' | 'hits' | 'createdAt' | 'active' | 'position' | 'projectId' | 'instanceId' | 'bucketId' | 'runId'> {
  const action = normalizeAction(String(i.action ?? ''));
  if (!action) throw new HttpError(400, `Unknown storage scenario "${i.action}". Use one of: ${STORAGE_ACTIONS.join(', ')}`);
  const op = String(i.op ?? 'any').toLowerCase();
  if (!(STORAGE_OPS as readonly string[]).includes(op)) throw new HttpError(400, `Unknown op "${i.op}". Use one of: ${STORAGE_OPS.join(', ')}`);
  const params: Record<string, unknown> = { ...(i.params && typeof i.params === 'object' ? i.params : {}) };
  for (const k of ['delayMs', 'bytesPerSec', 'afterBytes', 'maxBytes'] as const) if (i[k] !== undefined && i[k] !== null) params[k] = Number(i[k]);
  if (Number(params.delayMs) > 600_000) throw new HttpError(400, 'delayMs can be at most 600000');
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
  const count = num(i.count);
  if (count !== null && !(count >= 1)) throw new HttpError(400, 'count must be at least 1 (omit it for "always")');
  const failRate = num(i.failRate);
  if (failRate !== null && !(failRate > 0 && failRate <= 1)) throw new HttpError(400, 'failRate must be in (0, 1]');
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
    op,
    keyPrefix: i.keyPrefix ? String(i.keyPrefix) : null,
    action,
    params,
    remainingCount: count === null ? null : Math.floor(count),
    skipCount: Math.max(0, Math.floor(num(i.after) ?? 0)),
    failRate,
    expiresAt,
    label: i.label ? String(i.label) : null,
    enabled: i.enabled !== false,
  };
}

/** "slow_down", "slow=2000", "slow:bytesPerSec=65536", "reset=1024" → effects (first known action wins). */
export function parseScenario(value: string, source: 'header' | 'query'): { effects: StorageEffects | null; unknown: string[] } {
  const unknown: string[] = [];
  for (const raw of value.split(/[,\s]+/).filter(Boolean)) {
    const [nameRaw, ...rest] = raw.split(/[=:]/);
    const action = normalizeAction(nameRaw);
    if (!action) {
      unknown.push(raw);
      continue;
    }
    const params: Record<string, unknown> = {};
    const arg = rest.join('=');
    if (arg) {
      const kv = /^(\w+)=(\d+)$/.exec(arg);
      if (kv) params[kv[1]] = Number(kv[2]);
      else if (/^\d+$/.test(arg)) {
        const n = Number(arg);
        if (action === 'slow') params.delayMs = n;
        else if (action === 'reset') params.afterBytes = n;
        else if (action === 'entity_too_large') params.maxBytes = n;
      }
    }
    return { effects: { action, params, source }, unknown };
  }
  return { effects: null, unknown };
}

/** Rules that can match this request, in precedence order: run rules, bucket rules, instance rules. */
export function pickRule(repo: StorageRepo, o: { instanceId: string; bucketId: string | null; runId: string | null; op: StorageOp; opName?: string; key: string | null; only?: StorageAction[] }): StorageRule | null {
  const all = repo.listRules(o.instanceId, { runId: 'all' });
  const ordered = [
    ...all.filter((r) => o.runId && r.runId === o.runId),
    ...all.filter((r) => !r.runId && r.bucketId && r.bucketId === o.bucketId),
    ...all.filter((r) => !r.runId && !r.bucketId),
  ];
  for (const r of ordered) {
    if (!r.active) continue;
    if (r.bucketId && r.bucketId !== o.bucketId) continue;
    if (r.op !== 'any' && r.op !== o.op) continue;
    if (r.keyPrefix && !(o.key ?? '').startsWith(r.keyPrefix)) continue;
    if (o.only && !o.only.includes(r.action as StorageAction)) continue;
    if (r.action === 'complete_error_200' && o.opName !== 'CompleteMultipartUpload') continue;
    if (r.skipCount > 0) {
      repo.skipRule(r.id);
      continue;
    }
    if (r.failRate !== null && Math.random() >= r.failRate) continue;
    repo.consumeRule(r.id);
    return r;
  }
  return null;
}
