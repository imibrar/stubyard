import { z } from 'zod';
import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import { imageSize } from '../storage/image-size.js';
import { HttpError, newId, nowIso } from '../util.js';

/**
 * Features board (migration 28): a light per-project plan. A feature has markdown details, a status, an optional
 * priority, images and an optional storyboard link; tasks hang under a feature and subtasks under a task (two levels
 * only). Features are numbered per project (key "F-<n>"; feature_counters keeps numbers from being reused). Images are
 * BLOBs in feature_images (PNG, JPEG, WebP or GIF, checked by their bytes) and go with the feature (ON DELETE CASCADE).
 * Project reset keeps the board; deleting the project deletes it. Events: features.changed {id, key, kind}.
 */

export const FEATURE_STATUSES = ['idea', 'planned', 'in_progress', 'done'] as const;
export const FEATURE_PRIORITIES = ['none', 'low', 'medium', 'high'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export type FeaturePriority = (typeof FEATURE_PRIORITIES)[number];

/** Limits (mutable for tests). */
export interface FeatureLimits {
  imageBytes: number;
  imagesPerFeature: number;
  projectImageBytes: number;
  featuresPerProject: number;
  tasksPerFeature: number;
}
export const DEFAULT_FEATURE_LIMITS: FeatureLimits = {
  imageBytes: 5 * 1024 * 1024,
  imagesPerFeature: 20,
  projectImageBytes: 200 * 1024 * 1024,
  featuresPerProject: 1000,
  tasksPerFeature: 500,
};
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const FORMAT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

const TITLE = z.string().trim().min(1, 'is required').max(200, 'is longer than 200 characters');
const DETAILS = z.string().max(100_000, 'is longer than 100000 characters');
const NOTE = z.string().max(4000, 'is longer than 4000 characters');
const ASSIGNEE = z.string().trim().max(80, 'is longer than 80 characters');

export interface TaskInputTree {
  title: string;
  done?: boolean;
  note?: string;
  assignee?: string;
  subtasks?: TaskInputTree[];
}
const SubtaskIn = z.strictObject({ title: TITLE, done: z.boolean().optional(), note: NOTE.optional(), assignee: ASSIGNEE.optional() });
const TaskIn = SubtaskIn.extend({ subtasks: z.array(z.unknown()).max(200).optional() });

export const FeatureCreate = z.strictObject({
  title: TITLE,
  details: DETAILS.optional(),
  status: z.enum(FEATURE_STATUSES).optional(),
  priority: z.enum(FEATURE_PRIORITIES).optional(),
  /** Storyboard slug or id; null / "" = none. */
  storyboard: z.string().max(200).nullable().optional(),
  tasks: z.array(z.unknown()).max(500).optional(),
});
export const FeaturePatch = z.strictObject({
  title: TITLE.optional(),
  details: DETAILS.optional(),
  status: z.enum(FEATURE_STATUSES).optional(),
  priority: z.enum(FEATURE_PRIORITIES).optional(),
  storyboard: z.string().max(200).nullable().optional(),
});
export const TaskCreate = z.strictObject({
  title: TITLE,
  done: z.boolean().optional(),
  note: NOTE.optional(),
  assignee: ASSIGNEE.optional(),
  /** Parent task id: the new task is a subtask of it. */
  parentTaskId: z.string().max(64).nullable().optional(),
  /** 0-based place among its siblings (default: last). */
  position: z.number().int().min(0).optional(),
  subtasks: z.array(z.unknown()).max(200).optional(),
});
export const TaskPatch = z.strictObject({
  title: TITLE.optional(),
  done: z.boolean().optional(),
  note: NOTE.optional(),
  assignee: ASSIGNEE.optional(),
  /** Move under another task (subtask) or to the top level (null). Goes last among the new siblings. */
  parentTaskId: z.string().max(64).nullable().optional(),
});
const Reorder = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(2000) });
const TaskReorder = z.strictObject({ parentTaskId: z.string().nullable().optional(), ids: z.array(z.string().min(1)).min(1).max(1000) });

