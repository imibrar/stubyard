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

export interface StoragePresets {
  presets: StoragePresetInfo[];
  actions: string[];
  ops: string[];
  rulePresets: StorageRulePreset[];
}

export interface StorageInstance {
  id: string;
  slug: string;
  name: string;
  preset: string;
  presetName: string;
  protocol: string;
  enabled: boolean;
  config: { strict?: boolean; verifySignatures?: boolean; autoCreateBuckets?: boolean; quotaBytes?: number | null; maxObjectBytes?: number | null; allowActiveContent?: boolean; [k: string]: unknown };
  urls: { backend: string; docker: string; browser: string };
  credentials: StorageCredential[];
  credentialLabels?: string[];
  region: string;
  snippets: Snippet[];
  usage: { objects: number; bytes: number; quotaBytes: number; maxObjectBytes: number };
  buckets: number;
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

export const storageBase = (slug: string, instance?: string) => `/api/projects/${encodeURIComponent(slug)}/storage${instance ? `/${encodeURIComponent(instance)}` : ''}`;

/** Streamed upload through the data plane (the JSON-only /api cannot take files). */
export async function uploadFile(slug: string, instance: string, bucket: string, key: string, file: File): Promise<StorageObject> {
  const path = `/storage/${encodeURIComponent(slug)}/${encodeURIComponent(instance)}/__hub/objects/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(path, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as StorageObject;
}
