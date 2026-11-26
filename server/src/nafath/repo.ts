import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';
import { nafathConfig, type NafathInstance, type NafathRequest, type NafathRule } from './types.js';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toInstance(r: Row): NafathInstance {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    slug: String(r.slug),
    name: String(r.name),
    preset: 'nafath',
    appId: String(r.app_id),
    appKey: String(r.app_key),
    // Through the normaliser so rows written by older versions get the new defaults.
    config: nafathConfig(parseJson(r.config as string, {}), null),
    keys: parseJson(r.keys as string, []),
    strict: !!r.strict,
    enabled: !!r.enabled,
    createdAt: String(r.created_at),
  };
}

function toRequest(r: Row): NafathRequest {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    instanceId: String(r.instance_id),
    testUserId: str(r.test_user_id),
    runId: str(r.run_id),
    transId: String(r.trans_id),
    random: String(r.random),
    choices: parseJson(r.choices as string, [] as string[]),
    nationalId: String(r.national_id),
    service: str(r.service),
    locale: str(r.locale),
    requestId: str(r.request_id),
    status: r.status as NafathRequest['status'],
    reason: str(r.reason),
    decidedBy: str(r.decided_by),
    chosen: str(r.chosen),
    token: str(r.token),
    callback: parseJson(r.callback as string, []),
    logId: str(r.log_id),
    polls: Number(r.polls ?? 0),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    decidedAt: str(r.decided_at),
  };
}

function toRule(r: Row): NafathRule {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    runId: str(r.run_id),
    instanceId: str(r.instance_id),
    match: parseJson(r.match as string, {}),
    fault: String(r.fault),
    remaining: num(r.remaining),
    hits: Number(r.hits ?? 0),
    createdAt: String(r.created_at),
  };
}

export interface RequestFilter {
  testUserId?: string | null;
  unassigned?: boolean;
  status?: string[];
  runId?: string | null;
  instanceId?: string;
  nationalId?: string;
  limit?: number;
}

/** SQL access for nafath_instances, nafath_requests and nafath_rules (migration 34). */
export class NafathRepo {
  constructor(private db: DB) {}

