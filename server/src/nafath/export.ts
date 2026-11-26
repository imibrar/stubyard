import { registerExportSection } from '../maintenance/export.js';
import type { NafathKey, NafathRule } from './types.js';

/**
 * Export / import of Nafath instances and project-level fault rules. APP-KEY and the signing keys only travel with
 * ?secrets=1; without them a new APP-KEY and key are generated on import (the app's settings and any cached JWK set
 * must be updated). APP-IDs are unique across the hub: one already in use gets a new APP-ID, with a warning.
 * Requests and run rules are test data.
 */
let registered = false;

export function registerNafathExport(): void {
  if (registered) return;
  registered = true;

  registerExportSection({
    key: 'nafathInstances',
    table: 'nafath_instances',
    export: ({ hub, project, includeSecrets }) =>
      hub.nafath.repo.listInstances(project.id).map((i) => ({
        id: i.id, slug: i.slug, name: i.name, appId: i.appId, strict: i.strict, enabled: i.enabled, config: i.config,
        ...(includeSecrets ? { appKey: i.appKey, keys: i.keys } : {}),
      })),
    import: (ctx, rows) => {
      const svc = ctx.hub.nafath;
      let n = 0;
      for (const r of rows) {
        try {
          const appId = r.appId ? String(r.appId) : null;
          const appIdTaken = !!appId && !!svc.instanceByAppId(appId);
          const keys = Array.isArray(r.keys) ? (r.keys as NafathKey[]).filter((k) => k && k.kid && k.privatePem && k.publicJwk) : [];
          const kept = !!r.appKey && keys.length > 0;
          let i = svc.createInstance(ctx.project, {
            slug: r.slug, name: r.name, strict: r.strict === true, enabled: r.enabled !== false, config: r.config,
            ...(appId && !appIdTaken ? { appId } : {}),
            ...(r.appKey ? { appKey: r.appKey } : {}),
          });
          if (kept) i = svc.repo.updateInstance(i.id, { keys });
          if (r.id) ctx.ids.set('nafathInstances', String(r.id), i.id);
          if (!kept) ctx.warnings.push(`Nafath instance "${i.slug}": new APP-KEY and signing key generated (they are only exported with secrets); update the app's APP-KEY and refresh its JWK set.`);
          if (appIdTaken) ctx.warnings.push(`Nafath instance "${i.slug}": APP-ID "${appId}" is already used on this stubyard (APP-IDs are unique), new APP-ID ${i.appId}.`);
          n++;
        } catch (e) {
          ctx.warnings.push(`Nafath instance "${String(r.slug)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });

  registerExportSection({
    key: 'nafathRules',
    table: 'nafath_rules',
    export: ({ hub, project }) =>
      hub.nafath.repo
        .listRules(project.id)
        .filter((r) => !r.runId)
        .map((r) => ({ instanceId: r.instanceId, match: r.match, fault: r.fault, times: r.remaining })),
    import: (ctx, rows) => {
      let n = 0;
      for (const r of rows) {
        const m = (r.match ?? {}) as NafathRule['match'];
        try {
          const instance = r.instanceId ? ctx.ids.get('nafathInstances', String(r.instanceId)) : null;
          if (r.instanceId && !instance) throw new Error('its instance is not in the file');
          const user = m.user ? ctx.ids.get('users', m.user) : null;
          if (m.user && !user) throw new Error('its test user is not in the file');
          ctx.hub.nafath.addFault(ctx.project, { fault: r.fault, instance: instance ?? undefined, user: user ?? undefined, nationalId: m.nationalId, service: m.service, times: r.times ?? undefined }, null);
          n++;
        } catch (e) {
          ctx.warnings.push(`Nafath fault "${String(r.fault)}" skipped: ${(e as Error).message}`);
        }
      }
      return n;
    },
  });
}
