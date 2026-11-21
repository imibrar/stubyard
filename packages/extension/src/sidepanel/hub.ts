// stubyard calls the client does not cover (projects, system, data-set preview), and the error text helper.
// Everything else goes through '@stubyard/client/<module>' directly.
import { hubJson, projectPath, seg, StubyardError, type HubTarget } from '@stubyard/client/http';
import type { RenderedEntry } from '@stubyard/client/storyboard-types';

export type { HubTarget };

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  settings: { appOrigins?: string[]; [k: string]: unknown };
}

export function systemInfo(apiUrl: string): Promise<{ name: string; version: string }> {
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

/** The URL of a stored screenshot (for <img>). */
export function shotUrl(t: HubTarget, walkthroughId: string, shotId: string): string {
  return `${(t.apiUrl ?? '').replace(/\/+$/, '')}${projectPath(t, `/walkthroughs/${seg(walkthroughId)}/shots/${seg(shotId)}`)}`;
}

/** A readable message for any error; validation details are appended. */
export function errorText(err: unknown): string {
  if (err instanceof StubyardError) {
    const d = err.details as { errors?: { path: string; message: string }[] } | string[] | undefined;
    const list = Array.isArray(d) ? d.map(String) : d?.errors?.map((e) => `${e.path}: ${e.message}`);
    return list?.length ? `${err.message}\n${list.join('\n')}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
