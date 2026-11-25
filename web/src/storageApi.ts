import type { Snippet } from './api';

/** Types of the file storage control API (/api/projects/:slug/storage/…). */

export interface StorageCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StoragePresetInfo {
  id: string;
  name: string;
  protocol: string;
  description: string;
  region: string;
  credentials: StorageCredential[];
  notes?: string[];
  available: boolean;
}

export interface StorageRulePreset {
  id: string;
  label: string;
  rule: Record<string, unknown>;
  note?: string;
}

/** Global caps from the environment (0 = no limit). */
export interface StorageCaps {
  storageMaxMb: number;
  storageProjectMb: number;
  storageMaxObjectMb: number;
  storageRetentionDays: number;
}

export interface StoragePresets {
  presets: StoragePresetInfo[];
  actions: string[];
  ops: string[];
  rulePresets: StorageRulePreset[];
  caps?: StorageCaps;
}

/** One "Simulate errors" row and the native error it produces on this provider (null: not an error response). */
export interface SimulateRow {
  id: string;
  label: string;
  action: string;
  op: string;
  params?: Record<string, number>;
  sizes?: boolean;
  error: { status: number; code: string | null; message: string | null } | null;
}

export interface StorageInstance {
  id: string;
  slug: string;
  name: string;
  preset: string;
  presetName: string;
  protocol: string;
  enabled: boolean;
  config: { strict?: boolean; verifySignatures?: boolean; autoCreateBuckets?: boolean; quotaBytes?: number | null; maxObjectBytes?: number | null; maxObjects?: number | null; allowActiveContent?: boolean; [k: string]: unknown };
  urls: { backend: string; docker: string; browser: string };
  credentials: StorageCredential[];
  credentialLabels?: string[];
  region: string;
  snippets: Snippet[];
  /** maxObjectBytes is the effective per-file limit (the instance's, capped by STUBYARD_STORAGE_MAX_OBJECT_MB). */
  usage: { objects: number; bytes: number; quotaBytes: number; maxObjectBytes: number; maxObjects: number };
  buckets: number;
  simulate?: SimulateRow[];
}

export interface StorageBucket {
  id: string;
  name: string;
  region: string | null;
  public: boolean;
  cors: { mode: 'permissive' | 'rules' | 'none'; rules?: unknown[] };
  objects: number;
  bytes: number;
  uploads: number;
  createdAt: string;
}

export interface StorageObject {
  id: string;
  key: string;
  size: number;
  etag: string;
  contentType: string | null;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  checksums: Record<string, string>;
  parts: number | null;
  acl: string | null;
  source: string;
  runId: string | null;
  logId: string | null;
  createdAt: string;
  updatedAt: string;
  bucket: string;
  urls: { backend: string; browser: string; content: string };
  public: boolean;
}

export interface ObjectPage {
  objects: StorageObject[];
  prefixes: string[];
  truncated: boolean;
  cursor: string | null;
}

export interface StorageRule {
  id: string;
  bucketId: string | null;
  runId: string | null;
  op: string;
  keyPrefix: string | null;
  action: string;
  params: Record<string, unknown>;
  remainingCount: number | null;
  skipCount: number;
  failRate: number | null;
  expiresAt: string | null;
  label: string | null;
  hits: number;
  enabled: boolean;
  active: boolean;
}

export interface StorageUploadInfo {
  id: string;
  key: string;
  bucket: string;
  kind: string;
  parts: number;
  bytes: number;
  createdAt: string;
  expiresAt: string;
}

/** GET /api/projects/:slug/storage-summary: project-wide totals and the latest files (Overview "Files" card). */
export interface StorageSummary {
  objects: number;
  bytes: number;
  instances: { slug: string; name: string; preset: string; enabled: boolean; objects: number; bytes: number; maxObjects: number; quotaBytes: number; buckets: string[] }[];
  recent: (StorageObject & { instance: string; instanceName: string })[];
  caps: StorageCaps;
}

export const storageSummaryPath = (slug: string, limit = 5) => `/api/projects/${encodeURIComponent(slug)}/storage-summary?limit=${limit}`;

/** Storage page link that opens the file browser on an instance / bucket / file. */
export const storageLink = (slug: string, o: { instance?: string; bucket?: string; key?: string } = {}) => {
  const p = new URLSearchParams();
  if (o.instance) p.set('instance', o.instance);
  if (o.bucket) p.set('bucket', o.bucket);
  if (o.key) p.set('key', o.key);
  const q = p.toString();
  return `/p/${encodeURIComponent(slug)}/storage${q ? `?${q}` : ''}`;
};

/** The default bucket for dashboard uploads when an instance has none yet (created on the first upload). */
export const DEFAULT_UPLOAD_BUCKET = 'uploads';

export const storageBase = (slug: string, instance?: string) => `/api/projects/${encodeURIComponent(slug)}/storage${instance ? `/${encodeURIComponent(instance)}` : ''}`;

/** Streamed upload through the data plane (the JSON-only /api cannot take files). */
export async function uploadFile(slug: string, instance: string, bucket: string, key: string, file: File): Promise<StorageObject> {
  const path = `/storage/${encodeURIComponent(slug)}/${encodeURIComponent(instance)}/__hub/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(path, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
  const text = await res.text();
  let data: { error?: string; reason?: string | null } | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON (proxy error page) */
  }
  if (!res.ok) {
    // The real reason, e.g. "Limit reached: 10 files (instance maxObjects=10)".
    const msg = data?.error ?? (res.status === 413 ? 'File too large' : `Upload failed (HTTP ${res.status})`);
    throw new Error(data?.reason ? `${msg} (${data.reason})` : msg);
  }
  return data as unknown as StorageObject;
}
