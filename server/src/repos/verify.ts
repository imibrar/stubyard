import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import { nowIso, parseJson } from '../util.js';

/** A Twilio Verify service (VA…). */
export interface VerifyServiceRow {
  id: string;
  projectId: string;
  providerInstanceId: string;
  friendlyName: string;
  codeLength: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SendAttempt {
  attempt_sid: string;
  channel: string;
  time: string;
  /** stubyard message id of the delivered code. */
  messageId?: string | null;
}

/** One verification (Twilio VE…, Vonage request_id). */
export interface Verification {
  id: string;
  projectId: string;
  providerInstanceId: string;
  kind: 'twilio' | 'vonage';
  serviceId: string | null;
  to: string;
  channel: string;
  code: string;
  /** Twilio: pending, approved, canceled, max_attempts_reached, expired, failed. Vonage: pending, completed, failed, expired, cancelled. */
  status: string;
  sendAttempts: SendAttempt[];
  checkAttempts: number;
  messageIds: string[];
  params: Record<string, unknown>;
  runId: string | null;
  logId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface VRow {
  id: string;
  project_id: string;
  provider_instance_id: string;
  kind: 'twilio' | 'vonage';
  service_id: string | null;
  to_addr: string;
  channel: string;
  code: string;
  status: string;
  send_attempts: string;
  check_attempts: number;
  message_ids: string;
  params: string;
  run_id: string | null;
  log_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const toV = (r: VRow): Verification => ({
  id: r.id,
  projectId: r.project_id,
  providerInstanceId: r.provider_instance_id,
  kind: r.kind,
  serviceId: r.service_id,
  to: r.to_addr,
  channel: r.channel,
  code: r.code,
  status: r.status,
  sendAttempts: parseJson<SendAttempt[]>(r.send_attempts, []),
  checkAttempts: r.check_attempts,
  messageIds: parseJson<string[]>(r.message_ids, []),
  params: parseJson<Record<string, unknown>>(r.params, {}),
  runId: r.run_id,
  logId: r.log_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
});

export class VerifyRepo {
  constructor(private db: DB) {}

  // ---------- services ----------
  createService(s: Omit<VerifyServiceRow, 'createdAt' | 'updatedAt'>): VerifyServiceRow {
    const now = nowIso();
    this.db
      .prepare('INSERT INTO verify_services (id, project_id, provider_instance_id, friendly_name, code_length, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.id, s.projectId, s.providerInstanceId, s.friendlyName, s.codeLength, JSON.stringify(s.config), now, now);
    return this.getService(s.providerInstanceId, s.id)!;
  }

  getService(instanceId: string, id: string): VerifyServiceRow | null {
    const r = this.db.prepare('SELECT * FROM verify_services WHERE provider_instance_id = ? AND id = ?').get(instanceId, id) as Record<string, unknown> | undefined;
    return r ? this.toService(r) : null;
  }

  listServices(instanceId: string): VerifyServiceRow[] {
    return (this.db.prepare('SELECT * FROM verify_services WHERE provider_instance_id = ? ORDER BY created_at').all(instanceId) as Record<string, unknown>[]).map((r) => this.toService(r));
  }

  updateService(instanceId: string, id: string, patch: { friendlyName?: string; codeLength?: number; config?: Record<string, unknown> }): VerifyServiceRow | null {
    const s = this.getService(instanceId, id);
    if (!s) return null;
    this.db
      .prepare('UPDATE verify_services SET friendly_name = ?, code_length = ?, config = ?, updated_at = ? WHERE id = ?')
      .run(patch.friendlyName ?? s.friendlyName, patch.codeLength ?? s.codeLength, JSON.stringify({ ...s.config, ...(patch.config ?? {}) }), nowIso(), id);
    return this.getService(instanceId, id);
  }

  deleteService(instanceId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM verify_services WHERE provider_instance_id = ? AND id = ?').run(instanceId, id).changes > 0;
  }

  private toService(r: Record<string, unknown>): VerifyServiceRow {
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      providerInstanceId: String(r.provider_instance_id),
      friendlyName: String(r.friendly_name),
      codeLength: Number(r.code_length),
      config: parseJson<Record<string, unknown>>(r.config as string, {}),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  // ---------- verifications ----------
  insert(v: Omit<Verification, 'createdAt' | 'updatedAt'>): Verification {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO verifications (id, project_id, provider_instance_id, kind, service_id, to_addr, channel, code, status, send_attempts,
           check_attempts, message_ids, params, run_id, log_id, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        v.id, v.projectId, v.providerInstanceId, v.kind, v.serviceId, v.to, v.channel, v.code, v.status, JSON.stringify(v.sendAttempts),
        v.checkAttempts, JSON.stringify(v.messageIds), JSON.stringify(v.params), v.runId, v.logId, now, now, v.expiresAt,
      );
    return this.get(v.id)!;
  }

  get(id: string): Verification | null {
    const r = this.db.prepare('SELECT * FROM verifications WHERE id = ?').get(id) as VRow | undefined;
    return r ? toV(r) : null;
  }

  /** Newest pending verification for a recipient (Twilio: within one service). */
  findPending(instanceId: string, to: string, serviceId: string | null): Verification | null {
    const r = (
      serviceId
        ? this.db.prepare("SELECT * FROM verifications WHERE provider_instance_id = ? AND to_addr = ? AND service_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(instanceId, to, serviceId)
        : this.db.prepare("SELECT * FROM verifications WHERE provider_instance_id = ? AND to_addr = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(instanceId, to)
    ) as VRow | undefined;
    return r ? toV(r) : null;
  }

  update(id: string, patch: Partial<Pick<Verification, 'status' | 'sendAttempts' | 'checkAttempts' | 'messageIds' | 'params' | 'channel' | 'code'>>): Verification | null {
    const v = this.get(id);
    if (!v) return null;
    const n = { ...v, ...patch };
    this.db
      .prepare('UPDATE verifications SET status = ?, send_attempts = ?, check_attempts = ?, message_ids = ?, params = ?, channel = ?, code = ?, updated_at = ? WHERE id = ?')
      .run(n.status, JSON.stringify(n.sendAttempts), n.checkAttempts, JSON.stringify(n.messageIds), JSON.stringify(n.params), n.channel, n.code, nowIso(), id);
    return this.get(id);
  }

  list(projectId: string, limit = 50): Verification[] {
    return (this.db.prepare('SELECT * FROM verifications WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as VRow[]).map(toV);
  }
}

export interface MediaInfo {
  id: string;
  projectId: string;
  providerInstanceId: string;
  mimeType: string;
  sha256: string;
  fileSize: number;
  filename: string | null;
  createdAt: string;
}

/** WhatsApp media uploaded with POST /<version>/<phone-number-id>/media (kept small, in the DB). */
export class MediaRepo {
  constructor(private db: DB) {}

  insert(m: { id: string; projectId: string; providerInstanceId: string; mimeType: string; filename: string | null; data: Buffer }): MediaInfo {
    const sha256 = createHash('sha256').update(m.data).digest('hex');
    this.db
      .prepare('INSERT INTO wa_media (id, project_id, provider_instance_id, mime_type, sha256, file_size, filename, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(m.id, m.projectId, m.providerInstanceId, m.mimeType, sha256, m.data.length, m.filename, new Uint8Array(m.data), nowIso());
    return this.info(m.providerInstanceId, m.id)!;
  }

  info(instanceId: string, id: string): MediaInfo | null {
    const r = this.db
      .prepare('SELECT id, project_id, provider_instance_id, mime_type, sha256, file_size, filename, created_at FROM wa_media WHERE provider_instance_id = ? AND id = ?')
      .get(instanceId, id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      providerInstanceId: String(r.provider_instance_id),
      mimeType: String(r.mime_type),
      sha256: String(r.sha256),
      fileSize: Number(r.file_size),
      filename: r.filename === null ? null : String(r.filename),
      createdAt: String(r.created_at),
    };
  }

  data(instanceId: string, id: string): Buffer | null {
    const r = this.db.prepare('SELECT data FROM wa_media WHERE provider_instance_id = ? AND id = ?').get(instanceId, id) as { data: Uint8Array } | undefined;
    return r ? Buffer.from(r.data) : null;
  }

  delete(instanceId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM wa_media WHERE provider_instance_id = ? AND id = ?').run(instanceId, id).changes > 0;
  }

  /** Retention: drop media older than `beforeIso`. */
  purgeOlderThan(beforeIso: string): number {
    return this.db.prepare('DELETE FROM wa_media WHERE created_at < ?').run(beforeIso).changes;
  }
}
