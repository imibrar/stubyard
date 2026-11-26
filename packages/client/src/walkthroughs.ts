/**
 * Walkthroughs: a human (with the extension) or an agent (in its own browser) runs a storyboard step by step
 * (browser-safe, fetch only).
 *
 *   import { startWalkthrough, resolveStep, updateStep, finishWalkthrough } from '@stubyard/client/walkthroughs';
 *   const t = { project: 'classprovia' };
 *   let w = await startWalkthrough(t, { storyboard: 'event-registration', origin: 'https://app.test' });
 *   const r = await resolveStep(t, w.id, w.currentStepId ?? w.steps[0].id);   // URLs, credentials, rendered entries
 *   w = await updateStep(t, w.id, r.step.id, { status: 'done', data: { filled: 12 } });
 *   w = await finishWalkthrough(t, w.id, { verdict: 'pass', signedOffBy: 'QA' });
 *   const preview = await cleanupRuns(t, { walkthroughs: [w.id], dryRun: true });   // what a cleanup would remove
 *
 * An agent run (executor 'agent'): your own browser does each step, stubyard keeps the steps, data and evidence.
 *
 *   let w = await startAgentWalkthrough(t, { storyboard: 'event-registration', runner: { name: 'my-playwright', version: '1.0' } });
 *   let step = w.currentStepId ? await resolveStep(t, w.id, w.currentStepId) : null;
 *   while (step) {
 *     // … act in the browser from step (url, entries, username / password, …) …
 *     const r = await reportStep(t, w.id, step.step.id, { status: 'done', screenshot: await shot() });
 *     step = r.next;
 *   }
 *   w = await finishWalkthrough(t, w.id, { verdict: 'pass' });   // the agent's verdict; a person signs off later
 */
import { apiBase, hubJson, projectPath, query, seg, StubyardError, type HubTarget } from './http.js';
import type {
  CleanupConflict,
  CleanupItem,
  CleanupList,
  CleanupResult,
  CleanupStatus,
  RecordingChunk,
  RecordingChunkResult,
  RecordingList,
  RecordMode,
  ResolvedStep,
  RunMode,
  StepStatus,
  Verdict,
  WalkthroughBrief,
  WalkthroughExecutor,
  WalkthroughStatus,
  WalkthroughSummary,
  WalkthroughView,
} from './storyboard-types.js';

/**
 * The test run verdict a walkthrough was finished against (finishWalkthrough with `run`; walkthroughs.run_check).
 * failed: the verdict items with status fail.
 */
export interface WalkthroughRunCheck {
  runId: string;
  key: string;
  verdict: 'pass' | 'fail' | 'pending';
  summary: string;
  failed: { id: string; message: string }[];
}

/** A walkthrough with its runCheck (null when it was not finished with a run). */
export type WalkthroughWithRunCheck = WalkthroughView & { runCheck: WalkthroughRunCheck | null };

const wt = (t: HubTarget, id: string, suffix = '') => projectPath(t, `/walkthroughs/${seg(id)}${suffix}`);

/**
 * Start a walkthrough of a storyboard (slug or id): fresh actors get new users; missing required inputs → 400.
 * mode (default 'tracked', whatever the storyboard's preferredMode): 'quick' runs keep no screenshots or sign-off and are
 * left out of listWalkthroughs by default. Nothing is deleted automatically: see cleanupRuns.
 * uses: ids or keys (at most 20) of earlier walkthroughs whose captured values this run reuses; cleanup of those runs
 * then warns while this one still needs their data.
 * record: 'dom' records the run's app pages with the extension (rrweb); 'off' turns the storyboard's setting off.
 */
export function startWalkthrough(
  t: HubTarget,
  o: {
    storyboard: string;
    origin?: string;
    label?: string;
    vars?: Record<string, string>;
    actors?: Record<string, string>;
    mode?: RunMode;
    uses?: string[];
    /** Record the run (default: the storyboard's record for tracked runs, off for quick ones). */
    record?: RecordMode;
    maskAllInputs?: boolean;
  },
): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', projectPath(t, '/walkthroughs'), o);
}

/**
 * Start an agent run (executor 'agent'): no extension; your own browser does the steps. Same options as
 * startWalkthrough (inputs are `vars`); `runner` names what drives the browser. Recording is off unless 'video' (you
 * upload the video yourself). Actors come with their passwords.
 */
export function startAgentWalkthrough(
  t: HubTarget,
  o: {
    storyboard: string;
    runner?: { name: string; version?: string };
    origin?: string;
    label?: string;
    vars?: Record<string, string>;
    actors?: Record<string, string>;
    mode?: RunMode;
    uses?: string[];
    record?: 'off' | 'video';
  },
): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', projectPath(t, '/walkthroughs'), { ...o, executor: 'agent' });
}

/** Newest first. mode: 'tracked' (default; quick test runs left out), 'quick' or 'all'. executor: only human or agent runs. */
export function listWalkthroughs(
  t: HubTarget,
  o: { storyboard?: string; status?: WalkthroughStatus; mode?: RunMode | 'all'; executor?: WalkthroughExecutor; limit?: number } = {},
): Promise<WalkthroughBrief[]> {
  return hubJson<WalkthroughBrief[]>(t, 'GET', projectPath(t, `/walkthroughs${query({ storyboard: o.storyboard, status: o.status, mode: o.mode, executor: o.executor, limit: o.limit })}`));
}

