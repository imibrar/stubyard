import type { Hub } from '../hub.js';

export interface MaintenanceReport {
  at: string;
  durationMs: number;
  /** Logs removed because they were older than the retention period. */
  logsExpired: number;
  /** Logs removed because the database was larger than the size limit. */
  logsForSize: number;
  vacuumed: boolean;
  /** Projects with settings.autoResetDays whose old data was removed. */
  autoReset: { project: string; messages: number; logs: number }[];
  dbBytes: number;
  /** Test runs stopped because their TTL passed / purged after DEVHUB_RUN_RETENTION_HOURS. */
  runs?: { stopped: number; purged: number };
  /** Expired login-provider grants (codes, tokens, sessions) removed. */
  authGrantsPurged?: number;
  /** File storage: expired uploads, retention, orphan files swept, bytes stored. */
  storage?: { uploadsPurged: number; objectsExpired: number; orphansSwept: number; bytes: number };
  /** Finished scheduled actions older than 24 h removed. */
  schedules?: number;
  error?: string;
}

export interface StorageInfo {
  /** Database file size (plus WAL). */
  fileBytes: number;
  /** Bytes used by live data (file size minus free pages). */
  usedBytes: number;
  freeBytes: number;
  counts: Record<string, number>;
  oldestLogAt: string | null;
}

const DAY = 86_400_000;
const BATCH = 5000;

/**
 * Background clean-up:
 *  - traffic logs older than DEVHUB_LOG_RETENTION_DAYS (default 7; per project: settings.retentionDays);
 *  - when the database grows past DEVHUB_MAX_DB_MB (default 500), the oldest logs are deleted first, then VACUUM;
 *  - projects with settings.autoResetDays = N lose captured data (messages, emails, logs) older than N days.
 */
export class Maintenance {
  lastRun: MaintenanceReport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<MaintenanceReport> | null = null;

  constructor(private hub: Hub) {}

  get retentionDays(): number {
    return this.hub.config.logRetentionDays;
  }

  get maxDbBytes(): number {
    return Math.round(this.hub.config.maxDbMb * 1024 * 1024);
  }

