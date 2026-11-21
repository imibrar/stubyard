// Pure view-model helpers of the side panel (no chrome.*, no fetch): unit-tested in test/state.test.ts.
import type { DataEntryInput, DataSetView, StepCounts, StepStatus, StoryboardBrief, StoryboardView, Verdict, WalkthroughStepView, WalkthroughView } from '@stubyard/client/storyboard-types';
import type { FillReport, ScannedField } from '../shared/protocol';

export const FINAL_STATUSES: ReadonlySet<StepStatus> = new Set(['done', 'skipped', 'failed']);
export const isFinal = (s: StepStatus): boolean => FINAL_STATUSES.has(s);

export const STATUS_ICON: Record<StepStatus, string> = { pending: '○', active: '◐', done: '✓', skipped: '↷', failed: '✗' };

/** Steps the walkthrough still runs (steps removed from the storyboard after a refresh are left out). */
export const liveSteps = (w: WalkthroughView): WalkthroughStepView[] => w.steps.filter((s) => s.data?.removed !== true);

export function progress(w: WalkthroughView): { finished: number; total: number } {
  const steps = liveSteps(w);
  return { finished: steps.filter((s) => isFinal(s.status)).length, total: steps.length };
}

/** The step the card shows: the walkthrough's current step, else the first open one, else null (all finished). */
export function currentStep(w: WalkthroughView): WalkthroughStepView | null {
  const steps = liveSteps(w);
  return steps.find((s) => s.id === w.currentStepId) ?? steps.find((s) => !isFinal(s.status)) ?? null;
}

/** The next open step after `fromId` (wrapping to an earlier open one); null when none is open. */
export function nextOpenStepId(w: WalkthroughView, fromId: string | null): string | null {
  const steps = liveSteps(w);
  const i = steps.findIndex((s) => s.id === fromId);
  const after = steps.slice(i + 1).find((s) => !isFinal(s.status) && s.id !== fromId);
  return (after ?? steps.find((s) => !isFinal(s.status) && s.id !== fromId))?.id ?? null;
}

/** Non-optional steps still pending or active (finishing needs allowIncomplete while there are any). */
export const openRequiredSteps = (w: WalkthroughView): WalkthroughStepView[] => liveSteps(w).filter((s) => !s.optional && !isFinal(s.status));

/** The verdict the summary suggests: fail when a step failed, partial when a required step was skipped or not run, else pass. */
export function defaultVerdict(w: WalkthroughView): Verdict {
  const steps = liveSteps(w);
  if (steps.some((s) => s.status === 'failed')) return 'fail';
  if (steps.some((s) => !s.optional && (s.status === 'skipped' || !isFinal(s.status)))) return 'partial';
  return 'pass';
}

