import type { DB } from '../db/index.js';
import type { Channel } from '../providers/catalog.js';
import { newId, nowIso, parseJson } from '../util.js';

export interface Message {
  id: string;
  projectId: string;
  testUserId: string | null;
  providerInstanceId: string | null;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  from: string | null;
  to: string;
  subject: string | null;
  bodyText: string | null;
  hasHtml: boolean;
  attachments: number;
  mailpitId: string | null;
  messageIdHeader: string | null;
  status: string;
  statusDetail: string | null;
  appliedRule: unknown;
  otp: string | null;
  links: string[];
  duplicateOfId: string | null;
  logId: string | null;
  /** The provider's id for this message (Twilio SM…, wamid…, Vonage message-id). */
  providerMessageId: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  project_id: string;
  test_user_id: string | null;
  provider_instance_id: string | null;
  channel: Channel;
  direction: 'outbound' | 'inbound';
  from_addr: string | null;
  to_addr: string;
  subject: string | null;
  body_text: string | null;
  has_html: number;
  attachments: number;
  mailpit_id: string | null;
  message_id_header: string | null;
  status: string;
  status_detail: string | null;
  applied_rule: string | null;
  otp: string | null;
  links: string;
  duplicate_of_id: string | null;
  log_id: string | null;
  provider_message_id: string | null;
  metadata: string;
  read_at: string | null;
  created_at: string;
}

