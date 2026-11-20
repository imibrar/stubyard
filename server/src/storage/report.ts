import type { Hub } from '../hub.js';

export interface StorageRunReport {
  uploads: number;
  bytes: number;
  downloads: number;
  deletes: number;
  items: { op: string; bucket: string | null; key: string | null; size: number | null; contentType: string | null; status: number | null; logId: string }[];
  rules: { id: string; instance: string; action: string; op: string; hits: number; label: string | null }[];
}

// Object operations of every storage preset (S3, Azure Blob, GCS, Cloudinary, Supabase).
const UPLOADS = new Set([
  'PutObject', 'PostObject', 'CompleteMultipartUpload', 'CopyObject', 'HubUpload',
  'PutBlob', 'PutBlockList', 'CopyBlob', // Azure
  'InsertObject', // GCS
  'Upload', // Cloudinary
  'UploadObject', 'UpdateObject', 'UploadToSignedUrl', 'MoveObject', // Supabase
]);
const DOWNLOADS = new Set(['GetObject', 'GetBlob', 'GetObjectMedia', 'Deliver', 'GetSignedObject', 'GetPublicObject', 'GetAuthenticatedObject']);
const DELETES = new Set(['DeleteObject', 'DeleteObjects', 'DeleteBlob', 'Destroy', 'DeleteResources']);

/** Storage section of a run report, built from the run's traffic rows (so it survives object deletion). */
export function storageRunReport(hub: Hub, runId: string): StorageRunReport | null {
  const rows = hub.db
    .prepare(`SELECT id, res_status, resolved FROM traffic_logs WHERE run_id = ? AND json_extract(resolved, '$.kind') = 'storage' ORDER BY id`)
    .all(runId) as { id: string; res_status: number | null; resolved: string }[];
  const rules = (hub.db.prepare('SELECT r.id, i.slug, r.action, r.op, r.hits, r.label FROM storage_rules r JOIN storage_instances i ON i.id = r.instance_id WHERE r.run_id = ?').all(runId) as { id: string; slug: string; action: string; op: string; hits: number; label: string | null }[]).map((r) => ({ id: r.id, instance: r.slug, action: r.action, op: r.op, hits: r.hits, label: r.label }));
  if (!rows.length && !rules.length) return null;
  const out: StorageRunReport = { uploads: 0, bytes: 0, downloads: 0, deletes: 0, items: [], rules };
  for (const r of rows) {
    const res = JSON.parse(r.resolved || '{}') as Record<string, unknown>;
    const op = String(res.op ?? '');
    const ok = (r.res_status ?? 0) < 300;
    if (UPLOADS.has(op) && ok) {
      out.uploads++;
      out.bytes += Number(res.size ?? 0);
    }
    if (DOWNLOADS.has(op) && ok) out.downloads++;
    if (DELETES.has(op) && ok) out.deletes++;
    if (out.items.length < 200 && (UPLOADS.has(op) || DOWNLOADS.has(op) || DELETES.has(op))) {
      out.items.push({ op, bucket: (res.bucket as string) ?? null, key: (res.key as string) ?? null, size: res.size === undefined ? null : Number(res.size), contentType: (res.contentType as string) ?? null, status: r.res_status, logId: r.id });
    }
  }
  return out;
}