  start(): void {
    const every = this.hub.config.maintenanceIntervalMs;
    if (!(every > 0)) return;
    this.first = setTimeout(() => void this.run().catch(() => undefined), Math.min(5000, every));
    this.first.unref?.();
    this.timer = setInterval(() => void this.run().catch(() => undefined), every);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One clean-up pass (also POST /api/system/maintenance). Concurrent calls share the same pass. */
  run(now = Date.now()): Promise<MaintenanceReport> {
    if (!this.running) {
      this.running = this.pass(now).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(now: number): Promise<MaintenanceReport> {
    const t0 = Date.now();
    const report: MaintenanceReport = { at: new Date(now).toISOString(), durationMs: 0, logsExpired: 0, logsForSize: 0, vacuumed: false, autoReset: [], dbBytes: 0 };
    try {
      report.logsExpired = this.pruneExpiredLogs(now);
      report.autoReset = await this.autoReset(now);
      if (this.hub.runs) report.runs = await this.hub.runs.maintain(now);
      if (this.hub.auth) report.authGrantsPurged = this.hub.auth.purgeExpired(now);
      if (this.hub.storage) report.storage = await this.hub.storage.maintain(now);
      if (this.hub.schedules) report.schedules = this.hub.schedules.purgeFinished(now);
      const size = this.pruneForSize();
      report.logsForSize = size.deleted;
      report.vacuumed = size.vacuumed;
      if (report.logsExpired || report.logsForSize) this.hub.bus.publish({ type: 'project.reset', projectId: null, data: { retention: report } });
    } catch (err) {
      report.error = (err as Error).message;
    }
    report.dbBytes = this.storage().fileBytes;
    report.durationMs = Date.now() - t0;
    this.lastRun = report;
    return report;
  }

  /** Delete logs past their retention period. Returns the number deleted. */
  pruneExpiredLogs(now = Date.now()): number {
    let deleted = 0;
    const overrides = this.hub.projects.list().filter((p) => typeof p.settings.retentionDays === 'number' && p.settings.retentionDays > 0);
    const globalCutoff = new Date(now - this.retentionDays * DAY).toISOString();
    if (this.retentionDays > 0) {
      const ids = overrides.map((p) => p.id);
      const notIn = ids.length ? `AND (project_id IS NULL OR project_id NOT IN (${ids.map(() => '?').join(',')}))` : '';
      deleted += this.deleteBatched(`SELECT id FROM traffic_logs WHERE received_at < ? ${notIn}`, [globalCutoff, ...ids]);
    }
    for (const p of overrides) {
      const cutoff = new Date(now - p.settings.retentionDays! * DAY).toISOString();
      deleted += this.deleteBatched('SELECT id FROM traffic_logs WHERE project_id = ? AND received_at < ?', [p.id, cutoff]);
    }
    return deleted;
  }

  /** If the database is above the size limit, delete the oldest logs until it fits, then VACUUM. */
  pruneForSize(): { deleted: number; vacuumed: boolean } {
    const max = this.maxDbBytes;
    if (!(max > 0)) return { deleted: 0, vacuumed: false };
    let deleted = 0;
    for (let i = 0; i < 100 && this.storage().usedBytes > max; i++) {
      const count = (this.hub.db.prepare('SELECT COUNT(*) AS n FROM traffic_logs').get() as { n: number }).n;
      if (!count) break;
      const n = Math.max(1, Math.ceil(count * 0.1));
      deleted += this.hub.db.prepare('DELETE FROM traffic_logs WHERE id IN (SELECT id FROM traffic_logs ORDER BY received_at, id LIMIT ?)').run(n).changes;
    }
    let vacuumed = false;
    const s = this.storage();
    // Give the space back to the disk when we pruned for size, or when more than half the file is free pages.
    if ((deleted > 0 || (s.freeBytes > 64 * 1024 * 1024 && s.freeBytes > s.fileBytes / 2)) && s.freeBytes > 0) vacuumed = this.vacuum();
    return { deleted, vacuumed };
  }

  /** Projects with settings.autoResetDays: remove messages (and their emails) and logs older than N days. */
  async autoReset(now = Date.now()): Promise<MaintenanceReport['autoReset']> {
    const out: MaintenanceReport['autoReset'] = [];
    for (const p of this.hub.projects.list()) {
      const days = Number(p.settings.autoResetDays);
      if (!(days > 0)) continue;
      const cutoff = new Date(now - days * DAY).toISOString();
      const r = this.deleteOlderThan(p.id, cutoff);
      if (r.messages || r.logs) {
        await this.hub.mailpit?.deleteMessages(r.orphanMailpitIds).catch(() => undefined);
        this.hub.bus.publish({ type: 'project.reset', projectId: p.id, data: { autoReset: true, messages: r.messages, logs: r.logs } });
        out.push({ project: p.slug, messages: r.messages, logs: r.logs });
      }
    }
    return out;
  }

  /** Delete one project's messages and logs created before `cutoff` (ISO). */
  deleteOlderThan(projectId: string, cutoff: string): { messages: number; logs: number; orphanMailpitIds: string[] } {
    const db = this.hub.db;
    return db.transaction(() => {
      const candidates = (
        db.prepare('SELECT DISTINCT mailpit_id FROM messages WHERE project_id = ? AND created_at < ? AND mailpit_id IS NOT NULL').all(projectId, cutoff) as { mailpit_id: string }[]
      ).map((r) => r.mailpit_id);
      const messages = db.prepare('DELETE FROM messages WHERE project_id = ? AND created_at < ?').run(projectId, cutoff).changes;
      const stillUsed = db.prepare('SELECT 1 FROM messages WHERE mailpit_id = ? LIMIT 1');
      const orphanMailpitIds = candidates.filter((id) => !stillUsed.get(id));
      const logs = db.prepare('DELETE FROM traffic_logs WHERE project_id = ? AND received_at < ?').run(projectId, cutoff).changes;
      // Phase 6.5: old WhatsApp media uploads and finished verifications go with them.
      db.prepare('DELETE FROM wa_media WHERE project_id = ? AND created_at < ?').run(projectId, cutoff);
      db.prepare('DELETE FROM verifications WHERE project_id = ? AND created_at < ?').run(projectId, cutoff);
      return { messages, logs, orphanMailpitIds };
    })();
  }

  storage(): StorageInfo {
    const db = this.hub.db;
    const pragma = (name: string) => Number(Object.values((db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>) ?? {})[0] ?? 0);
    const pageSize = pragma('page_size');
    const pages = pragma('page_count');
    const free = pragma('freelist_count');
    const counts: Record<string, number> = {};
    for (const t of ['projects', 'test_users', 'provider_instances', 'messages', 'traffic_logs', 'rules', 'authenticators', 'api_mocks', 'scheduled_jobs']) {
      try {
        counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      } catch {
        /* table not there */
      }
    }
    if (this.hub.storage) {
      const s = this.hub.storage.counts();
      counts.storage_objects = s.objects;
      counts.storage_bytes = s.bytes;
    }
    const oldest = db.prepare('SELECT MIN(received_at) AS t FROM traffic_logs').get() as { t: string | null };
    return { fileBytes: pageSize * pages, usedBytes: pageSize * (pages - free), freeBytes: pageSize * free, counts, oldestLogAt: oldest.t };
  }

  vacuum(): boolean {
    try {
      this.hub.db.exec('VACUUM');
      try {
        this.hub.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* not WAL (in-memory) */
      }
      return true;
    } catch {
      return false; // busy (open transaction); next pass
    }
  }

  private deleteBatched(selectIds: string, args: unknown[]): number {
    let total = 0;
    for (;;) {
      const n = this.hub.db.prepare(`DELETE FROM traffic_logs WHERE id IN (${selectIds} LIMIT ${BATCH})`).run(...args).changes;
      total += n;
      if (n < BATCH) return total;
    }
  }
}

/** Reset counters after a project reset: rule and mock hit counts go back to 0. */
export function resetCounters(hub: Hub, projectId: string): { rules: number; mocks: number } {
  const rules = hub.db.prepare('UPDATE rules SET hits = 0 WHERE project_id = ?').run(projectId).changes;
  const mocks = hub.mocks.resetHits(projectId);
  hub.storage?.repo.resetHits(projectId);
  return { rules, mocks };
}

/** "Reset all rules": every test user and provider instance goes back to normal delivery. */
export function resetAllRules(hub: Hub, projectId: string): number {
  return hub.db.prepare('DELETE FROM rules WHERE project_id = ?').run(projectId).changes;
}

/** Delete every project, message, email and log. The HTTPS CA (files in the data dir) is kept. */
export async function factoryReset(hub: Hub): Promise<{ projects: number; messages: number; logs: number; emails: boolean }> {
  const projects = hub.projects.list();
  const counts = hub.db.transaction(() => {
    const messages = (hub.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const logs = (hub.db.prepare('SELECT COUNT(*) AS n FROM traffic_logs').get() as { n: number }).n;
    hub.db.exec('DELETE FROM scheduled_jobs');
    hub.db.exec('DELETE FROM traffic_logs');
    hub.db.exec('DELETE FROM ai_providers'); // global (not under projects): AI chat provider keys
    // Everything else hangs off projects (ON DELETE CASCADE), including tables added by later phases.
    hub.db.exec('DELETE FROM projects');
    return { messages, logs };
  })();
  let emails = true;
  try {
    await hub.mailpit?.deleteAll();
  } catch {
    emails = false;
  }
  hub.maintenance.vacuum();
  for (const p of projects) hub.bus.publish({ type: 'project.deleted', projectId: p.id, data: { slug: p.slug, factoryReset: true } });
  return { projects: projects.length, ...counts, emails };
}
