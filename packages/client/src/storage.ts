/**
 * stubyard file-storage helpers for tests (anything with a fetch).
 *
 *   import { S3Client } from '@aws-sdk/client-s3';
 *   import { s3Config, waitForUpload, getFile } from '@stubyard/client/storage';
 *   const s3 = new S3Client(s3Config({ project: 'hyper', instance: 's3' }));
 *   // … the app uploads an avatar …
 *   const [obj] = await waitForUpload({ project: 'hyper', instance: 's3', bucket: 'uploads', prefix: 'avatars/' });
 *   const bytes = await getFile({ project: 'hyper', instance: 's3', bucket: 'uploads', key: obj.key });
 */

import { hubFetchFn, trimSlashes } from './http.js';

export interface StorageTarget {
  /** stubyard API base (dashboard / control API and data plane), default http://localhost:4000. */
  apiUrl?: string;
  /** API token for a hub with sign-in on; default the STUBYARD_TOKEN environment variable. */
  apiToken?: string;
  project: string;
  /** Storage instance slug, e.g. "s3". */
  instance: string;
}

export interface StoredObject {
  key: string;
  size: number;
  etag: string;
  contentType: string | null;
  metadata: Record<string, string>;
  checksums: Record<string, string>;
  source: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  bucket: string;
  urls: { backend: string; browser: string; content: string };
  public: boolean;
}

const api = (o: { apiUrl?: string }) => trimSlashes(o.apiUrl ?? 'http://localhost:4000');
const inst = (o: StorageTarget) => `${api(o)}/api/projects/${encodeURIComponent(o.project)}/storage/${encodeURIComponent(o.instance)}`;
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`stubyard answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Options for `new S3Client(...)` pointing at a stubyard instance (path-style, region and default credentials of the
 * preset). Pass `baseUrl` for the browser-facing host when presigning for a browser.
 */
export function s3Config(o: { baseUrl?: string; project: string; instance: string; region?: string; accessKeyId?: string; secretAccessKey?: string }) {
  const base = trimSlashes(o.baseUrl ?? 'http://localhost:4000');
  return {
    endpoint: `${base}/storage/${encodeURIComponent(o.project)}/${encodeURIComponent(o.instance)}`,
    forcePathStyle: true,
    region: o.region ?? 'us-east-1',
    credentials: { accessKeyId: o.accessKeyId ?? 'stubyard', secretAccessKey: o.secretAccessKey ?? 'stubyard-secret' },
  };
}

export async function listFiles(o: StorageTarget & { bucket: string; prefix?: string; delimiter?: string; search?: string; run?: string; limit?: number; cursor?: string }): Promise<{ objects: StoredObject[]; prefixes: string[]; truncated: boolean; cursor: string | null }> {
  return json(await hubFetchFn(o)(`${inst(o)}/buckets/${encodeURIComponent(o.bucket)}/objects${qs({ prefix: o.prefix, delimiter: o.delimiter, search: o.search, run: o.run, limit: o.limit, cursor: o.cursor })}`));
}

/** Wait until `count` objects (default 1) were written under `prefix` after the call (or after `after`). */
export async function waitForUpload(o: StorageTarget & { bucket: string; prefix?: string; count?: number; timeoutMs?: number; after?: string }): Promise<StoredObject[]> {
  const r = await json<{ objects: StoredObject[]; timedOut: boolean }>(
    await hubFetchFn(o)(`${inst(o)}/buckets/${encodeURIComponent(o.bucket)}/objects/wait${qs({ prefix: o.prefix, count: o.count, timeoutMs: o.timeoutMs ?? 10_000, after: o.after })}`),
  );
  if (r.timedOut) throw new Error(`No upload to ${o.bucket}/${o.prefix ?? ''} within ${o.timeoutMs ?? 10_000} ms (got ${r.objects.length} of ${o.count ?? 1})`);
  return r.objects;
}

/** Bytes of a stored object. */
export async function getFile(o: StorageTarget & { bucket: string; key: string }): Promise<Uint8Array> {
  const res = await hubFetchFn(o)(`${inst(o)}/buckets/${encodeURIComponent(o.bucket)}/object/content${qs({ key: o.key })}`);
  if (!res.ok) throw new Error(`stubyard answered ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Presigned URL (SigV4 for S3 presets) for the backend and the browser. */
export async function presign(o: StorageTarget & { bucket: string; key: string; method?: 'GET' | 'PUT' | 'HEAD' | 'DELETE'; expiresIn?: number; contentType?: string; scenario?: string }): Promise<{ backend: string; browser: string; expiresAt: string; headers: Record<string, string> }> {
  return json(await hubFetchFn(o)(`${inst(o)}/presign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bucket: o.bucket, key: o.key, method: o.method, expiresIn: o.expiresIn, contentType: o.contentType, scenario: o.scenario }) }));
}

/**
 * Add a scenario rule, e.g. { action: "slow_down", op: "put", count: 3 } or { action: "access_denied", run: "w3" }.
 * Returns the rule (delete it with resetStorageScenarios).
 */
export async function setStorageScenario(o: StorageTarget & { action: string; op?: string; bucket?: string; keyPrefix?: string; count?: number; after?: number; minutes?: number; failRate?: number; delayMs?: number; bytesPerSec?: number; afterBytes?: number; maxBytes?: number; label?: string; run?: string }): Promise<{ id: string }> {
  const { apiUrl: _a, apiToken: _t, project: _p, instance: _i, run, ...rule } = o;
  return json(await hubFetchFn(o)(`${inst(o)}/rules${qs({ run })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rule) }));
}

export async function resetStorageScenarios(o: StorageTarget & { run?: string }): Promise<{ deleted: number }> {
  return json(await hubFetchFn(o)(`${inst(o)}/rules${qs({ run: o.run })}`, { method: 'DELETE' }));
}

export async function emptyBucket(o: StorageTarget & { bucket: string }): Promise<{ deleted: number }> {
  return json(await hubFetchFn(o)(`${inst(o)}/buckets/${encodeURIComponent(o.bucket)}/empty`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
}