/** zod → HttpError 400 "<what>: <path> <message>" with every issue in details. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: i.code, message: i.message }));
  const first = issues[0];
  const msg = first.code === 'unrecognized_keys' ? `${what}: ${first.message}` : `${what}: ${first.path || 'value'} ${first.message}`;
  throw new HttpError(400, msg, issues);
}

interface FeatureRow {
  id: string;
  project_id: string;
  number: number;
  title: string;
  details: string;
  status: string;
  priority: string;
  position: number;
  storyboard_id: string | null;
  created_at: string;
  updated_at: string;
}
interface TaskRow {
  id: string;
  feature_id: string;
  parent_task_id: string | null;
  title: string;
  done: number;
  note: string;
  assignee: string;
  position: number;
  done_at: string | null;
  created_at: string;
  updated_at: string;
}
interface ImageRow {
  id: string;
  feature_id: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  position: number;
  created_at: string;
}
const IMAGE_COLS = 'id, feature_id, name, mime, bytes, width, height, position, created_at';
const TASK_INSERT = 'INSERT INTO feature_tasks (id, feature_id, project_id, parent_task_id, title, done, note, assignee, position, done_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';

export interface FeatureTask {
  id: string;
  parentTaskId: string | null;
  title: string;
  done: boolean;
  note: string;
  assignee: string;
  position: number;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Top-level tasks only. */
  subtasks?: FeatureTask[];
}
export interface FeatureImage {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** GET this path for the bytes. */
  url: string;
  /** What to write in the details markdown: ![name](image:<id>). */
  markdown: string;
  createdAt: string;
}
export interface FeatureBrief {
  id: string;
  key: string;
  number: number;
  title: string;
  status: FeatureStatus;
  priority: FeaturePriority;
  position: number;
  storyboard: { id: string; slug: string; name: string } | null;
  /** Tasks and subtasks together. */
  progress: { done: number; total: number };
  imageCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface FeatureView extends FeatureBrief {
  details: string;
  tasks: FeatureTask[];
  images: FeatureImage[];
}
type TaskResult = { task: FeatureTask; feature: FeatureBrief };

const enc = encodeURIComponent;

export class FeatureService {
  limits: FeatureLimits = { ...DEFAULT_FEATURE_LIMITS };
  constructor(private hub: Hub) {}

  private get db() {
    return this.hub.db;
  }

  changed(project: Project, data: Record<string, unknown>): void {
    this.hub.bus.publish({ type: 'features.changed', projectId: project.id, data });
  }

  // ------------------------------------------------------------------------------------------------ lookups

  /** By id, "F-12", "f-12" or "12". */
  private row(project: Project, ref: string): FeatureRow | null {
    const m = /^(?:f-?)?(\d{1,9})$/i.exec(ref.trim());
    if (m) {
      const r = this.db.prepare('SELECT * FROM features WHERE project_id = ? AND number = ?').get(project.id, Number(m[1])) as FeatureRow | undefined;
      if (r) return r;
    }
    return (this.db.prepare('SELECT * FROM features WHERE project_id = ? AND id = ?').get(project.id, ref) as FeatureRow | undefined) ?? null;
  }
  requireRow(project: Project, ref: string): FeatureRow {
    const r = this.row(project, ref);
    if (!r) throw new HttpError(404, `Feature "${ref}" not found in project ${project.slug}`);
    return r;
  }
  private taskRow(featureId: string, taskId: string): TaskRow {
    const t = this.db.prepare('SELECT * FROM feature_tasks WHERE feature_id = ? AND id = ?').get(featureId, taskId) as TaskRow | undefined;
    if (!t) throw new HttpError(404, `Task "${taskId}" not found in this feature`);
    return t;
  }
  private storyboardOf(project: Project, ref: string | null | undefined): string | null {
    if (ref === undefined || ref === null || ref.trim() === '') return null;
    const sb = this.storyboardRef(project, ref.trim());
    if (!sb) throw new HttpError(400, `Storyboard "${ref}" not found in project ${project.slug}`);
    return sb.id;
  }
  private storyboardRef(project: Project, ref: string): { id: string } | null {
    return (this.db.prepare('SELECT id FROM storyboards WHERE project_id = ? AND (slug = ? OR id = ?) ORDER BY slug = ? DESC LIMIT 1').get(project.id, ref, ref, ref) as { id: string } | undefined) ?? null;
  }
  private count(sql: string, ...args: (string | null)[]): number {
    return (this.db.prepare(sql).get(...args) as { n: number }).n;
  }

  // ------------------------------------------------------------------------------------------------ views

