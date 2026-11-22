/**
 * Walkthroughs: a human runs a storyboard step by step (browser-safe, fetch only).
 *
 *   import { startWalkthrough, resolveStep, updateStep, finishWalkthrough } from '@stubyard/client/walkthroughs';
 *   const t = { project: 'classprovia' };
 *   let w = await startWalkthrough(t, { storyboard: 'event-registration', origin: 'https://app.test' });
 *   const r = await resolveStep(t, w.id, w.currentStepId ?? w.steps[0].id);   // URLs, credentials, rendered entries
 *   w = await updateStep(t, w.id, r.step.id, { status: 'done', data: { filled: 12 } });
 *   w = await finishWalkthrough(t, w.id, { verdict: 'pass', signedOffBy: 'QA' });
 *   const preview = await cleanupRuns(t, { walkthroughs: [w.id], dryRun: true });   // what a cleanup would remove
 */
import { apiBase, hubJson, projectPath, query, seg, type HubTarget } from './http.js';
import type {
  CleanupConflict,
  CleanupItem,
  CleanupList,
  CleanupResult,
  CleanupStatus,
  ResolvedStep,
  RunMode,
  StepStatus,
  Verdict,
  WalkthroughBrief,
  WalkthroughStatus,
  WalkthroughSummary,
  WalkthroughView,
} from './storyboard-types.js';

const wt = (t: HubTarget, id: string, suffix = '') => projectPath(t, `/walkthroughs/${seg(id)}${suffix}`);

/**
 * Start a walkthrough of a storyboard (slug or id): fresh actors get new users; missing required inputs → 400.
 * mode (default 'tracked', whatever the storyboard's preferredMode): 'quick' runs keep no screenshots or sign-off and are
 * left out of listWalkthroughs by default. Nothing is deleted automatically: see cleanupRuns.
 * uses: ids or keys (at most 20) of earlier walkthroughs whose captured values this run reuses; cleanup of those runs
 * then warns while this one still needs their data.
 */
export function startWalkthrough(
  t: HubTarget,
  o: { storyboard: string; origin?: string; label?: string; vars?: Record<string, string>; actors?: Record<string, string>; mode?: RunMode; uses?: string[] },
): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', projectPath(t, '/walkthroughs'), o);
}

/** Newest first. mode: 'tracked' (default; quick test runs left out), 'quick' or 'all'. */
export function listWalkthroughs(
  t: HubTarget,
  o: { storyboard?: string; status?: WalkthroughStatus; mode?: RunMode | 'all'; limit?: number } = {},
): Promise<WalkthroughBrief[]> {
  return hubJson<WalkthroughBrief[]>(t, 'GET', projectPath(t, `/walkthroughs${query({ storyboard: o.storyboard, status: o.status, mode: o.mode, limit: o.limit })}`));
}

/** By id or key. */
export function getWalkthrough(t: HubTarget, id: string): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'GET', wt(t, id));
}

/** A null var deletes it. */
export function patchWalkthrough(
  t: HubTarget,
  id: string,
  p: { label?: string; vars?: Record<string, string | null>; currentStepId?: string | null; origin?: string },
): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'PATCH', wt(t, id), p);
}

/** Everything the runner needs for one step (rendered for its actor); marks a pending step active. */
export function resolveStep(t: HubTarget, id: string, stepId: string): Promise<ResolvedStep> {
  return hubJson<ResolvedStep>(t, 'POST', wt(t, id, `/steps/${seg(stepId)}/resolve`), {});
}

/** Record a step's outcome. `data` is shallow-merged; `value` (capture steps) sets the captured var. */
export function updateStep(
  t: HubTarget,
  id: string,
  stepId: string,
  p: { status?: Exclude<StepStatus, 'active'>; note?: string; data?: Record<string, unknown>; value?: string },
): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'PATCH', wt(t, id, `/steps/${seg(stepId)}`), p);
}

