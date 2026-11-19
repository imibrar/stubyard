import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';

export type LogOutcome =
  | 'pending'
  | 'ok'
  | 'unmatched'
  | 'invalid'
  | 'rejected'
  | 'forced_error'
  | 'internal_error'
  | 'network_error';

export interface TrafficLog {
  id: string;
  projectId: string | null;
  direction: 'inbound' | 'outbound';
  protocol: 'http' | 'smtp';
  method: string | null;
  url: string | null;
  clientIp: string | null;
  reqHeaders: Record<string, unknown> | null;
  reqBody: string | null;
  reqBodySize: number | null;
  reqTruncated: boolean;
  resStatus: number | null;
  resHeaders: Record<string, unknown> | null;
  resBody: string | null;
  resBodySize: number | null;
  resTruncated: boolean;
  errorType: string | null;
  errorMessage: string | null;
  outcome: LogOutcome;
  resolved: Record<string, unknown>;
  transcript: unknown[] | null;
  parentLogId: string | null;
  receivedAt: string;
  respondedAt: string | null;
  durationMs: number | null;
  /** Test run this request was attributed to (null = none). */
  runId: string | null;
}

/** Compact form for lists (no bodies). */
export type TrafficLogSummary = Omit<TrafficLog, 'reqHeaders' | 'reqBody' | 'resHeaders' | 'resBody' | 'transcript'>;

interface Row {
  id: string;
  project_id: string | null;
  direction: 'inbound' | 'outbound';
  protocol: 'http' | 'smtp';
  method: string | null;
  url: string | null;
  client_ip: string | null;
  req_headers: string | null;
  req_body: string | null;
  req_body_size: number | null;
  req_truncated: number;
  res_status: number | null;
  res_headers: string | null;
  res_body: string | null;
  res_body_size: number | null;
  res_truncated: number;
  error_type: string | null;
  error_message: string | null;
  outcome: LogOutcome;
  resolved: string;
  transcript: string | null;
  parent_log_id: string | null;
  received_at: string;
  responded_at: string | null;
  duration_ms: number | null;
  run_id?: string | null;
}

function toLog(r: Row): TrafficLog {
  return {
    id: r.id,
    projectId: r.project_id,
    direction: r.direction,
    protocol: r.protocol,
    method: r.method,
    url: r.url,
    clientIp: r.client_ip,
    reqHeaders: parseJson(r.req_headers, null),
    reqBody: r.req_body,
    reqBodySize: r.req_body_size,
    reqTruncated: r.req_truncated === 1,
    resStatus: r.res_status,
    resHeaders: parseJson(r.res_headers, null),
    resBody: r.res_body,
    resBodySize: r.res_body_size,
    resTruncated: r.res_truncated === 1,
    errorType: r.error_type,
    errorMessage: r.error_message,
    outcome: r.outcome,
    resolved: parseJson(r.resolved, {}),
    transcript: parseJson(r.transcript, null),
    parentLogId: r.parent_log_id,
    receivedAt: r.received_at,
    respondedAt: r.responded_at,
    durationMs: r.duration_ms,
    runId: r.run_id ?? null,
  };
}

export function summarize(l: TrafficLog): TrafficLogSummary {
  const { reqHeaders: _a, reqBody: _b, resHeaders: _c, resBody: _d, transcript: _e, ...rest } = l;
  return rest;
}

export interface LogStart {
  projectId?: string | null;
  direction: 'inbound' | 'outbound';
  protocol: 'http' | 'smtp';
  method?: string | null;
  url?: string | null;
  clientIp?: string | null;
  reqHeaders?: Record<string, unknown> | null;
  parentLogId?: string | null;
  resolved?: Record<string, unknown>;
  receivedAt?: string;
  runId?: string | null;
}

export interface LogPatch {
  projectId?: string | null;
  reqHeaders?: Record<string, unknown> | null;
  reqBody?: string | null;
  reqBodySize?: number | null;
  reqTruncated?: boolean;
  resStatus?: number | null;
  resHeaders?: Record<string, unknown> | null;
  resBody?: string | null;
  resBodySize?: number | null;
  resTruncated?: boolean;
  errorType?: string | null;
  errorMessage?: string | null;
  outcome?: LogOutcome;
  resolved?: Record<string, unknown>;
  transcript?: unknown[] | null;
  respondedAt?: string | null;
  durationMs?: number | null;
  runId?: string | null;
}