  // ---------------- instances
  listInstances(projectId: string): NafathInstance[] {
    return (this.db.prepare('SELECT * FROM nafath_instances WHERE project_id = ? ORDER BY created_at, slug').all(projectId) as Row[]).map(toInstance);
  }
  allInstances(): NafathInstance[] {
    return (this.db.prepare('SELECT * FROM nafath_instances ORDER BY created_at').all() as Row[]).map(toInstance);
  }
  getInstance(id: string): NafathInstance | null {
    const r = this.db.prepare('SELECT * FROM nafath_instances WHERE id = ?').get(id) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  instanceBySlug(projectId: string, slug: string): NafathInstance | null {
    const r = this.db.prepare('SELECT * FROM nafath_instances WHERE project_id = ? AND slug = ?').get(projectId, slug) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  /** APP-ID is unique across the hub. */
  instanceByAppId(appId: string): NafathInstance | null {
    const r = this.db.prepare('SELECT * FROM nafath_instances WHERE app_id = ?').get(appId) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  insertInstance(i: Omit<NafathInstance, 'id' | 'createdAt' | 'preset'>): NafathInstance {
    const id = newId();
    this.db
      .prepare('INSERT INTO nafath_instances (id, project_id, slug, name, preset, app_id, app_key, config, keys, strict, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.projectId, i.slug, i.name, 'nafath', i.appId, i.appKey, JSON.stringify(i.config), JSON.stringify(i.keys), i.strict ? 1 : 0, i.enabled ? 1 : 0, nowIso());
    return this.getInstance(id)!;
  }
  updateInstance(id: string, p: Partial<Pick<NafathInstance, 'name' | 'slug' | 'appId' | 'appKey' | 'config' | 'keys' | 'strict' | 'enabled'>>): NafathInstance {
    const n = { ...this.getInstance(id)!, ...p };
    this.db
      .prepare('UPDATE nafath_instances SET name = ?, slug = ?, app_id = ?, app_key = ?, config = ?, keys = ?, strict = ?, enabled = ? WHERE id = ?')
      .run(n.name, n.slug, n.appId, n.appKey, JSON.stringify(n.config), JSON.stringify(n.keys), n.strict ? 1 : 0, n.enabled ? 1 : 0, id);
    return this.getInstance(id)!;
  }
  /** Requests go with the instance (ON DELETE CASCADE); its rules are deleted here. */
  deleteInstance(id: string): void {
    this.db.prepare('DELETE FROM nafath_rules WHERE instance_id = ?').run(id);
    this.db.prepare('DELETE FROM nafath_instances WHERE id = ?').run(id);
  }

  // ---------------- requests
  insertRequest(q: Omit<NafathRequest, 'id' | 'createdAt' | 'polls' | 'callback' | 'token' | 'chosen' | 'decidedBy' | 'reason' | 'decidedAt' | 'status'> & { status?: NafathRequest['status'] }): NafathRequest {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO nafath_requests (id, project_id, instance_id, test_user_id, run_id, trans_id, random, choices, national_id, service, locale, request_id,
          status, log_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, q.projectId, q.instanceId, q.testUserId, q.runId, q.transId, q.random, JSON.stringify(q.choices), q.nationalId, q.service, q.locale, q.requestId,
        q.status ?? 'WAITING', q.logId, nowIso(), q.expiresAt,
      );
    return this.getRequest(id)!;
  }
  getRequest(id: string): NafathRequest | null {
    const r = this.db.prepare('SELECT * FROM nafath_requests WHERE id = ?').get(id) as Row | undefined;
    return r ? toRequest(r) : null;
  }
  requestByTransId(transId: string): NafathRequest | null {
    const r = this.db.prepare('SELECT * FROM nafath_requests WHERE trans_id = ?').get(transId) as Row | undefined;
    return r ? toRequest(r) : null;
  }
  listRequests(projectId: string, f: RequestFilter = {}): NafathRequest[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.testUserId) (where.push('test_user_id = ?'), args.push(f.testUserId));
    if (f.unassigned) where.push('test_user_id IS NULL');
    if (f.status?.length) (where.push(`status IN (${f.status.map(() => '?').join(', ')})`), args.push(...f.status));
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    if (f.instanceId) (where.push('instance_id = ?'), args.push(f.instanceId));
    if (f.nationalId) (where.push('national_id = ?'), args.push(f.nationalId));
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    return (this.db.prepare(`SELECT * FROM nafath_requests WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ${limit}`).all(...args) as Row[]).map(toRequest);
  }
  /** The WAITING request of an ID on an instance (at most one; expiry is checked by the caller). */
  activeFor(instanceId: string, nationalId: string): NafathRequest | null {
    const r = this.db.prepare("SELECT * FROM nafath_requests WHERE instance_id = ? AND national_id = ? AND status = 'WAITING' ORDER BY rowid DESC LIMIT 1").get(instanceId, nationalId) as Row | undefined;
    return r ? toRequest(r) : null;
  }
  /** The latest decided request of an ID on an instance (wrong-number cooldown). */
  lastDecidedFor(instanceId: string, nationalId: string): NafathRequest | null {
    const r = this.db
      .prepare("SELECT * FROM nafath_requests WHERE instance_id = ? AND national_id = ? AND status <> 'WAITING' ORDER BY rowid DESC LIMIT 1")
      .get(instanceId, nationalId) as Row | undefined;
    return r ? toRequest(r) : null;
  }
  updateRequest(id: string, p: Partial<Pick<NafathRequest, 'status' | 'reason' | 'decidedBy' | 'chosen' | 'token' | 'callback' | 'logId' | 'polls' | 'decidedAt' | 'testUserId'>>): NafathRequest {
    const cols: Record<string, string> = {
      status: 'status',
      reason: 'reason',
      decidedBy: 'decided_by',
      chosen: 'chosen',
      token: 'token',
      callback: 'callback',
      logId: 'log_id',
      polls: 'polls',
      decidedAt: 'decided_at',
      testUserId: 'test_user_id',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      args.push(k === 'callback' ? JSON.stringify(v) : v);
    }
    if (sets.length) this.db.prepare(`UPDATE nafath_requests SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return this.getRequest(id)!;
  }
  /** One more /status poll. */
  countPoll(id: string): void {
    this.db.prepare('UPDATE nafath_requests SET polls = polls + 1 WHERE id = ?').run(id);
  }
  deleteRequests(projectId: string, f: { testUserId?: string; runId?: string } = {}): number {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.testUserId) (where.push('test_user_id = ?'), args.push(f.testUserId));
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    return this.db.prepare(`DELETE FROM nafath_requests WHERE ${where.join(' AND ')}`).run(...args).changes;
  }
  deleteOlderThan(projectId: string, cutoffIso: string): number {
    return this.db.prepare('DELETE FROM nafath_requests WHERE project_id = ? AND created_at < ?').run(projectId, cutoffIso).changes;
  }

  // ---------------- rules
  /** Run rules first, then project rules (each oldest first). With runId: that run's rules only. */
  listRules(projectId: string, f: { runId?: string | null } = {}): NafathRule[] {
    const rows = f.runId
      ? this.db.prepare('SELECT * FROM nafath_rules WHERE project_id = ? AND run_id = ? ORDER BY created_at').all(projectId, f.runId)
      : this.db.prepare('SELECT * FROM nafath_rules WHERE project_id = ? ORDER BY (run_id IS NULL), created_at').all(projectId);
    return (rows as Row[]).map(toRule);
  }
  getRule(id: string): NafathRule | null {
    const r = this.db.prepare('SELECT * FROM nafath_rules WHERE id = ?').get(id) as Row | undefined;
    return r ? toRule(r) : null;
  }
  insertRule(r: Omit<NafathRule, 'id' | 'createdAt' | 'hits'>): NafathRule {
    const id = newId();
    this.db
      .prepare('INSERT INTO nafath_rules (id, project_id, run_id, instance_id, match, fault, remaining, hits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, r.projectId, r.runId, r.instanceId, JSON.stringify(r.match ?? {}), r.fault, r.remaining, nowIso());
    return this.getRule(id)!;
  }
  /** One use: hits + 1, remaining - 1 (null stays null: every request). */
  hitRule(id: string): void {
    this.db.prepare('UPDATE nafath_rules SET hits = hits + 1, remaining = CASE WHEN remaining IS NULL THEN NULL ELSE MAX(remaining - 1, 0) END WHERE id = ?').run(id);
  }
  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM nafath_rules WHERE id = ?').run(id);
  }
  /** A run's rules, or the project rules (runId null). With testUserId: only rules matching that user. */
  deleteRules(projectId: string, f: { runId?: string | null; testUserId?: string } = {}): number {
    const where = ['project_id = ?', f.runId ? 'run_id = ?' : 'run_id IS NULL'];
    const args: unknown[] = [projectId];
    if (f.runId) args.push(f.runId);
    if (f.testUserId) (where.push("json_extract(match, '$.user') = ?"), args.push(f.testUserId));
    return this.db.prepare(`DELETE FROM nafath_rules WHERE ${where.join(' AND ')}`).run(...args).changes;
  }

  // ---------------- runs / reset
  purgeRun(runId: string): void {
    this.db.prepare('DELETE FROM nafath_requests WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM nafath_rules WHERE run_id = ?').run(runId);
  }
  resetProject(projectId: string): void {
    this.db.prepare('DELETE FROM nafath_requests WHERE project_id = ?').run(projectId);
    this.db.prepare('UPDATE nafath_rules SET hits = 0 WHERE project_id = ?').run(projectId);
  }
}
