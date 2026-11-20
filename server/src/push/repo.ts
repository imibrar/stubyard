import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';
import type { PushDevice, PushInstance, PushNotification, PushRule } from './types.js';

type Row = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toInstance(r: Row): PushInstance {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    slug: String(r.slug),
    name: String(r.name),
    preset: r.preset as PushInstance['preset'],
    config: parseJson(r.config as string, {} as PushInstance['config']),
    strict: !!r.strict,
    enabled: !!r.enabled,
    createdAt: String(r.created_at),
  };
}

function toDevice(r: Row): PushDevice {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    testUserId: str(r.test_user_id),
    runId: str(r.run_id),
    instanceId: str(r.instance_id),
    platform: r.platform as PushDevice['platform'],
    token: String(r.token),
    appId: str(r.app_id),
    name: String(r.name ?? ''),
    state: r.state as PushDevice['state'],
    unregisteredAt: str(r.unregistered_at),
    topics: parseJson(r.topics as string, [] as string[]),
    badge: num(r.badge),
    auto: !!r.auto,
    lastPushAt: str(r.last_push_at),
    createdAt: String(r.created_at),
  };
}

function toNotification(r: Row): PushNotification {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    instanceId: str(r.instance_id),
    deviceId: str(r.device_id),
    testUserId: str(r.test_user_id),
    runId: str(r.run_id),
    logId: str(r.log_id),
    groupId: str(r.group_id),
    provider: r.provider as PushNotification['provider'],
    targetKind: r.target_kind as PushNotification['targetKind'],
    target: String(r.target ?? ''),
    title: str(r.title),
    body: str(r.body),
    image: str(r.image),
    data: parseJson(r.data as string, {}),
    badge: num(r.badge),
    sound: str(r.sound),
    category: str(r.category),
    threadId: str(r.thread_id),
    collapseKey: str(r.collapse_key),
    priority: str(r.priority),
    pushType: str(r.push_type),
    silent: !!r.silent,
    expiresAt: str(r.expires_at),
    status: r.status as PushNotification['status'],
    errorCode: str(r.error_code),
    providerMessageId: str(r.provider_message_id),
    headers: parseJson(r.headers as string, {}),
    raw: parseJson(r.raw as string, null),
    lint: parseJson(r.lint as string, []),
    openedAt: str(r.opened_at),
    createdAt: String(r.created_at),
  };
}

