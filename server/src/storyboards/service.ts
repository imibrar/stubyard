import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { TestUser } from '../repos/users.js';
import { HttpError, nowIso } from '../util.js';
import { exportBundle, importBundle } from './bundle.js';
import { PREVIEW_WALKTHROUGH, previewFreshUser, renderEntries, type RenderContext, type RenderUser } from './render.js';
import { StoryboardRepo, type DataSetRecord, type RecipeRecord, type StoryboardRecord } from './repo.js';
import { DataEntry, DataSet, LoginRecipe, PageSnapshot, SLUG, TEMPLATE, type Bundle } from './schema.js';
import type {
  DataSetPatch,
  DataSetView,
  FromSnapshotInput,
  ImportMode,
  ImportResult,
  LoginRecipeView,
  OriginMatch,
  PageSnapshotBrief,
  PageSnapshotView,
  RenderedEntry,
  StoryboardBrief,
  StoryboardService,
  StoryboardView,
  Upserted,
  ValidationIssue,
  ValidationResult,
} from './types.js';
import { urlPatternScore } from './urlPattern.js';
import { effectiveActors, invalidMessage, recipeRolesOf, validateStoryboard, zodIssues, type StoredStoryboard, type ValidateContext, type ValidationUser } from './validate.js';

/** Snapshots kept per project (older ones are pruned on insert). */
export const KEEP_SNAPSHOTS = 200;
/** Storyboard slugs that collide with static routes (/storyboards/export, …). */
export const RESERVED_STORYBOARD_SLUGS = ['export', 'import', 'validate', 'match'];
export const RESERVED_DATA_SET_SLUGS = ['from-snapshot'];

/** JSON with sorted keys and no undefined: the basis of content hashes and "unchanged" checks. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) out[k] = norm(val);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** The content of a storyboard (what the hash covers): no server fields. */
export function storyboardContent(x: StoredStoryboard): StoredStoryboard {
  return { slug: x.slug, name: x.name, description: x.description, intent: x.intent, tags: x.tags, inputs: x.inputs, actors: x.actors, steps: x.steps, preferredMode: x.preferredMode };
}

/** preferredMode is hashed only when it is not the default, so storyboards saved before migration 25 keep their hash. */
export const contentHash = (x: StoredStoryboard) => {
  const c: Partial<StoredStoryboard> = storyboardContent(x);
  if (c.preferredMode === 'tracked') delete c.preferredMode;
  return createHash('sha256').update(canonical(c)).digest('hex');
};
export const recipeContent = (r: LoginRecipe): LoginRecipe => ({ role: r.role, name: r.name, loginUrl: r.loginUrl, fields: r.fields, twoFactor: r.twoFactor, logoutUrl: r.logoutUrl, notes: r.notes });
export const dataSetContent = (d: DataSet): DataSet => ({ slug: d.slug, name: d.name, description: d.description, match: d.match, entries: d.entries });

/** 400 with every issue listed (details: {errors, warnings}). */
export function invalid(what: string, errors: ValidationIssue[], warnings: ValidationIssue[] = []): HttpError {
  return new HttpError(400, invalidMessage(what, errors.length), { errors, warnings });
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The body key (role / slug) must equal the URL key when it is given. */
function withKey(input: unknown, key: 'role' | 'slug', value: string, what: string): Record<string, unknown> {
  const b = obj(input);
  if (b[key] !== undefined && b[key] !== value) {
    throw invalid(what, [{ path: key, code: 'schema', message: `${key} "${String(b[key])}" in the body does not match "${value}" in the URL` }]);
  }
  return { ...b, [key]: value };
}

const toValidationUser = (u: TestUser): ValidationUser => ({ id: u.id, name: u.name, role: u.role, email: u.email, phone: u.phone, password: u.password });
export const toRenderUser = (u: { name: string; email: string | null; phone: string | null; role: string; password: string | null }): RenderUser => ({
  name: u.name,
  email: u.email,
  phone: u.phone,
  role: u.role,
  password: u.password,
});

const DataSetPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  match: z.object({ urlPattern: z.string().max(500).optional(), formId: z.string().max(200).optional() }).optional(),
  entries: z.array(z.unknown()).optional(),
  upsertEntries: z.array(DataEntry).max(300).optional(),
  removeKeys: z.array(z.string()).optional(),
});