  private imageView(project: Project, f: FeatureRow, i: ImageRow): FeatureImage {
    return {
      id: i.id,
      name: i.name,
      mime: i.mime,
      bytes: i.bytes,
      width: i.width,
      height: i.height,
      url: `/api/projects/${enc(project.slug)}/features/${f.id}/images/${i.id}`,
      markdown: `![${i.name.replace(/[[\]]/g, '')}](image:${i.id})`,
      createdAt: i.created_at,
    };
  }
  private taskView(t: TaskRow): FeatureTask {
    return { id: t.id, parentTaskId: t.parent_task_id, title: t.title, done: !!t.done, note: t.note, assignee: t.assignee, position: t.position, doneAt: t.done_at, createdAt: t.created_at, updatedAt: t.updated_at };
  }
  private brief(project: Project, f: FeatureRow, counts?: { done: number; total: number; images: number }): FeatureBrief {
    const c =
      counts ??
      (this.db
        .prepare('SELECT (SELECT COUNT(*) FROM feature_tasks WHERE feature_id = ?1 AND done = 1) AS done, (SELECT COUNT(*) FROM feature_tasks WHERE feature_id = ?1) AS total, (SELECT COUNT(*) FROM feature_images WHERE feature_id = ?1) AS images')
        .get(f.id) as { done: number; total: number; images: number });
    let storyboard: FeatureBrief['storyboard'] = null;
    if (f.storyboard_id) {
      const sb = this.db.prepare('SELECT id, slug, name FROM storyboards WHERE id = ?').get(f.storyboard_id) as { id: string; slug: string; name: string } | undefined;
      storyboard = sb ? { id: sb.id, slug: sb.slug, name: sb.name } : null;
    }
    return {
      id: f.id,
      key: `F-${f.number}`,
      number: f.number,
      title: f.title,
      status: f.status as FeatureStatus,
      priority: f.priority as FeaturePriority,
      position: f.position,
      storyboard,
      progress: { done: c.done, total: c.total },
      imageCount: c.images,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    };
  }
  tasksOf(featureId: string): FeatureTask[] {
    const rows = this.db.prepare('SELECT * FROM feature_tasks WHERE feature_id = ? ORDER BY position, created_at, id').all(featureId) as TaskRow[];
    const top = rows.filter((r) => !r.parent_task_id).map((r) => ({ ...this.taskView(r), subtasks: [] as FeatureTask[] }));
    const byId = new Map(top.map((t) => [t.id, t]));
    for (const r of rows) if (r.parent_task_id) byId.get(r.parent_task_id)?.subtasks.push(this.taskView(r));
    return top;
  }
  private imagesOf(project: Project, f: FeatureRow): FeatureImage[] {
    const rows = this.db.prepare(`SELECT ${IMAGE_COLS} FROM feature_images WHERE feature_id = ? ORDER BY position, created_at, id`).all(f.id) as ImageRow[];
    return rows.map((i) => this.imageView(project, f, i));
  }
  view(project: Project, f: FeatureRow): FeatureView {
    return { ...this.brief(project, f), details: f.details, tasks: this.tasksOf(f.id), images: this.imagesOf(project, f) };
  }
  get(project: Project, ref: string): FeatureView {
    return this.view(project, this.requireRow(project, ref));
  }

