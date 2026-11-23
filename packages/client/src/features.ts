/**
 * The project features board (browser-safe, fetch only): features → tasks → subtasks, markdown details, images.
 *
 *   import { listFeatures, createFeature, addTask, toggleTask } from '@stubyard/client/features';
 *   const t = { project: 'hyper' };
 *   const f = await createFeature(t, { title: 'Sign-up with Google', tasks: [{ title: 'Backend', subtasks: [{ title: 'Token exchange' }] }] });
 *   const { task } = await addTask(t, f.key, { title: 'Docs' });
 *   await toggleTask(t, f.key, task.id);
 */
import { hubJson, projectPath, query, seg, type HubTarget } from './http.js';

export type FeatureStatus = 'idea' | 'planned' | 'in_progress' | 'done';
export type FeaturePriority = 'none' | 'low' | 'medium' | 'high';

export interface FeatureTask {
  id: string;
  /** null for a task; the parent task's id for a subtask (two levels only). */
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
  /** Hub path of the image bytes. */
  url: string;
  /** Markdown for the details text: ![name](image:<id>). */
  markdown: string;
  createdAt: string;
}
export interface FeatureBrief {
  id: string;
  /** "F-3": stable per project, never reused. */
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
export interface Feature extends FeatureBrief {
  details: string;
  tasks: FeatureTask[];
  images: FeatureImage[];
}
export interface TaskInput {
  title: string;
  done?: boolean;
  note?: string;
  assignee?: string;
  subtasks?: Omit<TaskInput, 'subtasks'>[];
}
export interface FeatureInput {
  title: string;
  details?: string;
  status?: FeatureStatus;
  priority?: FeaturePriority;
  /** Storyboard slug or id; "" or null unlinks. */
  storyboard?: string | null;
  tasks?: TaskInput[];
}
export type FeaturePatch = Partial<Omit<FeatureInput, 'tasks'>>;
export interface TaskResult {
  task: FeatureTask;
  feature: FeatureBrief;
}

const base = (t: HubTarget, suffix = '') => projectPath(t, `/features${suffix}`);
const one = (t: HubTarget, ref: string, suffix = '') => base(t, `/${seg(ref)}${suffix}`);

/** Features in board order with counts per status. `full` adds details, tasks and images to every row. */
export function listFeatures(t: HubTarget, o: { status?: FeatureStatus | FeatureStatus[]; q?: string; full?: boolean } = {}): Promise<{ features: FeatureBrief[] | Feature[]; counts: Record<FeatureStatus | 'all', number> }> {
  return hubJson(t, 'GET', base(t, query({ status: o.status, q: o.q, full: o.full })));
}
/** By key ("F-3") or id. */
export function getFeature(t: HubTarget, ref: string): Promise<Feature> {
  return hubJson(t, 'GET', one(t, ref));
}
export function createFeature(t: HubTarget, input: FeatureInput): Promise<Feature> {
  return hubJson(t, 'POST', base(t), input);
}
export function updateFeature(t: HubTarget, ref: string, patch: FeaturePatch): Promise<Feature> {
  return hubJson(t, 'PATCH', one(t, ref), patch);
}
/** Deletes the feature with its tasks and images. */
export function deleteFeature(t: HubTarget, ref: string): Promise<{ deleted: string; key: string; tasks: number; images: number }> {
  return hubJson(t, 'DELETE', one(t, ref));
}
/** Put these features in this order, in the slots they hold now (others stay where they are). */
export async function reorderFeatures(t: HubTarget, refs: string[]): Promise<FeatureBrief[]> {
  return (await hubJson<{ features: FeatureBrief[] }>(t, 'POST', base(t, '/reorder'), { ids: refs })).features;
}

/** A task, or a subtask with `parentTaskId` (a top-level task). `position` is the 0-based place among its siblings. */
export function addTask(t: HubTarget, ref: string, input: TaskInput & { parentTaskId?: string | null; position?: number }): Promise<TaskResult> {
  return hubJson(t, 'POST', one(t, ref, '/tasks'), input);
}
/** Edit or move (parentTaskId: a top-level task, or null for the top level). */
export function updateTask(t: HubTarget, ref: string, taskId: string, patch: Partial<Omit<TaskInput, 'subtasks'>> & { parentTaskId?: string | null }): Promise<TaskResult> {
  return hubJson(t, 'PATCH', one(t, ref, `/tasks/${seg(taskId)}`), patch);
}
/** Flip done, or set it. */
export function toggleTask(t: HubTarget, ref: string, taskId: string, done?: boolean): Promise<TaskResult> {
  return hubJson(t, 'POST', one(t, ref, `/tasks/${seg(taskId)}/toggle`), done === undefined ? {} : { done });
}
export function deleteTask(t: HubTarget, ref: string, taskId: string): Promise<{ deleted: string; subtasks: number; feature: FeatureBrief }> {
  return hubJson(t, 'DELETE', one(t, ref, `/tasks/${seg(taskId)}`));
}
/** Every task of one level (top level, or the subtasks of `parentTaskId`) in the new order. */
export function reorderTasks(t: HubTarget, ref: string, ids: string[], parentTaskId: string | null = null): Promise<Feature> {
  return hubJson(t, 'POST', one(t, ref, '/tasks/reorder'), { ids, parentTaskId });
}

/** Attach an image given as a data URL ("data:image/png;base64,…"; PNG, JPEG, WebP or GIF, at most 5 MB). */
export function addFeatureImage(t: HubTarget, ref: string, dataUrl: string, name?: string): Promise<FeatureImage> {
  return hubJson(t, 'POST', one(t, ref, '/images'), { dataUrl, name });
}
export function listFeatureImages(t: HubTarget, ref: string): Promise<FeatureImage[]> {
  return hubJson(t, 'GET', one(t, ref, '/images'));
}
export function deleteFeatureImage(t: HubTarget, ref: string, imageId: string): Promise<{ deleted: string }> {
  return hubJson(t, 'DELETE', one(t, ref, `/images/${seg(imageId)}`));
}