/** By id or key. */
export function getWalkthrough(t: HubTarget, id: string): Promise<WalkthroughWithRunCheck> {
  return hubJson<WalkthroughWithRunCheck>(t, 'GET', wt(t, id));
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
 * Record a step result as an agent: the screenshot (data URL, at most 600 KB; skipped with a warning on quick runs or
 * over the caps), then the status, note, data and value (capture steps). The walkthrough moves to its next open step,
 * returned resolved as `next` (null when every step is reported: finishWalkthrough).
 */
export async function reportStep(
  t: HubTarget,
  id: string,
  stepId: string,
  p: { status: 'done' | 'failed' | 'skipped'; note?: string; data?: Record<string, unknown>; value?: string; screenshot?: string },
): Promise<{ walkthrough: WalkthroughView; screenshot: { id: string; bytes: number } | null; next: ResolvedStep | null; warnings: string[] }> {
  const { screenshot: dataUrl, ...patch } = p;
  const walkthrough = await updateStep(t, id, stepId, patch);
  const warnings: string[] = [];
  let screenshot: { id: string; bytes: number } | null = null;
  if (dataUrl) {
    try {
      screenshot = await addScreenshot(t, id, stepId, dataUrl);
    } catch (err) {
      if (!(err instanceof StubyardError)) throw err;
      warnings.push(`screenshot not stored: ${err.message}`);
    }
  }
  const next = walkthrough.status === 'active' && walkthrough.currentStepId ? await resolveStep(t, id, walkthrough.currentStepId) : null;
  return { walkthrough, screenshot, next, warnings };
}

/**
 * Finish. Tracked human runs need verdict and signedOffBy, and answer 409 while non-optional steps are open unless
 * allowIncomplete (they are then skipped as "not run"). Quick runs: everything optional, open steps are skipped.
 * Agent runs: verdict only (no signedOffBy: 400); the verdict is the agent's until a person signs off.
 * run: a test run (key or id) whose verdict is evaluated now and stored as runCheck (404 for an unknown run). The
 * walkthrough verdict stays what you send: pass `verdict: 'fail'` yourself when runCheck should decide it.
 */
export function finishWalkthrough(
  t: HubTarget,
  id: string,
  o: { verdict?: Verdict; signedOffBy?: string; note?: string; allowIncomplete?: boolean; run?: string },
): Promise<WalkthroughWithRunCheck> {
  return hubJson<WalkthroughWithRunCheck>(t, 'POST', wt(t, id, '/finish'), o);
}

/** A person signs off a finished agent run (verdict defaults to the agent's). 409 for human or active runs, or twice. */
export function signOffWalkthrough(t: HubTarget, id: string, o: { signedOffBy: string; verdict?: Verdict; note?: string }): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', wt(t, id, '/signoff'), o);
}

export function abandonWalkthrough(t: HubTarget, id: string, note?: string): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'POST', wt(t, id, '/abandon'), note === undefined ? {} : { note });
}

/** Steps, vars, actors, sign-off and runCheck of one walkthrough as JSON. */
export function getWalkthroughSummary(t: HubTarget, id: string): Promise<WalkthroughSummary & { runCheck: WalkthroughRunCheck | null }> {
  return hubJson<WalkthroughSummary & { runCheck: WalkthroughRunCheck | null }>(t, 'GET', wt(t, id, '/summary'));
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

// ---------------------------------------------------------------------------------------------------------------
// Recording (the extension records the run's app pages; the dashboard plays them back)

/** The recording of a walkthrough: mode, paused / stopped, bytes and cap, and its segments (one per page load). */
export function getRecording(t: HubTarget, id: string): Promise<RecordingList> {
  return hubJson<RecordingList>(t, 'GET', wt(t, id, '/recording'));
}

/** Pause or resume, or switch recording on (mode 'dom') or off for the rest of the run. Returns the walkthrough. */
export function setRecording(t: HubTarget, id: string, p: { paused?: boolean; mode?: RecordMode; maskAllInputs?: boolean }): Promise<WalkthroughView> {
  return hubJson<WalkthroughView>(t, 'PATCH', wt(t, id, '/recording'), p);
}

/** Delete every segment (step results and screenshots stay). */
export function deleteRecording(t: HubTarget, id: string): Promise<{ deleted: number; bytes: number }> {
  return hubJson(t, 'DELETE', wt(t, id, '/recording'));
}

/**
 * Upload one chunk of rrweb events (idempotent per segment key + seq). 409 when recording is off; 413 over the caps
 * (then recording has stopped: the error says why).
 */
export function uploadRecordingChunk(t: HubTarget, id: string, chunk: RecordingChunk): Promise<RecordingChunkResult> {
  return hubJson<RecordingChunkResult>(t, 'POST', wt(t, id, '/recording/chunks'), chunk);
}

/** The URL of a segment's events (NDJSON, one rrweb event per line; gzip when accepted). */
export function recordingSegmentUrl(t: HubTarget, id: string, no: number): string {
  return `${apiBase(t)}${wt(t, id, `/recording/segments/${no}`)}`;
}

/** A segment's rrweb events, parsed. */
export async function getRecordingEvents(t: HubTarget, id: string, no: number): Promise<unknown[]> {
  const f = t.fetch ?? globalThis.fetch;
  const r = await f(recordingSegmentUrl(t, id, no));
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* text */
    }
    throw new StubyardError(r.status, msg);
  }
  return parseNdjson(text);
}

/** NDJSON text → values (blank lines skipped). */
export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) if (line.trim()) out.push(JSON.parse(line));
  return out;
}