  /** In board order. status: one or more statuses; q: words found in the title, details, key, or a task's title, note or assignee. */
  list(project: Project, opts: { status?: FeatureStatus[]; q?: string; full?: boolean } = {}): (FeatureBrief | FeatureView)[] {
    const where = ['f.project_id = ?'];
    const args: (string | number)[] = [project.id];
    if (opts.status?.length) {
      where.push(`f.status IN (${opts.status.map(() => '?').join(',')})`);
      args.push(...opts.status);
    }
    for (const word of (opts.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${word.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      where.push(
        "(f.title LIKE ? ESCAPE '!' OR f.details LIKE ? ESCAPE '!' OR ('F-' || f.number) LIKE ? ESCAPE '!' OR EXISTS (SELECT 1 FROM feature_tasks t WHERE t.feature_id = f.id AND (t.title LIKE ? ESCAPE '!' OR t.note LIKE ? ESCAPE '!' OR t.assignee LIKE ? ESCAPE '!')))",
      );
      args.push(like, like, like, like, like, like);
    }
    const rows = this.db
      .prepare(
        `SELECT f.*, (SELECT COUNT(*) FROM feature_tasks t WHERE t.feature_id = f.id AND t.done = 1) AS c_done, (SELECT COUNT(*) FROM feature_tasks t WHERE t.feature_id = f.id) AS c_total, (SELECT COUNT(*) FROM feature_images i WHERE i.feature_id = f.id) AS c_images FROM features f WHERE ${where.join(' AND ')} ORDER BY f.position, f.number`,
      )
      .all(...args) as (FeatureRow & { c_done: number; c_total: number; c_images: number })[];
    return rows.map((r) => (opts.full ? this.view(project, r) : this.brief(project, r, { done: r.c_done, total: r.c_total, images: r.c_images })));
  }

  /** Counts per status (for the filter chips). */
  counts(project: Project): Record<FeatureStatus | 'all', number> {
    const out: Record<FeatureStatus | 'all', number> = { idea: 0, planned: 0, in_progress: 0, done: 0, all: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM features WHERE project_id = ? GROUP BY status').all(project.id) as { status: FeatureStatus; n: number }[]) {
      if (r.status in out) out[r.status] = r.n;
      out.all += r.n;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ features

  create(project: Project, body: unknown): FeatureView {
    const b = parseBody(FeatureCreate, body, 'Feature');
    const tasks = b.tasks === undefined ? [] : this.parseTree(b.tasks);
    const n = this.count('SELECT COUNT(*) AS n FROM features WHERE project_id = ?', project.id);
    if (n >= this.limits.featuresPerProject) throw new HttpError(409, `Project ${project.slug} already has ${n} features (at most ${this.limits.featuresPerProject})`);
    const sbId = this.storyboardOf(project, b.storyboard);
    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      const next = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n, COALESCE(MAX(position), -1) + 1 AS p FROM features WHERE project_id = ?').get(project.id) as { n: number; p: number };
      const counter = this.db.prepare('SELECT next_number FROM feature_counters WHERE project_id = ?').get(project.id) as { next_number: number } | undefined;
      const number = Math.max(next.n, counter?.next_number ?? 1);
      this.db.prepare('INSERT INTO feature_counters (project_id, next_number) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET next_number = excluded.next_number').run(project.id, number + 1);
      this.db
        .prepare('INSERT INTO features (id, project_id, number, title, details, status, priority, position, storyboard_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, project.id, number, b.title, b.details ?? '', b.status ?? 'idea', b.priority ?? 'none', next.p, sbId, now, now);
      this.insertTree(id, project.id, tasks);
    })();
    const f = this.requireRow(project, id);
    this.changed(project, { id, key: `F-${f.number}`, kind: 'created' });
    return this.view(project, f);
  }

  update(project: Project, ref: string, body: unknown): FeatureView {
    const f = this.requireRow(project, ref);
    const b = parseBody(FeaturePatch, body, 'Feature');
    const sets: string[] = [];
    const args: (string | null)[] = [];
    const set = (col: string, v: string | null) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (b.title !== undefined) set('title', b.title);
    if (b.details !== undefined) set('details', b.details);
    if (b.status !== undefined) set('status', b.status);
    if (b.priority !== undefined) set('priority', b.priority);
    if (b.storyboard !== undefined) set('storyboard_id', this.storyboardOf(project, b.storyboard));
    if (sets.length) this.db.prepare(`UPDATE features SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowIso(), f.id);
    this.changed(project, { id: f.id, key: `F-${f.number}`, kind: 'updated' });
    return this.get(project, f.id);
  }

  delete(project: Project, ref: string): { deleted: string; key: string; tasks: number; images: number } {
    const f = this.requireRow(project, ref);
    const c = this.brief(project, f);
    this.db.prepare('DELETE FROM features WHERE id = ?').run(f.id); // tasks and images: ON DELETE CASCADE
    this.changed(project, { id: f.id, key: c.key, kind: 'deleted' });
    return { deleted: f.id, key: c.key, tasks: c.progress.total, images: c.imageCount };
  }

  /**
   * Put the given features in this order, in the slots they hold now (so a filtered or grouped list can be reordered
   * on its own; swapping two ids moves one up or down). Ids or keys.
   */
  reorder(project: Project, body: unknown): FeatureBrief[] {
    const b = parseBody(Reorder, body, 'Reorder');
    const rows = b.ids.map((ref) => this.requireRow(project, ref));
    if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new HttpError(400, 'Reorder: ids lists a feature twice');
    this.db.transaction(() => {
      // Renumber the whole board first (0..n-1) so the slots are distinct, then fill the slots in the given order.
      const all = this.db.prepare('SELECT id FROM features WHERE project_id = ? ORDER BY position, number').all(project.id) as { id: string }[];
      const pos = new Map(all.map((r, i) => [r.id, i]));
      const slots = rows.map((r) => pos.get(r.id)!).sort((x, y) => x - y);
      rows.forEach((r, i) => pos.set(r.id, slots[i]));
      const upd = this.db.prepare('UPDATE features SET position = ? WHERE id = ?');
      for (const [id, p] of pos) upd.run(p, id);
    })();
    this.changed(project, { kind: 'reordered' });
    return this.list(project) as FeatureBrief[];
  }

  // ------------------------------------------------------------------------------------------------ tasks

  private parseTree(items: unknown[], depth = 0): TaskInputTree[] {
    return items.map((raw, i) => {
      if (depth > 0 && raw && typeof raw === 'object' && 'subtasks' in raw) throw new HttpError(400, 'Subtasks cannot have subtasks (only task → subtask)');
      const t = parseBody(depth === 0 ? TaskIn : SubtaskIn, raw, depth === 0 ? `Task ${i + 1}` : `Subtask ${i + 1}`) as Omit<TaskInputTree, 'subtasks'> & { subtasks?: unknown[] };
      return { ...t, subtasks: t.subtasks ? this.parseTree(t.subtasks, depth + 1) : undefined };
    });
  }
  private insertTree(featureId: string, projectId: string, tasks: TaskInputTree[]): void {
    const total = tasks.reduce((n, t) => n + 1 + (t.subtasks?.length ?? 0), 0);
    if (!total) return;
    const have = this.count('SELECT COUNT(*) AS n FROM feature_tasks WHERE feature_id = ?', featureId);
    if (have + total > this.limits.tasksPerFeature) throw new HttpError(409, `A feature has at most ${this.limits.tasksPerFeature} tasks and subtasks (this one would have ${have + total})`);
    const ins = this.db.prepare(TASK_INSERT);
    const now = nowIso();
    let pos = this.count('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM feature_tasks WHERE feature_id = ? AND parent_task_id IS NULL', featureId);
    for (const t of tasks) {
      const id = newId();
      ins.run(id, featureId, projectId, null, t.title, t.done ? 1 : 0, t.note ?? '', t.assignee ?? '', pos++, t.done ? now : null, now, now);
      (t.subtasks ?? []).forEach((s, i) => ins.run(newId(), featureId, projectId, id, s.title, s.done ? 1 : 0, s.note ?? '', s.assignee ?? '', i, s.done ? now : null, now, now));
    }
  }
  private touch(featureId: string): void {
    this.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(nowIso(), featureId);
  }
  private checkParent(featureId: string, parentId: string | null | undefined, self?: string): string | null {
    if (!parentId) return null;
    const p = this.db.prepare('SELECT id, parent_task_id FROM feature_tasks WHERE feature_id = ? AND id = ?').get(featureId, parentId) as { id: string; parent_task_id: string | null } | undefined;
    if (!p) throw new HttpError(400, `Parent task "${parentId}" is not a task of this feature`);
    if (self && p.id === self) throw new HttpError(400, 'A task cannot be its own parent');
    if (p.parent_task_id) throw new HttpError(400, 'Subtasks cannot have subtasks (only task → subtask): pick a top-level task as the parent');
    return p.id;
  }
  private taskResult(project: Project, f: FeatureRow, taskId: string, kind: string): TaskResult {
    this.touch(f.id);
    const t = this.taskRow(f.id, taskId);
    const view: FeatureTask = this.taskView(t);
    if (!t.parent_task_id) view.subtasks = this.tasksOf(f.id).find((x) => x.id === t.id)?.subtasks ?? [];
    this.changed(project, { id: f.id, key: `F-${f.number}`, kind, taskId });
    return { task: view, feature: this.brief(project, this.requireRow(project, f.id)) };
  }
  private renumber(featureId: string, parent: string | null, order?: string[]): void {
    const ids = order ?? (this.db.prepare('SELECT id FROM feature_tasks WHERE feature_id = ? AND parent_task_id IS ? ORDER BY position, created_at, id').all(featureId, parent) as { id: string }[]).map((x) => x.id);
    const upd = this.db.prepare('UPDATE feature_tasks SET position = ? WHERE id = ?');
    ids.forEach((x, i) => upd.run(i, x));
  }

  addTask(project: Project, ref: string, body: unknown): TaskResult {
    const f = this.requireRow(project, ref);
    const b = parseBody(TaskCreate, body, 'Task');
    const parent = this.checkParent(f.id, b.parentTaskId);
    if (parent && b.subtasks?.length) throw new HttpError(400, 'Subtasks cannot have subtasks (only task → subtask)');
    const subs = b.subtasks ? this.parseTree(b.subtasks, 1) : [];
    const have = this.count('SELECT COUNT(*) AS n FROM feature_tasks WHERE feature_id = ?', f.id);
    if (have + 1 + subs.length > this.limits.tasksPerFeature) throw new HttpError(409, `A feature has at most ${this.limits.tasksPerFeature} tasks and subtasks`);
    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      const siblings = (this.db.prepare('SELECT id FROM feature_tasks WHERE feature_id = ? AND parent_task_id IS ? ORDER BY position, created_at, id').all(f.id, parent) as { id: string }[]).map((s) => s.id);
      const at = b.position === undefined ? siblings.length : Math.min(b.position, siblings.length);
      const ins = this.db.prepare(TASK_INSERT);
      ins.run(id, f.id, project.id, parent, b.title, b.done ? 1 : 0, b.note ?? '', b.assignee ?? '', at, b.done ? now : null, now, now);
      siblings.splice(at, 0, id);
      this.renumber(f.id, parent, siblings);
      subs.forEach((s, i) => ins.run(newId(), f.id, project.id, id, s.title, s.done ? 1 : 0, s.note ?? '', s.assignee ?? '', i, s.done ? now : null, now, now));
    })();
    return this.taskResult(project, f, id, 'task.created');
  }

  updateTask(project: Project, ref: string, taskId: string, body: unknown): TaskResult {
    const f = this.requireRow(project, ref);
    const t = this.taskRow(f.id, taskId);
    const b = parseBody(TaskPatch, body, 'Task');
    const now = nowIso();
    this.db.transaction(() => {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      const set = (col: string, v: string | number | null) => {
        sets.push(`${col} = ?`);
        args.push(v);
      };
      if (b.title !== undefined) set('title', b.title);
      if (b.note !== undefined) set('note', b.note);
      if (b.assignee !== undefined) set('assignee', b.assignee);
      if (b.done !== undefined && b.done !== !!t.done) {
        set('done', b.done ? 1 : 0);
        set('done_at', b.done ? now : null);
      }
      let moved = false;
      if (b.parentTaskId !== undefined && (b.parentTaskId || null) !== t.parent_task_id) {
        const parent = this.checkParent(f.id, b.parentTaskId, t.id);
        if (parent) {
          const kids = this.count('SELECT COUNT(*) AS n FROM feature_tasks WHERE parent_task_id = ?', t.id);
          if (kids) throw new HttpError(400, `This task has ${kids} subtask${kids === 1 ? '' : 's'}; it cannot become a subtask (only task → subtask)`);
        }
        set('parent_task_id', parent);
        set('position', this.count('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM feature_tasks WHERE feature_id = ? AND parent_task_id IS ?', f.id, parent));
        moved = true;
      }
      if (sets.length) this.db.prepare(`UPDATE feature_tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now, t.id);
      if (moved) this.renumber(f.id, t.parent_task_id);
    })();
    return this.taskResult(project, f, t.id, 'task.updated');
  }

  /** Flip done (or set it with {done}). */
  toggleTask(project: Project, ref: string, taskId: string, body: unknown): TaskResult {
    const f = this.requireRow(project, ref);
    const t = this.taskRow(f.id, taskId);
    const b = body && typeof body === 'object' && !Buffer.isBuffer(body) ? (body as { done?: unknown }) : {};
    if (b.done !== undefined && typeof b.done !== 'boolean') throw new HttpError(400, 'done must be true or false');
    return this.updateTask(project, f.id, t.id, { done: typeof b.done === 'boolean' ? b.done : !t.done });
  }

  deleteTask(project: Project, ref: string, taskId: string): { deleted: string; subtasks: number; feature: FeatureBrief } {
    const f = this.requireRow(project, ref);
    const t = this.taskRow(f.id, taskId);
    const kids = this.count('SELECT COUNT(*) AS n FROM feature_tasks WHERE parent_task_id = ?', t.id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM feature_tasks WHERE id = ?').run(t.id); // subtasks: ON DELETE CASCADE
      this.renumber(f.id, t.parent_task_id);
    })();
    this.touch(f.id);
    this.changed(project, { id: f.id, key: `F-${f.number}`, kind: 'task.deleted', taskId: t.id });
    return { deleted: t.id, subtasks: kids, feature: this.brief(project, this.requireRow(project, f.id)) };
  }

