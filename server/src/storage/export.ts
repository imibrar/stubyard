import { registerExportSection } from '../maintenance/export.js';
import type { BucketCors, StorageInstanceConfig } from '../repos/storage.js';

/** Config keys that hold secrets: exported only with ?secrets=1. */
const SECRET_KEYS = ['credentials', 'accountKey', 'apiSecret', 'serviceKey', 'jwtSecret', 'serviceAccount', 'anonKey'];

/**
 * Export / import of storage configuration: instances, buckets and project-level rules. Objects, uploads and
 * run-scoped rules are never exported (files are app state).
 */
let registered = false;

export function registerStorageExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'storageInstances',
    table: 'storage_instances',
    export: ({ hub, project, includeSecrets }) =>
      hub.storage.repo.listInstances(project.id).map((i) => ({
        id: i.id,
        slug: i.slug,
        name: i.name,
        preset: i.preset,
        enabled: i.enabled,
        config: includeSecrets ? i.config : Object.fromEntries(Object.entries(i.config).filter(([k]) => !SECRET_KEYS.includes(k))),
      })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        if (ctx.hub.storage.repo.getInstance(ctx.project.id, String(r.slug ?? ''))) {
          ctx.warnings.push(`Storage instance "${r.slug}" exists already; skipped`);
          continue;
        }
        const i = ctx.hub.storage.repo.createInstance(ctx.project.id, {
          preset: String(r.preset ?? 's3'),
          slug: r.slug ? String(r.slug) : undefined,
          name: String(r.name ?? r.preset ?? 'Storage'),
          config: (r.config as StorageInstanceConfig) ?? {},
          enabled: r.enabled !== false,
        });
        if (r.id) ctx.ids.set('storageInstances', String(r.id), i.id);
        n++;
      }
      return n;
    },
  });

  registerExportSection({
    key: 'storageBuckets',
    clear: () => undefined, // cascades from storage_instances
    export: ({ hub, project }) =>
      hub.storage.repo.listInstances(project.id).flatMap((i) =>
        hub.storage.repo.listBuckets(i.id).map((b) => ({ id: b.id, instance: i.slug, instanceId: i.id, name: b.name, region: b.region, public: b.public, cors: b.cors, config: b.config })),
      ),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const instId = ctx.ids.get('storageInstances', r.instanceId as string);
        const inst = instId ? ctx.hub.storage.repo.getInstance(ctx.project.id, instId) : ctx.hub.storage.repo.getInstance(ctx.project.id, String(r.instance ?? ''));
        if (!inst) {
          ctx.warnings.push(`Bucket "${r.name}" skipped: its storage instance is missing`);
          continue;
        }
        if (ctx.hub.storage.repo.getBucket(inst.id, String(r.name))) continue;
        const b = ctx.hub.storage.repo.createBucket(inst, { name: String(r.name), region: r.region ? String(r.region) : null, public: r.public === true, cors: (r.cors as BucketCors) ?? undefined, config: (r.config as Record<string, unknown>) ?? {} });
        if (r.id) ctx.ids.set('storageBuckets', String(r.id), b.id);
        n++;
      }
      return n;
    },
  });

  registerExportSection({
    key: 'storageRules',
    clear: () => undefined,
    export: ({ hub, project }) =>
      hub.storage.repo.listInstances(project.id).flatMap((i) =>
        hub.storage.repo.listRules(i.id, { runId: null }).map((r) => ({
          instance: i.slug,
          instanceId: i.id,
          bucketId: r.bucketId,
          op: r.op,
          keyPrefix: r.keyPrefix,
          action: r.action,
          params: r.params,
          count: r.remainingCount,
          after: r.skipCount || undefined,
          failRate: r.failRate,
          until: r.expiresAt,
          label: r.label,
          enabled: r.enabled,
        })),
      ),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const instId = ctx.ids.get('storageInstances', r.instanceId as string);
        const inst = instId ? ctx.hub.storage.repo.getInstance(ctx.project.id, instId) : ctx.hub.storage.repo.getInstance(ctx.project.id, String(r.instance ?? ''));
        if (!inst) {
          ctx.warnings.push(`Storage rule "${r.action}" skipped: its instance is missing`);
          continue;
        }
        if (r.count === 0) continue;
        if (r.until && String(r.until) <= new Date().toISOString()) continue;
        const bucketId = r.bucketId ? ctx.ids.get('storageBuckets', r.bucketId as string) : null;
        const bucket = bucketId ? ctx.hub.storage.repo.bucketById(bucketId) : null;
        ctx.hub.storage.addRule(
          ctx.project,
          inst,
          {
            action: String(r.action),
            op: r.op ? String(r.op) : undefined,
            bucket: bucket?.name ?? null,
            keyPrefix: r.keyPrefix ? String(r.keyPrefix) : null,
            params: (r.params as Record<string, unknown>) ?? {},
            count: r.count === null || r.count === undefined ? null : Number(r.count),
            after: r.after ? Number(r.after) : null,
            failRate: r.failRate === null || r.failRate === undefined ? null : Number(r.failRate),
            until: r.until ? String(r.until) : null,
            label: r.label ? String(r.label) : null,
            enabled: r.enabled !== false,
          },
          null,
        );
        n++;
      }
      return n;
    },
  });
}