/** Attach a screenshot (data:image/jpeg|png;base64 URL). Over the caps → StubyardError(413); quick test runs → 409. */
export function addScreenshot(t: HubTarget, id: string, stepId: string, dataUrl: string): Promise<{ id: string; bytes: number }> {
  return hubJson(t, 'POST', wt(t, id, `/steps/${seg(stepId)}/shots`), { dataUrl });
}

/**
 * Sign off. Tracked runs need verdict and signedOffBy, and answer 409 while non-optional steps are open unless
 * allowIncomplete (they are then skipped as "not run"). Quick runs: everything optional, open steps are skipped.
 */
export function finishWalkthrough(
  t: HubTarget,
  id: string,
  o: { verdict?: Verdict; signedOffBy?: string; note?: string; allowIncomplete?: boolean },
): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', wt(t, id, '/finish'), o);
}

export function abandonWalkthrough(t: HubTarget, id: string, note?: string): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', wt(t, id, '/abandon'), note === undefined ? {} : { note });
}

/** Steps, vars, actors and sign-off of one walkthrough as JSON. */
export function getWalkthroughSummary(t: HubTarget, id: string): Promise<WalkthroughSummary> {
  return hubJson<WalkthroughSummary>(t, 'GET', wt(t, id, '/summary'));
}

/** The printable summary page (screenshots inlined); open it in a tab. */
export function summaryUrl(t: HubTarget, id: string): string {
  return `${apiBase(t)}${wt(t, id, '/summary.html')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup of the test data runs created: fresh users and their messages (and quick runs' records). Manual only.

/** Non-active runs with test data. status: pending (default), cleaned, dismissed or all; mode: all (default), quick or tracked. */
export function listCleanup(t: HubTarget, o: { status?: Exclude<CleanupStatus, 'none'> | 'all'; mode?: RunMode | 'all' } = {}): Promise<CleanupList> {
  return hubJson<CleanupList>(t, 'GET', projectPath(t, `/cleanup${query({ status: o.status, mode: o.mode })}`));
}

/** What a cleanup of one run would remove (any status; an active run gets a warning). */
export function cleanupPreview(t: HubTarget, id: string): Promise<CleanupItem> {
  return hubJson<CleanupItem>(t, 'GET', wt(t, id, '/cleanup'));
}

/**
 * Clean up runs (1..100 ids or keys). onConflict 'ask' (default): when another run still needs a user, nothing changes
 * and this throws StubyardError(409) whose body is { error, conflicts: CleanupConflict[] } (see cleanupConflicts).
 * 'keep' leaves those users; 'include' cleans the non-active dependent runs too. dryRun computes the same result and
 * changes nothing (conflicts are returned instead of a 409).
 */
export function cleanupRuns(
  t: HubTarget,
  o: { walkthroughs: string[]; skipUsers?: string[]; onConflict?: 'ask' | 'keep' | 'include'; dryRun?: boolean },
): Promise<CleanupResult> {
  return hubJson<CleanupResult>(t, 'POST', projectPath(t, '/cleanup'), o);
}

/** The conflicts of a 409 from cleanupRuns (empty for any other error). */
export function cleanupConflicts(err: unknown): CleanupConflict[] {
  const body = (err as { status?: number; body?: unknown } | null)?.body as { conflicts?: unknown } | undefined;
  return (err as { status?: number } | null)?.status === 409 && Array.isArray(body?.conflicts) ? (body.conflicts as CleanupConflict[]) : [];
}

/** "Leave it": the data stays and the run leaves the pending list (reopenCleanup brings it back). */
export function dismissCleanup(t: HubTarget, id: string, note?: string): Promise<CleanupItem> {
  return hubJson<CleanupItem>(t, 'POST', wt(t, id, '/cleanup/dismiss'), note === undefined ? {} : { note });
}

/** dismissed → pending; 409 unless the run was dismissed. */
export function reopenCleanup(t: HubTarget, id: string): Promise<CleanupItem> {
  return hubJson<CleanupItem>(t, 'POST', wt(t, id, '/cleanup/reopen'), {});
}