const COLUMN: Record<keyof LogPatch, string> = {
  projectId: 'project_id',
  reqHeaders: 'req_headers',
  reqBody: 'req_body',
  reqBodySize: 'req_body_size',
  reqTruncated: 'req_truncated',
  resStatus: 'res_status',
  resHeaders: 'res_headers',
  resBody: 'res_body',
  resBodySize: 'res_body_size',
  resTruncated: 'res_truncated',
  errorType: 'error_type',
  errorMessage: 'error_message',
  outcome: 'outcome',
  resolved: 'resolved',
  transcript: 'transcript',
  respondedAt: 'responded_at',
  durationMs: 'duration_ms',
  runId: 'run_id',
};

const JSON_FIELDS = new Set<keyof LogPatch>(['reqHeaders', 'resHeaders', 'resolved', 'transcript']);

export interface LogQuery {
  projectId?: string;
  /** Only logs without a project (e.g. unknown project slug). */
  noProject?: boolean;
  direction?: 'inbound' | 'outbound';
  protocol?: 'http' | 'smtp';
  outcome?: string;
  status?: number;
  q?: string;
  before?: string;
  limit?: number;
  /** Logs that involved this test user (resolved.testUserIds). */
  testUserId?: string;
  /** Logs handled by this provider instance slug (resolved.instance). */
  instance?: string;
  /** Logs attributed to this test run. */
  runId?: string;
}

export class LogRepo {
  constructor(private db: DB) {}

  /** Insert the log row immediately when a request arrives ("record first, then respond"). */
  start(s: LogStart): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO traffic_logs (id, project_id, direction, protocol, method, url, client_ip, req_headers, resolved, parent_log_id, received_at, outcome, run_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`,
      )
      .run(
        id, s.projectId ?? null, s.direction, s.protocol, s.method ?? null, s.url ?? null, s.clientIp ?? null,
        s.reqHeaders ? JSON.stringify(s.reqHeaders) : null, JSON.stringify(s.resolved ?? {}), s.parentLogId ?? null,
        s.receivedAt ?? nowIso(), s.runId ?? null,
      );
    return id;
  }

  update(id: string, patch: LogPatch): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof LogPatch, unknown][]) {
      if (v === undefined) continue;
      sets.push(`${COLUMN[k]} = ?`);
      if (JSON_FIELDS.has(k)) args.push(v === null ? null : JSON.stringify(v));
      else if (typeof v === 'boolean') args.push(v ? 1 : 0);
      else args.push(v);
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE traffic_logs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** Merge keys into the "resolved" JSON (project, user, instance, rule…). */
  mergeResolved(id: string, extra: Record<string, unknown>): void {
    const cur = this.get(id);
    if (!cur) return;
    this.update(id, { resolved: { ...cur.resolved, ...extra } });
  }

  get(id: string): TrafficLog | null {
    const r = this.db.prepare('SELECT * FROM traffic_logs WHERE id = ?').get(id) as Row | undefined;
    return r ? toLog(r) : null;
  }

  list(q: LogQuery = {}): TrafficLogSummary[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.projectId) {
      where.push('project_id = ?');
      args.push(q.projectId);
    }
    if (q.noProject) where.push('project_id IS NULL');
    if (q.direction) {
      where.push('direction = ?');
      args.push(q.direction);
    }
    if (q.protocol) {
      where.push('protocol = ?');
      args.push(q.protocol);
    }
    if (q.outcome) {
      where.push('outcome = ?');
      args.push(q.outcome);
    }
    if (q.status) {
      where.push('res_status = ?');
      args.push(q.status);
    }
    if (q.testUserId) {
      where.push("EXISTS (SELECT 1 FROM json_each(traffic_logs.resolved, '$.testUserIds') WHERE value = ?)");
      args.push(q.testUserId);
    }
    if (q.instance) {
      where.push("json_extract(resolved, '$.instance') = ?");
      args.push(q.instance);
    }
    if (q.runId) {
      where.push('run_id = ?');
      args.push(q.runId);
    }
    if (q.before) {
      where.push('id < ?');
      args.push(q.before);
    }
    if (q.q) {
      where.push('(url LIKE ? OR req_body LIKE ? OR res_body LIKE ? OR error_message LIKE ? OR resolved LIKE ?)');
      const like = `%${q.q}%`;
      args.push(like, like, like, like, like);
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const sql = `SELECT * FROM traffic_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => summarize(toLog(r)));
  }

  deleteForRun(runId: string): number {
    return this.db.prepare('DELETE FROM traffic_logs WHERE run_id = ?').run(runId).changes;
  }

  deleteForProject(projectId: string): number {
    return this.db.prepare('DELETE FROM traffic_logs WHERE project_id = ?').run(projectId).changes;
  }
}
