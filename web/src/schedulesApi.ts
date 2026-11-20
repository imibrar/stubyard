/** Types and helpers of the scheduled-actions API (/api/projects/:slug/schedules). */
import { api } from './api';

export type ScheduleStatus = 'pending' | 'paused' | 'done' | 'failed' | 'cancelled' | 'missed';
export type ScheduleAction = 'webhook.send' | 'webhook.sequence' | 'user.reply' | 'rule.set' | 'rule.clear' | 'mock.scenario';

export const schBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/schedules`;

export interface Schedule {
  id: string;
  projectId: string;
  runId: string | null;
  /** Run key when the schedule belongs to a test run. */
  run: string | null;
  label: string;
  action: ScheduleAction;
  method: string;
  /** Suffix after /api/projects/<slug>. */
  path: string;
  /** Full dashboard API path. */
  url: string;
  body: unknown;
  status: ScheduleStatus;
  nextAt: string | null;
  everyMs: number | null;
  maxFires: number;
  fired: number;
  missed: number;
  lastFiredAt: string | null;
  lastStatus: number | null;
  lastResult: unknown;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FireResult {
  id: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  result: unknown;
}

export interface ScheduleReference {
  actions: ScheduleAction[];
  allowed: { action: ScheduleAction; call: string }[];
  statuses: ScheduleStatus[];
  graceMs: number;
}

/** The REST call a schedule makes later: method + path suffix (or full /api/projects/<slug>/… path) + JSON body. */
export interface ScheduledRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ScheduleOptions {
  delayMs: number;
  everyMs?: number | null;
  maxFires?: number;
  label?: string;
  run?: string | null;
}

export const ACTION_LABEL: Record<ScheduleAction, string> = {
  'webhook.send': 'Send webhook',
  'webhook.sequence': 'Run sequence',
  'user.reply': 'User reply',
  'rule.set': 'Set rule',
  'rule.clear': 'Clear rules',
  'mock.scenario': 'Mock scenario',
};

export const STATUS_KIND: Record<ScheduleStatus, string> = {
  pending: 'accent',
  paused: 'warn',
  done: 'ok',
  failed: 'bad',
  cancelled: '',
  missed: 'warn',
};

export function createSchedule(slug: string, req: ScheduledRequest, o: ScheduleOptions): Promise<Schedule> {
  const q = o.run ? `?run=${encodeURIComponent(o.run)}` : '';
  return api.post<Schedule>(`${schBase(slug)}${q}`, {
    method: req.method,
    path: req.path,
    body: req.body,
    label: o.label || undefined,
    delayMs: o.delayMs,
    everyMs: o.everyMs || undefined,
    maxFires: o.maxFires,
  });
}

/** "in 12s", "in 4m 10s", "in 2h", or "now" / "overdue". */
export function untilText(iso: string | null, now = Date.now()): string {
  if (!iso) return '–';
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return ms > -5000 ? 'now' : 'overdue';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `in ${Math.round(h / 24)}d`;
}

export function everyText(ms: number | null): string {
  if (!ms) return '';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 100) / 10}s`;
}
