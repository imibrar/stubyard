/**
 * Walkthroughs: a human runs a storyboard step by step (browser-safe, fetch only).
 *
 *   import { startWalkthrough, resolveStep, updateStep, finishWalkthrough } from '@stubyard/client/walkthroughs';
 *   const t = { project: 'classprovia' };
 *   let w = await startWalkthrough(t, { storyboard: 'event-registration', origin: 'https://app.test' });
 *   const r = await resolveStep(t, w.id, w.currentStepId ?? w.steps[0].id);   // URLs, credentials, rendered entries
 *   w = await updateStep(t, w.id, r.step.id, { status: 'done', data: { filled: 12 } });
 *   w = await finishWalkthrough(t, w.id, { verdict: 'pass', signedOffBy: 'QA' });
 */
import { apiBase, hubJson, projectPath, query, seg, type HubTarget } from './http.js';
import type { ResolvedStep, RunMode, StepStatus, Verdict, WalkthroughBrief, WalkthroughStatus, WalkthroughSummary, WalkthroughView } from './storyboard-types.js';

const wt = (t: HubTarget, id: string, suffix = '') => projectPath(t, `/walkthroughs/${seg(id)}${suffix}`);

/**
 * Start a walkthrough of a storyboard (slug or id): fresh actors get new users; missing required inputs → 400.
 * mode (default 'tracked', whatever the storyboard's preferredMode): 'quick' runs keep no screenshots or sign-off, are
 * left out of listWalkthroughs by default and are deleted 24 h after their last change.
 */
export function startWalkthrough(
  t: HubTarget,
  o: { storyboard: string; origin?: string; label?: string; vars?: Record<string, string>; actors?: Record<string, string>; mode?: RunMode },
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
