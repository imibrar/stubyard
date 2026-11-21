/**
 * Storyboard authoring (browser-safe, fetch only): storyboards, data sets, login recipes, page snapshots, bundles.
 * Invalid writes throw StubyardError(400) whose `details` is `{errors, warnings}` (every issue, with its path).
 *
 *   import { matchProjects, upsertStoryboard, validateStoryboard } from '@stubyard/client/storyboards';
 *   const { projects } = await matchProjects({}, location.origin);
 *   const t = { project: projects[0].slug };
 *   const check = await validateStoryboard(t, draft);        // dry run, never throws for an invalid storyboard
 *   if (check.ok) await upsertStoryboard(t, draft);
 */
import { hubJson, projectPath, query, seg, type HubTarget } from './http.js';
import type {
  DataSetInput,
  DataSetView,
  ImportMode,
  ImportResult,
  LoginRecipeInput,
  LoginRecipeView,
  OriginMatch,
  PageSnapshotBrief,
  PageSnapshotInput,
  PageSnapshotView,
  StoryboardBrief,
  StoryboardBundle,
  StoryboardInput,
  StoryboardView,
  ValidationResult,
} from './storyboard-types.js';

/** Projects whose App origins setting contains this origin (empty list when none). */
export function matchProjects(t: Pick<HubTarget, 'apiUrl' | 'fetch'>, origin: string): Promise<OriginMatch> {
  return hubJson<OriginMatch>(t, 'GET', `/api/storyboards/match${query({ origin })}`);
}

export function listStoryboards(t: HubTarget, o: { tag?: string } = {}): Promise<StoryboardBrief[]> {
  return hubJson<StoryboardBrief[]>(t, 'GET', projectPath(t, `/storyboards${query({ tag: o.tag })}`));
}

/** By slug or id. */
export function getStoryboard(t: HubTarget, slug: string): Promise<StoryboardView> {
  return hubJson<StoryboardView>(t, 'GET', projectPath(t, `/storyboards/${seg(slug)}`));
}

/** Create or replace by slug; the version only goes up when the content changed. */
export function upsertStoryboard(t: HubTarget, sb: StoryboardInput): Promise<StoryboardView> {
  return hubJson<StoryboardView>(t, 'PUT', projectPath(t, `/storyboards/${seg(sb.slug)}`), sb);
}

/** Dry-run validation of a draft, or of a stored storyboard by slug. */
export function validateStoryboard(t: HubTarget, sb: StoryboardInput | { slug: string }): Promise<ValidationResult> {
  const body = 'steps' in sb || 'actors' in sb || 'name' in sb ? { storyboard: sb } : { slug: sb.slug };
  return hubJson<ValidationResult>(t, 'POST', projectPath(t, '/storyboards/validate'), body);
}

/** Walkthroughs of it keep their snapshot. */
export async function deleteStoryboard(t: HubTarget, slug: string): Promise<void> {
  await hubJson(t, 'DELETE', projectPath(t, `/storyboards/${seg(slug)}`));
}

/** All data sets; with `url`, only those whose urlPattern matches it (best match first, with matchScore). */
export function listDataSets(t: HubTarget, o: { url?: string } = {}): Promise<DataSetView[]> {
  return hubJson<DataSetView[]>(t, 'GET', projectPath(t, `/data-sets${query({ url: o.url })}`));
}

export function getDataSet(t: HubTarget, slug: string): Promise<DataSetView> {
  return hubJson<DataSetView>(t, 'GET', projectPath(t, `/data-sets/${seg(slug)}`));
}

/** Create or replace by slug. */
export function upsertDataSet(t: HubTarget, ds: DataSetInput): Promise<DataSetView> {
  return hubJson<DataSetView>(t, 'PUT', projectPath(t, `/data-sets/${seg(ds.slug)}`), ds);
}

export function listLoginRecipes(t: HubTarget): Promise<LoginRecipeView[]> {
  return hubJson<LoginRecipeView[]>(t, 'GET', projectPath(t, '/login-recipes'));
}

/** Create or replace the recipe of `r.role`. */
export function upsertLoginRecipe(t: HubTarget, r: LoginRecipeInput): Promise<LoginRecipeView> {
  return hubJson<LoginRecipeView>(t, 'PUT', projectPath(t, `/login-recipes/${seg(r.role)}`), r);
}

/** Store a scanned page (the hub keeps the newest 200 per project). */
export function savePageSnapshot(t: HubTarget, s: PageSnapshotInput): Promise<PageSnapshotView> {
  return hubJson<PageSnapshotView>(t, 'POST', projectPath(t, '/page-snapshots'), s);
}

export function listPageSnapshots(t: HubTarget, o: { url?: string; limit?: number } = {}): Promise<PageSnapshotBrief[]> {
  return hubJson<PageSnapshotBrief[]>(t, 'GET', projectPath(t, `/page-snapshots${query({ url: o.url, limit: o.limit })}`));
}

/** Import a bundle as a whole (validated first, then one transaction). A bundle with problems throws StubyardError(400). */
export function importBundle(t: HubTarget, bundle: StoryboardBundle, o: { mode?: ImportMode; dryRun?: boolean } = {}): Promise<ImportResult> {
  return hubJson<ImportResult>(t, 'POST', projectPath(t, '/storyboards/import'), { bundle, mode: o.mode, dryRun: o.dryRun });
}

/** The named storyboards (default all) with what they reference; secrets are masked unless `secrets`. */
export function exportBundle(t: HubTarget, o: { storyboards?: string[]; secrets?: boolean } = {}): Promise<StoryboardBundle> {
  return hubJson<StoryboardBundle>(t, 'GET', projectPath(t, `/storyboards/export${query({ storyboards: o.storyboards, secrets: o.secrets })}`));
}
