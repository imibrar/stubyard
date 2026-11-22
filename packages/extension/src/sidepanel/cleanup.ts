// Cleanup of the test data a run created (fresh users and their messages; a quick run's record): the REST shapes of
// spec-cleanup.md and the pure view-model helpers of the Cleanup screen and the "Clean up this run" section
// (no chrome.*, no fetch): unit-tested in test/cleanup.test.ts.
import { StubyardError } from '@stubyard/client/http';
import type { RunMode, WalkthroughStatus, WalkthroughView } from '@stubyard/client/storyboard-types';

// ---------------------------------------------------------------------------------------------------------------
// Shapes (same as server/src/storyboards/types.ts)

export type CleanupStatus = 'none' | 'pending' | 'cleaned' | 'dismissed';
export type CleanupStatusFilter = 'pending' | 'cleaned' | 'dismissed' | 'all';
export type CleanupModeFilter = 'all' | 'quick' | 'tracked';
export type OnConflict = 'ask' | 'keep' | 'include';

export interface CleanupRunRef {
  id: string;
  key: string;
  label: string;
  status: WalkthroughStatus;
  mode: RunMode;
  storyboard: { slug: string; name: string } | null;
}

export interface CleanupUser {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  /** false = already deleted (nothing to do). */
  exists: boolean;
  /** Keep pin: never deleted by cleanup. */
  keep: boolean;
  /** Messages in this user's inbox. */
  messages: number;
  /** Other runs that still need this user. */
  usedBy: CleanupRunRef[];
}

export interface CleanupItem {
  walkthrough: CleanupRunRef & { cleanupStatus: CleanupStatus; cleanupAt: string | null; startedAt: string; finishedAt: string | null };
  users: CleanupUser[];
  /** Captured values: information only, not removed by stubyard. */
  vars: Record<string, string>;
  /** Runs whose data this run reused. */
  uses: CleanupRunRef[];
  /** What a cleanup with defaults would remove now. */
  removable: { users: number; messages: number; record: boolean };
  warnings: string[];
  lastReport: CleanupRunResult | null;
}

export interface CleanupKept {
  userId: string;
  email: string | null;
  reason: 'keep' | 'skipped' | 'used-by' | 'used-by-active';
  usedBy?: CleanupRunRef[];
}

export interface CleanupRunResult {
  id: string;
  key: string;
  label: string;
  mode: RunMode;
  status: 'cleaned' | 'partial';
  removed: { users: number; messages: number; record: boolean };
  kept: CleanupKept[];
  vars: Record<string, string>;
}

export interface CleanupConflict {
  userId: string;
  email: string | null;
  walkthrough: CleanupRunRef;
  usedBy: CleanupRunRef[];
}

export interface CleanupResult {
  dryRun: boolean;
  runs: CleanupRunResult[];
  /** Only non-empty in a dryRun, or on the 409 body. */
  conflicts: CleanupConflict[];
  totals: { users: number; messages: number; records: number };
}

export interface CleanupList {
  items: CleanupItem[];
  counts: { pending: number; active: number; cleaned: number; dismissed: number };
  /** true when the 500-item cap cut the list. */
  truncated?: boolean;
}