/** "You should be logged in as Admin (Ada Admin)" for a step with an actor. */
export function actorHint(w: WalkthroughView, step: WalkthroughStepView): string | null {
  if (!step.actor || step.kind === 'login') return null;
  const a = w.actors[step.actor];
  if (!a) return `Actor "${step.actor}" is not part of this walkthrough`;
  return `You should be logged in as ${a.name}${a.email ? ` (${a.email})` : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Email step (§6.8)

/** Subject filter: a substring (case-insensitive) or "/regex/flags". No pattern matches everything. */
export function subjectMatches(subject: string | null | undefined, pattern: string | null | undefined): boolean {
  if (!pattern) return true;
  const s = subject ?? '';
  const re = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  if (re) {
    try {
      return new RegExp(re[1], re[2]).test(s);
    } catch {
      return false;
    }
  }
  return s.toLowerCase().includes(pattern.toLowerCase());
}

/** A short label for a link: host + path (+ query), truncated. */
export function linkLabel(url: string, max = 60): string {
  let s = url;
  try {
    const u = new URL(url);
    s = `${u.host}${u.pathname}${u.search}`;
  } catch {
    /* not a URL: show as is */
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface RankedLinks {
  links: { url: string; label: string }[];
  /** The link to preselect (from the step's link pattern / index), or null. */
  preselected: string | null;
}

/**
 * The message's links for the picker: unsubscribe links last. `linkPattern` (substring or /regex/) and `linkIndex`
 * (into the matching links, else into all) pick the preselected one; with neither, a lone non-unsubscribe link is.
 */
export function rankLinks(links: string[], linkPattern: string | null, linkIndex: number | null): RankedLinks {
  const unique = [...new Set(links)];
  const isUnsub = (l: string) => /unsubscribe/i.test(l);
  const ordered = [...unique.filter((l) => !isUnsub(l)), ...unique.filter(isUnsub)];
  const candidates = linkPattern ? unique.filter((l) => subjectMatches(l, linkPattern)) : unique;
  let preselected: string | null = null;
  if (linkIndex !== null && linkIndex !== undefined) preselected = candidates[linkIndex] ?? null;
  else if (linkPattern) preselected = candidates[0] ?? null;
  else {
    const normal = unique.filter((l) => !isUnsub(l));
    if (normal.length === 1) preselected = normal[0];
  }
  return { links: ordered.map((url) => ({ url, label: linkLabel(url) })), preselected };
}

/** The waitPath with `after=<cursor>` set, to wait for a newer message than one that did not match. */
export function waitPathAfter(waitPath: string, cursor: string): string {
  const u = new URL(waitPath, 'http://x');
  u.searchParams.set('after', cursor);
  return /^https?:\/\//i.test(waitPath) ? u.toString() : `${u.pathname}${u.search}`;
}

/** The message-list path with the same filters as a waitPath (to look past a newest message that did not match). */
export function listPathFromWait(waitPath: string): string {
  const u = new URL(waitPath, 'http://x');
  u.pathname = u.pathname.replace(/\/messages\/wait$/, '/messages');
  u.searchParams.delete('timeout');
  u.searchParams.delete('after');
  return /^https?:\/\//i.test(waitPath) ? u.toString() : `${u.pathname}${u.search}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Login with TOTP (§6.7)

/** How long to wait before using a TOTP code: until the next period when fewer than 4 s are left, else 0. */
export function totpDelayMs(code: { remaining: number; validUntil: number }, now: number): number {
  return code.remaining < 4 ? Math.max(0, code.validUntil - now) + 250 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Fill report

export function fillSummary(r: Pick<FillReport, 'filled' | 'unmatched' | 'skipped' | 'errors'>): string {
  const parts = [`${r.filled} filled`, `${r.unmatched} unmatched`, `${r.skipped} skipped`];
  if (r.errors) parts.push(`${r.errors} errors`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------------------------------------------
// Page data (§6.10.6)

export interface PageDataRow {
  field: ScannedField;
  /** The key of the data-set entry that targets this field, or null. */
  entryKey: string | null;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether a data-set entry key addresses a scanned field (by key, id, name, test id, label or placeholder). */
export function entryTargetsField(entry: { key: string; label?: string }, f: ScannedField): boolean {
  if ([f.key, f.id, f.name, f.testId].includes(entry.key)) return true;
  const k = norm(entry.key);
  return !!k && (k === norm(f.label) || k === norm(f.placeholder));
}

/** Scan rows side by side with a data set: which fields it fills, and which entries have no field on this page. */
export function comparePage(fields: ScannedField[], dataSet: Pick<DataSetView, 'entries'> | null): { rows: PageDataRow[]; missing: string[] } {
  const entries = dataSet?.entries ?? [];
  const used = new Set<string>();
  const rows = fields.map((field) => {
    const e = entries.find((x) => entryTargetsField(x, field));
    if (e) used.add(e.key);
    return { field, entryKey: e?.key ?? null };
  });
  return { rows, missing: entries.filter((e) => !used.has(e.key)).map((e) => e.key) };
}

/** Data-set entries from a scan (the current values), for "Save page as data set". Unfillable fields are left out. */
export function entriesFromScan(fields: ScannedField[]): DataEntryInput[] {
  return fields
    .filter((f) => f.kind !== 'skip')
    .map((f) => ({
      key: f.key,
      value: f.value ?? '',
      kind: f.kind,
      ...(f.label && f.label !== f.key ? { label: f.label } : {}),
    }));
}

/** A slug from free text ("Sign-up page" → "sign-up-page"). */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** Replaces {{vars.x}} with the walkthrough's value (when it has one); every other placeholder is left as-is. */
export function fillVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*vars\.([A-Za-z0-9_-]+)\s*\}\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m));
}

// ---------------------------------------------------------------------------------------------------------------
// Run modes: quick test vs tracked walkthrough

export type RunMode = 'quick' | 'tracked';

export interface StartChoice {
  mode: RunMode;
  label: string;
  hint: string;
  primary: boolean;
}

const START_CHOICES: Record<RunMode, Omit<StartChoice, 'primary'>> = {
  quick: { mode: 'quick', label: 'Start quick test', hint: 'Click through with the helpers — nothing recorded' },
  tracked: { mode: 'tracked', label: 'Start tracked walkthrough', hint: 'Record each step, screenshots and sign-off' },
};

/** The two start buttons: the storyboard's preferred mode first (primary), the other second. Default: tracked. */
export function startChoices(preferred: RunMode | null | undefined): StartChoice[] {
  const first: RunMode = preferred === 'quick' ? 'quick' : 'tracked';
  const second: RunMode = first === 'quick' ? 'tracked' : 'quick';
  return [
    { ...START_CHOICES[first], primary: true },
    { ...START_CHOICES[second], primary: false },
  ];
}

/** Whether a walkthrough (view or brief) is a quick test run. Runs without a mode are tracked. */
export const isQuickRun = (w: { mode?: RunMode | null }): boolean => w.mode === 'quick';

export interface QuickRow {
  id: string;
  /** 1-based step number. */
  n: number;
  /** The title with {{vars.x}} filled (the hub-rendered one for the current step, when given). */
  title: string;
  kind: WalkthroughStepView['kind'];
  done: boolean;
  current: boolean;
}

/** One row per live step of a quick run; `currentTitle` is the hub-rendered title of the current step, if resolved. */
export function quickRows(w: WalkthroughView, currentId: string | null, currentTitle?: string): QuickRow[] {
  return liveSteps(w).map((s) => ({
    id: s.id,
    n: s.position + 1,
    title: s.id === currentId && currentTitle !== undefined ? currentTitle : fillVars(s.title, w.vars),
    kind: s.kind,
    done: isFinal(s.status),
    current: s.id === currentId,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Starting a run (shared by the Start screen and Home's one-tap quick test)

/** The inputs' starting values: each input's default, else ''. */
export const initialVars = (inputs: StoryboardView['inputs']): Record<string, string> => Object.fromEntries(inputs.map((i) => [i.name, i.default ?? '']));

/** The origin preselected for a run: the tab's when the project lists it, else the project's first, else the tab's. */
export const defaultOrigin = (tabOrigin: string | null, appOrigins: string[]): string =>
  tabOrigin && appOrigins.includes(tabOrigin) ? tabOrigin : (appOrigins[0] ?? tabOrigin ?? '');

/** Labels of required inputs that have no value yet. */
export const missingInputs = (inputs: StoryboardView['inputs'], vars: Record<string, string>): string[] =>
  inputs.filter((i) => i.required && !vars[i.name]?.trim()).map((i) => i.label || i.name);

/** The startWalkthrough body: empty vars, unchosen actors, a blank label and origin are left out. */
export function startBody(o: { storyboard: string; origin: string; label: string; vars: Record<string, string>; actors: Record<string, string>; mode: RunMode }) {
  return {
    storyboard: o.storyboard,
    origin: o.origin || undefined,
    label: o.label.trim() || undefined,
    vars: Object.fromEntries(Object.entries(o.vars).filter(([, v]) => v.trim() !== '')),
    actors: Object.fromEntries(Object.entries(o.actors).filter(([, v]) => v)),
    mode: o.mode,
  };
}

/**
 * Whether a quick test can start with one tap (no Start screen): every required input has a default. Actors need no
 * choice: fresh ones get new users and role-only ones get the hub's default user, as on the Start screen untouched.
 */
export const oneTapQuick = (sb: Pick<StoryboardView, 'inputs' | 'actors'>): boolean =>
  missingInputs(sb.inputs, initialVars(sb.inputs)).length === 0;

// ---------------------------------------------------------------------------------------------------------------
// Home lists

/** Finished and total steps of a walkthrough brief. */
export function countProgress(c: StepCounts): { finished: number; total: number } {
  const finished = c.done + c.skipped + c.failed;
  return { finished, total: finished + c.pending + c.active };
}

/** Storyboards whose name, slug, tags or description contain every word of the query (case-insensitive). */
export function filterStoryboards<S extends Pick<StoryboardBrief, 'name' | 'slug' | 'tags' | 'description'>>(list: S[], query: string): S[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = [s.name, s.slug, s.description, ...s.tags].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface StoryboardGroup<S> {
  /** The first tag of the group's storyboards; null for untagged ones (and for the single group of an untagged list). */
  tag: string | null;
  items: S[];
}

/** Groups by first tag (in order of first appearance), untagged last; one null group when nothing is tagged. */
export function groupByFirstTag<S extends Pick<StoryboardBrief, 'tags'>>(list: S[]): StoryboardGroup<S>[] {
  if (!list.some((s) => s.tags.length > 0)) return list.length ? [{ tag: null, items: list }] : [];
  const groups = new Map<string, S[]>();
  const untagged: S[] = [];
  for (const s of list) {
    const tag = s.tags[0];
    if (!tag) untagged.push(s);
    else groups.set(tag, [...(groups.get(tag) ?? []), s]);
  }
  const out: StoryboardGroup<S>[] = [...groups].map(([tag, items]) => ({ tag, items }));
  if (untagged.length) out.push({ tag: null, items: untagged });
  return out;
}

/** Home shows the search box above this many storyboards. */
export const SEARCH_THRESHOLD = 5;