function toMessage(r: Row): Message {
  return {
    id: r.id,
    projectId: r.project_id,
    testUserId: r.test_user_id,
    providerInstanceId: r.provider_instance_id,
    channel: r.channel,
    direction: r.direction,
    from: r.from_addr,
    to: r.to_addr,
    subject: r.subject,
    bodyText: r.body_text,
    hasHtml: r.has_html === 1,
    attachments: r.attachments,
    mailpitId: r.mailpit_id,
    messageIdHeader: r.message_id_header,
    status: r.status,
    statusDetail: r.status_detail,
    appliedRule: parseJson<unknown>(r.applied_rule, null),
    otp: r.otp,
    links: parseJson<string[]>(r.links, []),
    duplicateOfId: r.duplicate_of_id,
    logId: r.log_id,
    providerMessageId: r.provider_message_id ?? null,
    metadata: parseJson<Record<string, unknown>>(r.metadata, {}),
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export type NewMessage = Omit<Message, 'id' | 'createdAt' | 'readAt' | 'duplicateOfId' | 'appliedRule' | 'statusDetail' | 'metadata' | 'providerMessageId'> & {
  providerMessageId?: string | null;
  appliedRule?: unknown;
  statusDetail?: string | null;
  metadata?: Record<string, unknown>;
  duplicateOfId?: string | null;
};

/** Statuses where the user actually got the message (codes from other messages are not usable). */
export const RECEIVED_STATUSES = ['delivered', 'complained', 'received'];
const RECEIVED_SQL = RECEIVED_STATUSES.map((s) => `'${s}'`).join(',');

export interface MessageQuery {
  testUserId?: string;
  unassigned?: boolean;
  channel?: Channel;
  providerInstanceId?: string;
  since?: string;
  q?: string;
  limit?: number;
  before?: string;
  /** Only messages with an id greater than this (newer). */
  after?: string;
  /** Only messages where an OTP was detected. */
  hasOtp?: boolean;
  /** Exact recipient (already normalized). */
  to?: string;
  status?: string;
}

export class MessageRepo {
  constructor(private db: DB) {}

  insert(m: NewMessage): Message {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO messages (id, project_id, test_user_id, provider_instance_id, channel, direction, from_addr, to_addr, subject,
           body_text, has_html, attachments, mailpit_id, message_id_header, status, status_detail, applied_rule, otp, links,
           duplicate_of_id, log_id, provider_message_id, metadata, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, m.projectId, m.testUserId, m.providerInstanceId, m.channel, m.direction, m.from, m.to, m.subject,
        m.bodyText, m.hasHtml ? 1 : 0, m.attachments, m.mailpitId, m.messageIdHeader, m.status, m.statusDetail ?? null,
        m.appliedRule === undefined ? null : JSON.stringify(m.appliedRule), m.otp, JSON.stringify(m.links),
        m.duplicateOfId ?? null, m.logId, m.providerMessageId ?? null, JSON.stringify(m.metadata ?? {}), nowIso(),
      );
    return this.get(id)!;
  }

  /** Update delivery status (and optionally merge metadata). Returns the updated message. */
  updateStatus(id: string, patch: { status?: string; statusDetail?: string | null; metadata?: Record<string, unknown> }): Message | null {
    const m = this.get(id);
    if (!m) return null;
    const metadata = patch.metadata ? { ...m.metadata, ...patch.metadata } : m.metadata;
    this.db
      .prepare('UPDATE messages SET status = ?, status_detail = ?, metadata = ? WHERE id = ?')
      .run(patch.status ?? m.status, patch.statusDetail !== undefined ? patch.statusDetail : m.statusDetail, JSON.stringify(metadata), id);
    return this.get(id);
  }

  findByProviderId(projectId: string, providerMessageId: string): Message | null {
    const r = this.db
      .prepare('SELECT * FROM messages WHERE project_id = ? AND provider_message_id = ? ORDER BY id DESC LIMIT 1')
      .get(projectId, providerMessageId) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /**
   * A recent message with the same body to the same user on the same channel but through another instance that
   * was accepted (delivered / on its way): the classic "fallback fired although the primary only was slow" bug.
   * A fallback after a rejected or failed attempt is correct behaviour and is not flagged.
   */
  findDuplicate(m: { projectId: string; testUserId: string | null; channel: Channel; bodyText: string | null; providerInstanceId: string | null }, sinceIso: string): Message | null {
    if (!m.testUserId || !m.bodyText) return null;
    const r = this.db
      .prepare(
        `SELECT * FROM messages WHERE project_id = ? AND test_user_id = ? AND channel = ? AND body_text = ? AND created_at >= ?
           AND direction = 'outbound' AND status IN ('delivered', 'scheduled', 'complained')
           AND COALESCE(provider_instance_id, '') != COALESCE(?, '') ORDER BY id DESC LIMIT 1`,
      )
      .get(m.projectId, m.testUserId, m.channel, m.bodyText, sinceIso, m.providerInstanceId) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  get(id: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }

  list(projectId: string, q: MessageQuery = {}): Message[] {
    const where = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (q.testUserId) {
      where.push('test_user_id = ?');
      args.push(q.testUserId);
    }
    if (q.unassigned) where.push('test_user_id IS NULL');
    if (q.channel) {
      where.push('channel = ?');
      args.push(q.channel);
    }
    if (q.providerInstanceId) {
      where.push('provider_instance_id = ?');
      args.push(q.providerInstanceId);
    }
    if (q.since) {
      where.push('created_at >= ?');
      args.push(q.since);
    }
    if (q.before) {
      where.push('id < ?');
      args.push(q.before);
    }
    if (q.after) {
      where.push('id > ?');
      args.push(q.after);
    }
    if (q.hasOtp) where.push(`otp IS NOT NULL AND status IN (${RECEIVED_SQL})`);
    if (q.status) {
      where.push('status = ?');
      args.push(q.status);
    }
    if (q.to) {
      where.push('to_addr = ?');
      args.push(q.to);
    }
    if (q.q) {
      where.push("(to_addr LIKE ? OR from_addr LIKE ? OR subject LIKE ? OR body_text LIKE ?)");
      const like = `%${q.q}%`;
      args.push(like, like, like, like);
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    return (
      this.db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all(...args) as Row[]
    ).map(toMessage);
  }

  /** Does a message match a query? Used by the wait API on freshly created messages. */
  matches(m: Message, projectId: string, q: MessageQuery): boolean {
    if (m.projectId !== projectId) return false;
    if (q.testUserId && m.testUserId !== q.testUserId) return false;
    if (q.unassigned && m.testUserId !== null) return false;
    if (q.channel && m.channel !== q.channel) return false;
    if (q.providerInstanceId && m.providerInstanceId !== q.providerInstanceId) return false;
    if (q.since && m.createdAt < q.since) return false;
    if (q.after && m.id <= q.after) return false;
    if (q.hasOtp && (!m.otp || !RECEIVED_STATUSES.includes(m.status))) return false;
    if (q.status && m.status !== q.status) return false;
    if (q.to && m.to !== q.to) return false;
    if (q.q) {
      const needle = q.q.toLowerCase();
      if (![m.to, m.from, m.subject, m.bodyText].some((v) => v?.toLowerCase().includes(needle))) return false;
    }
    return true;
  }

  /** Per test user: time of the latest message and the latest detected code. */
  latestPerUser(projectId: string): Map<string, { at: string; otp: string | null; otpAt: string | null; otpChannel: Channel | null }> {
    const out = new Map<string, { at: string; otp: string | null; otpAt: string | null; otpChannel: Channel | null }>();
    const last = this.db
      .prepare('SELECT test_user_id, MAX(created_at) AS at FROM messages WHERE project_id = ? AND test_user_id IS NOT NULL GROUP BY test_user_id')
      .all(projectId) as { test_user_id: string; at: string }[];
    for (const r of last) out.set(r.test_user_id, { at: r.at, otp: null, otpAt: null, otpChannel: null });
    // SQLite returns the other columns from the row that has MAX(id).
    const otps = this.db
      .prepare(
        `SELECT test_user_id, MAX(id) AS id, otp, created_at, channel FROM messages
         WHERE project_id = ? AND test_user_id IS NOT NULL AND otp IS NOT NULL AND status IN (${RECEIVED_SQL}) GROUP BY test_user_id`,
      )
      .all(projectId) as { test_user_id: string; otp: string; created_at: string; channel: Channel }[];
    for (const r of otps) {
      const e = out.get(r.test_user_id);
      if (e) Object.assign(e, { otp: r.otp, otpAt: r.created_at, otpChannel: r.channel });
    }
    return out;
  }

  /** Unread counts per test user and channel (null user = Unassigned). */
  unreadCounts(projectId: string): { testUserId: string | null; channel: Channel; unread: number; total: number }[] {
    return (
      this.db
        .prepare(
          `SELECT test_user_id, channel, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, COUNT(*) AS total
           FROM messages WHERE project_id = ? GROUP BY test_user_id, channel`,
        )
        .all(projectId) as { test_user_id: string | null; channel: Channel; unread: number; total: number }[]
    ).map((r) => ({ testUserId: r.test_user_id, channel: r.channel, unread: r.unread, total: r.total }));
  }

  markRead(projectId: string, opts: { testUserId?: string | null; ids?: string[] }): number {
    const now = nowIso();
    if (opts.ids?.length) {
      const stmt = this.db.prepare('UPDATE messages SET read_at = ? WHERE project_id = ? AND id = ? AND read_at IS NULL');
      let n = 0;
      for (const id of opts.ids) n += stmt.run(now, projectId, id).changes;
      return n;
    }
    if (opts.testUserId === null) {
      return this.db.prepare('UPDATE messages SET read_at = ? WHERE project_id = ? AND test_user_id IS NULL AND read_at IS NULL').run(now, projectId).changes;
    }
    return this.db
      .prepare('UPDATE messages SET read_at = ? WHERE project_id = ? AND test_user_id = ? AND read_at IS NULL')
      .run(now, projectId, opts.testUserId).changes;
  }

  /** Delete messages; returns the Mailpit ids that are no longer referenced by any message. */
  delete(projectId: string, opts: { testUserId?: string | null } = {}): { deleted: number; orphanMailpitIds: string[] } {
    return this.db.transaction(() => {
      let where = 'project_id = ?';
      const args: unknown[] = [projectId];
      if (opts.testUserId === null) where += ' AND test_user_id IS NULL';
      else if (opts.testUserId) {
        where += ' AND test_user_id = ?';
        args.push(opts.testUserId);
      }
      const candidates = (
        this.db.prepare(`SELECT DISTINCT mailpit_id FROM messages WHERE ${where} AND mailpit_id IS NOT NULL`).all(...args) as { mailpit_id: string }[]
      ).map((r) => r.mailpit_id);
      const deleted = this.db.prepare(`DELETE FROM messages WHERE ${where}`).run(...args).changes;
      const stillUsed = this.db.prepare('SELECT 1 FROM messages WHERE mailpit_id = ? LIMIT 1');
      const orphanMailpitIds = candidates.filter((id) => !stillUsed.get(id));
      return { deleted, orphanMailpitIds };
    })();
  }

  allMailpitIds(projectId: string): string[] {
    return (
      this.db.prepare('SELECT DISTINCT mailpit_id FROM messages WHERE project_id = ? AND mailpit_id IS NOT NULL').all(projectId) as { mailpit_id: string }[]
    ).map((r) => r.mailpit_id);
  }
}