export interface CleanupBody {
  walkthroughs: string[];
  skipUsers?: string[];
  onConflict?: OnConflict;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Labels

/** The run's name in lists: its label, else the storyboard name, else its key. */
export const runTitle = (r: Pick<CleanupRunRef, 'label' | 'key' | 'storyboard'>): string => r.label.trim() || r.storyboard?.name || r.key;

/** "Ada (ada@x.test)" style name of a user, or the email alone when the name is empty. */
export const userLabel = (u: { name?: string; email: string | null; userId: string }): string =>
  u.name && u.email ? `${u.name} (${u.email})` : (u.email || u.name || u.userId);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 users · 5 messages · record" for what a cleanup removes; "nothing" when it is all zero. */
export function amountText(a: { users: number; messages: number; record?: boolean; records?: number }): string {
  const parts: string[] = [];
  if (a.users) parts.push(plural(a.users, 'user'));
  if (a.messages) parts.push(plural(a.messages, 'message'));
  if (a.record) parts.push('run record');
  if (a.records) parts.push(plural(a.records, 'run record'));
  return parts.length ? parts.join(' · ') : 'nothing';
}

/** The Home entry: "Clean up · N" when something is pending, else null (no entry). */
export const cleanupEntryLabel = (counts: CleanupList['counts'] | null | undefined): string | null =>
  counts && counts.pending > 0 ? `Clean up · ${counts.pending}` : null;

const refList = (runs: CleanupRunRef[]) => runs.map((r) => r.key).join(', ');

/** Why a user was kept, for the report. */
export function keptReason(k: CleanupKept): string {
  switch (k.reason) {
    case 'keep':
      return 'pinned with Keep';
    case 'skipped':
      return 'unchecked by you';
    case 'used-by':
      return `still used by ${refList(k.usedBy ?? []) || 'another run'}`;
    case 'used-by-active':
      return `still used by active run ${refList(k.usedBy ?? []) || ''}`.trim();
  }
}

/** "user x is also used by run K" lines of a conflict dialog, one per conflict. */
export function conflictLines(conflicts: CleanupConflict[]): string[] {
  return conflicts.map((c) => {
    const by = c.usedBy.map((r) => `${r.key}${runTitle(r) !== r.key ? ` (${runTitle(r)})` : ''}`).join(', ');
    return `${c.email ?? c.userId} (from ${c.walkthrough.key}) is also used by run${c.usedBy.length === 1 ? '' : 's'} ${by}`;
  });
}

/** A one-line result for a toast: "Removed 2 users · 5 messages; 1 run partly cleaned". */
export function resultSummary(r: CleanupResult): string {
  const partial = r.runs.filter((x) => x.status === 'partial').length;
  const kept = r.runs.reduce((n, x) => n + x.kept.length, 0);
  let s = `Removed ${amountText(r.totals)}`;
  if (kept) s += `; kept ${plural(kept, 'user')}`;
  if (partial) s += `; ${plural(partial, 'run')} partly cleaned`;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Selection (runs to clean and users to skip)

export interface CleanupSelection {
  /** Selected walkthrough ids. */
  runs: string[];
  /** User ids unchecked by the user (sent as skipUsers). */
  skip: string[];
}

export const EMPTY_SELECTION: CleanupSelection = { runs: [], skip: [] };

const toggle = (list: string[], id: string, on?: boolean): string[] => {
  const has = list.includes(id);
  const want = on ?? !has;
  return want === has ? list : want ? [...list, id] : list.filter((x) => x !== id);
};

export function toggleRun(s: CleanupSelection, id: string, on?: boolean): CleanupSelection {
  const runs = toggle(s.runs, id, on);
  return runs === s.runs ? s : { ...s, runs };
}

/** Toggle a user's checkbox (`on` = will be deleted). */
export function toggleUser(s: CleanupSelection, userId: string, on?: boolean): CleanupSelection {
  const skip = toggle(s.skip, userId, on === undefined ? undefined : !on);
  return skip === s.skip ? s : { ...s, skip };
}

/** Whether a user has a checkbox at all: it exists and is not keep-pinned. */
export const isDeletableUser = (u: CleanupUser): boolean => u.exists && !u.keep;

/**
 * Whether a run can be selected for cleanup: pending, not active, and something to remove. A user that only other runs
 * still use (removable 0 because of conflicts) counts: the conflict dialog then offers Clean both / Keep those users.
 */
export const isCleanable = (i: CleanupItem): boolean =>
  i.walkthrough.cleanupStatus === 'pending' && i.walkthrough.status !== 'active' && (i.users.some(isDeletableUser) || i.removable.users > 0 || i.removable.record);

/** Whether the user's checkbox is on. */
export const userChecked = (s: CleanupSelection, u: CleanupUser): boolean => isDeletableUser(u) && !s.skip.includes(u.userId);

/** Select all cleanable runs, or clear the run selection when they all are selected. */
export function toggleAll(s: CleanupSelection, items: CleanupItem[]): CleanupSelection {
  const ids = items.filter(isCleanable).map((i) => i.walkthrough.id);
  const all = ids.length > 0 && ids.every((id) => s.runs.includes(id));
  return { ...s, runs: all ? s.runs.filter((id) => !ids.includes(id)) : [...new Set([...s.runs, ...ids])] };
}

/** Drop selected runs that are no longer in the (reloaded) list or no longer cleanable. */
export function pruneSelection(s: CleanupSelection, items: CleanupItem[]): CleanupSelection {
  const ok = new Set(items.filter(isCleanable).map((i) => i.walkthrough.id));
  const runs = s.runs.filter((id) => ok.has(id));
  return runs.length === s.runs.length ? s : { ...s, runs };
}

/** What the selection would remove, as the panel can tell from the list (the dryRun is authoritative). */
export function selectionEstimate(s: CleanupSelection, items: CleanupItem[]): { runs: number; users: number; messages: number } {
  const chosen = items.filter((i) => s.runs.includes(i.walkthrough.id));
  const users = chosen.flatMap((i) => i.users.filter((u) => userChecked(s, u)));
  return { runs: chosen.length, users: users.length, messages: users.reduce((n, u) => n + u.messages, 0) };
}

/** The POST /cleanup body of a selection: skipUsers only for users of the selected runs. */
export function cleanupBody(s: CleanupSelection, items: CleanupItem[], o: { dryRun?: boolean; onConflict?: OnConflict } = {}): CleanupBody {
  const chosen = items.filter((i) => s.runs.includes(i.walkthrough.id));
  const ids = new Set(chosen.flatMap((i) => i.users.map((u) => u.userId)));
  const skipUsers = s.skip.filter((id) => ids.has(id));
  return {
    walkthroughs: chosen.map((i) => i.walkthrough.id),
    ...(skipUsers.length ? { skipUsers } : {}),
    ...(o.onConflict && o.onConflict !== 'ask' ? { onConflict: o.onConflict } : {}),
    ...(o.dryRun ? { dryRun: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The flow: dryRun → (conflicts? dialog) → the real call → report

export type CleanupStep =
  | { kind: 'idle' }
  | { kind: 'conflicts'; conflicts: CleanupConflict[]; body: CleanupBody }
  | { kind: 'report'; result: CleanupResult };

/** After the dryRun: ask about conflicts, else go on with the real call (null). */
export function afterPreview(preview: CleanupResult, body: CleanupBody): CleanupStep | null {
  return preview.conflicts.length ? { kind: 'conflicts', conflicts: preview.conflicts, body } : null;
}

/**
 * The confirm text of a dryRun: which runs and what goes ("Clean up 2 runs (A, B)? This deletes 3 users · 2 messages.").
 * Shown before the real call, also after Clean both / Keep those users (a second dryRun with that choice).
 */
export function confirmText(preview: CleanupResult): string {
  const names = preview.runs.map((r) => r.label.trim() || r.key);
  const shown = names.length > 5 ? `${names.slice(0, 5).join(', ')} +${names.length - 5} more` : names.join(', ');
  const head = names.length === 1 ? `Clean up ${shown}?` : `Clean up ${names.length} runs (${shown})?`;
  const kept = preview.runs.reduce((n, r) => n + r.kept.length, 0);
  return `${head} This deletes ${amountText(preview.totals)}.${kept ? ` ${plural(kept, 'user')} ${kept === 1 ? 'stays' : 'stay'}.` : ''}`;
}

/** The body of the real call after the conflict dialog's choice. */
export const resolveConflicts = (body: CleanupBody, choice: 'include' | 'keep'): CleanupBody => {
  const { dryRun: _d, ...rest } = body;
  return { ...rest, onConflict: choice };
};

/**
 * The conflicts of a 409 answer to POST /cleanup (data changed since the dryRun), else null. Read from the body's
 * `conflicts` (the spec's { error, conflicts }) or from `details.conflicts` (an HttpError with details).
 */
export function conflictsFromError(err: unknown): CleanupConflict[] | null {
  if (!(err instanceof StubyardError) || err.status !== 409) return null;
  const body = err.body as { conflicts?: unknown; details?: { conflicts?: unknown } } | undefined;
  const details = err.details as { conflicts?: unknown } | undefined;
  const c = body?.conflicts ?? details?.conflicts ?? body?.details?.conflicts;
  return Array.isArray(c) && c.length ? (c as CleanupConflict[]) : null;
}

/** Whether a walkthrough view created users (it may then have data to clean). */
export const createdUsers = (w: Pick<WalkthroughView, 'actors'>): number => Object.values(w.actors).filter((a) => a.created).length;
