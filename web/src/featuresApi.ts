/** Typed client for the features board (/api/projects/:slug/features; server: features/service.ts). */
import { api } from './api';

export type FeatureStatus = 'idea' | 'planned' | 'in_progress' | 'done';
export type FeaturePriority = 'none' | 'low' | 'medium' | 'high';

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
  subtasks?: FeatureTask[];
}
export interface FeatureImage {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  url: string;
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
export interface FeatureList {
  features: FeatureBrief[];
  counts: Record<FeatureStatus | 'all', number>;
}

export const STATUSES: FeatureStatus[] = ['idea', 'planned', 'in_progress', 'done'];
export const STATUS_LABEL: Record<FeatureStatus, string> = { idea: 'Idea', planned: 'Planned', in_progress: 'In progress', done: 'Done' };
/** .badge kinds: every status has text, the colour only helps. */
export const STATUS_KIND: Record<FeatureStatus, string> = { idea: '', planned: 'info', in_progress: 'warn', done: 'ok' };
export const PRIORITIES: FeaturePriority[] = ['none', 'low', 'medium', 'high'];
export const PRIORITY_LABEL: Record<FeaturePriority, string> = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High' };
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 20;

export const featuresBase = (slug: string) => `/api/projects/${encodeURIComponent(slug)}/features`;
const one = (slug: string, ref: string) => `${featuresBase(slug)}/${encodeURIComponent(ref)}`;

export const featuresApi = {
  create: (slug: string, body: { title: string; status?: FeatureStatus; details?: string }) => api.post<Feature>(featuresBase(slug), body),
  update: (slug: string, ref: string, body: Partial<{ title: string; details: string; status: FeatureStatus; priority: FeaturePriority; storyboard: string | null }>) => api.patch<Feature>(one(slug, ref), body),
  remove: (slug: string, ref: string) => api.del<{ deleted: string }>(one(slug, ref)),
  reorder: (slug: string, ids: string[]) => api.post<{ features: FeatureBrief[] }>(`${featuresBase(slug)}/reorder`, { ids }),
  addTask: (slug: string, ref: string, body: { title: string; parentTaskId?: string | null; position?: number }) => api.post<{ task: FeatureTask }>(`${one(slug, ref)}/tasks`, body),
  updateTask: (slug: string, ref: string, taskId: string, body: Partial<{ title: string; done: boolean; note: string; assignee: string; parentTaskId: string | null }>) =>
    api.patch<{ task: FeatureTask }>(`${one(slug, ref)}/tasks/${taskId}`, body),
  toggleTask: (slug: string, ref: string, taskId: string, done: boolean) => api.post<{ task: FeatureTask }>(`${one(slug, ref)}/tasks/${taskId}/toggle`, { done }),
  deleteTask: (slug: string, ref: string, taskId: string) => api.del<{ deleted: string; subtasks: number }>(`${one(slug, ref)}/tasks/${taskId}`),
  reorderTasks: (slug: string, ref: string, ids: string[], parentTaskId: string | null) => api.post<Feature>(`${one(slug, ref)}/tasks/reorder`, { ids, parentTaskId }),
  deleteImage: (slug: string, ref: string, imageId: string) => api.del<{ deleted: string }>(`${one(slug, ref)}/images/${imageId}`),
  /** Raw upload (the type is checked from the bytes on the hub). */
  async uploadImage(slug: string, ref: string, file: Blob, name: string): Promise<FeatureImage> {
    const type = IMAGE_TYPES.includes(file.type) ? file.type : 'image/png';
    const r = await fetch(`${one(slug, ref)}/images?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': type }, body: file });
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* text */
    }
    if (!r.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${r.status}`);
    return body as FeatureImage;
  },
};

/** Client-side checks before an upload, with the hub's wording. */
export function imageProblem(file: File): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name || 'This file'}: only PNG, JPEG, WebP or GIF images`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name || 'This image'} is ${(file.size / 1024 / 1024).toFixed(1)} MB; at most 5 MB each`;
  return null;
}