const FromSnapshotSchema = z.object({
  snapshot: z.string().min(1),
  slug: SLUG,
  name: z.string().min(1).max(100),
  include: z.enum(['visible', 'all']).default('visible'),
  values: z.record(z.string(), TEMPLATE).optional(),
});

/** Storyboards authoring (docs/design/storyboards.md §3.1–3.6): recipes, data sets, storyboards, snapshots, bundles. */
export class StoryboardServiceImpl implements StoryboardService {
  readonly repo: StoryboardRepo;

  constructor(readonly hub: Hub) {
    this.repo = new StoryboardRepo(hub.db);
  }

  /** storyboards.changed: {kind, slug | id, deleted?}. */
  changed(projectId: string, data: { kind: 'storyboard' | 'dataSet' | 'loginRecipe' | 'snapshot'; slug?: string; id?: string; deleted?: boolean; [k: string]: unknown }): void {
    this.hub.bus.publish({ type: 'storyboards.changed', projectId, data });
  }

  // ---------------------------------------------------------------- discovery

  matchOrigin(origin: string): OriginMatch {
    let o: string;
    try {
      const u = new URL(String(origin ?? '').trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
      o = u.origin.toLowerCase();
    } catch {
      throw new HttpError(400, 'origin must be an origin like http://localhost:3183');
    }
    const count = this.hub.db.prepare('SELECT COUNT(*) AS n FROM storyboards WHERE project_id = ?');
    const projects = this.hub.projects
      .list()
      .filter((p) => (p.settings.appOrigins ?? []).includes(o))
      .map((p) => ({ slug: p.slug, name: p.name, storyboards: Number((count.get(p.id) as { n: number }).n) }));
    return { origin: o, projects };
  }

  // ---------------------------------------------------------------- shared lookups

  /** What validation needs from the DB. */
  validateContext(project: Project): ValidateContext {
    return {
      settings: project.settings,
      dataSets: this.repo.listDataSets(project.id).map((d) => d.slug),
      recipes: this.repo.listRecipes(project.id),
      users: this.hub.users.list(project.id).map(toValidationUser),
      authenticators: this.hub.authenticators.list(project.id).map((a) => ({ label: a.label, testUserId: a.testUserId })),
    };
  }

  private usedBy(projectId: string): { dataSets: Map<string, string[]>; roles: Map<string, string[]> } {
    const dataSets = new Map<string, string[]>();
    const roles = new Map<string, string[]>();
    const push = (m: Map<string, string[]>, k: string, slug: string) => {
      const l = m.get(k) ?? [];
      if (!l.includes(slug)) l.push(slug);
      m.set(k, l);
    };
    for (const sb of this.repo.listStoryboards(projectId)) {
      for (const s of sb.steps) if (s.kind === 'fill') push(dataSets, s.dataSet, sb.slug);
      for (const r of recipeRolesOf(sb)) push(roles, r, sb.slug);
    }
    return { dataSets, roles };
  }

  // ---------------------------------------------------------------- login recipes

  private recipeView(project: Project, r: RecipeRecord, users?: TestUser[]): LoginRecipeView {
    const list = users ?? this.hub.users.list(project.id);
    return { ...r, users: list.filter((u) => u.role === r.role).length };
  }

  listLoginRecipes(project: Project): LoginRecipeView[] {
    const users = this.hub.users.list(project.id);
    return this.repo.listRecipes(project.id).map((r) => this.recipeView(project, r, users));
  }

  getLoginRecipe(project: Project, role: string): LoginRecipeView | null {
    const r = this.repo.getRecipe(project.id, role);
    return r ? this.recipeView(project, r) : null;
  }

  requireLoginRecipe(project: Project, role: string): LoginRecipeView {
    const r = this.getLoginRecipe(project, role);
    if (!r) throw new HttpError(404, `Login recipe for role "${role}" not found`);
    return r;
  }

  parseRecipe(input: unknown, prefix = ''): LoginRecipe {
    const r = LoginRecipe.safeParse(input);
    if (!r.success) throw invalid('Login recipe', zodIssues(r.error, prefix));
    return r.data;
  }

  /** Write without events; `changed` = the content differs from what was stored. */
  saveRecipe(project: Project, x: LoginRecipe): Upserted<RecipeRecord> {
    const existing = this.repo.getRecipe(project.id, x.role);
    if (existing && canonical(recipeContent(existing)) === canonical(recipeContent(x))) return { view: existing, created: false, changed: false };
    return { view: this.repo.saveRecipe(project.id, x), created: !existing, changed: true };
  }

  upsertLoginRecipe(project: Project, role: string, input: unknown): Upserted<LoginRecipeView> {
    const x = this.parseRecipe(withKey(input, 'role', role, 'Login recipe'));
    const r = this.saveRecipe(project, x);
    if (r.changed) this.changed(project.id, { kind: 'loginRecipe', slug: x.role });
    return { ...r, view: this.recipeView(project, r.view) };
  }

  deleteLoginRecipe(project: Project, role: string, opts: { force?: boolean } = {}): void {
    this.requireLoginRecipe(project, role);
    const used = this.usedBy(project.id).roles.get(role) ?? [];
    if (used.length && !opts.force) throw new HttpError(409, `Login recipe "${role}" is used by storyboard${used.length > 1 ? 's' : ''} ${used.join(', ')}; pass ?force=1 to delete it anyway`, { usedBy: used });
    this.repo.deleteRecipe(project.id, role);
    this.changed(project.id, { kind: 'loginRecipe', slug: role, deleted: true });
  }

  // ---------------------------------------------------------------- data sets

  private dataSetView(d: DataSetRecord, usedBy: Map<string, string[]>): DataSetView {
    return { ...d, usedBy: usedBy.get(d.slug) ?? [] };
  }

  listDataSets(project: Project, opts: { url?: string } = {}): DataSetView[] {
    const used = this.usedBy(project.id).dataSets;
    const all = this.repo.listDataSets(project.id).map((d) => this.dataSetView(d, used));
    if (!opts.url) return all;
    const url = opts.url;
    return all
      .flatMap((d) => {
        const score = urlPatternScore(d.match.urlPattern, url);
        return score === null ? [] : [{ ...d, matchScore: score }];
      })
      .sort((a, b) => b.matchScore - a.matchScore || a.slug.localeCompare(b.slug));
  }

  getDataSet(project: Project, slug: string): DataSetView | null {
    const d = this.repo.getDataSet(project.id, slug);
    return d ? this.dataSetView(d, this.usedBy(project.id).dataSets) : null;
  }

  requireDataSet(project: Project, slug: string): DataSetView {
    const d = this.getDataSet(project, slug);
    if (!d) throw new HttpError(404, `Data set "${slug}" not found`);
    return d;
  }

  parseDataSet(input: unknown, prefix = ''): DataSet {
    const r = DataSet.safeParse(input);
    if (!r.success) throw invalid('Data set', zodIssues(r.error, prefix));
    if (RESERVED_DATA_SET_SLUGS.includes(r.data.slug)) throw invalid('Data set', [{ path: prefix ? `${prefix}.slug` : 'slug', code: 'schema', message: `"${r.data.slug}" is reserved` }]);
    return r.data;
  }

  saveDataSet(project: Project, x: DataSet): Upserted<DataSetRecord> {
    const existing = this.repo.getDataSet(project.id, x.slug);
    if (existing && canonical(dataSetContent(existing)) === canonical(dataSetContent(x))) return { view: existing, created: false, changed: false };
    return { view: this.repo.saveDataSet(project.id, x), created: !existing, changed: true };
  }

  upsertDataSet(project: Project, slug: string, input: unknown): Upserted<DataSetView> {
    const x = this.parseDataSet(withKey(input, 'slug', slug, 'Data set'));
    const r = this.saveDataSet(project, x);
    if (r.changed) this.changed(project.id, { kind: 'dataSet', slug: x.slug });
    return { ...r, view: this.dataSetView(r.view, this.usedBy(project.id).dataSets) };
  }

  patchDataSet(project: Project, slug: string, patch: DataSetPatch): DataSetView {
    const cur = this.requireDataSet(project, slug);
    const p = DataSetPatchSchema.safeParse(patch);
    if (!p.success) throw invalid('Data set patch', zodIssues(p.error));
    const b = p.data;
    let entries: unknown[] = b.entries ?? cur.entries;
    for (const u of b.upsertEntries ?? []) {
      const i = entries.findIndex((e) => obj(e).key === u.key);
      if (i >= 0) entries = entries.map((e, j) => (j === i ? u : e));
      else entries = [...entries, u];
    }
    if (b.removeKeys?.length) entries = entries.filter((e) => !b.removeKeys!.includes(String(obj(e).key)));
    const next = this.parseDataSet({ slug, name: b.name ?? cur.name, description: b.description ?? cur.description, match: b.match ?? cur.match, entries });
    const r = this.saveDataSet(project, next);
    if (r.changed) this.changed(project.id, { kind: 'dataSet', slug });
    return this.dataSetView(r.view, this.usedBy(project.id).dataSets);
  }

  deleteDataSet(project: Project, slug: string, opts: { force?: boolean } = {}): void {
    const d = this.requireDataSet(project, slug);
    if (d.usedBy.length && !opts.force) {
      throw new HttpError(409, `Data set "${slug}" is used by storyboard${d.usedBy.length > 1 ? 's' : ''} ${d.usedBy.join(', ')}; pass ?force=1 to delete it anyway`, { usedBy: d.usedBy });
    }
    this.repo.deleteDataSet(project.id, slug);
    this.changed(project.id, { kind: 'dataSet', slug, deleted: true });
  }

  /**
   * Renders the entries for one actor. With `walkthrough`: that walkthrough's users, vars and identity. Otherwise the
   * authoring context: `storyboard` (default: the first one that uses the data set) gives the actors, resolved as at
   * start (fresh actors get a placeholder user); `actor` defaults to the actor of the first fill step using it.
   */
  previewDataSet(project: Project, slug: string, opts: { storyboard?: string; actor?: string; walkthrough?: string }): { entries: RenderedEntry[]; warnings: string[] } {
    const ds = this.requireDataSet(project, slug);
    const proj = { slug: project.slug, name: project.name, settings: project.settings };
    let ctx: RenderContext;
    if (opts.walkthrough) {
      if (!this.hub.walkthroughs) throw new HttpError(400, 'Walkthroughs are not available on this hub');
      const w = this.hub.walkthroughs.get(project, opts.walkthrough);
      if (!w) throw new HttpError(404, `Walkthrough "${opts.walkthrough}" not found`);
      const keys = Object.keys(w.actors);
      if (opts.actor && !keys.includes(opts.actor)) throw new HttpError(400, `actor "${opts.actor}" is not an actor of walkthrough ${w.key}`, { expected: keys });
      ctx = {
        project: proj,
        walkthrough: { id: w.id, key: w.key, startedAt: w.startedAt, origin: w.origin },
        actors: Object.fromEntries(Object.entries(w.actors).map(([k, a]) => [k, a.missing ? null : toRenderUser(a)])),
        actor: opts.actor ?? keys[0] ?? null,
        vars: w.vars,
      };
    } else {
      const sbRef = opts.storyboard ?? ds.usedBy[0];
      const sb = sbRef ? this.repo.getStoryboard(project.id, sbRef) : null;
      if (opts.storyboard && !sb) throw new HttpError(404, `Storyboard "${opts.storyboard}" not found`);
      const actors: Record<string, RenderUser | null> = {};
      let actor: string | null = null;
      const vars: Record<string, string> = {};
      if (sb) {
        for (const a of sb.actors) {
          if (a.fresh) actors[a.key] = previewFreshUser(proj, a.role);
          else {
            const u = this.hub.users.resolve(project.id, a.user ?? a.role);
            actors[a.key] = u ? toRenderUser(u) : null;
          }
        }
        for (const x of sb.inputs) if (x.default !== undefined) vars[x.name] = x.default;
        const eff = effectiveActors(sb);
        const i = sb.steps.findIndex((s) => s.kind === 'fill' && s.dataSet === slug);
        actor = opts.actor ?? (i >= 0 ? eff[i] : null) ?? sb.actors[0]?.key ?? null;
        if (opts.actor && !(opts.actor in actors)) throw new HttpError(400, `actor "${opts.actor}" is not an actor of storyboard ${sb.slug}`, { expected: Object.keys(actors) });
      } else if (opts.actor) {
        // No storyboard: `actor` is read as a test-user ref (id, email, name or role).
        const u = this.hub.users.requireRef(project.id, opts.actor);
        actors[opts.actor] = toRenderUser(u);
        actor = opts.actor;
      }
      ctx = { project: proj, walkthrough: { ...PREVIEW_WALKTHROUGH, startedAt: nowIso(), origin: '' }, actors, actor, vars };
    }
    return renderEntries(ctx, ds.entries);
  }

  dataSetFromSnapshot(project: Project, input: FromSnapshotInput): DataSetView {
    const p = FromSnapshotSchema.safeParse(input);
    if (!p.success) throw invalid('Request', zodIssues(p.error));
    const b = p.data;
    const snap = this.requirePageSnapshot(project, b.snapshot);
    if (this.repo.getDataSet(project.id, b.slug)) throw new HttpError(409, `Data set "${b.slug}" already exists`);
    const seen = new Set<string>();
    const entries = snap.fields
      .filter((f) => (b.include === 'all' || f.visible) && f.key && !seen.has(f.key) && seen.add(f.key))
      .map((f) => {
        const v = b.values?.[f.key] ?? f.value;
        const value = v === null || v === undefined ? (f.kind === 'checkbox' || f.kind === 'radix-checkbox' ? false : '') : v;
        return { key: f.key, value, kind: f.kind, ...(f.label ? { label: f.label } : {}) };
      });
    const match: DataSet['match'] = {};
    if (snap.urlPattern) match.urlPattern = snap.urlPattern;
    if (snap.formId) match.formId = snap.formId;
    const x = this.parseDataSet({ slug: b.slug, name: b.name, description: `From the page snapshot of ${snap.url}`, match, entries });
    const r = this.saveDataSet(project, x);
    this.changed(project.id, { kind: 'dataSet', slug: x.slug });
    return this.dataSetView(r.view, this.usedBy(project.id).dataSets);
  }

  // ---------------------------------------------------------------- storyboards

  private view(project: Project, r: StoryboardRecord): StoryboardView {
    const v = validateStoryboard(this.validateContext(project), storyboardContent(r));
    const { contentHash: _h, ...rest } = r;
    // On read nothing blocks: references may have changed since the save, so every current issue is listed as a warning.
    return { ...rest, refs: v.refs, warnings: [...v.errors, ...v.warnings] };
  }

  private brief(r: StoryboardRecord): StoryboardBrief {
    const last = this.repo.lastWalkthrough(r.id);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      tags: r.tags,
      preferredMode: r.preferredMode,
      version: r.version,
      steps: r.steps.length,
      actors: r.actors.map((a) => ({ key: a.key, role: a.role, fresh: a.fresh })),
      updatedAt: r.updatedAt,
      ...(last ? { lastWalkthrough: last as StoryboardBrief['lastWalkthrough'] } : {}),
    };
  }

