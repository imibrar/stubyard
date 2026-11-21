import type { DB } from '../db/index.js';
import { newId, nowIso, parseJson } from '../util.js';
import type { DataSet, LoginRecipe, PageSnapshot } from './schema.js';
import type { PageSnapshotView, ServerFields, StoredStep } from './types.js';
import type { StoredStoryboard } from './validate.js';

/** login_recipes, data_sets, storyboards, page_snapshots (migration 24). Plain SQL, no validation. */

type Row = Record<string, any>;

export type RecipeRecord = LoginRecipe & ServerFields;
export type DataSetRecord = DataSet & ServerFields;
export type StoryboardRecord = StoredStoryboard & ServerFields & { version: number; contentHash: string };

const toRecipe = (r: Row): RecipeRecord => ({
  role: r.role,
  name: r.name,
  loginUrl: r.login_url,
  fields: parseJson(r.fields, { username: '#email', password: '#password' }),
  twoFactor: parseJson(r.two_factor, { kind: 'none' }),
  logoutUrl: r.logout_url ?? null,
  notes: r.notes,
  id: r.id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toDataSet = (r: Row): DataSetRecord => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  match: parseJson(r.match, {}),
  entries: parseJson(r.entries, []),
  id: r.id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toStoryboard = (r: Row): StoryboardRecord => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  intent: r.intent,
  tags: parseJson(r.tags, []),
  inputs: parseJson(r.inputs, []),
  actors: parseJson(r.actors, []),
  steps: parseJson<StoredStep[]>(r.steps, []),
  id: r.id,
  version: r.version,
  contentHash: r.content_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSnapshot = (r: Row): PageSnapshotView => ({
  url: r.url,
  urlPattern: r.url_pattern,
  title: r.title,
  formId: r.form_id ?? null,
  fields: parseJson(r.fields, []),
  note: r.note,
  source: r.source,
  id: r.id,
  createdAt: r.created_at,
});

export class StoryboardRepo {
  constructor(private db: DB) {}

  // ---------------- login recipes

  listRecipes(projectId: string): RecipeRecord[] {
    return (this.db.prepare('SELECT * FROM login_recipes WHERE project_id = ? ORDER BY role').all(projectId) as Row[]).map(toRecipe);
  }

  getRecipe(projectId: string, role: string): RecipeRecord | null {
    const r = this.db.prepare('SELECT * FROM login_recipes WHERE project_id = ? AND role = ?').get(projectId, role) as Row | undefined;
    return r ? toRecipe(r) : null;
  }

  /** Insert or update by role. */
  saveRecipe(projectId: string, x: LoginRecipe): RecipeRecord {
    const now = nowIso();
    const existing = this.getRecipe(projectId, x.role);
    const vals = [x.name, x.loginUrl, JSON.stringify(x.fields), JSON.stringify(x.twoFactor), x.logoutUrl, x.notes];
    if (existing) {
      this.db.prepare('UPDATE login_recipes SET name=?, login_url=?, fields=?, two_factor=?, logout_url=?, notes=?, updated_at=? WHERE id=?').run(...vals, now, existing.id);
    } else {
      this.db
        .prepare('INSERT INTO login_recipes (id, project_id, role, name, login_url, fields, two_factor, logout_url, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId(), projectId, x.role, ...vals, now, now);
    }
    return this.getRecipe(projectId, x.role)!;
  }

  deleteRecipe(projectId: string, role: string): boolean {
    return this.db.prepare('DELETE FROM login_recipes WHERE project_id = ? AND role = ?').run(projectId, role).changes > 0;
  }

  // ---------------- data sets

  listDataSets(projectId: string): DataSetRecord[] {
    return (this.db.prepare('SELECT * FROM data_sets WHERE project_id = ? ORDER BY slug').all(projectId) as Row[]).map(toDataSet);
  }

  getDataSet(projectId: string, slug: string): DataSetRecord | null {
    const r = this.db.prepare('SELECT * FROM data_sets WHERE project_id = ? AND slug = ?').get(projectId, slug) as Row | undefined;
    return r ? toDataSet(r) : null;
  }

  saveDataSet(projectId: string, x: DataSet): DataSetRecord {
    const now = nowIso();
    const existing = this.getDataSet(projectId, x.slug);
    const vals = [x.name, x.description, JSON.stringify(x.match), JSON.stringify(x.entries)];
    if (existing) {
      this.db.prepare('UPDATE data_sets SET name=?, description=?, match=?, entries=?, updated_at=? WHERE id=?').run(...vals, now, existing.id);
    } else {
      this.db
        .prepare('INSERT INTO data_sets (id, project_id, slug, name, description, match, entries, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(newId(), projectId, x.slug, ...vals, now, now);
    }
    return this.getDataSet(projectId, x.slug)!;
  }

  deleteDataSet(projectId: string, slug: string): boolean {
    return this.db.prepare('DELETE FROM data_sets WHERE project_id = ? AND slug = ?').run(projectId, slug).changes > 0;
  }

  // ---------------- storyboards

  listStoryboards(projectId: string): StoryboardRecord[] {
    return (this.db.prepare('SELECT * FROM storyboards WHERE project_id = ? ORDER BY name COLLATE NOCASE, slug').all(projectId) as Row[]).map(toStoryboard);
  }

  /** By slug or id. */
  getStoryboard(projectId: string, ref: string): StoryboardRecord | null {
    const r = this.db.prepare('SELECT * FROM storyboards WHERE project_id = ? AND (slug = ? OR id = ?) ORDER BY slug = ? DESC LIMIT 1').get(projectId, ref, ref, ref) as Row | undefined;
    return r ? toStoryboard(r) : null;
  }

  /** Insert (version 1) or update with the given version. */
  saveStoryboard(projectId: string, x: StoredStoryboard, hash: string, version: number): StoryboardRecord {
    const now = nowIso();
    const existing = this.db.prepare('SELECT id FROM storyboards WHERE project_id = ? AND slug = ?').get(projectId, x.slug) as Row | undefined;
    const vals = [x.name, x.description, x.intent, JSON.stringify(x.tags), JSON.stringify(x.inputs), JSON.stringify(x.actors), JSON.stringify(x.steps), version, hash];
    if (existing) {
      this.db.prepare('UPDATE storyboards SET name=?, description=?, intent=?, tags=?, inputs=?, actors=?, steps=?, version=?, content_hash=?, updated_at=? WHERE id=?').run(...vals, now, existing.id);
    } else {
      this.db
        .prepare('INSERT INTO storyboards (id, project_id, slug, name, description, intent, tags, inputs, actors, steps, version, content_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(newId(), projectId, x.slug, ...vals, now, now);
    }
    return this.getStoryboard(projectId, x.slug)!;
  }

  /** Walkthroughs keep their snapshot; their storyboard_id becomes NULL (FK ON DELETE SET NULL). */
  deleteStoryboard(projectId: string, slug: string): boolean {
    return this.db.prepare('DELETE FROM storyboards WHERE project_id = ? AND slug = ?').run(projectId, slug).changes > 0;
  }

  lastWalkthrough(storyboardId: string): { id: string; status: string; verdict: string | null; startedAt: string } | null {
    const r = this.db.prepare('SELECT id, status, verdict, started_at FROM walkthroughs WHERE storyboard_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(storyboardId) as Row | undefined;
    return r ? { id: r.id, status: r.status, verdict: r.verdict ?? null, startedAt: r.started_at } : null;
  }

  // ---------------- page snapshots

  insertSnapshot(projectId: string, x: PageSnapshot): PageSnapshotView {
    const id = newId();
    this.db
      .prepare('INSERT INTO page_snapshots (id, project_id, source, url, url_pattern, title, form_id, fields, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, x.source, x.url, x.urlPattern, x.title, x.formId, JSON.stringify(x.fields), x.note, nowIso());
    return this.getSnapshot(projectId, id)!;
  }

  /** Newest first. */
  listSnapshots(projectId: string): PageSnapshotView[] {
    return (this.db.prepare('SELECT * FROM page_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(projectId) as Row[]).map(toSnapshot);
  }

  getSnapshot(projectId: string, id: string): PageSnapshotView | null {
    const r = this.db.prepare('SELECT * FROM page_snapshots WHERE project_id = ? AND id = ?').get(projectId, id) as Row | undefined;
    return r ? toSnapshot(r) : null;
  }

  deleteSnapshot(projectId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM page_snapshots WHERE project_id = ? AND id = ?').run(projectId, id).changes > 0;
  }

  /** Keeps the newest `keep` snapshots of the project; returns how many went. */
  pruneSnapshots(projectId: string, keep: number): number {
    return this.db
      .prepare('DELETE FROM page_snapshots WHERE project_id = ? AND id NOT IN (SELECT id FROM page_snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)')
      .run(projectId, projectId, keep).changes;
  }

  deleteSnapshots(projectId: string): number {
    return this.db.prepare('DELETE FROM page_snapshots WHERE project_id = ?').run(projectId).changes;
  }
}