function toRule(r: Row): PushRule {
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

export interface NotificationFilter {
  runId?: string | null;
  testUserId?: string | null;
  unassigned?: boolean;
  deviceId?: string;
  provider?: string;
  instanceId?: string;
  topic?: string;
  status?: string[];
  contains?: string;
  title?: string;
  dataKey?: string;
  /** Id cursor: rows created after this notification (ids are not ordered: compared by rowid). */
  after?: string;
  since?: string;
  limit?: number;
  /** Oldest first (wait) instead of newest first. */
  asc?: boolean;
}

/** SQL access for push_instances, push_devices, push_notifications and push_rules (migration 22). */
export class PushRepo {
  constructor(private db: DB) {}

  // ---------------- instances
  listInstances(projectId: string): PushInstance[] {
    return (this.db.prepare('SELECT * FROM push_instances WHERE project_id = ? ORDER BY created_at, slug').all(projectId) as Row[]).map(toInstance);
  }
  allInstances(preset?: string): PushInstance[] {
    const rows = preset ? this.db.prepare('SELECT * FROM push_instances WHERE preset = ? ORDER BY created_at').all(preset) : this.db.prepare('SELECT * FROM push_instances ORDER BY created_at').all();
    return (rows as Row[]).map(toInstance);
  }
  getInstance(id: string): PushInstance | null {
    const r = this.db.prepare('SELECT * FROM push_instances WHERE id = ?').get(id) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  instanceBySlug(projectId: string, slug: string): PushInstance | null {
    const r = this.db.prepare('SELECT * FROM push_instances WHERE project_id = ? AND slug = ?').get(projectId, slug) as Row | undefined;
    return r ? toInstance(r) : null;
  }
  insertInstance(i: Omit<PushInstance, 'id' | 'createdAt'>): PushInstance {
    const id = newId();
    this.db
      .prepare('INSERT INTO push_instances (id, project_id, slug, name, preset, config, strict, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.projectId, i.slug, i.name, i.preset, JSON.stringify(i.config), i.strict ? 1 : 0, i.enabled ? 1 : 0, nowIso());
    return this.getInstance(id)!;
  }
  updateInstance(id: string, p: Partial<Pick<PushInstance, 'name' | 'slug' | 'config' | 'strict' | 'enabled'>>): PushInstance {
    const cur = this.getInstance(id)!;
    const n = { ...cur, ...p };
    this.db.prepare('UPDATE push_instances SET name = ?, slug = ?, config = ?, strict = ?, enabled = ? WHERE id = ?').run(n.name, n.slug, JSON.stringify(n.config), n.strict ? 1 : 0, n.enabled ? 1 : 0, id);
    return this.getInstance(id)!;
  }
  deleteInstance(id: string): void {
    this.db.prepare('UPDATE push_devices SET instance_id = NULL WHERE instance_id = ?').run(id);
    this.db.prepare('DELETE FROM push_rules WHERE instance_id = ?').run(id);
    this.db.prepare('DELETE FROM push_instances WHERE id = ?').run(id);
  }

  // ---------------- devices
  listDevices(projectId: string, f: { testUserId?: string | null; platform?: string; runId?: string | null; unassigned?: boolean; instanceId?: string } = {}): PushDevice[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.testUserId) (where.push('test_user_id = ?'), args.push(f.testUserId));
    if (f.unassigned) where.push('test_user_id IS NULL');
    if (f.platform) (where.push('platform = ?'), args.push(f.platform));
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    if (f.instanceId) (where.push('instance_id = ?'), args.push(f.instanceId));
    return (this.db.prepare(`SELECT * FROM push_devices WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...args) as Row[]).map(toDevice);
  }
  getDevice(id: string): PushDevice | null {
    const r = this.db.prepare('SELECT * FROM push_devices WHERE id = ?').get(id) as Row | undefined;
    return r ? toDevice(r) : null;
  }
  deviceByToken(projectId: string, token: string): PushDevice | null {
    const r = this.db.prepare('SELECT * FROM push_devices WHERE project_id = ? AND token = ?').get(projectId, token) as Row | undefined;
    return r ? toDevice(r) : null;
  }
  /** Every project's device with this token (APNs project resolution). */
  devicesByToken(token: string): PushDevice[] {
    return (this.db.prepare('SELECT * FROM push_devices WHERE token = ?').all(token) as Row[]).map(toDevice);
  }
  insertDevice(d: Omit<PushDevice, 'id' | 'createdAt' | 'lastPushAt' | 'unregisteredAt' | 'state' | 'badge'> & { state?: PushDevice['state'] }): PushDevice {
    const id = newId();
    this.db
      .prepare(
        'INSERT INTO push_devices (id, project_id, test_user_id, run_id, instance_id, platform, token, app_id, name, state, topics, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, d.projectId, d.testUserId, d.runId, d.instanceId, d.platform, d.token, d.appId, d.name, d.state ?? 'active', JSON.stringify(d.topics), d.auto ? 1 : 0, nowIso());
    return this.getDevice(id)!;
  }
  updateDevice(id: string, p: Partial<Pick<PushDevice, 'testUserId' | 'instanceId' | 'appId' | 'name' | 'state' | 'unregisteredAt' | 'topics' | 'badge' | 'lastPushAt' | 'auto' | 'platform'>>): PushDevice {
    const cols: Record<string, string> = {
      testUserId: 'test_user_id',
      instanceId: 'instance_id',
      appId: 'app_id',
      name: 'name',
      state: 'state',
      unregisteredAt: 'unregistered_at',
      topics: 'topics',
      badge: 'badge',
      lastPushAt: 'last_push_at',
      auto: 'auto',
      platform: 'platform',
    };
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      args.push(k === 'topics' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (sets.length) this.db.prepare(`UPDATE push_devices SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return this.getDevice(id)!;
  }
  deleteDevice(id: string): void {
    this.db.prepare('DELETE FROM push_devices WHERE id = ?').run(id);
  }

  // ---------------- notifications
  insertNotification(n: Omit<PushNotification, 'id' | 'createdAt' | 'openedAt'>): PushNotification {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO push_notifications (id, project_id, instance_id, device_id, test_user_id, run_id, log_id, group_id, provider, target_kind, target,
          title, body, image, data, badge, sound, category, thread_id, collapse_key, priority, push_type, silent, expires_at, status, error_code,
          provider_message_id, headers, raw, lint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, n.projectId, n.instanceId, n.deviceId, n.testUserId, n.runId, n.logId, n.groupId, n.provider, n.targetKind, n.target,
        n.title, n.body, n.image, JSON.stringify(n.data ?? {}), n.badge, n.sound, n.category, n.threadId, n.collapseKey, n.priority, n.pushType,
        n.silent ? 1 : 0, n.expiresAt, n.status, n.errorCode, n.providerMessageId, JSON.stringify(n.headers ?? {}), JSON.stringify(n.raw ?? null), JSON.stringify(n.lint ?? []), nowIso(),
      );
    return this.getNotification(id)!;
  }
  getNotification(id: string): PushNotification | null {
    const r = this.db.prepare('SELECT * FROM push_notifications WHERE id = ?').get(id) as Row | undefined;
    return r ? toNotification(r) : null;
  }
  private rowid(id: string): number | null {
    const r = this.db.prepare('SELECT rowid AS r FROM push_notifications WHERE id = ?').get(id) as { r: number } | undefined;
    return r ? Number(r.r) : null;
  }
  listNotifications(projectId: string, f: NotificationFilter = {}): PushNotification[] {
    const where = ['n.project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.runId) (where.push('n.run_id = ?'), args.push(f.runId));
    if (f.testUserId) (where.push('n.test_user_id = ?'), args.push(f.testUserId));
    if (f.unassigned) where.push('n.test_user_id IS NULL');
    if (f.deviceId) (where.push('n.device_id = ?'), args.push(f.deviceId));
    if (f.provider) (where.push('n.provider = ?'), args.push(f.provider));
    if (f.instanceId) (where.push('n.instance_id = ?'), args.push(f.instanceId));
    if (f.topic) (where.push("n.target_kind IN ('topic', 'condition') AND n.target LIKE ?"), args.push(`%${f.topic}%`));
    if (f.status?.length) (where.push(`n.status IN (${f.status.map(() => '?').join(', ')})`), args.push(...f.status));
    if (f.contains) {
      where.push("(LOWER(COALESCE(n.title, '') || ' ' || COALESCE(n.body, '') || ' ' || n.data) LIKE ?)");
      args.push(`%${f.contains.toLowerCase()}%`);
    }
    if (f.title) (where.push("LOWER(COALESCE(n.title, '')) LIKE ?"), args.push(`%${f.title.toLowerCase()}%`));
    if (f.dataKey) (where.push("json_type(n.data, '$.' || ?) IS NOT NULL"), args.push(f.dataKey.replace(/[^\w-]/g, '')));
    if (f.since) (where.push('n.created_at >= ?'), args.push(f.since));
    if (f.after) {
      const r = this.rowid(f.after);
      if (r !== null) (where.push('n.rowid > ?'), args.push(r));
    }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    const order = f.asc ? 'n.rowid ASC' : 'n.rowid DESC';
    return (this.db.prepare(`SELECT n.* FROM push_notifications n WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`).all(...args) as Row[]).map(toNotification);
  }
  updateNotification(id: string, p: { status?: string; openedAt?: string | null; errorCode?: string | null }): void {
    if (p.status !== undefined) this.db.prepare('UPDATE push_notifications SET status = ? WHERE id = ?').run(p.status, id);
    if (p.openedAt !== undefined) this.db.prepare('UPDATE push_notifications SET opened_at = ? WHERE id = ?').run(p.openedAt, id);
    if (p.errorCode !== undefined) this.db.prepare('UPDATE push_notifications SET error_code = ? WHERE id = ?').run(p.errorCode, id);
  }
  /** Older delivered rows of a device with the same collapse key → 'collapsed'. */
  collapse(deviceId: string, collapseKey: string, exceptId: string): number {
    return this.db.prepare("UPDATE push_notifications SET status = 'collapsed' WHERE device_id = ? AND collapse_key = ? AND status = 'delivered' AND id <> ?").run(deviceId, collapseKey, exceptId).changes;
  }
  deleteNotifications(projectId: string, f: { testUserId?: string; runId?: string } = {}): number {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (f.testUserId) (where.push('test_user_id = ?'), args.push(f.testUserId));
    if (f.runId) (where.push('run_id = ?'), args.push(f.runId));
    return this.db.prepare(`DELETE FROM push_notifications WHERE ${where.join(' AND ')}`).run(...args).changes;
  }
  deleteOlderThan(projectId: string, cutoffIso: string): number {
    return this.db.prepare('DELETE FROM push_notifications WHERE project_id = ? AND created_at < ?').run(projectId, cutoffIso).changes;
  }
  unreadCounts(projectId: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT test_user_id AS u, COUNT(*) AS n FROM push_notifications WHERE project_id = ? AND opened_at IS NULL AND status IN ('delivered', 'collapsed') GROUP BY test_user_id")
      .all(projectId) as { u: string | null; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.u ?? 'unassigned', Number(r.n)]));
  }

  // ---------------- rules
  listRules(projectId: string, f: { runId?: string | null } = {}): PushRule[] {
    const rows = f.runId
      ? this.db.prepare('SELECT * FROM push_rules WHERE project_id = ? AND run_id = ? ORDER BY created_at').all(projectId, f.runId)
      : this.db.prepare('SELECT * FROM push_rules WHERE project_id = ? ORDER BY (run_id IS NULL), created_at').all(projectId);
    return (rows as Row[]).map(toRule);
  }
  getRule(id: string): PushRule | null {
    const r = this.db.prepare('SELECT * FROM push_rules WHERE id = ?').get(id) as Row | undefined;
    return r ? toRule(r) : null;
  }
  insertRule(r: Omit<PushRule, 'id' | 'createdAt' | 'hits'>): PushRule {
    const id = newId();
    this.db
      .prepare('INSERT INTO push_rules (id, project_id, run_id, instance_id, match, fault, remaining, hits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, r.projectId, r.runId, r.instanceId, JSON.stringify(r.match ?? {}), r.fault, r.remaining, nowIso());
    return this.getRule(id)!;
  }
  hitRule(id: string): void {
    this.db.prepare('UPDATE push_rules SET hits = hits + 1, remaining = CASE WHEN remaining IS NULL THEN NULL ELSE MAX(remaining - 1, 0) END WHERE id = ?').run(id);
  }
  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM push_rules WHERE id = ?').run(id);
  }
  deleteRules(projectId: string, runId?: string | null): number {
    return runId
      ? this.db.prepare('DELETE FROM push_rules WHERE project_id = ? AND run_id = ?').run(projectId, runId).changes
      : this.db.prepare('DELETE FROM push_rules WHERE project_id = ? AND run_id IS NULL').run(projectId).changes;
  }

  // ---------------- runs / reset
  purgeRun(runId: string): void {
    this.db.prepare('DELETE FROM push_notifications WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM push_devices WHERE run_id = ?').run(runId);
    this.db.prepare('DELETE FROM push_rules WHERE run_id = ?').run(runId);
  }
  resetProject(projectId: string): void {
    this.db.prepare('DELETE FROM push_notifications WHERE project_id = ?').run(projectId);
    this.db.prepare('DELETE FROM push_devices WHERE project_id = ? AND auto = 1').run(projectId);
    this.db.prepare('UPDATE push_devices SET badge = NULL, last_push_at = NULL WHERE project_id = ?').run(projectId);
    this.db.prepare('UPDATE push_rules SET hits = 0 WHERE project_id = ?').run(projectId);
  }
}