  listStoryboards(project: Project, opts: { tag?: string } = {}): StoryboardBrief[] {
    return this.repo
      .listStoryboards(project.id)
      .filter((s) => !opts.tag || s.tags.includes(opts.tag))
      .map((s) => this.brief(s));
  }

  getStoryboard(project: Project, slugOrId: string): StoryboardView | null {
    const r = this.repo.getStoryboard(project.id, slugOrId);
    return r ? this.view(project, r) : null;
  }

  requireStoryboard(project: Project, slugOrId: string): StoryboardView {
    const s = this.getStoryboard(project, slugOrId);
    if (!s) throw new HttpError(404, `Storyboard "${slugOrId}" not found`);
    return s;
  }

  /** Write without validation or events; the version goes up only when the content hash changes. */
  saveStoryboard(project: Project, x: StoredStoryboard): Upserted<StoryboardRecord> {
    const hash = contentHash(x);
    const existing = this.repo.getStoryboard(project.id, x.slug);
    if (existing && existing.slug === x.slug && existing.contentHash === hash) return { view: existing, created: false, changed: false };
    const owned = existing && existing.slug === x.slug ? existing : null;
    return { view: this.repo.saveStoryboard(project.id, x, hash, owned ? owned.version + 1 : 1), created: !owned, changed: true };
  }

