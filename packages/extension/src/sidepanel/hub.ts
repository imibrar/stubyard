// stubyard calls the client does not cover (projects, system, data-set preview, cleanup), and the error text helper.
// Everything else goes through '@stubyard/client/<module>' directly.
import { hubJson, projectPath, query, seg, StubyardError, type HubTarget } from '@stubyard/client/http';
import { needsToken, TOKEN_NEEDED } from '../shared/hubAuth';
import type { RenderedEntry } from '@stubyard/client/storyboard-types';
import type { CleanupBody, CleanupItem, CleanupList, CleanupModeFilter, CleanupResult, CleanupStatusFilter } from './cleanup';

export type { HubTarget };

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  settings: { appOrigins?: string[]; [k: string]: unknown };
}

export function systemInfo(apiUrl: string): Promise<{ name: string; version: string; authRequired?: boolean }> {
  return hubJson({ apiUrl }, 'GET', '/api/system');
}

export function listProjects(apiUrl: string): Promise<ProjectInfo[]> {
  return hubJson({ apiUrl }, 'GET', '/api/projects');
}

export function getProject(t: HubTarget): Promise<ProjectInfo> {
  return hubJson(t, 'GET', projectPath(t));
}

/** Add an app origin to the project's settings.appOrigins (settings merge shallowly, so the list is sent whole). */
export async function addAppOrigin(t: HubTarget, origin: string): Promise<ProjectInfo> {
  const p = await getProject(t);
  const origins = p.settings.appOrigins ?? [];
  if (origins.includes(origin)) return p;
  return hubJson(t, 'PATCH', projectPath(t), { settings: { appOrigins: [...origins, origin] } });
}

/** A data set's entries rendered by the hub (optionally for a walkthrough's actor and vars), §3.3. */
export function previewDataSet(t: HubTarget, slug: string, o: { walkthrough?: string } = {}): Promise<{ entries: RenderedEntry[]; warnings: unknown[] }> {
  return hubJson(t, 'POST', projectPath(t, `/data-sets/${seg(slug)}/preview`), o);
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup of the test data runs created (spec-cleanup.md)

/** Runs with data to clean (default: pending, all modes), and the counts per status. */
export function listCleanup(t: HubTarget, o: { status?: CleanupStatusFilter; mode?: CleanupModeFilter } = {}): Promise<CleanupList> {
  return hubJson(t, 'GET', projectPath(t, `/cleanup${query({ status: o.status, mode: o.mode })}`));
}

/** The cleanup preview of one run (any status). */
export function getRunCleanup(t: HubTarget, walkthrough: string): Promise<CleanupItem> {
  return hubJson(t, 'GET', projectPath(t, `/walkthroughs/${seg(walkthrough)}/cleanup`));
}

/** Clean up runs (or preview with dryRun). With onConflict ask, a conflict answers 409 { error, conflicts }. */
export function cleanupRuns(t: HubTarget, body: CleanupBody): Promise<CleanupResult> {
  return hubJson(t, 'POST', projectPath(t, '/cleanup'), body);
}

/** "Leave it": the data stays and the run leaves the list. */
export function dismissCleanup(t: HubTarget, walkthrough: string, note?: string): Promise<CleanupItem> {
  return hubJson(t, 'POST', projectPath(t, `/walkthroughs/${seg(walkthrough)}/cleanup/dismiss`), note ? { note } : {});
}

/** Back to pending (only for a dismissed run). */
export function reopenCleanup(t: HubTarget, walkthrough: string): Promise<CleanupItem> {
  return hubJson(t, 'POST', projectPath(t, `/walkthroughs/${seg(walkthrough)}/cleanup/reopen`), {});
}

/** Pin a test user as a shared fixture (keep: cleanup never deletes it), or unpin it. */
export function setUserKeep(t: HubTarget, userId: string, keep: boolean): Promise<unknown> {
  return hubJson(t, 'PATCH', projectPath(t, `/users/${seg(userId)}`), { keep });
}

/** The URL of a stored screenshot (for <img>). */
export function shotUrl(t: HubTarget, walkthroughId: string, shotId: string): string {
  return `${(t.apiUrl ?? '').replace(/\/+$/, '')}${projectPath(t, `/walkthroughs/${seg(walkthroughId)}/shots/${seg(shotId)}`)}`;
}

/** A readable message for any error; validation details are appended. */
export function errorText(err: unknown): string {
  if (needsToken(err)) return TOKEN_NEEDED;
  if (err instanceof StubyardError) {
    const d = err.details as { errors?: { path: string; message: string }[] } | string[] | undefined;
    const list = Array.isArray(d) ? d.map(String) : d?.errors?.map((e) => `${e.path}: ${e.message}`);
    return list?.length ? `${err.message}\n${list.join('\n')}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