  /** Order the tasks of one level (top level, or the subtasks of parentTaskId): every sibling id, in the new order. */
  reorderTasks(project: Project, ref: string, body: unknown): FeatureView {
    const f = this.requireRow(project, ref);
    const b = parseBody(TaskReorder, body, 'Reorder');
    const parent = b.parentTaskId ? this.checkParent(f.id, b.parentTaskId) : null;
    const siblings = (this.db.prepare('SELECT id FROM feature_tasks WHERE feature_id = ? AND parent_task_id IS ?').all(f.id, parent) as { id: string }[]).map((x) => x.id);
    const given = new Set(b.ids);
    if (given.size !== b.ids.length) throw new HttpError(400, 'Reorder: ids lists a task twice');
    const stranger = b.ids.find((id) => !siblings.includes(id));
    if (stranger) throw new HttpError(400, `Reorder: task "${stranger}" is not ${parent ? 'a subtask of that task' : 'a top-level task of this feature'}`);
    if (given.size !== siblings.length) throw new HttpError(400, `Reorder: send every ${parent ? 'subtask of that task' : 'top-level task'} (${siblings.length}), got ${given.size}`);
    this.db.transaction(() => this.renumber(f.id, parent, b.ids))();
    this.touch(f.id);
    this.changed(project, { id: f.id, key: `F-${f.number}`, kind: 'task.reordered' });
    return this.get(project, f.id);
  }