  upsertStoryboard(project: Project, slug: string, input: unknown): Upserted<StoryboardView> {
    const body = withKey(input, 'slug', slug, 'Storyboard');
    const v = validateStoryboard(this.validateContext(project), body);
    if (v.ok && RESERVED_STORYBOARD_SLUGS.includes(slug)) v.errors.push({ path: 'slug', code: 'schema', message: `"${slug}" is reserved` });
    if (v.errors.length || !v.storyboard) throw invalid('Storyboard', v.errors, v.warnings);
    const r = this.saveStoryboard(project, v.storyboard);
    if (r.changed) this.changed(project.id, { kind: 'storyboard', slug });
    const { contentHash: _h, ...rest } = r.view;
    return { ...r, view: { ...rest, refs: v.refs, warnings: v.warnings } };
  }

  deleteStoryboard(project: Project, slug: string): void {
    const s = this.requireStoryboard(project, slug);
    this.repo.deleteStoryboard(project.id, s.slug);
    this.changed(project.id, { kind: 'storyboard', slug: s.slug, deleted: true });
  }

  validateStoryboard(project: Project, input: { storyboard?: unknown; slug?: string }): ValidationResult {
    let sb = input.storyboard;
    if (sb === undefined) {
      if (!input.slug) throw new HttpError(400, 'Send {"storyboard": {...}} or {"slug": "..."}');
      sb = storyboardContent(this.repo.getStoryboard(project.id, input.slug) ?? (() => {
        throw new HttpError(404, `Storyboard "${input.slug}" not found`);
      })());
    }
    const { storyboard: _s, ...r } = validateStoryboard(this.validateContext(project), sb);
    return r;
  }

