import { registerExportSection } from '../maintenance/export.js';
import type { ApnsConfig, FcmConfig } from './types.js';

/**
 * Export / import of push instances (private keys are never exported: new keys are generated on import), devices that
 * belong to a test user, and project-level fault rules. Notifications are test data.
 */
let registered = false;

export function registerPushExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'pushInstances',
    table: 'push_instances',
    export: ({ hub, project }) =>
      hub.push.repo.listInstances(project.id).map((i) => {
        const { privateKeyPem: _k, publicKeyPem: _p, privateKeyId: _id, clientId: _c, ...config } = i.config as FcmConfig & ApnsConfig;
        return { id: i.id, slug: i.slug, name: i.name, preset: i.preset, strict: i.strict, enabled: i.enabled, config };
      }),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        try {
          const i = ctx.hub.push.createInstance(ctx.project, { preset: r.preset, slug: r.slug, name: r.name, strict: r.strict === true, enabled: r.enabled !== false, config: r.config });
          if (r.id) ctx.ids.set('pushInstances', String(r.id), i.id);
          ctx.warnings.push(`Push instance "${i.slug}": new ${i.preset === 'fcm' ? 'service-account key generated, download the service-account JSON' : 'APNs key generated, download the .p8'} again (private keys are not exported).`);
          n++;
        } catch (e) {
          ctx.warnings.push(`Push instance "${String(r.slug)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'pushDevices',
    table: 'push_devices',
    export: ({ hub, project }) =>
      hub.push.repo
        .listDevices(project.id)
        .filter((d) => d.testUserId && !d.runId)
        .map((d) => ({ testUserId: d.testUserId, instanceId: d.instanceId, platform: d.platform, token: d.token, appId: d.appId, name: d.name, state: d.state, topics: d.topics })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const user = ctx.ids.get('users', r.testUserId ? String(r.testUserId) : null);
        const inst = ctx.ids.get('pushInstances', r.instanceId ? String(r.instanceId) : null);
        if (!user) {
          ctx.warnings.push(`Push device "${String(r.name)}" skipped: its test user is not in the file`);
          continue;
        }
        try {
          const d = ctx.hub.push.registerDevice(ctx.project, { user, platform: r.platform, instance: inst ?? undefined, token: r.token, appId: r.appId, name: r.name, topics: r.topics }, null);
          if (r.state === 'unregistered') ctx.hub.push.setRegistered(ctx.project, d.id, false);
          n++;
        } catch (e) {
          ctx.warnings.push(`Push device "${String(r.name)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'pushRules',
    table: 'push_rules',
    export: ({ hub, project }) =>
      hub.push.repo
        .listRules(project.id)
        .filter((r) => !r.runId)
        .map((r) => ({ instanceId: r.instanceId, match: r.match, fault: r.fault, times: r.remaining })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const m = (r.match ?? {}) as { token?: string; user?: string; topic?: string };
        try {
          ctx.hub.push.addFault(
            ctx.project,
            { fault: r.fault, instance: ctx.ids.get('pushInstances', r.instanceId ? String(r.instanceId) : null) ?? undefined, token: m.token, user: m.user ? (ctx.ids.get('users', m.user) ?? undefined) : undefined, topic: m.topic, times: r.times ?? undefined },
            null,
          );
          n++;
        } catch (e) {
          ctx.warnings.push(`Push fault "${String(r.fault)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });
}