  // ------------------------------------------------------------------------------------------------ images

  /** Bytes from a raw upload or a data URL; the type comes from the bytes (PNG, JPEG, WebP, GIF), never the name. */
  addImage(project: Project, ref: string, input: { data: Buffer; declaredType?: string | null; name?: string | null }): FeatureImage {
    const f = this.requireRow(project, ref);
    const { data } = input;
    if (!data.length) throw new HttpError(400, 'The image is empty');
    const L = this.limits;
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
    if (data.length > L.imageBytes) throw new HttpError(413, `The image is ${mb(data.length)}; at most ${mb(L.imageBytes)} each`);
    const info = imageSize(data);
    const mime = info ? FORMAT_MIME[info.format] : undefined;
    if (!info || !mime) throw new HttpError(415, 'Only PNG, JPEG, WebP or GIF images can be uploaded (this file is none of them)');
    const declared = (input.declaredType ?? '').split(';')[0].trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && (declared === 'image/jpg' ? 'image/jpeg' : declared) !== mime) {
      throw new HttpError(415, `The file is ${info.format === 'jpg' ? 'JPEG' : info.format.toUpperCase()} but was sent as ${declared}`);
    }
    const n = this.count('SELECT COUNT(*) AS n FROM feature_images WHERE feature_id = ?', f.id);
    if (n >= L.imagesPerFeature) throw new HttpError(409, `Feature F-${f.number} already has ${n} images (at most ${L.imagesPerFeature}); delete some first`);
    const total = this.count('SELECT COALESCE(SUM(bytes), 0) AS n FROM feature_images WHERE project_id = ?', project.id);
    if (total + data.length > L.projectImageBytes) throw new HttpError(413, `Feature images of this project would take ${mb(total + data.length)}; at most ${mb(L.projectImageBytes)}`);
    const name = cleanName(input.name) || `image-${n + 1}.${info.format}`;
    const id = newId();
    const pos = this.count('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM feature_images WHERE feature_id = ?', f.id);
    this.db
      .prepare('INSERT INTO feature_images (id, feature_id, project_id, name, mime, bytes, width, height, position, data, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, f.id, project.id, name, mime, data.length, info.width || null, info.height || null, pos, data, nowIso());
    this.touch(f.id);
    this.changed(project, { id: f.id, key: `F-${f.number}`, kind: 'image.added', imageId: id });
    return this.imageView(project, f, this.db.prepare(`SELECT ${IMAGE_COLS} FROM feature_images WHERE id = ?`).get(id) as ImageRow);
  }
  /** "data:image/png;base64,…" */
  addImageDataUrl(project: Project, ref: string, dataUrl: unknown, name?: unknown): FeatureImage {
    const m = typeof dataUrl === 'string' ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl) : null;
    if (!m) throw new HttpError(400, 'dataUrl must be "data:image/png;base64,…" (PNG, JPEG, WebP or GIF)');
    return this.addImage(project, ref, { data: Buffer.from(m[2], 'base64'), declaredType: m[1], name: typeof name === 'string' ? name : null });
  }
  listImages(project: Project, ref: string): FeatureImage[] {
    return this.imagesOf(project, this.requireRow(project, ref));
  }
  imageFile(project: Project, ref: string, imageId: string): { mime: string; name: string; data: Buffer } {
    const f = this.requireRow(project, ref);
    const i = this.db.prepare('SELECT mime, name, data FROM feature_images WHERE feature_id = ? AND id = ?').get(f.id, imageId) as { mime: string; name: string; data: Uint8Array } | undefined;
    if (!i) throw new HttpError(404, `Image "${imageId}" not found in feature F-${f.number}`);
    return { mime: i.mime, name: i.name, data: Buffer.from(i.data) };
  }
  deleteImage(project: Project, ref: string, imageId: string): { deleted: string } {
    const f = this.requireRow(project, ref);
    const r = this.db.prepare('DELETE FROM feature_images WHERE feature_id = ? AND id = ?').run(f.id, imageId);
    if (!r.changes) throw new HttpError(404, `Image "${imageId}" not found in feature F-${f.number}`);
    this.touch(f.id);
    this.changed(project, { id: f.id, key: `F-${f.number}`, kind: 'image.deleted', imageId });
    return { deleted: imageId };
  }