  duplicateStoryboard(project: Project, slug: string, to: { slug: string; name?: string }): StoryboardView {
    const src = this.repo.getStoryboard(project.id, slug);
    if (!src) throw new HttpError(404, `Storyboard "${slug}" not found`);
    const t = obj(to);
    const p = z.object({ slug: SLUG, name: z.string().min(1).max(150).optional() }).safeParse(t);
    if (!p.success) throw invalid('Request', zodIssues(p.error));
    if (RESERVED_STORYBOARD_SLUGS.includes(p.data.slug)) throw invalid('Request', [{ path: 'slug', code: 'schema', message: `"${p.data.slug}" is reserved` }]);
    if (this.repo.getStoryboard(project.id, p.data.slug)) throw new HttpError(409, `Storyboard "${p.data.slug}" already exists`);
    const name = p.data.name ?? `${src.name} (copy)`.slice(0, 150);
    const x: StoredStoryboard = { ...storyboardContent(src), slug: p.data.slug, name };
    const r = this.saveStoryboard(project, x);
    this.changed(project.id, { kind: 'storyboard', slug: x.slug });
    return this.view(project, r.view);
  }

  // ---------------------------------------------------------------- page snapshots

  savePageSnapshot(project: Project, input: unknown): PageSnapshotView {
    const p = PageSnapshot.safeParse(input);
    if (!p.success) throw invalid('Page snapshot', zodIssues(p.error));
    const snap = this.repo.insertSnapshot(project.id, p.data);
    this.repo.pruneSnapshots(project.id, KEEP_SNAPSHOTS);
    this.changed(project.id, { kind: 'snapshot', id: snap.id });
    return snap;
  }

