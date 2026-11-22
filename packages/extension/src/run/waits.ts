// Long waits shared by the side panel and the on-page widget (docs/design/floating-widget.md, phase 1b): the 2FA code
// wait of a login step and the message wait of an email step. Their resume state lives in the hub's step data
// (step.data.twoFactorPending / step.data.emailWaitPending, final decision 5), not in chrome.storage: the walkthrough
// record is the single source of truth, so every view sees the same owner. No heartbeat: a wait has an owner (the
// view that started it), an id, the tab it acts on and a deadline. The owner runs it; a widget page that reloaded or
// navigated resumes its own wait; any other view only shows "Waiting in …" and can take it over.
import type { StepSurface } from './host';

export type WaitKind = '2fa' | 'email';

/** The step-data key of each wait (shallow-merged by the hub; null clears it). */
export const WAIT_DATA_KEY: Record<WaitKind, string> = { '2fa': 'twoFactorPending', email: 'emailWaitPending' };

export interface PendingWait {
  /** Unique per start (a take-over gets a new id, so the old owner knows it lost the wait). */
  id: string;
  /** The view that runs it. */
  owner: StepSurface;
  /** The tab it acts on (the widget's own tab; for the panel the tab that was active when it started). */
  tabId: number;
  /** The window of the owner (a panel resumes only its own window's waits). */
  windowId: number;
  startedAt: number;
  /** The deadline (ms since the epoch): after it the wait is over, whatever the data says. */
  until: number;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The pending wait stored in step data, or null (none, cleared, or malformed). */
export function parsePending(v: unknown): PendingWait | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const tabId = num(o.tabId);
  const windowId = num(o.windowId);
  const startedAt = num(o.startedAt);
  const until = num(o.until);
  if (typeof o.id !== 'string' || !o.id || (o.owner !== 'panel' && o.owner !== 'widget')) return null;
  if (tabId === null || windowId === null || startedAt === null || until === null) return null;
  return { id: o.id, owner: o.owner, tabId, windowId, startedAt, until };
}

/** The pending wait of a kind in a step's data. */
export const pendingOf = (data: Record<string, unknown> | null | undefined, kind: WaitKind): PendingWait | null => parsePending(data?.[WAIT_DATA_KEY[kind]]);

export function newPending(o: { owner: StepSurface; tabId: number; windowId: number; now: number; ms: number; id?: string }): PendingWait {
  const id = o.id ?? (globalThis.crypto?.randomUUID?.() ?? `w-${o.now}-${Math.random().toString(36).slice(2)}`);
  return { id, owner: o.owner, tabId: o.tabId, windowId: o.windowId, startedAt: o.now, until: o.now + o.ms };
}

/**
 * What a view does with a step's pending wait:
 *  - none: there is none (or it is past its deadline);
 *  - mine: this view is running it right now;
 *  - resume: it belongs to this view (the widget of the same tab after a reload or a navigation; the panel of the same
 *    window after it was reopened) and nobody runs it here: continue it;
 *  - elsewhere: another view owns it: show "Waiting in …", never wait or fill as well.
 */
export type WaitRole = 'none' | 'mine' | 'resume' | 'elsewhere';

export function waitRole(p: PendingWait | null, me: { surface: StepSurface; tabId: number | null; windowId: number; runningId: string | null }, now: number): WaitRole {
  if (!p || now > p.until) return 'none';
  if (me.runningId === p.id) return 'mine';
  if (p.owner !== me.surface) return 'elsewhere';
  if (me.surface === 'widget') return me.tabId === p.tabId ? 'resume' : 'elsewhere';
  return me.windowId === p.windowId ? 'resume' : 'elsewhere';
}

/** Whether `seen` is a newer wait that replaced `mine` (a take-over): a stale reload showing an older state is not. */
export const supersedes = (seen: PendingWait | null, mine: PendingWait): boolean => !!seen && seen.id !== mine.id && seen.startedAt >= mine.startedAt;

/** Where another view's wait runs, for "Waiting … in <where>". */
export const ownerLabel = (p: PendingWait, me: { tabId: number | null }): string =>
  p.owner === 'panel' ? 'the side panel' : me.tabId !== null && me.tabId !== p.tabId ? "another tab's page widget" : 'the page widget';