  // ------------------------------------------------------------------------------------------------ export / import

  exportRows(project: Project, opts: { images: boolean }): ExportedFeature[] {
    return (this.list(project) as FeatureBrief[]).map((b) => {
      const v = this.get(project, b.id);
      const out: ExportedFeature = {
        key: v.key,
        title: v.title,
        details: v.details,
        status: v.status,
        priority: v.priority,
        storyboard: v.storyboard?.slug ?? null,
        tasks: v.tasks.map((t) => ({ title: t.title, done: t.done, note: t.note, assignee: t.assignee, subtasks: (t.subtasks ?? []).map((s) => ({ title: s.title, done: s.done, note: s.note, assignee: s.assignee })) })),
      };
      if (opts.images) {
        out.images = (this.db.prepare('SELECT id, name, mime, data FROM feature_images WHERE feature_id = ? ORDER BY position, created_at, id').all(v.id) as { id: string; name: string; mime: string; data: Uint8Array }[]).map((i) => ({
          id: i.id,
          name: i.name,
          dataUrl: `data:${i.mime};base64,${Buffer.from(i.data).toString('base64')}`,
        }));
      } else if (v.images.length) {
        out.imagesLeftOut = v.images.length;
      }
      return out;
    });
  }

  /** Import one feature from an export row; image references in the details (image:<old id>) are moved to the new ids. */
  importRow(project: Project, row: ExportedFeature, warnings: string[]): void {
    let storyboard: string | null = null;
    if (row.storyboard) {
      if (this.storyboardRef(project, row.storyboard)) storyboard = row.storyboard;
      else warnings.push(`Feature "${row.title}": storyboard "${row.storyboard}" is not in the project; link dropped`);
    }
    const created = this.create(project, { title: row.title, details: row.details ?? '', status: row.status, priority: row.priority, storyboard, tasks: row.tasks ?? [] });
    let details = created.details;
    for (const img of row.images ?? []) {
      try {
        const v = this.addImageDataUrl(project, created.id, img.dataUrl, img.name);
        if (img.id) details = details.split(`image:${img.id}`).join(`image:${v.id}`);
      } catch (err) {
        warnings.push(`Feature "${row.title}": image "${img.name ?? '?'}" skipped: ${(err as Error).message}`);
      }
    }
    if (details !== created.details) this.db.prepare('UPDATE features SET details = ? WHERE id = ?').run(details, created.id);
  }
}

export interface ExportedFeature {
  /** Informational: keys are given again on import. */
  key?: string;
  title: string;
  details?: string;
  status?: FeatureStatus;
  priority?: FeaturePriority;
  /** Storyboard slug. */
  storyboard?: string | null;
  tasks?: { title: string; done?: boolean; note?: string; assignee?: string; subtasks?: { title: string; done?: boolean; note?: string; assignee?: string }[] }[];
  images?: { id?: string; name?: string; dataUrl: string }[];
  /** Export with ?images=0: how many images were left out. */
  imagesLeftOut?: number;
}

/** A file name without folders or control characters, at most 120 characters. */
function cleanName(name: string | null | undefined): string {
  return (name ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/[\x00-\x1f\x7f"<>]/g, '')
    .trim()
    .slice(0, 120);
}