  /** `url`: snapshots whose urlPattern matches it, or whose URL has the same path. */
  listPageSnapshots(project: Project, opts: { url?: string; limit?: number } = {}): PageSnapshotBrief[] {
    const limit = Math.min(KEEP_SNAPSHOTS, Math.max(1, Math.floor(opts.limit ?? 50) || 50));
    const pathOf = (u: string) => {
      try {
        return new URL(u).pathname.replace(/\/+$/, '') || '/';
      } catch {
        return u.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
      }
    };
    const url = opts.url;
    return this.repo
      .listSnapshots(project.id)
      .filter((s) => !url || (s.urlPattern ? urlPatternScore(s.urlPattern, url) !== null : pathOf(s.url) === pathOf(url)))
      .slice(0, limit)
      .map((s) => ({ id: s.id, url: s.url, urlPattern: s.urlPattern, title: s.title, formId: s.formId, fields: s.fields.length, source: s.source, createdAt: s.createdAt }));
  }

  getPageSnapshot(project: Project, id: string): PageSnapshotView | null {
    return this.repo.getSnapshot(project.id, id);
  }

  requirePageSnapshot(project: Project, id: string): PageSnapshotView {
    const s = this.repo.getSnapshot(project.id, id);
    if (!s) throw new HttpError(404, `Page snapshot "${id}" not found`);
    return s;
  }

  deletePageSnapshot(project: Project, id: string): void {
    this.requirePageSnapshot(project, id);
    this.repo.deleteSnapshot(project.id, id);
    this.changed(project.id, { kind: 'snapshot', id, deleted: true });
  }

  // ---------------------------------------------------------------- bundles

  exportBundle(project: Project, opts: { storyboards?: string[]; secrets?: boolean } = {}): Bundle {
    return exportBundle(this, project, opts);
  }

  importBundle(project: Project, bundle: unknown, opts: { mode?: ImportMode; dryRun?: boolean } = {}): ImportResult {
    return importBundle(this, project, bundle, opts);
  }

  // ---------------------------------------------------------------- housekeeping

  resetProject(projectId: string): void {
    if (this.repo.deleteSnapshots(projectId)) this.changed(projectId, { kind: 'snapshot', deleted: true, reset: true });
  }
}
